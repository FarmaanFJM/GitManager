// Deleting a repository's local folder: the preview, every refusal, recoverable deletion, failures, and what GitManager forgets afterwards.
// Native repositories use real Git and a real file system in temporary folders; the recycle bin is a stand-in that moves the folder
// aside (the real one is Electron's shell.trashItem). WSL repositories run against the in-memory distribution of the runner tests.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Backend, type Host } from '../src/main/backend.js'
import { AutoDiscovery } from '../src/core/autodiscovery.js'
import { Git, type GitRun } from '../src/core/git/ops.js'
import { protectedPathReason } from '../src/core/repoDelete.js'
import { NativeShell, type HostShell } from '../src/core/runners/hosts.js'
import type { ServiceManager } from '../src/core/processes.js'
import { Store } from '../src/core/store.js'
import type { Location } from '../src/shared/types.js'
import { FakeShell } from './runners/fakes.js'
import { git as g, isolateGitConfig } from './helpers.js'

beforeAll(isolateGitConfig)
let dirs: string[] = []
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = [] })
const tmp = (p: string) => { const d = realpathSync(mkdtempSync(join(tmpdir(), p))); dirs.push(d); return d }

function mkrepo(parent: string, name: string, o: { commit?: boolean } = {}) {
  const dir = join(parent, name); mkdirSync(dir, { recursive: true })
  g(dir, 'init', '-q', '-b', 'main')
  if (o.commit !== false) { writeFileSync(join(dir, 'a.txt'), 'a'); g(dir, 'add', '.'); g(dir, 'commit', '-q', '-m', 'init') }
  return dir
}

type Over = { runners?: unknown; guardHome?: string; trash?: ((p: string) => Promise<void>) | null; shellFor?: (l: Location) => HostShell; services?: Partial<ServiceManager>; home?: string; os?: 'linux' | 'windows'; git?: Git }
function setup(o: Over = {}) {
  const work = tmp('gm-del-'); const home = o.home ?? join(work, 'home'); mkdirSync(home, { recursive: true })
  const code = join(home, 'code'); mkdirSync(code)
  const bin = join(work, 'bin'); mkdirSync(bin)
  const trashed: string[] = []
  const trash = async (p: string) => { const to = join(bin, `${trashed.length}-${p.split(/[\\/]/).pop()}`); renameSync(p, to); trashed.push(p) }
  const host: Host = { version: 't', pickFolder: async () => null, openPath: async () => '', openExternal: async () => {}, ...(o.trash === null ? {} : { trashItem: o.trash ?? trash }) }
  const store = new Store(join(work, 'gitmanager.json'))
  const services = { activeForRepo: () => [], stopAll: async () => {}, list: () => [], ...(o.services ?? {}) } as unknown as ServiceManager
  const b = new Backend(store, host, { os: o.os ?? 'linux', home: o.guardHome ?? home, services, ...(o.runners ? { runners: o.runners as never } : {}), ...(o.shellFor ? { shellFor: o.shellFor } : {}), ...(o.git ? { git: o.git } : {}) })
  const add = (path: string, extra: { worktree?: boolean } = {}) => store.addRepo({ kind: 'native', path }, { source: 'discovered', ...extra }).repo
  return { b, store, code, home, work, bin, trashed, add }
}

