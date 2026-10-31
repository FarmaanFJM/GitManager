import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RunnerHost } from '../../src/shared/runners.js'
import { RunnerManager } from '../../src/core/runners/manager.js'
import { Store } from '../../src/core/store.js'
import { FakeRunnerGitHub, FakeShell } from './fakes.js'

let dirs: string[] = []
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = [] })

function setup(o: { os?: 'windows' | 'linux' | 'mac'; distros?: string[]; shells?: Record<string, FakeShell> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gm-mgr-')); dirs.push(dir)
  const store = new Store(join(dir, 'gitmanager.json'))
  const gh = new FakeRunnerGitHub()
  const native = new FakeShell({ kind: 'native' }, o.os === 'windows' ? 'windows' : o.os === 'mac' ? 'macos' : 'linux')
  native.mkdir('/opt'); native.mkdir('/home/me')
  const shells: Record<string, FakeShell> = { native, ...(o.shells ?? {}) }
  const opened: string[] = []
  const m = new RunnerManager({
    dir, gh, config: () => store.data.runners, saveConfig: () => store.save(), os: o.os ?? 'linux', tmpDir: dir, repos: () => store.data.repos,
    openExternal: async u => { opened.push(u) }, openPath: async p => { opened.push(p); return '' },
    shellFor: (h: RunnerHost) => shells[h.kind === 'native' ? 'native' : h.kind === 'wsl' ? `wsl:${h.distro}` : `ssh:${h.host}`] ?? new FakeShell(h, 'linux'),
    distros: async () => (o.distros ?? []).map(name => ({ name, version: 2 })), sshConfig: async () => [{ alias: 'nas', hostName: '10.0.0.2', user: 'me', allowed: false }],
    download: async (_u, dest) => { writeFileSync(dest, 'pkg'); return { ok: true, sha256: gh.latest.checksums['linux-x64'], bytes: 3 } }, sleep: async () => {}, onlineWaitMs: 5,
  })
  return { m, store, gh, native, shells, opened, dir }
}

describe('scanning and the inventory', () => {
  it('combines local installations and GitHub records, reports every host and scope, and persists non-sensitive state', async () => {
    const { m, gh, native, dir, store } = setup()
    native.install('/opt/actions-runner', { agentId: 11, name: 'runner-a', running: true })
    native.install('/home/me/other', { agentId: 12, name: 'other', url: 'https://github.com/acme/web', service: null })
    gh.scopes.push({ key: 'acme/app', kind: 'repo', runners: [{ id: 11, name: 'runner-a', os: 'Linux', status: 'online', labels: ['gpu'] }, { id: 77, name: 'elsewhere', os: 'Windows', status: 'offline' }] })
    gh.scopes.push({ key: 'acme/web', kind: 'repo', admin: false, runners: [] })
    const events: string[] = []
    m.on('status', () => events.push('status')); m.on('changed', () => events.push('changed'))
    const r = await m.scanAndWait()
    expect(r.ok).toBe(true)
    const inv = m.inventory()
    expect(inv.runners.map(x => `${x.name}:${x.source}:${x.status}`).sort()).toEqual(['elsewhere:github:offline', 'other:local:unknown', 'runner-a:both:online'])
    expect(inv.summary).toMatchObject({ total: 3, online: 1, offline: 1, manageable: 2, monitoringOnly: 1 })
    expect(inv.hosts).toHaveLength(1); expect(inv.hosts[0]).toMatchObject({ status: 'ok', found: 2 })
    expect(inv.scopes.map(s => `${s.scope.kind === 'repo' ? s.scope.repo : ''}:${s.status}`).sort()).toEqual(['app:ok', 'web:forbidden'])
    expect(inv.limitations.join(' ')).toMatch(/acme\/web: No permission/)
    expect(inv.latest?.version).toBe('2.321.0')
    const other = inv.runners.find(x => x.name === 'other')!
    expect(other.attention.join(' ')).not.toMatch(/Not found among/) // the scope could not be read, so nothing is claimed
    expect(events).toContain('status'); expect(events).toContain('changed')
    const persisted = JSON.parse(readFileSync(join(dir, 'runners-state.json'), 'utf8'))
    expect(persisted.locals).toHaveLength(2); expect(JSON.stringify(persisted)).not.toMatch(/never read|A[A-Z0-9]{28}|ghp_/)
    expect(store.data.runners.known.map(k => k.path).sort()).toEqual(['/home/me/other', '/opt/actions-runner'])
    const again = new RunnerManager({ dir, gh, config: () => store.data.runners, saveConfig: () => {}, os: 'linux', tmpDir: dir, repos: () => [], openExternal: async () => {}, openPath: async () => '' })
    expect(again.inventory().runners).toHaveLength(3)
  })

  it('scans WSL distributions and allowed SSH hosts as separate environments and keeps the Linux paths', async () => {
    const wsl = new FakeShell({ kind: 'wsl', distro: 'Ubuntu-24.04' }); wsl.probe.hostname = 'DESKTOP'; wsl.mkdir('/home/me')
    wsl.install('/home/me/actions-runner', { agentId: 21, name: 'wsl-box' })
    const nas = new FakeShell({ kind: 'ssh', host: 'nas' }); nas.probe.hostname = 'nas'; nas.mkdir('/opt')
    nas.install('/opt/runner', { agentId: 31, name: 'nas-box', url: 'https://github.com/acme' })
    const { m, gh } = setup({ os: 'windows', distros: ['Ubuntu-24.04'], shells: { 'wsl:Ubuntu-24.04': wsl, 'ssh:nas': nas } })
    m.setSshHostAllowed('nas', true)
    gh.scopes.push({ key: 'acme/app', kind: 'repo', runners: [{ id: 21, name: 'wsl-box', os: 'Linux', status: 'online' }] }, { key: 'acme', kind: 'org', runners: [{ id: 31, name: 'nas-box', os: 'Linux', status: 'offline', group: 1 }], groups: [{ id: 1, name: 'Default', default: true }] })
    await m.scanAndWait()
    const inv = m.inventory()
    expect(inv.hosts.map(h => h.label)).toEqual(['This computer (Windows)', 'WSL (Ubuntu-24.04)', 'SSH: nas'])
    const w = inv.runners.find(r => r.name === 'wsl-box')!
    expect(w).toMatchObject({ environment: 'wsl', distro: 'Ubuntu-24.04', machine: 'DESKTOP', path: '/home/me/actions-runner', source: 'both' })
    const n = inv.runners.find(r => r.name === 'nas-box')!
    expect(n).toMatchObject({ environment: 'remote', machine: 'nas', source: 'both', status: 'offline' })
    expect(n.github?.runnerGroupName).toBe('Default')
    expect(n.capabilities.openFolder.allowed).toBe(false)
    const hosts = await m.hostsCatalog()
    expect(hosts.map(h => h.host.kind)).toEqual(['native', 'wsl', 'ssh'])
  })

  it('keeps an unreachable host\'s previous results marked as not inspected, and reports the host as inaccessible', async () => {
    const nas = new FakeShell({ kind: 'ssh', host: 'nas' }); nas.mkdir('/opt'); nas.install('/opt/runner', { agentId: 31, name: 'nas-box' })
    const { m } = setup({ shells: { 'ssh:nas': nas } })
    m.setSshHostAllowed('nas', true)
    await m.scanAndWait({ localOnly: true })
    expect(m.inventory().runners.map(r => r.name)).toEqual(['nas-box'])
    nas.handlers.unshift(c => (c.file === 'sh' ? { code: 255, stdout: '', stderr: 'ssh: connect to host nas port 22: No route to host', timedOut: false } : undefined))
    await m.scanAndWait({ localOnly: true })
    const inv = m.inventory()
    expect(inv.hosts.find(h => h.host.kind === 'ssh')).toMatchObject({ status: 'inaccessible', message: expect.stringMatching(/No route to host/) })
    const r = inv.runners.find(x => x.name === 'nas-box')!
    expect(r.notices.join(' ')).toMatch(/Not inspected in the last scan/)
    expect(r.capabilities.stop.allowed).toBe(false); expect(r.capabilities.stop.reason).toMatch(/nas did not answer/)
  })

  it('stops at a rate limit, marks the rest as not read and keeps the previous GitHub records', async () => {
    const { m, gh } = setup()
    for (const k of ['a', 'b', 'c', 'd']) gh.scopes.push({ key: `acme/${k}`, kind: 'repo', runners: [{ id: 1, name: `r-${k}`, os: 'Linux', status: 'online' }] })
    m.saveSettings({ ...m['cfg']().settings, repos: ['acme/a', 'acme/b', 'acme/c', 'acme/d'] })
    await m.scanAndWait()
    expect(m.inventory().runners).toHaveLength(4)
    let n = 0
    gh.intercept = (_m, p) => (p.includes('/actions/runners?') && ++n > 1 ? { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 7200) }, body: { message: 'API rate limit exceeded' } } : undefined)
    await m.scanAndWait({ githubOnly: true })
    const inv = m.inventory()
    expect(inv.scopes.filter(s => s.status === 'rate-limited').length).toBeGreaterThanOrEqual(1)
    expect(inv.scopes.filter(s => s.status === 'rate-limited' || s.status === 'skipped')).toHaveLength(3)
    expect(inv.scopes.filter(s => s.status === 'ok')).toHaveLength(1)
    expect(inv.runners).toHaveLength(4) // previous records kept for scopes that could not be re-read
    expect(inv.limitations.some(l => /rate limit/i.test(l))).toBe(true)
  })

  it('skips GitHub when the CLI is signed out and says so, and cancels a running scan', async () => {
    const { m, gh, native } = setup()
    gh.auth = { state: 'unauthenticated', message: 'GitHub CLI is not signed in.' }
    native.install('/opt/actions-runner')
    await m.scanAndWait()
    const inv = m.inventory()
    expect(inv.runners).toHaveLength(1); expect(inv.githubScannedAt).toBeNull()
    expect(inv.limitations.join(' ')).toMatch(/GitHub has not been read yet/)
    gh.auth = { state: 'ok', login: 'me', scopes: [], scopesKnown: true, canWrite: true, plan: null }
    const r = m.scan()
    expect(r.ok).toBe(true)
    expect(m.scan().ok).toBe(false)
    expect(m.cancel()).toBe(true)
    await m.whenIdle()
    expect((await m.state()).scan.cancelled).toBe(true)
  })

  it('rate-limits GitHub refreshes to once a minute unless forced', async () => {
    const { m, gh } = setup()
    gh.scopes.push({ key: 'acme/app', kind: 'repo', runners: [] })
    m.saveSettings({ ...m['cfg']().settings, repos: ['acme/app'] })
    await m.scanAndWait()
    const calls = gh.calls.length
    expect(m.refreshGithub(false)).toEqual({ ok: true, value: { started: false } })
    expect(gh.calls.length).toBe(calls)
    expect(m.refreshGithub(true)).toEqual({ ok: true, value: { started: true } })
    await m.whenIdle()
    expect(gh.calls.length).toBeGreaterThan(calls)
  })
})

