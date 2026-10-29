import { describe, expect, it } from 'vitest'
import { classifyRepo } from '../../src/core/storage/classify.js'
import { DEFAULT_POLICY } from '../../src/core/storage/config.js'
import { totalsOf } from '../../src/shared/storageTotals.js'
import { art, ctx, run } from './factory.js'

// A repository whose CI builds and uploads an installer after every merge and every pull request, like the real
// GitManager (gitmanager-windows-x64) and Markdown Studio (markdown-studio-macos-dmg) inventories.
const MAIN = { defaultBranch: 'main' }
const classes = (items: ReturnType<typeof art>[], over = {}) => {
  const out = classifyRepo(items.map(i => i.a), ctx(items, { ...MAIN, ...over }))
  return Object.fromEntries(out.map(o => [o.id, o]))
}
const merges = (name: string, ages: number[], o: Parameters<typeof run>[0] = {}) => ages.map(d => art(name, d, {}, run({ headBranch: 'main', event: 'push', ...o })))

describe('recurring CI installers', () => {
  it('older post-merge installers become candidates once the retention age has passed; the newest two stay', () => {
    const items = merges('markdown-studio-macos-dmg', [1, 2, 9, 10, 11, 12, 13])
    const c = classes(items)
    expect(c[items[0].a.id].class).toBe('keep')
    expect(c[items[1].a.id].class).toBe('keep')
    for (const i of items.slice(2)) expect(c[i.a.id], `${i.a.id}`).toMatchObject({ class: 'delete-candidate', reasonCode: 'superseded-build' })
    expect(totalsOf(Object.values(c)).reclaimableBytes).toBe(5 * 10 * 1024 * 1024)
  })

  it('a name that merely resembles a release is still CI output', () => {
    const items = merges('Markdown-Studio-Release-Setup-0.4.0-win', [1, 2, 20, 30])
    const c = classes(items)
    expect(c[items[3].a.id]).toMatchObject({ class: 'delete-candidate', reasonCode: 'superseded-build' })
    expect(c[items[2].a.id].class).toBe('delete-candidate')
  })

  it('nothing is offered while every copy is younger than the retention age, however many there are', () => {
    const items = merges('gitmanager-windows-x64', [0, 0, 0, 1, 1, 1, 2, 3, 4, 5, 6])
    const c = classes(items)
    expect(Object.values(c).filter(x => x.class === 'delete-candidate')).toHaveLength(0)
    expect(Object.values(c).filter(x => x.reasonCode === 'recent').length).toBe(items.length - 2)
  })

  it('a shorter configured age makes recent superseded builds eligible, and only those', () => {
    const items = merges('gitmanager-windows-x64', [0, 0, 1, 2, 3])
    const c = classes(items, { policy: { ...DEFAULT_POLICY, tempDays: 1 } })
    expect(items.map(i => c[i.a.id].class)).toEqual(['keep', 'keep', 'delete-candidate', 'delete-candidate', 'delete-candidate'])
  })

  it('keeps the newest builds on the default branch even when newer pull request builds fill the global newest two', () => {
    const pr = [0, 0, 1, 1].map(d => art('app-windows-x64', d, {}, run({ headBranch: 'feature/x', event: 'pull_request' })))
    const main = [3, 4, 30, 40].map(d => art('app-windows-x64', d, {}, run({ headBranch: 'main', event: 'push' })))
    const c = classes([...pr, ...main])
    expect(c[main[0].a.id]).toMatchObject({ class: 'keep', reasonCode: 'newest-default-branch' })
    expect(c[main[1].a.id]).toMatchObject({ class: 'keep', reasonCode: 'newest-default-branch' })
    expect(c[main[2].a.id].class).toBe('delete-candidate')
    expect(c[main[3].a.id].class).toBe('delete-candidate')
  })
})

describe('genuine releases', () => {
  const tagRun = (tag: string) => run({ headBranch: tag, event: 'push' })

  it('the current release is protected; older tag builds are never offered automatically', () => {
    const cur = art('app-windows-x64', 40, {}, tagRun('v2.0.0'))
    const old = art('app-windows-x64', 90, {}, tagRun('v1.0.0'))
    const ci = merges('app-windows-x64', [1, 2, 50, 60])
    const c = classes([cur, old, ...ci], { releases: [{ tag: 'v2.0.0', sha: null, draft: false, prerelease: false }], releaseTags: new Set(['v2.0.0', 'v1.0.0']) })
    expect(c[cur.a.id]).toMatchObject({ class: 'protected', reasonCode: 'release' })
    expect(c[old.a.id]).toMatchObject({ class: 'review', reasonCode: 'tag-build' })
    expect(c[ci[2].a.id].class).toBe('delete-candidate')
    expect(c[ci[3].a.id].class).toBe('delete-candidate')
  })

  it('a draft release protects its tag build; a release event is a release build', () => {
    const draft = art('app-windows-x64', 60, {}, tagRun('v3.0.0-rc1'))
    const viaEvent = art('app-windows-x64', 80, {}, run({ headBranch: 'main', event: 'release' }))
    const c = classes([draft, viaEvent, ...merges('app-windows-x64', [1, 2])], { releases: [{ tag: 'v3.0.0-rc1', sha: null, draft: true, prerelease: false }] })
    expect(c[draft.a.id]).toMatchObject({ class: 'protected', reasonCode: 'release' })
    expect(c[viaEvent.a.id]).toMatchObject({ class: 'review', reasonCode: 'tag-build' })
  })

  it('release assets are not artifacts: having releases protects only artifacts built for them', () => {
    const items = merges('app-windows-x64', [1, 2, 30, 40])
    const c = classes(items, { releases: [{ tag: 'v1.0.0', sha: 'deadbeef', draft: false, prerelease: false }], releaseTags: new Set(['v1.0.0']) })
    expect(c[items[2].a.id].class).toBe('delete-candidate')
  })
})

