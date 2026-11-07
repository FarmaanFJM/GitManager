import { describe, expect, it } from 'vitest'
import { ProcessInspector, buildRepoIndex, pathCandidates, type OwnershipSource } from '../../src/core/procs/inspector.js'
import { procKey } from '../../src/core/procs/model.js'
import { FakeAdapter, listen, raw } from './fakes.js'

const native = { kind: 'native' } as const
const ubuntu = { kind: 'wsl', distro: 'Ubuntu' } as const

describe('repository association', () => {
  const idx = buildRepoIndex([
    { id: 'app', location: { kind: 'native', path: '/repos/app' } },
    { id: 'app2', location: { kind: 'native', path: '/repos/app2' } },
    { id: 'wt', location: { kind: 'native', path: '/repos/app/.worktrees/feature' } },
    { id: 'win', location: { kind: 'native', path: 'C:\\code\\Orders' }, extra: [{ kind: 'native', path: 'D:\\wt\\orders-hotfix' }] },
    { id: 'wsl', location: { kind: 'wsl', distro: 'Ubuntu', path: '/home/me/api' } },
    { id: 'unc', location: { kind: 'native', path: '\\\\wsl.localhost\\Debian\\home/me/web' } },
  ])
  it('matches a subfolder, the folder itself and trailing separators', () => {
    expect(idx.findRepoByPath(native, '/repos/app/src/deep')).toEqual({ repoId: 'app' })
    expect(idx.findRepoByPath(native, '/repos/app')).toEqual({ repoId: 'app' })
    expect(idx.findRepoByPath(native, '/repos/app/')).toEqual({ repoId: 'app' })
  })
  it('respects prefix boundaries: /repos/app is not /repos/app2 nor /repos/application', () => {
    expect(idx.findRepoByPath(native, '/repos/app2/x')).toEqual({ repoId: 'app2' })
    expect(idx.findRepoByPath(native, '/repos/application')).toBeNull()
    expect(idx.findRepoByPath(native, '/repos')).toBeNull()
  })
  it('longest prefix wins: a worktree inside a repository', () => {
    expect(idx.findRepoByPath(native, '/repos/app/.worktrees/feature/src')).toEqual({ repoId: 'wt' })
  })
  it('handles Windows case-insensitivity, separators, extra worktree paths and \\\\?\\ prefixes', () => {
    expect(idx.findRepoByPath(native, 'c:/CODE/orders/target')).toEqual({ repoId: 'win' })
    expect(idx.findRepoByPath(native, '\\\\?\\C:\\code\\Orders\\src')).toEqual({ repoId: 'win' })
    expect(idx.findRepoByPath(native, 'D:\\wt\\orders-hotfix\\x')).toEqual({ repoId: 'win' })
    expect(idx.findRepoByPath(native, 'C:\\code\\OrdersOld')).toBeNull()
  })
  it('keeps WSL and Windows namespaces apart but bridges UNC and /mnt', () => {
    expect(idx.findRepoByPath(ubuntu, '/home/me/api/src')).toEqual({ repoId: 'wsl' })
    expect(idx.findRepoByPath({ kind: 'wsl', distro: 'Debian' }, '/home/me/api')).toBeNull() // other distro
    expect(idx.findRepoByPath(native, '\\\\wsl.localhost\\Ubuntu\\home\\me\\api\\x')).toEqual({ repoId: 'wsl' })
    expect(idx.findRepoByPath({ kind: 'wsl', distro: 'Debian' }, '/home/me/web/src')).toEqual({ repoId: 'unc' })
    expect(idx.findRepoByPath(ubuntu, '/mnt/c/code/orders/target')).toEqual({ repoId: 'win' })
  })
  it('extracts path candidates from command lines', () => {
    const c = pathCandidates('"C:\\Program Files\\Java\\bin\\java.exe" -Dconf=C:\\code\\Orders\\conf -cp "C:\\code\\Orders\\target\\classes;x" /opt/tool --flag=/srv/x')
    expect(c).toEqual(expect.arrayContaining(['C:\\Program Files\\Java\\bin\\java.exe', 'C:\\code\\Orders\\conf', '/opt/tool', '/srv/x']))
  })
})

const ownership = (m: Record<string, { serviceKey: string; repoId: string }>): OwnershipSource => ({ managedPids: () => new Map(Object.entries(m)) })

