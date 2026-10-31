// The Runners tool in the main process: owns the inventory (local installations and GitHub records, reconciled), the
// scan, installation jobs and lifecycle actions, and persists non-sensitive state. The interface asks for state and for
// explicit actions; it never receives a token or runs a command of its own choosing.
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Repo } from '../../shared/types.js'
import type {
  ActionOptions, ActionResult, GitHubOrgChoice, GitHubRepoChoice, GitHubRunner, HostProbe, HostResult, InstallJob, InstallPlan, LatestRelease, LocalRunner, Runner, RunnerAction, RunnerDiagnostics,
  RunnerGroupInfo, RunnerHost, RunnerRoot, RunnersConfig, RunnersInventory, RunnersOpenTarget, RunnersScan, RunnersState, RunnerScope, RunsOnExample, ScopeResult, SshConfigHost, WorkflowLabelReport,
} from '../../shared/runners.js'
import type { AuthState } from '../../shared/storage.js'
import { listWslDistros, type HostOs } from '../exec.js'
import { wslUncPath } from '../paths.js'
import { GhError, type GhApi } from '../storage/gh.js'
import { discoverOnHost, inspectOne } from './discovery.js'
import { RUNNER_RELEASES, RunnerGitHub } from './github.js'
import { probeHost, readSshConfigHosts, shellFor as defaultShellFor, type HostShell } from './hosts.js'
import { sanitizeRunnerSettings } from './config.js'
import { newIdLike } from './ids.js'
import { newJob, planInstall, runInstall, validateRequest, type Downloader } from './install.js'
import { collectDiagnostics, performAction } from './lifecycle.js'
import { hostKey, hostLabel, installKey, parseScope, repoFromRemote, runsOnExample, sameHost, sameScope, scopeKey, scopeLabel, scopeSettingsUrl, scopeUrl, summarize, reconcile, validOwner, validRepoFull } from './model.js'
import { buildReport } from './workflows.js'

export type ManagerDeps = {
  dir: string
  gh: GhApi
  config: () => RunnersConfig
  saveConfig: () => void
  os: HostOs
  tmpDir: string
  repos: () => Repo[]
  openExternal: (url: string) => Promise<void>
  openPath: (path: string) => Promise<string>
  shellFor?: (host: RunnerHost) => HostShell
  distros?: () => Promise<{ name: string; version: number | null }[]>
  sshConfig?: () => Promise<SshConfigHost[]>
  drives?: string[]
  download?: Downloader
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  env?: NodeJS.ProcessEnv
  /** Seconds the installer waits for the runner to come online. */
  onlineWaitMs?: number
}

type Persisted = {
  locals: LocalRunner[]
  githubs: GitHubRunner[]
  hosts: HostResult[]
  scopes: ScopeResult[]
  localScannedAt: string | null
  githubScannedAt: string | null
  latest: (LatestRelease & { checksums: Record<string, string> }) | null
  recentJobs: InstallJob[]
  /** What the last GitHub scan left out on purpose (too many repositories), so the inventory never claims completeness. */
  scanNotes: string[]
}

export type Res<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string; detail?: string } }
const okRes = <T>(value: T): Res<T> => ({ ok: true, value })
const fail = <T>(code: string, message: string, detail?: string): Res<T> => ({ ok: false, error: { code, message, ...(detail ? { detail } : {}) } })

const ADMIN_REPO_LIMIT = 30
const IDLE: RunnersScan = { running: false, phase: 'idle', current: null, startedAt: null, cancelled: false, localOnly: false }
export const SECURITY_NOTE = 'A self-hosted runner executes the code of the workflows it is assigned. Use it only for repositories you trust, and avoid it for public repositories that accept contributions from outside, where a fork could run arbitrary code on this machine.'
const DOCS = { 'add-runner': 'https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/add-runners', configure: 'https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/configure-the-application', security: 'https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions#hardening-for-self-hosted-runners', api: 'https://docs.github.com/en/rest/actions/self-hosted-runners' }

export class RunnerManager extends EventEmitter {
  private readonly github: RunnerGitHub
  private readonly stateFile: string
  private p: Persisted
  private scanP: RunnersScan = { ...IDLE }
  private signal = { cancelled: false }
  private auth: AuthState | null = null
  private job: InstallJob | null = null
  private readonly plans = new Map<string, { plan: InstallPlan; at: number }>()
  private readonly busy = new Map<string, RunnerAction>()
  private probes = new Map<string, HostProbe>()
  private readonly now: () => number
  private lastGithubAt = 0
  private readonly bg = new Set<Promise<unknown>>()

  constructor(private readonly d: ManagerDeps) {
    super()
    this.now = d.now ?? Date.now
    this.github = new RunnerGitHub(d.gh, { sleep: d.sleep })
    this.stateFile = join(d.dir, 'runners-state.json')
    this.p = this.load()
  }

