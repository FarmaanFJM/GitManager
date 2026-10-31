import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { InstallJob, InstallRequest } from '../../src/shared/runners.js'
import { RunnerGitHub } from '../../src/core/runners/github.js'
import { commandPreviews, configureArgs, planInstall, runInstall, validateRequest, windowsConfigureArgs, type InstallDeps } from '../../src/core/runners/install.js'
import { FakeRunnerGitHub, FakeShell } from './fakes.js'

const tmp = mkdtempSync(join(tmpdir(), 'gm-install-'))
afterEach(() => { for (const f of ['x']) void f })
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }))

const request = (over: Partial<InstallRequest> = {}): InstallRequest => ({
  host: { kind: 'native' }, scope: { kind: 'repo', owner: 'acme', repo: 'app' }, name: 'build-box', directory: '/home/me/actions-runners/build-box', labels: ['gpu'], runnerGroup: null,
  installService: true, serviceUser: null, windowsAccount: null, windowsAccountName: null, startAfter: true, replace: false, ephemeral: false, disableUpdate: false, workFolder: '_work', ...over,
})

function world(o: { shell?: FakeShell; gh?: FakeRunnerGitHub; sha?: string } = {}) {
  const shell = o.shell ?? new FakeShell()
  shell.mkdir('/home/me')
  const gh = o.gh ?? new FakeRunnerGitHub()
  if (!gh.scopes.length) gh.scopes.push({ key: 'acme/app', kind: 'repo', runners: [] })
  if (!gh.repos.length) gh.repos.push({ full: 'acme/app', admin: true })
  // the fake configure step registers the runner on the fake GitHub, as the real one would
  shell.handlers.push(c => { if (c.file === './config.sh' && c.args[0] !== 'remove' && !shell.configureFails) gh.addRunner('repo', 'acme/app', { id: shell.nextAgentId, name: c.args[c.args.indexOf('--name') + 1], status: 'online' }); return undefined })
  const downloads: string[] = []
  const deps: InstallDeps = {
    shellFor: () => shell, github: new RunnerGitHub(gh), tmpDir: tmp, existing: () => [], githubRunners: () => [], now: Date.now, sleep: async () => {}, onlineWaitMs: 10,
    download: async (url, dest, opts) => { downloads.push(url); if (opts.signal.cancelled) return { ok: false, message: 'Cancelled.' }; writeFileSync(dest, 'pkg'); return { ok: true, sha256: o.sha ?? gh.latest.checksums['linux-x64'], bytes: 3 } },
  }
  return { shell, gh, deps, downloads }
}

const run = async (w: ReturnType<typeof world>, req: InstallRequest, onUpdate?: (j: InstallJob) => void) => {
  const plan = await planInstall(req, w.deps)
  const job = await runInstall(plan, w.deps, onUpdate ?? (() => {}))
  return { plan, job }
}

describe('request validation', () => {
  it('accepts a complete request and refuses unsafe names, labels, groups and accounts', () => {
    const ok = validateRequest(request())
    expect(ok.ok && ok.request.labels).toEqual(['gpu'])
    expect(validateRequest({ ...request(), name: 'a b' })).toMatchObject({ ok: false, message: expect.stringMatching(/runner name/) })
    expect(validateRequest({ ...request(), labels: ['x y'] })).toMatchObject({ ok: false })
    expect(validateRequest({ ...request(), runnerGroup: 'g;rm' })).toMatchObject({ ok: false })
    expect(validateRequest({ ...request(), windowsAccount: 'custom', windowsAccountName: '' })).toMatchObject({ ok: false })
    expect(validateRequest({ ...request(), host: { kind: 'wsl', distro: 'Ubuntu;x' } })).toMatchObject({ ok: false })
    expect(validateRequest({ ...request(), scope: { kind: 'repo', owner: '../x', repo: 'y' } })).toMatchObject({ ok: false })
    expect(validateRequest({ ...request(), workFolder: '../../etc' })).toMatchObject({ ok: false })
    const dedup = validateRequest({ ...request(), labels: ['gpu', 'gpu', 'self-hosted', 'Linux'] })
    expect(dedup.ok && dedup.request.labels).toEqual(['gpu'])
    expect(validateRequest(null)).toMatchObject({ ok: false })
  })
})

