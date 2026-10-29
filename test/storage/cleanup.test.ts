import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AuditLog } from '../../src/core/storage/audit.js'
import { buildPlan, executePlan, reconcileAudit } from '../../src/core/storage/cleanup.js'
import { emptyConfig } from '../../src/core/storage/config.js'
import { GitHub } from '../../src/core/storage/github.js'
import { ScanCache, scanAll } from '../../src/core/storage/scanner.js'
import type { ArtifactRef, Snapshot, StorageConfig } from '../../src/shared/storage.js'
import { tempDir } from '../helpers.js'
import { NOW } from './factory.js'
import { builds, FakeGitHub } from './fakeGithub.js'

const auth = { state: 'ok', login: 'me', scopes: ['repo'], scopesKnown: true, canWrite: true, plan: 'free' } as const
const now = () => NOW
let cleanups: (() => void)[] = []
afterEach(() => { for (const c of cleanups) c(); cleanups = [] })

function setup(mutate?: (f: FakeGitHub) => void) {
  const f = new FakeGitHub()
  f.repos.push(
    { ...builds('me/app', 'app-windows-x64', [1, 2, 20, 30, 40], NOW, 100), docs: {} },
    { ...builds('me/lib', 'coverage-report', [1, 5, 30, 60], NOW, 200), docs: {} },
  )
  mutate?.(f)
  const t = tempDir('gm-audit-'); cleanups.push(t.cleanup)
  const gh = new GitHub(f, { sleep: async () => {}, maxWaitMs: 1000 })
  const audit = new AuditLog(join(t.dir, 'audit.jsonl'), now)
  const config: StorageConfig = emptyConfig()
  const cache = new ScanCache()
  const scan = async () => (await scanAll(gh, auth, { config, now, cache })).snapshot
  const run = async (snap: Snapshot, refs: ArtifactRef[], o: Partial<Parameters<typeof executePlan>[3]> = {}, plan = buildPlan(snap, refs, { allowReview: o.allowReview ?? false })) =>
    executePlan(snap, plan.items, { gh, audit, config: () => config, cache, paceMs: 0, sleep: async () => {}, now }, { trigger: 'manual', dryRun: false, allowReview: false, ...o })
  const candidates = (snap: Snapshot) => snap.repos.flatMap(r => r.artifacts).filter(a => a.class === 'delete-candidate').map(a => ({ repo: a.repo, id: a.id }))
  return { f, gh, audit, config, scan, run, candidates, dir: t.dir }
}

describe('plan', () => {
  it('lists exactly the verified candidates and excludes protected, kept, expired and unknown artifacts with a reason', async () => {
    const { scan, candidates } = setup()
    const snap = await scan()
    const everything = snap.repos.flatMap(r => r.artifacts).map(a => ({ repo: a.repo, id: a.id }))
    const plan = buildPlan(snap, [...everything, { repo: 'me/app', id: 999999 }, { repo: 'me/app', id: -1 }, { repo: '*', id: 1 }], { allowReview: false })
    expect(plan.items.map(i => i.ref)).toEqual(candidates(snap))
    expect(plan.excluded.every(e => e.why)).toBe(true)
    expect(plan.excluded.some(e => e.why.includes('Not in the last scan'))).toBe(true)
    expect(plan.repos.sort()).toEqual(['me/app', 'me/lib'])
    expect(plan.totalBytes).toBe(plan.items.reduce((n, i) => n + i.sizeBytes, 0))
  })

  it('admits Review artifacts only when the user picks them', async () => {
    const { scan } = setup(f => { for (const [i, d] of [5, 400, 500].entries()) { f.repos[0].runs.push({ id: 700 + i }); f.repos[0].artifacts.push({ id: 7000 + i, name: 'mystery-output', size: 5, created: new Date(NOW - d * 86_400_000).toISOString(), run: 700 + i }) } })
    const snap = await scan()
    const review = snap.repos[0].artifacts.find(a => a.id === 7002)!
    expect(review.class).toBe('review')
    const ref = [{ repo: review.repo, id: review.id }]
    expect(buildPlan(snap, ref, { allowReview: false }).items).toHaveLength(0)
    expect(buildPlan(snap, ref, { allowReview: true }).items).toHaveLength(1)
  })
})

