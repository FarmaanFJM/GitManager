import { spawn } from 'node:child_process'
import type { AppState, Distros, LaunchPreview } from '../shared/api.js'
import type { BranchDetail, BranchOverview, DiscoveredRepo, DiscoveryStatus, Location, OpError, Platform, Profile, RemoteCheck, Repo, RepoStatus, Result, Root, ServiceStatus, Settings } from '../shared/types.js'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { AutoDiscovery } from '../core/autodiscovery.js'
import { discover } from '../core/discovery.js'
import { BranchInspector } from '../core/git/branches.js'
import { hostOs, listWslDistros, type HostOs } from '../core/exec.js'
import { Git } from '../core/git/ops.js'
import { classifySync, isClean } from '../core/git/status.js'
import { editorSpec, openInBrowser } from '../core/launchers.js'
import { displayLocation, normalizePath, parseLocationInput, sameLocation, wslUncPath } from '../core/paths.js'
import { ServiceManager } from '../core/processes.js'
import { draftProfile, fingerprint, isTrusted, planLaunch, readRuntimeFile, serviceKey, type FileReader, type Launch } from '../core/profiles.js'
import { newId, Store } from '../core/store.js'
import * as v from '../core/validate.js'

/** What the backend needs from the desktop shell. Electron provides it in main.ts; tests provide fakes. */
export type Host = {
  pickFolder(): Promise<string | null>
  openPath(path: string): Promise<string> // '' on success, an error message otherwise (Electron's shell.openPath contract)
  openExternal(url: string): Promise<void>
  version: string
}

const ok = <T>(value: T): Result<T> => ({ ok: true, value })
const err = <T>(code: string, message: string, detail?: string): Result<T> => ({ ok: false, error: { code, message, ...(detail ? { detail } : {}) } })

/**
 * Application logic behind the IPC surface. Every public method validates its arguments (they come from the renderer)
 * and returns a Result instead of throwing, so the interface can always explain what happened.
 */
export class Backend {
  readonly services: ServiceManager
  private readonly busy = new Set<string>()
  private readonly remoteChecks = new Map<string, RemoteCheck>()

  constructor(
    readonly store: Store,
    private readonly host: Host,
    readonly opts: { os?: HostOs; git?: Git; services?: ServiceManager; readFile?: FileReader; discovery?: AutoDiscovery; home?: string } = {},
  ) {
    this.services = opts.services ?? new ServiceManager({ os: opts.os })
    this.inspector = new BranchInspector()
    // GITMANAGER_HOME points discovery at another home folder (tests, or a user who keeps code elsewhere).
    this.discovery = opts.discovery ?? new AutoDiscovery(store, { os: opts.os ?? hostOs(), home: opts.home ?? process.env.GITMANAGER_HOME ?? homedir() })
  }

  readonly inspector: BranchInspector
  readonly discovery: AutoDiscovery

  private get os() { return this.opts.os ?? hostOs() }
  private get git() { return this.opts.git ?? (this.opts.git = new Git()) }

  private repo(id: unknown): Repo {
    const r = this.store.repo(v.id(id, 'Repository id'))
    if (!r) throw new v.ValidationError('That repository is no longer registered.')
    return r
  }
  private profile(id: unknown): Profile {
    const p = this.store.profile(v.id(id, 'Profile id'))
    if (!p) throw new v.ValidationError('That profile no longer exists.')
    return p
  }

  /** One Git operation that changes something at a time per repository; reads are never blocked. */
  private async exclusive<T>(repoId: string, fn: () => Promise<Result<T>>): Promise<Result<T>> {
    if (this.busy.has(repoId)) return err('BUSY', 'Another Git operation is still running for this repository.')
    this.busy.add(repoId)
    try { return await fn() } finally { this.busy.delete(repoId) }
  }

  async platform(): Promise<Platform> {
    const os = this.os
    const wsl = os === 'windows' ? (await listWslDistros(os)).available : false
    return { os, wslAvailable: wsl, dataPath: this.store.file, version: this.host.version }
  }

  state(): AppState {
    const d = this.store.data
    return { repos: d.repos, roots: d.roots, profiles: d.profiles, settings: d.settings, ui: d.ui, services: this.services.list(), warning: this.store.loadWarning, ignored: d.ignored, compareBase: d.compareBase, discovery: this.discovery.status }
  }

