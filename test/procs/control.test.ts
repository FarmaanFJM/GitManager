import { describe, expect, it } from 'vitest'
import { PERMISSION_MESSAGE, sameIdentity, stopProcess } from '../../src/core/procs/control.js'
import type { ProcInfo } from '../../src/shared/procs.js'
import { FakeAdapter, raw } from './fakes.js'

const ctx = { kind: 'native' } as const
const info = (p: Partial<ProcInfo> = {}): ProcInfo => ({
  key: 'native:42', context: ctx, pid: 42, name: 'java', command: 'java -jar app.jar', startedAt: '2026-11-07T08:00:00.000Z', ports: [], owner: 'external', canStop: true, ...p,
})
const live = () => raw({ pid: 42, name: 'java', command: 'java -jar app.jar', startedAt: '2026-11-07T08:00:00.000Z' })
const fast = { pollMs: 5, graceMs: 40, forceWaitMs: 60, sleep: (ms: number) => new Promise<void>(r => setTimeout(r, ms)) }

describe('stopProcess gating', () => {
  it('requires confirmExternal === true for external processes and does not touch them', async () => {
    const a = new FakeAdapter(ctx, [live()])
    for (const confirm of [undefined, false, 'yes' as unknown as boolean]) {
      const r = await stopProcess(info(), { ...fast, confirmExternal: confirm, adapterFor: () => a })
      expect(r).toMatchObject({ ok: false, code: 'CONFIRM_REQUIRED' })
    }
    expect(a.signals).toEqual([])
  })
  it('refuses processes the inspector marked as not stoppable', async () => {
    const a = new FakeAdapter(ctx, [live()])
    expect(await stopProcess(info({ canStop: false, stopDeniedReason: 'System.' }), { confirmExternal: true, adapterFor: () => a })).toEqual({ ok: false, code: 'DENIED', message: 'System.' })
    expect(a.signals).toEqual([])
  })
  it('refuses when the PID now belongs to another process (name, start time or command differ)', async () => {
    for (const changed of [{ name: 'python' }, { startedAt: '2026-11-07T09:00:00.000Z' }, { command: 'java -jar other.jar' }]) {
      const a = new FakeAdapter(ctx, [{ ...live(), ...changed }])
      const r = await stopProcess(info(), { ...fast, confirmExternal: true, adapterFor: () => a })
      expect(r).toMatchObject({ ok: false, code: 'CHANGED' })
      expect(a.signals).toEqual([])
    }
  })
  it('treats an already exited process as success without signalling', async () => {
    const a = new FakeAdapter(ctx, [])
    expect(await stopProcess(info(), { ...fast, confirmExternal: true, adapterFor: () => a })).toMatchObject({ ok: true, alreadyGone: true })
    expect(a.signals).toEqual([])
  })
  it('compares identity tolerantly when data is missing', () => {
    expect(sameIdentity(info({ command: null }), live())).toBe(true)
    expect(sameIdentity(info({ startedAt: undefined }), raw({ pid: 42, name: 'JAVA', command: 'java -jar app.jar' }))).toBe(true)
    expect(sameIdentity(info({ startedAt: undefined, ppid: 1 }), raw({ pid: 42, name: 'java', command: 'java -jar app.jar', ppid: 9 }))).toBe(false)
  })
})

