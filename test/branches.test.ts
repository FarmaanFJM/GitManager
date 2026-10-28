import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { BranchInspector, parseNameStatus, parseSymref, parseTrack } from '../src/core/git/branches.js'
import type { BranchRow, Location } from '../src/shared/types.js'
import { commit, git, isolateGitConfig, tempDir } from './helpers.js'

beforeAll(isolateGitConfig)
let cleanups: (() => void)[] = []
afterEach(() => { cleanups.forEach(c => c()); cleanups = [] })
const loc = (path: string): Location => ({ kind: 'native', path })
const commits = (repo: string, prefix: string, n: number) => { for (let i = 0; i < n; i++) commit(repo, `${prefix.replace(/\W/g, '_')}-${i}.txt`, `${i}`, `${prefix} ${i}`) }

/**
 * Remote whose default branch is `dev` (not main):
 *   feature/chessfold  7 ahead, 0 behind (local copy has 1 more, unpushed commit)
 *   fix/login          0 ahead, 5 behind
 *   experiment         2 ahead, 3 behind (diverged)
 *   pages              unrelated history (orphan)
 *   old                local branch whose upstream was deleted on the remote
 */
function fixture() {
  const t = tempDir(); cleanups.push(t.cleanup)
  const remote = join(t.dir, 'remote.git'), seed = join(t.dir, 'seed'), clone = join(t.dir, 'clone')
  git(t.dir, 'init', '-q', '--bare', '-b', 'dev', remote)
  git(t.dir, 'init', '-q', '-b', 'dev', seed)
  commits(seed, 'base', 3)
  git(seed, 'branch', 'fix/login')
  git(seed, 'branch', 'experiment')
  git(seed, 'checkout', '-q', '-b', 'old'); commit(seed, 'old.txt', 'o', 'old work')
  git(seed, 'checkout', '-q', 'dev')
  commits(seed, 'dev', 5) // fix/login is now 5 behind
  git(seed, 'checkout', '-q', 'experiment'); commits(seed, 'exp', 2)
  git(seed, 'checkout', '-q', 'dev')
  // experiment forked 5 dev commits ago; rewind its view: make it 3 behind by branching at dev~3 instead
  git(seed, 'branch', '-f', 'experiment', 'dev~3'); git(seed, 'checkout', '-q', 'experiment'); commits(seed, 'exp', 2); git(seed, 'checkout', '-q', 'dev')
  git(seed, 'checkout', '-q', '-b', 'feature/chessfold'); commits(seed, 'chessfold', 7); git(seed, 'checkout', '-q', 'dev')
  git(seed, 'checkout', '-q', '--orphan', 'pages'); git(seed, 'rm', '-rq', '--cached', '.'); commit(seed, 'index.html', '<h1>', 'pages root'); git(seed, 'checkout', '-q', '-f', 'dev')
  git(seed, 'remote', 'add', 'origin', remote)
  git(seed, 'push', '-q', 'origin', 'dev', 'fix/login', 'experiment', 'feature/chessfold', 'pages', 'old')
  git(t.dir, 'clone', '-q', remote, clone)
  git(clone, 'checkout', '-q', '-b', 'feature/chessfold', '--track', 'origin/feature/chessfold')
  commit(clone, 'local-only.txt', 'x', 'unpushed') // local tip differs from origin/feature/chessfold
  git(clone, 'checkout', '-q', '-b', 'old', '--track', 'origin/old')
  git(clone, 'checkout', '-q', 'dev')
  git(seed, 'push', '-q', 'origin', '--delete', 'old')
  git(clone, 'fetch', '-q', '--prune')
  return { ...t, remote, seed, clone }
}

/** Everything inspection must never touch. */
function snapshot(repo: string) {
  return {
    head: git(repo, 'rev-parse', 'HEAD'), symbolic: git(repo, 'symbolic-ref', '-q', 'HEAD'),
    status: git(repo, 'status', '--porcelain'), stash: git(repo, 'stash', 'list'), refs: git(repo, 'for-each-ref'),
    index: createHash('sha256').update(readFileSync(join(repo, '.git', 'index'))).digest('hex'),
    config: readFileSync(join(repo, '.git', 'config'), 'utf8'),
  }
}

const row = (rows: BranchRow[], name: string) => rows.find(r => r.name === name)!