  pickFolder() { return this.host.pickFolder() }

  async addRepo(input: unknown, distro?: unknown): Promise<Result<{ repo: Repo; existed: boolean }>> {
    const parsed = parseLocationInput(v.str(input, 'Path', { allowEmpty: false }), { hostOs: this.os, distro: distro ? v.distro(distro) : undefined })
    if (!parsed.ok) return err('BAD_PATH', parsed.message)
    // The same canonical path discovery uses (junctions, symbolic links, 8.3 short names and letter case resolved).
    if (parsed.location.kind === 'native') { try { parsed.location.path = normalizePath(realpathSync.native(parsed.location.path)) } catch { /* verifyRepo reports a missing folder */ } }
    const existing = this.store.findRepoByLocation(parsed.location)
    if (existing) return ok({ repo: existing, existed: true })
    const check = await this.git.verifyRepo(parsed.location)
    if (!check.ok) return { ok: false, error: { ...check.error, message: check.error.code === 'NOT_A_REPO' || check.error.code === 'GIT_FAILED' ? `${displayLocation(parsed.location)} is not a Git repository.` : check.error.message } }
    const added = this.store.addRepo(parsed.location)
    this.store.data.ui.selectedRepoId = added.repo.id
    this.store.save()
    return ok(added)
  }

  async removeRepo(id: unknown): Promise<Result<void>> {
    const repo = this.repo(id)
    if (this.services.activeForRepo(repo.id).length) return err('SERVICES_RUNNING', 'Stop the running services of this repository first.')
    this.store.removeRepo(repo.id)
    return ok(undefined)
  }

  selectRepo(id: unknown) {
    this.store.data.ui.selectedRepoId = id === null ? null : this.repo(id).id
    this.store.save()
  }

  async status(id: unknown): Promise<Result<RepoStatus>> {
    const repo = this.repo(id)
    const s = await this.git.status(repo.location)
    if (!s.ok) return s
    const p = s.value
    return ok({
      repoId: repo.id, branch: p.branch, head: p.oid ? p.oid.slice(0, 7) : null, upstream: p.upstream, ahead: p.ahead, behind: p.behind,
      sync: classifySync(p), changes: p.changes, clean: isClean(p.changes), remotes: p.remotes, checkedAt: new Date().toISOString(),
    })
  }

  /** Checks the remote the current branch tracks (or origin, or the only remote). Null when there is no remote. */
  async checkRemote(id: unknown): Promise<Result<RemoteCheck | null>> {
    const repo = this.repo(id)
    const s = await this.git.status(repo.location)
    if (!s.ok) return s
    const { remotes, upstream } = s.value
    const remote = remotes.find(r => upstream?.startsWith(r + '/')) ?? (remotes.includes('origin') ? 'origin' : remotes[0])
    if (!remote) return ok(null)
    const check = await this.git.checkRemote(repo.location, remote)
    this.remoteChecks.set(repo.id, check)
    return ok(check)
  }

  async fetch(id: unknown) {
    const repo = this.repo(id)
    return this.exclusive(repo.id, async () => {
      const r = await this.git.fetch(repo.location)
      this.inspector.invalidate(repo.id)
      // a successful fetch also proves the remote is reachable
      if (r.ok && r.value.remote !== 'all remotes') this.remoteChecks.set(repo.id, { remote: r.value.remote, reachable: true, checkedAt: new Date().toISOString() })
      return r
    })
  }

  async pull(id: unknown) {
    const repo = this.repo(id)
    return this.exclusive(repo.id, async (): Promise<Result<{ commits: number }>> => {
      const r = await this.git.pull(repo.location)
      this.inspector.invalidate(repo.id)
      return r.ok ? ok({ commits: r.value.commits }) : r
    })
  }

  async branches(id: unknown) { return this.git.branches(this.repo(id).location) }
  async log(id: unknown) { return this.git.log(this.repo(id).location, 40) }
  async compare(id: unknown) { return this.git.compare(this.repo(id).location) }

