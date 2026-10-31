// Types of the Runners tool (GitHub Actions self-hosted runners), shared by the main process, the preload bridge and the
// renderer. No runtime code. GitHub-provided facts and local observations are kept in separate records (GitHubRunner,
// LocalRunner) and combined into a Runner row only by reconciliation; nothing in a Runner is invented from the other side.

export type RunnerOs = 'windows' | 'linux' | 'macos' | 'unknown'
export type RunnerArch = 'x64' | 'arm64' | 'arm' | 'unknown'

/**
 * The GitHub side a runner is registered with: one repository, or an organization. A repository scope carries GitHub's
 * immutable repository id once it is known (`repoId`), so every historical name of a renamed repository is one scope.
 */
export type RunnerScope = { kind: 'repo'; owner: string; repo: string; repoId?: number } | { kind: 'org'; org: string }

/** Where an installation lives, as seen from this copy of GitManager. */
export type RunnerHost =
  | { kind: 'native' } // this computer
  | { kind: 'wsl'; distro: string } // a WSL 2 distribution on this Windows computer
  | { kind: 'ssh'; host: string } // a remote machine reached through an alias in the user's SSH configuration

export type RunnerLabel = { name: string; type: 'read-only' | 'custom' }

/** What GitHub says about a registered runner. Nothing here comes from the local file system. */
export type GitHubRunner = {
  id: number
  name: string
  /** As GitHub reports it (Linux, Windows, macOS, or another string). */
  os: string
  status: 'online' | 'offline' | 'unknown'
  busy: boolean
  labels: RunnerLabel[]
  scope: RunnerScope
  runnerGroupId: number | null
  runnerGroupName: string | null
  ephemeral: boolean | null
  fetchedAt: string
}

export type ServiceKind = 'systemd' | 'launchd' | 'windows-service' | 'none' | 'unknown'
export type ServiceRunState = 'running' | 'stopped' | 'unknown' | 'not-installed'
export type ServiceStartup = 'automatic' | 'manual' | 'disabled' | 'unknown' | 'not-applicable'

export type LocalService = {
  kind: ServiceKind
  /** Unit name (systemd), launchd label, or Windows service name. */
  name: string | null
  state: ServiceRunState
  startup: ServiceStartup
  /** Raw state text from the platform, for the details view. */
  detail: string | null
}

/** An installation observed on a file system GitManager can reach. Credential files are never read. */
export type LocalRunner = {
  /** Stable identity of the installation: host and normalized path (see runnerKey in core/runners/model.ts). */
  key: string
  host: RunnerHost
  /** In the host's own path syntax (C:\actions-runner, /home/me/actions-runner). */
  path: string
  os: RunnerOs
  arch: RunnerArch
  /** Host name of the machine the installation runs on, when it could be read. */
  machine: string | null
  /** From .runner: GitHub's id for this registration. */
  agentId: number | null
  agentName: string | null
  scope: RunnerScope | null
  gitHubUrl: string | null
  poolName: string | null
  ephemeral: boolean | null
  disableUpdate: boolean | null
  workFolder: string | null
  version: string | null
  versionSource: 'listener' | 'diag' | null
  service: LocalService
  /** A Runner.Listener process whose executable path is inside this installation (positive identification by path). */
  process: { running: boolean | null; pids: number[]; detail: string | null }
  /** .runner is present and readable: the installation is registered (or was). */
  configured: boolean
  /** .credentials exists (its content is never read). */
  hasCredentials: boolean
  /** Files present without a registration: a download that was never configured, or an interrupted setup. */
  partial: boolean
  warnings: string[]
  inspectedAt: string
  source: 'scan' | 'installed'
}

export type RunnerStatus = 'online' | 'offline' | 'busy' | 'unknown'
export type Environment = 'native' | 'wsl' | 'remote' | 'unknown'

export type Capability = { allowed: boolean; reason: string | null }
export type RunnerCapabilities = {
  start: Capability
  stop: Capability
  restart: Capability
  inspect: Capability
  openFolder: Capability
  logs: Capability
  checkUpdate: Capability
  update: Capability
  unregister: Capability
  uninstall: Capability
  /** Hide an orphaned installation from the active inventory (reversible, touches no files). */
  retire: Capability
}

/** One row of the inventory: a GitHub record, a local installation, or both when reconciliation matched them. */
export type Runner = {
  key: string
  name: string
  status: RunnerStatus
  platform: RunnerOs
  environment: Environment
  machine: string | null
  distro: string | null
  scope: RunnerScope | null
  path: string | null
  version: string | null
  github: GitHubRunner | null
  local: LocalRunner | null
  source: 'local' | 'github' | 'both'
  /** Genuine problems: a missing registration or credentials, a running service GitHub cannot see, a minor or major update missed. Only these count as "Needs attention". */
  attention: string[]
  /** Ordinary information shown in the details view: WSL does not start with Windows, a patch update the runner applies itself, no service installed. */
  notices: string[]
  capabilities: RunnerCapabilities
  /** At least one lifecycle action is possible from this GitManager. */
  manageable: boolean
}