describe('command construction', () => {
  it('builds the documented configure arguments with the token as its own argument, never inside a shell string', () => {
    const args = configureArgs(request({ labels: ['gpu', 'docker'], runnerGroup: 'GPU pool', replace: true, ephemeral: true, disableUpdate: true }), 'AABF3JGZDX3P5PMEXLND6TS7D4J6M')
    expect(args).toEqual(['--unattended', '--url', 'https://github.com/acme/app', '--token', 'AABF3JGZDX3P5PMEXLND6TS7D4J6M', '--name', 'build-box', '--work', '_work', '--labels', 'gpu,docker', '--runnergroup', 'GPU pool', '--replace', '--ephemeral', '--disableupdate'])
    expect(configureArgs(request({ scope: { kind: 'org', org: 'acme' }, labels: [] }), 't')).toContain('https://github.com/acme')
    expect(windowsConfigureArgs(request({ windowsAccount: 'local-system' }), 't')).toEqual(expect.arrayContaining(['configure', '--runasservice', '--windowslogonaccount', 'LocalSystem']))
    expect(windowsConfigureArgs(request({ windowsAccount: 'network-service' }), 't')).not.toContain('--windowslogonaccount')
    expect(windowsConfigureArgs(request({ installService: false }), 't')).not.toContain('--runasservice')
  })
  it('previews every command with a placeholder for the token', () => {
    const p = commandPreviews(request(), 'linux', { version: '2.321.0', os: 'linux', arch: 'x64', filename: 'actions-runner-linux-x64-2.321.0.tar.gz', downloadUrl: 'https://github.com/actions/runner/releases/download/v2.321.0/actions-runner-linux-x64-2.321.0.tar.gz', sha256: 'a'.repeat(64), checksumSource: 'downloads-api' }, 'me')
    expect(p.map(c => c.title)).toEqual(['Download and verify', 'Extract', 'Configure and register', 'Install service', 'Start service'])
    expect(p[2].command).toContain('--token <registration token>')
    expect(p[3]).toMatchObject({ command: './svc.sh install me', elevated: true })
    const w = commandPreviews(request({ host: { kind: 'native' } }), 'windows', null, null)
    expect(w[1].command).toMatch(/^bin\\Runner\.Listener\.exe configure/); expect(w[1].elevated).toBe(true)
  })
})

