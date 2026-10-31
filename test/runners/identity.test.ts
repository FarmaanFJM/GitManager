// Repository identity, alias reconciliation, retirement of orphaned installations and the cleanup safeguards, modelled on the
// real inventory that prompted them: FarmaanFJM/ChessTrainer was renamed FarmaanFJM/CaissaTrainer (repository id 1080449013),
// runner 22 is the working installation, runner 21's old installation is an orphan, and other projects have their own runners.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { GitHubRunner, LocalRunner, RunnerHost, RunnerScope } from '../../src/shared/runners.js'
import { RunnerManager } from '../../src/core/runners/manager.js'
import { cleanupCheck, installsOverlap, parseScope, reconcile, scopeKey, summarize, updateGap } from '../../src/core/runners/model.js'
import { Store } from '../../src/core/store.js'
import { FakeRunnerGitHub, FakeShell } from './fakes.js'
import { github, local } from './model.test.js'

const REPO_ID = 1080449013
const OLD = { kind: 'repo', owner: 'FarmaanFJM', repo: 'ChessTrainer' } as const
const NEW = { kind: 'repo', owner: 'FarmaanFJM', repo: 'CaissaTrainer' } as const
const CANON: RunnerScope = { ...NEW, repoId: REPO_ID }
const canon = (s: RunnerScope): RunnerScope => (s.kind === 'repo' && s.repo.toLowerCase().match(/^(chess|caissa)trainer$/) && s.owner.toLowerCase() === 'farmaanfjm' ? CANON : s)

let dirs: string[] = []
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = [] })

describe('repository identity', () => {
  it('keys a repository by its immutable id once known, so a renamed repository is one scope', () => {
    expect(scopeKey({ ...OLD, repoId: REPO_ID })).toBe(scopeKey({ ...NEW, repoId: REPO_ID }))
    expect(scopeKey({ ...OLD, repoId: REPO_ID })).toBe(`repo#${REPO_ID}`)
    // without an id the name is the identity, and different repositories never collide
    expect(scopeKey(OLD)).not.toBe(scopeKey(NEW))
    expect(scopeKey({ kind: 'repo', owner: 'FarmaanFJM', repo: 'Other', repoId: 5 })).not.toBe(scopeKey(CANON))
  })
  it('keeps the id through validation and drops an invalid one', () => {
    expect(parseScope({ ...NEW, repoId: REPO_ID })).toEqual({ ...NEW, repoId: REPO_ID })
    expect(parseScope({ ...NEW, repoId: -3 })).toEqual(NEW)
    expect(parseScope({ ...NEW, repoId: '7' })).toEqual(NEW)
  })
})