export type ScopeStatus = 'ok' | 'forbidden' | 'not-found' | 'rate-limited' | 'error' | 'skipped'
export type ScopeResult = { scope: RunnerScope; status: ScopeStatus; message: string | null; count: number; truncated: boolean; fetchedAt: string | null }

export type HostStatus = 'ok' | 'inaccessible' | 'skipped' | 'error' | 'cancelled'
export type HostResult = { host: RunnerHost; label: string; status: HostStatus; message: string | null; found: number; roots: string[]; durationMs: number }

export type RunnerSummary = { total: number; online: number; offline: number; busy: number; manageable: number; monitoringOnly: number; attention: number; /** Retired installations, not counted in any other figure. */ retired: number }

export type ScanPhase = 'idle' | 'local' | 'github' | 'reconcile'
export type RunnersScan = { running: boolean; phase: ScanPhase; current: string | null; startedAt: string | null; cancelled: boolean; localOnly: boolean }

export type LatestRelease = { version: string; checkedAt: string; url: string }

/** A local installation the user retired from the active inventory. Remembered across rescans and restarts. */
export type RetiredInstallation = { key: string; host: RunnerHost; path: string; name: string | null; agentId: number | null; scope: RunnerScope | null; retiredAt: string }

/** Whether the files of a retired installation may be removed now, with every reason when not. */
export type CleanupCheck = { allowed: boolean; reasons: string[] }

/** A retired installation as shown in the inventory: the row as last observed, when it was retired, and whether its files can be removed. */
export type RetiredRunner = { runner: Runner; retiredAt: string; cleanup: CleanupCheck }

export type RunnersInventory = {
  runners: Runner[]
  /** Installations retired by the user and still orphaned. Excluded from `runners` and from every figure in `summary` except `summary.retired`. */
  retired: RetiredRunner[]
  summary: RunnerSummary
  hosts: HostResult[]
  scopes: ScopeResult[]
  scannedAt: string | null
  localScannedAt: string | null
  githubScannedAt: string | null
  /** What could not be established, so an incomplete inventory is never mistaken for a complete one. */
  limitations: string[]
  latest: LatestRelease | null
}

export type RunnerRoot = { id: string; host: RunnerHost; path: string }

export type RunnersSettings = {
  /** Scan the local machine (and WSL distributions) for installations at every launch. */
  autoDiscover: boolean
  /** Also read GitHub at launch (uses API requests; off keeps startup to local files only). */
  githubAtStartup: boolean
  /** Extra folders to inspect, for unusual installation paths. */
  roots: RunnerRoot[]
  /** Organizations whose runners to list (needs organization admin). */
  orgs: string[]
  /** Repositories (owner/name) to list runners for, beyond those registered in GitManager and found in local installations. */
  repos: string[]
  /** SSH config host aliases the user allowed GitManager to inspect over SSH. */
  sshHosts: string[]
  /** Minutes between automatic GitHub status refreshes while the Runners tool is open (0 turns it off). */
  refreshMinutes: number
}

/** Non-sensitive memory of installations GitManager created or saw, so they reappear before the next scan. */
export type KnownInstallation = { key: string; host: RunnerHost; path: string; name: string | null; scope: RunnerScope | null; agentId: number | null; at: string }

export type RunnersConfig = { settings: RunnersSettings; known: KnownInstallation[]; retired: RetiredInstallation[] }

/* ------------------------------------------------------------ installation */

export type WindowsServiceAccount = 'network-service' | 'local-service' | 'local-system' | 'custom'

export type InstallRequest = {
  host: RunnerHost
  scope: RunnerScope
  name: string
  /** Absolute directory in the host's own path syntax. Each runner needs its own directory. */
  directory: string
  labels: string[]
  runnerGroup: string | null
  /** Install the runner as a service (systemd, launchd or a Windows service). */
  installService: boolean
  /** Linux systemd: the user the service runs as (empty: the user that performs the installation). */
  serviceUser: string | null
  /** Windows: the account the service runs as. */
  windowsAccount: WindowsServiceAccount | null
  windowsAccountName: string | null
  startAfter: boolean
  replace: boolean
  ephemeral: boolean
  disableUpdate: boolean
  workFolder: string
}

export type PackageInfo = {
  version: string
  os: RunnerOs
  arch: RunnerArch
  filename: string
  downloadUrl: string
  sha256: string | null
  checksumSource: 'downloads-api' | 'release-notes' | 'none'
}

export type CommandPreview = { title: string; where: string; command: string; elevated: boolean }

export type InstallPlan = {
  id: string
  request: InstallRequest
  target: { os: RunnerOs; arch: RunnerArch; machine: string | null; user: string | null; systemd: boolean | null }
  pkg: PackageInfo | null
  /** Exactly what will run, in order, with tokens shown as a placeholder. */
  commands: CommandPreview[]
  /** Fatal problems: the plan cannot run until these are resolved. */
  blockers: string[]
  warnings: string[]
  elevation: { needed: boolean; how: string | null }
  serviceName: string | null
  /** The GitHub access that was checked while planning. */
  access: { checked: boolean; canRegister: boolean | null; message: string | null }
  createdAt: string
}

