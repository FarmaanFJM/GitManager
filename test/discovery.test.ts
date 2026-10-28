import { execFileSync } from 'node:child_process'
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { AutoDiscovery } from '../src/core/autodiscovery.js'
import { classifyGitFile, commonTargets, discover, parseWslScan, wslScanScript, type Found } from '../src/core/discovery.js'
import { locationKey } from '../src/core/paths.js'
import { Store } from '../src/core/store.js'
import type { Location } from '../src/shared/types.js'
import { commit, git, isolateGitConfig, tempDir } from './helpers.js'

beforeAll(isolateGitConfig)
let cleanups: (() => void)[] = []
afterEach(() => { cleanups.forEach(c => c()); cleanups = [] })
const tmp = () => { const t = tempDir(); cleanups.push(t.cleanup); return t.dir }
const repo = (dir: string) => { mkdirSync(dir, { recursive: true }); git(dir, 'init', '-q', '-b', 'main'); commit(dir, 'a.txt', 'a', 'init'); return dir }
// Discovery returns real paths (on Windows the temp folder's 8.3 short name is expanded), so compare against the real root.
const rel = (root: string, f: Found[]) => { const base = realpathSync.native(root); return f.map(x => `${x.location.path.slice(base.length + 1).replace(/\\/g, '/')}${x.worktree ? ' (worktree)' : ''}`).sort() }

/** A home folder with the situations discovery must handle. */
function homeFixture() {
  const home = tmp()
  const main = repo(join(home, 'Projects', 'chess-engine'))
  git(main, 'worktree', 'add', '-q', join(home, 'Projects', 'chess-engine-review'), '-b', 'review')
  repo(join(home, 'Projects', 'web', 'shop'))
  const lib = repo(join(home, 'Projects', 'libs', 'lib-a'))
  execFileSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'vendored-lib'], { cwd: main, env: process.env })
  repo(join(home, 'Projects', 'web', 'shop', 'node_modules', 'some-dep')) // dependency folder
  repo(join(home, 'Projects', '.archive', 'old')) // hidden
  repo(join(home, 'Projects', 'a', 'b', 'c', 'd', 'too-deep')) // beyond the depth
  mkdirSync(join(home, 'Projects', 'not-a-repo', '.git'), { recursive: true }) // .git without HEAD
  repo(join(home, 'code', 'tool'))
  return { home }
}

describe('recognizing repositories', () => {
  it('classifies .git files: worktree, submodule, separate git dir', () => {
    expect(classifyGitFile('gitdir: /home/me/app/.git/worktrees/review\n')).toBe('worktree')
    expect(classifyGitFile('gitdir: C:\\code\\app\\.git\\worktrees\\fix')).toBe('worktree')
    expect(classifyGitFile('gitdir: ../.git/modules/vendored-lib\n')).toBe('submodule')
    expect(classifyGitFile('gitdir: /srv/git/app.git\n')).toBe('repository')
    expect(classifyGitFile('garbage')).toBeNull()
  })

  it('finds repositories and worktrees, skips submodules, dependencies, hidden folders and fake .git, within the depth', async () => {
    const { home } = homeFixture()
    const r = await discover({ kind: 'native', path: join(home, 'Projects') }, 3)
    expect(r.ok).toBe(true)
    expect(r.ok && rel(join(home, 'Projects'), r.value)).toEqual(['chess-engine', 'chess-engine-review (worktree)', 'libs/lib-a', 'web/shop'])
  })

  it('does not follow symbolic links, so a linked folder is not found twice', async () => {
    const { home } = homeFixture()
    symlinkSync(join(home, 'code'), join(home, 'Projects', 'code-link'))
    const r = await discover({ kind: 'native', path: home }, 3)
    const tools = r.ok ? r.value.filter(f => f.location.path.endsWith('tool')) : []
    expect(tools).toHaveLength(1)
  })

  it('skips folders it cannot read and keeps going', async () => {
    const { home } = homeFixture()
    const denied = join(home, 'Projects', 'web')
    const fake = (async (p: string, o?: unknown) => {
      if (String(p) === denied) { const e = new Error('EACCES: permission denied') as NodeJS.ErrnoException; e.code = 'EACCES'; throw e }
      return (readdir as (p: string, o?: unknown) => Promise<unknown>)(p, o)
    }) as unknown as typeof readdir
    const r = await discover({ kind: 'native', path: join(home, 'Projects') }, 3, { readdirImpl: fake })
    expect(r.ok && rel(join(home, 'Projects'), r.value)).toEqual(['chess-engine', 'chess-engine-review (worktree)', 'libs/lib-a'])
    const missing = await discover({ kind: 'native', path: join(home, 'nope') }, 3)
    expect(missing.ok).toBe(false)
  })

  it('stops at the folder budget', async () => {
    const { home } = homeFixture()
    const r = await discover({ kind: 'native', path: home }, 6, { maxDirs: 3 })
    expect(r.ok && r.value.length).toBeLessThanOrEqual(1)
  })

  it.skipIf(process.platform === 'win32')('the WSL scan script (run here with sh and find) gives the same result and never reports /mnt paths', async () => {
    const { home } = homeFixture()
    const out = execFileSync('sh', ['-c', wslScanScript(), 'sh', join(home, 'Projects'), '4'], { encoding: 'utf8' })
    expect(rel(join(home, 'Projects'), parseWslScan(out, 'Ubuntu'))).toEqual(['chess-engine', 'chess-engine-review (worktree)', 'libs/lib-a', 'web/shop'])
    expect(parseWslScan('R\t/mnt/c/code/app\nR\t/home/me/app\n', 'Ubuntu').map(f => f.location.path)).toEqual(['/home/me/app'])
  })
})

