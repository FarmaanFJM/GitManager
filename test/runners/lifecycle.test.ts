import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Runner } from '../../src/shared/runners.js'
import { RunnerGitHub } from '../../src/core/runners/github.js'
import { collectDiagnostics, performAction, type LifecycleDeps } from '../../src/core/runners/lifecycle.js'
import { reconcile } from '../../src/core/runners/model.js'
import { inspectOne } from '../../src/core/runners/discovery.js'
import { FakeRunnerGitHub, FakeShell } from './fakes.js'
import { github } from './model.test.js'

const tmp = mkdtempSync(join(tmpdir(), 'gm-life-'))

async function world(o: { running?: boolean; onGitHub?: boolean; busy?: boolean; os?: 'linux' | 'macos'; service?: string | null; version?: string } = {}) {
  const shell = new FakeShell({ kind: 'native' }, o.os ?? 'linux')
  shell.probe.sys = o.os === 'macos' ? 'Darwin' : 'Linux'
  const dir = shell.install('/opt/actions-runner', { running: o.running ?? true, service: o.os === 'macos' ? '/Users/me/Library/LaunchAgents/actions.runner.acme-app.runner-a.plist' : o.service, version: o.version })
  if (o.os === 'macos') shell.launchd.set('actions.runner.acme-app.runner-a', o.running === false ? null : 321)
  const gh = new FakeRunnerGitHub()
  gh.scopes.push({ key: 'acme/app', kind: 'repo', runners: o.onGitHub === false ? [] : [{ id: 11, name: 'runner-a', os: 'Linux', status: 'online', busy: o.busy, labels: ['gpu'] }] })
  gh.repos.push({ full: 'acme/app', admin: true })
  // the runner's own remove command tells GitHub to drop the registration; the fake does the same
  shell.handlers.push(c => { if (c.file === './config.sh' && c.args[0] === 'remove' && /^A[A-Z0-9]{28}$/.test(c.args[2] ?? '') && !shell.removeFails) { const sc = gh.scope('repo', 'acme/app')!; sc.runners = sc.runners.filter(r => r.id !== 11) } return undefined })
  const local = (await inspectOne(shell, null, dir))!
  const runner = reconcile([local], o.onGitHub === false ? [] : [github({ busy: o.busy })])[0]
  const inspected: (string | null)[] = []
  const deps: LifecycleDeps = {
    shellFor: () => shell, github: new RunnerGitHub(gh), tmpDir: tmp, now: Date.now, sleep: async () => {}, latest: async () => ({ version: gh.latest.version, checksums: gh.latest.checksums }),
    download: async (_u, dest) => { writeFileSync(dest, 'pkg'); return { ok: true, sha256: gh.latest.checksums['linux-x64'], bytes: 3 } }, onInspected: l => inspected.push(l ? l.key : null),
  }
  return { shell, gh, runner, deps, inspected, dir }
}