describe('settings, roots and choices', () => {
  it('validates and persists discovery settings, roots and allowed SSH hosts through the store', async () => {
    const { m, store, dir } = setup()
    expect(m.saveSettings({ autoDiscover: false, githubAtStartup: true, orgs: ['acme', 'bad name'], repos: ['acme/app', 'nope'], refreshMinutes: 999 }).ok).toBe(true)
    const root = m.addRoot({ kind: 'native' }, '/srv/runners')
    expect(root.ok).toBe(true)
    expect(m.addRoot({ kind: 'native' }, '/srv/runners/').ok && (m.addRoot({ kind: 'native' }, '/srv/runners/') as { value: { id: string } }).value.id).toBe((root as { value: { id: string } }).value.id)
    m.setSshHostAllowed('nas', true)
    const reloaded = new Store(join(dir, 'gitmanager.json')).data.runners.settings
    expect(reloaded).toMatchObject({ autoDiscover: false, githubAtStartup: true, orgs: ['acme'], repos: ['acme/app'], refreshMinutes: 60, sshHosts: ['nas'] })
    expect(reloaded.roots).toHaveLength(1)
    expect((await m.sshHosts())[0]).toMatchObject({ alias: 'nas', allowed: true })
    m.removeRoot(reloaded.roots[0].id)
    expect(store.data.runners.settings.roots).toEqual([])
  })
  it('offers repositories from GitManager, local installations and GitHub (admin first), and organizations with their role', async () => {
    const { m, gh, native, store } = setup()
    native.install('/opt/r', { url: 'https://github.com/acme/legacy' })
    store.data.repos.push({ id: 'r1', name: 'app', location: { kind: 'native', path: '/code/app' }, addedAt: '' })
    native.mkfile('/code/app/.git/config', '[remote "origin"]\n\turl = git@github.com:acme/app.git\n')
    gh.repos.push({ full: 'acme/app', admin: true }, { full: 'acme/other', admin: true, private: true })
    gh.orgs.push({ login: 'acme', role: 'admin' }, { login: 'club', role: 'member' })
    await m.scanAndWait({ localOnly: true })
    const repos = await m.repoChoices('')
    expect(repos.map(r => `${r.fullName}:${r.source}:${r.canAdmin}`)).toEqual(['acme/app:gitmanager:true', 'acme/other:github:true', 'acme/legacy:local:false'])
    const orgs = await m.orgChoices()
    expect(orgs).toEqual([{ login: 'acme', canAdmin: true, message: null }, { login: 'club', canAdmin: false, message: expect.stringMatching(/Member only/) }])
  })
})

