import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { emptyConfig, effectiveMode, policyHash, DEFAULT_POLICY, sanitizeConfig } from '../../src/core/storage/config.js'
import { addPeriod, nextRunAt } from '../../src/core/storage/scheduler.js'
import { StorageService } from '../../src/core/storage/service.js'
import { Store } from '../../src/core/store.js'
import { tempDir } from '../helpers.js'
import { NOW } from './factory.js'
import { builds, FakeGitHub } from './fakeGithub.js'

let cleanups: (() => void)[] = []
afterEach(() => { for (const c of cleanups) c(); cleanups = [] })

function setup(clock = { t: NOW }) {
  const f = new FakeGitHub()
  f.repos.push(
    { ...builds('me/auto', 'app-windows-x64', [1, 2, 20, 30, 40], NOW, 100), docs: {} },
    { ...builds('me/rec', 'app-windows-x64', [1, 2, 20, 30], NOW, 200), docs: {} },
    { ...builds('me/manual', 'app-windows-x64', [1, 2, 20, 30], NOW, 300), docs: {} },
  )
  const t = tempDir('gm-svc-'); cleanups.push(t.cleanup)
  const store = new Store(join(t.dir, 'gitmanager.json'))
  const notes: string[] = []
  const opened: string[] = []
  const svc = new StorageService({
    dir: t.dir, gh: f, config: () => store.data.storage, saveConfig: () => store.save(), openExternal: async u => { opened.push(u) },
    notify: (_t, b) => notes.push(b), now: () => clock.t, sleep: async () => {}, paceMs: 0,
  })
  return { f, svc, store, notes, opened, clock, dir: t.dir }
}

describe('schedule math', () => {
  it('adds periods without drifting off month ends', () => {
    expect(addPeriod(new Date('2026-01-31T10:00:00Z'), 'monthly').toISOString()).toBe('2026-02-28T10:00:00.000Z')
    expect(addPeriod(new Date('2026-10-29T10:00:00Z'), 'weekly').toISOString()).toBe('2026-11-05T10:00:00.000Z')
    expect(addPeriod(new Date('2026-12-31T10:00:00Z'), 'daily').toISOString()).toBe('2027-01-01T10:00:00.000Z')
    expect(nextRunAt(false, '2026-01-01T00:00:00Z', 'daily')).toBeNull()
  })
})

describe('configuration', () => {
  it('starts with everything off and survives a round trip through the store', () => {
    const c = emptyConfig()
    expect(c.settings.scheduleEnabled).toBe(false)
    expect(c.defaultPolicy.mode).toBe('manual')
    const t = tempDir(); cleanups.push(t.cleanup)
    const file = join(t.dir, 'g.json')
    const s = new Store(file)
    s.data.storage.protectedRepos = ['me/keep']
    s.data.storage.pins = [{ repo: 'me/a', artifactId: 5, name: 'n', at: 'x' }]
    s.data.storage.policies['me/a'] = { ...DEFAULT_POLICY, keepLatest: 3, evidencePatterns: ['gate'] }
    s.save()
    const again = new Store(file).data.storage
    expect(again.protectedRepos).toEqual(['me/keep'])
    expect(again.pins).toHaveLength(1)
    expect(again.policies['me/a']).toMatchObject({ keepLatest: 3, evidencePatterns: ['gate'] })
  })

  it('discards invalid stored values instead of trusting them', () => {
    const c = sanitizeConfig({ settings: { frequency: 'hourly', scheduleEnabled: 'yes' }, policies: { 'bad name': {}, 'me/a': { keepLatest: 0, mode: 'danger', deleteCategories: ['everything'] } }, pins: [{ repo: 'me/a', artifactId: -3 }, { repo: '../x', artifactId: 1 }], protectedRepos: ['*', 'me/ok'] })
    expect(c.settings).toMatchObject({ frequency: 'weekly', scheduleEnabled: false })
    expect(Object.keys(c.policies)).toEqual(['me/a'])
    expect(c.policies['me/a']).toMatchObject({ keepLatest: 1, mode: 'manual', deleteCategories: [] })
    expect(c.pins).toEqual([])
    expect(c.protectedRepos).toEqual(['me/ok'])
  })

  it('automatic safe mode needs an approval that still matches the policy', () => {
    const p = { ...DEFAULT_POLICY, mode: 'auto-safe' as const }
    expect(effectiveMode(p)).toBe('recommend')
    const approved = { ...p, approvedHash: policyHash(p) }
    expect(effectiveMode(approved)).toBe('auto-safe')
    expect(effectiveMode({ ...approved, keepLatest: 1 })).toBe('recommend')
    expect(effectiveMode({ ...approved, evidencePatterns: [] })).toBe('recommend')
  })
})

