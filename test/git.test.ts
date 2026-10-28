import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Git, isSafeBranchName, parseRefs, splitRemoteRef } from '../src/core/git/ops.js'
import { classifySync, parsePorcelainV2, planPull } from '../src/core/git/status.js'
import type { Location } from '../src/shared/types.js'
import { commit, git, isolateGitConfig, remoteFixture, tempDir } from './helpers.js'

beforeAll(isolateGitConfig)
const G = new Git()
const loc = (path: string): Location => ({ kind: 'native', path })
let cleanups: (() => void)[] = []
afterEach(() => { cleanups.forEach(c => c()); cleanups = [] })
const fixture = () => { const f = remoteFixture(); cleanups.push(f.cleanup); return f }

describe('status parsing and classification', () => {
  it('parses branch headers and counts each change kind', () => {
    const out = ['# branch.oid abc', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -3',
      '1 M. N... 100644 100644 100644 a b staged.txt', '1 .M N... 100644 100644 100644 a b unstaged.txt',
      '1 MM N... 100644 100644 100644 a b both.txt', '2 R. N... 100644 100644 100644 a b R100 new.txt', 'old.txt',
      'u UU N... 100644 100644 100644 100644 a b c conflict.txt', '? untracked.txt', ''].join('\0')
    const s = parsePorcelainV2(out)
    expect(s).toMatchObject({ branch: 'main', upstream: 'origin/main', ahead: 2, behind: 3, upstreamMissing: false })
    expect(s.changes).toEqual({ staged: 3, unstaged: 2, untracked: 1, conflicted: 1 })
  })

  it('classifies every sync state', () => {
    const base = { branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, upstreamMissing: false }
    expect(classifySync(base)).toBe('up-to-date')
    expect(classifySync({ ...base, ahead: 1 })).toBe('ahead')
    expect(classifySync({ ...base, behind: 1 })).toBe('behind')
    expect(classifySync({ ...base, ahead: 1, behind: 1 })).toBe('diverged')
    expect(classifySync({ ...base, upstream: null })).toBe('no-upstream')
    expect(classifySync({ ...base, upstreamMissing: true })).toBe('upstream-gone')
    expect(classifySync({ ...base, branch: null })).toBe('detached')
  })

  it('detects an upstream that is configured but gone', () => {
    const s = parsePorcelainV2(['# branch.oid abc', '# branch.head feature', '# branch.upstream origin/feature', ''].join('\0'))
    expect(s.upstreamMissing).toBe(true)
    expect(planPull(s)).toMatchObject({ action: 'refuse', code: 'UPSTREAM_GONE' })
  })

  it('reads real repositories: clean, dirty, ahead, behind and no upstream', async () => {
    const f = fixture()
    let s = await G.status(loc(f.local))
    expect(s.ok && s.value).toMatchObject({ branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, remotes: ['origin'] })
    expect(s.ok && classifySync(s.value)).toBe('up-to-date')

    writeFileSync(join(f.local, 'README.md'), 'edited\n'); writeFileSync(join(f.local, 'new.txt'), 'x')
    s = await G.status(loc(f.local))
    expect(s.ok && s.value.changes).toEqual({ staged: 0, unstaged: 1, untracked: 1, conflicted: 0 })
    git(f.local, 'checkout', '--', 'README.md')

    commit(f.local, 'local.txt', 'l')
    commit(f.other, 'other.txt', 'o'); git(f.other, 'push', '-q')
    await G.fetch(loc(f.local))
    s = await G.status(loc(f.local))
    expect(s.ok && classifySync(s.value)).toBe('diverged')

    git(f.local, 'checkout', '-q', '-b', 'solo')
    s = await G.status(loc(f.local))
    expect(s.ok && classifySync(s.value)).toBe('no-upstream')
  })

  it('reports a folder that is not a repository', async () => {
    const t = tempDir(); cleanups.push(t.cleanup)
    const r = await G.verifyRepo(loc(t.dir))
    expect(r.ok).toBe(false)
  })
})

