import { describe, expect, it } from 'vitest'
import { emptyConfig } from '../../src/core/storage/config.js'
import { GitHub } from '../../src/core/storage/github.js'
import { scanAll } from '../../src/core/storage/scanner.js'
import type { AuthState } from '../../src/shared/storage.js'
import { builds, FakeGitHub } from './fakeGithub.js'
import { NOW } from './factory.js'

const ok = (login = 'me') => ({ state: 'ok', login, scopes: ['repo'], scopesKnown: true, canWrite: true, plan: 'free' }) as Extract<AuthState, { state: 'ok' }>
const gh = (f: FakeGitHub) => new GitHub(f, { sleep: async () => {}, maxWaitMs: 1000 })
const now = () => NOW

function world() {
  const f = new FakeGitHub()
  f.repos.push(
    { ...builds('me/app', 'app-windows-x64', [1, 2, 20, 30, 40], NOW, 100), pulls: [], releases: [], docs: { 'README.md': 'hello' }, caches: [{ key: 'npm-1', size: 5_000_000 }] },
    { ...builds('me/lib', 'coverage-report', [1, 5, 30], NOW, 200), docs: {} },
  )
  return f
}

describe('scan', () => {
  it('inventories every repository with classification, caches and billing kept apart from artifacts', async () => {
    const f = world()
    const { snapshot, failed } = await scanAll(gh(f), ok(), { config: emptyConfig(), now })
    expect(failed).toBe(0)
    expect(snapshot.lastSuccessfulScanAt).not.toBeNull()
    const app = snapshot.repos.find(r => r.repo === 'me/app')!
    expect(app.artifacts).toHaveLength(5)
    expect(app.artifacts.map(a => a.class)).toEqual(['keep', 'keep', 'delete-candidate', 'delete-candidate', 'delete-candidate'])
    expect(app.cacheBytes).toBe(5_000_000)
    expect(app.caches[0].key).toBe('npm-1')
    expect(snapshot.billing.available).toBe(true)
    expect(snapshot.billing.items.map(i => i.unit)).toContain('GigabyteHours')
    expect(snapshot.limitations.join(' ')).toContain('without sizes')
  })

  it('reads every page of a large list and nothing is requested twice for runs already known', async () => {
    const f = new FakeGitHub()
    const big = builds('me/big', 'build-windows-x64', Array.from({ length: 250 }, (_, i) => i + 1), NOW, 1000)
    f.repos.push({ ...big, docs: {} })
    const { snapshot } = await scanAll(gh(f), ok(), { config: emptyConfig(), now })
    expect(snapshot.repos[0].artifacts).toHaveLength(250)
    expect(f.count('GET', /\/actions\/artifacts\?per_page=100&page=3/)).toBe(1)
    // 250 runs: three pages of the run list cover all of them, so no run is fetched one by one
    expect(f.count('GET', /\/actions\/runs\/\d+$/)).toBe(0)
  })

  it('a repository that cannot be read does not invalidate the others', async () => {
    const f = world()
    f.intercept = (m, p) => (p.startsWith('/repos/me/lib/actions/artifacts') ? { status: 500, headers: {}, body: { message: 'boom' } } : undefined)
    const { snapshot, failed } = await scanAll(gh(f), ok(), { config: emptyConfig(), now })
    expect(failed).toBe(1)
    expect(snapshot.repos.find(r => r.repo === 'me/lib')!.error).toContain('boom')
    expect(snapshot.repos.find(r => r.repo === 'me/app')!.artifacts).toHaveLength(5)
    expect(snapshot.lastSuccessfulScanAt).toBeNull() // not a fully successful scan
    expect(snapshot.limitations.join(' ')).toContain('could not be inventoried')
  })

  it('moves candidates to Review when pull requests could not be read', async () => {
    const f = world()
    f.intercept = (_m, p) => (p.startsWith('/repos/me/app/pulls') ? { status: 403, headers: {}, body: { message: 'Resource not accessible' } } : undefined)
    const { snapshot } = await scanAll(gh(f), ok(), { config: emptyConfig(), now })
    const app = snapshot.repos.find(r => r.repo === 'me/app')!
    expect(app.artifacts.filter(a => a.class === 'delete-candidate')).toHaveLength(0)
    expect(app.artifacts.filter(a => a.reasonCode === 'context-incomplete')).toHaveLength(3)
    expect(app.limits.some(l => l.area === 'pulls')).toBe(true)
  })

  it('stops the scan on an authentication failure, keeping what was read', async () => {
    const f = world()
    f.intercept = (_m, p) => (p.startsWith('/repos/me/lib/') ? { status: 401, headers: {}, body: { message: 'Bad credentials' } } : undefined)
    const { snapshot, aborted } = await scanAll(gh(f), ok(), { config: emptyConfig(), now, concurrency: 1 })
    expect(aborted).toContain('rejected')
    expect(snapshot.repos.map(r => r.repo)).toEqual(['me/app'])
    expect(snapshot.limitations[0]).toContain('stopped early')
  })

  it('reports billing and packages as unavailable instead of inventing them', async () => {
    const f = world()
    f.packages = 'forbidden'
    f.intercept = (_m, p) => (p.includes('/settings/billing/') ? { status: 403, headers: {}, body: { message: 'Forbidden' } } : undefined)
    const { snapshot } = await scanAll(gh(f), ok(), { config: emptyConfig(), now })
    expect(snapshot.billing.available).toBe(false)
    expect(snapshot.packages.available).toBe(false)
    expect(snapshot.packages.message).toContain('read:packages')
    expect(snapshot.limitations.join(' ')).toContain('Billing data unavailable')
  })

  it('honours protected repositories and pins from the configuration', async () => {
    const f = world()
    const cfg = emptyConfig()
    cfg.protectedRepos = ['me/lib']
    cfg.pins = [{ repo: 'me/app', artifactId: 1002, name: 'x', at: '' }]
    const app = f.repos[0]
    app.artifacts[2].id = 1002
    const { snapshot } = await scanAll(gh(f), ok(), { config: cfg, now })
    expect(snapshot.repos.find(r => r.repo === 'me/lib')!.artifacts.every(a => a.class === 'protected')).toBe(true)
    expect(snapshot.repos.find(r => r.repo === 'me/app')!.artifacts.find(a => a.id === 1002)).toMatchObject({ class: 'protected', reasonCode: 'pinned' })
  })

  it('only scans repositories the user can write to unless scope says otherwise', async () => {
    const f = world()
    f.repos.push({ ...builds('other/shared', 'app-windows-x64', [1], NOW, 300), push: false })
    const writable = await scanAll(gh(f), ok(), { config: emptyConfig(), now })
    expect(writable.snapshot.repos.map(r => r.repo).sort()).toEqual(['me/app', 'me/lib'])
  })
})
