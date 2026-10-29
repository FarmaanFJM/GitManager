import { describe, expect, it } from 'vitest'
import { classifyRepo, parseName } from '../../src/core/storage/classify.js'
import { DEFAULT_POLICY } from '../../src/core/storage/config.js'
import { art, ctx, run } from './factory.js'

const classOf = (items: ReturnType<typeof art>[], over = {}) => {
  const out = classifyRepo(items.map(i => i.a), ctx(items, over))
  return Object.fromEntries(out.map(o => [o.id, o]))
}

describe('name parsing', () => {
  it('finds category and platform, and a family that ignores versions and commit ids', () => {
    expect(parseName('GitManager-windows-x64')).toMatchObject({ category: 'build', platform: 'windows' })
    expect(parseName('Setup-1.2.3-win.exe')).toMatchObject({ category: 'installer', platform: 'windows' })
    expect(parseName('coverage-report')).toMatchObject({ category: 'report' })
    expect(parseName('server-logs')).toMatchObject({ category: 'logs' })
    expect(parseName('mystery')).toMatchObject({ category: 'other', platform: 'unknown' })
    expect(parseName('app-1.2.3-linux.deb').family).toBe(parseName('app-1.2.4-linux.deb').family)
    expect(parseName('build-3f2a9c1d').family).toBe(parseName('build-77aa00bb').family)
  })
})

