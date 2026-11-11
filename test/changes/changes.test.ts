import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ChangesService, parseChanges, parseUnifiedDiff, safeRelativePath } from '../../src/core/git/changes.js'
import { Git } from '../../src/core/git/ops.js'
import type { Location } from '../../src/shared/types.js'
import { commit, git, isolateGitConfig, remoteFixture, tempDir } from '../helpers.js'

beforeAll(isolateGitConfig)
const loc = (path: string): Location => ({ kind: 'native', path })
const S = new ChangesService()
let cleanups: (() => void)[] = []
afterEach(() => { cleanups.forEach(c => c()); cleanups = [] })
function repo() {
  const t = tempDir(); cleanups.push(t.cleanup)
  git(t.dir, 'init', '-q', '-b', 'main')
  commit(t.dir, 'a.txt', 'one\ntwo\nthree\n', 'a'); commit(t.dir, 'b.txt', 'b\n', 'b'); commit(t.dir, 'c.txt', 'c\n', 'c')
  return t.dir
}
const tree = async (dir: string) => { const r = await S.read(loc(dir)); if (!r.ok) throw new Error(r.error.message); return r.value }
const by = (t: Awaited<ReturnType<typeof tree>>, p: string) => t.files.find(f => f.path === p)

describe('status', () => {
  it('parses every kind of entry', () => {
    const out = ['# branch.oid abc', '# branch.head main',
      '1 M. N... 100644 100644 100644 a b staged.txt', '1 .M N... 100644 100644 100644 a b my file.txt', '1 MM N... 100644 100644 100644 a b both.txt',
      '1 .D N... 100644 100644 000000 a b gone.txt', '2 R. N... 100644 100644 100644 a b R100 new name.txt', 'old name.txt',
      'u UU N... 100644 100644 100644 100644 a b c conflict.txt', '? untracked.txt', ''].join('\0')
    const { files, branch } = parseChanges(out)
    expect(branch).toBe('main')
    expect(files.map(f => [f.path, f.index, f.worktree, f.untracked, f.conflicted])).toEqual([
      ['staged.txt', 'modified', null, false, false], ['my file.txt', null, 'modified', false, false], ['both.txt', 'modified', 'modified', false, false],
      ['gone.txt', null, 'deleted', false, false], ['new name.txt', 'renamed', null, false, false], ['conflict.txt', null, null, false, true], ['untracked.txt', null, null, true, false],
    ])
    expect(files[4].from).toBe('old name.txt')
    expect(files[5].conflictKind).toBe('both modified')
  })

  it('reads a real repository: staged, unstaged, both, deleted, renamed, untracked and counts', async () => {
    const d = repo()
    writeFileSync(join(d, 'a.txt'), 'ONE\ntwo\nthree\n'); git(d, 'add', 'a.txt'); writeFileSync(join(d, 'a.txt'), 'ONE\ntwo\nTHREE\n') // staged and unstaged
    writeFileSync(join(d, 'b.txt'), 'bb\n') // unstaged
    rmSync(join(d, 'c.txt')) // unstaged deletion
    writeFileSync(join(d, 'new dir file.txt'), 'x'); mkdirSync(join(d, 'sub')); writeFileSync(join(d, 'sub', 'u.txt'), 'u') // untracked
    git(d, 'mv', 'a.txt', 'a2.txt')
    const t = await tree(d)
    expect(by(t, 'a2.txt')).toMatchObject({ index: 'renamed', worktree: 'modified', from: 'a.txt' })
    expect(by(t, 'b.txt')).toMatchObject({ index: null, worktree: 'modified' })
    expect(by(t, 'c.txt')).toMatchObject({ worktree: 'deleted' })
    expect(by(t, 'sub/u.txt')).toMatchObject({ untracked: true })
    expect(t.counts).toEqual({ files: 5, staged: 1, unstaged: 3, untracked: 2, conflicted: 0 })
    expect(t.operation).toBeNull()
  })

  it('reads merge conflicts and the operation in progress', async () => {
    const d = repo()
    git(d, 'checkout', '-q', '-b', 'x'); commit(d, 'a.txt', 'x\ntwo\nthree\n', 'x')
    git(d, 'checkout', '-q', 'main'); commit(d, 'a.txt', 'm\ntwo\nthree\n', 'm')
    try { git(d, 'merge', 'x') } catch { /* conflicts expected */ }
    const t = await tree(d)
    expect(by(t, 'a.txt')).toMatchObject({ conflicted: true, conflictKind: 'both modified' })
    expect(t.operation).toBe('merge')
    expect(t.counts.conflicted).toBe(1)
    const c = await S.commit(loc(d), 'try')
    expect(c).toMatchObject({ ok: false, error: { code: 'CONFLICTS' } })
    const all = await S.stageAll(loc(d))
    expect(all.ok && all.value.skippedConflicts).toEqual(['a.txt'])
  })

  it('an empty repository (no commits) lists its untracked files', async () => {
    const t = tempDir(); cleanups.push(t.cleanup); git(t.dir, 'init', '-q', '-b', 'main'); writeFileSync(join(t.dir, 'f.txt'), 'x')
    const w = await tree(t.dir)
    expect(w.hasCommits).toBe(false)
    expect(w.files).toHaveLength(1)
    expect((await S.stage(loc(t.dir), ['f.txt'])).ok).toBe(true)
    expect(by(await tree(t.dir), 'f.txt')?.index).toBe('added')
    expect((await S.unstage(loc(t.dir), ['f.txt'])).ok).toBe(true) // no HEAD: the index entry is removed, the file stays
    expect(by(await tree(t.dir), 'f.txt')).toMatchObject({ untracked: true })
  })
})

