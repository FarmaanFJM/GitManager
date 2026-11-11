import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Backend } from '../../src/main/backend.js'
import { Store } from '../../src/core/store.js'
import { RepoWatcher } from '../../src/core/git/watcher.js'
import { DEFAULT_SETTINGS } from '../../src/core/store.js'
import { commit, git, isolateGitConfig, remoteFixture, tempDir } from '../helpers.js'

beforeAll(isolateGitConfig)
let cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const c of cleanups) await c(); cleanups = [] })

async function setup(opts: { trash?: boolean; clipboard?: string } = {}) {
  const f = remoteFixture(); const cfg = tempDir()
  const trashed: string[] = []
  const store = new Store(join(cfg.dir, 'gitmanager.json'))
  const b = new Backend(store, {
    version: 'test', pickFolder: async () => null, openPath: async () => '', openExternal: async () => {},
    ...(opts.trash ? { trashItem: async (p: string) => { trashed.push(p); const { rmSync } = await import('node:fs'); rmSync(p) } } : {}),
    readClipboardText: () => opts.clipboard ?? '',
  })
  cleanups.push(async () => { b.watcher.stop(); await b.services.stopAll(); f.cleanup(); cfg.cleanup() })
  const added = await b.addRepo(f.local)
  if (!added.ok) throw new Error(added.error.message)
  return { f, b, id: added.value.repo.id, trashed, cfg }
}

