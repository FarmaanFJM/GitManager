// Terminals, live processes and ports, and read-only environment inspection for the main process.
// The page asks; this class resolves what a request refers to (a repository, a worktree, a runner), plans the shell or
// the inspection with the core modules, and returns plain data. Nothing here builds a shell string from page input.
import { EventEmitter } from 'node:events'
import type { Location, Repo, Result } from '../shared/types.js'
import type { ShellOption, TerminalCloseResult, TerminalInfo, TerminalNote, TerminalOpenRequest, TerminalTarget } from '../shared/terminal.js'
import type { ConfigFileEnv, EnvSnapshot, PortConflict, ProcInfo, ProcsSnapshot, StopResult } from '../shared/procs.js'
import { TERMINAL_MAX_WRITE_CHARS } from '../shared/terminal.js'
import { hostOs, listWslDistros, type HostOs } from '../core/exec.js'
import { displayLocation, locationRuntime, sameLocation } from '../core/paths.js'
import { detectShells, locationWithSubpath, planShell, preferredShellFor, shellCannotOpen, type ShellPlan } from '../core/shells.js'
import { TerminalError, TerminalManager, type PtyFactory } from '../core/terminals.js'
import { createNodePtyFactory } from '../core/ptyNode.js'
import { parseSystemdUser, planRunnerTerminal } from '../core/runnerTerminal.js'
import { NativeShell, WslShell, type HostShell } from '../core/runners/hosts.js'
import { createProcAdapters } from '../core/procs/index.js'
import { ProcessInspector, buildRepoIndex, type OwnershipSource, type ManagedProc } from '../core/procs/inspector.js'
import { LaunchEnvStore, captureLaunchEnv, readConfigFiles, runtimeEnvOf } from '../core/procs/env.js'
import { procKey, sameContext } from '../core/procs/model.js'
import { stopProcess } from '../core/procs/control.js'
import type { ServiceManager } from '../core/processes.js'
import type { Store } from '../core/store.js'
import type { Runner } from '../shared/runners.js'
import * as v from '../core/validate.js'

const ok = <T>(value: T): Result<T> => ({ ok: true, value })
const err = <T>(code: string, message: string, detail?: string): Result<T> => ({ ok: false, error: { code, message, ...(detail ? { detail } : {}) } })

export type DevToolsDeps = {
  store: Store
  services: ServiceManager
  os?: HostOs
  ptyFactory?: PtyFactory
  /** Finds a runner by key (the Runners tool owns the inventory). */
  findRunner: (key: string) => Runner | undefined
  /** The shell for a location (tests replace it). */
  hostShell?: (host: { kind: 'native' } | { kind: 'wsl'; distro: string }) => HostShell
  /** All folders (worktrees) of a repository, for associating processes and validating terminal targets. */
  worktreePaths?: (repo: Repo) => Promise<string[]>
}

const SCAN_TTL_MS = 2000

export class DevTools extends EventEmitter {
  readonly terminals: TerminalManager
  private shellCache: { at: number; shells: ShellOption[] } | null = null
  private readonly targets = new Map<string, TerminalTarget>()
  private inspector: ProcessInspector | null = null
  private inspectorKey = ''
  private readonly launchEnv = new LaunchEnvStore()
  private readonly os: HostOs

  constructor(private readonly d: DevToolsDeps) {
    super()
    this.os = d.os ?? hostOs()
    this.terminals = new TerminalManager({ factory: d.ptyFactory ?? createNodePtyFactory() })
    this.terminals.on('data', p => this.emit('terminal-data', p))
    const changed = (info: TerminalInfo) => this.emit('terminal-changed', { info: this.withTarget(info), closed: null })
    this.terminals.on('created', e => changed(e.info))
    this.terminals.on('updated', e => changed(e.info))
    this.terminals.on('closed', e => { this.targets.delete(e.id); this.emit('terminal-changed', { info: null, closed: e.id }) })
  }

