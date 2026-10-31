import { describe, expect, it } from 'vitest'
import type { GitHubRunner, LocalRunner } from '../../src/shared/runners.js'
import {
  capabilitiesFor, checkInstallDirectory, compareVersions, defaultLabels, installKey, predictedServiceName, reconcile, repoFromRemote, runsOnExample, scopeFromUrl, scopeKey, scopeSettingsUrl, summarize, validLabel, validRunnerName,
} from '../../src/core/runners/model.js'
import { redact, redactArgs } from '../../src/core/runners/redact.js'

export const local = (over: Partial<LocalRunner> = {}): LocalRunner => ({
  key: installKey(over.host ?? { kind: 'native' }, over.path ?? '/opt/actions-runner'), host: { kind: 'native' }, path: '/opt/actions-runner', os: 'linux', arch: 'x64', machine: 'box', agentId: 11, agentName: 'runner-a',
  scope: { kind: 'repo', owner: 'acme', repo: 'app' }, gitHubUrl: 'https://github.com/acme/app', poolName: 'Default', ephemeral: false, disableUpdate: false, workFolder: '_work', version: '2.319.1', versionSource: 'listener',
  service: { kind: 'systemd', name: 'actions.runner.acme-app.runner-a.service', state: 'running', startup: 'automatic', detail: null }, process: { running: true, pids: [4001], detail: null },
  configured: true, hasCredentials: true, partial: false, warnings: [], inspectedAt: '2026-10-31T00:00:00Z', source: 'scan', ...over,
})
export const github = (over: Partial<GitHubRunner> = {}): GitHubRunner => ({
  id: 11, name: 'runner-a', os: 'Linux', status: 'online', busy: false, labels: [{ name: 'self-hosted', type: 'read-only' }, { name: 'Linux', type: 'read-only' }, { name: 'X64', type: 'read-only' }, { name: 'gpu', type: 'custom' }],
  scope: { kind: 'repo', owner: 'acme', repo: 'app' }, runnerGroupId: null, runnerGroupName: null, ephemeral: false, fetchedAt: '2026-10-31T00:00:00Z', ...over,
})

describe('scopes and identities', () => {
  it('reads repository and organization scopes from the registration URL and nothing else', () => {
    expect(scopeFromUrl('https://github.com/acme/app')).toEqual({ kind: 'repo', owner: 'acme', repo: 'app' })
    expect(scopeFromUrl('https://github.com/acme')).toEqual({ kind: 'org', org: 'acme' })
    expect(scopeFromUrl('https://github.com/acme/app.git/')).toEqual({ kind: 'repo', owner: 'acme', repo: 'app' })
    expect(scopeFromUrl('https://ghes.example.com/acme/app')).toBeNull()
    expect(scopeFromUrl('http://github.com/acme/app')).toBeNull()
    expect(scopeFromUrl('https://github.com/acme/app/settings')).toBeNull()
    expect(scopeFromUrl(null)).toBeNull()
  })
  it('keys scopes case-insensitively and builds GitHub settings links', () => {
    expect(scopeKey({ kind: 'repo', owner: 'Acme', repo: 'App' })).toBe(scopeKey({ kind: 'repo', owner: 'acme', repo: 'app' }))
    expect(scopeSettingsUrl({ kind: 'repo', owner: 'acme', repo: 'app' }, 7)).toBe('https://github.com/acme/app/settings/actions/runners/7')
    expect(scopeSettingsUrl({ kind: 'org', org: 'acme' })).toBe('https://github.com/organizations/acme/settings/actions/runners')
  })
  it('recognizes github.com remotes in https and ssh form', () => {
    expect(repoFromRemote('https://github.com/Acme/App.git')).toBe('Acme/App')
    expect(repoFromRemote('git@github.com:acme/app.git')).toBe('acme/app')
    expect(repoFromRemote('ssh://git@github.com/acme/app')).toBe('acme/app')
    expect(repoFromRemote('https://gitlab.com/acme/app.git')).toBeNull()
  })
  it('gives one identity to an installation however its path is written (Windows case, WSL UNC, /mnt mirrors)', () => {
    expect(installKey({ kind: 'native' }, 'C:\\Actions-Runner\\')).toBe(installKey({ kind: 'native' }, 'c:/actions-runner'))
    expect(installKey({ kind: 'native' }, '\\\\wsl.localhost\\Ubuntu\\home\\me\\runner')).toBe(installKey({ kind: 'wsl', distro: 'Ubuntu' }, '/home/me/runner'))
    expect(installKey({ kind: 'wsl', distro: 'Ubuntu' }, '/mnt/c/runners/a')).toBe(installKey({ kind: 'native' }, 'C:\\runners\\a'))
    expect(installKey({ kind: 'ssh', host: 'Build' }, '/opt/r/')).toBe(installKey({ kind: 'ssh', host: 'build' }, '/opt/r'))
    expect(installKey({ kind: 'wsl', distro: 'Ubuntu' }, '/opt/r')).not.toBe(installKey({ kind: 'wsl', distro: 'Debian' }, '/opt/r'))
  })
})