describe('the deletion preview', () => {
  it('describes a clean repository with its upstream, and allows it', async () => {
    const { b, code, add } = setup()
    const remote = join(code, '..', 'remote.git'); g(code, 'init', '-q', '--bare', '-b', 'main', remote)
    const dir = mkrepo(code, 'lied-stack'); g(dir, 'remote', 'add', 'origin', remote); g(dir, 'push', '-q', '-u', 'origin', 'main')
    const r = add(dir)
    const p = await b.deletionPreview(r.id); if (!p.ok) throw new Error(p.error.message)
    expect(p.value).toMatchObject({ name: 'lied-stack', display: dir, exists: true, blockers: [], losesWork: false, trash: { available: true }, runningServices: [], nestedRepos: [] })
    expect(p.value.facts).toMatchObject({ changes: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }, upstream: 'origin/main', ahead: 0, localOnlyCommits: 0 })
  })
  it('reports uncommitted changes, untracked files, unpushed commits and stashes as work that would be lost', async () => {
    const { b, code, add } = setup()
    const remote = join(code, '..', 'remote.git'); g(code, 'init', '-q', '--bare', '-b', 'main', remote)
    const dir = mkrepo(code, 'proj'); g(dir, 'remote', 'add', 'origin', remote); g(dir, 'push', '-q', '-u', 'origin', 'main')
    writeFileSync(join(dir, 'b.txt'), 'b'); g(dir, 'add', 'b.txt'); g(dir, 'commit', '-q', '-m', 'local only')
    writeFileSync(join(dir, 'a.txt'), 'changed'); writeFileSync(join(dir, 'new.txt'), 'x')
    const p = await b.deletionPreview(add(dir).id); if (!p.ok) throw new Error()
    expect(p.value.facts.changes).toMatchObject({ unstaged: 1, untracked: 1 })
    expect(p.value.facts.ahead).toBe(1)
    expect(p.value.losesWork).toBe(true)
    expect(p.value.blockers).toEqual([])
    expect(p.value.warnings.join(' ')).toMatch(/uncommitted changes, untracked files, 1 commit not on origin\/main/)
  })
  it('counts commits that exist on no remote when there is no upstream', async () => {
    const { b, code, add } = setup()
    const p = await b.deletionPreview(add(mkrepo(code, 'solo')).id); if (!p.ok) throw new Error()
    expect(p.value.facts).toMatchObject({ upstream: null, ahead: null, localOnlyCommits: 1 })
    expect(p.value.losesWork).toBe(true)
  })
  it('lists nested repositories and submodule entries, and lists nothing for plain folders', async () => {
    const { b, code, add } = setup()
    const dir = mkrepo(code, 'outer'); mkrepo(dir, 'vendor-lib'); mkdirSync(join(dir, 'docs'))
    mkdirSync(join(dir, 'sub')); writeFileSync(join(dir, 'sub', '.git'), 'gitdir: ../.git/modules/sub\n')
    writeFileSync(join(dir, '.gitmodules'), '[submodule "sub"]\n\tpath = sub\n\turl = x\n')
    const p = await b.deletionPreview(add(dir).id); if (!p.ok) throw new Error()
    expect(p.value.nestedRepos).toEqual(['vendor-lib']); expect(p.value.submodules).toEqual(['sub'])
    expect(p.value.blockers).toEqual([]); expect(p.value.warnings.join(' ')).toMatch(/1 nested repository/)
  })
  it('reports a folder that no longer exists', async () => {
    const { b, code, add } = setup()
    const dir = mkrepo(code, 'gone'); const r = add(dir); rmSync(dir, { recursive: true })
    const p = await b.deletionPreview(r.id); if (!p.ok) throw new Error()
    expect(p.value).toMatchObject({ exists: false, blockers: [] }); expect(p.value.warnings.join(' ')).toMatch(/no longer exists/)
  })
})

