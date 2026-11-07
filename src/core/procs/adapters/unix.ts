// Linux, macOS and WSL distributions. One fixed `sh` script reads /proc and prints tagged, tab-separated lines; a pure
// function turns them into processes. The script text is constant; the only positional argument is a number.
// Also here: parsers for `ss -ltnupH` (fallback when /proc/net is unreadable) and `lsof -F` (macOS).
import type { ExecResult } from '../../exec.js'
import type { HostShell } from '../../runners/hosts.js'
import type { PortBinding, ProcContext } from '../../../shared/procs.js'
import type { EnvRead, ProcAdapter, RawProcess, SignalResult } from '../model.js'
import { parseAddressPort } from '../model.js'

export type ProcShell = Pick<HostShell, 'run' | 'script'>

const US = '\u001f'
const RS = '\u001e'

/** Prints everything the parser needs. $1 = maximum command line bytes. Never interpolates anything. */
export const SCAN_SCRIPT = `
T=$(printf '\\t'); N=\${1:-8192}
echo "B$T$(sed -n 's/^btime //p' /proc/stat 2>/dev/null)$T$(getconf CLK_TCK 2>/dev/null)"
for f in tcp tcp6 udp udp6; do [ -r /proc/net/$f ] && sed "1d;s/^/N$T$f$T/" /proc/net/$f; done
cat /proc/[0-9]*/stat 2>/dev/null | sed "s/^/S$T/"
ls -ldn /proc/[0-9]* 2>/dev/null | sed "s/^/U$T/"
ls -l /proc/[0-9]*/cwd /proc/[0-9]*/exe /proc/self/cwd 2>/dev/null | sed "s/^/D$T/"
ls -l /proc/[0-9]*/fd/ /proc/self/fd/ 2>/dev/null | grep -E '^/proc/|socket:\\[' | sed "s/^/F$T/"
for d in /proc/[0-9]*; do [ -r "$d/cmdline" ] || continue; printf 'C%s%s%s' "$T" "\${d#/proc/}" "$T"; tr '\\0\\t\\n' '\\037  ' < "$d/cmdline" | head -c "$N"; echo; done
sed "s/^/W$T/" /etc/passwd 2>/dev/null
exit 0
`

/** Same tags for one process ($1 = pid, $2 = max command bytes). Used to re-verify identity. */
export const INSPECT_SCRIPT = `
T=$(printf '\\t'); P=$1; N=\${2:-8192}
[ -r "/proc/$P/stat" ] || exit 0
echo "B$T$(sed -n 's/^btime //p' /proc/stat 2>/dev/null)$T$(getconf CLK_TCK 2>/dev/null)"
sed "s/^/S$T/" "/proc/$P/stat" 2>/dev/null
ls -ldn "/proc/$P" 2>/dev/null | sed "s/^/U$T/"
ls -l "/proc/$P/cwd" "/proc/$P/exe" 2>/dev/null | sed "s/^/D$T/"
printf 'C%s%s%s' "$T" "$P" "$T"; tr '\\0\\t\\n' '\\037  ' < "/proc/$P/cmdline" 2>/dev/null | head -c "$N"; echo
sed "s/^/W$T/" /etc/passwd 2>/dev/null
exit 0
`

const ENVIRON_SCRIPT = `tr '\\0' '\\036' < "/proc/$1/environ"`
const SIGNAL_SCRIPT = `kill -s "$1" "$2"`

/* ------------------------------------------------------------ /proc/net */

const hexAddr4 = (h: string) => [3, 2, 1, 0].map(i => parseInt(h.slice(i * 2, i * 2 + 2), 16)).join('.')

