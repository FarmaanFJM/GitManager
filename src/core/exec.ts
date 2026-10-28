import { spawn } from 'node:child_process'
import type { Location, Runtime } from '../shared/types.js'

export type HostOs = 'windows' | 'mac' | 'linux'
export const hostOs = (): HostOs => (process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux')

/** A fully resolved process invocation. Never a shell string: arguments are passed as an array. */
export type ExecSpec = {
  file: string
  args: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  windowsVerbatimArguments?: boolean
}

export type ExecResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean; spawnError?: string }

/** Environment that keeps Git non-interactive in the terminal sense and its messages parseable. Credential helpers still work. */
export const GIT_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: '0', // there is no terminal; a prompt would hang forever
  GIT_OPTIONAL_LOCKS: '0', // background status must not compete with the user's own Git commands
  LC_ALL: 'C', // English messages, so errors can be recognized
  LANGUAGE: 'C',
}

/**
 * The command that runs Git for a repository. Native repositories use the Git on PATH; WSL repositories use the Git
 * inside their own distribution through wsl.exe --exec (no shell, no Windows Git, no UNC working directory).
 */
export function gitSpec(loc: Location, args: string[]): ExecSpec {
  if (loc.kind === 'wsl') {
    const env = Object.entries(GIT_ENV).map(([k, v]) => `${k}=${v}`)
    return { file: 'wsl.exe', args: ['-d', loc.distro, '--cd', loc.path, '--exec', 'env', ...env, 'git', ...args] }
  }
  return { file: 'git', args, cwd: loc.path, env: { ...process.env, ...GIT_ENV } }
}

/** A plain program (no shell) inside a runtime. Used for small helpers such as kill, cat and find in WSL. */
export function programSpec(runtime: Runtime, file: string, args: string[], cwd?: string): ExecSpec {
  if (runtime.kind === 'wsl') return { file: 'wsl.exe', args: ['-d', runtime.distro, ...(cwd ? ['--cd', cwd] : []), '--exec', file, ...args] }
  return { file, args, cwd }
}

/**
 * wsl.exe prints its own messages as UTF-16LE (unless WSL_UTF8=1 is honoured), while programs run with --exec
 * print whatever they print (normally UTF-8). Detect UTF-16 by the NUL bytes it contains for ASCII text.
 */
export function decodeOutput(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le')
  if (buf.length >= 4) {
    let zeros = 0
    const n = Math.min(buf.length, 200)
    for (let i = 1; i < n; i += 2) if (buf[i] === 0) zeros++
    if (zeros > n / 4) return buf.toString('utf16le')
  }
  return buf.toString('utf8')
}

/** Runs a process to completion with a timeout. Never throws; a missing executable becomes spawnError. */
export function run(spec: ExecSpec, opts: { timeoutMs?: number; maxBytes?: number } = {}): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? 60_000
  const maxBytes = opts.maxBytes ?? 16 * 1024 * 1024
  return new Promise(resolve => {
    const out: Buffer[] = [], err: Buffer[] = []
    let size = 0, timedOut = false, done = false
    const finish = (r: ExecResult) => { if (!done) { done = true; clearTimeout(timer); resolve(r) } }
    let child
    try {
      child = spawn(spec.file, spec.args, {
        cwd: spec.cwd, env: { ...process.env, WSL_UTF8: '1', ...spec.env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        windowsVerbatimArguments: spec.windowsVerbatimArguments,
      })
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, spawnError: (e as Error).message })
      return
    }
    const timer = setTimeout(() => { timedOut = true; child.kill() }, timeoutMs)
    const take = (list: Buffer[]) => (b: Buffer) => { size += b.length; if (size <= maxBytes) list.push(b) }
    child.stdout.on('data', take(out))
    child.stderr.on('data', take(err))
    child.on('error', e => finish({ code: null, stdout: '', stderr: '', timedOut, spawnError: e.message }))
    child.on('close', code => finish({ code, stdout: decodeOutput(Buffer.concat(out)), stderr: decodeOutput(Buffer.concat(err)), timedOut }))
  })
}

export type Distro = { name: string; isDefault: boolean; version: number | null; state: string }

/** Parses `wsl.exe --list --verbose`. Docker Desktop's internal distributions are not development environments, so they are left out. */
export function parseWslList(text: string): Distro[] {
  const lines = text.replace(/\0/g, '').split(/\r?\n/).map(l => l.trimEnd()).filter(Boolean)
  const out: Distro[] = []
  for (const line of lines) {
    if (/^\s*NAME\s+STATE\s+VERSION/i.test(line)) continue
    const m = /^\s*(\*)?\s*(\S.*?)\s{2,}(\S+)\s+(\d+)\s*$/.exec(line)
    if (!m) continue
    if (/^docker-desktop(-data)?$/i.test(m[2])) continue
    out.push({ name: m[2], isDefault: !!m[1], state: m[3], version: Number(m[4]) })
  }
  return out
}

export async function listWslDistros(os: HostOs = hostOs()): Promise<{ available: boolean; distros: Distro[]; error?: string }> {
  if (os !== 'windows') return { available: false, distros: [] }
  const r = await run({ file: 'wsl.exe', args: ['--list', '--verbose'] }, { timeoutMs: 15_000 })
  if (r.spawnError) return { available: false, distros: [], error: 'WSL is not installed (wsl.exe was not found).' }
  if (r.code !== 0) return { available: true, distros: [], error: firstLine(r.stdout || r.stderr) || 'wsl.exe --list failed.' }
  return { available: true, distros: parseWslList(r.stdout) }
}

export const firstLine = (s: string) => s.split(/\r?\n/).map(l => l.trim()).find(Boolean) ?? ''