describe('fetch and fast-forward pull', () => {
  it('fetch updates remote-tracking refs only, then pull fast-forwards', async () => {
    const f = fixture()
    commit(f.other, 'feature.txt', 'f'); git(f.other, 'push', '-q')
    const before = git(f.local, 'rev-parse', 'HEAD')
    const fetched = await G.fetch(loc(f.local))
    expect(fetched).toEqual({ ok: true, value: { remote: 'origin' } })
    expect(git(f.local, 'rev-parse', 'HEAD')).toBe(before)
    const s = await G.status(loc(f.local))
    expect(s.ok && s.value.behind).toBe(1)
    const cmp = await G.compare(loc(f.local))
    expect(cmp.ok && cmp.value.incoming.map(c => c.subject)).toEqual(['change feature.txt'])

    const pulled = await G.pull(loc(f.local))
    expect(pulled.ok && pulled.value.commits).toBe(1)
    expect(git(f.local, 'rev-parse', 'HEAD')).toBe(git(f.other, 'rev-parse', 'HEAD'))
  })

  it('keeps unrelated uncommitted work during a fast-forward and never stashes it', async () => {
    const f = fixture()
    commit(f.other, 'feature.txt', 'f'); git(f.other, 'push', '-q')
    writeFileSync(join(f.local, 'README.md'), 'my work in progress\n')
    const r = await G.pull(loc(f.local))
    expect(r.ok).toBe(true)
    expect(readFileSync(join(f.local, 'README.md'), 'utf8')).toBe('my work in progress\n')
    expect(git(f.local, 'stash', 'list')).toBe('')
  })

  it('refuses a pull that would overwrite local changes and leaves everything as it was', async () => {
    const f = fixture()
    commit(f.other, 'README.md', 'remote edit\n'); git(f.other, 'push', '-q')
    writeFileSync(join(f.local, 'README.md'), 'local edit\n')
    const head = git(f.local, 'rev-parse', 'HEAD')
    const r = await G.pull(loc(f.local))
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error.code).toBe('LOCAL_CHANGES')
    expect(git(f.local, 'rev-parse', 'HEAD')).toBe(head)
    expect(readFileSync(join(f.local, 'README.md'), 'utf8')).toBe('local edit\n')
    expect(git(f.local, 'stash', 'list')).toBe('')
  })

  it('refuses to pull a diverged branch without changing it', async () => {
    const f = fixture()
    commit(f.local, 'local.txt', 'l')
    commit(f.other, 'other.txt', 'o'); git(f.other, 'push', '-q')
    const head = git(f.local, 'rev-parse', 'HEAD')
    const r = await G.pull(loc(f.local))
    expect(!r.ok && r.error.code).toBe('DIVERGED')
    expect(git(f.local, 'rev-parse', 'HEAD')).toBe(head)
    expect(existsSync(join(f.local, 'other.txt'))).toBe(false)
  })

  it('ignores a pull.rebase or merge.autostash configuration', async () => {
    const f = fixture()
    git(f.local, 'config', 'pull.rebase', 'true'); git(f.local, 'config', 'merge.autostash', 'true')
    commit(f.local, 'local.txt', 'l')
    commit(f.other, 'other.txt', 'o'); git(f.other, 'push', '-q')
    const r = await G.pull(loc(f.local))
    expect(!r.ok && r.error.code).toBe('DIVERGED')
    expect(git(f.local, 'log', '--format=%s', '-1')).toBe('change local.txt')
  })

  it('reports up to date and nothing to pull', async () => {
    const f = fixture()
    const r = await G.pull(loc(f.local))
    expect(!r.ok && r.error.code).toBe('UP_TO_DATE')
  })
})

