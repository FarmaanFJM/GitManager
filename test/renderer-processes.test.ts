import { beforeAll, describe, expect, it } from 'vitest'
import type { PortBinding, ProcInfo } from '../src/shared/procs.js'

// The renderer reads window.gitmanager when api.ts loads; the helpers under test never call it.
let P: typeof import('../src/renderer/Processes.js')
let E: typeof import('../src/renderer/EnvironmentView.js')
beforeAll(async () => {
  ;(globalThis as { window?: unknown }).window = { gitmanager: {} }
  P = await import('../src/renderer/Processes.js')
  E = await import('../src/renderer/EnvironmentView.js')
})

const b = (port: number, protocol: PortBinding['protocol'] = 'tcp'): PortBinding => ({ port, protocol, address: '0.0.0.0', state: 'LISTEN' })
const proc = (o: Partial<ProcInfo> & { pid: number }): ProcInfo => ({
  key: `native:${o.pid}`, context: { kind: 'native' }, name: 'node', command: 'node server.js', ports: [], owner: 'external', canStop: true, ...o,
})

describe('port formatting', () => {
  it('shows the lowest port and a count of the others', () => {
    expect(P.portLabel([])).toBe('')
    expect(P.portLabel([b(8080)])).toBe('8080')
    expect(P.portLabel([b(9000), b(3000), b(3001)])).toBe('3000 +2')
  })
  it('counts a port bound on tcp and tcp6 once', () => {
    expect(P.portLabel([b(80), b(80, 'tcp6')])).toBe('80')
    expect(P.distinctPorts([b(81), b(80, 'tcp6'), b(80)])).toEqual([80, 81])
  })
  it('words the ports for the confirm dialog', () => {
    expect(P.portsText({ ports: [b(8080)] })).toBe('Port 8080')
    expect(P.portsText({ ports: [b(1), b(2)] })).toBe('Ports 1, 2')
    expect(P.portsText({ ports: [] })).toBe('')
  })
})

describe('default list', () => {
  it('keeps listening and GitManager-started processes only', () => {
    const list = [proc({ pid: 1 }), proc({ pid: 2, ports: [b(80)] }), proc({ pid: 3, owner: 'gitmanager' })]
    expect(P.visibleProcs(list).map(p => p.pid)).toEqual([2, 3])
  })
})

describe('sorting', () => {
  const repo = (id?: string) => ({ r1: 'beta', r2: 'alpha' } as Record<string, string>)[id ?? ''] ?? ''
  const list = [proc({ pid: 1, name: 'zed', ports: [b(9000)], repoId: 'r1' }), proc({ pid: 2, name: 'api', ports: [b(80)] }), proc({ pid: 3, name: 'mid', owner: 'gitmanager', repoId: 'r2' })]
  it('sorts by lowest port with portless processes last in both directions', () => {
    expect(P.sortProcs(list, 'port', 1, repo).map(p => p.pid)).toEqual([2, 1, 3])
    expect(P.sortProcs(list, 'port', -1, repo).map(p => p.pid)).toEqual([1, 2, 3])
  })
  it('sorts by name, numerically', () => {
    expect(P.sortProcs(list, 'name', 1, repo).map(p => p.name)).toEqual(['api', 'mid', 'zed'])
    expect(P.sortProcs([proc({ pid: 1, name: 'n10' }), proc({ pid: 2, name: 'n9' })], 'name', 1, repo).map(p => p.name)).toEqual(['n9', 'n10'])
  })
  it('sorts by repository with unassociated processes last', () => {
    expect(P.sortProcs(list, 'repo', 1, repo).map(p => p.pid)).toEqual([3, 1, 2])
    expect(P.sortProcs(list, 'repo', -1, repo).map(p => p.pid)).toEqual([1, 3, 2])
  })
  it('does not reorder its input', () => {
    const copy = [...list]
    P.sortProcs(list, 'name', -1, repo)
    expect(list).toEqual(copy)
  })
})

describe('search', () => {
  const repo = (id?: string) => (id === 'r1' ? 'Billing' : '')
  const list = [proc({ pid: 4120, name: 'java', ports: [b(8080)], command: 'java -jar app.jar' }), proc({ pid: 7, name: 'node', repoId: 'r1', owner: 'gitmanager' })]
  it('matches name, pid, port, command, repository and owner', () => {
    expect(P.filterProcs(list, 'JAVA', repo)).toHaveLength(1)
    expect(P.filterProcs(list, '4120', repo)[0].pid).toBe(4120)
    expect(P.filterProcs(list, '8080', repo)[0].pid).toBe(4120)
    expect(P.filterProcs(list, 'app.jar', repo)[0].pid).toBe(4120)
    expect(P.filterProcs(list, 'billing', repo)[0].pid).toBe(7)
    expect(P.filterProcs(list, 'external', repo)[0].pid).toBe(4120)
    expect(P.filterProcs(list, '  ', repo)).toHaveLength(2)
    expect(P.filterProcs(list, 'nothing', repo)).toHaveLength(0)
  })
})