describe('validation of names, labels and directories', () => {
  it('accepts runner names and labels GitHub accepts and refuses shell metacharacters', () => {
    expect(validRunnerName('build-box.01_x')).toBe(true)
    expect(validRunnerName('bad name')).toBe(false)
    expect(validRunnerName('-leading')).toBe(false)
    expect(validRunnerName('x'.repeat(65))).toBe(false)
    expect(validLabel('gpu')).toBe(true)
    expect(validLabel('team:ci/linux+docker')).toBe(true)
    expect(validLabel('a,b')).toBe(false)
    expect(validLabel('$(rm -rf /)')).toBe(false)
  })
  it('refuses system roots, dot segments and quoting characters in installation directories, on both path flavours', () => {
    expect(checkInstallDirectory('linux', '/opt/actions-runner')).toEqual({ ok: true, path: '/opt/actions-runner' })
    expect(checkInstallDirectory('linux', '/home/me/runners/a/')).toEqual({ ok: true, path: '/home/me/runners/a' })
    expect(checkInstallDirectory('linux', '/').ok).toBe(false)
    expect(checkInstallDirectory('linux', '/usr/bin/x').ok).toBe(false)
    expect(checkInstallDirectory('linux', '/opt/../etc/x').ok).toBe(false)
    expect(checkInstallDirectory('linux', "/opt/it's").ok).toBe(false)
    expect(checkInstallDirectory('linux', '/opt/a;b').ok).toBe(false)
    expect(checkInstallDirectory('linux', '/mnt/c/runners').ok).toBe(false)
    expect(checkInstallDirectory('linux', 'relative').ok).toBe(false)
    expect(checkInstallDirectory('windows', 'C:\\actions-runner')).toEqual({ ok: true, path: 'C:\\actions-runner' })
    expect(checkInstallDirectory('windows', 'C:/runners/a').ok && checkInstallDirectory('windows', 'C:/runners/a')).toMatchObject({ path: 'C:\\runners\\a' })
    expect(checkInstallDirectory('windows', 'C:\\').ok).toBe(false)
    expect(checkInstallDirectory('windows', 'C:\\Windows\\runner').ok).toBe(false)
    expect(checkInstallDirectory('windows', 'C:\\Program Files\\r').ok).toBe(false)
    expect(checkInstallDirectory('windows', 'C:\\Users\\me\\runner').ok).toBe(true)
    expect(checkInstallDirectory('windows', 'C:\\r%x').ok).toBe(false)
    expect(checkInstallDirectory('windows', '/opt/r').ok).toBe(false)
  })
  it('predicts the service name the runner creates', () => {
    expect(predictedServiceName({ kind: 'repo', owner: 'acme', repo: 'app' }, 'build-box', 'linux')).toBe('actions.runner.acme-app.build-box.service')
    expect(predictedServiceName({ kind: 'org', org: 'acme' }, 'r 1', 'windows')).toBe('actions.runner.acme.r-1')
    expect(predictedServiceName({ kind: 'repo', owner: 'acme', repo: 'app' }, 'mac', 'macos')).toBe('actions.runner.acme-app.mac')
  })
  it('compares runner versions numerically', () => {
    expect(compareVersions('2.319.1', '2.321.0')).toBeLessThan(0)
    expect(compareVersions('2.321.0', '2.321.0')).toBe(0)
    expect(compareVersions('2.9.0', '2.10.0')).toBeLessThan(0)
    expect(compareVersions(null, '2.1.0')).toBeLessThan(0)
  })
  it('names GitHub default labels per platform', () => {
    expect(defaultLabels('linux', 'x64')).toEqual(['self-hosted', 'Linux', 'X64'])
    expect(defaultLabels('macos', 'arm64')).toEqual(['self-hosted', 'macOS', 'ARM64'])
    expect(defaultLabels('unknown', 'unknown')).toEqual(['self-hosted'])
  })
})

