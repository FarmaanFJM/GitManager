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
  /** manual: added by the user; discovered: registered by automatic discovery. */
  source?: 'manual' | 'discovered'
  /** A linked worktree of another repository (its .git is a file pointing into <repo>/.git/worktrees). */
  worktree?: boolean
}

/** A repository the user removed or ignored; discovery never registers it again. */
export type IgnoredRepo = { key: string; location: Location; at: string }

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
  /** Scan common development folders and WSL home folders at every launch. */
  autoDiscover: boolean
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

export type DiscoveredRepo = { location: Location; name: string; registered: boolean; worktree?: boolean }

export type OpError = { code: string; message: string; detail?: string }

export type Result<T> = { ok: true; value: T } | { ok: false; error: OpError }

export type Platform = { os: 'windows' | 'mac' | 'linux'; wslAvailable: boolean; dataPath: string; version: string }

/** The ref every branch is compared with. `source` says how it was determined; nothing is guessed. */
export type BranchBase = {
  ref: string // full ref, e.g. refs/remotes/origin/main
  name: string // origin/main
  source: 'remote-head' | 'ls-remote' | 'user'
  remote: string | null
  oid: string
}

export type CompareState = 'base' | 'up-to-date' | 'ahead' | 'behind' | 'diverged' | 'unrelated' | 'unknown'
export type UpstreamState = 'in-sync' | 'ahead' | 'behind' | 'diverged' | 'gone' | 'none'

export type BranchRow = {
  ref: string
  name: string
  kind: 'local' | 'remote'
  remote?: string
  oid: string
  short: string
  current: boolean
  isBase: boolean
  upstream?: string
  upstreamState: UpstreamState
  upstreamAhead: number
  upstreamBehind: number
  /** Against the base: commits only on this branch (ahead) and only on the base (behind). Null when there is no base. */
  ahead: number | null
  behind: number | null
  compare: CompareState
  date: number
  subject: string
  author: string
}

export type BranchOverview = {
  base: BranchBase | null
  baseProblem: string | null
  remotes: string[]
  branches: BranchRow[]
  detached: boolean
  head: string | null
  /** When the remote-tracking refs were last updated by a fetch (FETCH_HEAD), so remote data is not mistaken for live. */
  lastFetch?: number | null
}

export type ChangedFile = { status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | 'X'; path: string; from?: string }

export type BranchDetail = {
  ref: string
  name: string
  baseRef: string
  baseName: string
  mergeBase: string | null
  unique: Commit[]
  missing: Commit[]
  latest: Commit | null
  files: ChangedFile[]
  filesTotal: number
  stat: string
}

export type DiscoveryStatus = {
  running: boolean
  scope: 'common' | 'deep' | null
  locationsScanned: number
  locationsTotal: number
  found: number
  added: number
  startedAt: string | null
  finishedAt: string | null
  errors: string[]
}