describe('installation through the manager', () => {
  it('plans, refuses to run without confirmation or with blockers, installs, and refreshes the inventory', async () => {
    const { m, gh, native } = setup()
    gh.scopes.push({ key: 'acme/app', kind: 'repo', runners: [] }); gh.repos.push({ full: 'acme/app', admin: true })
    native.handlers.push(c => { if (c.file === './config.sh' && c.args[0] !== 'remove') gh.addRunner('repo', 'acme/app', { id: native.nextAgentId, name: c.args[c.args.indexOf('--name') + 1] }); return undefined })
    const req = { host: { kind: 'native' }, scope: { kind: 'repo', owner: 'acme', repo: 'app' }, name: 'box', directory: '/home/me/actions-runners/box', labels: [], runnerGroup: null, installService: true, serviceUser: null, windowsAccount: null, windowsAccountName: null, startAfter: true, replace: false, ephemeral: false, disableUpdate: false, workFolder: '_work' }
    const plan = await m.plan(req)
    expect(plan.ok && plan.value.blockers).toEqual([])
    const id = plan.ok ? plan.value.id : ''
    expect(m.startInstall(id, false)).toMatchObject({ ok: false, error: { code: 'NOT_CONFIRMED' } })
    expect(m.startInstall('nope', true)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    const blocked = await m.plan({ ...req, name: 'bad name' })
    expect(blocked).toMatchObject({ ok: false, error: { code: 'INVALID' } })
    const started = m.startInstall(id, true)
    expect(started.ok).toBe(true)
    expect(m.startInstall(id, true)).toMatchObject({ ok: false }) // the plan is consumed
    await m.whenIdle()
    const st = await m.state()
    expect(st.job?.state).toBe('done')
    expect(st.recentJobs).toHaveLength(1)
    const inv = m.inventory()
    const r = inv.runners.find(x => x.name === 'box')!
    expect(r.source).toBe('both'); expect(r.local?.source).toBe('installed'); expect(r.status).toBe('online')
    expect(JSON.stringify(st)).not.toMatch(/A[A-Z0-9]{28}/)
  })
  it('does not run two operations on one installation or an action on a failed plan', async () => {
    const { m, gh, native } = setup()
    native.install('/opt/actions-runner', { agentId: 11, name: 'runner-a', running: true })
    gh.scopes.push({ key: 'acme/app', kind: 'repo', runners: [{ id: 11, name: 'runner-a', os: 'Linux', status: 'online' }] })
    await m.scanAndWait()
    const key = m.inventory().runners[0].key
    let release!: () => void
    native.handlers.push(c => (c.file === 'systemctl' ? new Promise(r => { release = () => r({ code: 0, stdout: '', stderr: '', timedOut: false }) }) : undefined))
    const first = m.action(key, 'stop', {})
    await new Promise(r => setTimeout(r, 10))
    expect((await m.state()).busy[m.inventory().runners[0].local!.key]).toBe('stop')
    expect(await m.action(key, 'restart', {})).toMatchObject({ ok: false, error: { code: 'BUSY' } })
    release()
    await first
    expect(await m.action('local:missing', 'stop', {})).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })
})

describe('links and workflow reports', () => {
  it('opens GitHub pages and local folders only for known targets', async () => {
    const { m, opened, native } = setup()
    native.install('/opt/actions-runner')
    await m.scanAndWait({ localOnly: true })
    const key = m.inventory().runners[0].key
    await m.open({ kind: 'runner-settings', scope: { kind: 'repo', owner: 'acme', repo: 'app' }, runnerId: 11 })
    await m.open({ kind: 'scope', scope: { kind: 'org', org: 'acme' } })
    await m.open({ kind: 'folder', key })
    await m.open({ kind: 'release', version: '2.321.0' })
    expect(await m.open({ kind: 'folder', key: 'nope' })).toMatchObject({ ok: false })
    expect(await m.open({ kind: 'runner-settings', scope: { kind: 'repo', owner: '../x', repo: 'y' } as never, runnerId: null })).toMatchObject({ ok: false })
    expect(opened).toEqual(['https://github.com/acme/app/settings/actions/runners/11', 'https://github.com/acme', '/opt/actions-runner', 'https://github.com/actions/runner/releases/tag/v2.321.0'])
  })
  it('reads workflow files from GitHub for a repository that is not registered locally', async () => {
    const { m, gh } = setup()
    gh.repos.push({ full: 'acme/app', admin: true, workflows: { '.github/workflows/ci.yml': 'jobs:\n  b:\n    runs-on: [self-hosted, linux]\n' } })
    gh.scopes.push({ key: 'acme/app', kind: 'repo', runners: [{ id: 1, name: 'a', os: 'Linux', status: 'online' }] })
    m.saveSettings({ ...m['cfg']().settings, repos: ['acme/app'] })
    await m.scanAndWait()
    const rep = await m.workflowReport('acme/app')
    expect(rep.ok && rep.value.source).toBe('github')
    expect(rep.ok && rep.value.files[0].jobs[0].matched).toHaveLength(1)
    expect(await m.workflowReport('bad')).toMatchObject({ ok: false })
  })
})