describe('service lifecycle', () => {
  it('stops, starts and restarts a systemd service as root and re-reads the state', async () => {
    const w = await world()
    const stop = await performAction('stop', w.runner, {}, w.deps)
    expect(stop.ok).toBe(true); expect(stop.message).toMatch(/stopped/)
    expect(w.shell.calls.find(c => c.file === 'systemctl')).toMatchObject({ args: ['stop', 'actions.runner.acme-app.runner-a.service'], elevated: true })
    expect(w.shell.services.get('actions.runner.acme-app.runner-a.service')!.active).toBe('inactive')
    const fresh = reconcile([(await inspectOne(w.shell, null, w.dir))!], [github()])[0]
    expect(fresh.capabilities.start.allowed).toBe(true); expect(fresh.capabilities.stop.allowed).toBe(false)
    const start = await performAction('start', fresh, {}, w.deps)
    expect(start.ok).toBe(true)
    const restart = await performAction('restart', reconcile([(await inspectOne(w.shell, null, w.dir))!], [github()])[0], {}, w.deps)
    expect(restart.ok).toBe(true); expect(w.shell.calls.filter(c => c.file === 'systemctl').map(c => c.args[0])).toEqual(['stop', 'start', 'restart'])
    expect(w.inspected.length).toBeGreaterThan(0)
  })
  it('uses svc.sh for a launchd agent without elevation', async () => {
    const w = await world({ os: 'macos' })
    expect(w.runner.local?.service).toMatchObject({ kind: 'launchd', state: 'running' })
    const r = await performAction('stop', w.runner, {}, w.deps)
    expect(r.ok).toBe(true)
    expect(w.shell.calls.filter(c => c.file === './svc.sh').map(c => [c.args[0], c.elevated])).toEqual([['stop', false]])
  })
  it('controls a Windows service through sc.exe as administrator and waits for the state', async () => {
    const shell = new FakeShell({ kind: 'native' }, 'windows')
    let state = 'RUNNING'
    shell.handlers.push(c => {
      if (c.file === 'sc.exe' && c.args[0] === 'stop') { if (!c.elevated) return { code: 1, stdout: '', stderr: '[SC] OpenService FAILED 5: Access is denied.', timedOut: false }; state = 'STOPPED'; return { code: 0, stdout: 'SERVICE_NAME: x\n STATE : 3 STOP_PENDING', stderr: '', timedOut: false } }
      if (c.file === 'sc.exe' && c.args[0] === 'query') return { code: 0, stdout: `SERVICE_NAME: actions.runner.acme-app.win\n        STATE              : ${state === 'RUNNING' ? '4  RUNNING' : '1  STOPPED'}\n`, stderr: '', timedOut: false }
      if (c.file === 'sc.exe' && c.args[0] === 'qc') return { code: 0, stdout: '        START_TYPE         : 2   AUTO_START\n        BINARY_PATH_NAME   : "C:\\r\\bin\\RunnerService.exe"', stderr: '', timedOut: false }
      if (c.file === 'powershell.exe') return { code: 0, stdout: '', stderr: '', timedOut: false }
      if (c.file.endsWith('Runner.Listener.exe')) return { code: 0, stdout: '2.319.1', stderr: '', timedOut: false }
      return undefined
    })
    shell.mkfile('C:\\r\\.runner', JSON.stringify({ agentId: 11, agentName: 'win', gitHubUrl: 'https://github.com/acme/app' })); shell.mkfile('C:\\r\\.service', 'actions.runner.acme-app.win'); shell.mkfile('C:\\r\\.credentials', ''); shell.mkfile('C:\\r\\bin\\Runner.Listener.exe', '')
    const local = (await inspectOne(shell, { host: shell.host, reachable: true, os: 'windows', arch: 'x64', machine: 'PC', user: 'me', systemd: false, sudo: null, message: null }, 'C:\\r'))!
    expect(local.service).toMatchObject({ kind: 'windows-service', state: 'running' })
    const runner = reconcile([local], [])[0]
    const deps: LifecycleDeps = { shellFor: () => shell, github: null, tmpDir: tmp, latest: async () => null, sleep: async () => {} }
    const r = await performAction('stop', runner, {}, deps)
    expect(r.ok).toBe(true)
    expect(shell.calls.filter(c => c.file === 'sc.exe' && c.args[0] === 'stop').map(c => c.elevated)).toEqual([true])
  })
  it('stops a manually started runner only through its identified process, and refuses to start without a service', async () => {
    const w = await world({ service: null })
    w.shell.procs.push({ pid: 777, cwd: '/opt/actions-runner' })
    const local = (await inspectOne(w.shell, null, w.dir))!
    expect(local.service.kind).toBe('none'); expect(local.process.pids).toEqual([777])
    const runner = reconcile([local], [])[0]
    const r = await performAction('stop', runner, {}, w.deps)
    expect(r.ok).toBe(true)
    expect(w.shell.calls.filter(c => c.file === 'kill').map(c => c.args)).toEqual([['-TERM', '777']])
    const again = reconcile([(await inspectOne(w.shell, null, w.dir))!], [])[0]
    expect((await performAction('start', again, {}, w.deps)).message).toMatch(/run\.sh/)
  })
})

