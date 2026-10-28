import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discover } from '../src/core/discovery.js'
import { draftProfile, fingerprint, isTrusted, parseEnvFile, planLaunch } from '../src/core/profiles.js'
import { Store } from '../src/core/store.js'
import * as v from '../src/core/validate.js'
import type { Profile } from '../src/shared/types.js'
import { git, tempDir } from './helpers.js'

let cleanups: (() => void)[] = []
afterEach(() => { cleanups.forEach(c => c()); cleanups = [] })
const tmp = () => { const t = tempDir(); cleanups.push(t.cleanup); return t.dir }

function caissaProfile(repoId: string): Profile {
  return {
    id: 'prof1', repoId, name: 'Dev', runtime: { kind: 'native' }, workingDir: '', openUrl: 'http://localhost:5173', browser: 'chrome', trustedFingerprint: null,
    services: [
      { id: 'fe', name: 'Frontend', command: 'npm run dev', cwd: 'frontend', env: { PORT: '5173' }, envFile: '', readiness: { type: 'http', url: 'http://localhost:5173' }, readyTimeout: 60 },
      { id: 'be', name: 'Backend', command: './mvnw spring-boot:run', cwd: 'backend', env: {}, envFile: '.env.local', readiness: { type: 'port', port: 8080 }, readyTimeout: 180 },
    ],
  }
}

describe('configuration persistence', () => {
  it('survives a restart: repositories, roots, profiles, settings and selection', () => {
    const file = join(tmp(), 'cfg', 'gitmanager.json')
    const a = new Store(file)
    const { repo } = a.addRepo({ kind: 'native', path: '/home/me/caissa' })
    a.addRoot({ kind: 'wsl', distro: 'Ubuntu', path: '/home/me/code' }, 3)
    a.upsertProfile(caissaProfile(repo.id))
    a.data.settings.editor = 'cursor'
    a.data.ui.selectedRepoId = repo.id
    a.save()

    const b = new Store(file)
    expect(b.loadWarning).toBeNull()
    expect(b.data.repos).toHaveLength(1)
    expect(b.data.repos[0]).toMatchObject({ name: 'caissa', location: { kind: 'native', path: '/home/me/caissa' } })
    expect(b.data.roots[0].location).toEqual({ kind: 'wsl', distro: 'Ubuntu', path: '/home/me/code' })
    expect(b.profilesFor(repo.id)[0].services.map(s => s.name)).toEqual(['Frontend', 'Backend'])
    expect(b.data.settings.editor).toBe('cursor')
    expect(b.data.ui.selectedRepoId).toBe(repo.id)
    expect(readdirSync(join(file, '..')).filter(f => f.endsWith('.tmp'))).toEqual([])
  })

  it('does not register the same folder twice, and removing a repository keeps the folder', () => {
    const dir = tmp()
    const s = new Store(join(dir, 'c.json'))
    const repoDir = join(dir, 'repo'); mkdirSync(repoDir)
    const first = s.addRepo({ kind: 'native', path: repoDir })
    expect(s.addRepo({ kind: 'native', path: repoDir + '/' }).existed).toBe(true)
    s.upsertProfile(caissaProfile(first.repo.id))
    s.removeRepo(first.repo.id)
    expect(s.data.repos).toEqual([])
    expect(s.data.profiles).toEqual([])
    expect(existsSync(repoDir)).toBe(true)
  })

  it('sets a corrupt file aside and drops invalid records instead of crashing', () => {
    const dir = tmp()
    const file = join(dir, 'c.json')
    writeFileSync(file, '{not json')
    const s = new Store(file)
    expect(s.data.repos).toEqual([])
    expect(s.loadWarning).toMatch(/set aside/)
    expect(readdirSync(dir).some(f => f.startsWith('c.json.corrupt-'))).toBe(true)

    writeFileSync(file, JSON.stringify({ repos: [{ id: 'ok1', name: 'a', location: { kind: 'native', path: '/a' } }, { id: 'bad id!', name: 'b', location: { kind: 'native', path: '/b' } }, { id: 'w', name: 'w', location: { kind: 'wsl', distro: 'Ubuntu', path: 'C:\\x' } }] }))
    const t = new Store(file)
    expect(t.data.repos.map(r => r.id)).toEqual(['ok1'])
    expect(t.loadWarning).toMatch(/2 invalid entries/)
  })
})

