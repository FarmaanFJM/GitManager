import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { BranchCleaner } from '../../src/core/git/branchClean.js'
import { RecoveryLog } from '../../src/core/git/recovery.js'
import { defaultGitRun } from '../../src/core/git/ops.js'
import type { Location } from '../../src/shared/types.js'
import { commit, git, isolateGitConfig, remoteFixture, tempDir } from '../helpers.js'

beforeAll(isolateGitConfig)
const loc = (path: string): Location => ({ kind: 'native', path })
let cleanups: (() => void)[] = []
afterEach(() => { cleanups.forEach(c => c()); cleanups = [] })

/** origin/main plus local branches of every kind. */
function world() {
  const f = remoteFixture(); cleanups.push(f.cleanup)
  const L = f.local
  const branch = (name: string, file: string, push: boolean) => {
    git(L, 'checkout', '-q', '-b', name, 'main'); commit(L, file, `${name}\n`, `work on ${name}`)
    if (push) git(L, 'push', '-q', '-u', 'origin', name)
    git(L, 'checkout', '-q', 'main')
  }
  branch('merged-ff', 'm1.txt', true)
  git(L, 'merge', '-q', '--ff-only', 'merged-ff'); git(L, 'push', '-q', 'origin', 'main')
  branch('pushed-open', 'p1.txt', true)
  branch('local-only', 'l1.txt', false)
  branch('gone-unique', 'g1.txt', true); git(L, 'push', '-q', 'origin', '--delete', 'gone-unique')
  branch('gone-merged', 'g2.txt', true)
  git(L, 'merge', '-q', '--no-ff', '-m', 'merge g2', 'gone-merged'); git(L, 'push', '-q', 'origin', 'main'); git(L, 'push', '-q', 'origin', '--delete', 'gone-merged')
  git(L, 'branch', 'develop', 'main')
  git(L, 'fetch', '-q', '--prune')
  const cleaner = new BranchCleaner(defaultGitRun)
  return { ...f, cleaner, L }
}
const info = async (c: BranchCleaner, d: string, name: string) => {
  const r = await c.analyze('k', loc(d))
  if (!r.ok) throw new Error(r.error.message)
  return r.value.branches.find(b => b.name === name)!
}

describe('analysis', () => {
  it('classifies merged, pushed, unmerged, gone, protected and current branches', async () => {
    const w = world()
    const r = await w.cleaner.analyze('k', loc(w.L))
    expect(r.ok).toBe(true)
    const a = r.ok ? r.value : null!
    expect(a.defaultBranch).toBe('main')
    const row = (n: string) => a.branches.find(b => b.name === n)!
    expect(row('merged-ff')).toMatchObject({ category: 'merged', tier: 'safe' })
    expect(row('gone-merged')).toMatchObject({ category: 'merged', tier: 'safe', upstreamState: 'gone' })
    expect(row('pushed-open')).toMatchObject({ category: 'pushed', tier: 'safe', onlyHereCount: 0, uniqueCount: 1 })
    expect(row('pushed-open').onRemotes).toContain('origin/pushed-open')
    expect(row('local-only')).toMatchObject({ category: 'unique', tier: 'force', onlyHereCount: 1, upstreamState: 'none' })
    expect(row('gone-unique')).toMatchObject({ category: 'unique', tier: 'force', upstreamState: 'gone' })
    expect(row('gone-unique').note).toMatch(/upstream no longer exists/)
    expect(row('local-only').blocker?.blocker?.actions.map(x => x.id)).toEqual(['inspect-commits', 'force-delete'])
    expect(row('main')).toMatchObject({ category: 'current', tier: 'blocked', current: true })
    expect(row('main').blocker?.code).toBe('CURRENT_BRANCH')
  })

  it('the default branch and protected names are blocked; a checked-out default offers a switch', async () => {
    const w = world()
    git(w.L, 'checkout', '-q', 'pushed-open')
    const main = await info(w.cleaner, w.L, 'main')
    expect(main).toMatchObject({ category: 'protected', tier: 'blocked' })
    expect(main.blocker?.code).toBe('DEFAULT_BRANCH')
    expect(await info(w.cleaner, w.L, 'develop')).toMatchObject({ tier: 'blocked', blocker: { code: 'PROTECTED' } })
    const cur = await info(w.cleaner, w.L, 'pushed-open')
    expect(cur.blocker).toMatchObject({ code: 'CURRENT_BRANCH', blocker: { actions: [{ id: 'switch-default', target: 'main' }] } })
  })

  it('a branch checked out in another worktree is blocked with the worktree to open', async () => {
    const w = world()
    const wt = join(w.dir, 'wt')
    git(w.L, 'worktree', 'add', '-q', wt, 'pushed-open')
    const b = await info(w.cleaner, w.L, 'pushed-open')
    expect(b).toMatchObject({ tier: 'blocked', category: 'worktree' })
    expect(b.blocker?.blocker?.actions[0]).toMatchObject({ id: 'open-worktree', target: expect.stringContaining('wt') })
  })

  it('uncommitted changes do not block deleting an unrelated branch', async () => {
    const w = world()
    writeFileSync(join(w.L, 'README.md'), 'dirty\n'); writeFileSync(join(w.L, 'untracked.txt'), 'u')
    const r = await w.cleaner.delete('k', 'r1', loc(w.L), [{ name: 'merged-ff', sha: git(w.L, 'rev-parse', 'merged-ff'), force: false }])
    expect(r.ok && r.value.deleted.map(d => d.name)).toEqual(['merged-ff'])
    expect(readFileSync(join(w.L, 'README.md'), 'utf8')).toBe('dirty\n')
  })

  it('the optional sync prunes remote-tracking refs first', async () => {
    const w = world()
    git(w.other, 'push', '-q', 'origin', 'main:refs/heads/temp-x'); git(w.L, 'fetch', '-q')
    git(w.other, 'push', '-q', 'origin', '--delete', 'temp-x')
    expect(git(w.L, 'branch', '-r')).toContain('origin/temp-x')
    const r = await w.cleaner.analyze('k', loc(w.L), { sync: true })
    expect(r.ok && r.value.sync).toMatchObject({ ran: true, pruned: ['origin/temp-x'] })
    expect(git(w.L, 'branch', '-r')).not.toContain('origin/temp-x')
  })
})