describe('reconciliation of local installations with GitHub records', () => {
  it('pairs by runner id within the scope, never by name alone, and keeps the unpaired on both sides', () => {
    const l1 = local(), l2 = local({ path: '/opt/other', key: installKey({ kind: 'native' }, '/opt/other'), agentId: 12, agentName: 'runner-a', scope: { kind: 'repo', owner: 'acme', repo: 'web' }, gitHubUrl: 'https://github.com/acme/web' })
    const g1 = github(), gOther = github({ id: 99, name: 'runner-a', scope: { kind: 'org', org: 'acme' } }), gElse = github({ id: 5, name: 'mac-mini', os: 'macOS' })
    const rows = reconcile([l1, l2], [g1, gOther, gElse], { githubFetched: () => true })
    const both = rows.find(r => r.local === l1)!
    expect(both.source).toBe('both'); expect(both.github).toBe(g1); expect(both.status).toBe('online'); expect(both.environment).toBe('native')
    const l2row = rows.find(r => r.local === l2)!
    expect(l2row.source).toBe('local'); expect(l2row.github).toBeNull(); expect(l2row.status).toBe('unknown')
    expect(l2row.attention.join(' ')).toMatch(/Not found among the runners of acme\/web/)
    expect(rows.filter(r => r.source === 'github').map(r => r.name).sort()).toEqual(['mac-mini', 'runner-a'])
    const orgRow = rows.find(r => r.github === gOther)!
    expect(orgRow.environment).toBe('unknown'); expect(orgRow.path).toBeNull(); expect(orgRow.machine).toBeNull()
  })
  it('pairs by name only when the installation has no id and exactly one GitHub record of that name exists in the scope', () => {
    const l = local({ agentId: null })
    const rows = reconcile([l], [github()], {})
    expect(rows[0].source).toBe('both')
    expect(rows[0].attention.join(' ')).toMatch(/Matched to the GitHub record by name/)
    const ambiguous = reconcile([l], [github(), github({ id: 12 })], {})
    expect(ambiguous.filter(r => r.source === 'both')).toHaveLength(0)
    expect(ambiguous).toHaveLength(3)
  })
  it('reports the states that need attention without confusing GitHub status with the local service', () => {
    const offlineButRunning = reconcile([local()], [github({ status: 'offline' })])[0]
    expect(offlineButRunning.status).toBe('offline')
    expect(offlineButRunning.attention.join(' ')).toMatch(/service is running but GitHub reports the runner offline/)
    const onlineNoService = reconcile([local({ service: { kind: 'systemd', name: 'u', state: 'stopped', startup: 'automatic', detail: null }, process: { running: false, pids: [], detail: null } })], [github()])[0]
    expect(onlineNoService.attention.join(' ')).toMatch(/online, but no local service or runner process/)
    const old = reconcile([local({ version: '2.300.0', disableUpdate: true })], [github()], { latestVersion: '2.321.0' })[0]
    expect(old.attention.join(' ')).toMatch(/2\.300\.0 installed, 2\.321\.0 is the latest.*Automatic updates are turned off/)
    const partial = reconcile([local({ configured: false, partial: true, agentId: null, agentName: null, scope: null })], [])[0]
    expect(partial.attention.join(' ')).toMatch(/without a registration/)
    expect(partial.name).toBe('actions-runner')
    const wsl = reconcile([local({ host: { kind: 'wsl', distro: 'Ubuntu-24.04' }, key: 'k' })], [github()])[0]
    expect(wsl.environment).toBe('wsl'); expect(wsl.distro).toBe('Ubuntu-24.04')
    expect(wsl.attention.join(' ')).toMatch(/WSL does not start distributions when Windows boots/)
  })
  it('summarizes online, offline, busy, manageable and monitoring-only counts', () => {
    const rows = reconcile([local()], [github(), github({ id: 2, name: 'b', busy: true }), github({ id: 3, name: 'c', status: 'offline' })])
    expect(summarize(rows)).toEqual({ total: 3, online: 2, offline: 1, busy: 1, manageable: 1, monitoringOnly: 2, attention: 0 })
  })
})