describe('stopProcess behaviour', () => {
  it('stops gracefully and verifies the process is gone', async () => {
    const a = new FakeAdapter(ctx, [live()])
    a.onSignal = (pid, mode, self) => { self.remove(pid); return { ok: true } }
    const r = await stopProcess(info(), { ...fast, confirmExternal: true, adapterFor: () => a })
    expect(r).toMatchObject({ ok: true })
    expect(a.signals).toEqual([{ pid: 42, mode: 'graceful' }])
  })
  it('forces after the grace period', async () => {
    const a = new FakeAdapter(ctx, [live()])
    a.onSignal = (pid, mode, self) => { if (mode === 'force') self.remove(pid); return { ok: true } }
    const r = await stopProcess(info(), { ...fast, confirmExternal: true, adapterFor: () => a })
    expect(r).toEqual({ ok: true, message: 'Stopped (forced).' })
    expect(a.signals.map(s => s.mode)).toEqual(['graceful', 'force'])
  })
  it('does not report success while the process survives', async () => {
    const a = new FakeAdapter(ctx, [live()])
    const r = await stopProcess(info(), { ...fast, confirmExternal: true, adapterFor: () => a })
    expect(r).toMatchObject({ ok: false, code: 'STILL_RUNNING' })
  })
  it('treats a zombie or a reused pid as gone', async () => {
    const z = new FakeAdapter(ctx, [live()])
    z.onSignal = (pid, m, self) => { self.procs = [{ ...live(), state: 'Z' }]; return { ok: true } }
    expect(await stopProcess(info(), { ...fast, confirmExternal: true, adapterFor: () => z })).toMatchObject({ ok: true })
    const r = new FakeAdapter(ctx, [live()])
    r.onSignal = (pid, m, self) => { self.procs = [raw({ pid: 42, name: 'other', command: 'other' })]; return { ok: true } }
    expect(await stopProcess(info(), { ...fast, confirmExternal: true, adapterFor: () => r })).toMatchObject({ ok: true })
    expect(r.signals).toHaveLength(1) // did not force the new owner of the pid
  })
  it('maps permission errors and never retries with elevation', async () => {
    for (const phase of ['graceful', 'force']) {
      const a = new FakeAdapter(ctx, [live()])
      a.onSignal = (_p, mode) => (mode === phase ? { ok: false, permission: true, message: 'Operation not permitted' } : { ok: true })
      const r = await stopProcess(info(), { ...fast, confirmExternal: true, adapterFor: () => a })
      expect(r).toEqual({ ok: false, code: 'PERMISSION', message: PERMISSION_MESSAGE })
    }
    expect(PERMISSION_MESSAGE).toBe('Access denied. Run GitManager as the process owner or stop it from its own terminal.')
  })
  it('reports adapter failures concisely', async () => {
    const a = new FakeAdapter(ctx, [live()])
    a.inspect = async () => { throw new Error('wsl.exe not found') }
    expect(await stopProcess(info(), { ...fast, confirmExternal: true, adapterFor: () => a })).toEqual({ ok: false, code: 'FAILED', message: 'wsl.exe not found' })
  })
  it('stops managed processes through the callback without needing confirmation', async () => {
    const a = new FakeAdapter(ctx, [live()])
    const seen: string[] = []
    const r = await stopProcess(info({ owner: 'gitmanager', serviceKey: 'p:s' }), {
      ...fast, adapterFor: () => a,
      stopManaged: async i => { seen.push(i.serviceKey!); a.remove(i.pid); return { ok: true } },
    })
    expect(r).toMatchObject({ ok: true }); expect(seen).toEqual(['p:s']); expect(a.signals).toEqual([])
  })
  it('does not trust a managed stop that left the process running, and surfaces callback failures', async () => {
    const a = new FakeAdapter(ctx, [live()])
    expect(await stopProcess(info({ owner: 'gitmanager', serviceKey: 'p:s' }), { ...fast, adapterFor: () => a, stopManaged: async () => ({ ok: true }) })).toMatchObject({ ok: false, code: 'STILL_RUNNING' })
    expect(await stopProcess(info({ owner: 'gitmanager' }), { ...fast, adapterFor: () => a, stopManaged: async () => { throw new Error('nope') } })).toMatchObject({ ok: false, code: 'FAILED', message: 'nope' })
    expect(await stopProcess(info({ owner: 'gitmanager' }), { ...fast, adapterFor: () => a })).toMatchObject({ ok: false, code: 'UNSUPPORTED' })
  })
})