function hexAddr6(h: string): string {
  // four 32-bit words, each in host (little-endian) byte order
  const groups: number[] = []
  for (let w = 0; w < 4; w++) {
    const word = h.slice(w * 8, w * 8 + 8)
    const b = [6, 4, 2, 0].map(i => parseInt(word.slice(i, i + 2), 16))
    groups.push((b[0] << 8) | b[1], (b[2] << 8) | b[3])
  }
  if (groups.every(g => g === 0)) return '::'
  if (groups.slice(0, 7).every(g => g === 0) && groups[7] === 1) return '::1'
  if (groups.slice(0, 5).every(g => g === 0) && groups[5] === 0xffff) return `::ffff:${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`
  return groups.map(g => g.toString(16)).join(':').replace(/(^|:)0(:0)+(:|$)/, '::')
}

export type NetSocket = { inode: number; binding: PortBinding }

/** One line of /proc/net/{tcp,tcp6,udp,udp6} (header removed). Returns listening/bound sockets only. */
export function parseProcNetLine(proto: 'tcp' | 'tcp6' | 'udp' | 'udp6', line: string): NetSocket | null {
  const f = line.trim().split(/\s+/)
  if (f.length < 10) return null
  const [addr, portHex] = f[1].split(':')
  const st = f[3]
  if (!addr || !portHex) return null
  const isTcp = proto.startsWith('tcp')
  if (isTcp ? st !== '0A' : st !== '07') return null
  const port = parseInt(portHex, 16)
  const inode = Number(f[9])
  if (!port || !inode) return null
  const address = addr.length === 8 ? hexAddr4(addr) : addr.length === 32 ? hexAddr6(addr) : null
  if (address === null) return null
  return { inode, binding: { port, protocol: proto, address, state: 'LISTEN' } }
}

/* ------------------------------------------------------------ tagged output */

type Partial1 = { pid: number; ppid?: number; name?: string; state?: string; startTicks?: number; uid?: string; cmd?: string; cwd?: string; exe?: string }

export function parseStatLine(raw: string): { pid: number; name: string; state: string; ppid: number; startTicks: number } | null {
  const open = raw.indexOf(' (')
  const close = raw.lastIndexOf(')')
  if (open < 0 || close < open) return null
  const pid = Number(raw.slice(0, open))
  const rest = raw.slice(close + 2).trim().split(/\s+/)
  const ppid = Number(rest[1])
  const startTicks = Number(rest[19])
  if (!Number.isInteger(pid) || !Number.isInteger(ppid)) return null
  return { pid, name: raw.slice(open + 2, close), state: rest[0], ppid, startTicks }
}

