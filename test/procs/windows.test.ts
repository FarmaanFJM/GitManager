import { describe, expect, it } from 'vitest'
import { POWERSHELL_ARGS, POWERSHELL_COMMAND, WindowsAdapter, decodePowerShell, parseWindowsProcesses } from '../../src/core/procs/adapters/windows.js'
import type { ExecResult, ExecSpec } from '../../src/core/exec.js'

const LONG = `"C:\\Program Files\\Java\\jdk-21\\bin\\java.exe" -Xms256m -Xmx1024m -Dspring.profiles.active=dev -Dfile.encoding=UTF-8 -classpath "C:\\code\\orders\\target\\classes;C:\\Users\\me\\.m2\\repository\\org\\springframework\\boot\\spring-boot\\3.3.1\\spring-boot-3.3.1.jar" com.acme.orders.OrdersApplication --server.port=8080`

const DATA = {
  tcp: [
    { LocalAddress: '0.0.0.0', LocalPort: 8080, OwningProcess: 7120 },
    { LocalAddress: '::', LocalPort: 8080, OwningProcess: 7120 },
    { LocalAddress: '127.0.0.1', LocalPort: 5173, OwningProcess: 8800 },
    { LocalAddress: '0.0.0.0', LocalPort: 135, OwningProcess: 1044 },
    { LocalAddress: '0.0.0.0', LocalPort: 9000, OwningProcess: 5000 },
    { LocalAddress: '0.0.0.0', LocalPort: 9000, OwningProcess: 5001 },
    { LocalAddress: 'fe80::1%12', LocalPort: 5040, OwningProcess: 9999 },
  ],
  udp: [{ LocalAddress: '0.0.0.0', LocalPort: 5353, OwningProcess: 8800 }],
  procs: [
    { ProcessId: 7120, ParentProcessId: 6000, Name: 'java.exe', ExecutablePath: 'C:\\Program Files\\Java\\jdk-21\\bin\\java.exe', CommandLine: LONG, Created: '2026-11-07T08:00:00.0000000Z' },
    { ProcessId: 8800, ParentProcessId: 6000, Name: 'node.exe', ExecutablePath: 'C:\\Program Files\\nodejs\\node.exe', CommandLine: 'node C:\\code\\web\\node_modules\\vite\\bin\\vite.js', Created: '2026-11-07T08:05:00Z' },
    { ProcessId: 1044, ParentProcessId: 836, Name: 'svchost.exe', ExecutablePath: null, CommandLine: null, Created: '2026-11-06T06:00:00Z' },
    { ProcessId: 5000, ParentProcessId: 836, Name: 'a.exe', ExecutablePath: 'C:\\a.exe', CommandLine: 'a.exe', Created: '2026-11-07T08:10:00Z' },
    { ProcessId: 5001, ParentProcessId: 836, Name: 'b.exe', ExecutablePath: 'C:\\b.exe', CommandLine: 'b.exe', Created: null },
  ],
  owners: { ProcessId: 7120, User: 'me', Domain: 'DESKTOP' }, // single object instead of an array
}