describe('profiles and trust', () => {
  const repo = { id: 'r1', name: 'caissa', location: { kind: 'native' as const, path: '/home/me/caissa' }, addedAt: '' }
  it('requires trusting again when anything that executes changes, but not for cosmetic edits', () => {
    const p = caissaProfile('r1')
    p.trustedFingerprint = fingerprint(p, repo)
    expect(isTrusted(p, repo)).toBe(true)
    expect(isTrusted({ ...p, name: 'Renamed', openUrl: 'http://localhost:3000' }, repo)).toBe(true)
    expect(isTrusted({ ...p, services: [{ ...p.services[0], command: 'npm run dev; curl evil' }, p.services[1]] }, repo)).toBe(false)
    expect(isTrusted({ ...p, services: [{ ...p.services[0], env: { PORT: '1' } }, p.services[1]] }, repo)).toBe(false)
    expect(isTrusted({ ...p, runtime: { kind: 'wsl', distro: 'Ubuntu' } }, repo)).toBe(false)
    expect(isTrusted(draftProfile(repo, 'x', 'y'), repo)).toBe(false)
  })

  it('parses env files', () => {
    expect(parseEnvFile('# comment\nexport A=1\nB = "two words"\nC=\'raw $x\'\nD=value # note\nE="line\\nbreak"\nbad line\n')).toEqual({ A: '1', B: 'two words', C: 'raw $x', D: 'value', E: 'line\nbreak' })
  })

  it('plans launches with resolved directories and env file values, inline values winning', async () => {
    const p = caissaProfile('r1')
    p.services[1].env = { SERVER_PORT: '9090' }
    const seen: string[] = []
    const r = await planLaunch(p, repo, p.services[1], async (_rt, path) => { seen.push(path); return 'SERVER_PORT=8080\nDB=local\n' })
    expect(seen).toEqual(['/home/me/caissa/.env.local'])
    expect(r.ok && r.value).toMatchObject({ key: 'prof1:be', dir: '/home/me/caissa/backend', env: { SERVER_PORT: '9090', DB: 'local' } })
    const missing = await planLaunch(p, repo, p.services[1], async () => { throw new Error('ENOENT') })
    expect(!missing.ok && missing.error.code).toBe('BAD_ENV_FILE')
  })

  it('validates profiles coming from the interface', () => {
    const p = caissaProfile('r1')
    expect(v.profile(p).services).toHaveLength(2)
    expect(() => v.profile({ ...p, services: [{ ...p.services[0], command: '  ' }] })).toThrow(/command is required/)
    expect(() => v.profile({ ...p, openUrl: 'file:///etc/passwd' })).toThrow(/http/)
    expect(() => v.profile({ ...p, services: [{ ...p.services[0], env: { 'BAD-KEY': 'x' } }] })).toThrow(/not a valid environment variable/)
    expect(() => v.profile({ ...p, runtime: { kind: 'wsl', distro: 'Ubuntu; rm -rf /' } })).toThrow(/distribution/)
    expect(() => v.profile({ ...p, services: [p.services[0], { ...p.services[1], name: 'frontend' }] })).toThrow(/Two services/)
    expect(() => v.location({ kind: 'wsl', distro: 'Ubuntu', path: 'relative' })).toThrow()
  })
})

describe('bounded discovery', () => {
  it('finds repositories within the depth, skipping hidden and dependency folders', async () => {
    const root = tmp()
    const mk = (rel: string) => { const d = join(root, rel); mkdirSync(d, { recursive: true }); git(d, 'init', '-q'); return d }
    mk('alpha'); mk('group/beta'); mk('group/deep/deeper/gamma'); mk('node_modules/pkg'); mk('.hidden/repo')
    const r = await discover({ kind: 'native', path: root }, 2)
    expect(r.ok).toBe(true)
    const names = r.ok ? r.value.map(l => l.location.path.slice(root.length + 1).replace(/\\/g, '/')).sort() : []
    expect(names).toEqual(['alpha', 'group/beta'])
    const deeper = await discover({ kind: 'native', path: root }, 4)
    expect(deeper.ok && deeper.value).toHaveLength(3)
    expect(readFileSync(join(root, 'alpha', '.git', 'HEAD'), 'utf8')).toMatch(/ref:/)
  })
  it('reports an unreadable root', async () => {
    const r = await discover({ kind: 'native', path: join(tmp(), 'missing') }, 2)
    expect(r.ok).toBe(false)
  })
})
