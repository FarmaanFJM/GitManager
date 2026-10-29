import { describe, expect, it } from 'vitest'
import { classifyRepo } from '../../src/core/storage/classify.js'
import { DEFAULT_POLICY } from '../../src/core/storage/config.js'
import { totalsOf } from '../../src/shared/storageTotals.js'
import { art, ctx, run } from './factory.js'

// Verified supersession decides ordinary CI build output, not age. These scenarios are repositories whose CI builds and uploads an
// installer after every merge and every pull request, like the real GitManager and Markdown Studio inventories.
const MAIN = { defaultBranch: 'main' }
const MB250 = 250 * 1024 * 1024
const classes = (items: ReturnType<typeof art>[], over = {}) => {
  const out = classifyRepo(items.map(i => i.a), ctx(items, { ...MAIN, ...over }))
  return Object.fromEntries(out.map(o => [o.id, o]))
}
const onMain = (name: string, ages: number[], o: Parameters<typeof run>[0] = {}) => ages.map(d => art(name, d, { sizeBytes: MB250 }, run({ headBranch: 'main', event: 'push', ...o })))
const onBranch = (name: string, branch: string, ages: number[], o: Parameters<typeof run>[0] = {}) => ages.map(d => art(name, d, { sizeBytes: MB250 }, run({ headBranch: branch, event: 'pull_request', ...o })))

describe('thirty installers in one day', () => {
  // 30 successful Windows installers of 250 MB, one every 40 minutes
  const day = Array.from({ length: 30 }, (_, i) => (i * 40) / 1440)
  const items = onMain('gitmanager-windows-x64', day)

  it('the newest two are kept and the other 28 are candidates immediately, with no waiting period', () => {
    const c = classes(items)
    expect(items.slice(0, 2).map(i => c[i.a.id].reasonCode)).toEqual(['newest-successful', 'newest-successful'])
    for (const i of items.slice(2)) expect(c[i.a.id], `${i.a.id}`).toMatchObject({ class: 'delete-candidate', reasonCode: 'superseded-build' })
    expect(totalsOf(Object.values(c)).reclaimableBytes).toBe(28 * MB250)
  })

  it('each candidate says exactly why: how many newer builds, which channel, and that no grace period applies', () => {
    const c = classes(items)
    const r = c[items[29].a.id].reason
    expect(r).toContain('29 newer successful builds')
    expect(r).toContain('default branch (main)')
    expect(r).toContain('no grace period')
    expect(c[items[29].a.id].newerBuilds).toBe(29)
  })

  it('an explicit grace period holds them back and names the date it ends; zero is always possible', () => {
    const held = classes(items, { policy: { ...DEFAULT_POLICY, graceDays: 3 } })
    expect(Object.values(held).filter(x => x.class === 'delete-candidate')).toHaveLength(0)
    expect(held[items[10].a.id]).toMatchObject({ class: 'keep', reasonCode: 'grace-period' })
    expect(held[items[10].a.id].graceUntil).toMatch(/^\d{4}-\d\d-\d\dT/)
    expect(Object.values(classes(items, { policy: { ...DEFAULT_POLICY, graceDays: 0 } })).filter(x => x.class === 'delete-candidate')).toHaveLength(28)
  })

  it('N is configurable', () => {
    const c = classes(items, { policy: { ...DEFAULT_POLICY, keepLatest: 5 } })
    expect(Object.values(c).filter(x => x.class === 'keep')).toHaveLength(5)
    expect(Object.values(c).filter(x => x.class === 'delete-candidate')).toHaveLength(25)
  })
})