describe('backend: working tree, stash and branches end to end', () => {
  it('lists changes, stages, commits and keeps the repository status counts consistent', async () => {
    const { f, b, id } = await setup()
    writeFileSync(join(f.local, 'README.md'), 'changed\n'); writeFileSync(join(f.local, 'new.txt'), 'n')
    const st = await b.status(id)
    expect(st.ok && st.value.changes).toMatchObject({ unstaged: 1, untracked: 1, files: 2 })
    expect((await b.changesStage(id, ['README.md'])).ok).toBe(true)
    const t = await b.changesRead(id)
    expect(t.ok && t.value.counts).toMatchObject({ staged: 1, untracked: 1, files: 2 })
    expect(await b.changesCommit(id, 'Update readme')).toMatchObject({ ok: true })
    const after = await b.status(id)
    expect(after.ok && after.value).toMatchObject({ ahead: 1, changes: { files: 1 } })
  })

  it('validates what the page sends', async () => {
    const { b, id } = await setup()
    await expect(b.changesStage(id, ['../escape'])).rejects.toThrow()
    await expect(b.changesStage(id, 'a.txt')).rejects.toThrow()
    await expect(b.changesDiff(id, { path: 'a', area: 'weird' })).rejects.toThrow()
    await expect(b.changesCommit(id, '')).rejects.toThrow()
    await expect(b.changesRead('nope')).rejects.toThrow()
    expect(await b.changesDiscard(id, ['README.md'], 'yes')).toMatchObject({ ok: false })
  })

  it('discard, restore and trash work through the backend and respect confirmation', async () => {
    const { f, b, id, trashed } = await setup({ trash: true })
    writeFileSync(join(f.local, 'README.md'), 'edited\n'); writeFileSync(join(f.local, 'junk.txt'), 'j')
    expect(await b.changesDiscard(id, ['README.md'], false)).toMatchObject({ ok: false, error: { code: 'CONFIRM_REQUIRED' } })
    expect(await b.changesDiscard(id, ['README.md'], true)).toMatchObject({ ok: true })
    expect(readFileSync(join(f.local, 'README.md'), 'utf8')).toBe('hello\n')
    expect(await b.changesDeleteUntracked(id, ['junk.txt'], { confirm: true })).toMatchObject({ ok: true, value: { method: 'trash' } })
    expect(trashed).toEqual([join(f.local, 'junk.txt')])
    expect(existsSync(join(f.local, 'junk.txt'))).toBe(false)
  })

  it('without a trash, untracked files need a separate permanent confirmation', async () => {
    const { f, b, id } = await setup()
    writeFileSync(join(f.local, 'junk.txt'), 'j')
    expect(await b.changesDeleteUntracked(id, ['junk.txt'], { confirm: true })).toMatchObject({ ok: false, error: { code: 'TRASH_UNAVAILABLE' } })
    expect(await b.changesDeleteUntracked(id, ['junk.txt'], { confirm: true, permanent: true })).toMatchObject({ ok: true, value: { method: 'permanent' } })
  })

  it('a pull blocked by local changes names the files and offers View Changes and Stash; a stash then lets the pull succeed', async () => {
    const { f, b, id } = await setup()
    commit(f.other, 'README.md', 'remote\n', 'remote edit'); git(f.other, 'push', '-q', 'origin', 'main')
    writeFileSync(join(f.local, 'README.md'), 'local edit\n')
    const p = await b.pull(id)
    expect(p).toMatchObject({ ok: false, error: { code: 'LOCAL_CHANGES', blocker: { files: ['README.md'], actions: [{ id: 'view-changes' }, { id: 'stash' }] } } })
    const s = await b.stashPush(id, { message: 'before pull' })
    expect(s).toMatchObject({ ok: true })
    expect((await b.pull(id)).ok).toBe(true)
    const list = await b.stashList(id)
    const e = list.ok ? list.value[0] : null!
    expect(e.message).toBe('before pull')
    // the stash edits README.md, which changed upstream: applying is a real merge conflict, reported as such and the stash is kept
    const pop = await b.stashPop(id, e.index, e.sha)
    expect(pop).toMatchObject({ ok: true, value: { conflicts: ['README.md'], dropped: false } })
  })

  it('a service running from the repository blocks a branch switch with its name and the stop action', async () => {
    const { f, b, id } = await setup()
    git(f.local, 'branch', 'other')
    const draft = await b.draftProfile(id)
    expect(draft.ok).toBe(true)
    ;(b.services as unknown as { activeForRepo: () => unknown[] }).activeForRepo = () => [{ key: 'p:s', profileId: 'p', serviceId: 's', repoId: id }]
    const r = await b.switchBranch(id, 'other')
    expect(r).toMatchObject({ ok: false, error: { code: 'SERVICES_RUNNING', blocker: { actions: [{ id: 'stop-services' }] } } })
  })

  it('bulk branch cleanup through the backend: analysis, partial results, recovery list and restore', async () => {
    const { f, b, id } = await setup()
    git(f.local, 'branch', 'done'); git(f.local, 'checkout', '-q', '-b', 'wip'); commit(f.local, 'w.txt', 'w', 'wip'); git(f.local, 'checkout', '-q', 'main')
    const a = await b.branchAnalyze(id, { sync: true })
    const rows = a.ok ? a.value.branches : []
    expect(a.ok && a.value.sync.ran).toBe(true)
    expect(Object.fromEntries(rows.map(r => [r.name, r.tier]))).toEqual({ main: 'blocked', done: 'safe', wip: 'force' })
    const sha = (n: string) => rows.find(r => r.name === n)!.sha
    const r = await b.branchDelete(id, [{ name: 'done', sha: sha('done'), force: false }, { name: 'wip', sha: sha('wip'), force: false }, { name: 'main', sha: sha('main'), force: true }])
    expect(r.ok && r.value.deleted.map(d => d.name)).toEqual(['done'])
    expect(r.ok && r.value.skipped.map(s => s.error.code).sort()).toEqual(['CURRENT_BRANCH', 'UNIQUE_COMMITS'].sort())
    const rec = await b.branchRecovery(id)
    expect(rec.ok && rec.value[0]).toMatchObject({ name: 'done', available: true })
    expect(await b.branchRestore(id, rec.ok ? rec.value[0].id : '')).toMatchObject({ ok: true, value: { name: 'done' } })
    expect(git(f.local, 'branch', '--list', 'done')).toContain('done')
    await expect(b.branchDelete(id, [])).rejects.toThrow()
  })

  it('reads the clipboard through the main process, never the page', async () => {
    const { b } = await setup({ clipboard: 'pasted text' })
    expect(await b.clipboardRead()).toBe('pasted text')
  })

  it('persists terminal preferences with the other settings and keeps old files working', async () => {
    const { b, cfg } = await setup()
    const s0 = b.store.data.settings
    expect(s0.terminal).toMatchObject({ selectToCopy: true, contextMenuCopy: true, rightClickPaste: true, scrollback: 5000 })
    await expect(b.saveSettings({ ...s0, terminal: { ...s0.terminal, fontSize: 4 } })).rejects.toThrow(/Font size/) // the IPC layer turns this into an error result
    const next = { ...s0, terminal: { ...s0.terminal, fontFamily: 'Consolas', fontSize: 16, lineHeight: 1.2, cursorStyle: 'bar', selectToCopy: false, rightClickPaste: false, defaultShell: 'pwsh' } }
    expect(await b.saveSettings(next)).toMatchObject({ ok: true })
    const reread = new Store(join(cfg.dir, 'gitmanager.json')).data.settings.terminal
    expect(reread).toMatchObject({ fontFamily: 'Consolas', fontSize: 16, lineHeight: 1.2, cursorStyle: 'bar', selectToCopy: false, contextMenuCopy: true, rightClickPaste: false, defaultShell: 'pwsh' })
    // a settings file written before v1.0.2 has no terminal section
    const old: Record<string, unknown> = { ...DEFAULT_SETTINGS }; delete old.terminal
    writeFileSync(join(cfg.dir, 'gitmanager.json'), JSON.stringify({ schemaVersion: 1, settings: old }))
    expect(new Store(join(cfg.dir, 'gitmanager.json')).data.settings.terminal).toMatchObject({ selectToCopy: true, fontSize: 13 })
  })
})

describe('repository watcher', () => {
  it('reports a change made by another Git command, once, and ignores lock files', async () => {
    const f = remoteFixture(); cleanups.push(() => f.cleanup())
    const w = new RepoWatcher(100)
    cleanups.push(() => w.stop())
    const events: string[] = []
    w.on('changed', (e: { repoId: string }) => events.push(e.repoId))
    expect(w.watch('r1', join(f.local, '.git'))).toBe(true)
    writeFileSync(join(f.local, 'x.txt'), 'x'); git(f.local, 'add', 'x.txt')
    await new Promise(r => setTimeout(r, 800))
    expect(events).toEqual(['r1'])
    git(f.local, 'branch', 'newbranch')
    await new Promise(r => setTimeout(r, 800))
    expect(events).toEqual(['r1', 'r1'])
    w.stop()
    git(f.local, 'commit', '-q', '-m', 'x')
    await new Promise(r => setTimeout(r, 400))
    expect(events).toHaveLength(2)
  })
})