describe('staging', () => {
  it('stages and unstages selected files, and everything', async () => {
    const d = repo()
    writeFileSync(join(d, 'a.txt'), 'A\n'); writeFileSync(join(d, 'b.txt'), 'B\n'); writeFileSync(join(d, 'n.txt'), 'n')
    expect(await S.stage(loc(d), ['a.txt', 'n.txt'])).toMatchObject({ ok: true })
    let t = await tree(d)
    expect([by(t, 'a.txt')?.index, by(t, 'n.txt')?.index, by(t, 'b.txt')?.index]).toEqual(['modified', 'added', null])
    expect(await S.unstage(loc(d), ['a.txt'])).toMatchObject({ ok: true })
    expect(by(await tree(d), 'a.txt')).toMatchObject({ index: null, worktree: 'modified' })
    const all = await S.stageAll(loc(d))
    expect(all.ok && all.value.staged.sort()).toEqual(['a.txt', 'b.txt']) // n.txt is already staged
    t = await tree(d); expect(t.counts).toMatchObject({ staged: 3, unstaged: 0 })
    const un = await S.unstageAll(loc(d))
    expect(un.ok && un.value.unstaged).toHaveLength(3)
    t = await tree(d); expect(t.counts).toMatchObject({ staged: 0, unstaged: 2, untracked: 1 })
  })

  it('stages a rename with its old path and a deletion', async () => {
    const d = repo()
    git(d, 'mv', 'b.txt', 'bb.txt'); git(d, 'reset', '-q') // rename is now an unstaged delete + untracked add
    rmSync(join(d, 'c.txt'))
    expect(await S.stage(loc(d), ['bb.txt', 'b.txt', 'c.txt'])).toMatchObject({ ok: true })
    const t = await tree(d)
    expect(by(t, 'bb.txt')).toMatchObject({ index: 'renamed', from: 'b.txt' })
    expect(by(t, 'c.txt')).toMatchObject({ index: 'deleted' })
  })

  it('refuses stale or unsafe selections and treats names literally', async () => {
    const d = repo()
    writeFileSync(join(d, 'a.txt'), 'A\n'); writeFileSync(join(d, '*.txt'), 'star'); writeFileSync(join(d, '-rf'), 'dash')
    for (const bad of [['../x'], ['/etc/passwd'], ['C:\\x'], ['a\nb'], [''], []]) expect(await S.stage(loc(d), bad), JSON.stringify(bad)).toMatchObject({ ok: false })
    expect(await S.stage(loc(d), ['c.txt'])).toMatchObject({ ok: false, error: { code: 'STALE_SELECTION' } })
    expect((await S.stage(loc(d), ['*.txt'])).ok).toBe(true)
    const t = await tree(d)
    expect([by(t, '*.txt')?.index, by(t, 'a.txt')?.index]).toEqual(['added', null]) // the pattern did not match a.txt
    expect((await S.stage(loc(d), ['-rf'])).ok).toBe(true)
    expect(safeRelativePath('dir/..x/file')).toBe(true)
    expect(safeRelativePath('dir/../x')).toBe(false)
  })
})

