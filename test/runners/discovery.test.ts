import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { dedupe, dirFromServiceBinary, discoverOnHost, inspectOne, launchdService, parsePosixScan, parseRunnerFile, parseScQc, parseScQuery, parseServiceFile, recordToLocal, systemdService, versionFromText, windowsService } from '../../src/core/runners/discovery.js'
import { NativeShell, WslShell, probeHost, SshShell, posixJoin, windowsElevatedSpec, parseSshConfig } from '../../src/core/runners/hosts.js'
import type { ExecSpec } from '../../src/core/exec.js'
import { hostname } from 'node:os'
import { tempDir } from '../helpers.js'
import { archFromNode } from '../../src/core/runners/model.js'

const WIN = process.platform === 'win32'
import { FakeShell } from './fakes.js'

const RUNNER_JSON = (over: Record<string, unknown> = {}) => JSON.stringify({ agentId: 42, agentName: 'build-box', poolId: 1, poolName: 'Default', ephemeral: false, serverUrl: 'https://pipelinesghubeus2.actions.githubusercontent.com/x/', gitHubUrl: 'https://github.com/acme/app', workFolder: '_work', disableUpdate: false, ...over }, null, 2)

/** A realistic installation on disk: metadata, a stand-in listener that answers --version, a diagnostic log. */
function writeInstall(dir: string, o: { runner?: boolean; service?: string; creds?: boolean; version?: string; listener?: boolean; diagVersion?: string } = {}) {
  mkdirSync(join(dir, 'bin'), { recursive: true }); mkdirSync(join(dir, '_diag'), { recursive: true })
  if (o.runner !== false) writeFileSync(join(dir, '.runner'), '\uFEFF' + RUNNER_JSON())
  if (o.service) writeFileSync(join(dir, '.service'), o.service)
  if (o.creds !== false) writeFileSync(join(dir, '.credentials'), '{"scheme":"OAuth"}')
  writeFileSync(join(dir, 'config.sh'), '#!/bin/sh\n')
  if (o.listener !== false) { writeFileSync(join(dir, 'bin', 'Runner.Listener'), `#!/bin/sh\n[ "$1" = "--version" ] && echo ${o.version ?? '2.319.1'}\n`); chmodSync(join(dir, 'bin', 'Runner.Listener'), 0o755) }
  if (o.diagVersion) writeFileSync(join(dir, '_diag', 'Runner_20261030-100001-utc.log'), `[2026-10-30 10:00:01Z INFO Listener] Version: ${o.diagVersion}\n`)
}

