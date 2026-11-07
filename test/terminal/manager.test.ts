import { describe, expect, it, vi } from 'vitest'
import { Scrollback, TerminalError, TerminalManager, linuxChildren, windowsChildCountCommand, type PtyFactory, type PtyProcess } from '../../src/core/terminals'
import type { ShellOption, TerminalEvents } from '../../src/shared/terminal'

class FakePty implements PtyProcess {
  static next = 1000
  pid = FakePty.next++
  written: string[] = []
  sizes: [number, number][] = []
  killed = 0
  private d: ((s: string) => void)[] = []
  private x: ((e: { exitCode: number; signal?: number }) => void)[] = []
  constructor(readonly file: string, readonly args: string[], readonly opts: Parameters<PtyFactory['spawn']>[2]) {}
  onData(cb: (s: string) => void) { this.d.push(cb) }
  onExit(cb: (e: { exitCode: number; signal?: number }) => void) { this.x.push(cb) }
  write(s: string) { this.written.push(s) }
  resize(c: number, r: number) { this.sizes.push([c, r]) }
  kill() { this.killed++ }
  emit(s: string) { this.d.forEach(f => f(s)) }
  exit(code: number, signal?: number) { this.x.forEach(f => f({ exitCode: code, signal })) }
}

const shell: ShellOption = { id: 'posix', kind: 'posix', label: 'bash', available: true }
const spec = { file: '/bin/bash', args: [], cwd: '/tmp', env: { A: '1' }, display: '/tmp', shell }

function setup(extra: Partial<ConstructorParameters<typeof TerminalManager>[0]> = {}) {
  const ptys: FakePty[] = []
  const factory: PtyFactory = { spawn: (f, a, o) => { const p = new FakePty(f, a, o); ptys.push(p); return p } }
  const m = new TerminalManager({ factory, hasChildren: async () => false, killTree: (_pid, p) => { p.kill() }, ...extra })
  return { m, ptys }
}

