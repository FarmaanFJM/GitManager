import { describe, expect, it } from 'vitest'
import { INSPECT_SCRIPT, SCAN_SCRIPT, UnixAdapter, parseEnviron, parseLsofCwd, parseLsofListen, parseProcNetLine, parsePsMac, parseSs, parseStatLine, parseTagged } from '../../src/core/procs/adapters/unix.js'
import type { ExecResult } from '../../src/core/exec.js'

const T = '\t', US = '\u001f'
const stat = (pid: number, name: string, state: string, ppid: number, start: number) =>
  `${pid} (${name}) ${state} ${ppid} ${pid} ${pid} 0 -1 4194560 100 0 0 0 10 5 0 0 20 0 30 0 ${start} 1000000 500 18446744073709551615`
const net = (proto: string, local: string, st: string, inode: number) => `N${T}${proto}${T}   0: ${local} 00000000:0000 ${st} 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 100 0 0 10 0`

const FIXTURE = [
  `B${T}1700000000${T}100`,
  net('tcp', '00000000:1F90', '0A', 5001),
  net('tcp', '0100007F:15B3', '0A', 5002), // 127.0.0.1:5555
  net('tcp', '0100007F:0050', '01', 5003), // established, ignored
  net('tcp6', '00000000000000000000000001000000:1435', '0A', 5004), // [::1]:5173
  net('udp', '00000000:14E9', '07', 5005), // udp 5353
  `S${T}${stat(4242, 'java', 'S', 1, 50000)}`,
  `S${T}${stat(300, 'node (dev) server', 'S', 4242, 60000)}`,
  `S${T}${stat(1, 'init', 'S', 0, 10)}`,
  `U${T}dr-xr-xr-x 9 1000 1000 0 Nov  7 10:00 /proc/4242`,
  `U${T}dr-xr-xr-x 9 0 0 0 Nov  7 10:00 /proc/1`,
  `U${T}dr-xr-xr-x 9 1000 1000 0 Nov  7 10:00 /proc/300`,
  `D${T}lrwxrwxrwx 1 me me 0 Nov  7 10:00 /proc/4242/cwd -> /home/me/app`,
  `D${T}lrwxrwxrwx 1 me me 0 Nov  7 10:00 /proc/4242/exe -> /usr/lib/jvm/bin/java (deleted)`,
  `D${T}lrwxrwxrwx 1 me me 0 Nov  7 10:00 /proc/300/cwd -> /home/me/web`,
  `F${T}/proc/4242/fd:`,
  `F${T}lrwx------ 1 me me 64 Nov  7 10:00 12 -> socket:[5001]`,
  `F${T}lrwx------ 1 me me 64 Nov  7 10:00 13 -> socket:[5002]`,
  `F${T}lrwx------ 1 me me 64 Nov  7 10:00 14 -> socket:[5003]`,
  `F${T}/proc/300/fd/:`,
  `F${T}lrwx------ 1 me me 64 Nov  7 10:00 9 -> socket:[5004]`,
  `F${T}lrwx------ 1 me me 64 Nov  7 10:00 10 -> socket:[5004]`,
  `F${T}lrwx------ 1 me me 64 Nov  7 10:00 11 -> socket:[5005]`,
  `C${T}4242${T}java${US}-Xmx512m${US}-jar${US}/home/me/app/target/app.jar${US}--server.port=8080${US}`,
  `C${T}300${T}node${US}server.js${US}`,
  `C${T}1${T}`,
  `W${T}root:x:0:0:root:/root:/bin/bash`,
  `W${T}me:x:1000:1000::/home/me:/bin/bash`,
].join('\n')