describe('scan', () => {
  const repos = buildRepoIndex([{ id: 'app', location: { kind: 'native', path: '/repos/app' } }, { id: 'app2', location: { kind: 'native', path: '/repos/app2' } }])
  const make = (opts: { own?: OwnershipSource; now?: () => number } = {}) => {
    const a = new FakeAdapter(native, [
      raw({ pid: 1, name: 'init', command: null, ppid: 0, cwd: '/' }),
      raw({ pid: 100, name: 'npm', ppid: 1, cwd: '/repos/app' }),
      raw({ pid: 101, name: 'node', ppid: 100, cwd: '/repos/app/web', ports: [listen(5173)] }),
      raw({ pid: 200, name: 'java', ppid: 1, cwd: '/home/other', command: 'java -jar /repos/app2/build/x.jar', ports: [listen(8080)] }),
      raw({ pid: 300, name: 'bash', ppid: 1, cwd: '/repos/app2/sub' }),
      raw({ pid: 301, name: 'editor', ppid: 1, cwd: '/home/me', command: 'editor /repos/app/readme' }),
      raw({ pid: 302, name: 'postgres', ppid: 1, cwd: '/var/lib/pg', ports: [listen(5432, '127.0.0.1')] }),
      raw({ pid: 303, name: 'cron', ppid: 1, cwd: '/' }),
    ])
    const insp = new ProcessInspector({ adapters: [a], repos, ownership: opts.own, now: opts.now, selfPid: 999999 })
    return { a, insp }
  }

  it('lists only development relevant processes by default', async () => {
    const { insp } = make()
    const snap = await insp.scan()
    expect(snap.processes.map(p => p.pid).sort((a, b) => a - b)).toEqual([100, 101, 200, 300, 302])
    expect(snap.errors).toEqual([])
  })
  it('associates by cwd or command path, never by port, with the right match kind', async () => {
    const { insp } = make()
    const by = Object.fromEntries((await insp.scan()).processes.map(p => [p.pid, p]))
    expect(by[101]).toMatchObject({ repoId: 'app', repoMatch: 'cwd', owner: 'external', key: 'native:101' })
    expect(by[200]).toMatchObject({ repoId: 'app2', repoMatch: 'command' })
    expect(by[300]).toMatchObject({ repoId: 'app2', repoMatch: 'cwd' })
    expect(by[302].repoId).toBeUndefined() // postgres: no repo, port 5432 means nothing
  })
  it('includeAll lists everything', async () => {
    const { insp } = make()
    expect((await insp.scan({ includeAll: true })).processes).toHaveLength(8)
  })
  it('marks managed processes and their descendants as gitmanager-owned', async () => {
    const { insp } = make({ own: ownership({ [procKey(native, 100)]: { serviceKey: 'p:web', repoId: 'app' } }) })
    const by = Object.fromEntries((await insp.scan()).processes.map(p => [p.pid, p]))
    expect(by[100]).toMatchObject({ owner: 'gitmanager', serviceKey: 'p:web', repoMatch: 'service', repoId: 'app' })
    expect(by[101]).toMatchObject({ owner: 'gitmanager', serviceKey: 'p:web' })
    expect(by[200].owner).toBe('external')
    expect((await insp.scan()).processes[0].owner).toBe('gitmanager') // managed first
  })
  it('does not offer system processes, init or itself for stopping', async () => {
    const a = new FakeAdapter(native, [raw({ pid: 1, name: 'init', ppid: 0, ports: [listen(1)] }), raw({ pid: 50, name: 'me', ppid: 1, ports: [listen(2)] }), raw({ pid: 51, name: 'helper', command: 'app --type=renderer', ppid: 50, ports: [listen(3)] }), raw({ pid: 52, name: 'plain-child', ppid: 50, ports: [listen(5)] }), raw({ pid: 60, name: 'x', ppid: 1, ports: [listen(4)] })])
    const w = new FakeAdapter(ubuntu, [raw({ pid: 4, name: 'System', ports: [listen(445)] }), raw({ pid: 9, name: 'lsass.exe', ports: [listen(1)] }), raw({ pid: 77, name: 'java.exe', ports: [listen(8080)] })], 'windows')
    const insp = new ProcessInspector({ adapters: [a, w], repos, selfPid: 50 })
    const by = new Map((await insp.scan()).processes.map(p => [`${p.context.kind}:${p.pid}`, p]))
    expect(by.get('native:1')!.canStop).toBe(false)
    expect(by.get('native:50')).toMatchObject({ canStop: false, stopDeniedReason: 'This is GitManager itself.' })
    expect(by.get('native:51')!.canStop).toBe(false)
    expect(by.get('native:60')!.canStop).toBe(true)
    expect(by.get('native:52')!.canStop).toBe(true)
    expect(by.get('wsl:4')!.canStop).toBe(false)
    expect(by.get('wsl:9')!.canStop).toBe(false)
    expect(by.get('wsl:77')!.canStop).toBe(true)
  })
  it('keeps Windows and Linux pids apart', async () => {
    const win = new FakeAdapter(native, [raw({ pid: 10, name: 'a.exe', ports: [listen(1)] })], 'windows')
    const lin = new FakeAdapter(ubuntu, [raw({ pid: 10, name: 'b', ports: [listen(2)] })])
    const snap = await new ProcessInspector({ adapters: [win, lin], repos }).scan()
    expect(snap.processes.map(p => p.key).sort()).toEqual(['native:10', 'wsl:ubuntu:10'])
  })
  it('isolates a failing context and reports its error', async () => {
    const win = new FakeAdapter(native, [raw({ pid: 10, name: 'java.exe', ports: [listen(8080)] })], 'windows')
    const bad = new FakeAdapter(ubuntu); bad.failWith = 'The distribution is not running'
    const snap = await new ProcessInspector({ adapters: [win, bad], repos }).scan()
    expect(snap.processes.map(p => p.pid)).toEqual([10])
    expect(snap.errors).toEqual([{ context: ubuntu, message: 'The distribution is not running' }])
  })
  it('restricts to requested contexts', async () => {
    const win = new FakeAdapter(native, [raw({ pid: 10, name: 'x', ports: [listen(1)] })])
    const lin = new FakeAdapter(ubuntu, [raw({ pid: 11, name: 'y', ports: [listen(2)] })])
    const insp = new ProcessInspector({ adapters: [win, lin], repos })
    expect((await insp.scan({ contexts: [ubuntu] })).processes.map(p => p.pid)).toEqual([11])
    expect(win.scans).toBe(0)
  })
})