describe('runner metadata files', () => {
  it('reads .runner (with a BOM, as Windows writes it) and takes only what the inventory needs', () => {
    expect(parseRunnerFile('\uFEFF' + RUNNER_JSON())).toEqual({ agentId: 42, agentName: 'build-box', poolName: 'Default', gitHubUrl: 'https://github.com/acme/app', workFolder: '_work', ephemeral: false, disableUpdate: false })
    expect(parseRunnerFile(RUNNER_JSON({ agentId: '7', disableUpdate: 'true' }))).toMatchObject({ agentId: 7, disableUpdate: true })
    expect(parseRunnerFile('not json')).toBeNull(); expect(parseRunnerFile(null)).toBeNull()
  })
  it('tells systemd units, launchd plists and Windows service names apart in .service', () => {
    expect(parseServiceFile('actions.runner.acme-app.box.service\n')).toEqual({ kind: 'systemd', name: 'actions.runner.acme-app.box.service' })
    expect(parseServiceFile('/etc/systemd/system/actions.runner.acme-app.box.service')).toEqual({ kind: 'systemd', name: 'actions.runner.acme-app.box.service' })
    expect(parseServiceFile('/Users/me/Library/LaunchAgents/actions.runner.acme-app.mac.plist')).toEqual({ kind: 'launchd', name: 'actions.runner.acme-app.mac' })
    expect(parseServiceFile('actions.runner.acme-app.win')).toEqual({ kind: 'windows-service', name: 'actions.runner.acme-app.win' })
    expect(parseServiceFile('')).toBeNull()
  })
  it('maps service states without guessing', () => {
    expect(systemdService('u', 'active', 'enabled')).toMatchObject({ state: 'running', startup: 'automatic' })
    expect(systemdService('u', 'inactive', 'disabled')).toMatchObject({ state: 'stopped', startup: 'disabled' })
    expect(systemdService('u', 'System has not been booted with systemd', 'x')).toMatchObject({ state: 'unknown', detail: expect.stringMatching(/wsl\.conf/) })
    expect(systemdService('u', 'nosystemctl', 'nosystemctl').state).toBe('unknown')
    expect(launchdService('l', 0, '{ "PID" = 123; "Label" = "l"; }')).toMatchObject({ state: 'running' })
    expect(launchdService('l', 0, '{ "Label" = "l"; }')).toMatchObject({ state: 'stopped' })
    expect(launchdService('l', 113, 'Could not find service "l" in domain for port')).toMatchObject({ state: 'stopped' })
    expect(windowsService('s', 'RUNNING', 'AUTO_START  (DELAYED)')).toMatchObject({ state: 'running', startup: 'automatic' })
    expect(windowsService('s', 'STOPPED', 'DEMAND_START')).toMatchObject({ state: 'stopped', startup: 'manual' })
    expect(windowsService('s', null, null)).toMatchObject({ state: 'not-installed' })
    expect(versionFromText('2.319.1\n')).toBe('2.319.1'); expect(versionFromText('Version: 2.300.0')).toBe('2.300.0'); expect(versionFromText('1.2.3')).toBeNull()
  })
})

