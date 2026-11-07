// Windows: ONE fixed PowerShell invocation prints JSON with listening TCP/UDP endpoints joined to Win32_Process.
// The command text is a constant (no interpolation, no double quotes, so no argument quoting can change it).
// Windows does not expose another process's environment or working directory without elevation or a debugger;
// this adapter says so honestly and never scrapes or injects.
import { run as execRun, type ExecResult, type ExecSpec } from '../../exec.js'
import type { PortBinding } from '../../../shared/procs.js'
import type { EnvRead, ProcAdapter, RawProcess, SignalResult } from '../model.js'

export type Runner = (spec: ExecSpec, opts?: { timeoutMs?: number; maxBytes?: number }) => Promise<ExecResult>

export const POWERSHELL_COMMAND = [
  '$ErrorActionPreference = \'SilentlyContinue\'',
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  '$tcp = @(Get-NetTCPConnection -State Listen | Select-Object LocalAddress, LocalPort, OwningProcess)',
  '$udp = @(Get-NetUDPEndpoint | Select-Object LocalAddress, LocalPort, OwningProcess)',
  '$procs = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine, @{ n = \'Created\'; e = { if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString(\'o\') } } })',
  '$ids = @(($tcp + $udp) | ForEach-Object { $_.OwningProcess } | Sort-Object -Unique)',
  '$owners = @(Get-CimInstance Win32_Process | Where-Object { $ids -contains $_.ProcessId } | ForEach-Object { $o = Invoke-CimMethod -InputObject $_ -MethodName GetOwner; if ($o -and $o.User) { [pscustomobject]@{ ProcessId = $_.ProcessId; User = $o.User; Domain = $o.Domain } } })',
  '[pscustomobject]@{ tcp = $tcp; udp = $udp; procs = $procs; owners = $owners } | ConvertTo-Json -Depth 4 -Compress',
].join('; ')

export const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-Command', POWERSHELL_COMMAND]

/** Decodes PowerShell output: UTF-8 with or without BOM, or UTF-16LE (older hosts ignore OutputEncoding). */
export function decodePowerShell(buf: Buffer | string): string {
  if (typeof buf === 'string') return buf.replace(/^﻿/, '').replace(/\0/g, '')
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le')
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return Buffer.from(buf.subarray(2)).swap16().toString('utf16le')
  let zeros = 0
  const n = Math.min(buf.length, 200)
  for (let i = 1; i < n; i += 2) if (buf[i] === 0) zeros++
  if (n >= 4 && zeros > n / 4) return buf.toString('utf16le')
  return buf.toString('utf8').replace(/^﻿/, '')
}

const arr = <T>(v: T | T[] | null | undefined): T[] => (v === null || v === undefined ? [] : Array.isArray(v) ? v : [v])
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
const num = (v: unknown): number | undefined => { const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN; return Number.isFinite(n) ? n : undefined }

/** Trims the text to the JSON object (PowerShell may print progress or warnings around it). */
function extractJson(text: string): unknown {
  const t = text.replace(/^﻿/, '').replace(/\0/g, '')
  const a = t.indexOf('{'), b = t.lastIndexOf('}')
  if (a < 0 || b < a) throw new Error('PowerShell returned no data.')
  return JSON.parse(t.slice(a, b + 1))
}

const bindingOf = (e: Record<string, unknown>, udp: boolean): { pid: number; b: PortBinding } | null => {
  const pid = num(e.OwningProcess), port = num(e.LocalPort)
  if (pid === undefined || !port) return null
  const address = str(e.LocalAddress) ?? '*'
  const v6 = address.includes(':')
  return { pid, b: { port, protocol: (udp ? 'udp' : 'tcp') + (v6 ? '6' : '') as PortBinding['protocol'], address: address.replace(/%.*$/, ''), state: 'LISTEN' } }
}