describe('service', () => {
  it('scans, reports state, and refuses deletion with a read-only sign-in', async () => {
    const { f, svc } = setup()
    expect((await svc.scanAndWait()).ok).toBe(true)
    const st = svc.state()
    expect(st.snapshot!.repos).toHaveLength(3)
    expect(st.snapshot!.lastSuccessfulScanAt).not.toBeNull()
    f.auth = { state: 'ok', login: 'me', scopes: ['read:org'], scopesKnown: true, canWrite: false, plan: null }
    const r = await svc.execute(svc.candidates(), { dryRun: false })
    expect(!r.ok && r.error.code).toBe('READ_ONLY')
    expect(f.deleted).toHaveLength(0)
    const dry = await svc.execute(svc.candidates(), { dryRun: true })
    expect(dry.ok).toBe(true) // read-only operation works without delete permission
  })

  it('distinguishes missing authentication from the rest', async () => {
    const { f, svc } = setup()
    f.auth = { state: 'unauthenticated', message: 'GitHub CLI is not signed in.' }
    const r = await svc.scan()
    expect(!r.ok && r.error.code).toBe('NOT_SIGNED_IN')
    f.auth = { state: 'no-gh', message: 'gh not found' }
    const r2 = await svc.scan()
    expect(!r2.ok && r2.error.code).toBe('NO_GH')
  })

  it('manual deletion end to end: confirmed results, audit log, numbers refreshed from GitHub', async () => {
    const { f, svc } = setup()
    await svc.scanAndWait()
    const before = svc.state().snapshot!.repos.find(r => r.repo === 'me/auto')!
    expect(before.artifacts).toHaveLength(5)
    const res = await svc.execute(svc.candidates().filter(c => c.repo === 'me/auto'), { dryRun: false })
    expect(res.ok && res.value.confirmedDeleted).toBe(3)
    await svc.whenIdle()
    const after = svc.state().snapshot!.repos.find(r => r.repo === 'me/auto')!
    expect(after.artifacts).toHaveLength(2)
    expect(f.repo('me/auto')!.artifacts).toHaveLength(2)
    expect(svc.auditView().entries.length).toBeGreaterThan(0)
  })

  it('pinning protects at once and survives a rescan; unpinning restores the classification', async () => {
    const { svc, store } = setup()
    await svc.scanAndWait()
    const cand = svc.candidates().find(c => c.repo === 'me/auto')!
    svc.setPinned(cand.repo, cand.id, true)
    expect(store.data.storage.pins).toHaveLength(1)
    expect(svc.candidates().some(c => c.id === cand.id)).toBe(false)
    await svc.scanAndWait({ only: ['me/auto'] })
    expect(svc.state().snapshot!.repos.find(r => r.repo === 'me/auto')!.artifacts.find(a => a.id === cand.id)).toMatchObject({ class: 'protected', pinned: true })
    svc.setPinned(cand.repo, cand.id, false)
    await svc.whenIdle()
    expect(svc.candidates().some(c => c.id === cand.id)).toBe(true)
  })

  it('protecting a repository removes all its candidates', async () => {
    const { svc } = setup()
    await svc.scanAndWait()
    svc.setRepoProtected('me/auto', true)
    await svc.whenIdle()
    expect(svc.candidates().some(c => c.repo === 'me/auto')).toBe(false)
  })

  it('opens only the links it builds itself', async () => {
    const { svc, opened } = setup()
    await svc.open({ kind: 'run', repo: 'me/auto', runId: 42 })
    await svc.open({ kind: 'billing' })
    const bad = await svc.open({ kind: 'run', repo: 'javascript:alert(1)//x', runId: 1 })
    expect(opened).toEqual(['https://github.com/me/auto/actions/runs/42', 'https://github.com/settings/billing'])
    expect(bad.ok).toBe(false)
  })
})

