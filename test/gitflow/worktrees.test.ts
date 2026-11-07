import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { WorktreeService, parseWorktrees, suggestWorktreePath } from '../../src/core/git/worktrees.js'
import type { Location } from '../../src/shared/types.js'
import { commit, git, isolateGitConfig, tempDir } from '../helpers.js'

beforeAll(isolateGitConfig)
let cleanups: (() => void)[] = []
afterEach(() => { cleanups.forEach(c => c()); cleanups = [] })
const loc = (path: string): Location => ({ kind: 'native', path })
const W = new WorktreeService()

function repo() {
  const t = tempDir(); cleanups.push(t.cleanup)
  const main = join(t.dir, 'my repo')
  git(t.dir, 'init', '-q', '-b', 'main', main)
  commit(main, 'a.txt', 'a')
  git(main, 'branch', 'feature')
  return { ...t, main }
}

describe('suggestWorktreePath', () => {
  it('is syntax aware and slugifies branches', () => {
    expect(suggestWorktreePath({ kind: 'native', path: 'C:\\src\\app\\' }, 'feat/Login page')).toBe('C:\\src\\app.worktrees\\feat-Login-page')
    expect(suggestWorktreePath({ kind: 'wsl', distro: 'Ubuntu', path: '/home/me/app' }, 'fix/x')).toBe('/home/me/app.worktrees/fix-x')
    expect(suggestWorktreePath({ kind: 'native', path: '/home/me/app' }, '///')).toBe('/home/me/app.worktrees/worktree')
  })
})

describe('parseWorktrees', () => {
  it('parses detached, bare, locked and prunable records', () => {
    const out = ['worktree /r', 'HEAD ' + 'a'.repeat(40), 'branch refs/heads/main', '', 'worktree /r2', 'HEAD ' + 'b'.repeat(40), 'detached', 'locked because', 'prunable gone', '', 'worktree /bare', 'bare', '', ''].join('\0')
    const l = parseWorktrees(out)
    expect(l.map(w => w.path)).toEqual(['/r', '/r2', '/bare'])
    expect(l[0]).toMatchObject({ branch: 'main', main: true })
    expect(l[1]).toMatchObject({ detached: true, locked: true, lockReason: 'because', prunable: true, main: false })
    expect(l[2].bare).toBe(true)
  })
})