describe('deletion', () => {
  it('deletes only after confirming with GitHub, and logs attempt and outcome', async () => {
    const { f, scan, run, candidates, audit } = setup()
    const snap = await scan()
    const refs = candidates(snap)
    expect(refs).toHaveLength(5) // 3 builds + 2 reports
    const r = await run(snap, refs)
    expect(r.confirmedDeleted).toBe(5)
    expect(r.confirmedBytes).toBe(5 * 20 * 1024 * 1024)
    expect(r.items.every(i => i.outcome === 'deleted')).toBe(true)
    expect(f.deleted).toHaveLength(5)
    expect(f.repo('me/app')!.artifacts).toHaveLength(2)
    const view = audit.view()
    expect(view.intact).toBe(true)
    expect(view.unresolved).toBe(0)
    expect(view.entries.filter(e => e.type === 'attempt')).toHaveLength(5)
    expect(view.entries.filter(e => e.type === 'result' && e.outcome === 'deleted')).toHaveLength(5)
    const e = view.entries[0]
    expect(e).toMatchObject({ repo: expect.any(String), artifactId: expect.any(Number), name: expect.any(String), sizeBytes: expect.any(Number) })
  })

  it('does not call a request a success: an artifact GitHub still lists is unconfirmed and not counted as reclaimed', async () => {
    const { f, scan, run, candidates } = setup()
    const snap = await scan()
    f.ignoreDeletes = true
    const r = await run(snap, candidates(snap).slice(0, 2))
    expect(r.items.map(i => i.outcome)).toEqual(['deleted-unconfirmed', 'deleted-unconfirmed'])
    expect(r.confirmedDeleted).toBe(0)
    expect(r.confirmedBytes).toBe(0)
  })

  it('dry run revalidates and reports what would happen without a single DELETE', async () => {
    const { f, scan, run, candidates, audit } = setup()
    const snap = await scan()
    const r = await run(snap, candidates(snap), { dryRun: true })
    expect(r.items.every(i => i.outcome === 'skipped-dry-run')).toBe(true)
    expect(f.count('DELETE', /./)).toBe(0)
    expect(audit.view().total).toBe(0)
  })

  it('sends nothing at all when the user cancels before starting', async () => {
    const { f, scan, run, candidates } = setup()
    const snap = await scan()
    const calls = f.calls.length
    const r = await run(snap, candidates(snap), { signal: { cancelled: true } })
    expect(r.items.every(i => i.outcome === 'not-attempted')).toBe(true)
    expect(f.calls.length).toBe(calls)
  })

  it('skips artifacts whose metadata changed between the scan and the deletion', async () => {
    const { f, scan, run, candidates } = setup()
    const snap = await scan()
    const refs = candidates(snap).filter(r => r.repo === 'me/app')
    f.repos[0].artifacts.find(a => a.id === refs[0].id)!.size += 1 // replaced by a different upload
    const r = await run(snap, refs)
    expect(r.items.find(i => i.ref.id === refs[0].id)!.outcome).toBe('skipped-changed')
    expect(r.items.filter(i => i.outcome === 'deleted')).toHaveLength(refs.length - 1)
  })

  it('skips artifacts that became protected, or whose classification changed, since the scan', async () => {
    const { f, scan, run, candidates, config } = setup()
    const snap = await scan()
    const refs = candidates(snap).filter(r => r.repo === 'me/app')
    config.pins.push({ repo: 'me/app', artifactId: refs[0].id, name: '', at: '' })
    config.protectedRepos.push('me/lib')
    const r = await run(snap, candidates(snap))
    expect(r.items.find(i => i.ref.id === refs[0].id)!.outcome).toBe('skipped-protected')
    expect(r.items.filter(i => i.ref.repo === 'me/lib').every(i => i.outcome === 'skipped-protected')).toBe(true)
    expect(f.repo('me/lib')!.artifacts).toHaveLength(4)
    // a newer build appearing makes older ones still candidates, but an open PR appearing keeps them
    const s2 = await scan()
    f.repos[0].pulls = [{ number: 5, ref: 'main', sha: 'x' }]
    const left = candidates(s2).filter(c => c.repo === 'me/app')
    const r2 = await run(s2, left)
    expect(r2.items.every(i => i.outcome === 'skipped-changed')).toBe(true)
    expect(f.deleted.some(d => d.repo === 'me/lib')).toBe(false)
  })

  it('reports a permission failure, stops that repository and still processes the others', async () => {
    const { f, scan, run, candidates } = setup()
    const snap = await scan()
    f.repos[0].push = undefined
    f.intercept = (m, p) => (m === 'DELETE' && p.startsWith('/repos/me/app/') ? { status: 403, headers: {}, body: { message: 'Resource not accessible by personal access token' } } : undefined)
    const r = await run(snap, candidates(snap))
    const app = r.items.filter(i => i.ref.repo === 'me/app')
    expect(app.map(i => i.outcome)).toEqual(['denied', 'denied', 'denied'])
    expect(f.count('DELETE', /me\/app/)).toBe(1) // not retried against every artifact
    expect(r.items.filter(i => i.ref.repo === 'me/lib').every(i => i.outcome === 'deleted')).toBe(true)
  })

  it('stops on a rate limit that will not lift soon and reports the rest as not attempted', async () => {
    const { f, scan, run, candidates } = setup()
    const snap = await scan()
    let seen = 0
    f.intercept = (m) => (m === 'DELETE' && ++seen === 2 ? { status: 403, headers: { 'retry-after': '3600' }, body: { message: 'You have exceeded a secondary rate limit' } } : undefined)
    const r = await run(snap, candidates(snap))
    const outcomes = r.items.map(i => i.outcome)
    expect(outcomes.filter(o => o === 'deleted')).toHaveLength(1)
    expect(outcomes).toContain('rate-limited')
    expect(outcomes.filter(o => o === 'not-attempted')).toHaveLength(3)
    expect(r.interrupted).toBe(true)
    expect(r.stopReason).toContain('rate limit')
  })

  it('waits out a short rate limit and carries on', async () => {
    const { f, scan, run, candidates } = setup()
    const snap = await scan()
    let seen = 0
    f.intercept = (m) => (m === 'DELETE' && ++seen === 1 ? { status: 429, headers: { 'retry-after': '1' }, body: { message: 'slow down' } } : undefined)
    const r = await run(snap, candidates(snap))
    expect(r.items.every(i => i.outcome === 'deleted')).toBe(true)
  })

  it('stops everything on an authentication error and never retries it', async () => {
    const { f, scan, run, candidates } = setup()
    const snap = await scan()
    f.intercept = (m) => (m === 'DELETE' ? { status: 401, headers: {}, body: { message: 'Bad credentials' } } : undefined)
    const r = await run(snap, candidates(snap))
    expect(r.items.filter(i => i.outcome === 'denied')).toHaveLength(1)
    expect(r.items.filter(i => i.outcome === 'not-attempted' || i.outcome === 'denied')).toHaveLength(r.items.length)
    expect(f.count('DELETE', /./)).toBe(1)
  })

  it('records partial failures per artifact and keeps going', async () => {
    const { f, scan, run, candidates } = setup()
    const snap = await scan()
    const target = candidates(snap)[1]
    f.intercept = (m, p) => (m === 'DELETE' && p.endsWith(`/${target.id}`) ? { status: 500, headers: {}, body: { message: 'server error' } } : undefined)
    const r = await run(snap, candidates(snap))
    expect(r.items.find(i => i.ref.id === target.id)!.outcome).toBe('failed')
    expect(r.items.filter(i => i.outcome === 'deleted')).toHaveLength(4)
    expect(r.confirmedDeleted).toBe(4)
  })

  it('a repeated deletion request is harmless', async () => {
    const { f, scan, run, candidates } = setup()
    const snap = await scan()
    const refs = candidates(snap)
    await run(snap, refs)
    const again = await run(snap, refs) // same stale plan
    expect(again.items.every(i => i.outcome === 'already-gone')).toBe(true)
    expect(f.deleted).toHaveLength(5)
  })

  it('an interrupted operation leaves an attempt that a later scan resolves', async () => {
    const { f, scan, run, candidates, audit } = setup()
    const snap = await scan()
    const refs = candidates(snap).filter(r => r.repo === 'me/app')
    // the process dies after the request was written to the log and sent, before the outcome was recorded
    audit.append({ opId: 'dead', type: 'attempt', trigger: 'manual', repo: 'me/app', artifactId: refs[0].id, name: 'x', runId: 1, sizeBytes: 1 })
    audit.append({ opId: 'dead', type: 'attempt', trigger: 'manual', repo: 'me/app', artifactId: refs[1].id, name: 'y', runId: 1, sizeBytes: 1 })
    expect(audit.view().unresolved).toBe(2)
    f.repos[0].artifacts = f.repos[0].artifacts.filter(a => a.id !== refs[0].id) // the first deletion did happen
    const after = await scan()
    expect(reconcileAudit(audit, after)).toBe(2)
    expect(audit.view().unresolved).toBe(0)
    const results = audit.read().entries.filter(e => e.opId === 'dead' && e.type === 'result')
    expect(results.map(e => e.outcome).sort()).toEqual(['deleted', 'not-attempted'])
    void run
  })

  it('never deletes protected, kept or uncertain artifacts even when asked for them by id', async () => {
    const { f, scan, run } = setup()
    const snap = await scan()
    const nonCandidates = snap.repos.flatMap(r => r.artifacts).filter(a => a.class !== 'delete-candidate').map(a => ({ repo: a.repo, id: a.id }))
    expect(nonCandidates.length).toBeGreaterThan(0)
    const plan = buildPlan(snap, nonCandidates, { allowReview: false })
    expect(plan.items).toHaveLength(0)
    const r = await run(snap, nonCandidates)
    expect(r.items).toHaveLength(0)
    expect(f.deleted).toHaveLength(0)
    // even a forged plan item is refused by revalidation
    const forged = nonCandidates.map(ref => ({ ref, name: 'x', sizeBytes: 1, createdAt: null, runId: null, runUrl: null, class: 'delete-candidate' as const, reasonCode: 'superseded-build' as const, reason: '' }))
    const r2 = await run(snap, [], {}, { ...plan, items: forged })
    expect(r2.items.every(i => i.outcome !== 'deleted' && i.outcome !== 'deleted-unconfirmed')).toBe(true)
    expect(f.deleted).toHaveLength(0)
  })

  it('refuses archived repositories even when they are included in the scan', async () => {
    const { f, gh, config, run } = setup(f => { f.repos[0].archived = true })
    config.settings.includeArchived = true
    const snap = (await scanAll(gh, auth, { config, now })).snapshot
    const app = snap.repos.find(r => r.repo === 'me/app')!
    expect(app.canDelete).toBe(false)
    const refs = app.artifacts.filter(a => a.class === 'delete-candidate').map(a => ({ repo: a.repo, id: a.id }))
    expect(refs.length).toBeGreaterThan(0)
    const plan = buildPlan(snap, refs, { allowReview: false })
    expect(plan.items).toHaveLength(0)
    expect(plan.excluded[0].why).toContain('Archived')
    const r = await run(snap, [], {}, { ...plan, items: plan.excluded.map(e => ({ ...e })) })
    expect(r.items.every(i => i.outcome === 'denied')).toBe(true)
    expect(f.deleted).toHaveLength(0)
  })
})