  private runningGuard(repo: Repo): OpError | null {
    const active = this.services.activeForRepo(repo.id)
    if (!active.length) return null
    const names = active.map(s => this.serviceName(s)).join(', ')
    return { code: 'SERVICES_RUNNING', message: `Stop the running services (${names}) before switching branches. Their files would change underneath them.` }
  }

  private serviceName(s: ServiceStatus) {
    return this.store.profile(s.profileId)?.services.find(x => x.id === s.serviceId)?.name ?? s.serviceId
  }

  async switchBranch(id: unknown, branch: unknown): Promise<Result<{ branch: string; carried: boolean }>> {
    const repo = this.repo(id)
    const name = v.str(branch, 'Branch', { max: 255, allowEmpty: false })
    const guard = this.runningGuard(repo)
    if (guard) return { ok: false, error: guard }
    return this.exclusive(repo.id, async () => { const r = await this.git.switchBranch(repo.location, name); this.inspector.invalidate(repo.id); return r })
  }

  async trackBranch(id: unknown, remoteRef: unknown): Promise<Result<{ branch: string }>> {
    const repo = this.repo(id)
    const ref = v.str(remoteRef, 'Remote branch', { max: 255, allowEmpty: false })
    const guard = this.runningGuard(repo)
    if (guard) return { ok: false, error: guard }
    return this.exclusive(repo.id, async () => { const r = await this.git.trackRemote(repo.location, ref); this.inspector.invalidate(repo.id); return r })
  }

  async openFolder(id: unknown): Promise<Result<void>> {
    const repo = this.repo(id)
    const target = repo.location.kind === 'wsl' ? wslUncPath(repo.location.distro, repo.location.path) : repo.location.path
    const e = await this.host.openPath(target)
    return e ? err('OPEN_FAILED', `Could not open ${target}.`, e) : ok(undefined)
  }

  async openEditor(id: unknown): Promise<Result<void>> {
    const repo = this.repo(id)
    const editor = this.store.data.settings.editor || 'code'
    const spec = editorSpec(editor, repo.location, this.os)
    return new Promise(resolve => {
      let stderr = ''
      let settled = false
      const done = (r: Result<void>) => { if (!settled) { settled = true; resolve(r) } }
      try {
        const child = spawn(spec.file, spec.args, { cwd: spec.cwd, detached: true, windowsHide: true, windowsVerbatimArguments: spec.verbatim, stdio: ['ignore', 'ignore', 'pipe'] })
        child.stderr?.on('data', (b: Buffer) => { stderr += b.toString() })
        child.on('error', e => done(err('EDITOR_MISSING', `The editor command "${editor}" was not found. Set it in Settings.`, e.message)))
        child.on('exit', code => done(code === 0 ? ok(undefined) : err('EDITOR_FAILED', `The editor command "${editor}" failed. Check it in Settings.`, stderr.trim() || `exit code ${code}`)))
        // Editors that stay attached are fine: no error within two seconds means it started.
        setTimeout(() => { child.unref(); child.stderr?.destroy(); done(ok(undefined)) }, 2000)
      } catch (e) { done(err('EDITOR_MISSING', `The editor command "${editor}" could not be started.`, (e as Error).message)) }
    })
  }

  async openUrl(profileId: unknown): Promise<Result<{ via: string }>> {
    const p = this.profile(profileId)
    if (!p.openUrl) return err('NO_URL', 'This profile has no URL to open. Add one in the profile.')
    const r = await openInBrowser(p.openUrl, p.browser, { os: this.os, chromePath: this.store.data.settings.chromePath, openDefault: u => this.host.openExternal(u) })
    return r.ok ? ok({ via: r.via }) : err('OPEN_FAILED', r.message)
  }

  wslDistros(): Promise<Distros> { return listWslDistros(this.os) }

  async addRoot(input: unknown, distro?: unknown): Promise<Result<Root>> {
    const parsed = parseLocationInput(v.str(input, 'Path', { allowEmpty: false }), { hostOs: this.os, distro: distro ? v.distro(distro) : undefined })
    if (!parsed.ok) return err('BAD_PATH', parsed.message)
    return ok(this.store.addRoot(parsed.location, this.store.data.settings.discoveryDepth))
  }

  async removeRoot(id: unknown): Promise<Result<void>> {
    this.store.removeRoot(v.id(id))
    return ok(undefined)
  }

