// Terminal sessions: real pseudo-terminals owned by the main process.
//
// Lifecycle (explicit, nothing implicit):
//  - A session is created by create(), lives in this manager until close() or killAll(), and is independent of any window or
//    view. Navigating away in the renderer does NOT end it: the renderer detaches, the shell keeps running, output keeps
//    filling a bounded replay buffer, and when a terminal view mounts again it calls get()/scrollback() and redraws from that
//    buffer, then follows the 'data' event. Closing the whole app ends all sessions (killAll).
//  - When the shell exits the session stays listed with state 'exited' and its exit code, so the output remains readable,
//    until the user closes it.
//  - close() on a running shell that has child processes (a build, a dev server) does nothing and answers
//    { closed: false, needsConfirm: true, reason } unless force is set. Detection is best effort and platform specific.
//  - Terminal data is never logged: this module has no logging at all.
import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import {
  MAX_TERMINAL_SESSIONS, SCROLLBACK_REPLAY_BYTES, TERMINAL_DEFAULT_COLS, TERMINAL_DEFAULT_ROWS, TERMINAL_MAX_COLS, TERMINAL_MAX_ROWS, TERMINAL_MAX_WRITE_CHARS,
  TERMINAL_MIN_COLS, TERMINAL_MIN_ROWS,
} from '../shared/terminal.js'
import type { ShellOption, TerminalCloseResult, TerminalEvents, TerminalInfo } from '../shared/terminal.js'

/* ------------------------------------------------------------ pty abstraction */

export interface PtyProcess {
  readonly pid: number
  onData(cb: (data: string) => void): void
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
}

export type PtySpawnOptions = { cwd?: string; env: Record<string, string>; cols: number; rows: number; name: string }

export interface PtyFactory {
  spawn(file: string, args: string[], opts: PtySpawnOptions): PtyProcess
}

export class TerminalError extends Error {
  constructor(readonly code: 'LIMIT' | 'INVALID' | 'NOT_FOUND' | 'SPAWN_FAILED', message: string) { super(message) }
}

/** The part of a ShellPlan the manager needs. */
export type TerminalSpawnSpec = { file: string; args: string[]; cwd?: string; env: Record<string, string>; display: string; shell: ShellOption }

/** true/false when known, null when this platform or shell cannot tell. */
export type HasChildren = (pid: number, shell: ShellOption) => Promise<boolean | null>

export type TerminalManagerOptions = {
  factory: PtyFactory
  hasChildren?: HasChildren
  /** Kills a session's process and its descendants. Default: pty.kill(), plus taskkill /T /F on Windows. */
  killTree?: (pid: number, pty: PtyProcess) => Promise<void> | void
  maxSessions?: number
  scrollbackBytes?: number
  /** When children cannot be detected (null), ask for confirmation anyway. Default false. */
  confirmWhenUnknown?: boolean
  now?: () => Date
}

/* ------------------------------------------------------------ scrollback */

/** A bounded text buffer measured in UTF-8 bytes. Oldest output is dropped first, whole chunks where possible. */
export class Scrollback {
  private chunks: string[] = []
  private bytes = 0
  private dropped = false
  constructor(private readonly max: number) {}
  push(data: string) {
    if (!data) return
    this.chunks.push(data)
    this.bytes += Buffer.byteLength(data)
    while (this.bytes > this.max && this.chunks.length > 1) { this.bytes -= Buffer.byteLength(this.chunks.shift() as string); this.dropped = true }
    if (this.bytes > this.max) {
      // One chunk bigger than the whole buffer: keep its tail, never starting inside a surrogate pair.
      let s = this.chunks[0]
      while (Buffer.byteLength(s) > this.max) s = s.slice(Math.max(1, Math.ceil((Buffer.byteLength(s) - this.max) / 4)))
      if (/^[\uDC00-\uDFFF]/.test(s)) s = s.slice(1)
      this.chunks = [s]; this.bytes = Buffer.byteLength(s); this.dropped = true
    }
  }
  get size() { return this.bytes }
  read(): { data: string; truncated: boolean } { return { data: this.chunks.join(''), truncated: this.dropped } }
}

/* ------------------------------------------------------------ manager */

type Session = { info: TerminalInfo; pty: PtyProcess; scroll: Scrollback }

export class TerminalManager extends EventEmitter {
  private readonly sessions = new Map<string, Session>()
  private readonly factory: PtyFactory
  private readonly hasChildrenFn: HasChildren
  private readonly killTreeFn: NonNullable<TerminalManagerOptions['killTree']>
  private readonly maxSessions: number
  private readonly scrollbackBytes: number
  private readonly confirmWhenUnknown: boolean
  private readonly now: () => Date

  constructor(opts: TerminalManagerOptions) {
    super()
    this.factory = opts.factory
    this.hasChildrenFn = opts.hasChildren ?? ((pid, shell) => detectChildren(pid, shell))
    this.killTreeFn = opts.killTree ?? defaultKillTree
    this.maxSessions = opts.maxSessions ?? MAX_TERMINAL_SESSIONS
    this.scrollbackBytes = opts.scrollbackBytes ?? SCROLLBACK_REPLAY_BYTES
    this.confirmWhenUnknown = opts.confirmWhenUnknown ?? false
    this.now = opts.now ?? (() => new Date())
  }