  /* ------------------------------------------------------------ persistence */

  private load(): Persisted {
    const empty: Persisted = { locals: [], githubs: [], hosts: [], scopes: [], localScannedAt: null, githubScannedAt: null, latest: null, recentJobs: [], scanNotes: [] }
    try {
      if (!existsSync(this.stateFile)) return empty
      const raw = JSON.parse(readFileSync(this.stateFile, 'utf8')) as Partial<Persisted>
      const arr = <T>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : [])
      return { ...empty, ...raw, locals: arr(raw.locals), githubs: arr(raw.githubs), hosts: arr(raw.hosts), scopes: arr(raw.scopes), recentJobs: arr<InstallJob>(raw.recentJobs).slice(0, 5), scanNotes: arr<string>(raw.scanNotes), latest: raw.latest && typeof raw.latest.version === 'string' ? raw.latest : null }
    } catch {
      try { renameSync(this.stateFile, `${this.stateFile}.corrupt-${this.now()}`) } catch { /* start empty */ }
      return empty
    }
  }

  private persist() {
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true })
      const tmp = `${this.stateFile}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(this.p), { mode: 0o600 })
      renameSync(tmp, this.stateFile)
    } catch (e) { console.error('[gitmanager] could not save runners state', e) }
  }

  private cfg() { return this.d.config() }
  private changed() { this.emit('changed') }
  private status() { this.emit('status', { scan: this.scanP, job: this.job, busy: Object.fromEntries(this.busy), auth: this.auth }) }
  private track<T>(p: Promise<T>): Promise<T> { this.bg.add(p); void p.finally(() => this.bg.delete(p)); return p }
  /** Resolves when no scan, job or background refresh is running (tests). */
  async whenIdle() { while (this.bg.size) await Promise.allSettled([...this.bg]) }

  private shellFor(host: RunnerHost): HostShell { return (this.d.shellFor ?? defaultShellFor)(host, { os: this.d.os }) }

  /* ------------------------------------------------------------ state */

  inventory(): RunnersInventory {
    const okHosts = new Set(this.p.hosts.filter(h => h.status === 'ok').map(h => hostKey(h.host)))
    const fetched = new Set(this.p.scopes.filter(s => s.status === 'ok').map(s => scopeKey(s.scope)))
    const runners = reconcile(this.p.locals, this.p.githubs, { latestVersion: this.p.latest?.version ?? null, githubFetched: s => fetched.has(scopeKey(s)), hostReachable: h => okHosts.has(hostKey(h)) || !this.p.hosts.some(x => sameHost(x.host, h)) })
    const limitations: string[] = []
    for (const s of this.p.scopes) if (s.status !== 'ok' && s.status !== 'skipped') limitations.push(`${scopeLabel(s.scope)}: ${s.message ?? s.status}`)
    for (const h of this.p.hosts) if (h.status !== 'ok') limitations.push(`${h.label}: ${h.message ?? h.status}`)
    if (!this.p.githubScannedAt) limitations.push('GitHub has not been read yet: online, busy and label information is unknown until a scan with GitHub access.')
    if (this.p.scopes.some(s => s.truncated)) limitations.push('Some scopes have more runners than were read.')
    limitations.push(...this.p.scanNotes)
    return { runners, summary: summarize(runners), hosts: this.p.hosts, scopes: this.p.scopes, scannedAt: this.p.localScannedAt ?? this.p.githubScannedAt, localScannedAt: this.p.localScannedAt, githubScannedAt: this.p.githubScannedAt, limitations, latest: this.p.latest ? { version: this.p.latest.version, checkedAt: this.p.latest.checkedAt, url: this.p.latest.url } : null }
  }

  async hostsCatalog(): Promise<RunnersState['hosts']> {
    const out: RunnersState['hosts'] = [{ host: { kind: 'native' }, label: hostLabel({ kind: 'native' }, this.d.os), os: this.d.os === 'windows' ? 'windows' : this.d.os === 'mac' ? 'macos' : 'linux', available: true, note: null }]
    if (this.d.os === 'windows') {
      const distros = this.d.distros ? await this.d.distros() : (await listWslDistros('windows')).distros
      for (const x of distros) out.push({ host: { kind: 'wsl', distro: x.name }, label: `WSL ${x.version ?? ''} ${x.name}`.replace(/\s+/g, ' '), os: 'linux', available: x.version !== 1, note: x.version === 1 ? 'WSL 1 distributions are not supported for runners (no systemd, shared Windows file system).' : null })
    }
    for (const h of this.cfg().settings.sshHosts) out.push({ host: { kind: 'ssh', host: h }, label: `SSH ${h}`, os: this.probes.get(`ssh:${h.toLowerCase()}`)?.os ?? 'unknown', available: true, note: 'Commands run over your SSH configuration with key-based authentication; nothing is enabled or opened on the remote machine.' })
    return out
  }

  async state(): Promise<RunnersState> {
    return { inventory: this.inventory(), config: this.cfg(), scan: this.scanP, job: this.job, recentJobs: this.p.recentJobs, busy: Object.fromEntries(this.busy), auth: this.auth, hosts: await this.hostsCatalog(), security: SECURITY_NOTE }
  }

  async refreshAuth(): Promise<AuthState> { this.auth = await this.d.gh.authState(); this.status(); return this.auth }

  /* ------------------------------------------------------------ scanning */

  scan(opts: { localOnly?: boolean; githubOnly?: boolean; hosts?: RunnerHost[] } = {}): Res<{ started: true }> {
    if (this.scanP.running) return fail('BUSY', 'A scan is already running.')
    this.signal = { cancelled: false }
    this.scanP = { running: true, phase: opts.githubOnly ? 'github' : 'local', current: null, startedAt: new Date(this.now()).toISOString(), cancelled: false, localOnly: !!opts.localOnly }
    this.status()
    void this.track(this.runScan(opts))
    return okRes({ started: true })
  }

  async scanAndWait(opts: { localOnly?: boolean; githubOnly?: boolean; hosts?: RunnerHost[] } = {}): Promise<Res<{ started: true }>> {
    const r = this.scan(opts)
    if (r.ok) await this.whenIdle()
    return r
  }

  cancel(): boolean {
    if (!this.scanP.running) return false
    this.signal.cancelled = true
    this.scanP = { ...this.scanP, cancelled: true }
    this.status()
    return true
  }

  private async runScan(opts: { localOnly?: boolean; githubOnly?: boolean; hosts?: RunnerHost[] }) {
    try {
      if (!opts.githubOnly) await this.scanLocal(opts.hosts)
      if (!opts.localOnly && !this.signal.cancelled) await this.scanGithub()
    } catch (e) {
      console.error('[gitmanager] runners scan failed', e)
    } finally {
      this.scanP = { ...this.scanP, running: false, phase: 'idle', current: null }
      this.persist()
      this.status(); this.changed()
    }
  }

  private async scanLocal(only?: RunnerHost[]) {
    this.scanP = { ...this.scanP, phase: 'local' }
    const catalog = await this.hostsCatalog()
    const hosts = catalog.filter(h => h.available && (!only || only.some(o => sameHost(o, h.host))))
    const results: HostResult[] = only ? this.p.hosts.filter(h => !only.some(o => sameHost(o, h.host))) : []
    let locals: LocalRunner[] = only ? this.p.locals.filter(l => !only.some(o => sameHost(o, l.host))) : []
    const roots: RunnerRoot[] = this.cfg().settings.roots
    for (const h of hosts) {
      if (this.signal.cancelled) { results.push({ host: h.host, label: h.label, status: 'cancelled', message: 'Cancelled.', found: 0, roots: [], durationMs: 0 }); continue }
      this.scanP = { ...this.scanP, current: h.label }; this.status()
      const shell = this.shellFor(h.host)
      const probe = await probeHost(shell)
      this.probes.set(hostKey(h.host), probe)
      const r = await discoverOnHost(shell, probe, { roots, signal: this.signal, now: this.now, deadlineMs: h.host.kind === 'native' ? 90_000 : 120_000 }, this.d.env ?? process.env, this.d.drives ?? (this.d.os === 'windows' ? 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(l => `${l}:\\`) : []))
      results.push(r.result)
      locals.push(...r.installs)
    }
    // Installations GitManager knows (installed by it, or seen before) that the scan did not visit stay listed as not inspected.
    for (const k of this.cfg().known) {
      if (locals.some(l => l.key === k.key)) continue
      const visited = results.find(h => sameHost(h.host, k.host) && h.status === 'ok')
      if (visited) continue // the host was scanned and the installation is gone
      const prev = this.p.locals.find(l => l.key === k.key)
      if (prev) locals.push({ ...prev, warnings: [...new Set([...prev.warnings, 'Not inspected in the last scan; shown from the previous one.'])] })
    }
    locals = locals.filter((l, i, a) => a.findIndex(x => x.key === l.key) === i)
    this.p.locals = locals
    this.p.hosts = results
    this.p.localScannedAt = new Date(this.now()).toISOString()
    this.rememberKnown()
    this.persist(); this.changed()
  }

  private rememberKnown() {
    const c = this.cfg()
    const at = new Date(this.now()).toISOString()
    const keep = c.known.filter(k => this.p.locals.some(l => l.key === k.key) || !this.p.hosts.some(h => sameHost(h.host, k.host) && h.status === 'ok'))
    for (const l of this.p.locals) {
      const i = keep.findIndex(k => k.key === l.key)
      const rec = { key: l.key, host: l.host, path: l.path, name: l.agentName, scope: l.scope, agentId: l.agentId, at }
      if (i >= 0) keep[i] = rec; else keep.push(rec)
    }
    c.known = keep.slice(0, 500)
    this.d.saveConfig()
  }

  /**
   * Scopes worth asking GitHub about: configured ones, those local installations point at, the GitHub remotes of registered
   * repositories, the user's organizations, and (bounded) the repositories the user administers. What is left out is noted.
   */
  private async scopesToQuery(): Promise<{ scopes: RunnerScope[]; notes: string[] }> {
    const map = new Map<string, RunnerScope>()
    const add = (s: RunnerScope | null) => { if (s) map.set(scopeKey(s), s) }
    const notes: string[] = []
    const c = this.cfg().settings
    for (const r of c.repos) { const [owner, repo] = r.split('/'); add({ kind: 'repo', owner, repo }) }
    for (const o of c.orgs) add({ kind: 'org', org: o })
    for (const l of this.p.locals) add(l.scope)
    for (const g of this.p.githubs) add(g.scope) // keep refreshing what was seen before
    for (const full of await this.registeredRepoScopes()) { const [owner, repo] = full.split('/'); add({ kind: 'repo', owner, repo }) }
    try { for (const o of await this.github.userOrgs()) add({ kind: 'org', org: o }) } catch { notes.push('Your organizations could not be listed (the sign-in may lack the read:org scope); add them under Discovery.') }
    try {
      const admin = await this.github.adminRepos()
      const extra = admin.filter(r => !map.has(scopeKey({ kind: 'repo', owner: r.owner, repo: r.fullName.split('/')[1] })))
      for (const r of extra.slice(0, ADMIN_REPO_LIMIT)) add({ kind: 'repo', owner: r.fullName.split('/')[0], repo: r.fullName.split('/')[1] })
      if (extra.length > ADMIN_REPO_LIMIT) notes.push(`${extra.length - ADMIN_REPO_LIMIT} more repositories you administer were not read (the scan reads at most ${ADMIN_REPO_LIMIT} beyond those registered here); add the ones that matter under Discovery.`)
    } catch { notes.push('The repositories you administer could not be listed; only registered repositories and configured scopes were read.') }
    return { scopes: [...map.values()], notes }
  }

  /** owner/name of the GitHub remotes of GitManager's repositories, read from each .git/config (no Git command, no network). */
  async registeredRepoScopes(): Promise<string[]> {
    const out = new Set<string>()
    const repos = this.d.repos().slice(0, 200)
    const native = repos.filter(r => r.location.kind === 'native')
    const wsl = repos.filter(r => r.location.kind === 'wsl').slice(0, 30)
    const read = async (r: Repo) => {
      const shell = this.shellFor(r.location.kind === 'wsl' ? { kind: 'wsl', distro: r.location.distro } : { kind: 'native' })
      const sep = r.location.kind === 'wsl' || !/^[A-Za-z]:\\/.test(r.location.path) ? '/' : '\\'
      const text = await shell.readFile(`${r.location.path}${sep}.git${sep}config`, 64 * 1024)
      if (!text) return
      for (const m of text.matchAll(/^\s*url\s*=\s*(.+)$/gm)) { const full = repoFromRemote(m[1]); if (full) out.add(full) }
    }
    for (let i = 0; i < native.length; i += 8) await Promise.all(native.slice(i, i + 8).map(read))
    for (let i = 0; i < wsl.length; i += 4) await Promise.all(wsl.slice(i, i + 4).map(read))
    return [...out]
  }

  private async scanGithub() {
    this.scanP = { ...this.scanP, phase: 'github', current: 'Checking sign-in' }; this.status()
    const auth = await this.refreshAuth()
    if (auth.state !== 'ok') {
      this.p.scopes = this.p.scopes.map(s => ({ ...s, status: 'skipped' as const, message: auth.message }))
      return
    }
    const { scopes, notes } = await this.scopesToQuery()
    const results: ScopeResult[] = []
    const githubs: GitHubRunner[] = []
    let stop: string | null = null
    let next = 0
    const worker = async () => {
      while (next < scopes.length && !this.signal.cancelled && !stop) {
        const scope = scopes[next++]
        this.scanP = { ...this.scanP, current: scopeLabel(scope) }; this.status()
        const at = new Date(this.now()).toISOString()
        try {
          const r = await this.github.listRunners(scope)
          githubs.push(...r.runners)
          results.push({ scope, status: 'ok', message: null, count: r.runners.length, truncated: r.truncated, fetchedAt: at })
        } catch (e) {
          const err = e as GhError
          const kind = err instanceof GhError ? err.kind : 'request'
          if (kind === 'rate-limit') { stop = err.message; results.push({ scope, status: 'rate-limited', message: err.message, count: 0, truncated: false, fetchedAt: at }); break }
          if (kind === 'auth') { stop = err.message; results.push({ scope, status: 'error', message: err.message, count: 0, truncated: false, fetchedAt: at }); break }
          results.push({
            scope, status: kind === 'permission' ? 'forbidden' : kind === 'not-found' ? 'not-found' : 'error',
            message: kind === 'permission' ? (scope.kind === 'org' ? `No permission to list the runners of ${scope.org} (organization administration and the admin:org scope are needed).` : `No permission to list the runners of ${scopeLabel(scope)} (repository administration is needed).`)
              : kind === 'not-found' ? `${scopeLabel(scope)} was not found, or the sign-in cannot see it (GitHub answers 404 for runners without administration permission).` : err.message,
            count: 0, truncated: false, fetchedAt: at,
          })
        }
      }
    }
    await Promise.all([worker(), worker(), worker()])
    for (const s of scopes.slice(next)) if (!results.some(r => sameScope(r.scope, s))) results.push({ scope: s, status: 'skipped', message: stop ?? 'Cancelled before this scope was read.', count: 0, truncated: false, fetchedAt: null })
    if (!this.signal.cancelled) {
      // scopes that could not be read keep their previous records, so a transient failure does not empty the table silently
      const okKeys = new Set(results.filter(r => r.status === 'ok').map(r => scopeKey(r.scope)))
      const kept = this.p.githubs.filter(g => !okKeys.has(scopeKey(g.scope)) && results.some(r => sameScope(r.scope, g.scope)))
      this.p.githubs = [...githubs, ...kept]
      this.p.scopes = results
      this.p.scanNotes = notes
      this.p.githubScannedAt = new Date(this.now()).toISOString()
      this.lastGithubAt = this.now()
    }
    await this.refreshLatest(false)
  }

  /** The latest runner release (cached for six hours). */
  async refreshLatest(force: boolean): Promise<Persisted['latest']> {
    if (!force && this.p.latest && this.now() - Date.parse(this.p.latest.checkedAt) < 6 * 3600_000) return this.p.latest
    try { this.p.latest = await this.github.latestRelease(); this.persist(); this.changed() } catch { /* keep the cached value */ }
    return this.p.latest
  }

  /** Re-reads GitHub only, at most once a minute unless forced (focus and timer refreshes). */
  refreshGithub(force = false): Res<{ started: boolean }> {
    if (this.scanP.running) return okRes({ started: false })
    if (!force && this.now() - this.lastGithubAt < 60_000) return okRes({ started: false })
    if (!this.p.githubScannedAt && !force) return okRes({ started: false })
    const r = this.scan({ githubOnly: true })
    return r.ok ? okRes({ started: true }) : okRes({ started: false })
  }

  /* ------------------------------------------------------------ settings */

  saveSettings(raw: unknown): Res<void> {
    const c = this.cfg()
    const next = sanitizeRunnerSettings(raw)
    c.settings = { ...next, roots: c.settings.roots } // roots have their own add and remove
    this.d.saveConfig(); this.changed()
    return okRes(undefined)
  }

  addRoot(host: RunnerHost, path: string): Res<RunnerRoot> {
    const c = this.cfg()
    const key = installKey(host, path)
    const existing = c.settings.roots.find(r => installKey(r.host, r.path) === key)
    if (existing) return okRes(existing)
    const root: RunnerRoot = { id: newIdLike(), host, path }
    c.settings.roots.push(root)
    this.d.saveConfig(); this.changed()
    return okRes(root)
  }

  removeRoot(id: string): Res<void> {
    const c = this.cfg()
    c.settings.roots = c.settings.roots.filter(r => r.id !== id)
    this.d.saveConfig(); this.changed()
    return okRes(undefined)
  }

  /* ------------------------------------------------------------ hosts */

  async sshHosts(): Promise<SshConfigHost[]> {
    const list = this.d.sshConfig ? await this.d.sshConfig() : await readSshConfigHosts()
    const allowed = new Set(this.cfg().settings.sshHosts.map(h => h.toLowerCase()))
    return list.map(h => ({ ...h, allowed: allowed.has(h.alias.toLowerCase()) }))
  }

  setSshHostAllowed(alias: string, allowed: boolean): Res<void> {
    const c = this.cfg()
    const list = c.settings.sshHosts.filter(h => h.toLowerCase() !== alias.toLowerCase())
    c.settings.sshHosts = allowed ? [...list, alias] : list
    this.d.saveConfig(); this.changed()
    return okRes(undefined)
  }

  async probe(host: RunnerHost): Promise<HostProbe> {
    const p = await probeHost(this.shellFor(host))
    this.probes.set(hostKey(host), p)
    return p
  }

  /* ------------------------------------------------------------ choices for the wizard */

  async repoChoices(query: string): Promise<GitHubRepoChoice[]> {
    const out = new Map<string, GitHubRepoChoice>()
    for (const full of await this.registeredRepoScopes()) out.set(full.toLowerCase(), { fullName: full, private: false, canAdmin: false, ownerType: 'unknown', source: 'gitmanager' })
    for (const l of this.p.locals) if (l.scope?.kind === 'repo') { const full = `${l.scope.owner}/${l.scope.repo}`; if (!out.has(full.toLowerCase())) out.set(full.toLowerCase(), { fullName: full, private: false, canAdmin: false, ownerType: 'unknown', source: 'local' }) }
    const auth = this.auth ?? await this.refreshAuth()
    if (auth.state === 'ok') {
      try {
        const repos = await this.github.adminRepos()
        for (const r of repos) out.set(r.fullName.toLowerCase(), { fullName: r.fullName, private: r.private, canAdmin: r.canAdmin, ownerType: r.ownerType, source: out.get(r.fullName.toLowerCase())?.source ?? 'github' })
        for (const [k, v] of out) if (v.source !== 'github' && !repos.some(r => r.fullName.toLowerCase() === k)) {
          if (validRepoFull(v.fullName) && query && v.fullName.toLowerCase().includes(query.toLowerCase())) { try { const r = await this.github.repo(v.fullName); out.set(k, { ...v, private: r.private, canAdmin: r.canAdmin, ownerType: r.ownerType }) } catch { /* unknown permissions stay false */ } }
        }
        if (query && validRepoFull(query) && !out.has(query.toLowerCase())) { try { const r = await this.github.repo(query); out.set(query.toLowerCase(), { fullName: r.fullName, private: r.private, canAdmin: r.canAdmin, ownerType: r.ownerType, source: 'github' }) } catch { /* not found or no access */ } }
      } catch { /* the local lists are still useful */ }
    }
    const q = query.trim().toLowerCase()
    return [...out.values()].filter(r => !q || r.fullName.toLowerCase().includes(q)).sort((a, b) => Number(b.canAdmin) - Number(a.canAdmin) || a.fullName.localeCompare(b.fullName)).slice(0, 100)
  }

  async orgChoices(): Promise<GitHubOrgChoice[]> {
    const auth = this.auth ?? await this.refreshAuth()
    if (auth.state !== 'ok') return this.cfg().settings.orgs.map(o => ({ login: o, canAdmin: null, message: auth.message }))
    let orgs: string[] = []
    try { orgs = await this.github.userOrgs() } catch { /* fall through to configured ones */ }
    const all = [...new Set([...orgs, ...this.cfg().settings.orgs])]
    const out: GitHubOrgChoice[] = []
    for (const o of all) { const role = await this.github.orgRole(o); out.push({ login: o, canAdmin: role === null ? null : role === 'admin', message: role === 'admin' ? null : role === 'member' ? 'Member only: organization runners need an administrator.' : 'Role unknown (the sign-in may lack read:org).' }) }
    return out
  }

  async runnerGroups(org: string): Promise<Res<RunnerGroupInfo[]>> {
    if (!validOwner(org)) return fail('INVALID', 'Invalid organization.')
    try {
      const groups = await this.github.runnerGroups(org)
      for (const g of groups) if (g.visibility === 'selected') { try { g.selectedRepos = await this.github.groupRepos(org, g.id) } catch { g.selectedRepos = null } }
      return okRes(groups)
    } catch (e) { const err = e as GhError; return fail(err.kind === 'permission' ? 'FORBIDDEN' : 'FAILED', err.message) }
  }

  /* ------------------------------------------------------------ installation */

  async plan(raw: unknown): Promise<Res<InstallPlan>> {
    const v = validateRequest(raw)
    if (!v.ok) return fail('INVALID', v.message)
    if (this.job?.state === 'running') return fail('BUSY', 'An installation is already running.')
    const auth = await this.refreshAuth()
    if (auth.state !== 'ok') return fail(auth.state === 'no-gh' ? 'NO_GH' : 'NOT_SIGNED_IN', auth.message)
    const plan = await planInstall(v.request, this.installDeps())
    for (const [k, p] of this.plans) if (this.now() - p.at > 30 * 60_000) this.plans.delete(k)
    this.plans.set(plan.id, { plan, at: this.now() })
    return okRes(plan)
  }

  private installDeps() {
    return { shellFor: (h: RunnerHost) => this.shellFor(h), github: this.github, tmpDir: this.d.tmpDir, existing: () => this.p.locals, githubRunners: () => this.p.githubs, now: this.now, download: this.d.download, onlineWaitMs: this.d.onlineWaitMs, sleep: this.d.sleep }
  }

  /** Starts the installation of a plan the user reviewed. Refused without `confirm`, with blockers, or while another job runs. */
  startInstall(planId: unknown, confirm: unknown): Res<InstallJob> {
    if (confirm !== true) return fail('NOT_CONFIRMED', 'Installing a runner needs your explicit confirmation of the plan.')
    const entry = typeof planId === 'string' ? this.plans.get(planId) : undefined
    if (!entry) return fail('NOT_FOUND', 'That plan has expired. Review the settings and plan again.')
    if (entry.plan.blockers.length) return fail('BLOCKED', entry.plan.blockers[0])
    if (this.job?.state === 'running') return fail('BUSY', 'An installation is already running.')
    const key = installKey(entry.plan.request.host, entry.plan.request.directory)
    if (this.busy.has(key)) return fail('BUSY', 'Another operation is running on that directory.')
    const job = newJob(entry.plan, this.now)
    this.job = job
    this.busy.set(key, 'inspect')
    this.plans.delete(entry.plan.id)
    this.status()
    void this.track((async () => {
      try {
        await runInstall(entry.plan, this.installDeps(), j => { this.job = { ...j, steps: j.steps.map(s => ({ ...s })), log: [...j.log] }; this.status() }, job)
      } finally {
        this.busy.delete(key)
        this.p.recentJobs = [{ ...job, log: job.log.slice(-200) }, ...this.p.recentJobs].slice(0, 5)
        if (job.outcome.extracted) {
          const shell = this.shellFor(entry.plan.request.host)
          const local = await inspectOne(shell, this.probes.get(hostKey(entry.plan.request.host)) ?? null, entry.plan.request.directory).catch(() => null)
          if (local) { this.p.locals = [...this.p.locals.filter(l => l.key !== local.key), { ...local, source: 'installed' }]; this.rememberKnown() }
        }
        this.persist(); this.status(); this.changed()
        if (job.outcome.registered) void this.track(this.refreshScope(entry.plan.request.scope))
      }
    })())
    return okRes(job)
  }

  cancelInstall(): boolean {
    if (!this.job || this.job.state !== 'running') return false
    this.job.cancelRequested = true
    this.status()
    return true
  }

  private async refreshScope(scope: RunnerScope) {
    try {
      const r = await this.github.listRunners(scope)
      this.p.githubs = [...this.p.githubs.filter(g => !sameScope(g.scope, scope)), ...r.runners]
      const at = new Date(this.now()).toISOString()
      this.p.scopes = [...this.p.scopes.filter(s => !sameScope(s.scope, scope)), { scope, status: 'ok', message: null, count: r.runners.length, truncated: r.truncated, fetchedAt: at }]
      this.p.githubScannedAt = at
      this.persist(); this.changed()
    } catch { /* the next scan reports it */ }
  }

  /* ------------------------------------------------------------ actions */

  find(key: string): Runner | undefined { return this.inventory().runners.find(r => r.key === key) }

  private lifecycleDeps() {
    return {
      shellFor: (h: RunnerHost) => this.shellFor(h), github: this.auth?.state === 'ok' ? this.github : null, tmpDir: this.d.tmpDir, now: this.now, sleep: this.d.sleep, download: this.d.download,
      latest: async () => { const l = await this.refreshLatest(false); return l ? { version: l.version, checksums: l.checksums } : null },
      onInspected: (local: LocalRunner | null, key: string) => {
        this.p.locals = local ? [...this.p.locals.filter(l => l.key !== key), local] : this.p.locals.filter(l => l.key !== key)
        if (!local) { const c = this.cfg(); c.known = c.known.filter(k => k.key !== key); this.d.saveConfig() }
        this.persist(); this.changed()
      },
    }
  }

  async action(key: string, action: RunnerAction, opts: ActionOptions): Promise<Res<ActionResult>> {
    const runner = this.find(key)
    if (!runner) return fail('NOT_FOUND', 'That runner is no longer in the inventory.')
    const lock = runner.local?.key ?? key
    if (this.busy.has(lock)) return fail('BUSY', `${runner.name} is busy with another operation (${this.busy.get(lock)}).`)
    if (this.job?.state === 'running' && runner.local && this.job.runnerKey === runner.local.key) return fail('BUSY', 'An installation is running in that directory.')
    if (['unregister', 'update', 'check-update'].includes(action) || (action === 'uninstall' && opts.unregisterFirst)) await this.refreshAuth()
    this.busy.set(lock, action); this.status()
    try {
      const r = await performAction(action, runner, opts, this.lifecycleDeps())
      if (r.ok && (action === 'unregister' || action === 'uninstall') && runner.scope) await this.refreshScope(runner.scope)
      if (r.ok && action === 'uninstall' && runner.github && !runner.local) this.p.githubs = this.p.githubs.filter(g => g !== runner.github)
      return okRes(r)
    } finally {
      this.busy.delete(lock); this.persist(); this.status(); this.changed()
    }
  }

  diagnostics(key: string): Promise<RunnerDiagnostics> {
    const runner = this.find(key)
    if (!runner) return Promise.resolve({ key, logs: [], service: { kind: 'unknown', name: null, state: 'unknown', startup: 'unknown', detail: null }, process: { running: null, pids: [], detail: null }, error: 'That runner is no longer in the inventory.', collectedAt: new Date(this.now()).toISOString() })
    return collectDiagnostics(runner, this.lifecycleDeps())
  }

  runsOn(key: string): Res<RunsOnExample> {
    const r = this.find(key)
    return r ? okRes(runsOnExample(r)) : fail('NOT_FOUND', 'That runner is no longer in the inventory.')
  }

  /* ------------------------------------------------------------ workflows */

  async workflowReport(repoFull: string): Promise<Res<WorkflowLabelReport>> {
    if (!validRepoFull(repoFull)) return fail('INVALID', 'Invalid repository name.')
    const runners = this.inventory().runners
    // Local copy first (no network); GitHub when the repository is not registered here.
    const local = this.d.repos().find(r => this.repoMatches(r, repoFull))
    if (local) {
      const shell = this.shellFor(local.location.kind === 'wsl' ? { kind: 'wsl', distro: local.location.distro } : { kind: 'native' })
      const sep = local.location.kind === 'wsl' || !/^[A-Za-z]:\\/.test(local.location.path) ? '/' : '\\'
      const dir = `${local.location.path}${sep}.github${sep}workflows`
      const names = ((await shell.listDir(dir)) ?? []).filter(n => /\.ya?ml$/i.test(n)).slice(0, 40)
      const files: { path: string; text: string }[] = []
      for (const n of names) { const text = await shell.readFile(`${dir}${sep}${n}`, 256 * 1024); if (text !== null) files.push({ path: `.github/workflows/${n}`, text }) }
      return okRes(buildReport(repoFull, 'local', files, runners))
    }
    const auth = await this.refreshAuth()
    if (auth.state !== 'ok') return fail('NOT_SIGNED_IN', auth.message)
    try {
      const repo = await this.github.repo(repoFull)
      const files = await this.github.workflowFiles(repo.fullName, repo.defaultBranch)
      return okRes(buildReport(repo.fullName, 'github', files, runners))
    } catch (e) { return fail('FAILED', (e as Error).message) }
  }

  private repoCache = new Map<string, string[]>()
  private repoMatches(r: Repo, full: string): boolean {
    const cached = this.repoCache.get(r.id)
    if (cached) return cached.includes(full.toLowerCase())
    // only native repositories are matched synchronously; the cache is filled by registeredRepoScopes for the rest
    if (r.location.kind !== 'native') return false
    try {
      const text = readFileSync(join(r.location.path, '.git', 'config'), 'utf8')
      const names = [...text.matchAll(/^\s*url\s*=\s*(.+)$/gm)].map(m => repoFromRemote(m[1])).filter((x): x is string => !!x).map(x => x.toLowerCase())
      this.repoCache.set(r.id, names)
      return names.includes(full.toLowerCase())
    } catch { return false }
  }

  /* ------------------------------------------------------------ links */

  async open(t: RunnersOpenTarget): Promise<Res<void>> {
    switch (t.kind) {
      case 'runner-settings': { const s = parseScope(t.scope); if (!s) return fail('INVALID', 'Invalid scope.'); await this.d.openExternal(scopeSettingsUrl(s, typeof t.runnerId === 'number' && t.runnerId > 0 ? t.runnerId : null)); return okRes(undefined) }
      case 'scope': { const s = parseScope(t.scope); if (!s) return fail('INVALID', 'Invalid scope.'); await this.d.openExternal(scopeUrl(s)); return okRes(undefined) }
      case 'workflows': { const s = parseScope(t.scope); if (!s || s.kind !== 'repo') return fail('INVALID', 'Invalid repository.'); await this.d.openExternal(`${scopeUrl(s)}/actions`); return okRes(undefined) }
      case 'docs': { const url = DOCS[t.page]; if (!url) return fail('INVALID', 'Unknown page.'); await this.d.openExternal(url); return okRes(undefined) }
      case 'release': { await this.d.openExternal(typeof t.version === 'string' && /^\d+\.\d+\.\d+$/.test(t.version) ? `${RUNNER_RELEASES}/tag/v${t.version}` : RUNNER_RELEASES); return okRes(undefined) }
      case 'folder': {
        const r = typeof t.key === 'string' ? this.find(t.key) : undefined
        if (!r?.local) return fail('NOT_FOUND', 'No local folder for that runner.')
        if (r.local.host.kind === 'ssh') return fail('REMOTE', 'The folder is on a remote machine.')
        const target = r.local.host.kind === 'wsl' ? wslUncPath(r.local.host.distro, r.local.path) : r.local.path
        const e = await this.d.openPath(target)
        return e ? fail('OPEN_FAILED', `Could not open ${target}.`, e) : okRes(undefined)
      }
      default: return fail('INVALID', 'Unknown link.')
    }
  }
}