  async scanRoot(id: unknown): Promise<Result<DiscoveredRepo[]>> {
    const root = this.store.data.roots.find(r => r.id === v.id(id))
    if (!root) return err('NOT_FOUND', 'That folder is no longer in the list.')
    const r = await discover(root.location, root.depth)
    if (!r.ok) return r
    return ok(r.value.map(({ location, worktree }) => ({ location, worktree, name: location.path.split(/[\\/]/).filter(Boolean).pop() ?? location.path, registered: !!this.store.findRepoByLocation(location) })))
  }

  /** Registers repositories picked from a discovery result. Each must still be a repository under a registered root. */
  async addRepos(locations: unknown): Promise<Result<Repo[]>> {
    if (!Array.isArray(locations) || locations.length > 500) return err('BAD_INPUT', 'Invalid selection.')
    const added: Repo[] = []
    for (const raw of locations) {
      const loc: Location = v.location(raw)
      const underRoot = this.store.data.roots.some(r => r.location.kind === loc.kind && (r.location.kind !== 'wsl' || (loc.kind === 'wsl' && r.location.distro === loc.distro)) && (loc.path.toLowerCase().startsWith(r.location.path.toLowerCase()) || sameLocation(r.location, loc)))
      if (!underRoot) continue
      if ((await this.git.verifyRepo(loc)).ok) added.push(this.store.addRepo(loc, { source: 'manual' }).repo)
    }
    return ok(added)
  }

  async draftProfile(repoId: unknown): Promise<Result<Profile>> {
    const repo = this.repo(repoId)
    return ok(draftProfile(repo, newId(), newId()))
  }

  /** Saves a profile. Trust is kept only if nothing that executes changed (the fingerprint still matches). */
  async saveProfile(raw: unknown): Promise<Result<Profile>> {
    const p = v.profile(raw)
    const repo = this.repo(p.repoId)
    const prev = this.store.profile(p.id)
    if (prev && prev.repoId !== repo.id) return err('BAD_INPUT', 'A profile cannot move to another repository.')
    if (prev && this.services.list().some(s => s.profileId === p.id && this.services.isAlive(s.key))) return err('SERVICES_RUNNING', 'Stop this profile\'s services before changing it.')
    const saved: Profile = { ...p, trustedFingerprint: prev && prev.trustedFingerprint === fingerprint(p, repo) ? prev.trustedFingerprint : null }
    for (const s of saved.services) {
      const plan = await planLaunch(saved, repo, { ...s, envFile: '' })
      if (!plan.ok) return plan
    }
    this.store.upsertProfile(saved)
    this.store.data.ui.selectedProfile[repo.id] = saved.id
    this.store.save()
    return ok(saved)
  }

  async removeProfile(id: unknown): Promise<Result<void>> {
    const p = this.profile(id)
    if (this.services.list().some(s => s.profileId === p.id && this.services.isAlive(s.key))) return err('SERVICES_RUNNING', 'Stop this profile\'s services first.')
    this.store.removeProfile(p.id)
    return ok(undefined)
  }

  selectProfile(repoId: unknown, profileId: unknown) {
    const repo = this.repo(repoId)
    const p = this.profile(profileId)
    if (p.repoId !== repo.id) throw new v.ValidationError('That profile belongs to another repository.')
    this.store.data.ui.selectedProfile[repo.id] = p.id
    this.store.save()
  }

  /** Exactly what would run, for the trust confirmation. Env values are not shown, only their names. */
  async previewLaunch(id: unknown): Promise<Result<LaunchPreview[]>> {
    const p = this.profile(id)
    const repo = this.repo(p.repoId)
    const out: LaunchPreview[] = []
    for (const s of p.services) {
      const plan = await planLaunch(p, repo, { ...s, envFile: '' })
      if (!plan.ok) return plan
      out.push({ service: s.name, runtime: p.runtime.kind === 'wsl' ? `WSL: ${p.runtime.distro}` : this.os === 'windows' ? 'Windows' : 'Native', dir: plan.value.dir, command: s.command, envKeys: [...Object.keys(s.env), ...(s.envFile ? [`(from ${s.envFile})`] : [])] })
    }
    return ok(out)
  }