  private withTarget(info: TerminalInfo): TerminalInfo { const t = this.targets.get(info.id); return t ? { ...info, target: t } : info }
  private shellFor(host: { kind: 'native' } | { kind: 'wsl'; distro: string }): HostShell {
    return this.d.hostShell ? this.d.hostShell(host) : host.kind === 'wsl' ? new WslShell(host.distro) : new NativeShell({ os: this.os })
  }

  /* ------------------------------------------------------------ terminals */

  async shells(refresh = false): Promise<ShellOption[]> {
    if (!refresh && this.shellCache && Date.now() - this.shellCache.at < 30_000) return this.shellCache.shells
    const shells = await detectShells()
    this.shellCache = { at: Date.now(), shells }
    return shells
  }

  private repo(id: unknown): Repo {
    const r = this.d.store.repo(v.id(id, 'Repository id'))
    if (!r) throw new v.ValidationError('That repository is no longer registered.')
    return r
  }

  /** Resolves a terminal target to the folder it opens in. Only registered repositories, their own worktrees and known runners are reachable. */
  private async resolve(target: TerminalTarget): Promise<{ location: Location; title: string; repo?: Repo } | { runner: Runner } | { error: string }> {
    if (target.type === 'repo') {
      const repo = this.repo(target.repoId)
      const loc = locationWithSubpath(repo.location, target.subpath)
      if (!loc.ok) return { error: loc.message }
      return { location: loc.location, title: repo.name, repo }
    }
    if (target.type === 'path') {
      const loc = target.location
      for (const repo of this.d.store.data.repos) {
        if (loc.kind !== repo.location.kind) continue
        if (sameLocation(loc, repo.location)) return { location: repo.location, title: repo.name, repo }
        const trees = (await this.d.worktreePaths?.(repo).catch(() => [])) ?? []
        const hit = trees.find(p => sameLocation({ ...repo.location, path: p }, loc))
        if (hit) return { location: { ...repo.location, path: hit }, title: `${repo.name} · ${hit.split(/[\\/]/).filter(Boolean).pop() ?? ''}`, repo }
      }
      return { error: 'That folder is not a registered repository or one of its worktrees.' }
    }
    const runner = this.d.findRunner(v.str(target.key, 'Runner', { max: 1024, allowEmpty: false }))
    if (!runner?.local) return { error: 'That runner has no installation on this computer.' }
    return { runner }
  }

  private async runnerPlan(runner: Runner, shells: ShellOption[]): Promise<{ plan: ShellPlan; notes: TerminalNote[]; title: string } | { error: string; notes: TerminalNote[] }> {
    const local = runner.local!
    if (local.host.kind === 'ssh') return { error: `A terminal on the SSH host ${local.host.host} is not supported yet.`, notes: [] }
    const sh = this.shellFor(local.host)
    let serviceAccount: string | null = null
    let ownerAccount: string | null = null
    try {
      if (local.service.kind === 'systemd' && local.service.name) serviceAccount = parseSystemdUser((await sh.run('systemctl', ['cat', '--', local.service.name], { timeoutMs: 8000 })).stdout)
      if (local.service.kind === 'windows-service' && local.service.name) {
        const r = await sh.run('sc.exe', ['qc', local.service.name], { timeoutMs: 8000 })
        serviceAccount = /SERVICE_START_NAME\s*:\s*(.+)/i.exec(r.stdout)?.[1]?.trim() ?? null
      }
      if (local.host.kind !== 'native' || this.os !== 'windows') ownerAccount = (await sh.run('stat', ['-c', '%U', '--', local.path], { timeoutMs: 8000 })).stdout.trim() || null
    } catch { /* unknown accounts are reported as such */ }
    const planned = planRunnerTerminal({ host: local.host, path: local.path, service: local.service, serviceAccount, ownerAccount }, { shells })
    if (!planned.ok) return { error: planned.reason, notes: planned.notes }
    return { plan: planned.shellPlan, notes: planned.notes, title: runner.name }
  }

