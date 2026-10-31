// Where runner operations run: this computer, a WSL 2 distribution, or a remote machine over SSH. One interface
// (HostShell) hides the difference, so discovery, installation and lifecycle code is written once. Commands are always
// argument arrays; the only place a shell string is built is the SSH transport, where every token is single-quoted.
import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { access, mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { homedir, hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HostProbe, RunnerArch, RunnerHost, RunnerOs, SshConfigHost } from '../../shared/runners.js'
import { decodeOutput, hostOs, run as execRun, type ExecResult, type ExecSpec, type HostOs } from '../exec.js'
import { normalizePath, windowsToWsl } from '../paths.js'
import { archFromMachine, archFromNode, osFromUname } from './model.js'

export type RunOpts = { cwd?: string; timeoutMs?: number; env?: Record<string, string>; maxBytes?: number }
export type Runner = (spec: ExecSpec, opts?: { timeoutMs?: number; maxBytes?: number }) => Promise<ExecResult>

export interface HostShell {
  readonly host: RunnerHost
  /** The host's operating system as far as it is known before probing. */
  readonly os: RunnerOs
  /** Runs a program with arguments. Never a shell string. */
  run(file: string, args: string[], opts?: RunOpts): Promise<ExecResult>
  /** Runs a POSIX shell script with positional arguments (the script text is fixed; arguments are never interpolated). */
  script(script: string, args: string[], opts?: RunOpts): Promise<ExecResult>
  readFile(path: string, maxBytes?: number): Promise<string | null>
  exists(path: string): Promise<boolean>
  isDir(path: string): Promise<boolean>
  listDir(path: string): Promise<string[] | null>
  mkdirp(path: string): Promise<{ ok: boolean; message?: string }>
  /** Deletes a directory tree. Callers decide whether the target is really an installation; this only does what it is told. */
  remove(path: string): Promise<{ ok: boolean; message?: string }>
  /** Renames a file or directory on the host. */
  move(from: string, to: string): Promise<{ ok: boolean; message?: string }>
  /** Copies a local file to a path on the host. */
  putFile(localPath: string, hostPath: string): Promise<{ ok: boolean; message?: string }>
  /** A shell that runs as the administrator (root), or null when no supported mechanism exists. */
  elevated(): HostShell | null
  /** How elevation works on this host, for the plan and the confirmation. */
  elevationNote(): string | null
}

export const posixQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
export const posixJoin = (tokens: readonly string[]) => tokens.map(posixQuote).join(' ')

/** Spawns with a file streamed to stdin. Used to put a file onto a host that has no shared file system. */
export function runWithStdin(spec: ExecSpec, inputFile: string, timeoutMs = 600_000): Promise<ExecResult> {
  return new Promise(resolve => {
    const out: Buffer[] = [], err: Buffer[] = []
    let done = false, timedOut = false
    const finish = (r: ExecResult) => { if (!done) { done = true; clearTimeout(timer); resolve(r) } }
    let child
    try {
      child = spawn(spec.file, spec.args, { cwd: spec.cwd, env: { ...process.env, WSL_UTF8: '1', ...spec.env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (e) { resolve({ code: null, stdout: '', stderr: '', timedOut: false, spawnError: (e as Error).message }); return }
    const timer = setTimeout(() => { timedOut = true; child.kill() }, timeoutMs)
    child.stdout.on('data', (b: Buffer) => out.push(b))
    child.stderr.on('data', (b: Buffer) => err.push(b))
    child.on('error', e => finish({ code: null, stdout: '', stderr: '', timedOut, spawnError: e.message }))
    child.on('close', code => finish({ code, stdout: decodeOutput(Buffer.concat(out)), stderr: decodeOutput(Buffer.concat(err)), timedOut }))
    const src = createReadStream(inputFile)
    src.on('error', e => { child.kill(); finish({ code: null, stdout: '', stderr: e.message, timedOut, spawnError: e.message }) })
    src.pipe(child.stdin)
  })
}

const failed = (r: ExecResult) => r.spawnError ?? (r.timedOut ? 'timed out' : r.code !== 0 ? (r.stderr.trim() || `exit code ${r.code}`) : null)

/* ------------------------------------------------------------ this computer */

export type NativeOptions = { os?: HostOs; runner?: Runner; env?: NodeJS.ProcessEnv; elevate?: 'sudo' | 'pkexec' | 'uac' | null }

export class NativeShell implements HostShell {
  readonly host: RunnerHost = { kind: 'native' }
  readonly os: RunnerOs
  private readonly hostOs: HostOs
  private readonly runner: Runner
  constructor(private readonly opts: NativeOptions = {}, private readonly asRoot: 'sudo' | 'pkexec' | 'uac' | null = null) {
    this.hostOs = opts.os ?? hostOs()
    this.os = this.hostOs === 'windows' ? 'windows' : this.hostOs === 'mac' ? 'macos' : 'linux'
    this.runner = opts.runner ?? execRun
  }

  async run(file: string, args: string[], o: RunOpts = {}): Promise<ExecResult> {
    let spec: ExecSpec = { file, args, cwd: o.cwd, env: o.env }
    if (this.asRoot === 'sudo') spec = { ...spec, file: 'sudo', args: ['-n', ...(o.cwd ? ['--chdir', o.cwd] : []), '--', file, ...args] }
    else if (this.asRoot === 'pkexec') spec = { ...spec, file: 'pkexec', args: [file, ...args] }
    else if (this.asRoot === 'uac') spec = windowsElevatedSpec(file, args, o.cwd)
    const r = await this.runner(spec, { timeoutMs: o.timeoutMs ?? 120_000, maxBytes: o.maxBytes })
    if (this.asRoot === 'sudo' && r.code === 1 && /password is required|a terminal is required|sudo: /.test(r.stderr) && !r.stdout) return { ...r, stderr: 'Administrator rights are needed (sudo asked for a password, and GitManager has no terminal to type it in).' }
    return r
  }

  script(script: string, args: string[], o: RunOpts = {}): Promise<ExecResult> {
    if (this.hostOs === 'windows') return Promise.resolve({ code: null, stdout: '', stderr: 'POSIX scripts do not run on Windows.', timedOut: false, spawnError: 'unsupported' })
    return this.run('sh', ['-c', script, 'sh', ...args], o)
  }

  async readFile(path: string, maxBytes = 1024 * 1024): Promise<string | null> {
    try { const b = await readFile(path); return b.subarray(0, maxBytes).toString('utf8').replace(/^﻿/, '') } catch { return null }
  }
  async exists(path: string) { try { await access(path); return true } catch { return false } }
  async isDir(path: string) { try { return (await stat(path)).isDirectory() } catch { return false } }
  async listDir(path: string) { try { return await readdir(path) } catch { return null } }
  async mkdirp(path: string) { try { await mkdir(path, { recursive: true }); return { ok: true } } catch (e) { return { ok: false, message: (e as Error).message } } }
  async remove(path: string) { try { await rm(path, { recursive: true, force: true, maxRetries: 3 }); return { ok: true } } catch (e) { return { ok: false, message: (e as Error).message } } }
  async move(from: string, to: string) { try { await rename(from, to); return { ok: true } } catch (e) { return { ok: false, message: (e as Error).message } } }
  async putFile(localPath: string, hostPath: string) {
    if (normalizePath(localPath) === normalizePath(hostPath)) return { ok: true }
    try { const { copyFile } = await import('node:fs/promises'); await copyFile(localPath, hostPath); return { ok: true } } catch (e) { return { ok: false, message: (e as Error).message } }
  }

  elevated(): HostShell | null {
    if (this.asRoot) return this
    const how = this.opts.elevate ?? (this.hostOs === 'windows' ? 'uac' : this.hostOs === 'linux' ? 'sudo' : 'sudo')
    return new NativeShell(this.opts, how)
  }
  elevationNote() {
    if (this.hostOs === 'windows') return 'Windows asks for administrator approval (User Account Control) for each privileged step.'
    if (this.hostOs === 'mac') return 'macOS runs the runner service as your user; no administrator rights are needed.'
    return 'Privileged steps run through sudo without a prompt. If sudo needs a password, GitManager shows the exact command to run in a terminal instead.'
  }
}

/**
 * An elevated run on Windows: PowerShell starts a second, elevated PowerShell (UAC prompt) that runs the program and
 * writes its output to a temporary file, which the first one prints. Every value is embedded as a single-quoted
 * PowerShell literal (the only escape in that syntax is doubling the quote), so no argument can change the script.
 */
export function windowsElevatedSpec(file: string, args: string[], cwd?: string): ExecSpec {
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`
  const out = join(tmpdir(), `gitmanager-elev-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`)
  const inner = [
    cwd ? `Set-Location -LiteralPath ${q(cwd)}` : '',
    `& ${q(file)} ${args.map(q).join(' ')} 2>&1 | Out-File -FilePath ${q(out)} -Encoding utf8`,
    'exit $LASTEXITCODE',
  ].filter(Boolean).join('; ')
  const outer = [
    `$p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand',${q(Buffer.from(inner, 'utf16le').toString('base64'))})`,
    `if (Test-Path -LiteralPath ${q(out)}) { Get-Content -LiteralPath ${q(out)} -Raw; Remove-Item -LiteralPath ${q(out)} -Force }`,
    'exit $p.ExitCode',
  ].join('; ')
  return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(outer, 'utf16le').toString('base64')] }
}

/* ------------------------------------------------------------ WSL */

export class WslShell implements HostShell {
  readonly host: RunnerHost
  readonly os: RunnerOs = 'linux'
  private readonly runner: Runner
  constructor(readonly distro: string, opts: { runner?: Runner } = {}, private readonly user: string | null = null) {
    this.host = { kind: 'wsl', distro }
    this.runner = opts.runner ?? execRun
  }
  private spec(file: string, args: string[], o: RunOpts): ExecSpec {
    const env = o.env ? ['env', ...Object.entries(o.env).map(([k, v]) => `${k}=${v}`)] : []
    return { file: 'wsl.exe', args: ['-d', this.distro, ...(this.user ? ['-u', this.user] : []), ...(o.cwd ? ['--cd', o.cwd] : []), '--exec', ...env, file, ...args] }
  }
  run(file: string, args: string[], o: RunOpts = {}) { return this.runner(this.spec(file, args, o), { timeoutMs: o.timeoutMs ?? 120_000, maxBytes: o.maxBytes }) }
  script(script: string, args: string[], o: RunOpts = {}) { return this.run('sh', ['-c', script, 'sh', ...args], o) }
  async readFile(path: string, maxBytes = 1024 * 1024) { const r = await this.run('head', ['-c', String(maxBytes), '--', path], { timeoutMs: 20_000 }); return r.code === 0 ? r.stdout.replace(/^﻿/, '') : null }
  async exists(path: string) { return (await this.run('test', ['-e', path], { timeoutMs: 20_000 })).code === 0 }
  async isDir(path: string) { return (await this.run('test', ['-d', path], { timeoutMs: 20_000 })).code === 0 }
  async listDir(path: string) { const r = await this.run('ls', ['-1A', '--', path], { timeoutMs: 20_000 }); return r.code === 0 ? r.stdout.split('\n').map(s => s.trim()).filter(Boolean) : null }
  async mkdirp(path: string) { const r = await this.run('mkdir', ['-p', '--', path], { timeoutMs: 20_000 }); const m = failed(r); return m ? { ok: false, message: m } : { ok: true } }
  async remove(path: string) { const r = await this.run('rm', ['-rf', '--', path], { timeoutMs: 120_000 }); const m = failed(r); return m ? { ok: false, message: m } : { ok: true } }
  async move(from: string, to: string) { const r = await this.run('mv', ['--', from, to], { timeoutMs: 60_000 }); const m = failed(r); return m ? { ok: false, message: m } : { ok: true } }
  async putFile(localPath: string, hostPath: string) {
    const viaMount = windowsToWsl(localPath)
    if (viaMount) { const r = await this.run('cp', ['--', viaMount, hostPath], { timeoutMs: 300_000 }); const m = failed(r); if (!m) return { ok: true } }
    const r = await runWithStdin(this.spec('sh', ['-c', 'cat > "$1"', 'sh', hostPath], {}), localPath)
    const m = failed(r); return m ? { ok: false, message: m } : { ok: true }
  }
  /** WSL lets the Windows user run commands as root in their own distributions (wsl -u root); no password is involved. */
  elevated(): HostShell { return this.user === 'root' ? this : new WslShell(this.distro, { runner: this.runner }, 'root') }
  elevationNote() { return `Privileged steps run as root inside ${this.distro} through "wsl -u root", which Windows allows for your own distributions.` }
}

/* ------------------------------------------------------------ SSH */

export class SshShell implements HostShell {
  readonly host: RunnerHost
  readonly os: RunnerOs
  private readonly runner: Runner
  constructor(readonly alias: string, opts: { runner?: Runner; os?: RunnerOs } = {}, private readonly sudo = false) {
    this.host = { kind: 'ssh', host: alias }
    this.os = opts.os ?? 'unknown'
    this.runner = opts.runner ?? execRun
  }
  private spec(command: string): ExecSpec {
    // BatchMode: never prompt (keys and agents only); an unknown host key is refused until the user connected once in a terminal.
    return { file: 'ssh', args: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'LogLevel=ERROR', '--', this.alias, command] }
  }
  private command(file: string, args: string[], o: RunOpts): string {
    const env = o.env ? `env ${Object.entries(o.env).map(([k, v]) => posixQuote(`${k}=${v}`)).join(' ')} ` : ''
    const core = `${env}${posixJoin([file, ...args])}`
    const sudo = this.sudo ? 'sudo -n ' : ''
    return o.cwd ? `cd ${posixQuote(o.cwd)} && ${sudo}${core}` : `${sudo}${core}`
  }
  async run(file: string, args: string[], o: RunOpts = {}) {
    const r = await this.runner(this.spec(this.command(file, args, o)), { timeoutMs: o.timeoutMs ?? 120_000, maxBytes: o.maxBytes })
    if (r.code === 255) return { ...r, stderr: `SSH could not connect to ${this.alias}: ${r.stderr.trim() || 'connection failed'}. The host must accept key-based authentication without prompts, and its host key must already be known.` }
    return r
  }
  script(script: string, args: string[], o: RunOpts = {}) { return this.run('sh', ['-c', script, 'sh', ...args], o) }
  async readFile(path: string, maxBytes = 1024 * 1024) { const r = await this.run('head', ['-c', String(maxBytes), '--', path], { timeoutMs: 30_000 }); return r.code === 0 ? r.stdout.replace(/^﻿/, '') : null }
  async exists(path: string) { return (await this.run('test', ['-e', path], { timeoutMs: 30_000 })).code === 0 }
  async isDir(path: string) { return (await this.run('test', ['-d', path], { timeoutMs: 30_000 })).code === 0 }
  async listDir(path: string) { const r = await this.run('ls', ['-1A', '--', path], { timeoutMs: 30_000 }); return r.code === 0 ? r.stdout.split('\n').map(s => s.trim()).filter(Boolean) : null }
  async mkdirp(path: string) { const r = await this.run('mkdir', ['-p', '--', path], { timeoutMs: 30_000 }); const m = failed(r); return m ? { ok: false, message: m } : { ok: true } }
  async remove(path: string) { const r = await this.run('rm', ['-rf', '--', path], { timeoutMs: 120_000 }); const m = failed(r); return m ? { ok: false, message: m } : { ok: true } }
  async move(from: string, to: string) { const r = await this.run('mv', ['--', from, to], { timeoutMs: 60_000 }); const m = failed(r); return m ? { ok: false, message: m } : { ok: true } }
  async putFile(localPath: string, hostPath: string) {
    const r = await runWithStdin(this.spec(`cat > ${posixQuote(hostPath)}`), localPath)
    const m = failed(r); return m ? { ok: false, message: m } : { ok: true }
  }
  elevated(): HostShell { return this.sudo ? this : new SshShell(this.alias, { runner: this.runner, os: this.os }, true) }
  elevationNote() { return `Privileged steps run through "sudo -n" on ${this.alias}; the remote user needs passwordless sudo for them, otherwise GitManager shows the command to run there.` }
}

/* ------------------------------------------------------------ probing */

/** What a host is: operating system, architecture, machine name, user, whether systemd is PID 1 and whether sudo works without a password. */
export async function probeHost(shell: HostShell): Promise<HostProbe> {
  const base: HostProbe = { host: shell.host, reachable: false, os: 'unknown', arch: 'unknown', machine: null, user: null, systemd: null, sudo: null, message: null }
  if (shell.host.kind === 'native' && shell.os === 'windows') {
    return { ...base, reachable: true, os: 'windows', arch: archFromNode(process.arch), machine: hostname(), user: process.env.USERNAME ?? null, systemd: false, sudo: null }
  }
  const r = await shell.script('printf "%s\\n%s\\n%s\\n%s\\n" "$(uname -s 2>/dev/null)" "$(uname -m 2>/dev/null)" "$(hostname 2>/dev/null)" "$(id -un 2>/dev/null)"; printf "%s\\n" "$(ps -p 1 -o comm= 2>/dev/null)"; if sudo -n true 2>/dev/null; then echo sudo=yes; else echo sudo=no; fi; exit 0', [], { timeoutMs: 30_000 })
  if (r.spawnError || r.timedOut || r.code !== 0) return { ...base, message: r.spawnError ? `Could not start the connection: ${r.spawnError}` : r.timedOut ? 'The host did not answer in time.' : r.stderr.trim() || `The probe failed with exit code ${r.code}.` }
  const lines = r.stdout.split('\n').map(s => s.trim())
  const [sys, mach, host, user, init] = lines
  const os = osFromUname(sys ?? '')
  return {
    ...base, reachable: true, os, arch: archFromMachine(mach ?? ''), machine: host || null, user: user || null,
    systemd: os === 'linux' ? (init ?? '').startsWith('systemd') : os === 'macos' ? null : null,
    sudo: os === 'macos' ? null : lines.includes('sudo=yes') ? true : lines.includes('sudo=no') ? false : null,
  }
}

/* ------------------------------------------------------------ SSH configuration */

/** Host aliases from an OpenSSH client configuration; wildcard and negated patterns are not hosts and are left out. */
export function parseSshConfig(text: string): SshConfigHost[] {
  const out: SshConfigHost[] = []
  let cur: SshConfigHost[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) continue
    const m = /^(\S+)\s*[=\s]\s*(.+)$/.exec(line)
    if (!m) continue
    const key = m[1].toLowerCase(), value = m[2].trim().replace(/^"(.*)"$/, '$1')
    if (key === 'host') {
      cur = value.split(/\s+/).filter(a => a && !/[*?!]/.test(a)).map(alias => ({ alias, hostName: null, user: null, allowed: false }))
      out.push(...cur)
    } else if (key === 'match') cur = []
    else if (key === 'hostname') for (const c of cur) c.hostName = value
    else if (key === 'user') for (const c of cur) c.user = value
  }
  const seen = new Set<string>()
  return out.filter(h => { const k = h.alias.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true })
}

export async function readSshConfigHosts(home = homedir()): Promise<SshConfigHost[]> {
  try { return parseSshConfig(await readFile(join(home, '.ssh', 'config'), 'utf8')) } catch { return [] }
}

export const validSshAlias = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/.test(s) && !s.startsWith('-')

/* ------------------------------------------------------------ factory */

export type ShellDeps = { os?: HostOs; runner?: Runner }

export function shellFor(host: RunnerHost, deps: ShellDeps = {}): HostShell {
  if (host.kind === 'wsl') return new WslShell(host.distro, deps)
  if (host.kind === 'ssh') return new SshShell(host.host, { runner: deps.runner })
  return new NativeShell(deps)
}

export const defaultRunnerOs = (os: HostOs): RunnerOs => (os === 'windows' ? 'windows' : os === 'mac' ? 'macos' : 'linux')
export const archOfThisMachine = (): RunnerArch => archFromNode(process.arch)