describe('WorktreeService', () => {
  it('lists worktrees with status, detached and locked, and marks the current one', async () => {
    const r = repo()
    const d = join(r.dir, 'det'), l = join(r.dir, 'lock dir')
    git(r.main, 'worktree', 'add', '-q', '--detach', d)
    git(r.main, 'worktree', 'add', '-q', l, 'feature')
    git(r.main, 'worktree', 'lock', '--reason', 'usb', l)
    writeFileSync(join(l, 'new.txt'), 'x')
    const res = await W.list(loc(r.main))
    if (!res.ok) throw new Error(res.error.message)
    const byPath = (p: string) => res.value.find(w => w.path.endsWith(p))!
    expect(res.value).toHaveLength(3)
    expect(byPath('my repo')).toMatchObject({ main: true, isCurrent: true, branch: 'main', dirty: false })
    expect(byPath('det')).toMatchObject({ detached: true, branch: null, isCurrent: false })
    expect(byPath('lock dir')).toMatchObject({ locked: true, lockReason: 'usb', branch: 'feature', dirty: true, changes: { untracked: 1 } })
    const fromLinked = await W.list(loc(d))
    expect(fromLinked.ok && fromLinked.value.find(w => w.isCurrent)?.path).toMatch(/det$/)
  })

  it('adds a worktree for an existing branch and for a new one (paths with spaces)', async () => {
    const r = repo()
    const a = join(r.dir, 'my repo.worktrees', 'feat one'), b = join(r.dir, 'my repo.worktrees', 'new-branch')
    expect(await W.add(loc(r.main), { path: a, branch: 'feature', create: false })).toMatchObject({ ok: true })
    expect(git(a, 'branch', '--show-current')).toBe('feature')
    expect(await W.add(loc(r.main), { path: b, branch: 'new/x', create: true, base: 'main' })).toMatchObject({ ok: true })
    expect(git(b, 'branch', '--show-current')).toBe('new/x')
  })

  it('refuses a branch already checked out and names the path', async () => {
    const r = repo()
    const res = await W.add(loc(r.main), { path: join(r.dir, 'w'), branch: 'main', create: false })
    expect(res).toMatchObject({ ok: false, error: { code: 'CHECKED_OUT' } })
    if (!res.ok) expect(res.error.message).toContain('my repo')
  })

  it('refuses invalid names, existing branches for create, missing branches and bad bases', async () => {
    const r = repo()
    const p = join(r.dir, 'w')
    for (const [o, code] of [
      [{ branch: '-x', create: true }, 'BAD_NAME'], [{ branch: 'feature', create: true }, 'EXISTS'],
      [{ branch: 'ghost', create: false }, 'NO_BRANCH'], [{ branch: 'n', create: true, base: 'nope' }, 'NO_BASE'], [{ branch: 'n', create: true, base: '--x' }, 'BAD_BASE'],
    ] as const) expect(await W.add(loc(r.main), { path: p, ...o })).toMatchObject({ ok: false, error: { code } })
  })

  it('refuses a non-empty target, relative paths and a WSL path with backslashes', async () => {
    const r = repo()
    const full = join(r.dir, 'full'); mkdirSync(full); writeFileSync(join(full, 'f'), 'x')
    expect(await W.add(loc(r.main), { path: full, branch: 'feature', create: false })).toMatchObject({ ok: false, error: { code: 'PATH_EXISTS' } })
    expect(await W.add(loc(r.main), { path: 'rel/dir', branch: 'feature', create: false })).toMatchObject({ ok: false, error: { code: 'BAD_PATH' } })
    expect(await W.add({ kind: 'wsl', distro: 'U', path: '/x' }, { path: 'C:\\a', branch: 'feature', create: false })).toMatchObject({ ok: false, error: { code: 'BAD_PATH' } })
  })

  it('allows an empty existing folder', async () => {
    const r = repo(); const e = join(r.dir, 'empty'); mkdirSync(e)
    expect(await W.add(loc(r.main), { path: e, branch: 'feature', create: false })).toMatchObject({ ok: true })
  })

  it('refuses a target inside the working tree unless it is ignored', async () => {
    const r = repo()
    expect(await W.add(loc(r.main), { path: join(r.main, 'sub', 'wt'), branch: 'feature', create: false })).toMatchObject({ ok: false, error: { code: 'INSIDE_REPO' } })
    writeFileSync(join(r.main, '.gitignore'), '.worktrees/\n'); git(r.main, 'add', '.gitignore'); git(r.main, 'commit', '-q', '-m', 'ignore')
    expect(await W.add(loc(r.main), { path: join(r.main, '.worktrees', 'wt'), branch: 'feature', create: false })).toMatchObject({ ok: true })
  })

  it('refuses to remove a worktree with uncommitted changes, then removes a clean one', async () => {
    const r = repo(); const p = join(r.dir, 'wt x')
    await W.add(loc(r.main), { path: p, branch: 'feature', create: false })
    writeFileSync(join(p, 'wip.txt'), 'x')
    const blocked = await W.remove(loc(r.main), p, { confirmed: true })
    expect(blocked).toMatchObject({ ok: false, error: { code: 'BLOCKED' } })
    expect(git(r.main, 'worktree', 'list')).toContain('wt x')
    const check = await W.removalCheck(loc(r.main), p)
    expect(check.ok && check.value.blockers.map(b => [b.code, b.overridable])).toEqual([['dirty', true]])
    expect(await W.remove(loc(r.main), p, { confirmed: false })).toMatchObject({ ok: false, error: { code: 'NOT_CONFIRMED' } })
    expect(await W.remove(loc(r.main), p, { confirmed: true, force: true })).toMatchObject({ ok: true })
    expect(git(r.main, 'branch', '--list', 'feature')).not.toBe('') // the branch is kept
  })

  it('removes a clean worktree', async () => {
    const r = repo(); const p = join(r.dir, 'clean')
    await W.add(loc(r.main), { path: p, branch: 'feature', create: false })
    const res = await W.remove(loc(r.main), p, { confirmed: true })
    expect(res).toMatchObject({ ok: true, value: { branch: 'feature' } })
    expect(git(r.main, 'worktree', 'list')).not.toContain('clean')
  })

  it('refuses the main worktree, the current one, locked ones and running services even with force', async () => {
    const r = repo(); const p = join(r.dir, 'busy')
    await W.add(loc(r.main), { path: p, branch: 'feature', create: false })
    expect(await W.remove(loc(r.main), r.main, { confirmed: true, force: true })).toMatchObject({ ok: false, error: { code: 'BLOCKED' } })
    expect(await W.remove(loc(p), p, { confirmed: true, force: true })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/using/) } })
    expect(await W.remove(loc(r.main), p, { confirmed: true, force: true, runningServicesAt: () => ['API'] })).toMatchObject({ ok: false, error: { message: expect.stringContaining('API') } })
    git(r.main, 'worktree', 'lock', p)
    expect(await W.remove(loc(r.main), p, { confirmed: true, force: true })).toMatchObject({ ok: false, error: { message: expect.stringMatching(/locked/) } })
    expect(await W.remove(loc(r.main), join(r.dir, 'unknown'), { confirmed: true })).toMatchObject({ ok: false, error: { code: 'NOT_A_WORKTREE' } })
    expect(git(r.main, 'worktree', 'list')).toContain('busy')
  })

  it('blocks removing a detached worktree whose commits are on no branch', async () => {
    const r = repo(); const p = join(r.dir, 'det')
    git(r.main, 'worktree', 'add', '-q', '--detach', p)
    commit(p, 'lost.txt', 'x', 'orphan work')
    const c = await W.removalCheck(loc(r.main), p)
    expect(c.ok && c.value.blockers.map(b => b.code)).toEqual(['detached-commits'])
    expect(c.ok && c.value.unpushed).toBe(2)
  })

  it('prunes records of deleted folders', async () => {
    const r = repo(); const p = join(r.dir, 'gone')
    await W.add(loc(r.main), { path: p, branch: 'feature', create: false })
    cleanups.push(() => undefined)
    const { rmSync } = await import('node:fs'); rmSync(p, { recursive: true })
    const dry = await W.prune(loc(r.main), { dryRun: true })
    expect(dry.ok && dry.value.pruned).toHaveLength(1)
    expect(git(r.main, 'worktree', 'list')).toContain('gone')
    await W.prune(loc(r.main))
    expect(git(r.main, 'worktree', 'list')).not.toContain('gone')
  })
})