describe('planning', () => {
  it('produces a complete plan for a reachable Linux host with systemd and administration permission', async () => {
    const w = world()
    const plan = await planInstall(request(), w.deps)
    expect(plan.blockers).toEqual([])
    expect(plan.target).toMatchObject({ os: 'linux', arch: 'x64', machine: 'build-box', user: 'me', systemd: true })
    expect(plan.pkg).toMatchObject({ filename: 'actions-runner-linux-x64-2.321.0.tar.gz', sha256: 'a'.repeat(64), checksumSource: 'downloads-api' })
    expect(plan.access).toMatchObject({ checked: true, canRegister: true })
    expect(plan.serviceName).toBe('actions.runner.acme-app.build-box.service')
    expect(plan.request.serviceUser).toBe('me')
    expect(plan.elevation.needed).toBe(true)
    expect(plan.warnings.join(' ')).toMatch(/public repository/)
    expect(w.gh.calls.filter(c => c.method === 'POST')).toHaveLength(0) // planning never requests a token
  })
  it('falls back to the release notes checksum when the downloads endpoint is not permitted, and refuses without any checksum', async () => {
    const w = world(); w.gh.downloads = 'forbidden'
    const plan = await planInstall(request(), w.deps)
    expect(plan.pkg).toMatchObject({ checksumSource: 'release-notes', sha256: 'a'.repeat(64) })
    w.gh.latest.checksums = {}
    const noSum = await planInstall(request(), w.deps)
    expect(noSum.blockers.join(' ')).toMatch(/No SHA-256 checksum/)
  })
  it('blocks collisions: a non-empty directory, an existing installation, a service name in use, a GitHub name without Replace', async () => {
    const w = world()
    w.shell.mkfile('/home/me/actions-runners/build-box/README', 'x')
    expect((await planInstall(request(), w.deps)).blockers.join(' ')).toMatch(/exists and is not empty/)
    const w2 = world(); w2.gh.addRunner('repo', 'acme/app', { name: 'Build-Box' })
    const p2 = await planInstall(request(), { ...w2.deps, githubRunners: () => [{ id: 1, name: 'Build-Box', os: 'Linux', status: 'offline', busy: false, labels: [], scope: { kind: 'repo', owner: 'acme', repo: 'app' }, runnerGroupId: null, runnerGroupName: null, ephemeral: null, fetchedAt: '' }] })
    expect(p2.blockers.join(' ')).toMatch(/already lists a runner named build-box/)
    const p3 = await planInstall(request({ replace: true }), { ...w2.deps, githubRunners: () => [{ id: 1, name: 'Build-Box', os: 'Linux', status: 'offline', busy: false, labels: [], scope: { kind: 'repo', owner: 'acme', repo: 'app' }, runnerGroupId: null, runnerGroupName: null, ephemeral: null, fetchedAt: '' }] })
    expect(p3.blockers).toEqual([]); expect(p3.warnings.join(' ')).toMatch(/Replace/)
    const w3 = world()
    const existing = { key: 'posix:/home/me/actions-runners/other', host: { kind: 'native' as const }, path: '/home/me/actions-runners/other', os: 'linux' as const, arch: 'x64' as const, machine: 'b', agentId: 1, agentName: 'build-box', scope: { kind: 'repo' as const, owner: 'acme', repo: 'app' }, gitHubUrl: '', poolName: null, ephemeral: null, disableUpdate: null, workFolder: null, version: null, versionSource: null, service: { kind: 'systemd' as const, name: 'actions.runner.acme-app.build-box.service', state: 'running' as const, startup: 'automatic' as const, detail: null }, process: { running: true, pids: [], detail: null }, configured: true, hasCredentials: true, partial: false, warnings: [], inspectedAt: '', source: 'scan' as const }
    const p4 = await planInstall(request(), { ...w3.deps, existing: () => [existing] })
    expect(p4.blockers.join(' ')).toMatch(/already installed here/)
    expect(p4.blockers.join(' ')).toMatch(/service named actions\.runner\.acme-app\.build-box\.service already exists/)
  })
  it('blocks a service without systemd (with the WSL hint), without a user, with password sudo, and an unknown architecture', async () => {
    const w = world(); w.shell.probe.init = 'init'
    expect((await planInstall(request(), w.deps)).blockers.join(' ')).toMatch(/systemd is not running on this machine/)
    const wsl = world({ shell: new FakeShell({ kind: 'wsl', distro: 'Ubuntu' }) }); wsl.shell.probe.init = 'init'; wsl.shell.mkdir('/home/me')
    expect((await planInstall(request({ host: { kind: 'wsl', distro: 'Ubuntu' } }), wsl.deps)).blockers.join(' ')).toMatch(/wsl\.conf/)
    const root = world(); root.shell.probe.user = 'root'
    expect((await planInstall(request(), root.deps)).blockers.join(' ')).toMatch(/Choose the user/)
    const sudo = world(); sudo.shell.probe.sudo = false
    expect((await planInstall(request(), sudo.deps)).blockers.join(' ')).toMatch(/sudo asks for a password/)
    const noSvc = await planInstall(request({ installService: false }), sudo.deps)
    expect(noSvc.blockers).toEqual([]); expect(noSvc.elevation.needed).toBe(false)
    const arch = world(); arch.shell.probe.machine = 'riscv64'
    expect((await planInstall(request(), arch.deps)).blockers.join(' ')).toMatch(/architecture/)
  })
  it('blocks when the sign-in cannot administer the repository or the organization, and when the host is unreachable', async () => {
    const w = world(); w.gh.repos[0].admin = false
    const p = await planInstall(request(), w.deps)
    expect(p.access.canRegister).toBe(false); expect(p.blockers.join(' ')).toMatch(/administrator permission/)
    const o = world(); o.gh.orgs.push({ login: 'acme', role: 'member' }); o.gh.scopes.push({ key: 'acme', kind: 'org', runners: [] })
    expect((await planInstall(request({ scope: { kind: 'org', org: 'acme' } }), o.deps)).blockers.join(' ')).toMatch(/member, not an administrator/)
    const down = world({ shell: new FakeShell({ kind: 'ssh', host: 'nas' }) })
    down.shell.handlers.unshift(c => (c.file === 'sh' ? { code: 255, stdout: '', stderr: 'ssh: connect to host nas: Connection refused', timedOut: false } : undefined))
    const dp = await planInstall(request({ host: { kind: 'ssh', host: 'nas' } }), down.deps)
    expect(dp.blockers[0]).toMatch(/Connection refused|could not be reached|failed/)
  })
})