describe('compatible families and channels', () => {
  it('experimental pull request builds never supersede the default branch installer', () => {
    const pr = onBranch('app-windows-x64', 'feature/x', [0, 0.1, 0.2, 0.3, 0.4], { pullNumbers: [7] })
    const main = onMain('app-windows-x64', [3, 4, 5, 6])
    const c = classes([...pr, ...main], { pulls: [{ number: 7, headRef: 'feature/x', headSha: 'x' }] })
    expect(c[main[0].a.id]).toMatchObject({ class: 'keep', reasonCode: 'newest-successful' })
    expect(c[main[1].a.id]).toMatchObject({ class: 'keep', reasonCode: 'newest-successful' })
    expect(c[main[2].a.id].class).toBe('delete-candidate')
    expect(c[main[2].a.id].reason).toContain('default branch (main)')
    expect(c[main[2].a.id].newerBuilds).toBe(2) // only default-branch builds count, not the five newer PR builds
    // the pull request keeps its own newest two; its older builds are superseded within the branch
    expect(c[pr[0].a.id].reasonCode).toBe('open-pr')
    expect(c[pr[1].a.id].reasonCode).toBe('open-pr')
    expect(c[pr[2].a.id].class).toBe('delete-candidate')
    expect(c[pr[2].a.id].reason).toContain('branch feature/x')
  })

  it('an older default-branch installer is never superseded by builds of another branch alone', () => {
    const main = onMain('app-windows-x64', [10])
    const other = onBranch('app-windows-x64', 'wip', [0, 1, 2, 3])
    const c = classes([...main, ...other])
    expect(c[main[0].a.id].class).toBe('keep') // the only default-branch build
    expect(c[other[2].a.id].class).toBe('delete-candidate')
  })

  it('architectures, platforms and workflows are separate families', () => {
    const x64 = onMain('app-windows-x64', [1, 2, 3, 4])
    const arm = onMain('app-windows-arm64', [10, 11])
    const lin = onMain('app-linux-x64', [12, 13])
    const other = [20, 21, 22].map(d => art('app-windows-x64', d, { sizeBytes: 1 }, run({ headBranch: 'main', name: 'Nightly', path: '.github/workflows/nightly.yml' })))
    const c = classes([...x64, ...arm, ...lin, ...other])
    expect(x64.slice(2).every(i => c[i.a.id].class === 'delete-candidate')).toBe(true)
    expect(arm.every(i => c[i.a.id].class === 'keep')).toBe(true) // two arm64 builds are not superseded by four x64 builds
    expect(lin.every(i => c[i.a.id].class === 'keep')).toBe(true)
    expect(other[0].a.id && c[other[0].a.id].class).toBe('keep')
    expect(c[other[1].a.id].class).toBe('keep')
    expect(c[other[2].a.id].class).toBe('delete-candidate') // superseded within the nightly workflow only
    expect(c[other[2].a.id].reason).toContain('2 newer')
  })

  it('a different purpose with the same name stem is a different family', () => {
    const inst = onMain('app-setup-windows', [1, 2, 3])
    const logs = onMain('app-windows-logs', [4, 5])
    const c = classes([...inst, ...logs])
    expect(logs.every(i => c[i.a.id].class === 'keep')).toBe(true)
  })

  it('the last usable installer of each platform and architecture is never offered', () => {
    const only = onBranch('app-setup-win-x64.exe', 'wip', [50])
    const c = classes(only)
    expect(c[only[0].a.id]).toMatchObject({ class: 'keep' })
    const withDefault = [...onMain('app-setup-win-x64.exe', [1]), ...onBranch('app-setup-win-x64.exe', 'wip', [0, 0.1, 0.2, 0.3])]
    const c2 = classes(withDefault)
    expect(c2[withDefault[0].a.id].class).toBe('keep')
  })
})

describe('names do not decide', () => {
  it('release and installer in a name protect nothing', () => {
    const items = onMain('Markdown-Studio-Release-Installer-Setup-0.4.0-win', [1, 2, 3, 4])
    const c = classes(items)
    expect(c[items[3].a.id]).toMatchObject({ class: 'delete-candidate', reasonCode: 'superseded-build' })
    expect(c[items[2].a.id].class).toBe('delete-candidate')
  })

  it('a release asset of a GitHub Release is not an artifact: having a release protects only artifacts built for it', () => {
    const items = onMain('app-windows-x64', [1, 2, 30, 40])
    const c = classes(items, { releases: [{ tag: 'v1.0.0', sha: 'deadbeef', draft: false, prerelease: false }], releaseTags: new Set(['v1.0.0']) })
    expect(c[items[2].a.id].class).toBe('delete-candidate')
  })
})

describe('genuine releases', () => {
  const tagRun = (tag: string) => run({ headBranch: tag, event: 'push' })

  it('the current release is protected; older tag builds are never offered automatically', () => {
    const cur = art('app-windows-x64', 40, {}, tagRun('v2.0.0'))
    const old = [90, 95, 99].map(d => art('app-windows-x64', d, {}, tagRun('v1.0.0')))
    const ci = onMain('app-windows-x64', [1, 2, 50, 60])
    const c = classes([cur, ...old, ...ci], { releases: [{ tag: 'v2.0.0', sha: null, draft: false, prerelease: false }], releaseTags: new Set(['v2.0.0', 'v1.0.0']) })
    expect(c[cur.a.id]).toMatchObject({ class: 'protected', reasonCode: 'release' })
    expect(c[old[2].a.id]).toMatchObject({ class: 'review', reasonCode: 'tag-build' })
    expect(c[ci[2].a.id].class).toBe('delete-candidate')
    expect(c[ci[3].a.id].class).toBe('delete-candidate')
  })

  it('a draft release protects its tag build by tag and by commit; a release event is a release build', () => {
    const draft = art('app-windows-x64', 60, {}, tagRun('v3.0.0-rc1'))
    const bySha = art('app-windows-x64', 61, {}, run({ headBranch: 'main', headSha: 'cafe1234' }))
    const viaEvent = [80, 81, 82].map(d => art('app-windows-x64', d, {}, run({ headBranch: 'main', event: 'release' })))
    const c = classes([draft, bySha, ...viaEvent, ...onMain('app-windows-x64', [1, 2])], { releases: [{ tag: 'v3.0.0-rc1', sha: 'cafe1234', draft: true, prerelease: false }] })
    expect(c[draft.a.id]).toMatchObject({ class: 'protected', reasonCode: 'release' })
    expect(c[bySha.a.id]).toMatchObject({ class: 'protected', reasonCode: 'release' })
    expect(c[viaEvent[2].a.id]).toMatchObject({ class: 'review', reasonCode: 'tag-build' })
  })
})