describe('busy, confirmation and update safety', () => {
  it('refuses to stop, restart, update, unregister or uninstall a runner GitHub reports busy unless allowBusy is set', async () => {
    const w = await world({ busy: true })
    for (const a of ['stop', 'restart', 'update', 'unregister', 'uninstall'] as const) {
      const r = await performAction(a, w.runner, { confirm: true }, w.deps)
      expect(r.ok, a).toBe(false); expect(r.message).toMatch(/running a job/)
    }
    expect(w.shell.calls.filter(c => c.file === 'systemctl')).toHaveLength(0)
    const forced = await performAction('stop', w.runner, { allowBusy: true }, w.deps)
    expect(forced.ok).toBe(true)
  })
  it('needs an explicit confirmation for update, unregister and uninstall', async () => {
    const w = await world()
    for (const a of ['update', 'unregister', 'uninstall'] as const) expect((await performAction(a, w.runner, {}, w.deps)).message).toMatch(/explicit confirmation/)
  })
  it('reports available updates without confusing them with the runner self-update', async () => {
    const w = await world({ version: '2.319.1' })
    const r = await performAction('check-update', w.runner, {}, w.deps)
    expect(r.ok).toBe(true); expect(r.updateAvailable).toEqual({ installed: '2.319.1', latest: '2.321.0' }); expect(r.message).toMatch(/updates itself/)
    const current = await world({ version: '2.321.0' })
    expect((await performAction('check-update', current.runner, {}, current.deps)).updateAvailable).toBeNull()
  })
  it('updates in place keeping the registration, restarting only if it was running, and restores the old files when the new ones are bad', async () => {
    const w = await world({ version: '2.319.1' })
    const r = await performAction('update', w.runner, { confirm: true }, w.deps)
    expect(r.ok, r.message).toBe(true); expect(r.message).toMatch(/updated to 2\.321\.0/)
    expect(w.shell.files.get('/opt/actions-runner/bin/Runner.Listener')).toBe('version=2.321.0')
    expect(w.shell.files.has('/opt/actions-runner/.runner')).toBe(true); expect(w.shell.files.has('/opt/actions-runner/.credentials')).toBe(true)
    expect([...w.shell.dirs].some(d => d.includes('.gm-old-'))).toBe(false)
    expect(w.shell.calls.filter(c => c.file === 'systemctl').map(c => c.args[0])).toEqual(['stop', 'start'])
    const bad = await world({ version: '2.319.1', running: false })
    bad.shell.packageVersion = '2.320.0' // the extracted runner reports the wrong version
    const b = await performAction('update', bad.runner, { confirm: true }, bad.deps)
    expect(b.ok).toBe(false); expect(b.message).toMatch(/previous program files were restored/)
    expect(bad.shell.files.get('/opt/actions-runner/bin/Runner.Listener')).toBe('version=2.319.1')
    expect(bad.shell.calls.filter(c => c.file === 'systemctl')).toHaveLength(0)
  })
})