describe('installation', () => {
  it('runs every step on Linux: verified download, extraction, configure with the token, service, start, GitHub and local verification', async () => {
    const w = world()
    const updates: string[] = []
    const { job } = await run(w, request(), j => updates.push(j.steps.filter(s => s.state === 'running').map(s => s.id).join()))
    expect(job.state).toBe('done')
    expect(job.steps.map(s => `${s.id}:${s.state}`)).toEqual(['environment:done', 'github:done', 'download:done', 'verify:done', 'extract:done', 'configure:done', 'register:done', 'service:done', 'start:done', 'verify-registration:done', 'verify-service:done'])
    expect(job.outcome).toEqual({ downloaded: true, extracted: true, registered: true, serviceInstalled: true, running: true, verified: true })
    const cfg = w.shell.configured[0]
    expect(cfg.dir).toBe('/home/me/actions-runners/build-box')
    expect(cfg.args.slice(0, 4)).toEqual(['--unattended', '--url', 'https://github.com/acme/app', '--token'])
    expect(w.gh.tokens).toContain(cfg.args[4])
    expect(cfg.args).toEqual(expect.arrayContaining(['--name', 'build-box', '--labels', 'gpu']))
    const svcCalls = w.shell.calls.filter(c => c.file === './svc.sh')
    expect(svcCalls.map(c => [c.args.join(' '), c.elevated])).toEqual([['install me', true], ['start', true]])
    expect(w.shell.files.has('/home/me/actions-runners/build-box/.service')).toBe(true)
    expect(w.gh.scope('repo', 'acme/app')!.runners.map(r => r.name)).toEqual(['build-box'])
    // the token never reaches the log or step messages
    const everything = JSON.stringify(job)
    for (const t of w.gh.tokens) expect(everything).not.toContain(t)
    expect(job.log.some(l => /--token \[redacted\]/.test(l))).toBe(true)
    expect(updates.length).toBeGreaterThan(10)
    expect(job.runnerKey).toBe('posix:/home/me/actions-runners/build-box')
  })

  it('stops before anything is written when the registration token has already expired', async () => {
    const w = world(); w.gh.tokenExpiresAt = new Date(Date.now() - 1000).toISOString()
    const { job } = await run(w, request())
    expect(job.state).toBe('failed'); expect(job.error?.step).toBe('github'); expect(job.error?.message).toMatch(/already expired/)
    expect(job.outcome.downloaded).toBe(false)
    expect(w.downloads).toEqual([])
  })

  it('refuses a download whose SHA-256 does not match, without extracting', async () => {
    const w = world({ sha: 'f'.repeat(64) })
    const { job } = await run(w, request())
    expect(job.state).toBe('failed'); expect(job.error?.step).toBe('verify')
    expect(job.outcome).toMatchObject({ downloaded: true, extracted: false, registered: false })
    expect(w.shell.files.has('/home/me/actions-runners/build-box/bin/Runner.Listener')).toBe(false)
    expect(job.error?.recovery.join(' ')).toMatch(/The file was not used/)
  })

  it('keeps the extracted files and says exactly what happened when configure fails, and reports GitHub refusals as permission problems', async () => {
    const w = world(); w.shell.configureFails = 'Http response code: Forbidden from https://api.github.com/actions/runner-registration'
    const { job } = await run(w, request())
    expect(job.state).toBe('failed'); expect(job.error?.step).toBe('configure')
    expect(job.error?.message).toMatch(/GitHub refused the registration/)
    expect(job.outcome).toMatchObject({ downloaded: true, extracted: true, registered: false, serviceInstalled: false, running: false })
    expect(w.shell.files.has('/home/me/actions-runners/build-box/bin/Runner.Listener')).toBe(true)
    expect(w.shell.files.has('/home/me/actions-runners/build-box/.runner')).toBe(false)
    expect(job.error?.recovery.join(' ')).toMatch(/Files are in \/home\/me\/actions-runners\/build-box\. Nothing was registered on GitHub/)
    expect(w.shell.calls.filter(c => c.file === './svc.sh')).toHaveLength(0)
    const perm = world(); perm.gh.scopes[0].admin = false; perm.gh.repos[0].admin = true
    const r = await run(perm, request())
    expect(r.job.error?.step).toBe('github'); expect(r.job.error?.recovery.join(' ')).toMatch(/repository administration/)
  })

  it('reports a service failure after a successful registration as a partial installation with the manual step', async () => {
    const w = world()
    w.shell.handlers.unshift(c => (c.file === './svc.sh' && c.args[0] === 'install' ? { code: 1, stdout: '', stderr: 'Failed to enable unit', timedOut: false } : undefined))
    const { job } = await run(w, request())
    expect(job.state).toBe('failed'); expect(job.error?.step).toBe('service')
    expect(job.outcome).toMatchObject({ registered: true, serviceInstalled: false, running: false })
    expect(job.error?.recovery[0]).toMatch(/sudo \.\/svc\.sh install me/)
    expect(job.error?.recovery.join(' ')).toMatch(/The runner is registered on GitHub/)
  })

  it('installs without a service and without starting when asked, and skips the steps visibly', async () => {
    const w = world()
    const { job } = await run(w, request({ installService: false, startAfter: false }))
    expect(job.state).toBe('done')
    expect(job.steps.find(s => s.id === 'service')).toMatchObject({ state: 'skipped', message: expect.stringMatching(/run\.sh/) })
    expect(job.steps.find(s => s.id === 'start')?.state).toBe('skipped')
    expect(job.outcome).toMatchObject({ registered: true, serviceInstalled: false, running: false, verified: true })
  })

  it('cancels between steps and reports what was done, deleting nothing', async () => {
    const w = world()
    let cancelled = false
    const plan = await planInstall(request(), w.deps)
    const job = await runInstall(plan, w.deps, j => { if (!cancelled && j.steps.find(s => s.id === 'download')?.state === 'done') { cancelled = true; j.cancelRequested = true } })
    expect(job.state).toBe('cancelled')
    expect(job.outcome.downloaded).toBe(true); expect(job.outcome.registered).toBe(false)
    expect(w.shell.configured).toHaveLength(0)
    expect(job.log[job.log.length - 1]).toMatch(/Cancelled/)
  })

  it('copies the package to a WSL or SSH host, re-verifies it there, and removes the archive afterwards', async () => {
    const shell = new FakeShell({ kind: 'wsl', distro: 'Ubuntu' })
    shell.handlers.push(c => (c.file === 'sha256sum' ? { code: 0, stdout: `${'a'.repeat(64)}  ${c.args[0]}\n`, stderr: '', timedOut: false } : undefined))
    const w = world({ shell })
    const { job } = await run(w, request({ host: { kind: 'wsl', distro: 'Ubuntu' } }))
    expect(job.state).toBe('done')
    expect(w.shell.calls.some(c => c.file === 'putFile' && c.args[0] === '/home/me/actions-runners/build-box/actions-runner-linux-x64-2.321.0.tar.gz')).toBe(true)
    expect(w.shell.calls.some(c => c.file === 'rm' && c.args.includes('/home/me/actions-runners/build-box/actions-runner-linux-x64-2.321.0.tar.gz'))).toBe(true)
    expect(job.log.join('\n')).toMatch(/re-verified on the target/)
  })

  it('never runs a plan with blockers', async () => {
    const w = world(); w.shell.mkfile('/home/me/actions-runners/build-box/old', 'x')
    const { job } = await run(w, request())
    expect(job.state).toBe('failed'); expect(job.error?.step).toBe('environment')
    expect(w.downloads).toEqual([]); expect(w.gh.tokens).toEqual([])
  })
})
