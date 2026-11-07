// Types shared by the main process, the preload bridge and the renderer for the embedded terminal. Type-only plus constants.
import type { Location } from './types.js'

/** Which family of shell a session runs. 'wsl' is a login shell inside a WSL distribution, 'posix' the user's login shell on Linux or macOS. */
export type ShellKind = 'powershell' | 'pwsh' | 'wsl' | 'posix'

/** A shell the user can pick. `id` is stable and is what a per-repository preference stores: 'powershell', 'pwsh', 'posix' or 'wsl:<distro>'. */
export type ShellOption = {
  id: string
  kind: ShellKind
  label: string
  /** WSL distribution, exactly as wsl.exe lists it (kind 'wsl' only). */
  distro?: string
  available: boolean
  /** Why it is unavailable, or a short fact (the executable that was found, the distribution state). */
  detail?: string
  /** Full path of the executable when detection found one (never user-editable). */
  executable?: string
}

/** What a terminal opens in. Resolved to a Location, and then to a shell plan, in the main process only. */
export type TerminalTarget =
  | { type: 'repo'; repoId: string; subpath?: string }
  | { type: 'runner'; key: string }
  | { type: 'path'; location: Location }

export type TerminalOpenRequest = {
  target: TerminalTarget
  /** ShellOption.id. Omitted: the repository's saved shell, else the default for the location. */
  shellId?: string
  cols?: number
  rows?: number
}

export type TerminalState = 'running' | 'exited'

export type TerminalInfo = {
  id: string
  title: string
  shell: ShellOption
  /** Where it started, for display (a Windows path, or `distro:/linux/path`). */
  cwd: string
  cols: number
  rows: number
  state: TerminalState
  /** Null while running (and when the platform gave none). */
  exitCode: number | null
  startedAt: string
  /** What the tab was opened for, so New tab and Reopen start in the same place. Set by the application, not by the PTY layer. */
  target?: TerminalTarget
  /** Filled by TerminalManager.inspect(): true/false when known, undefined when never checked or not detectable. */
  hasChildren?: boolean
}

export type TerminalNote = { code: 'ACCOUNT_DIFFERS' | 'ACCOUNT_UNKNOWN' | 'INFO'; message: string }

/** Result of closing: either closed, or the shell has running work and the user must confirm (then close again with force). */
export type TerminalCloseResult = { closed: true } | { closed: false; needsConfirm: true; reason: string }

export type TerminalEvents = {
  data: { id: string; data: string }
  exit: { id: string; exitCode: number | null; signal: number | null }
  created: { info: TerminalInfo }
  updated: { info: TerminalInfo }
  closed: { id: string }
}

export const MAX_TERMINAL_SESSIONS = 12
/** Output kept per session so a renderer that was away (another view) can redraw the screen when it comes back. */
export const SCROLLBACK_REPLAY_BYTES = 256 * 1024
export const TERMINAL_MIN_COLS = 2
export const TERMINAL_MAX_COLS = 500
export const TERMINAL_MIN_ROWS = 1
export const TERMINAL_MAX_ROWS = 200
export const TERMINAL_DEFAULT_COLS = 80
export const TERMINAL_DEFAULT_ROWS = 24
/** One write (a paste) larger than this is refused. */
export const TERMINAL_MAX_WRITE_CHARS = 256 * 1024