describe('deletion', () => {
  const sha = (d: string, b: string) => git(d, 'rev-parse', b)

  it('deletes safe branches with -d semantics and records how to recreate each one', async () => {
    const w = world()
    const items = ['merged-ff', 'gone-merged', 'pushed-open'].map(n => ({ name: n, sha: sha(w.L, n), force: false }))
    const remotes = git(w.L, 'branch', '-r')
    const r = await w.cleaner.delete('k', 'r1', loc(w.L), items)
    expect(r.ok && r.value.deleted.map(d => d.name)).toEqual(['merged-ff', 'gone-merged', 'pushed-open'])
    expect(r.ok && r.value.deleted.every(d => !d.forced)).toBe(true)
    expect(git(w.L, 'branch', '--list')).not.toMatch(/merged-ff|gone-merged|pushed-open/)
    expect(git(w.L, 'branch', '-r')).toBe(remotes) // remote branches are never deleted
    const rec = w.cleaner.recovery.list('r1')
    expect(rec.map(x => x.recoverWith)).toContain(`git branch pushed-open ${items[2].sha}`)
    // the recorded command really restores it
    git(w.L, ...(`branch pushed-open ${items[2].sha}`.split(' ')))
    expect(sha(w.L, 'pushed-open')).toBe(items[2].sha)
  })

  it('a branch with unique commits needs force by name and reports the risk', async () => {
    const w = world()
    const s = sha(w.L, 'local-only')
    const refused = await w.cleaner.delete('k', 'r1', loc(w.L), [{ name: 'local-only', sha: s, force: false }])
    expect(refused.ok && refused.value.skipped[0]).toMatchObject({ name: 'local-only', error: { code: 'UNIQUE_COMMITS' } })
    expect(git(w.L, 'branch', '--list', 'local-only')).toContain('local-only')
    const forced = await w.cleaner.delete('k', 'r1', loc(w.L), [{ name: 'local-only', sha: s, force: true }])
    expect(forced.ok && forced.value.deleted[0]).toMatchObject({ name: 'local-only', forced: true, method: 'D', onRemotes: [] })
    expect(git(w.L, 'branch', '--list', 'local-only')).toBe('')
    expect(git(w.L, 'cat-file', '-t', s)).toBe('commit') // still recoverable
    const records = await w.cleaner.records(loc(w.L), 'r1')
    expect(records[0]).toMatchObject({ name: 'local-only', sha: s, forced: true, available: true })
    const back = await w.cleaner.restore(loc(w.L), 'r1', records[0].id)
    expect(back).toMatchObject({ ok: true })
    expect(sha(w.L, 'local-only')).toBe(s)
    expect(await w.cleaner.restore(loc(w.L), 'r1', records[0].id)).toMatchObject({ ok: false, error: { code: 'NO_RECORD' } })
  })

  it('blocked branches are skipped with their reason; the others are still deleted (partial results)', async () => {
    const w = world()
    git(w.L, 'checkout', '-q', 'pushed-open')
    const wt = join(w.dir, 'wt2'); git(w.L, 'worktree', 'add', '-q', wt, 'gone-merged')
    const items = ['pushed-open', 'main', 'gone-merged', 'develop', 'merged-ff', 'no-such'].map(n => ({ name: n, sha: n === 'no-such' ? 'a'.repeat(40) : sha(w.L, n), force: false }))
    const r = await w.cleaner.delete('k', 'r1', loc(w.L), items)
    const v = r.ok ? r.value : null!
    expect(v.deleted.map(d => d.name)).toEqual(['merged-ff'])
    expect(Object.fromEntries(v.skipped.map(s => [s.name, s.error.code]))).toEqual({ 'pushed-open': 'CURRENT_BRANCH', main: 'DEFAULT_BRANCH', 'gone-merged': 'WORKTREE_CHECKED_OUT', develop: 'PROTECTED', 'no-such': 'GONE' })
  })

  it('rechecks right before deleting: a branch that moved is skipped', async () => {
    const w = world()
    const old = sha(w.L, 'pushed-open')
    git(w.L, 'checkout', '-q', 'pushed-open'); commit(w.L, 'late.txt', 'late', 'late commit'); git(w.L, 'checkout', '-q', 'main')
    const r = await w.cleaner.delete('k', 'r1', loc(w.L), [{ name: 'pushed-open', sha: old, force: false }])
    expect(r.ok && r.value.skipped[0].error.code).toBe('TIP_CHANGED')
    expect(git(w.L, 'branch', '--list', 'pushed-open')).toContain('pushed-open')
  })

  it('a failure on one branch is reported and does not stop the rest', async () => {
    const w = world()
    // a git runner that fails the deletion of one specific branch
    const run: typeof defaultGitRun = (l, args, t, input) => (args[0] === 'branch' && args.includes('merged-ff') ? Promise.resolve({ code: 1, stdout: '', stderr: 'error: Permission denied: cannot lock ref', timedOut: false }) : defaultGitRun(l, args, t, input))
    const cleaner = new BranchCleaner(run)
    const r = await cleaner.delete('k', 'r1', loc(w.L), ['merged-ff', 'gone-merged'].map(n => ({ name: n, sha: sha(w.L, n), force: false })))
    expect(r.ok && r.value.failed.map(f => [f.name, f.error.code])).toEqual([['merged-ff', 'PERMISSION']])
    expect(r.ok && r.value.deleted.map(d => d.name)).toEqual(['gone-merged'])
    expect(cleaner.recovery.list('r1').map(x => x.name)).toEqual(['gone-merged']) // no record for a deletion that did not happen
  })

  it('rejects names that could be read as options and duplicates', async () => {
    const w = world()
    const r = await w.cleaner.delete('k', 'r1', loc(w.L), [{ name: '--all', sha: 'a'.repeat(40), force: true }, { name: 'merged-ff', sha: sha(w.L, 'merged-ff'), force: false }, { name: 'merged-ff', sha: sha(w.L, 'merged-ff'), force: false }])
    expect(r.ok && r.value.skipped[0].error.code).toBe('BAD_NAME')
    expect(r.ok && r.value.deleted).toHaveLength(1)
  })

  it('the recovery log persists between runs', () => {
    const t = tempDir('gm-rec-'); cleanups.push(t.cleanup); const file = join(t.dir, 'rec.json')
    const a = new RecoveryLog(file); a.add({ repoId: 'r', name: 'x', sha: 'b'.repeat(40), forced: false, recoverWith: `git branch x ${'b'.repeat(40)}` })
    expect(new RecoveryLog(file).list('r')).toHaveLength(1)
    writeFileSync(file, '{ not json'); expect(new RecoveryLog(file).list('r')).toEqual([])
  })
})