describe('path protection', () => {
  it('never allows roots, drive roots, system folders, home folders or their ancestors, on every path flavour', () => {
    const n = (path: string): Location => ({ kind: 'native', path })
    for (const p of ['/', '/usr', '/etc', '/home', '/home/me', '/Users/me', '/usr/lib/thing', '/home/me/Documents', '/mnt/c']) expect(protectedPathReason(n(p), '/home/me'), p).not.toBeNull()
    expect(protectedPathReason(n('/home'), '/home/me')).not.toBeNull()
    for (const p of ['C:\\', 'C:\\Windows', 'C:\\Users', 'C:\\Windows\\System32', 'C:\\Program Files\\App', 'C:\\Users\\me', 'C:\\Users\\me\\Desktop', '\\\\server\\share']) expect(protectedPathReason(n(p), 'C:\\Users\\me'), p).not.toBeNull()
    expect(protectedPathReason(n('C:\\'), 'C:\\Users\\me')).not.toBeNull(); expect(protectedPathReason(n('c:\\users\\ME'), 'C:\\Users\\me')).not.toBeNull()
    expect(protectedPathReason({ kind: 'wsl', distro: 'Ubuntu', path: '/home/farmaan' }, '/x')).not.toBeNull()
    expect(protectedPathReason({ kind: 'wsl', distro: 'Ubuntu', path: '/mnt/c/Users' }, '/x')).not.toBeNull()
    for (const [p, h] of [['/home/me/code/lied-stack', '/home/me'], ['C:\\Users\\me\\code\\lied-stack', 'C:\\Users\\me'], ['D:\\dev\\app', 'C:\\Users\\me'], ['/srv/app/repo', '/home/me']] as const) expect(protectedPathReason(n(p), h), p).toBeNull()
    expect(protectedPathReason({ kind: 'wsl', distro: 'Ubuntu', path: '/home/farmaan/code/lied-stack' }, '/x')).toBeNull()
  })
  it('blocks the home folder, a parent of other registered repositories, a discovery root and a runner installation', async () => {
    const { b, code, home, add, store } = setup()
    mkdirSync(join(home, '.git')); const homeRepo = add(home)
    expect((await b.deletionPreview(homeRepo.id) as { ok: true; value: { blockers: string[] } }).value.blockers.join(' ')).toMatch(/home folder/)
    rmSync(join(home, '.git'), { recursive: true }); store.removeRepo(homeRepo.id)
    const parent = mkrepo(code, 'parent'); mkrepo(parent, 'child-a'); const parentRepo = add(parent); add(join(parent, 'child-a'))
    const pp = await b.deletionPreview(parentRepo.id); if (!pp.ok) throw new Error()
    expect(pp.value.blockers.join(' ')).toMatch(/contains 1 other repository registered in GitManager \(child-a\)/)
    const r = await b.deleteRepoFolder(parentRepo.id, { confirmPath: parent })
    expect(r).toMatchObject({ ok: false, error: { code: 'REFUSED' } }); expect(existsSync(join(parent, 'child-a', '.git'))).toBe(true)
    const lone = add(mkrepo(code, 'lone')); store.addRoot({ kind: 'native', path: join(code, 'lone') }, 2)
    expect((await b.deletionPreview(lone.id) as { ok: true; value: { blockers: string[] } }).value.blockers.join(' ')).toMatch(/discovery root/)
    const withRoot = add(mkrepo(code, 'has-root')); store.addRoot({ kind: 'native', path: join(code, 'has-root', 'inner') }, 2)
    expect((await b.deletionPreview(withRoot.id) as { ok: true; value: { blockers: string[] } }).value.blockers.join(' ')).toMatch(/discovery root .* is inside/)
  })
  it('blocks a symbolic link, a submodule folder, and a folder that is not a repository root', async () => {
    const { b, code, add } = setup()
    const real = mkrepo(code, 'real'); const link = join(code, 'link'); symlinkSync(real, link, 'dir')
    expect((await b.deletionPreview(add(link).id) as { ok: true; value: { blockers: string[] } }).value.blockers.join(' ')).toMatch(/symbolic link or junction/)
    const r = await b.deleteRepoFolder(add(link).id, { confirmPath: link }); expect(r).toMatchObject({ ok: false, error: { code: 'REFUSED' } }); expect(existsSync(real)).toBe(true)
    const sub = join(code, 'subm'); mkdirSync(sub); writeFileSync(join(sub, '.git'), 'gitdir: /x/.git/modules/subm\n')
    expect((await b.deletionPreview(add(sub).id) as { ok: true; value: { blockers: string[] } }).value.blockers.join(' ')).toMatch(/submodule/)
    const plain = join(code, 'plain'); mkdirSync(plain)
    expect((await b.deletionPreview(add(plain).id) as { ok: true; value: { blockers: string[] } }).value.blockers.join(' ')).toMatch(/not the root of a repository/)
  })
  it('blocks while GitManager-managed services run, and only then allows the deletion', async () => {
    let running = true
    const { b, code, add, trashed } = setup({ services: { activeForRepo: () => (running ? [{ profileId: 'p', serviceId: 'web' }] : []) as never } })
    const dir = mkrepo(code, 'svc'); const r = add(dir)
    const refused = await b.deleteRepoFolder(r.id, { confirmPath: dir })
    expect(refused).toMatchObject({ ok: false, error: { code: 'REFUSED', message: expect.stringMatching(/Services started by GitManager are running/) } })
    expect(existsSync(dir)).toBe(true); expect(trashed).toEqual([])
    running = false
    expect(await b.deleteRepoFolder(r.id, { confirmPath: dir })).toMatchObject({ ok: true, value: { deleted: true } })
  })
  it('blocks a repository whose linked worktree lives elsewhere, and prunes the record when the worktree itself is deleted', async () => {
    const { b, code, add, store } = setup()
    const main = mkrepo(code, 'main'); const wt = join(code, 'main-wt'); g(main, 'worktree', 'add', '-q', '-b', 'feature', wt)
    const mainRepo = add(main), wtRepo = add(wt, { worktree: true })
    const pm = await b.deletionPreview(mainRepo.id); if (!pm.ok) throw new Error()
    expect(pm.value.linkedWorktrees).toMatchObject([{ path: wt, exists: true, inside: false }]); expect(pm.value.blockers.join(' ')).toMatch(/linked worktree of this repository exists outside it/)
    expect(await b.deleteRepoFolder(mainRepo.id, { confirmPath: main })).toMatchObject({ ok: false, error: { code: 'REFUSED' } }); expect(existsSync(join(main, '.git'))).toBe(true)
    const pw = await b.deletionPreview(wtRepo.id); if (!pw.ok) throw new Error()
    expect(pw.value.worktreeOf).toBe(main); expect(pw.value.blockers).toEqual([]); expect(pw.value.warnings.join(' ')).toMatch(/linked worktree of /)
    const del = await b.deleteRepoFolder(wtRepo.id, { confirmPath: wt })
    expect(del).toMatchObject({ ok: true, value: { deleted: true } }); expect(del.ok && del.value.notes.join(' ')).toMatch(/Pruned the stale worktree record/)
    expect(existsSync(wt)).toBe(false); expect(g(main, 'worktree', 'list', '--porcelain')).not.toMatch(/main-wt/)
    expect(store.data.repos.map(r => r.name)).toEqual(['main'])
  })
})

