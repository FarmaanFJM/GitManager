import { describe, expect, it } from 'vitest'
import { matchesSearch, sortRunners } from '../../src/renderer/tools/runners/tableLogic.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { reconcile } from '../../src/core/runners/model.js'
import { github, local } from './model.test.js'

describe('runner table logic', () => {
  const rows = reconcile(
    [local(), local({ path: '/home/me/r2', key: 'k2', agentId: 2, agentName: 'wsl-box', host: { kind: 'wsl', distro: 'Ubuntu-24.04' }, machine: 'DESKTOP', version: '2.300.0' })],
    [github(), github({ id: 2, name: 'wsl-box', status: 'offline' }), github({ id: 3, name: 'mac-mini', os: 'macOS', busy: true, scope: { kind: 'org', org: 'acme' } })],
  )
  it('searches name, repository, host, platform, distribution, path and labels', () => {
    const names = (q: string) => rows.filter(r => matchesSearch(r, q)).map(r => r.name).sort()
    expect(names('wsl')).toEqual(['wsl-box']); expect(names('ubuntu')).toEqual(['wsl-box']); expect(names('/home/me')).toEqual(['wsl-box'])
    expect(names('acme/app')).toEqual(['runner-a', 'wsl-box']); expect(names('macos')).toEqual(['mac-mini']); expect(names('gpu').length).toBe(3)
    expect(names('DESKTOP')).toEqual(['wsl-box']); expect(names('zzz')).toEqual([])
  })
  it('sorts by status (busy, online, offline), name, platform and version', () => {
    expect(sortRunners(rows, 'status', 1).map(r => r.name)).toEqual(['mac-mini', 'runner-a', 'wsl-box'])
    expect(sortRunners(rows, 'name', -1).map(r => r.name)).toEqual(['wsl-box', 'runner-a', 'mac-mini'])
    expect(sortRunners(rows, 'platform', 1)[0].platform).toBe('linux')
    expect(sortRunners(rows, 'version', -1)[0].version).toBe('2.319.1')
  })
})

describe('tools navigation and copy', () => {
  const root = join(__dirname, '..', '..', 'src', 'renderer')
  it('registers Runners as a tool, routes the tools view and keeps repository selection separate', () => {
    const tools = readFileSync(join(root, 'tools', 'Tools.tsx'), 'utf8')
    expect(tools).toMatch(/id: 'runners', name: 'Runners'/)
    const app = readFileSync(join(root, 'App.tsx'), 'utf8')
    expect(app).toMatch(/kind: 'tools'; tool: ToolId \| null/)
    expect(app).toMatch(/view\.kind === 'tools' \? <ToolsView/)
    const sidebar = readFileSync(join(root, 'Sidebar.tsx'), 'utf8')
    expect(sidebar).toMatch(/label="Tools" current=\{view\.kind === 'tools'\}/)
    // a repository row is current only in repository views, so opening a tool never shows a repository as selected and selection survives
    expect(sidebar).toMatch(/\(view\.kind === 'repo' \|\| view\.kind === 'profile'\) && model\.data\.ui\.selectedRepoId === r\.id/)
  })
  it('uses no em dashes in the runner interface copy', () => {
    const { readdirSync } = require('node:fs') as typeof import('node:fs')
    const files = [join(root, 'tools', 'Tools.tsx'), ...readdirSync(join(root, 'tools', 'runners')).map(f => join(root, 'tools', 'runners', f))]
    for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toMatch(/\u2014/)
  })
})