describe('parseTagged (output of the fixed sh script)', () => {
  const procs = parseTagged(FIXTURE)
  const java = procs.find(p => p.pid === 4242)!
  it('builds processes with command, cwd, exe, user and start time', () => {
    expect(java).toMatchObject({ name: 'java', ppid: 1, state: 'S', cwd: '/home/me/app', exe: '/usr/lib/jvm/bin/java', user: 'me' })
    expect(java.command).toBe('java -Xmx512m -jar /home/me/app/target/app.jar --server.port=8080')
    expect(java.startedAt).toBe(new Date((1700000000 + 500) * 1000).toISOString())
  })
  it('maps socket inodes to listening ports, ignoring non-listening sockets', () => {
    expect(java.ports.map(p => `${p.protocol} ${p.address}:${p.port}`).sort()).toEqual(['tcp 0.0.0.0:8080', 'tcp 127.0.0.1:5555'])
  })
  it('handles parentheses in names, IPv6 and UDP, and de-duplicates repeated fds', () => {
    const node = procs.find(p => p.pid === 300)!
    expect(node.name).toBe('node (dev) server')
    expect(node.ports).toEqual([
      { port: 5173, protocol: 'tcp6', address: '::1', state: 'LISTEN' },
      { port: 5353, protocol: 'udp', address: '0.0.0.0', state: 'LISTEN' },
    ])
  })
  it('reports a null command line when the process has none', () => {
    expect(procs.find(p => p.pid === 1)!.command).toBeNull()
    expect(procs.find(p => p.pid === 1)!.user).toBe('root')
  })
  it('keeps the scripts constant and free of interpolation', () => {
    for (const s of [SCAN_SCRIPT, INSPECT_SCRIPT]) { expect(s).not.toMatch(/\$\{[^}]*\}\$\{/); expect(s.includes('undefined')).toBe(false) }
    expect(SCAN_SCRIPT).toContain('/proc/[0-9]*/stat')
  })
})

describe('socket and stat parsing', () => {
  it('decodes little-endian addresses', () => {
    expect(parseProcNetLine('tcp', `   1: 0100007F:1F90 00000000:0000 0A 0:0 0:0 0 1 0 77 1 0 0 0 0 0`.trim().replace(/^1:/, '1:'))?.binding.address).toBe('127.0.0.1')
    expect(parseProcNetLine('tcp6', '   1: 0000000000000000FFFF00000100007F:1F90 00000000000000000000000000000000:0000 0A 0:0 0:0 0 1 0 77 1 0 0 0 0 0')?.binding.address).toBe('::ffff:127.0.0.1')
    expect(parseProcNetLine('tcp6', '   1: 00000000000000000000000000000000:1F90 00000000000000000000000000000000:0000 0A 0:0 0:0 0 1 0 77 1 0 0 0 0 0')?.binding.address).toBe('::')
  })
  it('parses stat with spaces and parentheses in comm', () => {
    expect(parseStatLine(stat(9, 'a) b (c', 'R', 4, 777))).toMatchObject({ pid: 9, name: 'a) b (c', state: 'R', ppid: 4, startTicks: 777 })
    expect(parseStatLine('garbage')).toBeNull()
  })
})

describe('ss -ltnupH parser', () => {
  const SS = [
    'tcp   LISTEN 0      511          0.0.0.0:8080       0.0.0.0:*    users:(("java",pid=4242,fd=12))',
    'tcp   LISTEN 0      128             [::1]:5173          [::]:*    users:(("node",pid=300,fd=9),("node",pid=301,fd=9))',
    'tcp   LISTEN 0      4096    127.0.0.53%lo:53         0.0.0.0:*',
    'udp   UNCONN 0      0                  *:5353            *:*    users:(("avahi-daemon",pid=700,fd=12))',
    'tcp   LISTEN 0      128                *:22              *:*',
    'bogus line',
  ].join('\n')
  it('extracts protocol, address, port and owners', () => {
    const rows = parseSs(SS)
    expect(rows).toHaveLength(5)
    expect(rows[0]).toEqual({ protocol: 'tcp', address: '0.0.0.0', port: 8080, pids: [{ pid: 4242, name: 'java' }] })
    expect(rows[1]).toMatchObject({ protocol: 'tcp6', address: '::1', port: 5173 })
    expect(rows[1].pids.map(p => p.pid)).toEqual([300, 301])
    expect(rows[2]).toMatchObject({ address: '127.0.0.53', port: 53, pids: [] })
    expect(rows[3]).toMatchObject({ protocol: 'udp', address: '*', port: 5353 })
  })
})

