import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Backend } from '../src/main/backend.js'
import { Store } from '../src/core/store.js'
import { API_METHODS } from '../src/shared/api.js'
import { git, isolateGitConfig, remoteFixture, tempDir } from './helpers.js'

beforeAll(isolateGitConfig)
const FIXTURE = join(__dirname, 'fixtures', 'service.cjs')
let cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const c of cleanups) await c(); cleanups = [] })

async function freePort(): Promise<number> {
  return new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)) }) })
}

function setup() {
  const f = remoteFixture()
  const cfg = tempDir()
  const opened: string[] = []
  const store = new Store(join(cfg.dir, 'gitmanager.json'))
  const b = new Backend(store, { version: 'test', pickFolder: async () => null, openPath: async p => { opened.push(p); return '' }, openExternal: async u => { opened.push(u) } })
  cleanups.push(async () => { await b.services.stopAll(); f.cleanup(); cfg.cleanup() })
  return { f, b, opened, cfgFile: join(cfg.dir, 'gitmanager.json') }
}

describe('backend', () => {
  it('registers only real repositories and remembers them', async () => {
    const { f, b, cfgFile } = setup()
    const bad = await b.addRepo(f.dir)
    expect(!bad.ok && bad.error.code).toBe('NOT_A_REPO')
    const r = await b.addRepo(f.local)
    expect(r.ok && r.value.existed).toBe(false)
    expect((await b.addRepo(f.local + '/')).ok).toBe(true)
    expect(new Store(cfgFile).data.repos).toHaveLength(1)
    const s = r.ok ? await b.status(r.value.repo.id) : null
    expect(s?.ok && s.value).toMatchObject({ branch: 'main', sync: 'up-to-date', clean: true, remotes: ['origin'] })
    const remote = r.ok ? await b.checkRemote(r.value.repo.id) : null
    expect(remote?.ok && remote.value?.reachable).toBe(true)
  })

  it('never runs an untrusted profile, and editing a command revokes trust', async () => {
    const { f, b } = setup()
    const r = await b.addRepo(f.local); if (!r.ok) throw new Error()
    const d = await b.draftProfile(r.value.repo.id); if (!d.ok) throw new Error()
    const p = { ...d.value, services: [{ ...d.value.services[0], command: `"${process.execPath}" "${FIXTURE}" 0` }] }
    const saved = await b.saveProfile(p); if (!saved.ok) throw new Error(saved.error.message)
    const refused = await b.startServices(saved.value.id)
    expect(!refused.ok && refused.error.code).toBe('UNTRUSTED')
    expect(b.services.list()).toEqual([])

    const preview = await b.previewLaunch(saved.value.id)
    expect(preview.ok && preview.value[0]).toMatchObject({ dir: realpathSync.native(f.local), command: p.services[0].command })
    await b.trustProfile(saved.value.id)
    const renamed = await b.saveProfile({ ...b.store.profile(saved.value.id)!, name: 'Renamed' })
    expect(renamed.ok && renamed.value.trustedFingerprint).toBeTruthy()
    const edited = await b.saveProfile({ ...b.store.profile(saved.value.id)!, services: [{ ...p.services[0], command: 'echo changed' }] })
    expect(edited.ok && edited.value.trustedFingerprint).toBeNull()
  })

  it('requires running services to stop before switching branches, then switches', async () => {
    const { f, b } = setup()
    git(f.local, 'branch', 'feature')
    const r = await b.addRepo(f.local); if (!r.ok) throw new Error()
    const port = await freePort()
    const d = await b.draftProfile(r.value.repo.id); if (!d.ok) throw new Error()
    const saved = await b.saveProfile({ ...d.value, services: [{ ...d.value.services[0], command: `"${process.execPath}" "${FIXTURE}" ${port}`, readiness: { type: 'port', port } }] })
    if (!saved.ok) throw new Error(saved.error.message)
    await b.trustProfile(saved.value.id)
    const started = await b.startServices(saved.value.id)
    expect(started.ok).toBe(true)

    const refused = await b.switchBranch(r.value.repo.id, 'feature')
    expect(!refused.ok && refused.error.code).toBe('SERVICES_RUNNING')
    expect(git(f.local, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
    expect((await b.removeRepo(r.value.repo.id)).ok).toBe(false)

    await b.stopServices(saved.value.id)
    const switched = await b.switchBranch(r.value.repo.id, 'feature')
    expect(switched.ok).toBe(true)
    expect(git(f.local, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature')
  })

  it('validates arguments from the renderer', async () => {
    const { b } = setup()
    await expect(b.status('../../etc')).rejects.toThrow()
    await expect(b.switchBranch('nope', 'main')).rejects.toThrow(/no longer registered/)
    const r = await b.addRepo('relative/path')
    expect(r.ok).toBe(false)
  })

  it('opens WSL folders through their UNC path and refuses non-http URLs', async () => {
    const { b, opened } = setup()
    const repo = b.store.addRepo({ kind: 'wsl', distro: 'Ubuntu', path: '/home/me/app' }).repo
    await b.openFolder(repo.id)
    expect(opened).toContain('\\\\wsl.localhost\\Ubuntu\\home\\me\\app')
  })
})

describe('preload surface', () => {
  it('exposes exactly the API methods the main process handles', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'main', 'preload.ts'), 'utf8')
    const list = /const METHODS = \[([\s\S]*?)\]/.exec(src)![1].match(/'([^']+)'/g)!.map(s => s.slice(1, -1))
    expect(list).toEqual([...API_METHODS])
    expect(src).not.toMatch(/require\(|from '(?!electron|\.\.\/shared\/api\.js)/)
  })
})

describe('discovery and branch overview through the backend', () => {
  it('remembers removals, persists a chosen comparison base and validates it', async () => {
    const { f, b, cfgFile } = setup()
    const r = await b.addRepo(f.local); if (!r.ok) throw new Error()
    const id = r.value.repo.id
    const ov = await b.branchOverview(id)
    expect(ov.ok && ov.value.base?.name).toBe('origin/main')
    await expect(b.setCompareBase(id, '--output=x')).rejects.toThrow(/branch name/)
    await b.setCompareBase(id, 'main')
    expect(new Store(cfgFile).data.compareBase[id]).toBe('main')
    const chosen = await b.branchOverview(id)
    expect(chosen.ok && chosen.value.base).toMatchObject({ name: 'main', source: 'user' })
    await b.setCompareBase(id, null)
    expect(new Store(cfgFile).data.compareBase[id]).toBeUndefined()
    await b.removeRepo(id)
    const s = new Store(cfgFile)
    expect(s.data.ignored).toHaveLength(1)
    expect(s.isIgnored({ kind: 'native', path: f.local })).toBe(true)
  })

  it('loads a configuration written before discovery existed, keeping everything', () => {
    const t = tempDir(); cleanups.push(t.cleanup)
    const file = join(t.dir, 'gitmanager.json')
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, repos: [{ id: 'r1', name: 'app', location: { kind: 'native', path: '/x/app' }, addedAt: '' }], roots: [], profiles: [],
      settings: { editor: 'code', chromePath: '', discoveryDepth: 3 }, ui: { selectedRepoId: 'r1', selectedProfile: {} } }))
    const s = new Store(file)
    expect(s.loadWarning).toBeNull()
    expect(s.data.repos[0]).toMatchObject({ id: 'r1', source: 'manual' })
    expect(s.data.settings.autoDiscover).toBe(true)
    expect(s.data.ignored).toEqual([])
    expect(s.data.ui.selectedRepoId).toBe('r1')
  })
})