describe('deleting', () => {
  it('moves the folder to the trash after an exact confirmation and forgets it, its profiles and its selection, leaving other repositories alone', async () => {
    const { b, store, code, add, trashed, bin } = setup()
    const keepDir = mkrepo(code, 'keep'), dir = mkrepo(code, 'lied-stack')
    const keep = add(keepDir), r = add(dir)
    store.upsertProfile({ id: 'p1', repoId: r.id, name: 'dev', services: [], trusted: null } as never); store.upsertProfile({ id: 'p2', repoId: keep.id, name: 'dev', services: [], trusted: null } as never)
    store.data.ui.selectedRepoId = r.id; store.data.ui.selectedProfile[r.id] = 'p1'; store.data.compareBase[r.id] = 'main'; store.save()
    writeFileSync(join(dir, 'unsaved.txt'), 'x') // untracked work: deletion is still allowed after the explicit confirmation
    const res = await b.deleteRepoFolder(r.id, { confirmPath: dir })
    expect(res).toMatchObject({ ok: true, value: { deleted: true, alreadyGone: false, method: 'trash', removedRepoIds: [r.id] } })
    expect(res.ok && res.value.message).toContain(dir)
    expect(existsSync(dir)).toBe(false); expect(trashed).toEqual([dir]); expect(readdirSync(bin)).toHaveLength(1)
    expect(existsSync(join(bin, readdirSync(bin)[0], 'unsaved.txt'))).toBe(true) // recoverable, with its files
    expect(store.data.repos.map(x => x.name)).toEqual(['keep']); expect(store.data.profiles.map(p => p.id)).toEqual(['p2'])
    expect(store.data.ui.selectedRepoId).toBeNull(); expect(store.data.ui.selectedProfile[r.id]).toBeUndefined(); expect(store.data.compareBase[r.id]).toBeUndefined()
    expect(store.data.ignored).toEqual([]); expect(existsSync(join(keepDir, '.git'))).toBe(true)
    expect(new Store(store.file).data.repos.map(x => x.name)).toEqual(['keep']) // persisted
  })
  it('deletes nothing unless the confirmed path is exactly the repository path', async () => {
    const { b, code, add, trashed } = setup()
    const dir = mkrepo(code, 'proj'); const r = add(dir)
    for (const wrong of [dir + '/', join(dir, '..'), code, 'proj', dir.toUpperCase()]) {
      const res = await b.deleteRepoFolder(r.id, { confirmPath: wrong })
      expect(res.ok).toBe(false)
    }
    expect(await b.deleteRepoFolder(r.id, { confirmPath: code })).toMatchObject({ error: { code: 'CONFIRM_MISMATCH' } })
    expect(existsSync(dir)).toBe(true); expect(trashed).toEqual([])
  })
  it('handles a folder that is already gone: nothing deleted, GitManager cleaned up, truthfully reported', async () => {
    const { b, store, code, add, trashed } = setup()
    const dir = mkrepo(code, 'gone'); const r = add(dir); rmSync(dir, { recursive: true })
    const res = await b.deleteRepoFolder(r.id, { confirmPath: dir })
    expect(res).toMatchObject({ ok: true, value: { deleted: false, alreadyGone: true, method: null } }); expect(res.ok && res.value.message).toMatch(/no longer exists, so nothing was deleted/)
    expect(trashed).toEqual([]); expect(store.data.repos).toEqual([])
  })
  it('never falls back to permanent deletion when the trash is missing, and needs a separate confirmation for it', async () => {
    const { b, code, add, store } = setup({ trash: null })
    const dir = mkrepo(code, 'proj'); const r = add(dir)
    const p = await b.deletionPreview(r.id); expect(p.ok && p.value.trash.available).toBe(false)
    expect(await b.deleteRepoFolder(r.id, { confirmPath: dir })).toMatchObject({ ok: false, error: { code: 'TRASH_UNAVAILABLE', message: expect.stringMatching(/Nothing was deleted/) } })
    expect(existsSync(dir)).toBe(true)
    expect(await b.deleteRepoFolder(r.id, { confirmPath: dir, permanent: true })).toMatchObject({ ok: false, error: { code: 'CONFIRM_REQUIRED' } }) // permanent alone is not enough
    expect(existsSync(dir)).toBe(true); expect(store.data.repos).toHaveLength(1)
    expect(await b.deleteRepoFolder(r.id, { confirmPath: dir, permanent: true, confirmPermanent: true })).toMatchObject({ ok: true, value: { deleted: true, method: 'permanent' } })
    expect(existsSync(dir)).toBe(false); expect(store.data.repos).toEqual([])
  })
  it('reports a failing trash without deleting anything or forgetting the repository', async () => {
    const { b, code, add, store } = setup({ trash: async () => { throw new Error('The folder is on a drive without a Recycle Bin') } })
    const dir = mkrepo(code, 'proj'); const r = add(dir)
    expect(await b.deleteRepoFolder(r.id, { confirmPath: dir })).toMatchObject({ ok: false, error: { code: 'TRASH_FAILED', message: expect.stringMatching(/without a Recycle Bin.*Nothing was deleted/s) } })
    expect(existsSync(join(dir, '.git'))).toBe(true); expect(store.data.repos).toHaveLength(1)
  })
  it('never claims success when the trash reports success but the folder is still there', async () => {
    const { b, code, add, store } = setup({ trash: async () => {} })
    const dir = mkrepo(code, 'proj'); const r = add(dir)
    const res = await b.deleteRepoFolder(r.id, { confirmPath: dir })
    expect(res).toMatchObject({ ok: false, error: { code: 'PARTIAL', message: expect.stringMatching(/still exists after the deletion.*stays in GitManager/s) } })
    expect(store.data.repos).toHaveLength(1)
  })
  it('reports a partial permanent deletion (a locked file) exactly: what remains, and that the repository stays', async () => {
    // a shell that deletes everything except one "locked" file and then fails, as Windows does for a file held open by another program
    class LockedShell extends NativeShell {
      override async remove(p: string) { const { rmSync: rm, readdirSync: ls } = await import('node:fs'); for (const n of ls(p)) if (n !== 'locked.bin') rm(join(p, n), { recursive: true, force: true }); return { ok: false, message: 'EBUSY: resource busy or locked, unlink locked.bin' } }
    }
    const { b, code, add, store } = setup({ trash: null, shellFor: () => new LockedShell() })
    const dir = mkrepo(code, 'proj'); writeFileSync(join(dir, 'locked.bin'), 'x'); const r = add(dir)
    const res = await b.deleteRepoFolder(r.id, { confirmPath: dir, permanent: true, confirmPermanent: true })
    expect(res).toMatchObject({ ok: false, error: { code: 'PARTIAL', message: expect.stringMatching(/did not complete: EBUSY.*1 item remains in .*stays in GitManager/s) } })
    expect(res.ok === false && res.error.message).not.toMatch(/was deleted/)
    expect(existsSync(join(dir, 'locked.bin'))).toBe(true); expect(store.data.repos).toHaveLength(1)
  })
})