describe('default branch detection', () => {
  it('reads the remote HEAD recorded by clone, whatever it is called', async () => {
    const f = fixture()
    const ins = new BranchInspector()
    const r = await ins.resolveBase('k', loc(f.clone))
    expect(r.base).toMatchObject({ ref: 'refs/remotes/origin/dev', name: 'origin/dev', source: 'remote-head', remote: 'origin' })
  })

  it('asks the remote (ls-remote --symref) when the local remote HEAD is missing, without writing it', async () => {
    const f = fixture()
    git(f.clone, 'remote', 'set-head', 'origin', '-d')
    const before = snapshot(f.clone)
    const r = await new BranchInspector().resolveBase('k', loc(f.clone))
    expect(r.base).toMatchObject({ name: 'origin/dev', source: 'ls-remote' })
    expect(snapshot(f.clone)).toEqual(before)
    expect(() => git(f.clone, 'symbolic-ref', 'refs/remotes/origin/HEAD')).toThrow()
  })

  it('does not guess without a remote, and uses the base the user chose', async () => {
    const t = tempDir(); cleanups.push(t.cleanup)
    git(t.dir, 'init', '-q', '-b', 'trunk'); commits(t.dir, 'c', 2); git(t.dir, 'branch', 'topic')
    const ins = new BranchInspector()
    const none = await ins.resolveBase('k', loc(t.dir))
    expect(none.base).toBeNull()
    expect(none.problem).toMatch(/no remote/)
    const chosen = await ins.resolveBase('k', loc(t.dir), { chosen: 'trunk' })
    expect(chosen.base).toMatchObject({ ref: 'refs/heads/trunk', source: 'user' })
    const gone = await ins.resolveBase('k', loc(t.dir), { chosen: 'deleted' })
    expect(gone.base).toBeNull()
  })

  it('does not pick a remote at random when there are several and none is origin', async () => {
    const f = fixture()
    git(f.clone, 'remote', 'rename', 'origin', 'upstream')
    git(f.clone, 'remote', 'add', 'fork', f.remote)
    git(f.clone, 'checkout', '-q', '--detach')
    const r = await new BranchInspector().resolveBase('k', loc(f.clone))
    expect(r.base).toBeNull()
    expect(r.problem).toMatch(/several remotes/)
  })

  it('uses the current branch upstream remote when there are several remotes', async () => {
    const f = fixture()
    git(f.clone, 'remote', 'add', 'fork', f.remote)
    const r = await new BranchInspector().resolveBase('k', loc(f.clone))
    expect(r.base?.remote).toBe('origin')
  })

  it('parses ls-remote --symref output', () => {
    expect(parseSymref('ref: refs/heads/master\tHEAD\nabc123\tHEAD\n')).toBe('master')
    expect(parseSymref('abc123\tHEAD\n')).toBeNull()
  })
})