describe('capabilities', () => {
  it('offers nothing but GitHub removal for a runner GitManager cannot reach', () => {
    const c = capabilitiesFor(null, github())
    expect(c.start.allowed).toBe(false); expect(c.stop.allowed).toBe(false); expect(c.uninstall.allowed).toBe(false); expect(c.unregister.allowed).toBe(true)
    expect(c.start.reason).toMatch(/elsewhere/)
    const unreachable = capabilitiesFor(local({ host: { kind: 'ssh', host: 'nas' } }), github(), { hostReachable: false })
    expect(unreachable.stop.allowed).toBe(false); expect(unreachable.stop.reason).toMatch(/nas did not answer/)
  })
  it('follows the service state and warns when a job would be interrupted', () => {
    const running = capabilitiesFor(local(), github({ busy: true }))
    expect(running.start.allowed).toBe(false); expect(running.stop.allowed).toBe(true); expect(running.stop.reason).toMatch(/interrupts the job/)
    const stopped = capabilitiesFor(local({ service: { kind: 'systemd', name: 'u', state: 'stopped', startup: 'automatic', detail: null }, process: { running: false, pids: [], detail: null } }), null)
    expect(stopped.start.allowed).toBe(true); expect(stopped.stop.allowed).toBe(false)
    const noService = capabilitiesFor(local({ service: { kind: 'none', name: null, state: 'not-installed', startup: 'not-applicable', detail: null }, process: { running: false, pids: [], detail: null } }), null)
    expect(noService.start.allowed).toBe(false); expect(noService.start.reason).toMatch(/run\.sh/)
    expect(noService.restart.allowed).toBe(false)
    const unconfigured = capabilitiesFor(local({ configured: false, partial: true, agentId: null, version: null }), null)
    expect(unconfigured.update.allowed).toBe(false); expect(unconfigured.checkUpdate.allowed).toBe(false); expect(unconfigured.uninstall.allowed).toBe(true)
  })
})

describe('runs-on example', () => {
  it('uses GitHub-confirmed labels, tells default and custom labels apart, and adds the group for organization runners', () => {
    const r = reconcile([local()], [github()])[0]
    expect(runsOnExample(r)).toMatchObject({ yaml: 'runs-on: [self-hosted, Linux, X64, gpu]', defaultLabels: ['self-hosted', 'Linux', 'X64'], customLabels: ['gpu'], group: null })
    const org = reconcile([], [github({ scope: { kind: 'org', org: 'acme' }, runnerGroupName: 'gpu-pool' })])[0]
    const ex = runsOnExample(org)
    expect(ex.yaml).toBe('runs-on:\n  group: gpu-pool\n  labels: [self-hosted, Linux, X64, gpu]')
    expect(ex.note).toMatch(/matching labels alone do not grant access/)
    const localOnly = reconcile([local()], [])[0]
    expect(runsOnExample(localOnly)).toMatchObject({ yaml: 'runs-on: [self-hosted, Linux, X64]', customLabels: [] })
    expect(runsOnExample(localOnly).note).toMatch(/Custom labels are known only after reading/)
  })
})

describe('secret redaction', () => {
  it('masks registration and removal tokens, GitHub tokens, JWTs and token arguments', () => {
    const token = 'AABF3JGZDX3P5PMEXLND6TS7D4J6M'
    expect(redact(`./config.sh --url https://github.com/a/b --token ${token} --name x`)).toBe('./config.sh --url https://github.com/a/b --token [redacted] --name x')
    expect(redact(`got ${token} back`)).toBe('got [redacted] back')
    expect(redact('Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789')).toBe('Authorization: [redacted]')
    expect(redact('token=github_pat_11AAAAAAA0bbbbbbbbbbbbbbbbbbbbbbbb')).toBe('token=[redacted]')
    expect(redact('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('jwt [redacted]')
    expect(redact('--windowslogonpassword hunter2x')).toBe('--windowslogonpassword [redacted]')
    expect(redact('RUNNER_TOKEN=abc123 GH_TOKEN: gho_x')).toBe('RUNNER_TOKEN=[redacted] GH_TOKEN: [redacted]')
    expect(redact('plain text with --name runner stays', ['secretvalue'])).toBe('plain text with --name runner stays')
    expect(redact('the known secretvalue is hidden', ['secretvalue'])).toBe('the known [redacted] is hidden')
    expect(redactArgs(['configure', '--token', 'whatever', '--name', 'n'])).toEqual(['configure', '--token', '[redacted]', '--name', 'n'])
  })
})