describe('automatic discovery after removal and deletion', () => {
  const discoverer = (store: Store, home: string, code: string) => { store.addRoot({ kind: 'native', path: code }, 3); return new AutoDiscovery(store, { os: 'linux', home }) }
  it('does not bring back a repository removed from GitManager (files untouched), after a rescan or a restart, and a manual add lifts the removal', async () => {
    const { b, store, code, home, add } = setup()
    const dir = mkrepo(code, 'old-project'); mkrepo(code, 'other')
    const d = discoverer(store, home, code); await d.run('common')
    expect(store.data.repos.map(r => r.name).sort()).toEqual(['old-project', 'other'])
    const r = store.data.repos.find(x => x.name === 'old-project')!
    expect(await b.removeRepo(r.id)).toMatchObject({ ok: true })
    expect(existsSync(join(dir, '.git'))).toBe(true)
    await d.run('common'); expect(store.data.repos.map(x => x.name)).toEqual(['other'])
    const restarted = new Store(store.file); await discoverer(restarted, home, code).run('common'); expect(restarted.data.repos.map(x => x.name)).toEqual(['other'])
    expect((await new Backend(restarted, { version: 't', pickFolder: async () => null, openPath: async () => '', openExternal: async () => {} }, { os: 'linux', home }).addRepo(dir)).ok).toBe(true)
    void add
  })
  it('does not resurrect a deleted repository from stale records, keeps the others, and finds a folder that is restored later like any other', async () => {
    const { b, store, code, home, add, bin } = setup()
    const dir = mkrepo(code, 'lied-stack'); mkrepo(code, 'keep')
    const d = discoverer(store, home, code); await d.run('common')
    const r = store.data.repos.find(x => x.name === 'lied-stack')!
    expect(await b.deleteRepoFolder(r.id, { confirmPath: dir })).toMatchObject({ ok: true })
    await d.run('common'); expect(store.data.repos.map(x => x.name)).toEqual(['keep'])
    const restarted = new Store(store.file); await discoverer(restarted, home, code).run('common'); expect(restarted.data.repos.map(x => x.name)).toEqual(['keep'])
    renameSync(join(bin, readdirSync(bin)[0]), dir) // restored from the trash
    await d.run('common'); expect(store.data.repos.map(x => x.name).sort()).toEqual(['keep', 'lied-stack'])
    void add
  })
})