describe('probing this computer', () => {
  it('reports the real system, architecture and machine name of the host it runs on', async () => {
    const probe = await probeHost(new NativeShell())
    expect(probe.reachable).toBe(true)
    expect(probe.os).toBe(WIN ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux')
    expect(probe.arch).toBe(archFromNode(process.arch))
    expect(probe.machine).toBe(hostname())
    if (WIN) expect(probe.systemd).toBe(false)
  })
})

// The POSIX inspection is one real sh run (find, base64, /proc); it needs a POSIX host. Windows has its own real-file-system run below.
describe.runIf(!WIN)('native POSIX discovery (real sh, temporary folders)', () => {
  it('finds registered, service-less and partial installations by their metadata, never by folder name, and reads the version', async () => {
    const t = tempDir()
    try {
      writeInstall(join(t.dir, 'opt', 'actions-runner'), { service: 'actions.runner.acme-app.build-box.service' })
      writeInstall(join(t.dir, 'home', 'me', 'runners', 'two'), { runner: false, listener: true })
      writeInstall(join(t.dir, 'home', 'me', 'old'), { listener: false, version: undefined, diagVersion: '2.300.0' })
      mkdirSync(join(t.dir, 'home', 'me', 'actions-runner-not-really'), { recursive: true }); writeFileSync(join(t.dir, 'home', 'me', 'actions-runner-not-really', 'README'), 'nothing')
      mkdirSync(join(t.dir, 'home', 'me', 'node_modules', 'x'), { recursive: true }); writeFileSync(join(t.dir, 'home', 'me', 'node_modules', 'x', '.runner'), RUNNER_JSON())
      const shell = new NativeShell({ os: 'linux' })
      const probe = await probeHost(shell)
      expect(probe.reachable).toBe(true); expect(probe.os).toBe('linux'); expect(probe.arch).not.toBe('unknown')
      const r = await discoverOnHost(shell, probe, { defaultRoots: [], roots: [{ id: 'a', host: { kind: 'native' }, path: join(t.dir, 'opt') }, { id: 'b', host: { kind: 'native' }, path: join(t.dir, 'home') }] })
      expect(r.result.status).toBe('ok')
      const byName = Object.fromEntries(r.installs.map(i => [i.path.split('/').pop()!, i]))
      expect(Object.keys(byName).sort()).toEqual(['actions-runner', 'old', 'two'])
      expect(byName['actions-runner']).toMatchObject({ configured: true, agentId: 42, agentName: 'build-box', scope: { kind: 'repo', owner: 'acme', repo: 'app' }, version: '2.319.1', versionSource: 'listener', hasCredentials: true, partial: false, machine: probe.machine, os: 'linux' })
      expect(byName['actions-runner'].service).toMatchObject({ kind: 'systemd', name: 'actions.runner.acme-app.build-box.service' })
      expect(['unknown', 'not-installed', 'stopped']).toContain(byName['actions-runner'].service.state)
      expect(byName.two).toMatchObject({ configured: false, partial: true, agentId: null, scope: null, service: { kind: 'none' } })
      expect(byName.old).toMatchObject({ configured: true, version: '2.300.0', versionSource: 'diag' })
      expect(r.result.roots).toContain(join(t.dir, 'opt'))
      const one = await inspectOne(shell, probe, join(t.dir, 'opt', 'actions-runner'))
      expect(one?.agentId).toBe(42)
      expect(await inspectOne(shell, probe, join(t.dir, 'home', 'me', 'actions-runner-not-really'))).toBeNull()
    } finally { t.cleanup() }
  })

  it('reports a missing root and keeps going, and marks an installation whose credentials are gone', async () => {
    const t = tempDir()
    try {
      writeInstall(join(t.dir, 'r', 'a'), { creds: false })
      const shell = new NativeShell({ os: 'linux' })
      const r = await discoverOnHost(shell, await probeHost(shell), { defaultRoots: [], roots: [{ id: 'x', host: { kind: 'native' }, path: join(t.dir, 'missing') }, { id: 'y', host: { kind: 'native' }, path: join(t.dir, 'r') }] })
      expect(r.result.status).toBe('ok')
      const a = r.installs.find(i => i.path.endsWith('/a'))!
      expect(a.hasCredentials).toBe(false)
      expect(a.warnings.join(' ')).toMatch(/credentials file is missing/)
    } finally { t.cleanup() }
  })

  it('is read-only: a scan changes no file in an installation', async () => {
    const t = tempDir()
    try {
      const dir = join(t.dir, 'opt', 'actions-runner'); writeInstall(dir, { service: 'u.service' })
      const { statSync, readdirSync } = await import('node:fs')
      const before = readdirSync(dir).map(f => [f, statSync(join(dir, f)).mtimeMs])
      const shell = new NativeShell({ os: 'linux' })
      await discoverOnHost(shell, await probeHost(shell), { defaultRoots: [], roots: [{ id: 'a', host: { kind: 'native' }, path: join(t.dir, 'opt') }] })
      expect(readdirSync(dir).map(f => [f, statSync(join(dir, f)).mtimeMs])).toEqual(before)
    } finally { t.cleanup() }
  })
})

/** A realistic Windows installation on disk: metadata with a BOM, config.cmd, a listener stub that cannot run (so the version comes from _diag), a recorded service name. */
function writeWindowsInstall(dir: string, o: { runner?: boolean; service?: string; creds?: boolean; diagVersion?: string } = {}) {
  mkdirSync(join(dir, 'bin'), { recursive: true }); mkdirSync(join(dir, '_diag'), { recursive: true })
  if (o.runner !== false) writeFileSync(join(dir, '.runner'), '\uFEFF' + RUNNER_JSON({ agentName: 'win-box' }))
  if (o.service) writeFileSync(join(dir, '.service'), o.service)
  if (o.creds !== false) writeFileSync(join(dir, '.credentials'), '{"scheme":"OAuth"}')
  writeFileSync(join(dir, 'config.cmd'), '@echo off\r\n"%~dp0bin\\Runner.Listener.exe" configure %*\r\n')
  writeFileSync(join(dir, 'bin', 'Runner.Listener.exe'), 'not a real executable')
  if (o.diagVersion) writeFileSync(join(dir, '_diag', 'Runner_20261030-100001-utc.log'), `[2026-10-30 10:00:01Z INFO Listener] Version: ${o.diagVersion}\r\n`)
}

// The Windows inspection uses the real file system, sc.exe and PowerShell; it needs a Windows host (CI runs it on windows-latest).
describe.runIf(WIN)('native Windows discovery (real file system, sc.exe and PowerShell)', () => {
  it('finds registered and partial installations by their metadata, never by folder name, with the version from the diagnostic log', async () => {
    const t = tempDir()
    try {
      writeWindowsInstall(join(t.dir, 'actions-runner'), { service: 'actions.runner.acme-app.win-box', diagVersion: '2.319.1' })
      writeWindowsInstall(join(t.dir, 'runners', 'second'), { runner: false })
      writeWindowsInstall(join(t.dir, 'runners', 'nocreds'), { creds: false })
      mkdirSync(join(t.dir, 'actions-runner-not-really'), { recursive: true }); writeFileSync(join(t.dir, 'actions-runner-not-really', 'README'), 'nothing')
      const shell = new NativeShell()
      const probe = await probeHost(shell)
      expect(probe.os).toBe('windows')
      const r = await discoverOnHost(shell, probe, { defaultRoots: [], roots: [{ id: 'a', host: { kind: 'native' }, path: t.dir }] })
      expect(r.result.status).toBe('ok')
      // only what lies under the temporary root is asserted; a machine may have real runner services of its own
      const mine = r.installs.filter(i => i.path.toLowerCase().startsWith(t.dir.toLowerCase()))
      const byName = Object.fromEntries(mine.map(i => [i.path.split('\\').pop()!, i]))
      expect(Object.keys(byName).sort()).toEqual(['actions-runner', 'nocreds', 'second'])
      expect(byName['actions-runner']).toMatchObject({ os: 'windows', arch: archFromNode(process.arch), machine: hostname(), configured: true, agentId: 42, agentName: 'win-box', scope: { kind: 'repo', owner: 'acme', repo: 'app' }, version: '2.319.1', versionSource: 'diag', hasCredentials: true, partial: false })
      expect(byName['actions-runner'].service).toMatchObject({ kind: 'windows-service', name: 'actions.runner.acme-app.win-box', state: 'not-installed' })
      expect(byName['actions-runner'].process).toMatchObject({ running: false, pids: [] })
      expect(byName['actions-runner'].key).toBe(`win:${join(t.dir, 'actions-runner').toLowerCase()}`)
      expect(byName.second).toMatchObject({ configured: false, partial: true, agentId: null, service: { kind: 'none' } })
      expect(byName.nocreds.warnings.join(' ')).toMatch(/credentials file is missing/)
      const one = await inspectOne(shell, probe, join(t.dir, 'actions-runner'))
      expect(one?.agentId).toBe(42)
      expect(await inspectOne(shell, probe, join(t.dir, 'actions-runner-not-really'))).toBeNull()
    } finally { t.cleanup() }
  })

  it('reports a missing root and keeps going, and leaves every file of an installation untouched', async () => {
    const t = tempDir()
    try {
      const dir = join(t.dir, 'r', 'a'); writeWindowsInstall(dir, { service: 'actions.runner.acme-app.win-box' })
      const { statSync, readdirSync } = await import('node:fs')
      const before = readdirSync(dir).map(f => [f, statSync(join(dir, f)).mtimeMs])
      const shell = new NativeShell()
      const r = await discoverOnHost(shell, await probeHost(shell), { defaultRoots: [], roots: [{ id: 'x', host: { kind: 'native' }, path: join(t.dir, 'missing') }, { id: 'y', host: { kind: 'native' }, path: join(t.dir, 'r') }] })
      expect(r.result.status).toBe('ok')
      expect(r.installs.some(i => i.path.toLowerCase() === dir.toLowerCase())).toBe(true)
      expect(readdirSync(dir).map(f => [f, statSync(join(dir, f)).mtimeMs])).toEqual(before)
    } finally { t.cleanup() }
  })
})

describe('scan output parsing for macOS and WSL layouts', () => {
  it('turns a macOS record (launchd plist, running agent) into an installation', () => {
    const out = ['@@ROOT /Users ok', '@@DIR /Users/me/actions-runner', `@@RUNNER ${Buffer.from(RUNNER_JSON({ agentName: 'mac-mini', gitHubUrl: 'https://github.com/acme' })).toString('base64')}`, '@@SERVICE /Users/me/Library/LaunchAgents/actions.runner.acme.mac-mini.plist', '@@CREDS yes', '@@LISTENER yes', '@@CONFIG yes', '@@VERSION 2.321.0', '@@LAUNCHD 0 { "PID" = 512; "Label" = "actions.runner.acme.mac-mini"; }', '@@PID 512', '@@END'].join('\n')
    const { records } = parsePosixScan(out)
    const shell = new FakeShell({ kind: 'native' }, 'macos')
    const l = recordToLocal(records[0], shell, { host: { kind: 'native' }, reachable: true, os: 'macos', arch: 'arm64', machine: 'mini', user: 'me', systemd: null, sudo: null, message: null }, '2026-10-31T00:00:00Z')
    expect(l).toMatchObject({ os: 'macos', arch: 'arm64', agentName: 'mac-mini', scope: { kind: 'org', org: 'acme' }, version: '2.321.0', service: { kind: 'launchd', name: 'actions.runner.acme.mac-mini', state: 'running', startup: 'automatic' }, process: { running: true, pids: [512] } })
  })
  it('turns a WSL record into an installation in that distribution, keeping the Linux path and reporting a missing systemd', () => {
    const out = ['@@ROOT /home ok', '@@DIR /home/me/actions-runner', `@@RUNNER ${Buffer.from(RUNNER_JSON()).toString('base64')}`, '@@SERVICE actions.runner.acme-app.build-box.service', '@@CREDS yes', '@@LISTENER yes', '@@CONFIG yes', '@@VERSION 2.319.1', "@@SYSTEMD System has not been booted with systemd as init system (PID 1). Can't operate.\tFailed to connect to bus: Host is down", '@@END'].join('\n')
    const { records, roots } = parsePosixScan(out)
    expect(roots).toEqual([{ path: '/home', ok: true }])
    const shell = new WslShell('Ubuntu-24.04')
    const l = recordToLocal(records[0], shell, { host: shell.host, reachable: true, os: 'linux', arch: 'x64', machine: 'DESKTOP', user: 'me', systemd: false, sudo: true, message: null }, '2026-10-31T00:00:00Z')
    expect(l.host).toEqual({ kind: 'wsl', distro: 'Ubuntu-24.04' })
    expect(l.path).toBe('/home/me/actions-runner')
    expect(l.key).toBe('wsl:ubuntu-24.04:/home/me/actions-runner')
    expect(l.service).toMatchObject({ kind: 'systemd', state: 'unknown' })
    expect(l.service.detail).toMatch(/wsl\.conf/)
  })
  it('deduplicates the same installation reached through two representations', () => {
    const a = { ...recordToLocal(parsePosixScan('@@DIR /home/me/r\n@@LISTENER yes\n@@CONFIG yes\n@@END').records[0], new WslShell('Ubuntu'), null, 'now') }
    const b = { ...a, path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\r', key: a.key }
    expect(dedupe([a, b])).toHaveLength(1)
  })
})

describe('WSL and SSH hosts', () => {
  it('runs everything through wsl.exe --exec with argument arrays, and root through -u root', async () => {
    const specs: ExecSpec[] = []
    const runner = async (s: ExecSpec) => { specs.push(s); return { code: 0, stdout: '@@ROOT /opt ok\n', stderr: '', timedOut: false } }
    const shell = new WslShell('Ubuntu-24.04', { runner })
    await discoverOnHost(shell, { host: shell.host, reachable: true, os: 'linux', arch: 'x64', machine: 'd', user: 'me', systemd: true, sudo: true, message: null })
    expect(specs[0].file).toBe('wsl.exe')
    expect(specs[0].args.slice(0, 6)).toEqual(['-d', 'Ubuntu-24.04', '--exec', 'sh', '-c', expect.stringContaining('@@DIR')])
    expect(specs[0].args.slice(7)).toContain('4:/opt')
    await shell.elevated().run('./svc.sh', ['install', 'me'], { cwd: '/home/me/r' })
    expect(specs[1].args).toEqual(['-d', 'Ubuntu-24.04', '-u', 'root', '--cd', '/home/me/r', '--exec', './svc.sh', 'install', 'me'])
    expect(shell.elevationNote()).toMatch(/wsl -u root/)
  })
  it('quotes every token for the SSH transport and never prompts', async () => {
    const specs: ExecSpec[] = []
    const shell = new SshShell('build', { runner: async s => { specs.push(s); return { code: 0, stdout: '', stderr: '', timedOut: false } } })
    await shell.elevated().run('./svc.sh', ['install', "o'neil"], { cwd: '/opt/a b' })
    expect(specs[0].file).toBe('ssh')
    expect(specs[0].args).toEqual(['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'LogLevel=ERROR', '--', 'build', `cd '/opt/a b' && sudo -n './svc.sh' 'install' 'o'\\''neil'`])
    expect(posixJoin(['a', 'b c', '$(x)', '`y`'])).toBe(`'a' 'b c' '$(x)' '\`y\`'`)
    const r = await new SshShell('down', { runner: async () => ({ code: 255, stdout: '', stderr: 'Connection refused', timedOut: false }) }).run('true', [])
    expect(r.stderr).toMatch(/could not connect to down/)
  })
  it('reads host aliases from an SSH configuration, skipping patterns', () => {
    const hosts = parseSshConfig('Host build nas\n  HostName 10.0.0.5\n  User me\n\nHost *.example.com\n  User x\nHost !bad\nMatch host foo\n  User y\nHost solo\n')
    expect(hosts.map(h => h.alias)).toEqual(['build', 'nas', 'solo'])
    expect(hosts[0]).toMatchObject({ hostName: '10.0.0.5', user: 'me', allowed: false })
  })
  it('builds a Windows elevation request that embeds every argument as a quoted literal', () => {
    const spec = windowsElevatedSpec('C:\\r\\bin\\Runner.Listener.exe', ['configure', '--name', "it's", '--token', 'AABF3JGZDX3P5PMEXLND6TS7D4J6M'], 'C:\\r')
    expect(spec.file).toBe('powershell.exe')
    const outer = Buffer.from(spec.args[3], 'base64').toString('utf16le')
    expect(outer).toMatch(/Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru/)
    const inner = Buffer.from(/'-EncodedCommand','([A-Za-z0-9+/=]+)'/.exec(outer)![1], 'base64').toString('utf16le')
    expect(inner).toContain(`& 'C:\\r\\bin\\Runner.Listener.exe' 'configure' '--name' 'it''s' '--token' 'AABF3JGZDX3P5PMEXLND6TS7D4J6M'`)
    expect(inner).toContain("Set-Location -LiteralPath 'C:\\r'")
  })
})

describe('Windows discovery (simulated services and folders; not a native Windows run)', () => {
  const SC_QUERY = 'SERVICE_NAME: actions.runner.acme-app.win-box\nDISPLAY_NAME: GitHub Actions Runner (acme-app.win-box)\n        TYPE               : 10  WIN32_OWN_PROCESS\n        STATE              : 4  RUNNING\n\nSERVICE_NAME: Spooler\n        STATE              : 1  STOPPED\n'
  const SC_QC = '[SC] QueryServiceConfig SUCCESS\n\nSERVICE_NAME: actions.runner.acme-app.win-box\n        TYPE               : 10  WIN32_OWN_PROCESS\n        START_TYPE         : 2   AUTO_START\n        BINARY_PATH_NAME   : "C:\\actions-runner\\bin\\RunnerService.exe"\n        DISPLAY_NAME       : GitHub Actions Runner (acme-app.win-box)\n'
  it('parses sc.exe output and derives the folder from the service binary', () => {
    expect(parseScQuery(SC_QUERY)).toEqual([{ name: 'actions.runner.acme-app.win-box', state: 'RUNNING' }, { name: 'Spooler', state: 'STOPPED' }])
    expect(parseScQc(SC_QC)).toEqual({ startType: 'AUTO_START', binaryPath: '"C:\\actions-runner\\bin\\RunnerService.exe"' })
    expect(dirFromServiceBinary('"C:\\actions-runner\\bin\\RunnerService.exe"')).toBe('C:\\actions-runner')
    expect(dirFromServiceBinary('C:\\other\\svc.exe')).toBeNull()
  })
  it('finds service-managed and folder-only installations, versions and processes', async () => {
    const shell = new FakeShell({ kind: 'native' }, 'windows')
    shell.mkdir('C:\\'); shell.mkdir('D:\\')
    shell.mkfile('C:\\actions-runner\\.runner', RUNNER_JSON({ agentName: 'win-box' })); shell.mkfile('C:\\actions-runner\\.service', 'actions.runner.acme-app.win-box'); shell.mkfile('C:\\actions-runner\\.credentials', 'x'); shell.mkfile('C:\\actions-runner\\config.cmd', ''); shell.mkfile('C:\\actions-runner\\bin\\Runner.Listener.exe', 'v')
    shell.mkfile('D:\\runners\\second\\.runner', RUNNER_JSON({ agentId: 43, agentName: 'second' })); shell.mkfile('D:\\runners\\second\\config.cmd', ''); shell.mkfile('D:\\runners\\second\\bin\\Runner.Listener.exe', 'v'); shell.mkfile('D:\\runners\\second\\_diag\\Runner_20261030-100001-utc.log', '[2026-10-30 10:00:01Z INFO Listener] Version: 2.318.0\n')
    shell.mkfile('C:\\Users\\me\\Downloads\\actions-runner\\README', 'nothing here')
    shell.handlers.push(c => {
      if (c.file === 'sc.exe' && c.args[0] === 'query' && c.args[1] === 'type=') return { code: 0, stdout: SC_QUERY, stderr: '', timedOut: false }
      if (c.file === 'sc.exe' && c.args[0] === 'qc') return { code: 0, stdout: SC_QC, stderr: '', timedOut: false }
      if (c.file === 'powershell.exe') return { code: 0, stdout: '1234\tC:\\actions-runner\\bin\\Runner.Listener.exe\r\n', stderr: '', timedOut: false }
      if (c.file.endsWith('Runner.Listener.exe')) return c.file.startsWith('C:\\actions-runner') ? { code: 0, stdout: '2.319.1\r\n', stderr: '', timedOut: false } : { code: 1, stdout: '', stderr: 'crash', timedOut: false }
      return undefined
    })
    const r = await discoverOnHost(shell, { host: shell.host, reachable: true, os: 'windows', arch: 'x64', machine: 'PC', user: 'me', systemd: false, sudo: null, message: null }, {}, { USERPROFILE: 'C:\\Users\\me' }, ['C:\\', 'D:\\'])
    expect(r.result.status).toBe('ok')
    const by = Object.fromEntries(r.installs.map(i => [i.path, i]))
    expect(Object.keys(by).sort()).toEqual(['C:\\actions-runner', 'D:\\runners\\second'])
    expect(by['C:\\actions-runner']).toMatchObject({ os: 'windows', agentName: 'win-box', version: '2.319.1', versionSource: 'listener', service: { kind: 'windows-service', name: 'actions.runner.acme-app.win-box', state: 'running', startup: 'automatic' }, process: { running: true, pids: [1234] } })
    expect(by['D:\\runners\\second']).toMatchObject({ version: '2.318.0', versionSource: 'diag', service: { kind: 'none' }, process: { running: false, pids: [] } })
    expect(by['C:\\actions-runner'].key).toBe('win:c:\\actions-runner')
  })
})