  async open(req: unknown): Promise<Result<{ info: TerminalInfo; notes: TerminalNote[] }>> {
    const r = (req ?? {}) as TerminalOpenRequest
    const t = r.target
    if (!t || typeof t !== 'object') return err('INVALID', 'Choose where to open the terminal.')
    const shells = await this.shells()
    const size = { cols: typeof r.cols === 'number' ? r.cols : undefined, rows: typeof r.rows === 'number' ? r.rows : undefined }
    try {
      const res = await this.resolve(t)
      if ('error' in res) return err('NO_TARGET', res.error)
      let plan: ShellPlan
      let notes: TerminalNote[] = []
      let title: string
      if ('runner' in res) {
        const rp = await this.runnerPlan(res.runner, shells)
        if ('error' in rp) return err('NOT_SUPPORTED', rp.error)
        ;({ plan, notes, title } = rp)
      } else {
        const saved = res.repo ? this.d.store.data.ui.shellByRepo?.[res.repo.id] : undefined
        const shell = typeof r.shellId === 'string' && r.shellId
          ? shells.find(s => s.id === r.shellId)
          : preferredShellFor(res.location, saved, shells)
        if (!shell) return err('NO_SHELL', 'No shell is available for this folder.')
        if (!shell.available) return err('NO_SHELL', shell.detail ? `${shell.label} is not available: ${shell.detail}` : `${shell.label} is not available.`)
        const cannot = shellCannotOpen(shell, res.location)
        if (cannot) return err('NO_SHELL', cannot)
        const planned = planShell({ shell, location: res.location })
        if (!planned.ok) return err('NO_SHELL', planned.message)
        plan = planned.plan
        notes = (planned.plan.notes ?? []).map(message => ({ code: 'INFO' as const, message }))
        title = res.title
        if (res.repo && typeof r.shellId === 'string' && r.shellId && saved !== r.shellId) {
          this.d.store.data.ui.shellByRepo = { ...(this.d.store.data.ui.shellByRepo ?? {}), [res.repo.id]: r.shellId }
          this.d.store.save()
        }
      }
      const info = this.terminals.create(plan, title, size)
      this.targets.set(info.id, t)
      return ok({ info: this.withTarget(info), notes })
    } catch (e) {
      if (e instanceof TerminalError) return err(e.code, e.message)
      throw e
    }
  }

  list(): TerminalInfo[] { return this.terminals.list().map(i => this.withTarget(i)) }
  replay(id: unknown): string {
    const sb = this.terminals.scrollback(v.id(id, 'Terminal'))
    // A truncated replay can start inside an escape sequence: reset the screen state first.
    return sb.truncated ? `\x1bc${sb.data}` : sb.data
  }
  write(id: unknown, data: unknown): Result<void> {
    if (typeof data !== 'string' || data.length > TERMINAL_MAX_WRITE_CHARS) return err('INVALID', 'That input is too large.')
    return this.terminals.write(v.id(id, 'Terminal'), data) ? ok(undefined) : err('EXITED', 'The shell has exited.')
  }
  resize(id: unknown, cols: unknown, rows: unknown): Result<void> {
    try { this.terminals.resize(v.id(id, 'Terminal'), v.int(cols, 'Columns', 2, 500), v.int(rows, 'Rows', 1, 200)); return ok(undefined) } catch (e) { return err('INVALID', (e as Error).message) }
  }
  async close(id: unknown, force: unknown): Promise<Result<TerminalCloseResult>> {
    try { return ok(await this.terminals.close(v.id(id, 'Terminal'), { force: force === true })) } catch (e) { return err('FAILED', (e as Error).message) }
  }
  /** Application quit: the shells go with the application. */
  shutdown() { void this.terminals.killAll() }

  /* ------------------------------------------------------------ processes and ports */