describe('TerminalManager', () => {
  it('creates a session with the given environment and default size', () => {
    const { m, ptys } = setup()
    const created: TerminalEvents['created'][] = []
    m.on('created', e => created.push(e))
    const info = m.create(spec, 'repo')
    expect(info).toMatchObject({ title: 'repo', cols: 80, rows: 24, state: 'running', exitCode: null, cwd: '/tmp' })
    expect(ptys[0].opts).toMatchObject({ cwd: '/tmp', env: { A: '1' }, cols: 80, rows: 24, name: 'xterm-256color' })
    expect(m.list()).toHaveLength(1)
    expect(m.get(info.id)).toEqual(info)
    expect(created).toHaveLength(1)
  })
  it('turns a spawn failure into a TerminalError', () => {
    const m = new TerminalManager({ factory: { spawn: () => { throw new Error('ENOENT') } } })
    expect(() => m.create(spec, 't')).toThrowError(expect.objectContaining({ code: 'SPAWN_FAILED' }))
    expect(m.list()).toHaveLength(0)
  })
  it('validates write, resize and unknown ids', () => {
    const { m, ptys } = setup()
    const { id } = m.create(spec, 't')
    expect(m.write(id, 'ls\r')).toBe(true)
    expect(ptys[0].written).toEqual(['ls\r'])
    expect(() => m.write(id, 5 as unknown as string)).toThrow(TerminalError)
    expect(() => m.write(id, 'x'.repeat(256 * 1024 + 1))).toThrow(TerminalError)
    m.resize(id, 120, 40)
    expect(ptys[0].sizes).toEqual([[120, 40]])
    expect(m.get(id)).toMatchObject({ cols: 120, rows: 40 })
    for (const [c, r] of [[1, 10], [501, 10], [80, 0], [80, 201], [80.5, 24], [NaN, 24], ['80', 24]] as [number, number][]) expect(() => m.resize(id, c, r)).toThrow(TerminalError)
    m.resize(id, 2, 1); m.resize(id, 500, 200)
    expect(ptys[0].sizes.length).toBe(3)
    expect(() => m.write('nope', 'x')).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }))
    expect(() => m.create(spec, 't', { cols: 1 })).toThrow(TerminalError)
  })
  it('streams data into events and a bounded replay buffer', () => {
    const { m, ptys } = setup({ scrollbackBytes: 100 })
    const { id } = m.create(spec, 't')
    const seen: string[] = []
    m.on('data', e => seen.push(e.data))
    for (let i = 0; i < 20; i++) ptys[0].emit(`line-${String(i).padStart(2, '0')}\r\n`) // 9 bytes each
    expect(seen).toHaveLength(20)
    const sb = m.scrollback(id)
    expect(Buffer.byteLength(sb.data)).toBeLessThanOrEqual(100)
    expect(sb.truncated).toBe(true)
    expect(sb.data.endsWith('line-19\r\n')).toBe(true)
    expect(sb.data.startsWith('line-')).toBe(true) // whole chunks dropped
  })
  it('Scrollback keeps the tail of a single huge chunk and never splits a surrogate pair', () => {
    const s = new Scrollback(10)
    s.push('a'.repeat(5) + '😀'.repeat(20))
    const { data, truncated } = s.read()
    expect(truncated).toBe(true)
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(10)
    expect(data).not.toMatch(/^[\uDC00-\uDFFF]/)
    expect(Buffer.from(data).toString()).toBe(data)
  })
  it('keeps an exited session listed with its exit code, drops late input', async () => {
    const { m, ptys } = setup()
    const { id } = m.create(spec, 't')
    const exits: TerminalEvents['exit'][] = []
    m.on('exit', e => exits.push(e))
    ptys[0].emit('bye\r\n')
    ptys[0].exit(3)
    expect(exits).toEqual([{ id, exitCode: 3, signal: null }])
    expect(m.get(id)).toMatchObject({ state: 'exited', exitCode: 3 })
    expect(m.scrollback(id).data).toBe('bye\r\n')
    ptys[0].emit('ghost')
    expect(m.scrollback(id).data).toBe('bye\r\n')
    expect(m.write(id, 'x')).toBe(false)
    expect(ptys[0].written).toEqual([])
    expect(await m.close(id)).toEqual({ closed: true })
    expect(m.list()).toEqual([])
    expect(ptys[0].killed).toBe(0) // nothing to kill
  })
  it('close with running children asks for confirmation unless forced', async () => {
    const hasChildren = vi.fn(async () => true)
    const { m, ptys } = setup({ hasChildren })
    const { id } = m.create(spec, 't')
    const closed: string[] = []
    m.on('closed', e => closed.push(e.id))
    const r = await m.close(id)
    expect(r).toMatchObject({ closed: false, needsConfirm: true, reason: expect.stringMatching(/still running/) })
    expect(m.get(id)).not.toBeNull()
    expect(ptys[0].killed).toBe(0)
    expect(hasChildren).toHaveBeenCalledWith(ptys[0].pid, shell)
    expect(await m.close(id, { force: true })).toEqual({ closed: true })
    expect(ptys[0].killed).toBe(1)
    expect(closed).toEqual([id])
    expect(m.get(id)).toBeNull()
    await expect(m.close(id)).rejects.toThrow(TerminalError)
  })
  it('closes an idle shell without asking; unknown detection only asks when configured', async () => {
    const a = setup({ hasChildren: async () => false })
    const ia = a.m.create(spec, 't')
    expect(await a.m.close(ia.id)).toEqual({ closed: true })
    const b = setup({ hasChildren: async () => null })
    const ib = b.m.create(spec, 't')
    expect(await b.m.close(ib.id)).toEqual({ closed: true })
    const c = setup({ hasChildren: async () => null, confirmWhenUnknown: true })
    const ic = c.m.create(spec, 't')
    expect(await c.m.close(ic.id)).toMatchObject({ needsConfirm: true })
    const d = setup({ hasChildren: async () => { throw new Error('x') } })
    expect(await d.m.close(d.m.create(spec, 't').id)).toEqual({ closed: true }) // detection failure is not a reason to refuse
  })
  it('inspect records hasChildren', async () => {
    const { m } = setup({ hasChildren: async () => true })
    const { id } = m.create(spec, 't')
    expect(await m.inspect(id)).toMatchObject({ hasChildren: true })
    expect(m.get(id)?.hasChildren).toBe(true)
  })
  it('enforces the session limit, and closing frees a slot', async () => {
    const { m } = setup({ maxSessions: 2 })
    const a = m.create(spec, 'a'); m.create(spec, 'b')
    expect(() => m.create(spec, 'c')).toThrowError(expect.objectContaining({ code: 'LIMIT' }))
    await m.close(a.id)
    expect(() => m.create(spec, 'c')).not.toThrow()
  })
  it('defaults to 12 sessions', () => {
    const { m } = setup()
    for (let i = 0; i < 12; i++) m.create(spec, `t${i}`)
    expect(() => m.create(spec, 'x')).toThrow(/At most 12/)
  })
  it('killAll ends every running shell and empties the list', async () => {
    const { m, ptys } = setup()
    m.create(spec, 'a'); m.create(spec, 'b'); m.create(spec, 'c')
    ptys[2].exit(0)
    await m.killAll()
    expect(ptys.map(p => p.killed)).toEqual([1, 1, 0])
    expect(m.list()).toEqual([])
  })
  it('rename updates the title and emits', () => {
    const { m } = setup()
    const { id } = m.create(spec, 'a')
    const upd = vi.fn(); m.on('updated', upd)
    expect(m.rename(id, '  build  ').title).toBe('build')
    expect(upd).toHaveBeenCalledTimes(1)
  })
})

describe('child detection helpers', () => {
  it('windowsChildCountCommand is an args array with an integer pid and refuses anything else', () => {
    const c = windowsChildCountCommand(4242)
    expect(c.file).toBe('powershell.exe')
    expect(c.args.slice(0, 4)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'])
    expect(c.args[4]).toContain('ParentProcessId=4242')
    expect(c.args[4]).toContain('conhost.exe')
    for (const bad of [0, -1, 1.5, NaN, '5; calc' as unknown as number]) expect(() => windowsChildCountCommand(bad)).toThrow()
  })
  it.skipIf(process.platform !== 'linux')('linuxChildren finds a real child of this process', async () => {
    const { spawn } = await import('node:child_process')
    const child = spawn('sleep', ['5'], { stdio: 'ignore' })
    try {
      const kids = await linuxChildren(process.pid)
      expect(kids).toContain(child.pid)
      expect(await linuxChildren(child.pid as number)).toEqual([])
    } finally { child.kill() }
  })
})