describe('reconciliation across repository aliases', () => {
  const installed = (over: Partial<LocalRunner> = {}) => local({ path: '/home/farmaan/actions-runner-caissatrainer', host: { kind: 'wsl', distro: 'Ubuntu-24.04' }, key: 'wsl:ubuntu-24.04:/home/farmaan/actions-runner-caissatrainer', agentId: 22, agentName: 'caissa-pc', scope: OLD, gitHubUrl: 'https://github.com/FarmaanFJM/ChessTrainer', ...over })
  const gh22 = (scope: RunnerScope, over: Partial<GitHubRunner> = {}) => github({ id: 22, name: 'caissa-pc', scope, ...over })

  it('shows one runner when GitHub returned runner 22 under both names of the repository, paired with its installation', () => {
    const l = installed()
    const rows = reconcile([l], [gh22(OLD), gh22(NEW)], { canonicalScope: canon })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ name: 'caissa-pc', source: 'both', status: 'online', path: l.path, distro: 'Ubuntu-24.04', environment: 'wsl' })
    expect(rows[0].github?.id).toBe(22)
    expect(rows[0].scope).toEqual(CANON)
  })
  it('without alias knowledge the same data would split (the bug being fixed), and with it never does', () => {
    expect(reconcile([installed()], [gh22(OLD), gh22(NEW)])).toHaveLength(2)
    expect(reconcile([installed()], [gh22(OLD)], { canonicalScope: canon })).toHaveLength(1)
    expect(reconcile([installed({ scope: NEW })], [gh22(OLD)], { canonicalScope: canon })).toHaveLength(1)
  })
  it('keeps distinct registrations apart even when their display names are identical', () => {
    const other = github({ id: 31, name: 'caissa-pc', scope: { kind: 'repo', owner: 'FarmaanFJM', repo: 'Other', repoId: 5 } })
    const sameRepo = gh22(NEW, { id: 23, name: 'caissa-pc' })
    const rows = reconcile([installed()], [gh22(OLD), sameRepo, other], { canonicalScope: canon })
    expect(rows).toHaveLength(3)
    expect(rows.filter(r => r.name === 'caissa-pc')).toHaveLength(3)
    expect(rows.find(r => r.github?.id === 22)?.source).toBe('both')
    expect(rows.find(r => r.github?.id === 23)?.source).toBe('github')
    expect(rows.find(r => r.github?.id === 31)?.scope).toMatchObject({ repo: 'Other' })
  })
  it('does not pair runner id 22 in one repository with id 22 in another', () => {
    const elsewhere = github({ id: 22, name: 'caissa-pc', scope: { kind: 'repo', owner: 'FarmaanFJM', repo: 'Other', repoId: 5 } })
    const rows = reconcile([installed()], [elsewhere], { canonicalScope: canon, githubFetched: () => true })
    expect(rows).toHaveLength(2)
    expect(rows.find(r => r.local)?.source).toBe('local')
  })
  it('keeps the old installation (id 21) a separate, distinguishable row that GitHub does not list', () => {
    const l22 = installed(), l21 = installed({ path: '/home/farmaan/actions-runner-caissa', key: 'wsl:ubuntu-24.04:/home/farmaan/actions-runner-caissa', agentId: 21, version: '2.337.0', service: { kind: 'none', name: null, state: 'not-installed', startup: 'not-applicable', detail: null }, process: { running: false, pids: [], detail: null } })
    const rows = reconcile([l22, l21], [gh22(OLD)], { canonicalScope: canon, githubFetched: () => true })
    expect(rows).toHaveLength(2)
    const orphan = rows.find(r => r.local?.agentId === 21)!
    expect(orphan).toMatchObject({ source: 'local', status: 'unknown', path: '/home/farmaan/actions-runner-caissa', version: '2.337.0' })
    expect(orphan.attention.join(' ')).toMatch(/Not found among the runners of FarmaanFJM\/CaissaTrainer/)
    expect(orphan.capabilities.retire.allowed).toBe(true)
    const active = rows.find(r => r.local?.agentId === 22)!
    expect(active.source).toBe('both'); expect(active.capabilities.retire.allowed).toBe(false)
    expect(active.capabilities.retire.reason).toMatch(/active runner/)
  })
})

describe('warning severity', () => {
  const wsl = (over: Partial<LocalRunner> = {}) => local({ host: { kind: 'wsl', distro: 'Ubuntu-24.04' }, key: 'wsl:ubuntu-24.04:/opt/actions-runner', scope: CANON, ...over })
  const ghc = (over: Partial<GitHubRunner> = {}) => github({ scope: CANON, ...over })
  it('treats WSL not starting with Windows, a patch update and a missing service as information', () => {
    const r = reconcile([wsl({ version: '2.337.0' })], [ghc()], { latestVersion: '2.337.1', canonicalScope: canon })[0]
    expect(r.attention).toEqual([])
    expect(r.notices.join(' ')).toMatch(/WSL does not start distributions/)
    expect(r.notices.join(' ')).toMatch(/patch update/)
    const manual = reconcile([local({ service: { kind: 'none', name: null, state: 'not-installed', startup: 'not-applicable', detail: null }, process: { running: true, pids: [1], detail: null } })], [github()])[0]
    expect(manual.attention).toEqual([]); expect(manual.notices.join(' ')).toMatch(/Not installed as a service/)
  })
  it('keeps a minor update, a missing registration or credentials, and a running service GitHub cannot reach as warnings', () => {
    expect(updateGap('2.337.0', '2.337.1')).toBe('patch'); expect(updateGap('2.336.9', '2.337.0')).toBe('minor'); expect(updateGap('3.0.0', '2.9.9')).toBe('none')
    expect(reconcile([wsl({ version: '2.330.0' })], [ghc()], { latestVersion: '2.337.1' })[0].attention.join(' ')).toMatch(/2\.330\.0 installed/)
    expect(reconcile([wsl({ warnings: ['Registered, but the credentials file is missing: the runner cannot connect until it is configured again.'] })], [ghc()])[0].attention.join(' ')).toMatch(/credentials file is missing/)
    expect(reconcile([wsl({ configured: false, partial: true, agentId: null, agentName: null, scope: null })], [])[0].attention.join(' ')).toMatch(/without a registration/)
    expect(reconcile([wsl()], [], { githubFetched: () => true, canonicalScope: canon })[0].attention.join(' ')).toMatch(/Not found among the runners/)
    expect(reconcile([wsl()], [ghc({ status: 'offline' })])[0].attention.join(' ')).toMatch(/service is running but GitHub reports the runner offline/)
  })
  it('counts only genuine warnings in Needs attention', () => {
    const rows = reconcile([wsl({ version: '2.337.0' })], [ghc(), ghc({ id: 2, name: 'b', status: 'offline' })], { latestVersion: '2.337.1', canonicalScope: canon })
    expect(summarize(rows).attention).toBe(0)
    expect(rows.every(r => r.attention.length === 0)).toBe(true)
  })
})