/** Pure. Tolerates a single object instead of an array, nulls (access denied), BOM and UTF-16. */
export function parseWindowsProcesses(input: string | Buffer): RawProcess[] {
  const data = extractJson(decodePowerShell(input)) as Record<string, unknown>
  const owners = new Map<number, string>()
  for (const o of arr(data.owners as Record<string, unknown> | Record<string, unknown>[])) {
    const pid = num(o?.ProcessId), user = str(o?.User)
    if (pid !== undefined && user) owners.set(pid, str(o.Domain) ? `${str(o.Domain)}\\${user}` : user)
  }
  const ports = new Map<number, PortBinding[]>()
  const add = (e: Record<string, unknown>, udp: boolean) => {
    const r = e ? bindingOf(e, udp) : null
    if (!r) return
    const list = ports.get(r.pid) ?? []
    if (!list.some(x => x.port === r.b.port && x.protocol === r.b.protocol && x.address === r.b.address)) list.push(r.b)
    ports.set(r.pid, list)
  }
  for (const e of arr(data.tcp as Record<string, unknown> | Record<string, unknown>[])) add(e, false)
  for (const e of arr(data.udp as Record<string, unknown> | Record<string, unknown>[])) add(e, true)
  const out: RawProcess[] = []
  for (const p of arr(data.procs as Record<string, unknown> | Record<string, unknown>[])) {
    const pid = num(p?.ProcessId)
    if (pid === undefined) continue
    const created = str(p.Created)
    const d = created ? new Date(created) : null
    out.push({
      pid, ppid: num(p.ParentProcessId), name: str(p.Name) ?? `pid ${pid}`, command: str(p.CommandLine) ?? null, exe: str(p.ExecutablePath),
      user: owners.get(pid), startedAt: d && !Number.isNaN(d.getTime()) ? d.toISOString() : undefined, ports: ports.get(pid) ?? [],
    })
  }
  // listening sockets of processes the process table did not return (very short-lived or hidden): keep the port visible
  for (const [pid, list] of ports) if (!out.some(p => p.pid === pid)) out.push({ pid, name: `pid ${pid}`, command: null, ports: list })
  return out
}

export const WINDOWS_ENV_REASON = 'Windows does not expose another process environment without elevation or a debugger.'
const TASKKILL_DENIED = /access is denied|zugriff verweigert|acc[eè]s.*refus|acceso denegado|accesso negato/i

export class WindowsAdapter implements ProcAdapter {
  readonly os = 'windows' as const
  readonly context = { kind: 'native' } as const
  constructor(private readonly runner: Runner = execRun) {}

  async scan(): Promise<RawProcess[]> {
    const r = await this.runner({ file: 'powershell.exe', args: POWERSHELL_ARGS }, { timeoutMs: 45_000, maxBytes: 64 * 1024 * 1024 })
    if (r.spawnError) throw new Error(`PowerShell could not be started: ${r.spawnError}`)
    if (r.timedOut) throw new Error('PowerShell did not answer in time.')
    if (!r.stdout.trim()) throw new Error(r.stderr.trim().split('\n')[0] || `PowerShell exited with code ${r.code} and no output.`)
    return parseWindowsProcesses(r.stdout)
  }

  async inspect(pid: number): Promise<RawProcess | null> {
    return (await this.scan()).find(p => p.pid === pid) ?? null
  }

  async liveEnv(): Promise<EnvRead> { return { ok: false, reason: WINDOWS_ENV_REASON } }

  async signal(pid: number, mode: 'graceful' | 'force'): Promise<SignalResult> {
    if (!Number.isSafeInteger(pid) || pid <= 0) return { ok: false, message: 'Invalid process id.' }
    const r = await this.runner({ file: 'taskkill', args: ['/PID', String(pid), '/T', ...(mode === 'force' ? ['/F'] : [])] }, { timeoutMs: 15_000 })
    if (r.code === 0) return { ok: true }
    const text = `${r.stdout}\n${r.stderr}`
    if (TASKKILL_DENIED.test(text)) return { ok: false, permission: true, message: text.trim() }
    if (/not found|no running instance|nicht gefunden|introuvable/i.test(text)) return { ok: true }
    // "can only be terminated forcefully": not fatal for the graceful attempt, the caller forces after the grace period.
    return { ok: false, message: text.trim().split('\n')[0] || `taskkill exited with ${r.code}` }
  }
}