describe('common locations', () => {
  it('derives development folders from the home folder, not from a user name', async () => {
    const home = tmp()
    for (const d of ['Projects', 'source/repos', 'code']) mkdirSync(join(home, d), { recursive: true })
    const os = process.platform === 'win32' ? 'windows' : 'linux'
    const t = await commonTargets(os, home, { drives: [] })
    const names = t.map(x => x.location.path.slice(home.length + 1).replace(/\\/g, '/') || '(home)')
    expect(names).toEqual(expect.arrayContaining(['source/repos', 'Projects', 'code', '(home)']))
    expect(new Set(names.map(n => n.toLowerCase())).size).toBe(names.length) // Projects and projects are one folder on Windows
    expect(t.find(x => x.location.path === home)?.depth).toBe(1)
    if (os === 'linux') {
      const deep = await commonTargets('linux', home, { deep: true })
      expect(deep).toEqual([{ location: { kind: 'native', path: home }, depth: 5, label: home }])
    }
  })

  it.runIf(process.platform === 'win32')('finds drive-level folders such as C:\\Projects on Windows', async () => {
    const home = tmp()
    mkdirSync(join(home, 'Projects'))
    const t = await commonTargets('windows', home, { drives: [] })
    expect(t.some(x => x.location.path.toLowerCase() === join(home, 'Projects').toLowerCase())).toBe(true)
  })
})

