import { describe, expect, it } from 'vitest'
import { detectShells, locationWithSubpath, planShell, preferredShellFor, shellCannotOpen, terminalEnvironment } from '../../src/core/shells'
import type { ShellOption } from '../../src/shared/terminal'
import type { Location } from '../../src/shared/types'

const distros = [
  { name: 'Ubuntu-24.04', isDefault: true, version: 2, state: 'Running' },
  { name: 'Debian', isDefault: false, version: 2, state: 'Stopped' },
]
const winEnv = { SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows\\System32;C:\\Tools', ProgramFiles: 'C:\\Program Files', USERPROFILE: 'C:\\Users\\x' }
const exists = (set: string[]) => (p: string) => set.includes(p)
const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const PW = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'

describe('detectShells', () => {
  it('Windows with PowerShell, pwsh and two distributions', async () => {
    const s = await detectShells({ platform: 'win32', env: winEnv, fileExists: exists([PS, PW]), listDistros: async () => ({ available: true, distros }) })
    expect(s.map(x => x.id)).toEqual(['powershell', 'pwsh', 'wsl:Ubuntu-24.04', 'wsl:Debian'])
    expect(s.every(x => x.available)).toBe(true)
    expect(s[1].executable).toBe(PW)
    expect(s[2]).toMatchObject({ kind: 'wsl', distro: 'Ubuntu-24.04', label: 'WSL: Ubuntu-24.04' })
  })
  it('finds pwsh on PATH', async () => {
    const p = 'C:\\Tools\\pwsh.exe'
    const s = await detectShells({ platform: 'win32', env: winEnv, fileExists: exists([PS, p]), listDistros: async () => ({ available: false, distros: [] }) })
    expect(s.find(x => x.id === 'pwsh')).toMatchObject({ available: true, executable: p })
  })
  it('Windows without WSL or pwsh', async () => {
    const s = await detectShells({ platform: 'win32', env: winEnv, fileExists: exists([PS]), listDistros: async () => ({ available: false, distros: [], error: 'WSL is not installed' }) })
    expect(s.map(x => [x.id, x.available])).toEqual([['powershell', true], ['pwsh', false]])
    expect(s[1].detail).toMatch(/not found/)
  })
  it('survives a failing distribution query and skips invalid names', async () => {
    const s = await detectShells({ platform: 'win32', env: winEnv, fileExists: exists([PS]), listDistros: async () => ({ available: true, distros: [{ name: '-evil', isDefault: false, version: 2, state: 'Running' }, { name: 'a b;c', isDefault: false, version: 2, state: 'Running' }, distros[0]] }) })
    expect(s.filter(x => x.kind === 'wsl').map(x => x.distro)).toEqual(['Ubuntu-24.04'])
    const t = await detectShells({ platform: 'win32', env: winEnv, fileExists: exists([PS]), listDistros: async () => { throw new Error('boom') } })
    expect(t.some(x => x.kind === 'wsl')).toBe(false)
  })
  it('Linux uses $SHELL, else bash, else sh', async () => {
    const a = await detectShells({ platform: 'linux', env: { SHELL: '/usr/bin/zsh' }, fileExists: exists(['/usr/bin/zsh', '/bin/bash']) })
    expect(a).toEqual([expect.objectContaining({ id: 'posix', kind: 'posix', executable: '/usr/bin/zsh', available: true })])
    const b = await detectShells({ platform: 'linux', env: {}, fileExists: exists(['/bin/bash']) })
    expect(b[0].executable).toBe('/bin/bash')
    const c = await detectShells({ platform: 'darwin', env: { SHELL: 'relative/zsh' }, fileExists: exists(['/bin/sh']) })
    expect(c[0].executable).toBe('/bin/sh')
    const d = await detectShells({ platform: 'linux', env: {}, fileExists: () => false })
    expect(d[0].available).toBe(false)
  })
})

const ps: ShellOption = { id: 'powershell', kind: 'powershell', label: 'Windows PowerShell', available: true, executable: PS }
const pwsh: ShellOption = { id: 'pwsh', kind: 'pwsh', label: 'PowerShell 7', available: true, executable: PW }
const ubuntu: ShellOption = { id: 'wsl:Ubuntu-24.04', kind: 'wsl', label: 'WSL: Ubuntu-24.04', distro: 'Ubuntu-24.04', available: true }
const debian: ShellOption = { id: 'wsl:Debian', kind: 'wsl', label: 'WSL: Debian', distro: 'Debian', available: true }
const posix: ShellOption = { id: 'posix', kind: 'posix', label: 'bash', available: true, executable: '/bin/bash' }
const win = { platform: 'win32' as const, env: { ...winEnv, ELECTRON_RUN_AS_NODE: '1', GITHUB_TOKEN: 'secret', Path: 'x' }, homeDir: () => 'C:\\Users\\x' }

const plan = (o: Parameters<typeof planShell>[0]) => { const r = planShell(o); if (!r.ok) throw new Error(r.message); return r.plan }

describe('planShell argv', () => {
  const nasty = [
    'C:\\Users\\x\\my project',
    'C:\\Users\\x\\proj é 日本語',
    'C:\\Users\\x\\it\'s "quoted"',
    'C:\\Users\\x\\a;b & c $(calc) `id` %PATH% ^',
  ]
  it.each(nasty)('PowerShell keeps %s as the cwd and out of the arguments', p => {
    const r = plan({ shell: pwsh, location: { kind: 'native', path: p }, deps: win })
    expect(r.file).toBe(PW)
    expect(r.args).toEqual(['-NoLogo'])
    expect(r.cwd).toBe(p)
    expect(JSON.stringify(r.args)).not.toContain('calc')
  })
  it.each([
    ['C:\\Users\\x\\my project', '/mnt/c/Users/x/my project'],
    ['C:\\Users\\x\\proj', '/mnt/c/Users/x/proj'],
    ['C:\\Users\\x\\a;b & c $(calc) `id`', '/mnt/c/Users/x/a;b & c $(calc) `id`'],
    ['C:\\Users\\x\\日本語 it\'s', '/mnt/c/Users/x/日本語 it\'s'],
  ])('WSL translates %s to one argv element', (p, linux) => {
    const r = plan({ shell: ubuntu, location: { kind: 'native', path: p }, deps: win })
    expect(r.file).toBe('wsl.exe')
    expect(r.args).toEqual(['-d', 'Ubuntu-24.04', '--cd', linux])
    expect(r.args.filter(a => a.includes('calc')).length).toBe(p.includes('calc') ? 1 : 0)
    expect(r.cwd).toBe('C:\\Users\\x') // never a UNC or Linux path
    expect(r.display).toBe(`Ubuntu-24.04:${linux}`)
  })
  it('a UNC path in the same distribution becomes its Linux path', () => {
    const r = plan({ shell: ubuntu, location: { kind: 'native', path: '\\\\wsl.localhost\\Ubuntu-24.04\\home\\farmaan\\r' }, deps: win })
    expect(r.args).toEqual(['-d', 'Ubuntu-24.04', '--cd', '/home/farmaan/r'])
    const old = plan({ shell: ubuntu, location: { kind: 'native', path: '\\\\wsl$\\ubuntu-24.04\\home\\farmaan\\r' }, deps: win })
    expect(old.args[3]).toBe('/home/farmaan/r')
  })
  it('refuses a UNC path for a different distribution, shares, and Linux paths', () => {
    expect(planShell({ shell: debian, location: { kind: 'native', path: '\\\\wsl.localhost\\Ubuntu-24.04\\home\\x' }, deps: win })).toMatchObject({ ok: false })
    expect(planShell({ shell: debian, location: { kind: 'wsl', distro: 'Ubuntu-24.04', path: '/home/x' }, deps: win })).toMatchObject({ ok: false })
    expect(planShell({ shell: ubuntu, location: { kind: 'native', path: '\\\\server\\share\\x' }, deps: win })).toMatchObject({ ok: false, message: expect.stringMatching(/network share/) })
    expect(planShell({ shell: ubuntu, location: { kind: 'native', path: '/home/x' }, deps: win })).toMatchObject({ ok: false })
  })
  it('a WSL repository in its own distribution, with and without -u', () => {
    const loc: Location = { kind: 'wsl', distro: 'ubuntu-24.04', path: '/home/farmaan/my repo; $(x)' }
    expect(plan({ shell: ubuntu, location: loc, deps: win }).args).toEqual(['-d', 'Ubuntu-24.04', '--cd', '/home/farmaan/my repo; $(x)'])
    expect(plan({ shell: ubuntu, location: loc, wslUser: 'farmaan', deps: win }).args).toEqual(['-d', 'Ubuntu-24.04', '--cd', '/home/farmaan/my repo; $(x)', '-u', 'farmaan'])
  })
  it('never opens as root and rejects odd user names', () => {
    const loc: Location = { kind: 'wsl', distro: 'Ubuntu-24.04', path: '/home/x' }
    expect(planShell({ shell: ubuntu, location: loc, wslUser: 'root', deps: win })).toMatchObject({ ok: false })
    expect(planShell({ shell: ubuntu, location: loc, wslUser: 'a b', deps: win })).toMatchObject({ ok: false })
    expect(planShell({ shell: ubuntu, location: loc, wslUser: '-x', deps: win })).toMatchObject({ ok: false })
  })
  it('refuses an invalid distribution name', () => {
    expect(planShell({ shell: { ...ubuntu, distro: 'a b;c' }, location: { kind: 'wsl', distro: 'a b;c', path: '/x' }, deps: win })).toMatchObject({ ok: false })
  })
  it('a WSL repository in PowerShell starts in a local folder and passes the UNC path by environment, not in the script', () => {
    const r = plan({ shell: pwsh, location: { kind: 'wsl', distro: 'Ubuntu-24.04', path: '/home/farmaan/it\'s;$(x)' }, deps: win })
    expect(r.cwd).toBe('C:\\Users\\x')
    expect(r.env.GITMANAGER_START_DIR).toBe('\\\\wsl.localhost\\Ubuntu-24.04\\home\\farmaan\\it\'s;$(x)')
    expect(r.args.join(' ')).not.toContain('farmaan')
    expect(r.args.slice(0, 3)).toEqual(['-NoLogo', '-NoExit', '-Command'])
    expect(r.notes[0]).toMatch(/prefer the WSL/)
  })
  it('POSIX shells use the folder as cwd, -l only on macOS', () => {
    const l: Location = { kind: 'native', path: '/home/me/my repo' }
    expect(plan({ shell: posix, location: l, deps: { platform: 'linux', env: {}, homeDir: () => '/h' } })).toMatchObject({ file: '/bin/bash', args: [], cwd: '/home/me/my repo' })
    expect(plan({ shell: posix, location: l, deps: { platform: 'darwin', env: {}, homeDir: () => '/h' } }).args).toEqual(['-l'])
    expect(planShell({ shell: posix, location: { kind: 'wsl', distro: 'x', path: '/a' }, deps: { platform: 'linux', env: {}, homeDir: () => '/h' } })).toMatchObject({ ok: false })
  })
  it('PowerShell refuses Linux paths and unavailable shells are refused', () => {
    expect(planShell({ shell: pwsh, location: { kind: 'native', path: '/home/x' }, deps: win })).toMatchObject({ ok: false })
    expect(planShell({ shell: { ...pwsh, available: false, detail: 'gone' }, location: { kind: 'native', path: 'C:\\x' }, deps: win })).toEqual({ ok: false, message: 'gone' })
  })
})

describe('environment', () => {
  it('removes app variables, sets TERM, and keeps secrets out of WSL launches only', () => {
    const base = { PATH: 'p', ELECTRON_RUN_AS_NODE: '1', ELECTRON_FOO: 'x', npm_config_x: 'y', NODE_OPTIONS: '--x', GITHUB_TOKEN: 't', WSLENV: 'A/p', HOME: '/h', TERM: 'dumb' }
    const native = terminalEnvironment(base, 'posix')
    expect(native).toMatchObject({ PATH: 'p', HOME: '/h', TERM: 'xterm-256color', COLORTERM: 'truecolor', GITHUB_TOKEN: 't' })
    expect(Object.keys(native)).not.toEqual(expect.arrayContaining(['ELECTRON_RUN_AS_NODE', 'npm_config_x', 'NODE_OPTIONS']))
    const wsl = terminalEnvironment(base, 'wsl')
    expect(wsl.GITHUB_TOKEN).toBeUndefined()
    expect(wsl.WSLENV).toBeUndefined()
  })
  it('planShell applies it', () => {
    const r = plan({ shell: ubuntu, location: { kind: 'wsl', distro: 'Ubuntu-24.04', path: '/x' }, deps: win })
    expect(r.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(r.env.GITHUB_TOKEN).toBeUndefined()
    expect(r.env.TERM).toBe('xterm-256color')
  })
})

describe('subpath', () => {
  it('joins inside the repository and refuses escapes', () => {
    expect(locationWithSubpath({ kind: 'native', path: 'C:\\r' }, 'src\\app')).toEqual({ ok: true, location: { kind: 'native', path: 'C:\\r\\src\\app' } })
    expect(locationWithSubpath({ kind: 'wsl', distro: 'U', path: '/r' }, 'a/b')).toEqual({ ok: true, location: { kind: 'wsl', distro: 'U', path: '/r/a/b' } })
    expect(locationWithSubpath({ kind: 'native', path: '/r' }, undefined)).toMatchObject({ ok: true })
    for (const bad of ['..', 'a/../../b', '/etc', 'C:\\x', '\\\\s\\x', 'a\0b']) expect(locationWithSubpath({ kind: 'native', path: '/r' }, bad)).toMatchObject({ ok: false })
  })
})

describe('preferredShellFor', () => {
  const all = [ps, pwsh, ubuntu, debian]
  const native: Location = { kind: 'native', path: 'C:\\Users\\x\\proj' }
  const wslRepo: Location = { kind: 'wsl', distro: 'Ubuntu-24.04', path: '/home/farmaan/r' }
  it('default: WSL repo -> its distro; native -> pwsh, then powershell, then posix', () => {
    expect(preferredShellFor(wslRepo, null, all, 'win32')?.id).toBe('wsl:Ubuntu-24.04')
    expect(preferredShellFor({ ...wslRepo, distro: 'UBUNTU-24.04' }, null, all, 'win32')?.id).toBe('wsl:Ubuntu-24.04')
    expect(preferredShellFor(native, null, all, 'win32')?.id).toBe('pwsh')
    expect(preferredShellFor(native, null, [ps, ubuntu], 'win32')?.id).toBe('powershell')
    expect(preferredShellFor({ kind: 'native', path: '/home/me' }, null, [posix], 'linux')?.id).toBe('posix')
    expect(preferredShellFor(native, null, [], 'win32')).toBeNull()
  })
  it('honours a saved preference while it is available and able to open the folder', () => {
    expect(preferredShellFor(native, 'powershell', all, 'win32')?.id).toBe('powershell')
    expect(preferredShellFor(native, 'wsl:Debian', all, 'win32')?.id).toBe('wsl:Debian') // C:\ via /mnt
    expect(preferredShellFor(wslRepo, 'pwsh', all, 'win32')?.id).toBe('pwsh') // the user chose it; planShell adds a note
  })
  it('falls back when the saved shell vanished, is unavailable, or cannot open the folder', () => {
    expect(preferredShellFor(native, 'wsl:Gone', all, 'win32')?.id).toBe('pwsh')
    expect(preferredShellFor(native, 'pwsh', [ps, { ...pwsh, available: false }], 'win32')?.id).toBe('powershell')
    expect(preferredShellFor(wslRepo, 'wsl:Debian', all, 'win32')?.id).toBe('wsl:Ubuntu-24.04') // other distro cannot reach it
  })
  it('shellCannotOpen explains', () => {
    expect(shellCannotOpen(debian, wslRepo, 'win32')).toMatch(/Ubuntu-24.04/)
    expect(shellCannotOpen(ubuntu, native, 'linux')).toMatch(/Windows only/)
  })
})