describe('what stays protected', () => {
  it('qualification and audit evidence is never a candidate, even as an old duplicate of a recurring name', () => {
    const q = [1, 2, 40, 50].map(d => art('release-qualification-report', d, {}, run({ headBranch: 'main' })))
    const a = [60, 70, 80].map(d => art('installer-windows', d, {}, run({ name: 'Security audit', path: '.github/workflows/audit.yml', headBranch: 'main' })))
    const c = classes([...q, ...a])
    for (const i of [...q, ...a]) expect(c[i.a.id].class, i.a.name).toBe('protected')
  })

  it('pinned artifacts and protected repositories are never candidates', () => {
    const items = merges('app-windows-x64', [1, 2, 30, 40])
    expect(classes(items, { pinned: new Set([items[3].a.id]) })[items[3].a.id]).toMatchObject({ class: 'protected', reasonCode: 'pinned' })
    expect(Object.values(classes(items, { protectedRepo: true })).every(x => x.class === 'protected')).toBe(true)
  })
})

describe('open pull requests', () => {
  const pr = (d: number, ok = true) => art('app-windows-x64', d, {}, run({ headBranch: 'feature/x', event: 'pull_request', pullNumbers: [7], conclusion: ok ? 'success' : 'failure' }))
  const open = [{ number: 7, headRef: 'feature/x', headSha: 'x' }]

  it('keeps the newest builds of the PR branch, but not every superseded build it ever produced', () => {
    const builds = [0, 1, 20, 21, 22].map(d => pr(d))
    const main = merges('app-windows-x64', [40, 41])
    const c = classes([...builds, ...main], { pulls: open })
    expect(c[builds[0].a.id].class).toBe('keep')
    expect(c[builds[1].a.id].class).toBe('keep')
    for (const b of builds.slice(2)) expect(c[b.a.id], `${b.a.id}`).toMatchObject({ class: 'delete-candidate' })
  })

  it('keeps a failed PR build while the branch has not been superseded, but not once newer successes exist and the age has passed', () => {
    const failedNew = pr(0, false)
    const c1 = classes([failedNew], { pulls: open })
    expect(c1[failedNew.a.id]).toMatchObject({ class: 'keep', reasonCode: 'open-pr' })
    const items = [pr(0), pr(1), pr(30, false)]
    const c2 = classes(items, { pulls: open })
    expect(c2[items[2].a.id]).toMatchObject({ class: 'delete-candidate', reasonCode: 'superseded-failed' })
  })

  it('a PR that is not open protects nothing', () => {
    const items = [0, 1, 20, 21].map(d => pr(d))
    const c = classes(items, { pulls: [] })
    expect(c[items[3].a.id].class).toBe('delete-candidate')
  })
})

describe('incomplete information stays conservative', () => {
  it('missing run metadata, missing dates and failed lookups never produce candidates', () => {
    const items = merges('app-windows-x64', [1, 2, 30, 40])
    const noRun = art('app-windows-x64', 90, {}, null)
    const noDate = art('app-windows-x64', 90, { createdAt: null })
    const c = classes([...items, noRun, noDate])
    expect(c[noRun.a.id]).toMatchObject({ class: 'review', reasonCode: 'metadata-missing' })
    expect(c[noDate.a.id]).toMatchObject({ class: 'review', reasonCode: 'metadata-missing' })
    for (const lookup of ['runs', 'pulls', 'releases', 'docs'] as const) {
      const ctxLimited = { context: { runs: true, pulls: true, releases: true, docs: true, [lookup]: false } }
      const l = classes(items, ctxLimited)
      expect(Object.values(l).filter(x => x.class === 'delete-candidate'), lookup).toHaveLength(0)
      expect(l[items[3].a.id]).toMatchObject({ class: 'review', reasonCode: 'context-incomplete' })
    }
  })

  it('unfinished runs are kept, and artifacts of unrecognised purpose stay in Review', () => {
    const active = art('app-windows-x64', 30, {}, run({ status: 'in_progress', conclusion: null }))
    const odd = [1, 2, 60].map(d => art('mystery-output', d, {}, run({ headBranch: 'main' })))
    const c = classes([active, ...merges('app-windows-x64', [1, 2]), ...odd])
    expect(c[active.a.id].reasonCode).toBe('run-active')
    expect(c[odd[2].a.id]).toMatchObject({ class: 'review', reasonCode: 'category-unreviewed' })
  })
})