/** Parses the output of SCAN_SCRIPT or INSPECT_SCRIPT. Pure; tests feed fixtures. */
export function parseTagged(output: string): RawProcess[] {
  const procs = new Map<number, Partial1>()
  const get = (pid: number) => { let p = procs.get(pid); if (!p) { p = { pid }; procs.set(pid, p) } return p }
  const sockets = new Map<number, NetSocket>()
  const fdInodes = new Map<number, number[]>()
  const users = new Map<string, string>()
  let btime = 0, clk = 100, curFd = 0
  for (const line of output.split(/\r?\n/)) {
    if (line.length < 2 || line[1] !== '\t') continue
    const tag = line[0], body = line.slice(2)
    if (tag === 'B') { const [b, c] = body.split('\t'); btime = Number(b) || 0; clk = Number(c) || 100 }
    else if (tag === 'N') {
      const i = body.indexOf('\t')
      const proto = body.slice(0, i) as 'tcp' | 'tcp6' | 'udp' | 'udp6'
      const s = parseProcNetLine(proto, body.slice(i + 1))
      if (s) sockets.set(s.inode, s)
    } else if (tag === 'S') {
      const s = parseStatLine(body)
      if (s) Object.assign(get(s.pid), { name: s.name, state: s.state, ppid: s.ppid, startTicks: s.startTicks })
    } else if (tag === 'U') {
      const parts = body.trim().split(/\s+/)
      const m = /\/proc\/(\d+)$/.exec(parts[parts.length - 1] ?? '')
      if (m && parts.length >= 4) get(Number(m[1])).uid = parts[2]
    } else if (tag === 'D') {
      const m = /\/proc\/(\d+)\/(cwd|exe) -> (.*)$/.exec(body)
      if (m && Number(m[1]) > 0) get(Number(m[1]))[m[2] as 'cwd' | 'exe'] = m[3].replace(/ \(deleted\)$/, '')
    } else if (tag === 'F') {
      const h = /^\/proc\/(\d+)\/fd\/?:/.exec(body)
      if (h) { curFd = Number(h[1]); continue }
      if (/^\/proc\//.test(body)) { curFd = 0; continue }
      const s = /socket:\[(\d+)\]/.exec(body)
      if (s && curFd) { const l = fdInodes.get(curFd) ?? []; l.push(Number(s[1])); fdInodes.set(curFd, l) }
    } else if (tag === 'C') {
      const i = body.indexOf('\t')
      const pid = Number(body.slice(0, i))
      if (pid > 0) get(pid).cmd = body.slice(i + 1)
    } else if (tag === 'W') {
      const f = body.split(':')
      if (f.length >= 3) users.set(f[2], f[0])
    }
  }
  const out: RawProcess[] = []
  for (const p of procs.values()) {
    if (p.name === undefined) continue // vanished while reading
    const command = p.cmd === undefined || p.cmd === '' ? null : p.cmd.replace(new RegExp(`${US}+$`), '').split(US).join(' ')
    const ports: PortBinding[] = []
    const seen = new Set<string>()
    for (const inode of fdInodes.get(p.pid) ?? []) {
      const s = sockets.get(inode)
      if (!s) continue
      const k = `${s.binding.protocol}|${s.binding.address}|${s.binding.port}`
      if (!seen.has(k)) { seen.add(k); ports.push(s.binding) }
    }
    out.push({
      pid: p.pid, ppid: p.ppid, name: p.name, command, exe: p.exe, cwd: p.cwd, state: p.state, ports,
      user: p.uid !== undefined ? users.get(p.uid) ?? p.uid : undefined,
      startedAt: btime && p.startTicks !== undefined ? new Date((btime + p.startTicks / clk) * 1000).toISOString() : undefined,
    })
  }
  return out
}

/** Listening sockets with no owner found (inodes the user cannot map). Used to detect that /proc ownership is incomplete. */
export function hasNetRows(output: string): boolean { return /^N\t/m.test(output) }

/* ------------------------------------------------------------ ss */

export type SsRow = { protocol: PortBinding['protocol']; address: string; port: number; pids: { pid: number; name: string }[] }

/** Parses `ss -ltnupH` (listening TCP and bound UDP, numeric, with processes, no header). */
export function parseSs(output: string): SsRow[] {
  const rows: SsRow[] = []
  for (const line of output.split(/\r?\n/)) {
    const f = line.trim().split(/\s+/)
    if (f.length < 5) continue
    const netid = f[0].toLowerCase()
    if (netid !== 'tcp' && netid !== 'udp') continue
    const local = f.length >= 6 ? f[4] : f[3]
    const ap = parseAddressPort(local.replace(/%[^:\]]+(?=[:\]])/, ''))
    if (!ap || ap.port === 0) continue
    const v6 = ap.address.includes(':')
    const pids: { pid: number; name: string }[] = []
    for (const m of line.matchAll(/\("([^"]*)",pid=(\d+)/g)) pids.push({ name: m[1], pid: Number(m[2]) })
    rows.push({ protocol: (netid + (v6 ? '6' : '')) as PortBinding['protocol'], address: ap.address, port: ap.port, pids })
  }
  return rows
}

/* ------------------------------------------------------------ lsof (macOS) */