describe('audit log', () => {
  it('detects edited, deleted and reordered lines, and survives a half-written last line', () => {
    const t = tempDir('gm-audit-'); cleanups.push(t.cleanup)
    const file = join(t.dir, 'a.jsonl')
    const log = new AuditLog(file, now)
    for (let i = 1; i <= 4; i++) log.append({ opId: 'o', type: 'result', trigger: 'manual', repo: 'a/b', artifactId: i, name: `n${i}`, runId: i, sizeBytes: i, outcome: 'deleted' })
    expect(new AuditLog(file).read().intact).toBe(true)
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    writeFileSync(file, [lines[0], lines[1].replace('"n2"', '"edited"'), lines[2], lines[3]].join('\n') + '\n')
    expect(new AuditLog(file).read()).toMatchObject({ intact: false, brokenAt: 2 })
    writeFileSync(file, [lines[0], lines[2], lines[3]].join('\n') + '\n')
    expect(new AuditLog(file).read().intact).toBe(false)
    writeFileSync(file, lines.join('\n') + '\n{"seq":5,"at":"2026')
    const reopened = new AuditLog(file, now)
    reopened.append({ opId: 'o', type: 'result', trigger: 'manual', repo: 'a/b', artifactId: 9, name: 'n9', runId: 9, sizeBytes: 9, outcome: 'deleted' })
    const after = reopened.read()
    expect(after.entries.map(e => e.artifactId)).toEqual([1, 2, 3, 4, 9])
    expect(after.intact).toBe(false) // the damaged line is reported, not hidden
    appendFileSync(file, '')
  })
})