describe('what stays protected or retained', () => {
  it('qualification and audit evidence is never a candidate, even as old duplicates of a recurring name', () => {
    const q = [1, 2, 40, 50].map(d => art('release-qualification-report', d, {}, run({ headBranch: 'main' })))
    const a = [60, 70, 80].map(d => art('installer-windows', d, {}, run({ name: 'Security audit', path: '.github/workflows/audit.yml', headBranch: 'main' })))
    const c = classes([...q, ...a])
    for (const i of [...q, ...a]) expect(c[i.a.id].class, i.a.name).toBe('protected')
  })

  it('documentation run URLs, pins and protected repositories protect; a recurring name in documentation does not', () => {
    const items = onMain('app-windows-x64', [1, 2, 30, 40, 50])
    const c = classes(items, { docs: `see https://github.com/o/r/actions/runs/${items[3].run!.id} and the app-windows-x64 artifact`, pinned: new Set([items[4].a.id]) })
    expect(c[items[3].a.id]).toMatchObject({ class: 'protected', reasonCode: 'doc-cited' })
    expect(c[items[4].a.id]).toMatchObject({ class: 'protected', reasonCode: 'pinned' })
    expect(c[items[2].a.id].class).toBe('delete-candidate')
    expect(Object.values(classes(items, { protectedRepo: true })).every(x => x.class === 'protected')).toBe(true)
  })

  it('active workflow output is kept and is never a newer successful build', () => {
    const running = art('app-windows-x64', 0, {}, run({ status: 'in_progress', conclusion: null, headBranch: 'main' }))
    const items = onMain('app-windows-x64', [1, 2, 3])
    const c = classes([running, ...items])
    expect(c[running.a.id].reasonCode).toBe('run-active')
    // the running build does not count as a newer success, so the two real newest builds are still kept
    expect(c[items[0].a.id].class).toBe('keep')
    expect(c[items[1].a.id].class).toBe('keep')
    expect(c[items[2].a.id].class).toBe('delete-candidate')
  })
})

describe('failed builds', () => {
  it('failed and cancelled output is Review by default however many newer successes exist, and never counts as a successor', () => {
    const good = onMain('app-windows-x64', [3, 4, 5])
    const failed = [0, 1, 2].map(d => art('app-windows-x64', d, { sizeBytes: MB250 }, run({ headBranch: 'main', conclusion: d === 1 ? 'cancelled' : 'failure' })))
    const c = classes([...good, ...failed])
    for (const f of failed) expect(c[f.a.id]).toMatchObject({ class: 'review', reasonCode: 'failed-run' })
    // failed builds are not newer successes: the successful builds are still ranked among themselves
    expect(c[good[0].a.id].class).toBe('keep')
    expect(c[good[2].a.id].class).toBe('delete-candidate')
  })
})

describe('missing or incomplete metadata', () => {
  it('unknown run, date, branch or workflow means Review, never a candidate', () => {
    const items = onMain('app-windows-x64', [1, 2, 30, 40])
    const noRun = art('app-windows-x64', 90, {}, null)
    const noDate = art('app-windows-x64', 90, { createdAt: null }, run({ headBranch: 'main' }))
    const noBranch = art('app-windows-x64', 90, { headBranch: null }, run({ headBranch: null }))
    const noWorkflow = art('app-windows-x64', 90, {}, run({ headBranch: 'main', name: null, path: null }))
    const c = classes([...items, noRun, noDate, noBranch, noWorkflow])
    for (const x of [noRun, noDate, noBranch, noWorkflow]) expect(c[x.a.id], x.a.name).toMatchObject({ class: 'review', reasonCode: 'metadata-missing' })
    expect(c[items[3].a.id].class).toBe('delete-candidate') // the complete ones are unaffected
  })

  it('a failed contextual lookup turns every candidate into Review, and keep decisions stay', () => {
    const items = onMain('app-windows-x64', [1, 2, 30, 40])
    for (const lookup of ['runs', 'pulls', 'releases', 'docs'] as const) {
      const l = classes(items, { context: { runs: true, pulls: true, releases: true, docs: true, [lookup]: false } })
      expect(Object.values(l).filter(x => x.class === 'delete-candidate'), lookup).toHaveLength(0)
      expect(l[items[3].a.id]).toMatchObject({ class: 'review', reasonCode: 'context-incomplete' })
      expect(l[items[0].a.id].class).toBe('keep')
    }
  })

  it('artifacts of unrecognised purpose stay in Review and disabled categories are not offered', () => {
    const odd = onMain('mystery-output', [1, 2, 60])
    const inst = onMain('app-windows-x64', [1, 2, 3])
    const c = classes([...odd, ...inst], { policy: { ...DEFAULT_POLICY, deleteCategories: ['report'] } })
    expect(c[odd[2].a.id]).toMatchObject({ class: 'review', reasonCode: 'category-unreviewed' })
    expect(c[inst[2].a.id]).toMatchObject({ class: 'review', reasonCode: 'category-disabled' })
  })
})