/** Parses `lsof -nP -iTCP -sTCP:LISTEN -F pcPn` (and the UDP equivalent). */
export function parseLsofListen(output: string): { pid: number; name: string; ports: PortBinding[] }[] {
  const out = new Map<number, { pid: number; name: string; ports: PortBinding[] }>()
  let cur: { pid: number; name: string; ports: PortBinding[] } | null = null
  let proto = 'TCP'
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue
    const c = line[0], v = line.slice(1)
    if (c === 'p') { const pid = Number(v); cur = out.get(pid) ?? { pid, name: '', ports: [] }; out.set(pid, cur); proto = 'TCP' }
    else if (!cur) continue
    else if (c === 'c') cur.name = v
    else if (c === 'P') proto = v.toUpperCase()
    else if (c === 'n') {
      const ap = parseAddressPort(v.replace(/->.*$/, ''))
      if (!ap || ap.port === 0 || v.includes('->')) continue
      const v6 = ap.address.includes(':')
      const protocol = (proto === 'UDP' ? 'udp' : 'tcp') + (v6 ? '6' : '') as PortBinding['protocol']
      if (!cur.ports.some(p => p.port === ap.port && p.protocol === protocol && p.address === ap.address)) cur.ports.push({ port: ap.port, protocol, address: ap.address, state: 'LISTEN' })
    }
  }
  return [...out.values()]
}

/** Parses `lsof -nP -a -d cwd -Fpn`: pid -> cwd. */
export function parseLsofCwd(output: string): Map<number, string> {
  const m = new Map<number, string>()
  let pid = 0
  for (const line of output.split(/\r?\n/)) {
    if (line[0] === 'p') pid = Number(line.slice(1))
    else if (line[0] === 'n' && pid) m.set(pid, line.slice(1))
  }
  return m
}

/** Parses `ps -axo pid=,ppid=,user=,lstart=,command=` (BSD/macOS). */
export function parsePsMac(output: string): { pid: number; ppid: number; user: string; startedAt?: string; command: string }[] {
  const rows = []
  for (const line of output.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/.exec(line)
    if (!m) continue
    const d = new Date(`${m[4]} UTC`)
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), user: m[3], startedAt: Number.isNaN(d.getTime()) ? undefined : d.toISOString(), command: m[5] })
  }
  return rows
}

/* ------------------------------------------------------------ environ */

/** Parses /proc/<pid>/environ after NUL was translated to the record separator (so the transport stays NUL free). */
export function parseEnviron(text: string): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = []
  for (const rec of text.split(RS)) {
    if (!rec) continue
    const i = rec.indexOf('=')
    if (i <= 0) continue
    out.push({ name: rec.slice(0, i), value: rec.slice(i + 1) })
  }
  return out
}

export const ENVIRON_NOTE = 'Read from the running process (/proc/<pid>/environ). This is the environment the process was started with; variables the program changed later are not shown.'

/* ------------------------------------------------------------ adapter */

const validPid = (pid: number) => Number.isSafeInteger(pid) && pid > 0
const MAX_CMD = '8192'
const why = (r: ExecResult) => r.spawnError ?? (r.timedOut ? 'timed out' : r.stderr.trim().split('\n')[0] || `exit code ${r.code}`)

export class UnixAdapter implements ProcAdapter {
  readonly os = 'unix' as const
  constructor(readonly context: ProcContext, private readonly shell: ProcShell, private readonly flavor: 'linux' | 'mac' = 'linux') {}

  async scan(): Promise<RawProcess[]> {
    return this.flavor === 'mac' ? this.scanMac() : this.scanLinux()
  }

  private async scanLinux(): Promise<RawProcess[]> {
    const r = await this.shell.script(SCAN_SCRIPT, [MAX_CMD], { timeoutMs: 40_000, maxBytes: 64 * 1024 * 1024 })
    if (r.spawnError || r.timedOut || (r.code !== 0 && !r.stdout)) throw new Error(`Could not list processes: ${why(r)}`)
    const procs = parseTagged(r.stdout)
    if (!hasNetRows(r.stdout)) await this.mergeSs(procs)
    return procs
  }