describe('installation overlap and cleanup checks', () => {
  const at = (path: string, host: RunnerHost = { kind: 'wsl', distro: 'Ubuntu-24.04' }) => ({ host, path })
  it('compares whole path segments: actions-runner-caissa is not inside, and does not contain, actions-runner-caissatrainer', () => {
    expect(installsOverlap(at('/home/farmaan/actions-runner-caissa'), at('/home/farmaan/actions-runner-caissatrainer'))).toBe(false)
    expect(installsOverlap(at('/home/farmaan/actions-runner-caissa'), at('/home/farmaan/actions-runner-caissa/nested'))).toBe(true)
    expect(installsOverlap(at('/home/farmaan'), at('/home/farmaan/actions-runner-caissa'))).toBe(true)
    expect(installsOverlap(at('/home/farmaan/actions-runner-caissa'), at('/home/farmaan/actions-runner-caissa', { kind: 'wsl', distro: 'Debian' }))).toBe(false)
    expect(installsOverlap(at('C:\\Runners\\A', { kind: 'native' }), at('c:/runners/a/x', { kind: 'native' }))).toBe(true)
  })
  const orphan = (over: Partial<LocalRunner> = {}) => local({ path: '/home/farmaan/actions-runner-caissa', host: { kind: 'wsl', distro: 'Ubuntu-24.04' }, key: 'wsl:ubuntu-24.04:/home/farmaan/actions-runner-caissa', agentId: 21, scope: CANON, service: { kind: 'none', name: null, state: 'not-installed', startup: 'not-applicable', detail: null }, process: { running: false, pids: [], detail: null }, ...over })
  it('allows an orphan whose registration is confirmed gone and refuses every other state with a reason', () => {
    const row = (l: LocalRunner, g: GitHubRunner | null = null) => reconcile([l], g ? [g] : [], { canonicalScope: canon, githubFetched: () => true })[0]
    expect(cleanupCheck(row(orphan()), { others: [], registrationGone: true })).toEqual({ allowed: true, reasons: [] })
    expect(cleanupCheck(row(orphan()), { others: [], registrationGone: false }).reasons.join(' ')).toMatch(/has not confirmed/)
    expect(cleanupCheck(row(orphan(), github({ id: 21, scope: CANON })), { others: [], registrationGone: true }).reasons.join(' ')).toMatch(/lists this registration/)
    expect(cleanupCheck(row(orphan({ process: { running: true, pids: [9], detail: null } })), { others: [], registrationGone: true }).reasons.join(' ')).toMatch(/running/)
    expect(cleanupCheck(row(orphan({ process: { running: null, pids: [], detail: null } })), { others: [], registrationGone: true }).reasons.join(' ')).toMatch(/could not be determined/)
    expect(cleanupCheck(row(orphan({ service: { kind: 'systemd', name: 'actions.runner.x.service', state: 'stopped', startup: 'automatic', detail: null } })), { others: [], registrationGone: true }).reasons.join(' ')).toMatch(/service is installed/)
    expect(cleanupCheck(row(orphan({ path: '/usr/bin', key: 'wsl:ubuntu-24.04:/usr/bin' })), { others: [], registrationGone: true }).allowed).toBe(false)
  })
  it('refuses when another installation overlaps, shares the service or shares the registration, but not for a sibling folder with a longer name', () => {
    const o = orphan()
    const ok = (other: LocalRunner) => cleanupCheck(reconcile([o], [], { canonicalScope: canon, githubFetched: () => true })[0], { others: [other], registrationGone: true })
    const sibling = local({ path: '/home/farmaan/actions-runner-caissatrainer', host: o.host, key: 'wsl:ubuntu-24.04:/home/farmaan/actions-runner-caissatrainer', agentId: 22, scope: CANON })
    expect(ok(sibling).allowed).toBe(true)
    expect(ok({ ...sibling, path: '/home/farmaan/actions-runner-caissa/inner', key: 'wsl:ubuntu-24.04:/home/farmaan/actions-runner-caissa/inner' }).reasons.join(' ')).toMatch(/overlaps/)
    expect(ok({ ...sibling, service: { ...o.service, kind: 'systemd', name: 'u' } }).allowed).toBe(true)
    const withService = { ...o, service: { kind: 'systemd' as const, name: 'u', state: 'not-installed' as const, startup: 'unknown' as const, detail: null } }
    expect(cleanupCheck(reconcile([withService], [], { canonicalScope: canon })[0], { others: [{ ...sibling, service: { ...withService.service, state: 'running' } }], registrationGone: true }).reasons.join(' ')).toMatch(/shares the service name/)
    expect(ok({ ...sibling, agentId: 21 }).reasons.join(' ')).toMatch(/shares runner id 21/)
  })
})

