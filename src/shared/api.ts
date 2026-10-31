// The complete surface the renderer can reach, exposed by the preload script as window.gitmanager.
// Every call is a request to the main process, which validates the arguments. Type-only module.
import type {
  Branch, BranchDetail, BranchOverview, Commit, Comparison, DiscoveredRepo, DiscoveryStatus, IgnoredRepo, Location, LogBatch, LogLine,
  Platform, Profile, RemoteCheck, Repo, RepoStatus, Result, Root, ServiceStatus, Settings, StartupState,
} from './types.js'
import type { ArtifactRef, AuditView, AuthState, CleanupPlan, OpenTarget, OperationResult, StorageSettings, StorageState } from './storage.js'

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
}

export interface GitManagerApi {
  platform(): Promise<Platform>
  state(): Promise<AppState>

  pickFolder(): Promise<string | null>
  addRepo(input: string, distro?: string): Promise<Result<{ repo: Repo; existed: boolean }>>
  removeRepo(repoId: string): Promise<Result<void>>
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

  on<K extends keyof ApiEvents>(event: K, cb: (payload: ApiEvents[K]) => void): () => void
}

/** Method names, in one place, so the preload, the main process and a test can be checked against each other. */
export const API_METHODS = [
  'platform', 'state', 'pickFolder', 'addRepo', 'removeRepo', 'selectRepo', 'status', 'checkRemote', 'fetch', 'pull', 'branches',
  'switchBranch', 'trackBranch', 'log', 'compare', 'openFolder', 'openEditor', 'openUrl', 'wslDistros', 'addRoot', 'removeRoot',
  'scanRoot', 'addRepos', 'draftProfile', 'saveProfile', 'removeProfile', 'selectProfile', 'previewLaunch', 'trustProfile',
  'startServices', 'stopServices', 'restartService', 'logs', 'clearLogs', 'saveSettings', 'startupState',
  'discoveryStatus', 'rescan', 'unignoreRepo', 'branchOverview', 'branchDetail', 'setCompareBase',
  'storageState', 'storageAuth', 'storageScan', 'storageCancel', 'storageCandidates', 'storagePreview', 'storageDelete', 'storagePin', 'storageProtectRepo',
  'storageSavePolicy', 'storageSaveSettings', 'storageRunAutomation', 'storageDismissRecommendation', 'storageAudit', 'storageOpen',
] as const satisfies readonly Exclude<keyof GitManagerApi, 'on'>[]