describe('macOS parsers', () => {
  it('parses lsof -F listeners', () => {
    const out = ['p501', 'cnode', 'f23', 'PTCP', 'n*:3000', 'f24', 'PTCP', 'n[::1]:3000', 'p502', 'cpostgres', 'PTCP', 'n127.0.0.1:5432', 'PUDP', 'n*:5353', 'n10.0.0.1:50000->1.2.3.4:443'].join('\n')
    const r = parseLsofListen(out)
    expect(r).toHaveLength(2)
    expect(r[0]).toMatchObject({ pid: 501, name: 'node' })
    expect(r[0].ports.map(p => `${p.protocol}:${p.address}:${p.port}`)).toEqual(['tcp:*:3000', 'tcp6:::1:3000'])
    expect(r[1].ports.map(p => `${p.protocol}:${p.port}`)).toEqual(['tcp:5432', 'udp:5353'])
    expect(parseLsofCwd('p501\nn/Users/me/app\np502\nn/')).toEqual(new Map([[501, '/Users/me/app'], [502, '/']]))
  })
  it('parses ps with lstart', () => {
    const rows = parsePsMac('  501     1 me       Fri Nov  7 10:00:00 2026 /usr/local/bin/node server.js --port 3000\nnot a row')
    expect(rows).toEqual([{ pid: 501, ppid: 1, user: 'me', startedAt: '2026-11-07T10:00:00.000Z', command: '/usr/local/bin/node server.js --port 3000' }])
  })
})

describe('environ', () => {
  it('splits records, keeps = inside values and newlines', () => {
    expect(parseEnviron('A=1\u001eB=x=y\u001eMULTI=l1\nl2\u001eNOEQ\u001e=bad\u001eEMPTY=\u001e')).toEqual([
      { name: 'A', value: '1' }, { name: 'B', value: 'x=y' }, { name: 'MULTI', value: 'l1\nl2' }, { name: 'EMPTY', value: '' },
    ])
  })
})

describe('UnixAdapter with a fake shell', () => {
  const res = (p: Partial<ExecResult>): ExecResult => ({ code: 0, stdout: '', stderr: '', timedOut: false, ...p })
  const shellWith = (handler: (kind: 'script' | 'run', text: string, args: string[]) => ExecResult) => ({
    script: async (s: string, a: string[]) => handler('script', s, a),
    run: async (f: string, a: string[]) => handler('run', f, a),
  })
  it('scans through the shell with the numeric argument only', async () => {
    const calls: string[][] = []
    const a = new UnixAdapter({ kind: 'wsl', distro: 'Ubuntu' }, shellWith((k, s, args) => { calls.push(args); return res({ stdout: FIXTURE }) }))
    const procs = await a.scan()
    expect(procs.some(p => p.pid === 4242)).toBe(true)
    expect(calls[0]).toEqual(['8192'])
  })
  it('falls back to ss when /proc/net had no rows', async () => {
    const noNet = FIXTURE.split('\n').filter(l => !l.startsWith('N' + T)).join('\n')
    const a = new UnixAdapter({ kind: 'native' }, shellWith((k, s) => (k === 'run' && s === 'ss' ? res({ stdout: 'tcp LISTEN 0 1 0.0.0.0:9999 0.0.0.0:* users:(("java",pid=4242,fd=3))' }) : res({ stdout: noNet.replace(/^F\t.*\n?/gm, '') }))))
    const java = (await a.scan()).find(p => p.pid === 4242)!
    expect(java.ports).toEqual([{ port: 9999, protocol: 'tcp', address: '0.0.0.0', state: 'LISTEN' }])
  })
  it('maps environ failures to reasons and signals to permission', async () => {
    const denied = new UnixAdapter({ kind: 'native' }, shellWith(() => res({ code: 1, stderr: 'sh: 1: cannot open /proc/1/environ: Permission denied' })))
    const r = await denied.liveEnv(1)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toMatch(/Permission denied/)
    const denySig = new UnixAdapter({ kind: 'native' }, shellWith(() => res({ code: 1, stderr: 'sh: kill: (1) - Operation not permitted' })))
    expect(await denySig.signal(1, 'graceful')).toMatchObject({ ok: false, permission: true })
  })
  it('refuses invalid pids without running anything', async () => {
    const a = new UnixAdapter({ kind: 'native' }, shellWith(() => { throw new Error('must not run') }))
    expect((await a.liveEnv(-1)).ok).toBe(false)
    expect((await a.signal(0, 'force')).ok).toBe(false)
    expect(await a.inspect(NaN)).toBeNull()
  })
})