  on<K extends keyof TerminalEvents>(event: K, listener: (payload: TerminalEvents[K]) => void): this { return super.on(event, listener) }
  off<K extends keyof TerminalEvents>(event: K, listener: (payload: TerminalEvents[K]) => void): this { return super.off(event, listener) }
  private fire<K extends keyof TerminalEvents>(event: K, payload: TerminalEvents[K]) { this.emit(event, payload) }

  create(spec: TerminalSpawnSpec, title: string, size: { cols?: number; rows?: number } = {}): TerminalInfo {
    if (this.sessions.size >= this.maxSessions) throw new TerminalError('LIMIT', `At most ${this.maxSessions} terminals can be open. Close one first.`)
    const cols = checkInt(size.cols ?? TERMINAL_DEFAULT_COLS, 'Columns', TERMINAL_MIN_COLS, TERMINAL_MAX_COLS)
    const rows = checkInt(size.rows ?? TERMINAL_DEFAULT_ROWS, 'Rows', TERMINAL_MIN_ROWS, TERMINAL_MAX_ROWS)
    let pty: PtyProcess
    try {
      pty = this.factory.spawn(spec.file, spec.args, { cwd: spec.cwd, env: spec.env, cols, rows, name: 'xterm-256color' })
    } catch (e) {
      throw new TerminalError('SPAWN_FAILED', `The shell could not be started: ${(e as Error).message}`)
    }
    const id = `t-${randomBytes(6).toString('hex')}`
    const info: TerminalInfo = {
      id, title: title.slice(0, 120) || spec.shell.label, shell: spec.shell, cwd: spec.display, cols, rows,
      state: 'running', exitCode: null, startedAt: this.now().toISOString(),
    }
    const session: Session = { info, pty, scroll: new Scrollback(this.scrollbackBytes) }
    this.sessions.set(id, session)
    pty.onData(data => {
      if (this.sessions.get(id) !== session || session.info.state !== 'running') return
      session.scroll.push(data)
      this.fire('data', { id, data })
    })
    pty.onExit(e => {
      if (this.sessions.get(id) !== session || session.info.state === 'exited') return
      session.info = { ...session.info, state: 'exited', exitCode: Number.isFinite(e.exitCode) ? e.exitCode : null, hasChildren: false }
      this.fire('exit', { id, exitCode: session.info.exitCode, signal: e.signal ?? null })
      this.fire('updated', { info: { ...session.info } })
    })
    const copy = { ...info }
    this.fire('created', { info: copy })
    return copy
  }

  private need(id: string): Session {
    const s = typeof id === 'string' ? this.sessions.get(id) : undefined
    if (!s) throw new TerminalError('NOT_FOUND', 'This terminal is no longer open.')
    return s
  }

  list(): TerminalInfo[] { return [...this.sessions.values()].map(s => ({ ...s.info })) }
  get(id: string): TerminalInfo | null { const s = this.sessions.get(id); return s ? { ...s.info } : null }
  /** The replay buffer for re-attaching a view. `data` is raw terminal output (escape sequences included). */
  scrollback(id: string): { data: string; truncated: boolean } { return this.need(id).scroll.read() }

  /** Sends keystrokes or a paste. Returns false when the shell already exited (the input is dropped). */
  write(id: string, data: string): boolean {
    const s = this.need(id)
    if (typeof data !== 'string') throw new TerminalError('INVALID', 'Input must be text.')
    if (data.length > TERMINAL_MAX_WRITE_CHARS) throw new TerminalError('INVALID', `Input is too large (more than ${TERMINAL_MAX_WRITE_CHARS} characters).`)
    if (s.info.state !== 'running') return false
    s.pty.write(data)
    return true
  }

  resize(id: string, cols: number, rows: number): void {
    const s = this.need(id)
    const c = checkInt(cols, 'Columns', TERMINAL_MIN_COLS, TERMINAL_MAX_COLS)
    const r = checkInt(rows, 'Rows', TERMINAL_MIN_ROWS, TERMINAL_MAX_ROWS)
    if (s.info.state !== 'running') return
    if (s.info.cols === c && s.info.rows === r) return
    try { s.pty.resize(c, r) } catch { return } // the process may have just exited
    s.info = { ...s.info, cols: c, rows: r }
  }

  rename(id: string, title: string): TerminalInfo {
    const s = this.need(id)
    s.info = { ...s.info, title: String(title).trim().slice(0, 120) || s.info.shell.label }
    this.fire('updated', { info: { ...s.info } })
    return { ...s.info }
  }

  /** Looks for child processes of a running shell and records the answer in the session's info. */
  async inspect(id: string): Promise<TerminalInfo> {
    const s = this.need(id)
    if (s.info.state === 'running') {
      const r = await this.safeChildren(s)
      if (this.sessions.get(id) === s && r !== null) s.info = { ...s.info, hasChildren: r }
    }
    return { ...s.info }
  }