describe('branches and safe switching', () => {
  it('lists local and remote branches and marks tracked remotes', async () => {
    const f = fixture()
    git(f.other, 'checkout', '-q', '-b', 'feature'); commit(f.other, 'f.txt', 'f'); git(f.other, 'push', '-q', '-u', 'origin', 'feature')
    await G.fetch(loc(f.local))
    const r = await G.branches(loc(f.local))
    expect(r.ok).toBe(true)
    const names = r.ok ? r.value.map(b => `${b.kind}:${b.name}:${b.current ? '*' : ''}${b.tracked ? 't' : ''}`) : []
    expect(names.sort()).toEqual(['local:main:*', 'remote:origin/feature:', 'remote:origin/main:t'])
  })

  it('creates a tracking branch from a remote branch and refuses an existing local name', async () => {
    const f = fixture()
    git(f.other, 'checkout', '-q', '-b', 'feature'); commit(f.other, 'f.txt', 'f'); git(f.other, 'push', '-q', '-u', 'origin', 'feature')
    await G.fetch(loc(f.local))
    const r = await G.trackRemote(loc(f.local), 'origin/feature')
    expect(r).toEqual({ ok: true, value: { branch: 'feature' } })
    expect(git(f.local, 'rev-parse', '--abbrev-ref', 'feature@{upstream}')).toBe('origin/feature')
    const again = await G.trackRemote(loc(f.local), 'origin/feature')
    expect(!again.ok && again.error.code).toBe('EXISTS')
  })

  it('switches branches carrying non-conflicting work along', async () => {
    const f = fixture()
    git(f.local, 'branch', 'other')
    writeFileSync(join(f.local, 'notes.txt'), 'draft')
    const r = await G.switchBranch(loc(f.local), 'other')
    expect(r).toEqual({ ok: true, value: { branch: 'other', carried: true } })
    expect(readFileSync(join(f.local, 'notes.txt'), 'utf8')).toBe('draft')
  })

  it('refuses a switch that would overwrite local changes and leaves the repository unchanged', async () => {
    const f = fixture()
    git(f.local, 'checkout', '-q', '-b', 'other'); commit(f.local, 'README.md', 'other branch\n'); git(f.local, 'checkout', '-q', 'main')
    writeFileSync(join(f.local, 'README.md'), 'uncommitted on main\n')
    const r = await G.switchBranch(loc(f.local), 'other')
    expect(!r.ok && r.error.code).toBe('LOCAL_CHANGES')
    expect(git(f.local, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
    expect(readFileSync(join(f.local, 'README.md'), 'utf8')).toBe('uncommitted on main\n')
    expect(git(f.local, 'stash', 'list')).toBe('')
  })

  it('rejects branch names that could be read as options', async () => {
    const f = fixture()
    for (const bad of ['-f', '--force', 'a..b', 'x y', 'a~1', '']) expect(isSafeBranchName(bad)).toBe(false)
    expect(isSafeBranchName('feature/login-2')).toBe(true)
    const r = await G.switchBranch(loc(f.local), '--discard-changes')
    expect(!r.ok && r.error.code).toBe('BAD_NAME')
  })

  it('splits remote refs using configured remote names', () => {
    expect(splitRemoteRef('origin/feature/x', ['origin'])).toEqual({ remote: 'origin', branch: 'feature/x' })
    expect(splitRemoteRef('team/a/b', ['team', 'team/a'])).toEqual({ remote: 'team/a', branch: 'b' })
    expect(splitRemoteRef('nope/x', ['origin'])).toBeNull()
    expect(parseRefs('refs/remotes/origin/HEAD\x1f \x1f\x1f1\n', ['origin'])).toEqual([])
  })

  it('reads recent commits and checks the remote', async () => {
    const f = fixture()
    commit(f.local, 'a.txt', 'a', 'Add a')
    const log = await G.log(loc(f.local), 5)
    expect(log.ok && log.value.map(c => c.subject)).toEqual(['Add a', 'initial'])
    expect((await G.checkRemote(loc(f.local), 'origin')).reachable).toBe(true)
    git(f.local, 'remote', 'add', 'broken', join(f.dir, 'missing.git'))
    const bad = await G.checkRemote(loc(f.local), 'broken')
    expect(bad.reachable).toBe(false)
  })

  it('handles an empty repository', async () => {
    const t = tempDir(); cleanups.push(t.cleanup)
    git(t.dir, 'init', '-q', '-b', 'main')
    const s = await G.status(loc(t.dir))
    expect(s.ok && s.value).toMatchObject({ branch: 'main', oid: null, upstream: null })
    const log = await G.log(loc(t.dir))
    expect(log).toEqual({ ok: true, value: [] })
  })
})
