import { describe, expect, it } from 'vitest'
import { decodeOutput, gitSpec, parseWslList } from '../src/core/exec.js'
import { displayLocation, parseLocationInput, resolveRunDir, sameLocation, windowsToWsl, wslToWindowsDrive, wslUncPath } from '../src/core/paths.js'

describe('parsing what the user enters', () => {
  it('reads WSL UNC paths from Explorer and the folder picker', () => {
    for (const p of ['\\\\wsl.localhost\\Ubuntu-22.04\\home\\me\\app', '\\\\wsl$\\Ubuntu-22.04\\home\\me\\app\\', '//wsl.localhost/Ubuntu-22.04/home/me/app'])
      expect(parseLocationInput(p, { hostOs: 'windows' })).toEqual({ ok: true, location: { kind: 'wsl', distro: 'Ubuntu-22.04', path: '/home/me/app' } })
  })
  it('needs a distribution for a Linux path on Windows', () => {
    expect(parseLocationInput('/home/me/app', { hostOs: 'windows' }).ok).toBe(false)
    expect(parseLocationInput('/home/me/app', { hostOs: 'windows', distro: 'Debian' })).toEqual({ ok: true, location: { kind: 'wsl', distro: 'Debian', path: '/home/me/app' } })
    expect(parseLocationInput('/home/me/app', { hostOs: 'linux' })).toEqual({ ok: true, location: { kind: 'native', path: '/home/me/app' } })
  })
  it('normalizes Windows drive paths and refuses to mix them with a distribution', () => {
    expect(parseLocationInput('"C:/Users/Some One/code/app/"', { hostOs: 'windows' })).toEqual({ ok: true, location: { kind: 'native', path: 'C:\\Users\\Some One\\code\\app' } })
    expect(parseLocationInput('C:\\code', { hostOs: 'windows', distro: 'Ubuntu' }).ok).toBe(false)
    expect(parseLocationInput('code/app', { hostOs: 'windows' }).ok).toBe(false)
    expect(parseLocationInput('', { hostOs: 'windows' }).ok).toBe(false)
  })
})

describe('converting between Windows and WSL', () => {
  it('maps drives to /mnt and back', () => {
    expect(windowsToWsl('D:\\Work\\My App')).toBe('/mnt/d/Work/My App')
    expect(windowsToWsl('C:\\')).toBe('/mnt/c')
    expect(windowsToWsl('\\\\server\\share\\x')).toBeNull()
    expect(wslToWindowsDrive('/mnt/d/Work/My App')).toBe('D:\\Work\\My App')
    expect(wslToWindowsDrive('/home/me')).toBeNull()
  })
  it('builds the UNC path Explorer uses for a WSL folder', () => {
    expect(wslUncPath('Ubuntu', '/home/me/app/')).toBe('\\\\wsl.localhost\\Ubuntu\\home\\me\\app')
    expect(displayLocation({ kind: 'wsl', distro: 'Ubuntu', path: '/home/me/app' })).toBe('Ubuntu: /home/me/app')
  })
  it('compares locations by namespace, case-insensitively only for Windows', () => {
    expect(sameLocation({ kind: 'native', path: 'C:\\Code\\App' }, { kind: 'native', path: 'c:/code/app/' })).toBe(true)
    expect(sameLocation({ kind: 'native', path: '/home/a' }, { kind: 'native', path: '/home/A' })).toBe(false)
    expect(sameLocation({ kind: 'wsl', distro: 'Ubuntu', path: '/a' }, { kind: 'native', path: '/a' })).toBe(false)
  })
})

describe('service working directories', () => {
  const win = { kind: 'native' as const, path: 'C:\\code\\caissa' }
  const wsl = { kind: 'wsl' as const, distro: 'Ubuntu', path: '/home/me/caissa' }
  it('resolves relative directories in the runtime syntax', () => {
    expect(resolveRunDir(win, { kind: 'native' }, '', 'frontend')).toEqual({ ok: true, path: 'C:\\code\\caissa\\frontend' })
    expect(resolveRunDir(wsl, { kind: 'wsl', distro: 'Ubuntu' }, 'apps', 'backend')).toEqual({ ok: true, path: '/home/me/caissa/apps/backend' })
    expect(resolveRunDir(win, { kind: 'wsl', distro: 'Ubuntu' }, 'frontend')).toEqual({ ok: true, path: '/mnt/c/code/caissa/frontend' })
    expect(resolveRunDir(wsl, { kind: 'wsl', distro: 'ubuntu' }, '/opt/tool')).toEqual({ ok: true, path: '/opt/tool' })
  })
  it('never mixes a WSL repository with Windows tools or another distribution', () => {
    expect(resolveRunDir(wsl, { kind: 'native' }).ok).toBe(false)
    expect(resolveRunDir(wsl, { kind: 'wsl', distro: 'Debian' }).ok).toBe(false)
    expect(resolveRunDir(wsl, { kind: 'wsl', distro: 'Ubuntu' }, 'C:\\x').ok).toBe(false)
  })
})

describe('WSL command construction and output', () => {
  it('runs Git inside the distribution, never through a Windows path', () => {
    const s = gitSpec({ kind: 'wsl', distro: 'Ubuntu', path: '/home/me/app' }, ['status'])
    expect(s.file).toBe('wsl.exe')
    expect(s.args.slice(0, 6)).toEqual(['-d', 'Ubuntu', '--cd', '/home/me/app', '--exec', 'env'])
    expect(s.args.slice(-2)).toEqual(['git', 'status'])
    expect(s.cwd).toBeUndefined()
    expect(gitSpec({ kind: 'native', path: 'C:\\code' }, ['status'])).toMatchObject({ file: 'git', args: ['status'], cwd: 'C:\\code' })
  })
  it('parses wsl --list --verbose in UTF-16 and UTF-8, skipping Docker internals', () => {
    const text = '  NAME                   STATE           VERSION\r\n* Ubuntu-22.04           Running         2\r\n  Debian                 Stopped         2\r\n  docker-desktop         Stopped         2\r\n  Legacy                 Stopped         1\r\n'
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
    for (const decoded of [decodeOutput(utf16), decodeOutput(Buffer.from(text, 'utf16le')), decodeOutput(Buffer.from(text))]) {
      expect(parseWslList(decoded)).toEqual([
        { name: 'Ubuntu-22.04', isDefault: true, state: 'Running', version: 2 },
        { name: 'Debian', isDefault: false, state: 'Stopped', version: 2 },
        { name: 'Legacy', isDefault: false, state: 'Stopped', version: 1 },
      ])
    }
  })
})
