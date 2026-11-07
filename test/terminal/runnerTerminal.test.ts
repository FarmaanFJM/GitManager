import { describe, expect, it } from 'vitest'
import { parseSystemdUser, planRunnerTerminal } from '../../src/core/runnerTerminal'
import type { ShellOption } from '../../src/shared/terminal'

const ubuntu: ShellOption = { id: 'wsl:Ubuntu-24.04', kind: 'wsl', label: 'WSL: Ubuntu-24.04', distro: 'Ubuntu-24.04', available: true }
const pwsh: ShellOption = { id: 'pwsh', kind: 'pwsh', label: 'PowerShell 7', available: true, executable: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' }
const ps: ShellOption = { id: 'powershell', kind: 'powershell', label: 'Windows PowerShell', available: true }
const planDeps = { platform: 'win32' as const, env: { PATH: 'x' }, homeDir: () => 'C:\\Users\\x' }
const wslRunner = { host: { kind: 'wsl' as const, distro: 'Ubuntu-24.04' }, path: '/home/farmaan/actions-runner-caissatrainer', service: { kind: 'systemd' as const, name: 'actions.runner.x.service' } }
const ctx = (extra = {}) => ({ shells: [ps, pwsh, ubuntu], platform: 'win32' as const, planDeps, ...extra })
const codes = (r: { notes: { code: string }[] }) => r.notes.map(n => n.code)

describe('parseSystemdUser', () => {
  it('reads User= from [Service] only', () => {
    expect(parseSystemdUser('[Unit]\nUser=nope\n[Service]\nExecStart=/x\nUser=farmaan\n[Install]\nUser=also-no\n')).toBe('farmaan')
    expect(parseSystemdUser('[Service]\n# User=comment\nUser = bob \r\n')).toBe('bob')
    expect(parseSystemdUser('[Service]\nUser=%i\n')).toBeNull()
    expect(parseSystemdUser('[Service]\nExecStart=x\n')).toBeNull()
    expect(parseSystemdUser(null)).toBeNull()
  })
})

describe('planRunnerTerminal', () => {
  it('WSL runner: wsl.exe -d <distro> --cd <path> -u <service user>', () => {
    const r = planRunnerTerminal({ ...wslRunner, serviceAccount: 'farmaan', ownerAccount: 'farmaan' }, ctx())
    if (!r.ok) throw new Error(r.reason)
    expect(r.shellPlan.file).toBe('wsl.exe')
    expect(r.shellPlan.args).toEqual(['-d', 'Ubuntu-24.04', '--cd', '/home/farmaan/actions-runner-caissatrainer', '-u', 'farmaan'])
    expect(r.notes).toEqual([])
  })
  it('uses the directory owner when the service user is unknown, with no account note', () => {
    const r = planRunnerTerminal({ ...wslRunner, ownerAccount: 'farmaan' }, ctx())
    expect(r.ok && r.shellPlan.args.slice(-2)).toEqual(['-u', 'farmaan'])
  })
  it('nothing known: default user and ACCOUNT_UNKNOWN', () => {
    const r = planRunnerTerminal(wslRunner, ctx())
    expect(r.ok && r.shellPlan.args).toEqual(['-d', 'Ubuntu-24.04', '--cd', '/home/farmaan/actions-runner-caissatrainer'])
    expect(codes(r)).toEqual(['ACCOUNT_UNKNOWN'])
  })
  it('root service: never -u root, ACCOUNT_DIFFERS', () => {
    const r = planRunnerTerminal({ ...wslRunner, serviceAccount: 'root' }, ctx())
    expect(r.ok && r.shellPlan.args).not.toContain('-u')
    expect(codes(r)).toContain('ACCOUNT_DIFFERS')
    const owned = planRunnerTerminal({ ...wslRunner, serviceAccount: 'root', ownerAccount: 'farmaan' }, ctx())
    expect(owned.ok && owned.shellPlan.args.slice(-2)).toEqual(['-u', 'farmaan']) // an ordinary owner, never root
    expect(JSON.stringify(owned)).not.toMatch(/"-u","root"/)
  })
  it('service user and owner differ: opens as the service user and says so', () => {
    const r = planRunnerTerminal({ ...wslRunner, serviceAccount: 'runner', ownerAccount: 'farmaan' }, ctx())
    expect(r.ok && r.shellPlan.args.slice(-2)).toEqual(['-u', 'runner'])
    expect(codes(r)).toEqual(['ACCOUNT_DIFFERS'])
  })
  it('an unusable account name is not passed to wsl.exe', () => {
    const r = planRunnerTerminal({ ...wslRunner, serviceAccount: '-u; rm' }, ctx())
    expect(r.ok && r.shellPlan.args).not.toContain('-u')
    expect(codes(r)).toContain('ACCOUNT_UNKNOWN')
  })
  it('refuses a distribution that is not available, and WSL off Windows', () => {
    expect(planRunnerTerminal(wslRunner, ctx({ shells: [pwsh] }))).toMatchObject({ ok: false })
    expect(planRunnerTerminal(wslRunner, ctx({ platform: 'linux' }))).toMatchObject({ ok: false })
  })
  it('Windows runner: PowerShell in the install directory, account notes', () => {
    const base = { host: { kind: 'native' as const }, path: 'C:\\actions-runner', service: { kind: 'windows-service' as const, name: 'actions.runner.a' } }
    const same = planRunnerTerminal({ ...base, serviceAccount: 'PC\\Farmaan' }, ctx({ interactiveAccount: 'farmaan' }))
    expect(same.ok && same.shellPlan).toMatchObject({ file: pwsh.executable, args: ['-NoLogo'], cwd: 'C:\\actions-runner' })
    expect(codes(same)).toEqual([])
    const net = planRunnerTerminal({ ...base, serviceAccount: 'NT AUTHORITY\\NETWORK SERVICE' }, ctx({ interactiveAccount: 'farmaan' }))
    expect(codes(net)).toEqual(['ACCOUNT_DIFFERS'])
    expect(planRunnerTerminal(base, ctx({ interactiveAccount: 'farmaan' })).notes.map(n => n.code)).toEqual(['ACCOUNT_UNKNOWN'])
    expect(codes(planRunnerTerminal({ ...base, serviceAccount: 'x' }, ctx()))).toEqual(['ACCOUNT_UNKNOWN'])
    const noPwsh = planRunnerTerminal(base, ctx({ shells: [ps, ubuntu] }))
    expect(noPwsh.ok && noPwsh.shellPlan.shell.id).toBe('powershell')
  })
  it('SSH is unsupported with a reason', () => {
    const r = planRunnerTerminal({ host: { kind: 'ssh', host: 'buildbox' }, path: '/srv/r' }, ctx())
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('buildbox') })
  })
  it('nothing about the example is hardcoded', () => {
    const r = planRunnerTerminal({ host: { kind: 'wsl', distro: 'Debian' }, path: '/opt/r x', serviceAccount: 'ci' }, ctx({ shells: [{ ...ubuntu, id: 'wsl:Debian', distro: 'debian' }] }))
    expect(r.ok && r.shellPlan.args).toEqual(['-d', 'debian', '--cd', '/opt/r x', '-u', 'ci'])
  })
})
