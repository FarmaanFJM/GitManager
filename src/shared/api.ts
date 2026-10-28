// The complete surface the renderer can reach, exposed by the preload script as window.gitmanager.
// Every call is a request to the main process, which validates the arguments. Type-only module.
import type {
  Branch, Commit, Comparison, DiscoveredRepo, Location, LogBatch, LogLine, Platform, Profile, RemoteCheck, Repo, RepoStatus,
  Result, Root, ServiceStatus, Settings,
} from './types.js'

export type AppState = {
  repos: Repo[]
  roots: Root[]
  profiles: Profile[]
  settings: Settings
  ui: { selectedRepoId: string | null; selectedProfile: Record<string, string> }
  services: ServiceStatus[]
  warning: string | null
}

export type Distros = { available: boolean; distros: { name: string; isDefault: boolean; version: number | null }[]; error?: string }

export type LaunchPreview = { service: string; runtime: string; dir: string; command: string; envKeys: string[] }

export type ApiEvents = {
  'service-status': ServiceStatus
  'service-logs': LogBatch
  'logs-cleared': string
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

  on<K extends keyof ApiEvents>(event: K, cb: (payload: ApiEvents[K]) => void): () => void
}

/** Method names, in one place, so the preload, the main process and a test can be checked against each other. */
export const API_METHODS = [
  'platform', 'state', 'pickFolder', 'addRepo', 'removeRepo', 'selectRepo', 'status', 'checkRemote', 'fetch', 'pull', 'branches',
  'switchBranch', 'trackBranch', 'log', 'compare', 'openFolder', 'openEditor', 'openUrl', 'wslDistros', 'addRoot', 'removeRoot',
  'scanRoot', 'addRepos', 'draftProfile', 'saveProfile', 'removeProfile', 'selectProfile', 'previewLaunch', 'trustProfile',
  'startServices', 'stopServices', 'restartService', 'logs', 'clearLogs', 'saveSettings',
] as const satisfies readonly Exclude<keyof GitManagerApi, 'on'>[]