describe('automation', () => {
  function configure(svc: StorageService, store: Store) {
    expect(svc.savePolicy('me/auto', { ...DEFAULT_POLICY, mode: 'auto-safe' }, true).ok).toBe(true)
    expect(svc.savePolicy('me/rec', { ...DEFAULT_POLICY, mode: 'recommend' }, false).ok).toBe(true)
    store.data.storage.settings.scheduleEnabled = true
  }

  it('does nothing unless switched on, and a switched-on schedule waits one period', async () => {
    const { svc, store, clock, f } = setup()
    await svc.scanAndWait()
    configure(svc, store)
    await svc.whenIdle()
    store.data.storage.settings.scheduleEnabled = false
    expect(await svc.tick()).toBe(false)
    svc.saveSettings({ ...store.data.storage.settings, scheduleEnabled: true, frequency: 'daily' })
    expect(await svc.tick()).toBe(false) // not due yet
    expect(svc.scheduler().nextRunAt).toBe(new Date(NOW + 86_400_000).toISOString())
    clock.t = NOW + 86_400_000 + 1000
    const calls = f.calls.length
    expect(await svc.tick()).toBe(true)
    expect(f.calls.length).toBeGreaterThan(calls)
  })

  it('deletes only in approved automatic repositories, recommends for the rest, and leaves manual repositories untouched', async () => {
    const { svc, store, f } = setup()
    await svc.scanAndWait()
    configure(svc, store)
    await svc.whenIdle()
    f.calls.length = 0
    const r = await svc.runAutomation()
    expect(r.scanned.sort()).toEqual(['me/auto', 'me/rec'])
    expect(r.deleted).toBe(3)
    expect(f.deleted.every(d => d.repo === 'me/auto')).toBe(true)
    expect(f.calls.some(c => c.path.includes('me/manual'))).toBe(false)
    expect(svc.state().recommendation!.refs.every(x => x.repo === 'me/rec')).toBe(true)
    expect(svc.state().recommendation!.refs).toHaveLength(2)
    expect(svc.scheduler().lastCleanupSummary).toContain('3 deleted')
    // audit shows these were scheduled
    expect(svc.auditView().entries.every(e => e.trigger === 'scheduled')).toBe(true)
  })

  it('an edited policy loses its approval and falls back to recommendations', async () => {
    const { svc, store, f } = setup()
    await svc.scanAndWait()
    configure(svc, store)
    // the user changes the policy but does not re-approve it
    const edited = { ...store.data.storage.policies['me/auto'], keepLatest: 1 }
    const saved = svc.savePolicy('me/auto', edited, false)
    expect(saved.ok && saved.value.effective).toBe('recommend')
    await svc.whenIdle()
    const r = await svc.runAutomation()
    expect(r.deleted).toBe(0)
    expect(f.deleted).toHaveLength(0)
  })

  it('holds a deletion above the large-deletion limit for approval', async () => {
    const { svc, store, f } = setup()
    await svc.scanAndWait()
    svc.savePolicy('me/auto', { ...DEFAULT_POLICY, mode: 'auto-safe', largeDeleteBytes: 10 * 1024 * 1024 }, true)
    store.data.storage.settings.scheduleEnabled = true
    await svc.whenIdle()
    const r = await svc.runAutomation()
    expect(r.deleted).toBe(0)
    expect(f.deleted).toHaveLength(0)
    expect(svc.state().recommendation!.refs).toHaveLength(3)
  })

  it('never auto-deletes when repository context is incomplete, and reports a failure instead of hiding it', async () => {
    const { svc, store, f, notes } = setup()
    await svc.scanAndWait()
    configure(svc, store)
    store.data.storage.settings.notify = true
    f.intercept = (_m, p) => (p.startsWith('/repos/me/auto/pulls') ? { status: 500, headers: {}, body: { message: 'down' } } : undefined)
    const r = await svc.runAutomation()
    expect(r.deleted).toBe(0)
    expect(f.deleted).toHaveLength(0)
    // a scan that fails outright is a failed run
    f.intercept = (_m, p) => (p === '/user' ? { status: 401, headers: {}, body: { message: 'x' } } : undefined)
    f.auth = { state: 'unauthenticated', message: 'GitHub CLI is not signed in.' }
    await svc.runAutomation()
    expect(svc.scheduler().lastError).toContain('not signed in')
    expect(svc.state().snapshot!.alerts.some(a => a.kind === 'cleanup-failed')).toBe(true)
    expect(notes.some(n => n.includes('failed'))).toBe(true)
  })
})