describe('classification', () => {
  it('keeps the newest two successful builds of identical names and offers older superseded ones', () => {
    const items = [1, 2, 3, 4].map(n => art('GitManager-windows-x64', n * 10))
    const c = classOf(items)
    expect(c[items[0].a.id].reasonCode).toBe('newest-successful')
    expect(c[items[1].a.id].reasonCode).toBe('newest-successful')
    expect(c[items[2].a.id]).toMatchObject({ class: 'delete-candidate', reasonCode: 'superseded-build' })
    expect(c[items[3].a.id].class).toBe('delete-candidate')
  })

  it('does not decide by age alone: an old artifact that is not superseded is kept or reviewed, never offered', () => {
    const only = art('GitManager-windows-x64', 400)
    expect(classOf([only])[only.a.id].class).toBe('keep')
    const unknown = [10, 400, 500].map(n => art('mystery-output', n))
    expect(classOf(unknown)[unknown[2].a.id]).toMatchObject({ class: 'review', reasonCode: 'category-unreviewed' })
  })

  it('treats builds for different operating systems as separate families', () => {
    const win = [1, 2, 3].map(n => art('app-windows-x64', n))
    const lin = [1, 2, 3].map(n => art('app-linux-x64', n))
    const c = classOf([...win, ...lin], { policy: { ...DEFAULT_POLICY, tempDays: 1 } })
    for (const set of [win, lin]) {
      expect(c[set[0].a.id].reasonCode).toBe('newest-successful')
      expect(c[set[1].a.id].reasonCode).toBe('newest-successful')
      expect(c[set[2].a.id].class).toBe('delete-candidate')
    }
  })

  it('keeps recent builds even when superseded', () => {
    const items = [1, 2, 3].map(n => art('app-windows-x64', n))
    expect(classOf(items)[items[2].a.id]).toMatchObject({ class: 'keep', reasonCode: 'recent' })
  })

  it('always keeps the last usable installer of a platform, even with a long list of older failures', () => {
    const failed = art('app-setup-win.exe', 3, {}, run({ conclusion: 'failure' }))
    const old = art('app-setup-win.exe', 90)
    const c = classOf([failed, old])
    expect(c[old.a.id].class).toBe('keep')
    expect(c[failed.a.id].class).not.toBe('delete-candidate')
    // no successful installer at all: the newest one of the platform is still retained
    const onlyFailed = art('app-setup-linux.deb', 90, {}, run({ conclusion: 'failure' }))
    expect(classOf([onlyFailed])[onlyFailed.a.id]).toMatchObject({ class: 'keep', reasonCode: 'last-installer' })
  })

  it('protects artifacts of a release and keeps those of an open pull request', () => {
    const tagRun = run({ headBranch: 'v1.4.0', event: 'push' })
    const rel = art('app-windows-x64', 200, {}, tagRun)
    const prRun = run({ headBranch: 'feature', pullNumbers: [7] })
    const pr = art('app-linux-x64', 200, {}, prRun)
    const c = classOf([rel, pr], { releases: [{ tag: 'v1.4.0', sha: null, draft: false, prerelease: false }], pulls: [{ number: 7, headRef: 'feature', headSha: 'x' }] })
    expect(c[rel.a.id]).toMatchObject({ class: 'protected', reasonCode: 'release' })
    expect(c[pr.a.id]).toMatchObject({ class: 'keep', reasonCode: 'open-pr' })
  })

  it('treats a run that is still going as keep', () => {
    const a = art('app-windows-x64', 30, {}, run({ status: 'in_progress', conclusion: null }))
    expect(classOf([a])[a.a.id].reasonCode).toBe('run-active')
  })

  it('does not offer failed or cancelled output until a newer successful build supersedes it', () => {
    const failed = art('app-windows-x64', 40, {}, run({ conclusion: 'failure' }))
    expect(classOf([failed])[failed.a.id]).toMatchObject({ class: 'review', reasonCode: 'failed-run' })
    const good = [1, 2].map(n => art('app-windows-x64', n))
    const cancelled = art('app-windows-x64', 40, {}, run({ conclusion: 'cancelled' }))
    expect(classOf([...good, cancelled])[cancelled.a.id]).toMatchObject({ class: 'delete-candidate', reasonCode: 'superseded-failed' })
  })

  it('protects artifacts cited by documentation, by name or by run', () => {
    const named = art('release-evidence-bundle-2026', 100)
    const byRun = art('some-build-windows', 100)
    const c = classOf([named, byRun], { docs: `see release-evidence-bundle-2026 and https://github.com/o/r/actions/runs/${byRun.run!.id}`, policy: { ...DEFAULT_POLICY, evidencePatterns: [] } })
    expect(c[named.a.id]).toMatchObject({ class: 'protected', reasonCode: 'doc-cited' })
    expect(c[byRun.a.id]).toMatchObject({ class: 'protected', reasonCode: 'doc-cited' })
  })

  it('protects qualification and audit evidence by artifact name or by workflow', () => {
    const a = art('qualification-report', 300)
    const b = art('output', 300, {}, run({ name: 'Security audit', path: '.github/workflows/audit.yml' }))
    const c = classOf([a, b])
    expect(c[a.a.id].reasonCode).toBe('evidence')
    expect(c[b.a.id].reasonCode).toBe('evidence')
  })

  it('reports expired artifacts as expired with nothing to reclaim', () => {
    const e = art('app-windows-x64', 100, { expired: true })
    expect(classOf([e])[e.a.id].class).toBe('expired')
  })

  it('sends artifacts with missing metadata to review', () => {
    const noRun = art('app-windows-x64', 100, {}, null)
    const noDate = art('app-windows-x64', 100, { createdAt: null })
    const c = classOf([noRun, noDate])
    expect(c[noRun.a.id]).toMatchObject({ class: 'review', reasonCode: 'metadata-missing' })
    expect(c[noDate.a.id]).toMatchObject({ class: 'review', reasonCode: 'metadata-missing' })
  })

  it('protects whole repositories and pinned artifacts, which beat every other rule', () => {
    const items = [1, 2, 3, 4].map(n => art('app-windows-x64', n * 20))
    expect(Object.values(classOf(items, { protectedRepo: true })).every(x => x.class === 'protected')).toBe(true)
    const c = classOf(items, { pinned: new Set([items[3].a.id]) })
    expect(c[items[3].a.id]).toMatchObject({ class: 'protected', reasonCode: 'pinned', pinned: true })
    expect(c[items[2].a.id].class).toBe('delete-candidate')
  })

  it('downgrades candidates to review when a lookup they depend on failed', () => {
    const items = [1, 2, 3].map(n => art('app-windows-x64', n * 20))
    const c = classOf(items, { context: { runs: true, pulls: false, releases: true, docs: true } })
    expect(c[items[2].a.id]).toMatchObject({ class: 'review', reasonCode: 'context-incomplete' })
    expect(c[items[2].a.id].reason).toContain('open pull requests')
    expect(c[items[0].a.id].class).toBe('keep') // keep decisions do not depend on the missing lookup
  })

  it('offers only categories the policy enables', () => {
    const items = [1, 2, 3].map(n => art('app-windows-x64', n * 20))
    const c = classOf(items, { policy: { ...DEFAULT_POLICY, deleteCategories: ['report'] } })
    expect(c[items[2].a.id]).toMatchObject({ class: 'review', reasonCode: 'category-disabled' })
  })

  it('applies the separate report age to CI reports', () => {
    const items = [1, 5, 20].map(n => art('coverage-report', n))
    const c = classOf(items)
    expect(c[items[2].a.id]).toMatchObject({ class: 'delete-candidate', reasonCode: 'obsolete-report' })
    const young = [1, 2, 10].map(n => art('coverage-report', n))
    expect(classOf(young)[young[2].a.id].reasonCode).toBe('recent')
  })

  it('never allows fewer than one kept build', () => {
    const items = [1, 2].map(n => art('app-windows-x64', n * 30))
    const c = classOf(items, { policy: { ...DEFAULT_POLICY, keepLatest: 1 } })
    expect(c[items[0].a.id].class).toBe('keep')
    expect(c[items[1].a.id].class).toBe('delete-candidate')
  })
})
