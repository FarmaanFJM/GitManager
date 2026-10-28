import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { readdirSync, readFileSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import type { LogBatch, LogLine, ServiceStatus } from '../shared/types.js'
import { decodeOutput, hostOs, programSpec, run, type ExecSpec, type HostOs } from './exec.js'
import type { Launch } from './profiles.js'
import { describeReadiness, probe } from './readiness.js'

// eslint-disable-next-line no-control-regex
const MARK = /^\x1eGM_PGID (\d+)$/

/**
 * How a service command is started.
 * - Windows: cmd.exe /d /s /c "<command>", so npm.cmd, mvnw.cmd and friends resolve as in a terminal.
 * - macOS and Linux: the user's login shell, in its own process group so the whole tree can be signalled.
 * - WSL: wsl.exe runs `setsid -w bash -lc` inside the distribution. setsid makes bash the leader of a new process group,
 *   whose id bash prints first (marker line), so Stop can signal exactly that group inside Linux. Without it, killing
 *   wsl.exe on Windows can leave Linux children (a JVM, a dev server) running and holding their port.
 */
export function serviceSpec(l: Launch, os: HostOs = hostOs()): ExecSpec & { detached: boolean; marker: boolean } {
  if (l.runtime.kind === 'wsl') {
    const env = Object.entries(l.env).map(([k, v]) => `${k}=${v}`)
    const script = `printf '\\036GM_PGID %s\\n' "$$"; ${l.command}`
    return { file: 'wsl.exe', args: ['-d', l.runtime.distro, '--cd', l.dir, '--exec', 'env', ...env, 'setsid', '-w', 'bash', '-lc', script], detached: false, marker: true }
  }
  const env = { ...process.env, ...l.env }
  if (os === 'windows') {
    return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${l.command}"`], cwd: l.dir, env, windowsVerbatimArguments: true, detached: false, marker: false }
  }
  const shell = process.env.SHELL && /\/(bash|zsh)$/.test(process.env.SHELL) ? process.env.SHELL : '/bin/sh'
  return { file: shell, args: shell === '/bin/sh' ? ['-c', l.command] : ['-lc', l.command], cwd: l.dir, env, detached: true, marker: false }
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g
export const stripAnsi = (s: string) => s.replace(ANSI, '')

/** Splits a stream into display lines: ANSI codes removed, carriage-return progress collapsed to its final state. */
export class LineSplitter {
  private buf = ''
  constructor(private readonly emit: (line: string) => void) {}
  push(text: string) {
    this.buf += text
    let i: number
    while ((i = this.buf.indexOf('\n')) >= 0) {
      this.line(this.buf.slice(0, i))
      this.buf = this.buf.slice(i + 1)
    }
    if (this.buf.length > 64_000) { this.line(this.buf); this.buf = '' }
  }
  flush() { if (this.buf) { this.line(this.buf); this.buf = '' } }
  get pending() { return this.buf.length > 0 }
  private line(raw: string) {
    const parts = raw.replace(/\r$/, '').split('\r')
    const text = stripAnsi(parts[parts.length - 1]).replace(/\s+$/, '')
    this.emit(text.length > 4000 ? text.slice(0, 4000) + ' …' : text)
  }
}

type Entry = {
  launch: Launch
  status: ServiceStatus
  child: ChildProcess | null
  pgid: number | null
  logs: LogLine[]
  seq: number
  pending: LogLine[]
  flushTimer: NodeJS.Timeout | null
  stopRequested: boolean
  exited: Promise<void>
}

/** True while any live (non-zombie) process remains in the group. On Linux /proc tells zombies apart; elsewhere ask the kernel. */
function groupAlive(pgid: number) {
  try { process.kill(-pgid, 0) } catch { return false }
  if (process.platform !== 'linux') return true
  try {
    return readdirSync('/proc').some(d => {
      if (!/^\d+$/.test(d)) return false
      try {
        const stat = readFileSync(`/proc/${d}/stat`, 'utf8')
        const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ') // state, ppid, pgrp, ...
        return Number(f[2]) === pgid && f[0] !== 'Z'
      } catch { return false }
    })
  } catch { return true }
}

export type ManagerOptions = { os?: HostOs; graceMs?: number; logLimit?: number; pollMs?: number }

/**
 * Owns every process GitManager starts. A service is `starting` until its readiness check passes (`ready`); with no
 * check it is `running` (alive, readiness unknown). It is `failed` when it exits with an error before being stopped, or
 * when the check never passes. Stop terminates only the process tree GitManager started, never "whatever uses the port".
 */
export class ServiceManager extends EventEmitter {
  private entries = new Map<string, Entry>()
  private readonly os: HostOs
  private readonly graceMs: number
  private readonly logLimit: number
  private readonly pollMs: number

  constructor(opts: ManagerOptions = {}) {
    super()
    this.os = opts.os ?? hostOs()
    this.graceMs = opts.graceMs ?? 8000
    this.logLimit = opts.logLimit ?? 5000
    this.pollMs = opts.pollMs ?? 500
  }

  list(): ServiceStatus[] { return [...this.entries.values()].map(e => e.status) }
  get(key: string): ServiceStatus | undefined { return this.entries.get(key)?.status }
  logs(key: string): LogLine[] { return this.entries.get(key)?.logs ?? [] }
  isAlive(key: string) { const e = this.entries.get(key); return !!e?.child && e.child.exitCode === null && e.child.signalCode === null }
  /** Services GitManager is running for a repository (anything not stopped and not finished). */
  activeForRepo(repoId: string) { return [...this.entries.values()].filter(e => e.launch.repoId === repoId && this.isAlive(e.launch.key)).map(e => e.status) }

  clearLogs(key: string) { const e = this.entries.get(key); if (e) { e.logs = []; this.emit('logs-cleared', key) } }

  private set(e: Entry, patch: Partial<ServiceStatus>) {
    e.status = { ...e.status, ...patch }
    this.emit('status', e.status)
  }

  private log(e: Entry, stream: LogLine['stream'], text: string) {
    const line: LogLine = { seq: ++e.seq, stream, text, at: Date.now() }
    e.logs.push(line)
    if (e.logs.length > this.logLimit) e.logs.splice(0, e.logs.length - this.logLimit)
    e.pending.push(line)
    if (!e.flushTimer) e.flushTimer = setTimeout(() => this.flush(e), 80)
  }

  private flush(e: Entry) {
    if (e.flushTimer) clearTimeout(e.flushTimer)
    e.flushTimer = null
    if (!e.pending.length) return
    const batch: LogBatch = { key: e.launch.key, lines: e.pending }
    e.pending = []
    this.emit('logs', batch)
  }

  async start(launch: Launch): Promise<ServiceStatus> {
    const prev = this.entries.get(launch.key)
    if (prev && this.isAlive(launch.key)) return prev.status
    const e: Entry = {
      launch, child: null, pgid: null, logs: prev?.logs ?? [], seq: prev?.seq ?? 0, pending: [], flushTimer: null, stopRequested: false,
      exited: Promise.resolve(),
      status: { key: launch.key, profileId: launch.profileId, serviceId: launch.serviceId, repoId: launch.repoId, state: 'starting', pid: null, startedAt: null, exitCode: null, message: null },
    }
    this.entries.set(launch.key, e)
    this.set(e, {})

    // Refuse to start when the readiness target already answers: it belongs to another process, and the check would lie.
    if (launch.readiness.type !== 'none' && await probe(launch.readiness, 1000)) {
      const where = describeReadiness(launch.readiness)
      this.log(e, 'sys', `${where} is already in use by another process. GitManager did not start ${launch.name} and did not touch that process.`)
      this.set(e, { state: 'failed', message: `${where} is already in use by another process.` })
      this.flush(e)
      return e.status
    }

    const spec = serviceSpec(launch, this.os)
    this.log(e, 'sys', `$ ${launch.command}`)
    this.log(e, 'sys', `in ${launch.runtime.kind === 'wsl' ? `${launch.runtime.distro}:` : ''}${launch.dir}`)
    let child: ChildProcess
    try {
      child = spawn(spec.file, spec.args, {
        cwd: spec.cwd, env: spec.env ?? process.env, detached: spec.detached, windowsHide: true,
        windowsVerbatimArguments: spec.windowsVerbatimArguments, stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      this.log(e, 'sys', `Could not start: ${(err as Error).message}`)
      this.set(e, { state: 'failed', message: (err as Error).message })
      this.flush(e)
      return e.status
    }
    e.child = child
    this.set(e, { pid: child.pid ?? null, startedAt: new Date().toISOString() })

    const attach = (stream: NodeJS.ReadableStream, kind: 'out' | 'err') => {
      const dec = new StringDecoder('utf8')
      const lines = new LineSplitter(text => {
        const m = spec.marker && kind === 'out' && e.pgid === null ? MARK.exec(text) : null
        if (m) { e.pgid = Number(m[1]); return }
        this.log(e, kind, text)
      })
      let idle: NodeJS.Timeout | null = null
      stream.on('data', (chunk: Buffer) => {
        // wsl.exe's own errors are UTF-16; everything the Linux side prints is UTF-8.
        lines.push(chunk.includes(0) ? decodeOutput(chunk) : dec.write(chunk))
        if (idle) clearTimeout(idle)
        if (lines.pending) idle = setTimeout(() => lines.flush(), 250)
      })
      stream.on('end', () => { if (idle) clearTimeout(idle); lines.push(dec.end()); lines.flush() })
    }
    attach(child.stdout!, 'out')
    attach(child.stderr!, 'err')

    e.exited = new Promise<void>(resolve => {
      let settled = false
      const onExit = (code: number | null, signal: NodeJS.Signals | null, spawnError?: Error) => {
        if (settled) return
        settled = true
        // let the stream 'end' handlers deliver the last lines first
        setTimeout(() => {
          if (spawnError) this.log(e, 'sys', `Could not start: ${spawnError.message}`)
          else this.log(e, 'sys', e.stopRequested ? 'Stopped.' : `Exited with ${code !== null ? `code ${code}` : `signal ${signal}`}.`)
          const failed = !e.stopRequested && (spawnError || code !== 0)
          const msg = spawnError ? spawnError.message : failed ? (code === 127 ? 'Command not found (exit code 127). Check that the tool is installed in this environment.' : `Exited with ${code !== null ? `code ${code}` : `signal ${signal}`}.`) : e.stopRequested ? null : 'Exited.'
          this.set(e, { state: failed ? 'failed' : 'stopped', exitCode: code, pid: null, message: msg })
          this.flush(e)
          resolve()
        }, 30)
      }
      child.on('exit', (code, signal) => onExit(code, signal))
      child.on('error', err => onExit(null, null, err))
    })

    if (launch.readiness.type === 'none') this.set(e, { state: 'running' })
    else void this.waitReady(e)
    return e.status
  }

  private async waitReady(e: Entry) {
    const deadline = Date.now() + e.launch.readyTimeout * 1000
    const where = describeReadiness(e.launch.readiness)
    while (this.isAlive(e.launch.key) && !e.stopRequested) {
      if (await probe(e.launch.readiness)) {
        if (this.isAlive(e.launch.key) && !e.stopRequested) { this.log(e, 'sys', `Ready at ${where}.`); this.set(e, { state: 'ready', message: null }) }
        return
      }
      if (Date.now() > deadline) {
        const hint = e.launch.runtime.kind === 'wsl'
          ? ' If the service is listening inside WSL, make sure it listens on localhost or 0.0.0.0 and that WSL localhost forwarding is enabled.'
          : ''
        const msg = `Not reachable at ${where} after ${e.launch.readyTimeout} s. The process is still running.${hint}`
        this.log(e, 'sys', msg)
        this.set(e, { state: 'failed', message: msg })
        return
      }
      await new Promise(r => setTimeout(r, this.pollMs))
    }
  }

  /** Graceful first (SIGTERM / taskkill), then forced after the grace period. Only the tree GitManager started. */
  async stop(key: string): Promise<void> {
    const e = this.entries.get(key)
    if (!e?.child || !this.isAlive(key)) return
    e.stopRequested = true
    this.set(e, { state: 'stopping' })
    this.log(e, 'sys', 'Stopping…')
    const pid = e.child.pid!
    await this.signalTree(e, pid, false)
    const exitedInTime = await Promise.race([e.exited.then(() => true), new Promise<boolean>(r => setTimeout(() => r(false), this.graceMs))])
    if (!exitedInTime) {
      this.log(e, 'sys', `Still running after ${Math.round(this.graceMs / 1000)} s; forcing it to stop.`)
      await this.signalTree(e, pid, true)
      await Promise.race([e.exited, new Promise(r => setTimeout(r, 5000))])
    } else if (this.os !== 'windows' && e.launch.runtime.kind === 'native') {
      // The leader is gone; give the rest of its process group the remaining grace period, then force it.
      const until = Date.now() + this.graceMs
      while (groupAlive(pid) && Date.now() < until) await new Promise(r => setTimeout(r, 100))
      if (groupAlive(pid)) await this.signalTree(e, pid, true)
    }
  }

  private async signalTree(e: Entry, pid: number, force: boolean) {
    const rt = e.launch.runtime
    try {
      if (rt.kind === 'wsl') {
        if (e.pgid) await run(programSpec(rt, 'kill', [force ? '-KILL' : '-TERM', '--', `-${e.pgid}`]), { timeoutMs: 10_000 })
        if (force || !e.pgid) await run({ file: 'taskkill', args: ['/PID', String(pid), '/T', '/F'] }, { timeoutMs: 10_000 })
      } else if (this.os === 'windows') {
        await run({ file: 'taskkill', args: ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])] }, { timeoutMs: 10_000 })
      } else {
        process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM')
      }
    } catch { /* the group may already be gone */ }
  }

  async restart(key: string): Promise<ServiceStatus | undefined> {
    const e = this.entries.get(key)
    if (!e) return undefined
    await this.stop(key)
    return this.start(e.launch)
  }

  async stopAll(filter: (s: ServiceStatus) => boolean = () => true) {
    await Promise.all([...this.entries.values()].filter(e => filter(e.status)).map(e => this.stop(e.launch.key)))
  }

  /** Last-resort synchronous cleanup when the app is killed: force the trees down without waiting. */
  killAllNow() {
    for (const e of this.entries.values()) {
      if (!e.child || !this.isAlive(e.launch.key)) continue
      e.stopRequested = true
      try {
        if (this.os === 'windows' || e.launch.runtime.kind === 'wsl') spawn('taskkill', ['/PID', String(e.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        else process.kill(-e.child.pid!, 'SIGKILL')
        if (e.launch.runtime.kind === 'wsl' && e.pgid) spawn('wsl.exe', ['-d', e.launch.runtime.distro, '--exec', 'kill', '-KILL', '--', `-${e.pgid}`], { windowsHide: true, stdio: 'ignore' })
      } catch { /* already gone */ }
    }
  }

  forget(key: string) { if (!this.isAlive(key)) this.entries.delete(key) }
}
