import { describe, expect, it } from 'vitest'
import { groupByEnvironment } from '../src/renderer/util.js'
import type { Location, Repo } from '../src/shared/types.js'

const repo = (name: string, location: Location): Repo => ({ id: name + (location.kind === 'wsl' ? location.distro : ''), name, location, addedAt: '', source: 'manual' })
const win = (name: string) => repo(name, { kind: 'native', path: `C:\\Projects\\${name}` })
const wsl = (name: string, distro = 'Ubuntu-24.04') => repo(name, { kind: 'wsl', distro, path: `/home/me/${name}` })

describe('sidebar groups by environment', () => {
  it('puts Windows first, then each WSL distribution by name, keeping the list order inside a group', () => {
    const groups = groupByEnvironment([wsl('CaissaTrainer'), win('CaissaTrainer'), wsl('api', 'Debian'), win('chess2'), wsl('loccex')], 'windows')
    expect(groups.map(g => g.label)).toEqual(['Windows', 'WSL (Debian)', 'WSL (Ubuntu-24.04)'])
    expect(groups[0].repos.map(r => r.name)).toEqual(['CaissaTrainer', 'chess2'])
    expect(groups[2].repos.map(r => r.name)).toEqual(['CaissaTrainer', 'loccex'])
  })

  it('is one group when everything lives in one environment, so no headings are shown', () => {
    expect(groupByEnvironment([win('a'), win('b')], 'windows')).toHaveLength(1)
    expect(groupByEnvironment([wsl('a'), wsl('b')], 'windows')).toHaveLength(1)
    expect(groupByEnvironment([], 'windows')).toEqual([])
  })

  it('names this computer after its system', () => {
    expect(groupByEnvironment([win('a')], 'linux')[0].label).toBe('Linux')
    expect(groupByEnvironment([win('a')], 'mac')[0].label).toBe('macOS')
  })
})