describe('adversarial names', () => {
  const evil = ['a; rm -rf /', '$(calc.exe)', '`whoami`', 'x" & del /q * & "', "it's", '../../releases/1', 'name\nwith\nnewlines', '%2e%2e%2f', '*', 'ünï©ode 😀', '{{ secrets.TOKEN }}', '--output=x']

  it('artifact names never reach a command line or a request path: only validated ids and repository names do', async () => {
    const { f, gh, scan, run, candidates } = setup(f => {
      f.repos[0].artifacts = []; f.repos[0].runs = []
      evil.forEach((name, i) => { for (const [j, d] of [1, 2, 20, 30].entries()) { f.repos[0].runs.push({ id: 5000 + i * 10 + j }); f.repos[0].artifacts.push({ id: 6000 + i * 10 + j, name: `${name}-windows-x64`, size: 1024, created: new Date(NOW - d * 86_400_000).toISOString(), run: 5000 + i * 10 + j }) } })
    })
    void gh
    const snap = await scan()
    const refs = candidates(snap)
    expect(refs.length).toBeGreaterThan(0)
    const r = await run(snap, refs.filter(x => x.repo === 'me/app'))
    expect(r.items.every(i => i.outcome === 'deleted')).toBe(true)
    for (const c of f.calls) expect(c.path, c.path).toMatch(/^\/[A-Za-z0-9_./?=&%,:+-]*$/)
    for (const c of f.calls.filter(c => c.method === 'DELETE')) expect(c.path).toMatch(/^\/repos\/me\/app\/actions\/artifacts\/\d+$/)
    expect(f.calls.some(c => /rm|calc|whoami|secrets/.test(c.path))).toBe(false)
  })

  it('a renderer-supplied repository name that is not owner/name never produces a request', async () => {
    const { buildPlan } = await import('../../src/core/storage/cleanup.js')
    const { f, scan } = setup()
    const snap = await scan()
    const calls = f.calls.length
    for (const repo of ['*', '../x', 'a/b/c', 'me/app; rm -rf /', 'me/app\n', '', 'me/..', '$(x)/y']) expect(buildPlan(snap, [{ repo, id: 1 }], { allowReview: true }).items).toHaveLength(0)
    expect(f.calls.length).toBe(calls)
  })
})
