import { spawn } from 'node:child_process'
import { dirname } from 'node:path'
import type { AppState, Distros, LaunchPreview } from '../shared/api.js'
import type { BranchDetail, BranchOverview, DiscoveredRepo, DiscoveryStatus, Location, OpError, Platform, Profile, RemoteCheck, Repo, RepoStatus, Result, Root, ServiceStatus, Settings, StartupState } from '../shared/types.js'
import { realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
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
import { reconcile, Startup } from '../core/startup.js'
import { newId, Store } from '../core/store.js'
import * as v from '../core/validate.js'
import type { ArtifactRef, AuditView, AuthState, CleanupPlan, OpenTarget, OperationResult, StorageSettings, StorageState } from '../shared/storage.js'
import { validRepoName } from '../core/storage/config.js'
import { GhCli } from '../core/storage/gh.js'
import { StorageService } from '../core/storage/service.js'
import type { ActionOptions, ActionResult, GitHubOrgChoice, GitHubRepoChoice, HostProbe, InstallJob, InstallPlan, RunnerAction, RunnerDiagnostics, RunnerGroupInfo, RunnerHost, RunnerRoot, RunnersOpenTarget, RunnersState, RunsOnExample, SshConfigHost, WorkflowLabelReport } from '../shared/runners.js'
import { parseHost } from '../core/runners/config.js'
import { RunnerManager } from '../core/runners/manager.js'
import { validOwner, validRepoFull } from '../core/runners/model.js'
import { validSshAlias } from '../core/runners/hosts.js'

/** What the backend needs from the desktop shell. Electron provides it in main.ts; tests provide fakes. */
export type Host = {
  pickFolder(): Promise<string | null>
  openPath(path: string): Promise<string> // '' on success, an error message otherwise (Electron's shell.openPath contract)
  openExternal(url: string): Promise<void>
  version: string
  /** Called after settings are saved or corrected (main.ts updates the tray). */
  settingsChanged?(settings: Settings): void
  /** A system notification (optional; used for scheduled storage results when the user turned them on). */
  notify?(title: string, body: string): void
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
    readonly opts: { os?: HostOs; git?: Git; services?: ServiceManager; readFile?: FileReader; discovery?: AutoDiscovery; home?: string; startup?: Startup; storage?: StorageService; runners?: RunnerManager } = {},
  ) {
    this.services = opts.services ?? new ServiceManager({ os: opts.os })
    this.inspector = new BranchInspector()
    // GITMANAGER_HOME points discovery at another home folder (tests, or a user who keeps code elsewhere).
    this.discovery = opts.discovery ?? new AutoDiscovery(store, { os: opts.os ?? hostOs(), home: opts.home ?? process.env.GITMANAGER_HOME ?? homedir() })
    this.startup = opts.startup ?? new Startup(null, { platform: process.platform, packaged: false, execPath: process.execPath })
    // GitHub access goes through the GitHub CLI's own sign-in; GitManager never sees or stores a token.
    this.storage = opts.storage ?? new StorageService({
      dir: dirname(store.file), gh: new GhCli(), config: () => store.data.storage, saveConfig: () => store.save(),
      openExternal: u => host.openExternal(u), notify: (t, b) => host.notify?.(t, b),
    })
    // The Runners tool has its own GitHub CLI door (registration tokens and runner removal allowed, nothing else) and its own request log.
    this.runners = opts.runners ?? new RunnerManager({
      dir: dirname(store.file), gh: new GhCli({ profile: 'runners' }), config: () => store.data.runners, saveConfig: () => store.save(), os: opts.os ?? hostOs(), tmpDir: tmpdir(),
      repos: () => store.data.repos, openExternal: u => host.openExternal(u), openPath: p => host.openPath(p),
    })
  }

  readonly storage: StorageService
  readonly runners: RunnerManager

  readonly inspector: BranchInspector
  readonly discovery: AutoDiscovery
  readonly startup: Startup

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

  /**
   * Writes or removes the Windows startup entry when the switch differs from what Windows will do, then stores the
   * settings with the switch as Windows reports it afterwards.
   */
  async saveSettings(raw: unknown): Promise<Result<Settings>> {
    let s = v.settings(raw)
    const before = this.startup.state()
    if (before.supported && s.launchAtStartup !== before.active) {
      try { s = reconcile(s, this.startup.set(s.launchAtStartup)) } catch (e) {
        return err('STARTUP', 'Windows did not accept the change to the startup entry.', (e as Error).message)
      }
    } else if (!before.supported) s = { ...s, launchAtStartup: false }
    this.store.data.settings = s
    this.store.save()
    this.host.settingsChanged?.(s)
    return ok(s)
  }

  /** The startup entry as Windows sees it now. A change made outside GitManager (Task Manager) corrects the stored switch. */
  async startupState(): Promise<StartupState> {
    const st = this.startup.state()
    const cur = this.store.data.settings
    const next = reconcile(cur, st)
    if (next !== cur) {
      this.store.data.settings = next
      this.store.save()
      this.host.settingsChanged?.(next)
    }
    return st
  }

  /* ------------------------------------------------------------ storage (GitHub Actions artifacts) */

  private refs(raw: unknown): ArtifactRef[] {
    if (!Array.isArray(raw) || raw.length > 20_000) throw new v.ValidationError('Invalid selection.')
    return raw.map(x => {
      const o = (x ?? {}) as Record<string, unknown>
      if (!validRepoName(o.repo) || typeof o.id !== 'number' || !Number.isSafeInteger(o.id) || o.id <= 0) throw new v.ValidationError('Invalid artifact in the selection.')
      return { repo: o.repo, id: o.id }
    })
  }

  storageState(): StorageState { return this.storage.state() }
  storageAuth(): Promise<AuthState> { return this.storage.refreshAuth() }
  storageScan(): Promise<Result<{ started: true }>> { return this.storage.scan() as Promise<Result<{ started: true }>> }
  storageCancel(): boolean { return this.storage.cancel() }
  storageCandidates(): ArtifactRef[] { return this.storage.candidates() }
  storagePreview(refs: unknown): CleanupPlan { return this.storage.preview(this.refs(refs)) }

  /** Permanent deletion. Needs the explicit `confirm: true` of the cleanup preview; a dry run needs nothing and changes nothing. */
  async storageDelete(refs: unknown, opts: unknown): Promise<Result<OperationResult>> {
    const o = (opts ?? {}) as Record<string, unknown>
    const dryRun = o.dryRun === true
    if (!dryRun && o.confirm !== true) return err('NOT_CONFIRMED', 'Deleting artifacts needs your explicit confirmation.')
    return this.storage.execute(this.refs(refs), { dryRun }) as Promise<Result<OperationResult>>
  }

  async storagePin(repo: unknown, artifactId: unknown, pinned: unknown): Promise<Result<void>> {
    return this.storage.setPinned(String(repo), Number(artifactId), pinned === true) as Result<void>
  }
  async storageProtectRepo(repo: unknown, on: unknown): Promise<Result<void>> { return this.storage.setRepoProtected(String(repo), on === true) as Result<void> }
  async storageSavePolicy(repo: unknown, policy: unknown, approve: unknown): Promise<Result<{ effective: string }>> {
    return this.storage.savePolicy(repo === null ? null : String(repo), policy, approve === true) as Result<{ effective: string }>
  }
  async storageSaveSettings(settings: unknown): Promise<Result<void>> { return this.storage.saveSettings(settings as StorageSettings) as Result<void> }
  async storageRunAutomation(): Promise<Result<{ scanned: string[]; deleted: number; recommended: number }>> { return ok(await this.storage.runAutomation()) }
  storageDismissRecommendation() { this.storage.clearRecommendation() }
  storageAudit(): AuditView { return this.storage.auditView() }
  async storageOpen(target: unknown): Promise<Result<void>> {
    const t = (target ?? {}) as Record<string, unknown>
    const kind = t.kind
    if (kind === 'run') return this.storage.open({ kind, repo: String(t.repo), runId: Number(t.runId) }) as Promise<Result<void>>
    if (kind === 'repo-actions') return this.storage.open({ kind, repo: String(t.repo) }) as Promise<Result<void>>
    if (kind === 'billing' || kind === 'billing-docs' || kind === 'scopes') return this.storage.open({ kind } as OpenTarget) as Promise<Result<void>>
    return err('INVALID', 'Unknown link.')
  }
  /* ------------------------------------------------------------ runners (GitHub Actions self-hosted runners) */

  private runnerKey(raw: unknown) { return v.str(raw, 'Runner', { max: 1024, allowEmpty: false }) }
  private runnerHost(raw: unknown): RunnerHost { const h = parseHost(raw); if (!h) throw new v.ValidationError('Invalid host.'); return h }

  runnersState(): Promise<RunnersState> { return this.runners.state() }
  runnersAuth(): Promise<AuthState> { return this.runners.refreshAuth() }
  async runnersScan(opts: unknown): Promise<Result<{ started: true }>> {
    const o = (opts ?? {}) as Record<string, unknown>
    return this.runners.scan({ localOnly: o.localOnly === true, githubOnly: o.githubOnly === true }) as Result<{ started: true }>
  }
  runnersCancel(): boolean { return this.runners.cancel() }
  async runnersRefresh(force: unknown): Promise<Result<{ started: boolean }>> { return this.runners.refreshGithub(force === true) as Result<{ started: boolean }> }
  async runnersSaveSettings(settings: unknown): Promise<Result<void>> { return this.runners.saveSettings(settings) as Result<void> }
  async runnersAddRoot(host: unknown, path: unknown): Promise<Result<RunnerRoot>> {
    return this.runners.addRoot(this.runnerHost(host), v.str(path, 'Path', { max: 1024, allowEmpty: false }).trim()) as Result<RunnerRoot>
  }
  async runnersRemoveRoot(id: unknown): Promise<Result<void>> { return this.runners.removeRoot(v.id(id)) as Result<void> }
  runnersSshHosts(): Promise<SshConfigHost[]> { return this.runners.sshHosts() }
  async runnersAllowSsh(alias: unknown, allowed: unknown): Promise<Result<void>> {
    if (!validSshAlias(alias)) throw new v.ValidationError('Invalid SSH host alias.')
    return this.runners.setSshHostAllowed(alias, allowed === true) as Result<void>
  }
  async runnersProbe(host: unknown): Promise<Result<HostProbe>> { return ok(await this.runners.probe(this.runnerHost(host))) }
  runnersRepos(query: unknown): Promise<GitHubRepoChoice[]> { return this.runners.repoChoices(v.str(query ?? '', 'Search', { max: 200 })) }
  runnersOrgs(): Promise<GitHubOrgChoice[]> { return this.runners.orgChoices() }
  async runnersGroups(org: unknown): Promise<Result<RunnerGroupInfo[]>> {
    if (!validOwner(org)) throw new v.ValidationError('Invalid organization.')
    return this.runners.runnerGroups(org) as Promise<Result<RunnerGroupInfo[]>>
  }
  async runnersPlan(request: unknown): Promise<Result<InstallPlan>> { return this.runners.plan(request) as Promise<Result<InstallPlan>> }
  /** Installs a reviewed plan. Refused unless confirm is exactly true. */
  async runnersInstall(planId: unknown, confirm: unknown): Promise<Result<InstallJob>> { return this.runners.startInstall(typeof planId === 'string' ? v.id(planId, 'Plan') : planId, confirm) as Result<InstallJob> }
  runnersCancelInstall(): boolean { return this.runners.cancelInstall() }
  async runnersAction(key: unknown, action: unknown, opts: unknown): Promise<Result<ActionResult>> {
    const actions: RunnerAction[] = ['start', 'stop', 'restart', 'inspect', 'check-update', 'update', 'unregister', 'uninstall']
    if (!actions.includes(action as RunnerAction)) throw new v.ValidationError('Unknown operation.')
    const o = (opts ?? {}) as Record<string, unknown>
    const options: ActionOptions = { allowBusy: o.allowBusy === true, confirm: o.confirm === true, unregisterFirst: o.unregisterFirst === true }
    return this.runners.action(this.runnerKey(key), action as RunnerAction, options) as Promise<Result<ActionResult>>
  }
  runnersDiagnostics(key: unknown): Promise<RunnerDiagnostics> { return this.runners.diagnostics(this.runnerKey(key)) }
  async runnersRunsOn(key: unknown): Promise<Result<RunsOnExample>> { return this.runners.runsOn(this.runnerKey(key)) as Result<RunsOnExample> }
  async runnersWorkflows(repo: unknown): Promise<Result<WorkflowLabelReport>> {
    if (!validRepoFull(repo)) throw new v.ValidationError('Invalid repository name.')
    return this.runners.workflowReport(repo) as Promise<Result<WorkflowLabelReport>>
  }
  async runnersOpen(target: unknown): Promise<Result<void>> {
    const t = (target ?? {}) as Record<string, unknown>
    const kinds = ['runner-settings', 'scope', 'workflows', 'docs', 'folder', 'release']
    if (!kinds.includes(t.kind as string)) return err('INVALID', 'Unknown link.')
    if (t.kind === 'folder') return this.runners.open({ kind: 'folder', key: this.runnerKey(t.key) }) as Promise<Result<void>>
    if (t.kind === 'docs') return this.runners.open({ kind: 'docs', page: String(t.page) as never }) as Promise<Result<void>>
    if (t.kind === 'release') return this.runners.open({ kind: 'release', version: typeof t.version === 'string' ? t.version : null }) as Promise<Result<void>>
    return this.runners.open({ kind: t.kind, scope: t.scope, runnerId: typeof t.runnerId === 'number' ? t.runnerId : null } as RunnersOpenTarget) as Promise<Result<void>>
  }
}
