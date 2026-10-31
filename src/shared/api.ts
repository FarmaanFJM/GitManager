// The complete surface the renderer can reach, exposed by the preload script as window.gitmanager.
// Every call is a request to the main process, which validates the arguments. Type-only module.
import type {
  Branch, BranchDetail, BranchOverview, Commit, Comparison, DeleteResult, DeletionReport, DiscoveredRepo, DiscoveryStatus, IgnoredRepo, Location, LogBatch, LogLine,
  Platform, Profile, RemoteCheck, Repo, RepoStatus, Result, Root, ServiceStatus, Settings, StartupState,
} from './types.js'
import type { ArtifactRef, AuditView, AuthState, CleanupPlan, OpenTarget, OperationResult, StorageSettings, StorageState } from './storage.js'
import type {
  ActionOptions, ActionResult, GitHubOrgChoice, GitHubRepoChoice, HostProbe, InstallJob, InstallPlan, RunnerAction, RunnerDiagnostics, RunnerGroupInfo, RunnerHost, RunnerRoot, RunnersOpenTarget, RunnersScan, RunnersSettings, RunnersState, RunsOnExample, SshConfigHost, WorkflowLabelReport,
} from './runners.js'

export type AppState = {
  repos: Repo[]
  roots: Root[]
  profiles: Profile[]
  settings: Settings
  ui: { selectedRepoId: string | null; selectedProfile: Record<string, string> }
  services: ServiceStatus[]
  warning: string | null
  ignored: IgnoredRepo[]
  compareBase: Record<string, string>
  discovery: DiscoveryStatus
}

export type Distros = { available: boolean; distros: { name: string; isDefault: boolean; version: number | null }[]; error?: string }

export type LaunchPreview = { service: string; runtime: string; dir: string; command: string; envKeys: string[] }

export type ApiEvents = {
  'service-status': ServiceStatus
  'service-logs': LogBatch
  'logs-cleared': string
  'discovery-status': DiscoveryStatus
  'repo-added': Repo
  /** Scan, cleanup and schedule progress (small). */
  'storage-status': Pick<StorageState, 'scan' | 'operation' | 'scheduler' | 'auth'>
  /** The stored scan, alerts or settings changed; ask for storageState again. */
  'storage-changed': null
  /** Runners: scan progress, the running installation job, busy installations and sign-in state (small). */
  'runners-status': { scan: RunnersScan; job: InstallJob | null; busy: Record<string, RunnerAction>; auth: AuthState | null }
  /** Runners: the inventory or settings changed; ask for runnersState again. */
  'runners-changed': null
}

export interface GitManagerApi {
  platform(): Promise<Platform>
  state(): Promise<AppState>

  pickFolder(): Promise<string | null>
  addRepo(input: string, distro?: string): Promise<Result<{ repo: Repo; existed: boolean }>>
  removeRepo(repoId: string): Promise<Result<void>>
  /** Everything the confirmation dialog shows before a repository's folder may be deleted. Read-only. */
  deletionPreview(repoId: string): Promise<Result<DeletionReport>>
  /** Deletes the local folder (never anything on GitHub). confirmPath must equal the repository path exactly; permanent needs confirmPermanent. */
  deleteRepoFolder(repoId: string, opts: { confirmPath: string; permanent?: boolean; confirmPermanent?: boolean }): Promise<Result<DeleteResult>>
  selectRepo(repoId: string | null): Promise<void>
  status(repoId: string): Promise<Result<RepoStatus>>
  checkRemote(repoId: string): Promise<Result<RemoteCheck | null>>

  fetch(repoId: string): Promise<Result<{ remote: string }>>
  pull(repoId: string): Promise<Result<{ commits: number }>>
  branches(repoId: string): Promise<Result<Branch[]>>
  switchBranch(repoId: string, branch: string): Promise<Result<{ branch: string; carried: boolean }>>
  trackBranch(repoId: string, remoteRef: string): Promise<Result<{ branch: string }>>
  log(repoId: string): Promise<Result<Commit[]>>
  compare(repoId: string): Promise<Result<Comparison>>