describe('cache and coalescing', () => {
  const repos = buildRepoIndex([])
  it('coalesces concurrent scans into one adapter call and serves the TTL cache', async () => {
    let t = 1000
    const a = new FakeAdapter(native, [raw({ pid: 1, name: 'x', ports: [listen(1)] })]); a.delayMs = 30
    const insp = new ProcessInspector({ adapters: [a], repos, ttlMs: 500, now: () => t })
    await Promise.all([insp.scan(), insp.scan(), insp.portOwner(1), insp.conflictsFor({ ports: [1] })])
    expect(a.scans).toBe(1)
    t += 400; await insp.scan(); expect(a.scans).toBe(1)
    t += 200; await insp.scan(); expect(a.scans).toBe(2)
    await insp.scan({ maxAgeMs: 0 }); expect(a.scans).toBe(3)
    insp.invalidate(); await insp.scan(); expect(a.scans).toBe(4)
  })
  it('caches a failure for the TTL so a broken distro is not hammered', async () => {
    let t = 0
    const a = new FakeAdapter(ubuntu); a.failWith = 'boom'
    const insp = new ProcessInspector({ adapters: [a], repos, ttlMs: 1000, now: () => t })
    await insp.scan(); await insp.scan(); expect(a.scans).toBe(1)
    t = 2000; a.failWith = null; expect((await insp.scan()).errors).toEqual([]); expect(a.scans).toBe(2)
  })
})

describe('portOwner and conflicts', () => {
  const repos = buildRepoIndex([])
  const setup = () => {
    const win = new FakeAdapter(native, [raw({ pid: 7120, name: 'java.exe', ports: [listen(8080)] }), raw({ pid: 5, name: 'dns', ports: [{ port: 53, protocol: 'udp', address: '*', state: 'LISTEN' }] })], 'windows')
    const lin = new FakeAdapter(ubuntu, [raw({ pid: 40, name: 'node', ppid: 1, ports: [listen(8080), listen(3000)] })])
    const own = ownership({ [procKey(ubuntu, 40)]: { serviceKey: 'p:web', repoId: 'r' } })
    return new ProcessInspector({ adapters: [win, lin], repos, ownership: own })
  }
  it('finds every owner of a port across contexts', async () => {
    const owners = await setup().portOwner(8080)
    expect(owners.map(p => p.key).sort()).toEqual(['native:7120', 'wsl:ubuntu:40'])
    expect(await setup().portOwner(53)).toEqual([])
    expect((await setup().portOwner(53, { protocol: 'udp' })).map(p => p.pid)).toEqual([5])
  })
  it('reports conflicts with managed flag and can ignore a service (restart)', async () => {
    const { conflicts } = await setup().conflictsFor({ ports: [8080, 3000, 9999] })
    expect(conflicts.map(c => [c.port, c.process.pid, c.managed]).sort()).toEqual([[3000, 40, true], [8080, 40, true], [8080, 7120, false]])
    const { conflicts: c2 } = await setup().conflictsFor({ ports: [8080], ignoreServiceKeys: ['p:web'] })
    expect(c2.map(c => c.process.pid)).toEqual([7120])
  })
  it('surfaces context errors alongside conflicts', async () => {
    const bad = new FakeAdapter(ubuntu); bad.failWith = 'down'
    const r = await new ProcessInspector({ adapters: [bad], repos }).conflictsFor({ ports: [1] })
    expect(r.conflicts).toEqual([]); expect(r.errors).toHaveLength(1)
  })
})