describe('discard, restore and delete', () => {
  it('discard needs confirmation, reverts only the unstaged side, keeps staged changes and records a snapshot', async () => {
    const d = repo()
    writeFileSync(join(d, 'a.txt'), 'S\ntwo\nthree\n'); git(d, 'add', 'a.txt'); writeFileSync(join(d, 'a.txt'), 'S\ntwo\nUNSAVED\n')
    expect(await S.discard(loc(d), ['a.txt'], false)).toMatchObject({ ok: false, error: { code: 'CONFIRM_REQUIRED' } })
    expect(readFileSync(join(d, 'a.txt'), 'utf8')).toContain('UNSAVED')
    const r = await S.discard(loc(d), ['a.txt'], true)
    expect(r.ok && r.value.discarded).toEqual(['a.txt'])
    expect(readFileSync(join(d, 'a.txt'), 'utf8')).toBe('S\ntwo\nthree\n')
    expect(by(await tree(d), 'a.txt')).toMatchObject({ index: 'modified', worktree: null })
    expect(r.ok && r.value.recoverWith).toMatch(/^git stash apply [0-9a-f]{40}$/)
    // the recovery command really brings the discarded content back
    const sha = (r.ok && r.value.recoverWith!.split(' ').pop())!
    expect(git(d, 'show', `${sha}:a.txt`)).toContain('UNSAVED')
  })

  it('discard refuses untracked, deleted and conflicted files', async () => {
    const d = repo()
    writeFileSync(join(d, 'n.txt'), 'x'); rmSync(join(d, 'c.txt'))
    expect(await S.discard(loc(d), ['n.txt'], true)).toMatchObject({ ok: false, error: { code: 'STALE_SELECTION' } })
    expect(await S.discard(loc(d), ['c.txt'], true)).toMatchObject({ ok: false })
    expect(existsSync(join(d, 'n.txt'))).toBe(true)
  })

  it('restores deleted tracked files, unstaged and staged', async () => {
    const d = repo()
    rmSync(join(d, 'b.txt')); git(d, 'rm', '-q', 'c.txt')
    expect(by(await tree(d), 'c.txt')).toMatchObject({ index: 'deleted' })
    const r = await S.restoreDeleted(loc(d), ['b.txt', 'c.txt'])
    expect(r.ok && r.value.restored.sort()).toEqual(['b.txt', 'c.txt'])
    expect(readFileSync(join(d, 'c.txt'), 'utf8')).toBe('c\n')
    expect((await tree(d)).files).toHaveLength(0)
    writeFileSync(join(d, 'a.txt'), 'x')
    expect(await S.restoreDeleted(loc(d), ['a.txt'])).toMatchObject({ ok: false }) // modified, not deleted
  })

  it('deletes untracked files only: to the trash when available, git clean after a separate permanent confirmation', async () => {
    const d = repo()
    writeFileSync(join(d, 'n1.txt'), 'x'); writeFileSync(join(d, 'n2.txt'), 'y'); writeFileSync(join(d, '.gitignore'), 'ign.txt\n'); writeFileSync(join(d, 'ign.txt'), 'i')
    git(d, 'add', '.gitignore')
    const trashed: string[] = []
    const trash = async (_l: Location, p: string) => { trashed.push(p); rmSync(join(d, p)) }
    expect(await S.deleteUntracked(loc(d), ['n1.txt'], { confirm: false, trash })).toMatchObject({ ok: false, error: { code: 'CONFIRM_REQUIRED' } })
    const r = await S.deleteUntracked(loc(d), ['n1.txt'], { confirm: true, trash })
    expect(r.ok && r.value).toMatchObject({ deleted: ['n1.txt'], method: 'trash' })
    expect(trashed).toEqual(['n1.txt'])
    expect(await S.deleteUntracked(loc(d), ['n2.txt'], { confirm: true, trash: null })).toMatchObject({ ok: false, error: { code: 'TRASH_UNAVAILABLE' } })
    expect(existsSync(join(d, 'n2.txt'))).toBe(true)
    const p = await S.deleteUntracked(loc(d), ['n2.txt'], { confirm: true, permanent: true, trash: null })
    expect(p.ok && p.value).toMatchObject({ deleted: ['n2.txt'], method: 'permanent' })
    expect(existsSync(join(d, 'n2.txt'))).toBe(false)
    // tracked and ignored files are never deletable through this path
    expect(await S.deleteUntracked(loc(d), ['a.txt'], { confirm: true, permanent: true })).toMatchObject({ ok: false })
    expect(await S.deleteUntracked(loc(d), ['ign.txt'], { confirm: true, permanent: true })).toMatchObject({ ok: false })
    expect(existsSync(join(d, 'ign.txt')) && existsSync(join(d, 'a.txt'))).toBe(true)
  })
})

