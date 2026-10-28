// Types shared by the main process, the preload bridge and the renderer. No runtime code.

/** Where a repository lives and which Git executable owns it. Fixed at registration; never mixed. */
export type Location =
  | { kind: 'native'; path: string }
  | { kind: 'wsl'; distro: string; path: string }

/** Where commands run. A WSL repository always runs in its own distribution. */
export type Runtime = { kind: 'native' } | { kind: 'wsl'; distro: string }

export type Repo = {
  id: string
  name: string
  location: Location
  addedAt: string
}

export type Root = { id: string; location: Location; depth: number }

export type SyncState = 'up-to-date' | 'ahead' | 'behind' | 'diverged' | 'no-upstream' | 'upstream-gone' | 'detached'

export type RepoStatus = {
  repoId: string
  branch: string | null // null when detached
  head: string | null // abbreviated commit, null in an empty repository
  upstream: string | null
  ahead: number
  behind: number
  sync: SyncState
  changes: { staged: number; unstaged: number; untracked: number; conflicted: number }
  clean: boolean
  remotes: string[]
  checkedAt: string
}

export type RemoteCheck = { remote: string; reachable: boolean; error?: string; checkedAt: string }

export type Branch = {
  name: string // local: main, remote: origin/main
  kind: 'local' | 'remote'
  current: boolean
  upstream?: string
  /** Remote branch only: a local branch already tracks it. */
  tracked?: boolean
  date: number
}

export type Commit = { hash: string; short: string; author: string; date: number; subject: string }

export type Comparison = { upstream: string | null; incoming: Commit[]; outgoing: Commit[] }

export type Readiness =
  | { type: 'none' }
  | { type: 'http'; url: string }
  | { type: 'port'; port: number; host?: string }

export type ServiceDef = {
  id: string
  name: string
  command: string
  /** Relative to the profile working directory. Empty means the same directory. */
  cwd: string
  env: Record<string, string>
  /** A local env file (KEY=VALUE lines), relative to the profile working directory or absolute. */
  envFile: string
  readiness: Readiness
  /** Seconds to wait for the readiness check before reporting failure. */
  readyTimeout: number
}

export type Browser = 'default' | 'chrome' | 'edge'

export type Profile = {
  id: string
  repoId: string
  name: string
  runtime: Runtime
  /** Relative to the repository root. Empty means the root. */
  workingDir: string
  services: ServiceDef[]
  openUrl: string
  browser: Browser
  /** Fingerprint of everything that decides what gets executed, recorded when the user trusted it. */
  trustedFingerprint: string | null
}

export type Settings = {
  editor: string // command, e.g. "code"
  chromePath: string // empty: auto-detect
  discoveryDepth: number
}

export type ServiceState = 'stopped' | 'starting' | 'running' | 'ready' | 'stopping' | 'failed'

export type ServiceStatus = {
  key: string // profileId:serviceId
  profileId: string
  serviceId: string
  repoId: string
  state: ServiceState
  pid: number | null
  startedAt: string | null
  exitCode: number | null
  message: string | null
}

export type LogLine = { seq: number; stream: 'out' | 'err' | 'sys'; text: string; at: number }

export type LogBatch = { key: string; lines: LogLine[] }

export type DiscoveredRepo = { location: Location; name: string; registered: boolean }

export type OpError = { code: string; message: string; detail?: string }

export type Result<T> = { ok: true; value: T } | { ok: false; error: OpError }

export type Platform = { os: 'windows' | 'mac' | 'linux'; wslAvailable: boolean; dataPath: string; version: string }