describe('WSL repositories', () => {
  const DISTRO = 'Ubuntu-24.04'
  const loc = (path: string): Location => ({ kind: 'wsl', distro: DISTRO, path })
  /** A Git that answers like the distribution's git for a fixed state. */
  const gitFor = (state: { status?: string; localOnly?: number; stash?: string } = {}): Git => new Git((async (_l, args) => {
    const r = (stdout: string, code = 0) => ({ code, stdout, stderr: '', timedOut: false })
    if (args[0] === 'status') return r(state.status ?? '# branch.oid abc\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +0 -0\0')
    if (args[0] === 'remote') return r('origin\n')
    if (args[0] === 'rev-list') return r(`${state.localOnly ?? 0}\n`)
    if (args[0] === 'stash') return r(state.stash ?? '')
    return r('')
  }) as GitRun)
  function wslSetup(o: { trashTool?: 'gio' | 'trash-put' | null; git?: Git } = {}) {
    const wsl = new FakeShell({ kind: 'wsl', distro: DISTRO }); wsl.mkdir('/home/farmaan/code')
    const trashed: string[] = []
    const move = (p: string) => { for (const k of [...wsl.files.keys()]) if (k === p || k.startsWith(p + '/')) wsl.files.delete(k); for (const d of [...wsl.dirs]) if (d === p || d.startsWith(p + '/')) wsl.dirs.delete(d); trashed.push(p) }
    wsl.handlers.push((c, sh) => {
      if (c.file === 'sh' && /command -v gio/.test(c.args[1] ?? '')) return { code: 0, stdout: o.trashTool === null ? '' : `${o.trashTool ?? 'gio'}\n`, stderr: '', timedOut: false }
      if (c.file === 'gio' || c.file === 'trash-put') { const t = o.trashTool ?? 'gio'; if (c.file !== t) return { code: 127, stdout: '', stderr: 'not found', timedOut: false }; move(c.args[c.args.length - 1]); return { code: 0, stdout: '', stderr: '', timedOut: false } }
      void sh; return undefined
    })
    const s = setup({ os: 'windows', trash: async () => { throw new Error('windows recycle bin must not be used for Linux files') }, shellFor: l => (l.kind === 'wsl' ? wsl : new NativeShell({ os: 'windows' })), git: o.git ?? gitFor(), guardHome: 'C:\\Users\\me' })
    const repo = (path: string) => { wsl.mkdir(path + '/.git'); wsl.mkfile(path + '/README.md', 'x'); return s.store.addRepo(loc(path), { source: 'discovered' }).repo }
    return { ...s, wsl, wslTrashed: trashed, repo }
  }

  it('inspects the repository inside its distribution and moves it to that distribution\'s trash, not the Windows Recycle Bin', async () => {
    const { b, repo, wsl, wslTrashed, store } = wslSetup()
    const r = repo('/home/farmaan/code/lied-stack'); repo('/home/farmaan/code/keep')
    const p = await b.deletionPreview(r.id); if (!p.ok) throw new Error(p.error.message)
    expect(p.value).toMatchObject({ display: `${DISTRO}: /home/farmaan/code/lied-stack`, environment: `WSL: ${DISTRO}`, blockers: [], trash: { available: true, label: `Trash in ${DISTRO}` } })
    expect(await b.deleteRepoFolder(r.id, { confirmPath: '/home/farmaan/code/lied-stack' })).toMatchObject({ ok: true, value: { deleted: true, method: 'trash', message: expect.stringContaining(`Trash in ${DISTRO}`) } })
    expect(wslTrashed).toEqual(['/home/farmaan/code/lied-stack']); expect(wsl.dirs.has('/home/farmaan/code/lied-stack')).toBe(false); expect(wsl.dirs.has('/home/farmaan/code/keep/.git')).toBe(true)
    expect(store.data.repos.map(x => x.name)).toEqual(['keep'])
  })
  it('falls back to trash-put when gio is missing', async () => {
    const { b, repo, wslTrashed } = wslSetup({ trashTool: 'trash-put' })
    const r = repo('/home/farmaan/code/app')
    expect(await b.deleteRepoFolder(r.id, { confirmPath: '/home/farmaan/code/app' })).toMatchObject({ ok: true, value: { deleted: true } }); expect(wslTrashed).toEqual(['/home/farmaan/code/app'])
  })
  it('explains that recoverable deletion is impossible without a trash tool, and permanent deletion needs its own confirmation', async () => {
    const { b, repo, wsl } = wslSetup({ trashTool: null })
    const r = repo('/home/farmaan/code/app')
    const p = await b.deletionPreview(r.id); expect(p.ok && p.value.trash).toMatchObject({ available: false, reason: expect.stringMatching(/no trash tool.*Recoverable deletion is not possible/s) })
    expect(await b.deleteRepoFolder(r.id, { confirmPath: '/home/farmaan/code/app' })).toMatchObject({ ok: false, error: { code: 'TRASH_UNAVAILABLE' } }); expect(wsl.dirs.has('/home/farmaan/code/app/.git')).toBe(true)
    expect(await b.deleteRepoFolder(r.id, { confirmPath: '/home/farmaan/code/app', permanent: true, confirmPermanent: true })).toMatchObject({ ok: true, value: { deleted: true, method: 'permanent' } })
    expect(wsl.dirs.has('/home/farmaan/code/app')).toBe(false)
  })
  it('reports unsaved work from the distribution\'s Git and refuses the distribution home, a link and a missing folder correctly', async () => {
    const dirty = '# branch.oid abc\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +3 -0\0' + '1 .M N... 100644 100644 100644 a a a.txt\0? new.txt\0'
    const { b, repo, wsl, store } = wslSetup({ git: gitFor({ status: dirty, stash: 'stash@{0}: WIP\n' }) })
    const r = repo('/home/farmaan/code/app')
    const p = await b.deletionPreview(r.id); if (!p.ok) throw new Error()
    expect(p.value.facts).toMatchObject({ ahead: 3, upstream: 'origin/main', stashes: 1, changes: { unstaged: 1, untracked: 1 } }); expect(p.value.losesWork).toBe(true)
    const home = repo('/home/farmaan'); expect((await b.deletionPreview(home.id) as { ok: true; value: { blockers: string[] } }).value.blockers.join(' ')).toMatch(/home folder/)
    wsl.realpaths['/home/farmaan/code/app'] = '/data/app'
    expect((await b.deletionPreview(r.id) as { ok: true; value: { blockers: string[] } }).value.blockers.join(' ')).toMatch(/symbolic link or junction \(it resolves to \/data\/app\)/)
    delete wsl.realpaths['/home/farmaan/code/app']; wsl.dirs.delete('/home/farmaan/code/app')
    expect(await b.deleteRepoFolder(r.id, { confirmPath: '/home/farmaan/code/app' })).toMatchObject({ ok: true, value: { alreadyGone: true } })
    expect(store.data.repos.map(x => x.location.path)).toEqual(['/home/farmaan'])
  })
  it('does not delete a WSL folder that contains a runner installation (it would take the runner, its credentials and work folder)', async () => {
    const runners = { inventory: () => ({ runners: [{ local: { host: { kind: 'wsl', distro: DISTRO }, path: '/home/farmaan/code/app/actions-runner' } }], retired: [] }) }
    const s = wslSetup(); const r = s.repo('/home/farmaan/code/app')
    const b = new Backend(s.store, { version: 't', pickFolder: async () => null, openPath: async () => '', openExternal: async () => {} }, { os: 'windows', home: 'C:\\Users\\me', runners: runners as never, git: gitFor(), shellFor: l => (l.kind === 'wsl' ? s.wsl : new NativeShell({ os: 'windows' })), services: { activeForRepo: () => [], list: () => [] } as never })
    const p = await b.deletionPreview(r.id); if (!p.ok) throw new Error()
    expect(p.value.runnerInstallations).toEqual(['/home/farmaan/code/app/actions-runner']); expect(p.value.blockers.join(' ')).toMatch(/runner installation is inside this folder/)
    expect(await b.deleteRepoFolder(r.id, { confirmPath: '/home/farmaan/code/app' })).toMatchObject({ ok: false, error: { code: 'REFUSED' } }); expect(s.wsl.dirs.has('/home/farmaan/code/app/.git')).toBe(true)
  })
})

