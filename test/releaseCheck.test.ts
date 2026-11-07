import { describe, expect, it } from 'vitest'
// @ts-expect-error plain ES module script
import { artifactNames, checkArtifacts, checkSource, checkVersionInfo, strayArtifacts, versionMatches, versionOfTag } from '../scripts/release/check.mjs'

const pkg = (version: string) => ({ name: 'gitmanager', version })
const lock = (version: string, root = version) => ({ name: 'gitmanager', version, packages: { '': { name: 'gitmanager', version: root } } })
const info = (v: string, numeric = `${v}.0`) => ({ fileVersion: v, productVersion: v, productName: 'GitManager', numeric, productNumeric: numeric })

describe('release consistency', () => {
  it('reads the version from a tag', () => {
    expect(versionOfTag('v1.0.0')).toBe('1.0.0')
    expect(versionOfTag('refs/tags/v1.2.3-rc.1')).toBe('1.2.3-rc.1')
    expect(versionOfTag('1.0.0')).toBeNull()
    expect(versionOfTag('v1.0')).toBeNull()
    expect(versionOfTag('release-1')).toBeNull()
  })

  it('accepts matching package.json, lockfile and tag', () => {
    expect(checkSource({ pkg: pkg('1.0.0'), lock: lock('1.0.0'), tag: 'v1.0.0' })).toEqual([])
    expect(checkSource({ pkg: pkg('1.0.0'), lock: lock('1.0.0') })).toEqual([])
  })

  it('reports a tag that disagrees with the application version', () => {
    const e = checkSource({ pkg: pkg('0.1.0'), lock: lock('0.1.0'), tag: 'v1.0.0' })
    expect(e).toHaveLength(1)
    expect(e[0]).toMatch(/tag v1\.0\.0 says 1\.0\.0 but package\.json says 0\.1\.0/)
    expect(checkSource({ pkg: pkg('1.0.0'), lock: lock('1.0.0'), tag: 'nightly' })[0]).toMatch(/not a version tag/)
  })

  it('reports a lockfile that was not synchronized', () => {
    expect(checkSource({ pkg: pkg('1.0.0'), lock: lock('0.1.0', '0.1.0') }).join('\n')).toMatch(/package-lock\.json version is 0\.1\.0/)
    expect(checkSource({ pkg: pkg('1.0.0'), lock: lock('1.0.0', '0.1.0') }).join('\n')).toMatch(/packages\[""\] version is 0\.1\.0/)
  })

  it('rejects a version that is not semantic', () => {
    expect(checkSource({ pkg: pkg('1.0'), lock: null })[0]).toMatch(/not a semantic version/)
  })

  it('matches Windows version strings', () => {
    expect(versionMatches('1.0.0', '1.0.0')).toBe(true)
    expect(versionMatches('1.0.0.0', '1.0.0')).toBe(true)
    expect(versionMatches('1.0.0.0', '1.0.0-rc.1')).toBe(true)
    expect(versionMatches('0.1.0', '1.0.0')).toBe(false)
    expect(versionMatches(null, '1.0.0')).toBe(false)
  })

  it('checks a version resource', () => {
    expect(checkVersionInfo('x.exe', info('1.0.0'), '1.0.0')).toEqual([])
    expect(checkVersionInfo('x.exe', info('0.1.0', '0.1.0.0'), '1.0.0').join('\n')).toMatch(/ProductVersion is 0\.1\.0/)
    expect(checkVersionInfo('x.exe', null, '1.0.0')).toEqual(['x.exe: no version resource found'])
  })

  it('checks the artifact names and the stamped versions', () => {
    const n = artifactNames('1.0.0')
    expect(n).toEqual({ installer: 'GitManager-1.0.0-x64.exe', zip: 'GitManager-1.0.0-x64.zip' })
    const files = [n.installer, n.zip, 'win-unpacked', 'builder-debug.yml']
    const ok = checkArtifacts({ dir: 'release', version: '1.0.0', list: () => files, exists: () => true, read: () => Buffer.alloc(0), readInfo: () => info('1.0.0') })
    expect(ok).toEqual([])
    const stale = checkArtifacts({ dir: 'release', version: '1.0.0', list: () => [...files, 'GitManager-0.1.0-x64.exe'], exists: () => true, read: () => Buffer.alloc(0), readInfo: () => info('1.0.0') })
    expect(stale.join('\n')).toMatch(/GitManager-0\.1\.0-x64\.exe is not version 1\.0\.0/)
    const wrongStamp = checkArtifacts({ dir: 'release', version: '1.0.0', list: () => files, exists: () => true, read: () => Buffer.alloc(0), readInfo: () => info('0.1.0', '0.1.0.0') })
    expect(wrongStamp.length).toBeGreaterThan(0)
    const missing = checkArtifacts({ dir: 'release', version: '1.0.0', list: () => [n.installer], exists: p => !String(p).endsWith('GitManager.exe'), read: () => Buffer.alloc(0), readInfo: () => info('1.0.0') })
    expect(missing.join('\n')).toMatch(/missing GitManager-1\.0\.0-x64\.zip/)
    expect(strayArtifacts(['GitManager-0.9.0-x64.zip', 'notes.txt'], '1.0.0')).toEqual(['GitManager-0.9.0-x64.zip'])
  })
})