describe('ahead and behind against the default branch', () => {
  it('computes every branch from the commit graph, local and remote separately', async () => {
    const f = fixture()
    const before = snapshot(f.clone)
    const r = await new BranchInspector().overview('k', loc(f.clone))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const rows = r.value.branches
    expect(r.value.base?.name).toBe('origin/dev')
    expect(row(rows, 'origin/dev')).toMatchObject({ isBase: true, compare: 'base', ahead: 0, behind: 0 })
    expect(row(rows, 'dev')).toMatchObject({ kind: 'local', current: true, compare: 'up-to-date', ahead: 0, behind: 0, upstreamState: 'in-sync' })
    expect(row(rows, 'origin/feature/chessfold')).toMatchObject({ kind: 'remote', compare: 'ahead', ahead: 7, behind: 0 })
    expect(row(rows, 'feature/chessfold')).toMatchObject({ kind: 'local', compare: 'ahead', ahead: 8, behind: 0, upstreamState: 'ahead', upstreamAhead: 1 })
    expect(row(rows, 'origin/fix/login')).toMatchObject({ compare: 'behind', ahead: 0, behind: 5 })
    expect(row(rows, 'origin/experiment')).toMatchObject({ compare: 'diverged', ahead: 2, behind: 3 })
    expect(row(rows, 'origin/pages')).toMatchObject({ compare: 'unrelated' })
    expect(row(rows, 'old')).toMatchObject({ upstreamState: 'gone' })
    expect(rows.some(x => x.name.endsWith('/HEAD'))).toBe(false)
    // remote branches are listed even when a local branch tracks them
    expect(rows.filter(x => x.name.endsWith('feature/chessfold'))).toHaveLength(2)
    expect(snapshot(f.clone)).toEqual(before)
  })

  it('gives the same counts without the for-each-ref ahead-behind atom (older Git)', async () => {
    const f = fixture()
    const { defaultGitRun } = await import('../src/core/git/ops.js')
    // Simulate Git before 2.41: reject %(ahead-behind) like an old Git would.
    const oldGit: typeof defaultGitRun = (l, args, t) => args.some(a => a.includes('%(ahead-behind'))
      ? Promise.resolve({ code: 128, stdout: '', stderr: 'fatal: unknown field name: ahead-behind', timedOut: false })
      : defaultGitRun(l, args, t)
    const r = await new BranchInspector(oldGit).overview('k', loc(f.clone))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(row(r.value.branches, 'origin/feature/chessfold')).toMatchObject({ ahead: 7, behind: 0 })
    expect(row(r.value.branches, 'origin/experiment')).toMatchObject({ ahead: 2, behind: 3, compare: 'diverged' })
    expect(row(r.value.branches, 'origin/pages')).toMatchObject({ compare: 'unrelated' })
  })

  it('reuses cached counts for unchanged refs and recomputes after a ref moves', async () => {
    const f = fixture()
    const calls: string[][] = []
    const { defaultGitRun } = await import('../src/core/git/ops.js')
    const ins = new BranchInspector((l, args, t) => { calls.push(args); return defaultGitRun(l, args, t) })
    await ins.overview('k', loc(f.clone))
    const mergeBaseCalls = () => calls.filter(c => c[0] === 'merge-base').length
    const first = mergeBaseCalls()
    await ins.overview('k', loc(f.clone))
    expect(mergeBaseCalls()).toBe(first)
    git(f.clone, 'checkout', '-q', 'feature/chessfold'); commit(f.clone, 'more.txt', 'm', 'more'); git(f.clone, 'checkout', '-q', 'dev')
    const r = await ins.overview('k', loc(f.clone))
    expect(r.ok && row(r.value.branches, 'feature/chessfold').ahead).toBe(9)
  })

  it('handles detached HEAD, a missing base and an empty repository', async () => {
    const f = fixture()
    git(f.clone, 'checkout', '-q', '--detach', 'HEAD~1')
    const d = await new BranchInspector().overview('k', loc(f.clone))
    expect(d.ok && d.value.detached).toBe(true)
    expect(d.ok && d.value.branches.some(b => b.current)).toBe(false)

    const t = tempDir(); cleanups.push(t.cleanup)
    git(t.dir, 'init', '-q', '-b', 'main')
    const e = await new BranchInspector().overview('k', loc(t.dir))
    expect(e.ok && e.value).toMatchObject({ branches: [], base: null })

    const c = await new BranchInspector().overview('k', loc(f.clone), { chosen: 'origin/nope' })
    expect(c.ok && c.value.base).toBeNull()
    expect(c.ok && c.value.branches.every(b => b.ahead === null && b.compare === 'unknown')).toBe(true)
  })

  it('parses upstream tracking and name-status output', () => {
    expect(parseTrack('', '')).toMatchObject({ upstreamState: 'none' })
    expect(parseTrack('refs/remotes/origin/x', '[ahead 2, behind 1]')).toEqual({ upstreamState: 'diverged', upstreamAhead: 2, upstreamBehind: 1 })
    expect(parseTrack('refs/remotes/origin/x', '[gone]')).toMatchObject({ upstreamState: 'gone' })
    expect(parseNameStatus('M\0a.txt\0R100\0old.txt\0new.txt\0D\0gone.txt\0')).toEqual([
      { status: 'M', path: 'a.txt' }, { status: 'R', from: 'old.txt', path: 'new.txt' }, { status: 'D', path: 'gone.txt' }])
  })
})

describe('branch inspection', () => {
  it('lists unique and missing commits and changed files without touching the repository', async () => {
    const f = fixture()
    writeFileSync(join(f.clone, 'wip.txt'), 'uncommitted') // the working tree must stay as it is
    git(f.clone, 'stash', 'list')
    const before = snapshot(f.clone)
    const ins = new BranchInspector()
    const d = await ins.detail(loc(f.clone), 'refs/remotes/origin/dev', 'refs/remotes/origin/experiment')
    expect(d.ok).toBe(true)
    if (!d.ok) return
    expect(d.value.unique.map(c => c.subject)).toEqual(['exp 1', 'exp 0'])
    expect(d.value.missing).toHaveLength(3)
    expect(d.value.files.map(x => `${x.status} ${x.path}`).sort()).toEqual(['A exp-0.txt', 'A exp-1.txt'])
    expect(d.value.latest?.subject).toBe('exp 1')
    const u = await ins.detail(loc(f.clone), 'refs/remotes/origin/dev', 'refs/remotes/origin/pages')
    expect(u.ok && u.value.mergeBase).toBeNull()
    expect(snapshot(f.clone)).toEqual(before)
  })

  it('reports a branch that disappeared and refuses non-branch references', async () => {
    const f = fixture()
    const ins = new BranchInspector()
    const gone = await ins.detail(loc(f.clone), 'refs/remotes/origin/dev', 'refs/heads/nope')
    expect(!gone.ok && gone.error.code).toBe('NO_REF')
    const bad = await ins.detail(loc(f.clone), 'refs/remotes/origin/dev', '--output=/tmp/x')
    expect(!bad.ok && bad.error.code).toBe('BAD_REF')
  })
})

describe('freshness of remote data', () => {
  it('reports when the remote-tracking refs were last fetched', async () => {
    const f = fixture()
    const r = await new BranchInspector().overview('k', loc(f.clone))
    expect(r.ok && typeof r.value.lastFetch).toBe('number')
    expect(r.ok && Date.now() - (r.value.lastFetch ?? 0)).toBeLessThan(120_000)
  })
})