describe('stop wording', () => {
  it('names process and PID', () => expect(P.stopTitle({ name: 'java', pid: 4120 })).toBe('Stop java (PID 4120)?'))
  it('never suggests elevation', () => {
    for (const c of ['PERMISSION', 'DENIED', 'CHANGED', 'STILL_RUNNING', 'FAILED', 'UNSUPPORTED', 'CONFIRM_REQUIRED'] as const) {
      expect(P.stopNextStep(c).toLowerCase()).not.toMatch(/admin|sudo|elevat|root/)
      expect(P.stopNextStep(c)).not.toContain('—')
    }
    expect(P.stopNextStep('PERMISSION')).not.toBe('')
  })
})

describe('service keys', () => {
  const profiles = [{ id: 'p1', services: [{ id: 's1' }] }] as unknown as Parameters<typeof P.resolveService>[1]
  it('parses profile and service ids', () => {
    expect(E.parseServiceKey('p1:s1')).toEqual({ profileId: 'p1', serviceId: 's1' })
    expect(E.parseServiceKey(undefined)).toBeNull()
    expect(E.parseServiceKey('nocolon')).toBeNull()
    expect(E.parseServiceKey(':s')).toBeNull()
    expect(E.parseServiceKey('p:')).toBeNull()
  })
  it('offers a restart only when the profile and service exist', () => {
    expect(P.resolveService('p1:s1', profiles)).toEqual({ profileId: 'p1', serviceId: 's1' })
    expect(P.resolveService('p1:gone', profiles)).toBeNull()
    expect(P.resolveService('x:s1', profiles)).toBeNull()
    expect(P.resolveService(undefined, profiles)).toBeNull()
  })
  it('picks the root process of a service', () => {
    const list = [proc({ pid: 10, ppid: 1, serviceKey: 'p1:s1' }), proc({ pid: 11, ppid: 10, serviceKey: 'p1:s1' }), proc({ pid: 12, serviceKey: 'other' })]
    expect(E.pickServiceProcess(list, 'p1:s1')?.pid).toBe(10)
    expect(E.pickServiceProcess(list, 'none')).toBeNull()
  })
})

describe('environment helpers', () => {
  const entries = [
    { name: 'PATH', value: '/usr/bin:/bin', sensitive: false },
    { name: 'API_TOKEN', value: 'hunter2', sensitive: true },
    { name: 'home', value: '/root', sensitive: false },
  ]
  it('filters by name and by non-sensitive value, never by a secret', () => {
    expect(E.filterEntries(entries, 'path').map(e => e.name)).toEqual(['PATH'])
    expect(E.filterEntries(entries, '/usr/bin').map(e => e.name)).toEqual(['PATH'])
    expect(E.filterEntries(entries, 'hunter2')).toEqual([])
    expect(E.filterEntries(entries, 'token').map(e => e.name)).toEqual(['API_TOKEN'])
    expect(E.filterEntries(entries, '')).toBe(entries)
  })
  it('sorts names case-insensitively without mutating', () => {
    expect(E.sortEntries(entries).map(e => e.name)).toEqual(['API_TOKEN', 'home', 'PATH'])
    expect(entries[0].name).toBe('PATH')
  })
  it('labels sources and contexts', () => {
    expect(E.sourceLabel('runtime-launch')).toBe('Captured at launch')
    expect(E.sourceLabel('runtime-live')).toBe('Read from the running process')
    expect(E.sourceLabel('unavailable')).toBe('')
    expect(E.contextLabel({ kind: 'wsl', distro: 'Ubuntu' })).toBe('WSL Ubuntu')
    expect(E.contextLabel({ kind: 'native' }, 'windows')).toBe('Windows')
  })
  it('builds compact metadata', () => {
    const m = E.runtimeMeta({ source: 'runtime-launch', context: { kind: 'native' }, pid: 5, capturedAt: 'bad', entries: [], note: '' }, 'node', 'linux')
    expect(m).toEqual(['node (PID 5)', 'Captured at launch', 'Linux'])
  })
  it('lists each note once', () => {
    expect(E.uniqueNotes([{ note: 'a' }, { note: 'a' }, { note: 'b' }, { note: '' }])).toEqual(['a', 'b'])
  })
})