/* ------------------------------------------------------------ the manager, end to end with fakes */

function world(o: { renamed?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gm-ident-')); dirs.push(dir)
  const file = join(dir, 'gitmanager.json')
  const store = new Store(file)
  const gh = new FakeRunnerGitHub()
  gh.repos.push({ full: 'FarmaanFJM/CaissaTrainer', admin: true, id: REPO_ID }, { full: 'FarmaanFJM/Other', admin: true, id: 5 })
  if (o.renamed !== false) gh.aliases['farmaanfjm/chesstrainer'] = 'FarmaanFJM/CaissaTrainer'
  gh.latest.version = '2.337.1'
  gh.scopes.push({ key: 'FarmaanFJM/CaissaTrainer', kind: 'repo', runners: [{ id: 22, name: 'caissa-pc', os: 'Linux', status: 'online' }] })
  gh.scopes.push({ key: 'FarmaanFJM/Other', kind: 'repo', runners: [{ id: 7, name: 'other-pc', os: 'Linux', status: 'online' }] })
  const wsl = new FakeShell({ kind: 'wsl', distro: 'Ubuntu-24.04' }); wsl.probe.hostname = 'DESKTOP'; wsl.mkdir('/home/farmaan')
  // the .runner files still carry the old repository URL, as they do after a rename
  const OLD_URL = 'https://github.com/FarmaanFJM/ChessTrainer'
  wsl.install('/home/farmaan/actions-runner-caissatrainer', { agentId: 22, name: 'caissa-pc', url: OLD_URL, version: '2.337.0', running: true, service: 'actions.runner.FarmaanFJM-CaissaTrainer.caissa-pc.service' })
  wsl.install('/home/farmaan/actions-runner-caissa', { agentId: 21, name: 'caissa-pc', url: OLD_URL, version: '2.337.0', service: null })
  wsl.install('/home/farmaan/actions-runner-other', { agentId: 7, name: 'other-pc', url: 'https://github.com/FarmaanFJM/Other', version: '2.337.1', running: true, service: 'actions.runner.FarmaanFJM-Other.other-pc.service' })
  const make = (st = store) => new RunnerManager({
    dir, gh, config: () => st.data.runners, saveConfig: () => st.save(), os: 'windows', tmpDir: dir, repos: () => st.data.repos, openExternal: async () => {}, openPath: async () => '',
    shellFor: (h: RunnerHost) => (h.kind === 'wsl' ? wsl : new FakeShell(h, 'windows')), distros: async () => [{ name: 'Ubuntu-24.04', version: 2 }], sshConfig: async () => [],
    download: async (_u, dest) => { writeFileSync(dest, 'pkg'); return { ok: true, sha256: gh.latest.checksums['linux-x64'], bytes: 3 } }, sleep: async () => {}, onlineWaitMs: 5,
  })
  return { m: make(), make, store, file, gh, wsl, dir }
}
const O21 = 'wsl:ubuntu-24.04:/home/farmaan/actions-runner-caissa'
const P21 = '/home/farmaan/actions-runner-caissa'
const P22 = '/home/farmaan/actions-runner-caissatrainer'

describe('the Runner Manager inventory for a renamed repository', () => {
  it('lists the working runner once, under the canonical name, with its installation and GitHub status', async () => {
    const { m, gh } = world()
    await m.scanAndWait()
    const inv = m.inventory()
    const named = inv.runners.filter(r => r.name === 'caissa-pc')
    const active = named.filter(r => r.github?.id === 22)
    expect(active).toHaveLength(1)
    expect(active[0]).toMatchObject({ source: 'both', status: 'online', path: P22, distro: 'Ubuntu-24.04', environment: 'wsl', version: '2.337.0' })
    expect(active[0].scope).toMatchObject({ owner: 'FarmaanFJM', repo: 'CaissaTrainer', repoId: REPO_ID })
    expect(active[0].local?.service.name).toBe('actions.runner.FarmaanFJM-CaissaTrainer.caissa-pc.service')
    expect(inv.runners.filter(r => r.source === 'github')).toHaveLength(0) // no phantom "Not inspected" row
    // the repository was read once, under its current name, not once per alias
    expect(gh.calls.filter(c => c.method === 'GET' && /\/repos\/FarmaanFJM\/(Chess|Caissa)Trainer\/actions\/runners\?/.test(c.path)).every(c => /CaissaTrainer/.test(c.path))).toBe(true)
    expect(inv.scopes.filter(s => s.scope.kind === 'repo' && s.scope.repoId === REPO_ID)).toHaveLength(1)
  })
  it('totals and statuses: the orphan is a local-only row, the other project keeps its runner, and information does not inflate Needs attention', async () => {
    const { m } = world()
    await m.scanAndWait()
    const inv = m.inventory()
    expect(inv.runners.map(r => `${r.name}:${r.local?.agentId ?? r.github?.id}:${r.source}:${r.status}`).sort()).toEqual(['caissa-pc:21:local:unknown', 'caissa-pc:22:both:online', 'other-pc:7:both:online'])
    // only the orphan (registration not found) is a genuine warning; the WSL notice and the patch update on 22 and the other runner are information
    expect(inv.summary).toMatchObject({ total: 3, online: 2, offline: 0, busy: 0, manageable: 3, monitoringOnly: 0, attention: 1, retired: 0 })
    const r22 = inv.runners.find(r => r.local?.agentId === 22)!
    expect(r22.attention).toEqual([]); expect(r22.notices.length).toBe(2)
  })
  it('works from a stored inventory written before aliases were known, and when GitHub cannot identify the repository', async () => {
    const { m, gh } = world()
    gh.intercept = (_m, path) => (/^\/repos\/[^/]+\/[^/]+$/.test(path) || /^\/repositories\//.test(path) ? { status: 404, headers: {}, body: { message: 'Not Found' } } : undefined)
    await m.scanAndWait()
    // without an id the old and the new name are different scopes, but nothing is lost or invented
    expect(m.inventory().runners.some(r => r.github?.id === 22)).toBe(true)
  })
})

describe('retiring an orphaned installation', () => {
  it('hides only the orphan, persistently, without touching any file, service, process or registration', async () => {
    const { m, store, file, make, wsl, gh } = world()
    await m.scanAndWait()
    const orphanRow = m.inventory().runners.find(r => r.local?.agentId === 21)!
    const filesBefore = new Map(wsl.files), unitsBefore = new Map(wsl.services), procsBefore = [...wsl.procs]
    expect(m.retire(orphanRow.key)).toEqual({ ok: true, value: { retired: true } })
    let inv = m.inventory()
    expect(inv.runners.map(r => r.local?.agentId ?? r.github?.id).sort()).toEqual([22, 7].sort())
    expect(inv.summary).toMatchObject({ total: 2, attention: 0, retired: 1 })
    expect(inv.retired).toHaveLength(1); expect(inv.retired[0].runner.path).toBe(P21)
    expect(wsl.files).toEqual(filesBefore); expect(wsl.services).toEqual(unitsBefore); expect(wsl.procs).toEqual(procsBefore)
    expect(gh.calls.filter(c => c.method !== 'GET')).toEqual([])
    expect(store.data.runners.retired).toMatchObject([{ key: O21, path: P21, agentId: 21, name: 'caissa-pc' }])
    // survives a rescan
    await m.scanAndWait()
    inv = m.inventory(); expect(inv.runners).toHaveLength(2); expect(inv.retired).toHaveLength(1)
    // and an application restart (a new store from the same file, a new manager from the same state)
    const reopened = make(new Store(file))
    expect(reopened.inventory().runners.map(r => r.local?.agentId ?? r.github?.id).sort()).toEqual([22, 7].sort())
    expect(reopened.inventory().retired).toHaveLength(1)
    await reopened.scanAndWait()
    expect(reopened.inventory().retired).toHaveLength(1); expect(reopened.inventory().runners).toHaveLength(2)
  })
  it('refuses to retire the working runner, a GitHub-only runner, or an installation that is running', async () => {
    const { m, wsl, gh } = world()
    gh.scopes[1].runners.push({ id: 99, name: 'far-away', os: 'Windows', status: 'offline' })
    await m.scanAndWait()
    const inv = m.inventory()
    const active = inv.runners.find(r => r.local?.agentId === 22)!
    expect(m.retire(active.key)).toMatchObject({ ok: false, error: { code: 'NOT_ORPHANED' } })
    expect(m.retire(inv.runners.find(r => r.github?.id === 99)!.key)).toMatchObject({ ok: false, error: { code: 'NOT_ORPHANED' } })
    wsl.procs.push({ pid: 777, cwd: P21 })
    await m.scanAndWait()
    expect(m.retire(m.inventory().runners.find(r => r.local?.agentId === 21)!.key)).toMatchObject({ ok: false, error: { message: expect.stringMatching(/Running now/) } })
    expect(m.retire('gh:nonexistent')).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })
  it('restores a retired installation, and shows it again by itself when GitHub lists it', async () => {
    const { m, gh, store } = world()
    await m.scanAndWait()
    m.retire(m.inventory().runners.find(r => r.local?.agentId === 21)!.key)
    expect(m.restore(O21)).toMatchObject({ ok: true })
    expect(m.inventory().runners).toHaveLength(3); expect(store.data.runners.retired).toEqual([])
    expect(m.restore(O21)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    m.retire(m.inventory().runners.find(r => r.local?.agentId === 21)!.key)
    gh.scopes[0].runners.push({ id: 21, name: 'caissa-pc', os: 'Linux', status: 'online' }) // registered again
    await m.scanAndWait()
    const inv = m.inventory()
    expect(inv.retired).toHaveLength(0)
    const back = inv.runners.find(r => r.local?.agentId === 21)!
    expect(back.source).toBe('both'); expect(back.notices.join(' ')).toMatch(/retired earlier, but it is active again/)
  })
})

describe('removing the files of a retired installation', () => {
  const retired = async () => { const w = world(); await w.m.scanAndWait(); w.m.retire(w.m.inventory().runners.find(r => r.local?.agentId === 21)!.key); return w }

  it('offers cleanup only for the verified orphan, never for the working installation', async () => {
    const { m } = await retired()
    const [item] = m.inventory().retired
    expect(item.cleanup).toEqual({ allowed: true, reasons: [] })
    expect(m.inventory().runners.every(r => r.key !== item.runner.key)).toBe(true)
    // the working runner cannot be addressed by the cleanup at all
    const key22 = 'wsl:ubuntu-24.04:' + P22
    expect(await m.cleanupRetired(key22, P22)).toMatchObject({ ok: false, error: { code: 'NOT_RETIRED' } })
  })
  it('requires the exact path and deletes nothing otherwise', async () => {
    const { m, wsl } = await retired()
    const before = new Map(wsl.files)
    for (const wrong of ['', P21 + '/', '/home/farmaan/actions-runner-caissa/..', P22, 'actions-runner-caissa']) {
      const r = await m.cleanupRetired(O21, wrong)
      expect(r.ok).toBe(false)
    }
    expect(await m.cleanupRetired(O21, P22)).toMatchObject({ error: { code: 'CONFIRM_MISMATCH' } })
    expect(wsl.files).toEqual(before)
  })
  it('refuses while anything runs from the folder, a service is installed, GitHub lists the registration, or GitHub cannot be read', async () => {
    const { m, wsl, gh } = await retired()
    const before = new Map(wsl.files)
    wsl.procs.push({ pid: 888, cwd: P21 })
    expect(await m.cleanupRetired(O21, P21)).toMatchObject({ ok: false, error: { code: 'REFUSED', message: expect.stringMatching(/Something is running/) } })
    wsl.procs = wsl.procs.filter(p => p.pid !== 888)
    gh.auth = { ...gh.auth, state: 'unauthenticated' } as typeof gh.auth
    expect(await m.cleanupRetired(O21, P21)).toMatchObject({ ok: false, error: { code: 'UNVERIFIED' } })
    gh.auth = { ...gh.auth, state: 'ok' } as typeof gh.auth
    gh.scopes[0].runners.push({ id: 21, name: 'caissa-pc', os: 'Linux', status: 'offline' })
    expect(await m.cleanupRetired(O21, P21)).toMatchObject({ ok: false, error: { message: expect.stringMatching(/lists this registration|registered again/) } })
    expect(wsl.files).toEqual(before)
    expect(gh.calls.filter(c => c.method === 'DELETE')).toEqual([])
  })
  it('refuses when another installation overlaps the folder', async () => {
    const { m, wsl } = await retired()
    wsl.install(P21 + '/nested', { agentId: 40, name: 'nested', url: 'https://github.com/FarmaanFJM/Other', service: null })
    await m.scanAndWait()
    const before = new Map(wsl.files)
    const r = await m.cleanupRetired(O21, P21)
    expect(r).toMatchObject({ ok: false, error: { code: 'REFUSED', message: expect.stringMatching(/overlaps/) } })
    expect(wsl.files).toEqual(before)
  })
  it('deletes exactly the retired folder after verification and leaves runner 22, its service, credentials, work folder, registration and other projects alone', async () => {
    const { m, wsl, gh, store } = await retired()
    wsl.mkdir(P22 + '/_work'); wsl.mkfile(P22 + '/_work/keep.txt', 'work')
    wsl.mkdir(P21 + '/_work'); wsl.mkfile(P21 + '/_work/old.txt', 'old')
    const keep = [...wsl.files.keys()].filter(f => !f.startsWith(P21 + '/') && f !== P21)
    const res = await m.cleanupRetired(O21, P21)
    expect(res).toMatchObject({ ok: true, value: { ok: true, message: expect.stringContaining(P21) } })
    expect([...wsl.files.keys()].filter(f => f === P21 || f.startsWith(P21 + '/'))).toEqual([]); expect(wsl.dirs.has(P21)).toBe(false)
    for (const f of keep) expect(wsl.files.has(f), f).toBe(true)
    expect(wsl.files.has(P22 + '/.credentials')).toBe(true); expect(wsl.files.has(P22 + '/_work/keep.txt')).toBe(true); expect(wsl.files.has(P22 + '/.runner')).toBe(true)
    expect(wsl.services.get('actions.runner.FarmaanFJM-CaissaTrainer.caissa-pc.service')).toEqual({ active: 'active', enabled: 'enabled' })
    expect(wsl.procs.some(p => p.cwd === P22)).toBe(true)
    expect(gh.scopes[0].runners.map(r => r.id)).toEqual([22]) // registration untouched
    expect(gh.calls.filter(c => c.method === 'DELETE' || c.method === 'POST')).toEqual([])
    expect(store.data.runners.retired).toEqual([])
    const inv = m.inventory()
    expect(inv.retired).toHaveLength(0); expect(inv.runners.map(r => r.local?.agentId ?? r.github?.id).sort()).toEqual([22, 7].sort())
    expect(inv.runners.find(r => r.local?.agentId === 22)).toMatchObject({ source: 'both', status: 'online' })
  })
  it('does not delete an installation that was registered again under a new id after it was retired', async () => {
    const { m, wsl } = await retired()
    wsl.mkfile(P21 + '/.runner', JSON.stringify({ agentId: 55, agentName: 'caissa-pc', poolName: 'Default', gitHubUrl: 'https://github.com/FarmaanFJM/CaissaTrainer', workFolder: '_work' }))
    const before = new Map(wsl.files)
    expect(await m.cleanupRetired(O21, P21)).toMatchObject({ ok: false, error: { code: 'CHANGED' } })
    expect(wsl.files).toEqual(before)
  })
})