  openFolder(repoId: string): Promise<Result<void>>
  openEditor(repoId: string): Promise<Result<void>>
  openUrl(profileId: string): Promise<Result<{ via: string }>>

  wslDistros(): Promise<Distros>
  addRoot(input: string, distro?: string): Promise<Result<Root>>
  removeRoot(rootId: string): Promise<Result<void>>
  scanRoot(rootId: string): Promise<Result<DiscoveredRepo[]>>
  addRepos(locations: Location[]): Promise<Result<Repo[]>>

  draftProfile(repoId: string): Promise<Result<Profile>>
  saveProfile(profile: Profile): Promise<Result<Profile>>
  removeProfile(profileId: string): Promise<Result<void>>
  selectProfile(repoId: string, profileId: string): Promise<void>
  previewLaunch(profileId: string): Promise<Result<LaunchPreview[]>>
  trustProfile(profileId: string): Promise<Result<Profile>>

  startServices(profileId: string, serviceId?: string): Promise<Result<ServiceStatus[]>>
  stopServices(profileId: string, serviceId?: string): Promise<Result<void>>
  restartService(profileId: string, serviceId: string): Promise<Result<ServiceStatus[]>>
  logs(key: string): Promise<LogLine[]>
  clearLogs(key: string): Promise<void>

  saveSettings(settings: Settings): Promise<Result<Settings>>
  startupState(): Promise<StartupState>

  discoveryStatus(): Promise<DiscoveryStatus>
  rescan(scope: 'common' | 'deep'): Promise<Result<DiscoveryStatus>>
  unignoreRepo(key: string): Promise<Result<void>>

  branchOverview(repoId: string): Promise<Result<BranchOverview>>
  branchDetail(repoId: string, ref: string, baseRef: string): Promise<Result<BranchDetail>>
  setCompareBase(repoId: string, ref: string | null): Promise<Result<void>>

  storageState(): Promise<StorageState>
  storageAuth(): Promise<AuthState>
  storageScan(): Promise<Result<{ started: true }>>
  storageCancel(): Promise<boolean>
  storageCandidates(): Promise<ArtifactRef[]>
  storagePreview(refs: ArtifactRef[]): Promise<CleanupPlan>
  /** Deletes permanently. Refused unless `confirm` is true (or `dryRun`, which changes nothing). */
  storageDelete(refs: ArtifactRef[], opts: { dryRun: boolean; confirm: boolean }): Promise<Result<OperationResult>>
  storagePin(repo: string, artifactId: number, pinned: boolean): Promise<Result<void>>
  storageProtectRepo(repo: string, on: boolean): Promise<Result<void>>
  storageSavePolicy(repo: string | null, policy: unknown, approve: boolean): Promise<Result<{ effective: string }>>
  storageSaveSettings(settings: StorageSettings): Promise<Result<void>>
  storageRunAutomation(): Promise<Result<{ scanned: string[]; deleted: number; recommended: number }>>
  storageDismissRecommendation(): Promise<void>
  storageAudit(): Promise<AuditView>
  storageOpen(target: OpenTarget): Promise<Result<void>>

