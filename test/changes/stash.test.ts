import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { StashService, parseStashList } from '../../src/core/git/stash.js'
import type { Location } from '../../src/shared/types.js'
import { commit, git, isolateGitConfig, tempDir } from '../helpers.js'

beforeAll(isolateGitConfig)
const loc = (path: string): Location => ({ kind: 'native', path })
const S = new StashService()
let cleanups: (() => void)[] = []
afterEach(() => { cleanups.forEach(c => c()); cleanups = [] })
function repo() {
  const t = tempDir(); cleanups.push(t.cleanup)
  git(t.dir, 'init', '-q', '-b', 'main'); commit(t.dir, 'a.txt', 'one\ntwo\nthree\n', 'a'); commit(t.dir, 'b.txt', 'b\n', 'b')
  return t.dir
}
const list = async (d: string) => { const r = await S.list(loc(d)); if (!r.ok) throw new Error(r.error.message); return r.value }

describe('stash', () => {
  it('parses the stash list format', () => {
    const e = parseStashList('stash@{0}\x1faaa\x1fOn main: my message\x1f1700000000\x1estash@{1}\x1fbbb\x1fWIP on dev: abc123 subject\x1f1600000000\x1e')
    expect(e).toMatchObject([{ index: 0, branch: 'main', message: 'my message', date: 1700000000000 }, { index: 1, branch: 'dev', message: 'abc123 subject' }])
  })

  it('stashes with a message, optionally with untracked files, and lists them', async () => {
    const d = repo()
    expect(await S.push(loc(d), {})).toMatchObject({ ok: false, error: { code: 'NOTHING_TO_STASH' } })
    writeFileSync(join(d, 'new.txt'), 'n')
    expect(await S.push(loc(d), {})).toMatchObject({ ok: false, error: { code: 'NOTHING_TO_STASH', message: expect.stringContaining('Include untracked') } })
    writeFileSync(join(d, 'a.txt'), 'A\n')
    const r = await S.push(loc(d), { message: 'work in progress', includeUntracked: true })
    expect(r.ok && r.value.entry).toMatchObject({ message: 'work in progress', branch: 'main', hasUntracked: true })
    expect(existsSync(join(d, 'new.txt'))).toBe(false)
    expect(readFileSync(join(d, 'a.txt'), 'utf8')).toBe('one\ntwo\nthree\n')
    writeFileSync(join(d, 'b.txt'), 'bb\n')
    const second = await S.push(loc(d), {})
    expect(second.ok && second.value.entry).toMatchObject({ hasUntracked: false })
    expect((await list(d)).map(e => e.index)).toEqual([0, 1])
    expect(await S.push(loc(d), { message: 'bad\nline' })).toMatchObject({ ok: false, error: { code: 'BAD_MESSAGE' } })
  })

  it('previews files and diffs, tracked and untracked', async () => {
    const d = repo()
    writeFileSync(join(d, 'a.txt'), 'A\ntwo\nthree\n'); writeFileSync(join(d, 'u.txt'), 'u1\nu2\n')
    await S.push(loc(d), { includeUntracked: true })
    const [e] = await list(d)
    const p = await S.preview(loc(d), e.index, e.sha)
    expect(p.ok && p.value.files).toEqual([{ status: 'M', path: 'a.txt', untracked: false }, { status: 'A', path: 'u.txt', untracked: true }])
    expect(p.ok && p.value.stat).toContain('1 file changed')
    const d1 = await S.fileDiff(loc(d), e.index, e.sha, 'a.txt', false)
    expect(d1.ok && d1.value).toMatchObject({ added: 1, removed: 1 })
    const d2 = await S.fileDiff(loc(d), e.index, e.sha, 'u.txt', true)
    expect(d2.ok && d2.value).toMatchObject({ added: 2, removed: 0 })
  })

  it('apply keeps the stash, pop removes it', async () => {
    const d = repo()
    writeFileSync(join(d, 'a.txt'), 'A\ntwo\nthree\n'); await S.push(loc(d), {})
    let [e] = await list(d)
    const a = await S.apply(loc(d), e.index, e.sha, false)
    expect(a.ok && a.value).toMatchObject({ applied: true, conflicts: [], dropped: false })
    expect(readFileSync(join(d, 'a.txt'), 'utf8')).toBe('A\ntwo\nthree\n')
    expect(await list(d)).toHaveLength(1)
    git(d, 'checkout', '--', 'a.txt')
    ;[e] = await list(d)
    const p = await S.apply(loc(d), e.index, e.sha, true)
    expect(p.ok && p.value).toMatchObject({ applied: true, dropped: true })
    expect(await list(d)).toHaveLength(0)
  })

  it('protects local changes: a stash that touches a changed file is refused before Git runs', async () => {
    const d = repo()
    writeFileSync(join(d, 'a.txt'), 'A\ntwo\nthree\n'); await S.push(loc(d), {})
    writeFileSync(join(d, 'a.txt'), 'LOCAL\ntwo\nthree\n')
    const [e] = await list(d)
    const r = await S.apply(loc(d), e.index, e.sha, false)
    expect(r).toMatchObject({ ok: false, error: { code: 'STASH_OVERLAP', blocker: { files: ['a.txt'] } } })
    expect(!r.ok && r.error.blocker?.actions.map(a => a.id)).toEqual(['view-changes', 'stash'])
    expect(readFileSync(join(d, 'a.txt'), 'utf8')).toBe('LOCAL\ntwo\nthree\n')
    expect(await list(d)).toHaveLength(1)
    // unrelated local changes do not block it
    git(d, 'checkout', '--', 'a.txt'); writeFileSync(join(d, 'b.txt'), 'other\n')
    expect((await S.apply(loc(d), e.index, e.sha, false)).ok).toBe(true)
  })

  it('reports merge conflicts accurately and keeps the stash on pop', async () => {
    const d = repo()
    writeFileSync(join(d, 'a.txt'), 'STASHED\ntwo\nthree\n'); await S.push(loc(d), {})
    commit(d, 'a.txt', 'COMMITTED\ntwo\nthree\n', 'conflicting commit')
    const [e] = await list(d)
    const r = await S.apply(loc(d), e.index, e.sha, true)
    expect(r.ok && r.value).toMatchObject({ applied: true, conflicts: ['a.txt'], dropped: false })
    expect(await list(d)).toHaveLength(1) // Git keeps the stash after a conflicted pop
    expect(await S.apply(loc(d), e.index, e.sha, false)).toMatchObject({ ok: false, error: { code: 'CONFLICTS' } })
  })

  it('drop needs confirmation and the exact stash; the dropped commit can be recovered', async () => {
    const d = repo()
    writeFileSync(join(d, 'a.txt'), 'A\n'); await S.push(loc(d), { message: 'one' })
    writeFileSync(join(d, 'a.txt'), 'B\n'); await S.push(loc(d), { message: 'two' })
    const [top, old] = await list(d)
    expect(await S.drop(loc(d), top.index, top.sha, false)).toMatchObject({ ok: false, error: { code: 'CONFIRM_REQUIRED' } })
    expect(await S.drop(loc(d), 0, old.sha, true)).toMatchObject({ ok: false, error: { code: 'STASH_CHANGED' } }) // position 0 holds another stash
    const r = await S.drop(loc(d), top.index, top.sha, true)
    expect(r.ok && r.value.recoverWith).toBe(`git stash apply ${top.sha}`)
    expect((await list(d)).map(e => e.message)).toEqual(['one'])
    expect(git(d, 'show', `${top.sha}:a.txt`)).toBe('B')
    expect(await S.apply(loc(d), -1, top.sha, false)).toMatchObject({ ok: false, error: { code: 'BAD_STASH' } })
  })
})