describe('Windows JSON parsing', () => {
  const procs = parseWindowsProcesses(JSON.stringify(DATA))
  const by = (pid: number) => procs.find(p => p.pid === pid)!
  it('joins listeners to processes with the full command line, owner and start time', () => {
    const java = by(7120)
    expect(java.command).toBe(LONG)
    expect(java.exe).toMatch(/java\.exe$/)
    expect(java.user).toBe('DESKTOP\\me')
    expect(java.startedAt).toBe('2026-11-07T08:00:00.000Z')
    expect(java.ports.map(p => `${p.protocol}:${p.address}:${p.port}`)).toEqual(['tcp:0.0.0.0:8080', 'tcp6::::8080'])
  })
  it('keeps node on 5173 and attaches UDP', () => {
    expect(by(8800).ports.map(p => `${p.protocol}:${p.port}`)).toEqual(['tcp:5173', 'udp:5353'])
  })
  it('represents an access-denied command line as null', () => {
    expect(by(1044).command).toBeNull()
    expect(by(1044).ports[0].port).toBe(135)
  })
  it('lists both PIDs when two processes share one port', () => {
    expect(procs.filter(p => p.ports.some(b => b.port === 9000)).map(p => p.pid).sort()).toEqual([5000, 5001])
    expect(by(5001).startedAt).toBeUndefined()
  })
  it('keeps listeners of processes missing from the process table and strips zone ids', () => {
    expect(by(9999).ports[0].address).toBe('fe80::1')
    expect(by(9999).command).toBeNull()
  })
  it('tolerates single objects instead of arrays, empty sections, BOM and UTF-16', () => {
    const single = { tcp: DATA.tcp[0], udp: null, procs: DATA.procs[0], owners: null }
    expect(parseWindowsProcesses(JSON.stringify(single)).map(p => p.pid)).toEqual([7120])
    expect(parseWindowsProcesses('\uFEFF' + JSON.stringify(DATA))).toHaveLength(procs.length)
    const u16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(JSON.stringify(DATA), 'utf16le')])
    expect(parseWindowsProcesses(u16)).toHaveLength(procs.length)
    expect(parseWindowsProcesses(Buffer.from(JSON.stringify(DATA), 'utf16le'))).toHaveLength(procs.length)
    expect(parseWindowsProcesses(`WARNING: something\n${JSON.stringify(DATA)}\n`)).toHaveLength(procs.length)
    expect(decodePowerShell(Buffer.from('\uFEFFhello'))).toBe('hello')
  })
  it('throws a clear error without JSON', () => {
    expect(() => parseWindowsProcesses('Access denied')).toThrow(/no data/)
  })
})

describe('Windows invocation', () => {
  it('uses one constant powershell command as an argument array', () => {
    expect(POWERSHELL_ARGS.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command'])
    expect(POWERSHELL_ARGS[3]).toBe(POWERSHELL_COMMAND)
    expect(POWERSHELL_COMMAND).toContain('[Console]::OutputEncoding')
    expect(POWERSHELL_COMMAND).toContain('Get-NetTCPConnection -State Listen')
    expect(POWERSHELL_COMMAND).toContain('Win32_Process')
    expect(POWERSHELL_COMMAND).not.toContain('"')
  })
  const res = (p: Partial<ExecResult>): ExecResult => ({ code: 0, stdout: '', stderr: '', timedOut: false, ...p })
  it('scans through the runner and reports spawn errors', async () => {
    const specs: ExecSpec[] = []
    const ok = new WindowsAdapter(async s => { specs.push(s); return res({ stdout: JSON.stringify(DATA) }) })
    expect((await ok.scan()).length).toBeGreaterThan(3)
    expect(specs[0].file).toBe('powershell.exe')
    await expect(new WindowsAdapter(async () => res({ code: null, spawnError: 'ENOENT' })).scan()).rejects.toThrow(/could not be started/)
  })
  it('never claims to know another process environment', async () => {
    const r = await new WindowsAdapter(async () => res({})).liveEnv()
    expect(r).toEqual({ ok: false, reason: 'Windows does not expose another process environment without elevation or a debugger.' })
  })
  it('maps taskkill results', async () => {
    const mk = (r: Partial<ExecResult>) => new WindowsAdapter(async () => res(r))
    expect(await mk({ code: 0 }).signal(10, 'graceful')).toEqual({ ok: true })
    expect(await mk({ code: 1, stderr: 'ERROR: The process with PID 10 could not be terminated.\nReason: Access is denied.' }).signal(10, 'force')).toMatchObject({ ok: false, permission: true })
    expect(await mk({ code: 128, stderr: 'ERROR: The process "10" not found.' }).signal(10, 'force')).toEqual({ ok: true })
    expect((await mk({ code: 1, stderr: 'ERROR: This process can only be terminated forcefully (with /F option).' }).signal(10, 'graceful')).ok).toBe(false)
  })
  it('passes /T and only forces with /F', async () => {
    const specs: ExecSpec[] = []
    const a = new WindowsAdapter(async s => { specs.push(s); return res({}) })
    await a.signal(42, 'graceful'); await a.signal(42, 'force')
    expect(specs.map(s => s.args)).toEqual([['/PID', '42', '/T'], ['/PID', '42', '/T', '/F']])
  })
})
