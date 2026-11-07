// Types for the runner dependency inspector. Everything here describes what was verified INSIDE the runner's own
// operating environment (Windows, or one specific WSL distribution), never what another environment happens to have.
import type { RunnerHost, RunnerOs } from './runners.js'

export type BuiltinDependencyId =
  | 'git' | 'python3' | 'python' | 'py' | 'pip' | 'node' | 'npm' | 'java' | 'mvn' | 'gradle' | 'dotnet' | 'docker' | 'tesseract'
  | 'make' | 'gcc' | 'curl' | 'unzip'
/** A built-in tool, or a user-added one ("extra:<id>"). */
export type DependencyId = BuiltinDependencyId | `extra:${string}`

/**
 * found: executable in the checked environment (and, when the runner's recorded PATH is known, on that PATH).
 * missing: the lookup ran and the tool is not there. error: it is there but the version command failed or timed out, or
 * the probe itself failed. unknown: the probe did not report on this tool (nothing is guessed).
 */
export type DependencyStatus = 'found' | 'missing' | 'error' | 'unknown'

/** Where the answer comes from. */
export type DependencyVerifiedIn = { host: RunnerHost; os: RunnerOs; /** 'WSL Ubuntu-24.04', 'Windows', 'Linux', 'macOS', 'SSH build-box' */ label: string }

export type DependencyResult = {
  id: DependencyId
  label: string
  status: DependencyStatus
  version: string | null
  /** Absolute path of the executable that was run; null unless status is found or error with a known executable. */
  path: string | null
  verifiedIn: DependencyVerifiedIn
  checkedAt: string
  /** Short: the first line of a failure, a language count, 'Not on the runner PATH', ... */
  detail?: string
  /** path-lookup: the login PATH of the host. service-path: the PATH the runner recorded in its .path / .env file. */
  via: 'path-lookup' | 'service-path'
  /** Where the executable is on the interactive login PATH, when that differs from the runner PATH answer. */
  loginPath?: string | null
  /** Optional 'other tool' rather than one of the main toolchains. */
  optional: boolean
  /** Only an id of a suggested manual next step; the UI decides how to offer it. Never a command to run. */
  installHint?: 'open-terminal'
}

export type DependencyReport = {
  key: string
  host: RunnerHost
  hostLabel: string
  /** The account the probe ran as (the runner service may run as another one). */
  user: string | null
  results: DependencyResult[]
  runnerEnvNote?: string
  collectedAt: string
}

export type ExtraDependency = { id: string; label: string; command: string; args?: string[] }