  async trustProfile(id: unknown): Promise<Result<Profile>> {
    const p = this.profile(id)
    const repo = this.repo(p.repoId)
    const trusted = { ...p, trustedFingerprint: fingerprint(p, repo) }
    this.store.upsertProfile(trusted)
    return ok(trusted)
  }

  /** Starts one or all services of a trusted profile. Nothing runs from an untrusted or modified profile. */
  async startServices(profileId: unknown, serviceId?: unknown): Promise<Result<ServiceStatus[]>> {
    const p = this.profile(profileId)
    const repo = this.repo(p.repoId)
    if (!isTrusted(p, repo)) return err('UNTRUSTED', 'Review and trust this profile before running it.')
    const targets = serviceId === undefined ? p.services : p.services.filter(s => s.id === v.id(serviceId, 'Service id'))
    if (!targets.length) return err('NOT_FOUND', 'That service no longer exists.')
    const launches: Launch[] = []
    for (const s of targets) {
      const plan = await planLaunch(p, repo, s, this.opts.readFile ?? readRuntimeFile)
      if (!plan.ok) return plan
      launches.push(plan.value)
    }
    return ok(await Promise.all(launches.map(l => this.services.start(l))))
  }

  async stopServices(profileId: unknown, serviceId?: unknown): Promise<Result<void>> {
    const p = this.profile(profileId)
    const keys = (serviceId === undefined ? p.services : p.services.filter(s => s.id === v.id(serviceId, 'Service id'))).map(s => serviceKey(p.id, s.id))
    await Promise.all(keys.map(k => this.services.stop(k)))
    return ok(undefined)
  }

  async restartService(profileId: unknown, serviceId: unknown): Promise<Result<ServiceStatus[]>> {
    await this.stopServices(profileId, serviceId)
    return this.startServices(profileId, serviceId)
  }

  logs(key: unknown) { return this.services.logs(v.str(key, 'key', { max: 140 })) }
  clearLogs(key: unknown) { this.services.clearLogs(v.str(key, 'key', { max: 140 })) }

  /* ------------------------------------------------------------ automatic discovery */

  discoveryStatus(): DiscoveryStatus { return this.discovery.status }

  /** Starts a scan in the background and returns at once; progress arrives as events. 'deep' also searches whole drives. */
  async rescan(scope: unknown): Promise<Result<DiscoveryStatus>> {
    const s = scope === 'deep' ? 'deep' : 'common'
    void this.discovery.run(s)
    return ok(this.discovery.status)
  }

  async unignoreRepo(key: unknown): Promise<Result<void>> {
    this.store.unignore(v.str(key, 'Key', { max: 4096, allowEmpty: false }))
    return ok(undefined)
  }

  /* ------------------------------------------------------------ branch overview (read-only) */

  async branchOverview(id: unknown): Promise<Result<BranchOverview>> {
    const repo = this.repo(id)
    return this.inspector.overview(repo.id, repo.location, { chosen: this.store.data.compareBase[repo.id] ?? null })
  }

  async branchDetail(id: unknown, ref: unknown, baseRef: unknown): Promise<Result<BranchDetail>> {
    const repo = this.repo(id)
    return this.inspector.detail(repo.location, v.str(baseRef, 'Base', { max: 512, allowEmpty: false }), v.str(ref, 'Branch', { max: 512, allowEmpty: false }))
  }

  /** Persists the comparison base for a repository (a branch name such as main or origin/main), or clears it with null. */
  async setCompareBase(id: unknown, ref: unknown): Promise<Result<void>> {
    const repo = this.repo(id)
    if (ref === null) delete this.store.data.compareBase[repo.id]
    else {
      const name = v.str(ref, 'Branch', { max: 255, allowEmpty: false })
      if (name.startsWith('-') || /[\s~^:?*[\\]|\.\./.test(name)) throw new v.ValidationError('That is not a branch name.')
      this.store.data.compareBase[repo.id] = name
    }
    this.store.save()
    return ok(undefined)
  }

  async saveSettings(raw: unknown): Promise<Result<Settings>> {
    const s = v.settings(raw)
    this.store.data.settings = s
    this.store.save()
    return ok(s)
  }
}