  /** /proc/net was not readable (restricted container, unusual kernel): ask ss instead. */
  private async mergeSs(procs: RawProcess[]) {
    const r = await this.shell.run('ss', ['-ltnupH'], { timeoutMs: 15_000 })
    if (r.code !== 0) return
    for (const row of parseSs(r.stdout)) for (const o of row.pids) {
      const p = procs.find(x => x.pid === o.pid)
      if (p && !p.ports.some(b => b.port === row.port && b.protocol === row.protocol && b.address === row.address)) p.ports.push({ port: row.port, protocol: row.protocol, address: row.address, state: 'LISTEN' })
    }
  }

  private async scanMac(): Promise<RawProcess[]> {
    const ps = await this.shell.run('ps', ['-axo', 'pid=,ppid=,user=,lstart=,command='], { timeoutMs: 20_000, env: { LC_ALL: 'C' } })
    if (ps.code !== 0) throw new Error(`Could not list processes: ${why(ps)}`)
    const listen = new Map<number, { name: string; ports: PortBinding[] }>()
    for (const args of [['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcPn'], ['-nP', '-iUDP', '-F', 'pcPn']]) {
      const l = await this.shell.run('lsof', args, { timeoutMs: 20_000 })
      if (l.stdout) for (const e of parseLsofListen(l.stdout)) { const x = listen.get(e.pid) ?? { name: e.name, ports: [] }; x.ports.push(...e.ports); listen.set(e.pid, x) }
    }
    const cwds = parseLsofCwd((await this.shell.run('lsof', ['-nP', '-a', '-d', 'cwd', '-F', 'pn'], { timeoutMs: 30_000 })).stdout)
    return parsePsMac(ps.stdout).map(p => {
      const first = p.command.split(/\s+/)[0] ?? ''
      return { pid: p.pid, ppid: p.ppid, name: listen.get(p.pid)?.name || first.split('/').pop() || first, command: p.command, exe: first.startsWith('/') ? first : undefined, cwd: cwds.get(p.pid), user: p.user, startedAt: p.startedAt, ports: listen.get(p.pid)?.ports ?? [] }
    })
  }

  async inspect(pid: number): Promise<RawProcess | null> {
    if (!validPid(pid)) return null
    if (this.flavor === 'mac') return (await this.scanMac()).find(p => p.pid === pid) ?? null
    const r = await this.shell.script(INSPECT_SCRIPT, [String(pid), MAX_CMD], { timeoutMs: 15_000 })
    if (r.spawnError || r.timedOut) throw new Error(why(r))
    return parseTagged(r.stdout).find(p => p.pid === pid) ?? null
  }

  async liveEnv(pid: number): Promise<EnvRead> {
    if (this.flavor === 'mac') return { ok: false, reason: 'macOS does not expose another process environment to GitManager.' }
    if (!validPid(pid)) return { ok: false, reason: 'Invalid process id.' }
    const r = await this.shell.script(ENVIRON_SCRIPT, [String(pid)], { timeoutMs: 15_000 })
    if (r.spawnError || r.timedOut) return { ok: false, reason: why(r) }
    if (r.code !== 0) {
      if (/permission denied|not permitted/i.test(r.stderr)) return { ok: false, reason: 'Permission denied. The environment of a process owned by another user can only be read by that user or an administrator.' }
      if (/no such file/i.test(r.stderr)) return { ok: false, reason: 'The process no longer exists.' }
      return { ok: false, reason: why(r) }
    }
    return { ok: true, entries: parseEnviron(r.stdout), note: ENVIRON_NOTE }
  }

  async signal(pid: number, mode: 'graceful' | 'force'): Promise<SignalResult> {
    if (!validPid(pid)) return { ok: false, message: 'Invalid process id.' }
    const r = await this.shell.script(SIGNAL_SCRIPT, [mode === 'force' ? 'KILL' : 'TERM', String(pid)], { timeoutMs: 15_000 })
    if (r.code === 0) return { ok: true }
    if (/no such process/i.test(r.stderr)) return { ok: true }
    if (/not permitted|permission denied/i.test(r.stderr)) return { ok: false, permission: true, message: r.stderr.trim() }
    return { ok: false, message: why(r) }
  }
}