  private async safeChildren(s: Session): Promise<boolean | null> {
    try { return await this.hasChildrenFn(s.pty.pid, s.info.shell) } catch { return null }
  }

  /**
   * Ends a session and removes it. A running shell with child processes is not closed unless `force` is set; the caller shows
   * `reason` to the user and calls again with force. An exited session is simply removed.
   */
  async close(id: string, opts: { force?: boolean } = {}): Promise<TerminalCloseResult> {
    const s = this.need(id)
    if (s.info.state === 'running' && !opts.force) {
      const children = await this.safeChildren(s)
      if (this.sessions.get(id) !== s) return { closed: true } // it ended while we looked
      if (children === true) return { closed: false, needsConfirm: true, reason: 'Something is still running in this terminal. Closing it will stop that work.' }
      if (children === null && this.confirmWhenUnknown) return { closed: false, needsConfirm: true, reason: 'GitManager cannot tell whether something is still running in this terminal. Closing it will stop the shell and anything it started.' }
    }
    this.sessions.delete(id)
    if (s.info.state === 'running') await this.terminate(s)
    this.fire('closed', { id })
    return { closed: true }
  }

  private async terminate(s: Session) {
    try { await this.killTreeFn(s.pty.pid, s.pty) } catch { /* already gone */ }
  }

  /** App quit: ends every shell. Does not emit events (the windows are going away). */
  async killAll(): Promise<void> {
    const all = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(all.filter(s => s.info.state === 'running').map(s => this.terminate(s)))
  }
}

function checkInt(v: unknown, name: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new TerminalError('INVALID', `${name} must be a whole number from ${min} to ${max}.`)
  return v
}

/* ------------------------------------------------------------ process inspection (platform specific, best effort) */

const exec = (file: string, args: string[], timeoutMs = 5000): Promise<{ code: number | null; stdout: string }> =>
  new Promise(resolve => {
    try {
      execFile(file, args, { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
        const code = err ? (typeof (err as NodeJS.ErrnoException).code === 'number' ? ((err as NodeJS.ErrnoException).code as unknown as number) : null) : 0
        resolve({ code, stdout: String(stdout ?? '') })
      })
    } catch { resolve({ code: null, stdout: '' }) }
  })

/** Pids whose parent is `pid`, read from /proc (Linux). Null when /proc is not usable. */
export async function linuxChildren(pid: number, procRoot = '/proc'): Promise<number[] | null> {
  let names: string[]
  try { names = await readdir(procRoot) } catch { return null }
  const found: number[] = []
  await Promise.all(names.filter(n => /^\d+$/.test(n)).map(async n => {
    try {
      const stat = await readFile(`${procRoot}/${n}/stat`, 'utf8')
      // "pid (comm) S ppid ...": comm may contain spaces and parentheses, so parse after the LAST ')'.
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      if (Number(rest[1]) === pid) found.push(Number(n))
    } catch { /* process vanished */ }
  }))
  return found
}

/** Windows host processes that exist only to serve the pseudo console; they are not user work. */
export const WINDOWS_HELPER_PROCESSES = ['conhost.exe', 'OpenConsole.exe']

/** PowerShell arguments that count the non-helper children of `pid`. The pid is an integer we validated, never user text. */
export function windowsChildCountCommand(pid: number): { file: string; args: string[] } {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('invalid pid')
  const skip = WINDOWS_HELPER_PROCESSES.map(n => `'${n}'`).join(',')
  const script = `@(Get-CimInstance -ClassName Win32_Process -Filter 'ParentProcessId=${pid}' | Where-Object { @(${skip}) -notcontains $_.Name }).Count`
  return { file: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script] }
}

export async function detectChildren(pid: number, shell: ShellOption, platform: NodeJS.Platform = process.platform): Promise<boolean | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  if (platform === 'win32') {
    // Processes inside a WSL distribution are invisible from Windows: wsl.exe's children are WSL plumbing. Unknown, not "none".
    if (shell.kind === 'wsl') return null
    const c = windowsChildCountCommand(pid)
    const r = await exec(c.file, c.args, 10_000)
    const n = parseInt(r.stdout.trim(), 10)
    return Number.isFinite(n) ? n > 0 : null
  }
  if (platform === 'linux') {
    const kids = await linuxChildren(pid)
    if (kids) return kids.length > 0
  }
  // macOS (and Linux without /proc): pgrep exits 0 when it found children, 1 when none.
  const r = await exec('pgrep', ['-P', String(pid)])
  if (r.code === 0) return true
  if (r.code === 1) return false
  return null
}

/** pty.kill() ends the shell; on Windows its descendants would survive, so the tree is ended with taskkill (arguments array). */
export async function defaultKillTree(pid: number, pty: PtyProcess): Promise<void> {
  if (process.platform === 'win32' && Number.isSafeInteger(pid) && pid > 0) {
    await exec('taskkill', ['/PID', String(pid), '/T', '/F'], 10_000)
  }
  try { pty.kill() } catch { /* already gone */ }
}
