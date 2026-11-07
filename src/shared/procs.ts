// Types for live process and port discovery and the read-only environment inspector. No runtime code.
// Windows PIDs and Linux PIDs live in different namespaces, so every process is identified by context + pid (ProcInfo.key).

/** The operating-system family an environment snapshot comes from. */
export type ProcessEnvKind = 'windows' | 'unix' | { kind: 'wsl'; distro: string }

/** Where a process runs: this computer's own OS, or inside a WSL distribution. */
export type ProcContext = { kind: 'native' } | { kind: 'wsl'; distro: string }

export type PortBinding = {
  port: number
  protocol: 'tcp' | 'tcp6' | 'udp' | 'udp6'
  /** Local address as the OS reports it ("0.0.0.0", "127.0.0.1", "::", "::1", "*"). */
  address: string
  /** Listening TCP sockets, or bound UDP sockets. */
  state: 'LISTEN'
}

export type ProcOwner = 'gitmanager' | 'external'

export type ProcInfo = {
  /** Unique across contexts: "<context>:<pid>". */
  key: string
  context: ProcContext
  pid: number
  ppid?: number
  name: string
  /** Full command line; null when the OS denies it. */
  command: string | null
  exe?: string
  cwd?: string
  user?: string
  /** ISO timestamp of the process start (identity check against PID reuse). */
  startedAt?: string
  /** OS state letter or word (R, S, Z, ...). */
  state?: string
  ports: PortBinding[]
  owner: ProcOwner
  serviceKey?: string
  repoId?: string
  /** How the repository was associated. Never by port number. */
  repoMatch?: 'cwd' | 'command' | 'service'
  canStop: boolean
  stopDeniedReason?: string
}

export type EnvEntry = { name: string; value: string; sensitive: boolean }

export type EnvSnapshot = {
  /** runtime-live: read from the running process. runtime-launch: what GitManager passed when it started the service. */
  source: 'runtime-live' | 'runtime-launch' | 'unavailable'
  context: ProcContext
  pid: number
  capturedAt: string
  entries: EnvEntry[]
  /** Why nothing could be read. */
  reason?: string
  note: string
}

export type ConfigEntry = { name: string; value: string; sensitive: boolean; line: number; /** A later entry in the same file replaces this one. */ overridden?: boolean }

export type ConfigFileEnv = {
  kind: 'config-file'
  path: string
  format: 'dotenv' | 'properties' | 'yaml'
  entries: ConfigEntry[]
  parseErrors: { line: number; message: string }[]
  /** Always states that these files are not what a running process resolved. */
  note: string
}

export type ProcError = { context: ProcContext; message: string }

export type ProcsSnapshot = {
  processes: ProcInfo[]
  scannedAt: string
  errors: ProcError[]
}

export type PortConflict = {
  port: number
  protocol: PortBinding['protocol']
  address: string
  process: ProcInfo
  /** True when GitManager started the occupying process. */
  managed: boolean
  serviceKey?: string
}

export type StopCode = 'CONFIRM_REQUIRED' | 'PERMISSION' | 'DENIED' | 'CHANGED' | 'STILL_RUNNING' | 'FAILED' | 'UNSUPPORTED'

export type StopResult =
  | { ok: true; message: string; alreadyGone?: boolean }
  | { ok: false; code: StopCode; message: string }