describe('the words of the removal and deletion flows', async () => {
  const { deletionRows, removeWords, deleteWords } = await import('../src/renderer/deleteText.js')
  const base = { repoId: 'r', name: 'lied-stack', location: { kind: 'native', path: '/home/me/code/lied-stack' }, display: '/home/me/code/lied-stack', environment: 'Linux', exists: true, resolvedPath: '/home/me/code/lied-stack',
    facts: { changes: { staged: 0, unstaged: 2, untracked: 1, conflicted: 0 }, upstream: 'origin/main', ahead: 3, localOnlyCommits: 3, stashes: 0 }, runningServices: [], nestedRepos: ['vendor'], linkedWorktrees: [], worktreeOf: null, submodules: [], runnerInstallations: [], containedRepos: [],
    trash: { available: true, label: 'Trash', reason: null }, blockers: [], warnings: [], losesWork: true, inspectedAt: '' } as never
  it('lists exactly what the confirmation must show: folder, environment, changes, untracked files, unpushed commits, services, nested data', () => {
    const rows = Object.fromEntries(deletionRows(base).map(r => [r.label, r]))
    expect(rows.Folder.value).toBe('/home/me/code/lied-stack'); expect(rows.Where.value).toBe('Linux')
    expect(rows.Uncommitted).toMatchObject({ value: 'Yes (2 modified)', warn: true }); expect(rows.Untracked).toMatchObject({ value: 'Yes (1 file)', warn: true })
    expect(rows.Unpushed.value).toBe('3 commits not on origin/main'); expect(rows.Services).toMatchObject({ value: 'None running', warn: false }); expect(rows['Also in it'].value).toMatch(/1 nested repository \(vendor\)/)
  })
  it('keeps "Remove from GitManager" and "Delete local folder" unmistakably different', () => {
    expect(removeWords.title('lied-stack')).toBe('Remove lied-stack from GitManager?'); expect(deleteWords.title('lied-stack')).toBe('Delete the local folder of lied-stack?')
    expect(removeWords.confirm).toBe('Remove from GitManager'); expect(deleteWords.confirm('Recycle Bin')).toBe('Move folder to Recycle Bin'); expect(deleteWords.permanent).toBe('Delete permanently')
    expect(removeWords.confirm).not.toMatch(/delete|folder/i); expect(deleteWords.confirm('Trash')).not.toMatch(/remove/i)
  })
})
