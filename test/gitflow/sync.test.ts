import { renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { SyncService } from '../../src/core/git/sync.js'
import type { StaleBranch, SyncPlan } from '../../src/shared/gitflow.js'
import type { Location } from '../../src/shared/types.js'
import { commit, git, isolateGitConfig, remoteFixture, tempDir } from '../helpers.js'

beforeAll(isolateGitConfig)
let cleanups: (() => void)[] = []
afterEach(() => { cleanups.forEach(c => c()); cleanups = [] })
const loc = (path: string): Location => ({ kind: 'native', path })
const S = new SyncService()
const fixture = () => { const f = remoteFixture(); cleanups.push(f.cleanup); return f }

/** A feature branch pushed from `other`, tracked locally, with `n` commits. Returns after local has the tracking branch. */
function feature(f: ReturnType<typeof fixture>, name: string, n = 1) {
  git(f.other, 'checkout', '-q', '-b', name, 'main')
  for (let i = 0; i < n; i++) commit(f.other, `${name.replace(/\W/g, '_')}-${i}.txt`, String(i), `${name} ${i}`)
  git(f.other, 'push', '-q', '-u', 'origin', name)
  git(f.other, 'checkout', '-q', 'main')
  git(f.local, 'fetch', '-q')
  git(f.local, 'branch', '--track', name, `origin/${name}`)
}
/** Merge via a PR (merge commit) and delete the remote branch. */
function mergeAndDelete(f: ReturnType<typeof fixture>, name: string) {
  git(f.other, 'merge', '-q', '--no-ff', '-m', `Merge ${name}`, name)
  git(f.other, 'push', '-q', 'origin', 'main')
  git(f.other, 'push', '-q', 'origin', '--delete', name)
}
/** Squash merge: same content lands as ONE new commit on main, the branch commits are not ancestors. */
function squashAndDelete(f: ReturnType<typeof fixture>, name: string) {
  git(f.other, 'merge', '-q', '--squash', name)
  git(f.other, 'commit', '-q', '-m', `Squash ${name}`)
  git(f.other, 'push', '-q', 'origin', 'main')
  git(f.other, 'push', '-q', 'origin', '--delete', name)
}
const plan = async (f: { local: string }, opts?: Parameters<SyncService['plan']>[1]) => {
  const r = await S.plan(loc(f.local), opts)
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`)
  return r.value
}
const find = (p: SyncPlan, n: string): StaleBranch => p.stale.find(b => b.name === n)!

describe('SyncService.plan', () => {
  it('reports Synced when nothing is stale and keeps local-only branches as information', async () => {
    const f = fixture()
    git(f.local, 'branch', 'scratch') // no upstream
    const p = await plan(f)
    expect(p.summary.text).toBe('Synced')
    expect(p.stale).toEqual([])
    expect(p.kept).toContain('scratch')
    expect(p.defaultBranch).toBe('main')
    expect(p.remote).toBe('origin')
  })

  it('prunes remote-tracking refs and reports them', async () => {
    const f = fixture()
    feature(f, 'feat/a')
    git(f.other, 'push', '-q', 'origin', '--delete', 'feat/a')
    const p = await plan(f)
    expect(p.pruned).toEqual(['origin/feat/a'])
    expect(git(f.local, 'branch', '-r')).not.toContain('feat/a')
  })

  it('classifies a branch merged by PR and deleted remotely as delete-safe', async () => {
    const f = fixture()
    feature(f, 'feat/merged', 2)
    mergeAndDelete(f, 'feat/merged')
    const p = await plan(f)
    expect(p.summary.text).toBe('1 stale branch found')
    const b = find(p, 'feat/merged')
    expect(b).toMatchObject({ kind: 'delete-safe', ahead: 0, upstream: 'origin/feat/merged' })
    expect(b.sha).toBe(git(f.local, 'rev-parse', 'feat/merged'))
  })

  it('classifies a squash-merged branch as needs-review with its unique commits', async () => {
    const f = fixture()
    feature(f, 'feat/squash', 3)
    squashAndDelete(f, 'feat/squash')
    const b = find(await plan(f), 'feat/squash')
    expect(b.kind).toBe('needs-review')
    expect(b.ahead).toBe(3)
    expect(b.uniqueCommits.map(c => c.subject)).toEqual(['feat/squash 2', 'feat/squash 1', 'feat/squash 0'])
  })

  it('resolves master as the default branch from the remote HEAD', async () => {
    const t = tempDir(); cleanups.push(t.cleanup)
    const remote = join(t.dir, 'r.git'), seed = join(t.dir, 'seed'), local = join(t.dir, 'local')
    git(t.dir, 'init', '-q', '--bare', '-b', 'master', remote)
    git(t.dir, 'init', '-q', '-b', 'master', seed)
    commit(seed, 'a.txt', 'a'); git(seed, 'remote', 'add', 'origin', remote); git(seed, 'push', '-q', 'origin', 'master')
    git(seed, 'checkout', '-q', '-b', 'topic'); commit(seed, 'b.txt', 'b'); git(seed, 'push', '-q', 'origin', 'topic')
    git(t.dir, 'clone', '-q', remote, local)
    git(local, 'branch', '--track', 'topic', 'origin/topic')
    git(seed, 'push', '-q', 'origin', '--delete', 'topic')
    const p = await plan({ local })
    expect(p.defaultBranch).toBe('master')
    expect(find(p, 'topic').kind).toBe('needs-review')
  })

  it('protects a branch checked out in another worktree and says where', async () => {
    const f = fixture()
    feature(f, 'feat/wt'); mergeAndDelete(f, 'feat/wt')
    const wtPath = join(f.dir, 'wt dir')
    git(f.local, 'worktree', 'add', '-q', wtPath, 'feat/wt')
    const b = find(await plan(f), 'feat/wt')
    expect(b.kind).toBe('protected')
    expect(b.worktree?.path).toContain('wt dir')
    expect(b.worktree?.current).toBe(false)
    expect(b.wouldBe).toBe('delete-safe')
  })

  it('protects configured names such as release/*', async () => {
    const f = fixture()
    feature(f, 'release/1.0'); mergeAndDelete(f, 'release/1.0')
    expect(find(await plan(f), 'release/1.0').kind).toBe('protected')
  })

  it('offers a switch when the current branch is stale and the tree is clean', async () => {
    const f = fixture()
    feature(f, 'feat/cur'); mergeAndDelete(f, 'feat/cur')
    git(f.local, 'switch', '-q', 'feat/cur')
    const p = await plan(f)
    expect(find(p, 'feat/cur')).toMatchObject({ kind: 'protected', wouldBe: 'delete-safe' })
    expect(p.switchTo).toEqual({ branch: 'main', safe: true, tracksRemote: false })
  })

  it('never offers a safe switch with a dirty tree', async () => {
    const f = fixture()
    feature(f, 'feat/dirty'); mergeAndDelete(f, 'feat/dirty')
    git(f.local, 'switch', '-q', 'feat/dirty')
    writeFileSync(join(f.local, 'wip.txt'), 'x')
    const p = await plan(f)
    expect(p.switchTo?.safe).toBe(false)
    expect(p.switchTo?.reason).toMatch(/uncommitted/)
    const r = await S.execute(loc(f.local), p, { branches: ['feat/dirty'], switchToDefault: true })
    expect(r.ok).toBe(false)
    expect(git(f.local, 'branch', '--show-current')).toBe('feat/dirty')
  })

  it('handles a detached HEAD', async () => {
    const f = fixture()
    feature(f, 'feat/d'); mergeAndDelete(f, 'feat/d')
    git(f.local, 'checkout', '-q', '--detach')
    const p = await plan(f)
    expect(p.detached).toBe(true)
    expect(p.current).toBeNull()
    expect(p.switchTo).toBeUndefined()
    expect(find(p, 'feat/d').kind).toBe('delete-safe')
  })

  it('returns precise codes: no remote, empty repository, ambiguous remote', async () => {
    const t = tempDir(); cleanups.push(t.cleanup)
    const empty = join(t.dir, 'empty'); git(t.dir, 'init', '-q', empty)
    expect(await S.plan(loc(empty))).toMatchObject({ ok: false, error: { code: 'EMPTY_REPO' } })
    const noRemote = join(t.dir, 'nr'); git(t.dir, 'init', '-q', noRemote); commit(noRemote, 'a', 'a')
    expect(await S.plan(loc(noRemote))).toMatchObject({ ok: false, error: { code: 'NO_REMOTE' } })
    git(noRemote, 'remote', 'add', 'one', join(t.dir, 'x1')); git(noRemote, 'remote', 'add', 'two', join(t.dir, 'x2'))
    expect(await S.plan(loc(noRemote))).toMatchObject({ ok: false, error: { code: 'AMBIGUOUS_REMOTE' } })
  })

  it('keeps everything when the remote is unreachable', async () => {
    const f = fixture()
    feature(f, 'feat/x'); mergeAndDelete(f, 'feat/x')
    renameSync(f.remote, f.remote + '-moved')
    const before = git(f.local, 'for-each-ref')
    const r = await S.plan(loc(f.local))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toMatch(/Nothing was changed/)
    expect(git(f.local, 'for-each-ref')).toBe(before)
  })
})

describe('SyncService.execute', () => {
  it('deletes a delete-safe branch even when the local main is behind, and records the sha', async () => {
    const f = fixture()
    feature(f, 'feat/merged'); mergeAndDelete(f, 'feat/merged')
    const p = await plan(f)
    const sha = git(f.local, 'rev-parse', 'feat/merged')
    const r = await S.execute(loc(f.local), p, { branches: ['feat/merged'] })
    expect(r.ok && r.value.deleted).toEqual([{ name: 'feat/merged', sha, forced: false, recoverWith: `git branch feat/merged ${sha}` }])
    expect(git(f.local, 'branch', '--list', 'feat/merged')).toBe('')
    // the recovery command really restores it
    git(f.local, 'branch', 'feat/merged', sha)
    expect(git(f.local, 'rev-parse', 'feat/merged')).toBe(sha)
  })

  it('refuses a needs-review branch unless forced, then records the sha', async () => {
    const f = fixture()
    feature(f, 'feat/sq', 2); squashAndDelete(f, 'feat/sq')
    const p = await plan(f)
    const sha = git(f.local, 'rev-parse', 'feat/sq')
    const r1 = await S.execute(loc(f.local), p, { branches: ['feat/sq'] })
    expect(r1.ok && r1.value.failed[0]).toMatchObject({ name: 'feat/sq', code: 'NEEDS_REVIEW' })
    expect(git(f.local, 'branch', '--list', 'feat/sq')).not.toBe('')
    const r2 = await S.execute(loc(f.local), p, { branches: ['feat/sq'], forceBranches: ['feat/sq'] })
    expect(r2.ok && r2.value.deleted).toEqual([{ name: 'feat/sq', sha, forced: true, recoverWith: `git branch feat/sq ${sha}` }])
    expect(git(f.local, 'branch', '--list', 'feat/sq')).toBe('')
  })

  it('refuses when the tip changed between plan and execute', async () => {
    const f = fixture()
    feature(f, 'feat/moved'); mergeAndDelete(f, 'feat/moved')
    const p = await plan(f)
    git(f.local, 'switch', '-q', 'feat/moved'); commit(f.local, 'late.txt', 'late'); git(f.local, 'switch', '-q', 'main')
    const r = await S.execute(loc(f.local), p, { branches: ['feat/moved'] })
    expect(r.ok && r.value.failed[0].code).toBe('TIP_CHANGED')
    expect(r.ok && r.value.deleted).toEqual([])
    expect(git(f.local, 'branch', '--list', 'feat/moved')).not.toBe('')
  })

  it('refuses a branch that became checked out after the plan, and keeps partial results', async () => {
    const f = fixture()
    feature(f, 'feat/one'); feature(f, 'feat/two')
    mergeAndDelete(f, 'feat/one'); mergeAndDelete(f, 'feat/two')
    const p = await plan(f)
    git(f.local, 'worktree', 'add', '-q', join(f.dir, 'wt'), 'feat/two')
    const r = await S.execute(loc(f.local), p, { branches: ['feat/one', 'feat/two'] })
    expect(r.ok && r.value.deleted.map(d => d.name)).toEqual(['feat/one'])
    expect(r.ok && r.value.failed).toMatchObject([{ name: 'feat/two', code: 'CHECKED_OUT' }])
  })

  it('refuses names that begin with a dash or are not in the plan', async () => {
    const f = fixture()
    feature(f, 'feat/a'); mergeAndDelete(f, 'feat/a')
    const p = await plan(f)
    const r = await S.execute(loc(f.local), p, { branches: ['--force', '-D', 'main', 'nope'] })
    expect(r.ok && r.value.failed.map(x => x.code)).toEqual(['BAD_NAME', 'BAD_NAME', 'NOT_IN_PLAN', 'NOT_IN_PLAN'])
    expect(git(f.local, 'branch', '--list', 'main')).not.toBe('')
  })

  it('switches to the default branch first, then deletes the former current branch', async () => {
    const f = fixture()
    feature(f, 'feat/cur'); mergeAndDelete(f, 'feat/cur')
    git(f.local, 'switch', '-q', 'feat/cur')
    const p = await plan(f)
    const r = await S.execute(loc(f.local), p, { branches: ['feat/cur'], switchToDefault: true })
    expect(r.ok && r.value.switched).toEqual({ from: 'feat/cur', to: 'main' })
    expect(r.ok && r.value.deleted.map(d => d.name)).toEqual(['feat/cur'])
    expect(git(f.local, 'branch', '--show-current')).toBe('main')
    // Sync never pulls: local main stays where it was
    expect(git(f.local, 'rev-parse', 'main')).not.toBe(git(f.local, 'rev-parse', 'origin/main'))
  })

  it('never deletes the default branch or the checked-out branch without a switch', async () => {
    const f = fixture()
    feature(f, 'feat/cur'); mergeAndDelete(f, 'feat/cur')
    git(f.local, 'switch', '-q', 'feat/cur')
    const p = await plan(f)
    const r = await S.execute(loc(f.local), p, { branches: ['feat/cur'] })
    expect(r.ok && r.value.failed[0].code).toBe('CHECKED_OUT')
  })
})