export type InstallStepId = 'environment' | 'github' | 'download' | 'verify' | 'extract' | 'configure' | 'register' | 'service' | 'start' | 'verify-registration' | 'verify-service'
export type StepState = 'pending' | 'running' | 'done' | 'failed' | 'skipped'
export type InstallStep = { id: InstallStepId; label: string; state: StepState; message: string | null; startedAt: string | null; finishedAt: string | null }

export type InstallOutcome = { downloaded: boolean; extracted: boolean; registered: boolean; serviceInstalled: boolean; running: boolean; verified: boolean }

export type InstallJob = {
  id: string
  planId: string
  request: InstallRequest
  pkg: PackageInfo | null
  steps: InstallStep[]
  state: 'running' | 'done' | 'failed' | 'cancelled'
  error: { step: InstallStepId; message: string; recovery: string[] } | null
  outcome: InstallOutcome
  /** Redacted output lines (tokens never appear). */
  log: string[]
  startedAt: string
  finishedAt: string | null
  /** Key of the resulting local installation when files were written. */
  runnerKey: string | null
  cancelRequested: boolean
}

/* ------------------------------------------------------------ actions on existing runners */

export type RunnerAction = 'start' | 'stop' | 'restart' | 'inspect' | 'check-update' | 'update' | 'unregister' | 'uninstall'

export type ActionOptions = {
  /** Required for stop, restart, update and unregister while GitHub reports the runner busy. */
  allowBusy?: boolean
  /** Required for unregister, uninstall and update: the user saw what will happen. */
  confirm?: boolean
  /** uninstall: also remove the GitHub registration first (needs a removal token). */
  unregisterFirst?: boolean
}

export type ActionStep = { label: string; state: StepState; message: string | null }

export type ActionResult = {
  action: RunnerAction
  ok: boolean
  message: string
  detail?: string
  steps?: ActionStep[]
  /** Redacted output. */
  log?: string[]
  updateAvailable?: { installed: string | null; latest: string } | null
}

export type DiagnosticLog = { file: string; modifiedAt: string | null; sizeBytes: number; tail: string[] }
export type RunnerDiagnostics = { key: string; logs: DiagnosticLog[]; service: LocalService; process: LocalRunner['process']; error: string | null; collectedAt: string }

/* ------------------------------------------------------------ remote hosts, repositories, workflow integration */

export type SshConfigHost = { alias: string; hostName: string | null; user: string | null; allowed: boolean }

export type HostProbe = {
  host: RunnerHost
  reachable: boolean
  os: RunnerOs
  arch: RunnerArch
  machine: string | null
  user: string | null
  systemd: boolean | null
  /** Non-interactive sudo works (Linux). null when not applicable or unknown. */
  sudo: boolean | null
  message: string | null
}

export type GitHubRepoChoice = { fullName: string; private: boolean; canAdmin: boolean; ownerType: string; source: 'gitmanager' | 'github' | 'local' }
export type GitHubOrgChoice = { login: string; canAdmin: boolean | null; message: string | null }
export type RunnerGroupInfo = { id: number; name: string; default: boolean; visibility: string; allowsPublic: boolean; selectedRepos: string[] | null }

export type WorkflowJobLabels = { job: string; runsOn: string[]; dynamic: boolean; group: string | null; matched: string[]; problem: string | null }
export type WorkflowLabelFile = { path: string; name: string | null; jobs: WorkflowJobLabels[]; error: string | null }
export type WorkflowLabelReport = {
  repo: string
  source: 'local' | 'github'
  files: WorkflowLabelFile[]
  /** Labels requested by workflows that no runner known for this repository offers. */
  unmatched: string[]
  /** Runners (keys) whose labels no workflow in this repository asks for. */
  idleRunners: string[]
  errors: string[]
  note: string
}

export type RunsOnExample = { yaml: string; defaultLabels: string[]; customLabels: string[]; group: string | null; note: string }

export type RunnersOpenTarget =
  | { kind: 'runner-settings'; scope: RunnerScope; runnerId: number | null }
  | { kind: 'scope'; scope: RunnerScope }
  | { kind: 'workflows'; scope: Extract<RunnerScope, { kind: 'repo' }> }
  | { kind: 'docs'; page: 'add-runner' | 'configure' | 'security' | 'api' }
  | { kind: 'folder'; key: string }
  | { kind: 'release'; version: string | null }

export type RunnersState = {
  inventory: RunnersInventory
  config: RunnersConfig
  scan: RunnersScan
  job: InstallJob | null
  recentJobs: InstallJob[]
  /** Installations with an operation in progress (key -> action). */
  busy: Record<string, RunnerAction>
  auth: import('./storage.js').AuthState | null
  /** Hosts this GitManager can operate on: this machine, its WSL distributions, allowed SSH hosts. */
  hosts: { host: RunnerHost; label: string; os: RunnerOs; available: boolean; note: string | null }[]
  security: string
}