  private async getInspector(): Promise<ProcessInspector> {
    const distros = this.os === 'windows' ? (await listWslDistros(this.os)).distros.map(x => x.name) : []
    const key = distros.join('|')
    if (this.inspector && this.inspectorKey === key) return this.inspector
    const ownership: OwnershipSource = {
      managedPids: () => {
        const m = new Map<string, ManagedProc>()
        for (const s of this.d.services.managed()) {
          const ctx = s.runtime.kind === 'wsl' ? { kind: 'wsl' as const, distro: s.runtime.distro } : { kind: 'native' as const }
          const env = captureLaunchEnv(s.runtime.kind === 'wsl' ? {} : s.env, {}, {})
          this.launchEnv.record(s.serviceKey, s.pid, env)
          m.set(procKey(ctx, s.pid), { serviceKey: s.serviceKey, repoId: s.repoId, launchEnv: env })
        }
        return m
      },
    }
    const repos = this.d.store.data.repos
    this.inspector = new ProcessInspector({
      adapters: createProcAdapters({ os: this.os, wslDistros: distros }),
      repos: { findRepoByPath: (ctx, p) => buildRepoIndex(this.indexed(repos)).findRepoByPath(ctx, p) },
      ownership, ttlMs: SCAN_TTL_MS,
    })
    this.inspectorKey = key
    return this.inspector
  }

  private indexed(repos: Repo[]) {
    return repos.map(r => ({
      id: r.id, location: r.location,
      extra: this.d.store.data.profiles.filter(p => p.repoId === r.id && p.worktreePath).map(p => ({ ...r.location, path: p.worktreePath! } as Location)),
    }))
  }

  async scan(force = false): Promise<Result<ProcsSnapshot>> {
    try { return ok(await (await this.getInspector()).scan({ maxAgeMs: force ? 0 : undefined })) } catch (e) { return err('SCAN_FAILED', 'Processes could not be read.', (e as Error).message) }
  }

  private async find(key: unknown): Promise<ProcInfo | undefined> {
    const k = v.str(key, 'Process', { max: 200, allowEmpty: false })
    const snap = await (await this.getInspector()).scan({ maxAgeMs: 30_000 })
    return snap.processes.find(p => p.key === k)
  }

  async stop(key: unknown, confirmExternal: unknown): Promise<Result<StopResult>> {
    const info = await this.find(key)
    if (!info) return err('GONE', 'That process is no longer running.')
    const inspector = await this.getInspector()
    const res = await stopProcess(info, {
      confirmExternal: confirmExternal === true,
      adapterFor: ctx => inspector.adapterFor(ctx),
      stopManaged: async i => {
        if (!i.serviceKey) return { ok: false, message: 'GitManager does not know how to stop this one.' }
        await this.d.services.stop(i.serviceKey)
        return { ok: true }
      },
    })
    inspector.invalidate()
    return ok(res)
  }

  async env(key: unknown): Promise<Result<EnvSnapshot>> {
    const info = await this.find(key)
    if (!info) return err('GONE', 'That process is no longer running.')
    const inspector = await this.getInspector()
    return ok(await runtimeEnvOf(info, { launchEnv: this.launchEnv, adapter: inspector.adapterFor(info.context) }))
  }

  /** Configuration files of a folder, read where the folder lives. Never presented as the running environment. */
  async configFiles(location: Location, names?: string[]): Promise<ConfigFileEnv[]> {
    const sh = this.shellFor(locationRuntime(location).kind === 'wsl' ? { kind: 'wsl', distro: (location as { distro: string }).distro } : { kind: 'native' })
    return readConfigFiles(location.path, names, sh)
  }

  async conflicts(ports: number[], ignoreServiceKeys: string[] = []): Promise<Result<PortConflict[]>> {
    const { conflicts } = await (await this.getInspector()).conflictsFor({ ports, maxAgeMs: 0, ignoreServiceKeys })
    return ok(conflicts)
  }

  /** The listener processes of a runner installation, found by the pids the Runners tool recorded in the runner's own environment. */
  async runnerProcess(runner: Runner): Promise<ProcInfo | undefined> {
    const local = runner.local
    if (!local || !local.process.pids.length || local.host.kind === 'ssh') return undefined
    const ctx = local.host.kind === 'wsl' ? { kind: 'wsl' as const, distro: local.host.distro } : { kind: 'native' as const }
    const snap = await (await this.getInspector()).scan({ contexts: [ctx], includeAll: true, maxAgeMs: 0 })
    return snap.processes.find(p => sameContext(p.context, ctx) && local.process.pids.includes(p.pid))
  }
}

export { displayLocation }