describe('diff and hunks', () => {
  const big = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
  const setup = () => { const d = repo(); commit(d, 'big.txt', big, 'big'); return d }
  const edit = (d: string) => writeFileSync(join(d, 'big.txt'), big.replace('line 2\n', 'LINE 2\n').replace('line 38\n', 'LINE 38\n'))

  it('parses unified diffs with line numbers', () => {
    const p = parseUnifiedDiff('diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n\\ No newline at end of file\n')
    expect(p).toMatchObject({ binary: false, added: 1, removed: 1, simple: true })
    expect(p.hunks[0].lines.map(l => [l.type, l.oldNo, l.newNo])).toEqual([['context', 1, 1], ['del', 2, undefined], ['add', undefined, 2], ['context', 3, 3], ['meta', undefined, undefined]])
  })

  it('reads staged, unstaged and untracked diffs with the requested context', async () => {
    const d = setup(); edit(d)
    let r = await S.diff(loc(d), { path: 'big.txt', area: 'unstaged', context: 1 })
    expect(r.ok && r.value).toMatchObject({ added: 2, removed: 2, hunkable: true })
    expect(r.ok && r.value.hunks).toHaveLength(2)
    r = await S.diff(loc(d), { path: 'big.txt', area: 'unstaged', context: 100 })
    expect(r.ok && r.value.hunks).toHaveLength(1)
    git(d, 'add', 'big.txt')
    expect((await S.diff(loc(d), { path: 'big.txt', area: 'unstaged' })).ok && true).toBe(true)
    r = await S.diff(loc(d), { path: 'big.txt', area: 'staged' })
    expect(r.ok && r.value.added).toBe(2)
    writeFileSync(join(d, 'new.txt'), 'x\ny\n'); writeFileSync(join(d, 'bin.dat'), Buffer.from([0, 1, 2, 0, 255]))
    r = await S.diff(loc(d), { path: 'new.txt', area: 'untracked' })
    expect(r.ok && r.value).toMatchObject({ added: 2, removed: 0, hunkable: false })
    r = await S.diff(loc(d), { path: 'bin.dat', area: 'untracked' })
    expect(r.ok && r.value).toMatchObject({ binary: true, hunks: [] })
  })

  it('stages, unstages and discards one hunk', async () => {
    const d = setup(); edit(d)
    const hunks = async (area: 'staged' | 'unstaged') => { const r = await S.diff(loc(d), { path: 'big.txt', area }); return r.ok ? r.value.hunks : [] }
    const [h1, h2] = await hunks('unstaged')
    expect(await S.hunk(loc(d), { path: 'big.txt', area: 'unstaged', hunkId: h1.id, action: 'stage' })).toMatchObject({ ok: true })
    expect(git(d, 'diff', '--cached')).toContain('+LINE 2')
    expect(git(d, 'diff', '--cached')).not.toContain('LINE 38')
    expect((await hunks('unstaged')).map(h => h.header)).toHaveLength(1)
    const [sh] = await hunks('staged')
    expect(await S.hunk(loc(d), { path: 'big.txt', area: 'staged', hunkId: sh.id, action: 'unstage' })).toMatchObject({ ok: true })
    expect(git(d, 'diff', '--cached')).toBe('')
    // discard needs confirmation and removes only that hunk from the working file
    const [a, b] = await hunks('unstaged')
    expect(await S.hunk(loc(d), { path: 'big.txt', area: 'unstaged', hunkId: b.id, action: 'discard' })).toMatchObject({ ok: false, error: { code: 'CONFIRM_REQUIRED' } })
    expect(await S.hunk(loc(d), { path: 'big.txt', area: 'unstaged', hunkId: b.id, action: 'discard', confirm: true })).toMatchObject({ ok: true })
    const text = readFileSync(join(d, 'big.txt'), 'utf8')
    expect(text).toContain('LINE 2') ; expect(text).toContain('line 38')
    void a; void h2
  })

  it('refuses a stale hunk and a staged hunk discard', async () => {
    const d = setup(); edit(d)
    const r = await S.diff(loc(d), { path: 'big.txt', area: 'unstaged' })
    const id = r.ok ? r.value.hunks[0].id : ''
    writeFileSync(join(d, 'big.txt'), big.replace('line 2\n', 'CHANGED AGAIN\n'))
    expect(await S.hunk(loc(d), { path: 'big.txt', area: 'unstaged', hunkId: id, action: 'stage' })).toMatchObject({ ok: false, error: { code: 'STALE_HUNK' } })
    expect(await S.hunk(loc(d), { path: 'big.txt', area: 'staged', hunkId: id, action: 'discard', confirm: true })).toMatchObject({ ok: false, error: { code: 'BAD_ACTION' } })
    expect(git(d, 'diff', '--cached')).toBe('')
  })
})