describe('automatic registration', () => {
  function setup(extra: Partial<ConstructorParameters<typeof AutoDiscovery>[1]> = {}) {
    const { home } = homeFixture()
    const file = join(tmp(), 'gitmanager.json')
    const store = new Store(file)
    const d = new AutoDiscovery(store, { os: 'linux', home, ...extra })
    return { home, store, d, file }
  }

  it('registers what it finds once, keeps manual repositories and profiles, and reports progress', async () => {
    const { home, store, d, file } = setup()
    const manual = repo(join(tmp(), 'elsewhere'))
    const m = store.addRepo({ kind: 'native', path: manual })
    store.upsertProfile({ id: 'p1', repoId: m.repo.id, name: 'Dev', runtime: { kind: 'native' }, workingDir: '', services: [], openUrl: '', browser: 'default', trustedFingerprint: null })
    store.data.settings.editor = 'cursor'; store.save()
    const statuses: boolean[] = []
    const added: string[] = []
    d.on('status', s => statuses.push(s.running))
    d.on('added', r => added.push(r.name))
    const st = await d.run('common')
    expect(st.running).toBe(false)
    expect(statuses[0]).toBe(true)
    expect(added.sort()).toEqual(['chess-engine', 'chess-engine-review', 'lib-a', 'shop', 'tool'])
    expect(store.data.repos.find(r => r.name === 'chess-engine-review')?.worktree).toBe(true)
    expect(store.data.repos.filter(r => r.source === 'discovered')).toHaveLength(5)
    await d.run('common')
    expect(store.data.repos).toHaveLength(6)
    const reloaded = new Store(file)
    expect(reloaded.data.repos).toHaveLength(6)
    expect(reloaded.data.profiles).toHaveLength(1)
    expect(reloaded.data.settings.editor).toBe('cursor')
    expect(reloaded.data.discovery.lastRunAt).toBeTruthy()
    void home
  })

  it('never brings back a repository the user removed, across restarts, until it is added manually', async () => {
    const { store, d, file } = setup()
    await d.run('common')
    const shop = store.data.repos.find(r => r.name === 'shop')!
    store.removeRepo(shop.id)
    await d.run('common')
    expect(store.data.repos.some(r => r.name === 'shop')).toBe(false)
    const again = new Store(file)
    const d2 = new AutoDiscovery(again, { os: 'linux', home: (d as unknown as { deps: { home: string } }).deps.home })
    await d2.run('common')
    expect(again.data.repos.some(r => r.name === 'shop')).toBe(false)
    expect(again.data.ignored).toHaveLength(1)
    again.addRepo(shop.location) // a manual add lifts the removal
    expect(again.data.ignored).toHaveLength(0)
  })

  it('deduplicates the same folder reached through different representations', async () => {
    const file = join(tmp(), 'gitmanager.json')
    const store = new Store(file)
    store.addRepo({ kind: 'wsl', distro: 'Ubuntu', path: '/mnt/c/code/app' })
    const scan = async (root: Location): Promise<{ ok: true; value: Found[] }> => ({
      ok: true,
      value: root.kind === 'wsl'
        ? [{ location: { kind: 'wsl', distro: 'Ubuntu', path: '/home/me/chess' }, worktree: false }]
        : [{ location: { kind: 'native', path: 'C:\\Code\\App' }, worktree: false }, { location: { kind: 'native', path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\chess' }, worktree: false }],
    })
    const d = new AutoDiscovery(store, {
      os: 'windows', home: 'C:\\Users\\someone', drives: [], scan,
      distros: async () => [{ name: 'Ubuntu', version: 2 }, { name: 'Legacy', version: 1 }], wslHome: async () => '/home/me',
    })
    store.addRoot({ kind: 'native', path: 'C:\\Code' }, 3)
    await d.run('common')
    expect(store.data.repos.map(r => locationKey(r.location)).sort()).toEqual(['win:c:\\code\\app', 'wsl:ubuntu:/home/me/chess'])
    expect(locationKey({ kind: 'native', path: 'c:/code/app/' })).toBe(locationKey({ kind: 'wsl', distro: 'Debian', path: '/mnt/c/code/app' }))
  })

  it('reports unreadable locations without stopping the scan', async () => {
    const store = new Store(join(tmp(), 'gitmanager.json'))
    store.addRoot({ kind: 'native', path: '/definitely/missing' }, 3)
    const { home } = homeFixture()
    const st = await new AutoDiscovery(store, { os: 'linux', home }).run('common')
    expect(st.errors.some(e => e.includes('/definitely/missing'))).toBe(true)
    expect(store.data.repos.length).toBeGreaterThan(0)
  })

  it('a second request while scanning waits for the same scan', async () => {
    const { d } = setup()
    const [a, b] = await Promise.all([d.run('common'), d.run('common')])
    expect(a.finishedAt).toBe(b.finishedAt)
  })
})

// The fixtures above write files only; repositories are never modified by discovery.
it('discovery leaves repositories untouched', async () => {
  const { home } = homeFixture()
  const target = join(home, 'Projects', 'chess-engine')
  writeFileSync(join(target, 'wip.txt'), 'uncommitted')
  const before = [git(target, 'rev-parse', 'HEAD'), git(target, 'status', '--porcelain'), git(target, 'stash', 'list')]
  await new AutoDiscovery(new Store(join(tmp(), 'c.json')), { os: 'linux', home }).run('common')
  expect([git(target, 'rev-parse', 'HEAD'), git(target, 'status', '--porcelain'), git(target, 'stash', 'list')]).toEqual(before)
})