describe('unregister and uninstall', () => {
  it('removes the service, runs the runner\'s own remove with a removal token, and confirms with GitHub; files stay', async () => {
    const w = await world()
    const r = await performAction('unregister', w.runner, { confirm: true }, w.deps)
    expect(r.ok, r.message).toBe(true); expect(r.message).toMatch(/no longer registered.*files remain in \/opt\/actions-runner/)
    expect(w.shell.calls.filter(c => c.file === './svc.sh').map(c => c.args[0])).toEqual(['stop', 'uninstall'])
    const remove = w.shell.calls.find(c => c.file === './config.sh' && c.args[0] === 'remove')!
    expect(remove.args[2]).toMatch(/^A[A-Z0-9]{28}$/)
    expect(w.gh.calls.some(c => c.method === 'POST' && c.path.endsWith('/remove-token'))).toBe(true)
    expect(w.gh.scope('repo', 'acme/app')!.runners).toEqual([])
    expect(w.shell.files.has('/opt/actions-runner/bin/Runner.Listener')).toBe(true)
    expect(w.shell.files.has('/opt/actions-runner/.runner')).toBe(false)
    expect(JSON.stringify(r)).not.toMatch(/A[A-Z0-9]{28}/)
  })
  it('falls back to removing the registration on GitHub when the local remove fails, and removes a GitHub-only runner through the API', async () => {
    const w = await world()
    w.shell.removeFails = true
    w.shell.handlers.unshift(c => (c.file === './config.sh' && c.args[0] === 'remove' ? { code: 1, stdout: '', stderr: 'Failed to remove: credentials missing', timedOut: false } : undefined))
    const r = await performAction('unregister', w.runner, { confirm: true }, w.deps)
    expect(r.ok, r.message).toBe(true)
    expect(w.gh.calls.some(c => c.method === 'DELETE' && c.path === '/repos/acme/app/actions/runners/11')).toBe(true)
    const remote = await world()
    const ghOnly: Runner = reconcile([], [github({ id: 11 })])[0]
    const rr = await performAction('unregister', ghOnly, { confirm: true }, remote.deps)
    expect(rr.ok).toBe(true); expect(rr.message).toMatch(/files on its machine were not touched/)
    expect(remote.shell.calls.filter(c => c.file === './config.sh')).toHaveLength(0)
  })
  it('refuses to delete the files of a runner that is still registered unless the registration is removed first, then deletes exactly that directory', async () => {
    const w = await world()
    const refused = await performAction('uninstall', w.runner, { confirm: true }, w.deps)
    expect(refused.ok).toBe(false); expect(refused.message).toMatch(/still registered/)
    expect(w.shell.dirs.has('/opt/actions-runner')).toBe(true)
    const done = await performAction('uninstall', w.runner, { confirm: true, unregisterFirst: true }, w.deps)
    expect(done.ok, done.message).toBe(true); expect(done.message).toMatch(/\/opt\/actions-runner was deleted and the registration removed/)
    expect(w.shell.dirs.has('/opt/actions-runner')).toBe(false)
    expect(w.shell.dirs.has('/opt')).toBe(true)
    expect(w.inspected[w.inspected.length - 1]).toBeNull()
  })
  it('uninstalls an unregistered or partial installation after removing its service, and never deletes a folder that is not an installation or a system path', async () => {
    const w = await world({ onGitHub: false })
    const r = await performAction('uninstall', w.runner, { confirm: true }, w.deps)
    expect(r.ok, r.message).toBe(true)
    expect(w.shell.calls.filter(c => c.file === './svc.sh').map(c => c.args[0])).toEqual(['stop', 'uninstall'])
    const notInstall = await world({ onGitHub: false })
    for (const f of [...notInstall.shell.files.keys()]) if (f.startsWith('/opt/actions-runner/')) notInstall.shell.files.delete(f)
    expect((await performAction('uninstall', notInstall.runner, { confirm: true }, notInstall.deps)).message).toMatch(/does not look like a runner installation/)
    const sys = await world({ onGitHub: false })
    const bogus = { ...sys.runner, local: { ...sys.runner.local!, path: '/usr' } }
    expect((await performAction('uninstall', bogus, { confirm: true }, sys.deps)).message).toMatch(/Refused/)
    expect(sys.shell.calls.filter(c => c.file === 'rm')).toHaveLength(0)
  })
})

describe('diagnostics', () => {
  it('reads the newest diagnostic logs, redacted, and refreshes the service state', async () => {
    const w = await world()
    w.shell.mkfile('/opt/actions-runner/_diag/Runner_20261030-100001-utc.log', '[INFO] Version: 2.319.1\n[INFO] token ghp_abcdefghijklmnopqrstuvwxyz0123456789 used\n')
    const d = await collectDiagnostics(w.runner, w.deps)
    expect(d.logs).toHaveLength(1); expect(d.logs[0].tail[1]).toBe('[INFO] token [redacted] used'); expect(d.logs[0].sizeBytes).toBeGreaterThan(0)
    expect(d.service.state).toBe('running')
  })
})