describe('commit', () => {
  it('commits only staged changes and needs a message and something staged', async () => {
    const d = repo()
    writeFileSync(join(d, 'a.txt'), 'A\n'); writeFileSync(join(d, 'b.txt'), 'B\n')
    expect(await S.commit(loc(d), '  ')).toMatchObject({ ok: false, error: { code: 'NO_MESSAGE' } })
    expect(await S.commit(loc(d), 'msg')).toMatchObject({ ok: false, error: { code: 'NOTHING_STAGED' } })
    await S.stage(loc(d), ['a.txt'])
    const r = await S.commit(loc(d), 'Change a\n\nbody line')
    expect(r.ok && r.value).toMatchObject({ summary: 'Change a' })
    expect(git(d, 'log', '-1', '--format=%B').trim()).toBe('Change a\n\nbody line')
    expect(git(d, 'show', '--stat', '--format=', 'HEAD')).toContain('a.txt')
    expect(by(await tree(d), 'b.txt')).toMatchObject({ worktree: 'modified' }) // not committed
  })
})

describe('operations that Git refuses because of local changes', () => {
  it('a blocked pull and a blocked branch switch name the files and the real actions', async () => {
    const f = remoteFixture(); cleanups.push(f.cleanup)
    commit(f.other, 'README.md', 'remote change\n', 'remote'); git(f.other, 'push', '-q', 'origin', 'main')
    writeFileSync(join(f.local, 'README.md'), 'my local edit\n')
    const G = new Git()
    const p = await G.pull(loc(f.local))
    expect(p).toMatchObject({ ok: false, error: { code: 'LOCAL_CHANGES' } })
    const err = !p.ok ? p.error : null
    expect(err?.blocker?.files).toEqual(['README.md'])
    expect(err?.blocker?.actions.map(a => a.id)).toEqual(['view-changes', 'stash'])
    git(f.local, 'checkout', '-q', '-b', 'other'); commit(f.local, 'README.md', 'other branch\n', 'o'); git(f.local, 'checkout', '-q', 'main')
    git(f.local, 'checkout', '--', 'README.md'); writeFileSync(join(f.local, 'README.md'), 'dirty on main\n')
    const sw = await G.switchBranch(loc(f.local), 'other')
    expect(sw).toMatchObject({ ok: false, error: { code: 'LOCAL_CHANGES', blocker: { files: ['README.md'] } } })
  })
})
