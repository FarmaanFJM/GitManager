// Real-system tests: a real node process listens on an ephemeral port; discovery, environment and stop run against /proc.
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ProcessInspector, buildRepoIndex, createProcAdapters, runtimeEnvOf, stopProcess } from '../../src/core/procs/index.js'
import type { ProcInfo } from '../../src/shared/procs.js'

const linux = process.platform === 'linux' && existsSync('/proc/self/stat')

describe.skipIf(!linux)('real processes (Linux)', () => {
  let dir = '', child: ChildProcess, port = 0
  let insp: ProcessInspector
  const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
  const SCRIPT = "const s=require('net').createServer().listen(0,'127.0.0.1',()=>console.log('PORT='+s.address().port));setInterval(()=>{},1000)"

  beforeAll(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'gm-procs-')))
    child = spawn(process.execPath, ['-e', SCRIPT, 'gm-procs-marker'], { cwd: dir, env: { ...process.env, GM_TEST_VAR: 'custom-value-123', GM_TEST_SECRET_TOKEN: 'shh' }, stdio: ['ignore', 'pipe', 'ignore'] })
    port = await new Promise<number>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('child did not start')), 10_000)
      child.stdout!.on('data', (b: Buffer) => { const m = /PORT=(\d+)/.exec(b.toString()); if (m) { clearTimeout(t); resolve(Number(m[1])) } })
    })
    insp = new ProcessInspector({
      adapters: createProcAdapters({ os: 'linux' }),
      repos: buildRepoIndex([{ id: 'tmp-repo', location: { kind: 'native', path: dir } }]),
      ttlMs: 0,
    })
  })
  afterAll(() => { try { child.kill('SIGKILL') } catch { /* gone */ }; if (dir) rmSync(dir, { recursive: true, force: true }) })

  const find = async (): Promise<ProcInfo> => {
    const snap = await insp.scan({ maxAgeMs: 0 })
    expect(snap.errors).toEqual([])
    const p = snap.processes.find(x => x.pid === child.pid)
    expect(p, 'child not discovered').toBeDefined()
    return p!
  }

  it('discovers the listening process with port, cwd, command and external owner', async () => {
    const p = await find()
    expect(p.ports.some(b => b.port === port && b.protocol === 'tcp' && b.address === '127.0.0.1')).toBe(true)
    expect(p.cwd).toBe(dir)
    expect(p.command).toContain('gm-procs-marker')
    expect(p.command).toContain("createServer")
    expect(p.owner).toBe('external')
    expect(p).toMatchObject({ repoId: 'tmp-repo', repoMatch: 'cwd', canStop: true, key: `native:${child.pid}` })
    expect(p.startedAt).toBeDefined()
    expect(p.name.length).toBeGreaterThan(0)
  })

  it('finds the port owner and reports a conflict', async () => {
    const owners = await insp.portOwner(port, { maxAgeMs: 0 })
    expect(owners.map(o => o.pid)).toEqual([child.pid])
    const { conflicts } = await insp.conflictsFor({ ports: [port], maxAgeMs: 0 })
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({ port, managed: false })
  })

  it('reads the live environment and flags sensitive names', async () => {
    const p = await find()
    const env = await runtimeEnvOf(p, { adapter: insp.adapterFor(p.context) })
    expect(env.source).toBe('runtime-live')
    expect(env.entries.find(e => e.name === 'GM_TEST_VAR')).toEqual({ name: 'GM_TEST_VAR', value: 'custom-value-123', sensitive: false })
    expect(env.entries.find(e => e.name === 'GM_TEST_SECRET_TOKEN')).toMatchObject({ value: 'shh', sensitive: true })
    expect(env.note).toMatch(/started with/)
  })

  it('refuses to stop an external process without confirmation, and it survives', async () => {
    const p = await find()
    const r = await stopProcess(p, { adapterFor: c => insp.adapterFor(c) })
    expect(r).toMatchObject({ ok: false, code: 'CONFIRM_REQUIRED' })
    const r2 = await stopProcess(p, { confirmExternal: false, adapterFor: c => insp.adapterFor(c) })
    expect(r2).toMatchObject({ ok: false, code: 'CONFIRM_REQUIRED' })
    await new Promise(r => setTimeout(r, 300))
    expect(alive(child.pid!)).toBe(true)
    expect((await find()).ports.some(b => b.port === port)).toBe(true)
  })

  it('stops it with confirmation and verifies it is gone', async () => {
    const p = await find()
    const exited = new Promise<void>(r => child.once('exit', () => r()))
    const r = await stopProcess(p, { confirmExternal: true, graceMs: 3000, adapterFor: c => insp.adapterFor(c) })
    expect(r).toMatchObject({ ok: true })
    await exited
    expect(alive(child.pid!)).toBe(false)
    const snap = await insp.scan({ maxAgeMs: 0 })
    expect(snap.processes.find(x => x.pid === child.pid)).toBeUndefined()
    expect(await insp.portOwner(port, { maxAgeMs: 0 })).toEqual([])
  })
})
