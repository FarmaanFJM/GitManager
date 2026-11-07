// One real pseudo-terminal round trip. Skipped on Windows (the shell commands are POSIX) and where node-pty cannot load.
import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNodePtyFactory, loadNodePty } from '../../src/core/ptyNode'
import { TerminalManager } from '../../src/core/terminals'
import { detectShells, planShell } from '../../src/core/shells'
import type { TerminalInfo } from '../../src/shared/terminal'

const loaded = loadNodePty()
const canRun = process.platform !== 'win32' && loaded.ok

const root = mkdtempSync(join(tmpdir(), 'gm term '))
const dir = join(root, 'dir with spaces é')
mkdirSync(dir)
afterAll(() => rmSync(root, { recursive: true, force: true }))

const until = async (cond: () => boolean, ms = 10_000) => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 25)) } }

describe('real pty', () => {
  it.skipIf(!canRun)('runs a shell in a folder with spaces, resizes, and reports the exit code', async () => {
    const shells = await detectShells()
    const sh = shells.find(s => s.available)
    expect(sh).toBeTruthy()
    const r = planShell({ shell: sh!, location: { kind: 'native', path: dir } })
    if (!r.ok) throw new Error(r.message)
    // Plain /bin/sh keeps the test independent of the developer's rc files.
    const spec = { ...r.plan, file: '/bin/sh', args: [] }
    const m = new TerminalManager({ factory: createNodePtyFactory() })
    const info: TerminalInfo = m.create(spec, 'test')
    let out = ''
    m.on('data', e => { if (e.id === info.id) out += e.data })
    try {
      m.write(info.id, 'pwd\r')
      m.write(info.id, 'echo $((6*7))\r')
      await until(() => out.includes('42') && out.includes(realpathSync(dir)))
      m.resize(info.id, 100, 30)
      m.write(info.id, 'stty size\r')
      await until(() => /30 100/.test(out))
      expect(m.scrollback(info.id).data).toContain('42')
      expect((await m.inspect(info.id)).hasChildren).toBe(false)
      m.write(info.id, 'exit 7\r')
      await until(() => m.get(info.id)?.state === 'exited')
      expect(m.get(info.id)).toMatchObject({ state: 'exited', exitCode: 7 })
    } finally {
      await m.killAll()
    }
  })
  it.skipIf(!canRun)('detects a running child process before closing', async () => {
    const m = new TerminalManager({ factory: createNodePtyFactory() })
    const info = m.create({ file: '/bin/sh', args: [], cwd: dir, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', TERM: 'xterm' }, display: dir, shell: { id: 'posix', kind: 'posix', label: 'sh', available: true } }, 't')
    try {
      m.write(info.id, 'sleep 30\r')
      const end = Date.now() + 10_000
      while (!(await m.inspect(info.id)).hasChildren) { if (Date.now() > end) throw new Error('child never detected'); await new Promise(res => setTimeout(res, 50)) }
      const r = await m.close(info.id)
      expect(r).toMatchObject({ closed: false, needsConfirm: true })
      expect(await m.close(info.id, { force: true })).toEqual({ closed: true })
    } finally { await m.killAll() }
  })
  it('reports a clear error when node-pty is unavailable', () => {
    const f = createNodePtyFactory({ load: () => ({ ok: false, message: 'The terminal component (node-pty) could not be loaded: nope' }) })
    expect(() => f.spawn('x', [], { env: {}, cols: 80, rows: 24, name: 'xterm' })).toThrow(/node-pty/)
  })
})