  runnersState(): Promise<RunnersState>
  runnersAuth(): Promise<AuthState>
  /** Starts a scan in the background; progress arrives as runners-status events, results as runners-changed. */
  runnersScan(opts?: { localOnly?: boolean; githubOnly?: boolean }): Promise<Result<{ started: true }>>
  runnersCancel(): Promise<boolean>
  /** GitHub-only refresh, rate-limited to once a minute unless forced. */
  runnersRefresh(force?: boolean): Promise<Result<{ started: boolean }>>
  runnersSaveSettings(settings: RunnersSettings): Promise<Result<void>>
  runnersAddRoot(host: RunnerHost, path: string): Promise<Result<RunnerRoot>>
  runnersRemoveRoot(rootId: string): Promise<Result<void>>
  runnersSshHosts(): Promise<SshConfigHost[]>
  runnersAllowSsh(alias: string, allowed: boolean): Promise<Result<void>>
  runnersProbe(host: RunnerHost): Promise<Result<HostProbe>>
  runnersRepos(query: string): Promise<GitHubRepoChoice[]>
  runnersOrgs(): Promise<GitHubOrgChoice[]>
  runnersGroups(org: string): Promise<Result<RunnerGroupInfo[]>>
  runnersPlan(request: unknown): Promise<Result<InstallPlan>>
  /** Runs a reviewed plan. Refused unless confirm is true. */
  runnersInstall(planId: string, confirm: boolean): Promise<Result<InstallJob>>
  runnersCancelInstall(): Promise<boolean>
  runnersAction(key: string, action: RunnerAction, opts: ActionOptions): Promise<Result<ActionResult>>
  /** Hides an orphaned installation from the active inventory (persistent, reversible, touches no files). */
  runnersRetire(key: string): Promise<Result<{ retired: true }>>
  runnersRestore(key: string): Promise<Result<{ restored: true }>>
  /** Deletes the files of a retired installation after fresh verification. Refused unless confirmPath equals the installation path exactly. */
  runnersCleanup(key: string, confirmPath: string): Promise<Result<ActionResult>>
  runnersDiagnostics(key: string): Promise<RunnerDiagnostics>
  runnersRunsOn(key: string): Promise<Result<RunsOnExample>>
  runnersWorkflows(repo: string): Promise<Result<WorkflowLabelReport>>
  runnersOpen(target: RunnersOpenTarget): Promise<Result<void>>

  on<K extends keyof ApiEvents>(event: K, cb: (payload: ApiEvents[K]) => void): () => void
}

/** Method names, in one place, so the preload, the main process and a test can be checked against each other. */
export const API_METHODS = [
  'platform', 'state', 'pickFolder', 'addRepo', 'removeRepo', 'deletionPreview', 'deleteRepoFolder', 'selectRepo', 'status', 'checkRemote', 'fetch', 'pull', 'branches',
  'switchBranch', 'trackBranch', 'log', 'compare', 'openFolder', 'openEditor', 'openUrl', 'wslDistros', 'addRoot', 'removeRoot',
  'scanRoot', 'addRepos', 'draftProfile', 'saveProfile', 'removeProfile', 'selectProfile', 'previewLaunch', 'trustProfile',
  'startServices', 'stopServices', 'restartService', 'logs', 'clearLogs', 'saveSettings', 'startupState',
  'discoveryStatus', 'rescan', 'unignoreRepo', 'branchOverview', 'branchDetail', 'setCompareBase',
  'storageState', 'storageAuth', 'storageScan', 'storageCancel', 'storageCandidates', 'storagePreview', 'storageDelete', 'storagePin', 'storageProtectRepo',
  'storageSavePolicy', 'storageSaveSettings', 'storageRunAutomation', 'storageDismissRecommendation', 'storageAudit', 'storageOpen',
  'runnersState', 'runnersAuth', 'runnersScan', 'runnersCancel', 'runnersRefresh', 'runnersSaveSettings', 'runnersAddRoot', 'runnersRemoveRoot', 'runnersSshHosts', 'runnersAllowSsh', 'runnersProbe',
  'runnersRepos', 'runnersOrgs', 'runnersGroups', 'runnersPlan', 'runnersInstall', 'runnersCancelInstall', 'runnersAction', 'runnersRetire', 'runnersRestore', 'runnersCleanup', 'runnersDiagnostics', 'runnersRunsOn', 'runnersWorkflows', 'runnersOpen',
] as const satisfies readonly Exclude<keyof GitManagerApi, 'on'>[]
