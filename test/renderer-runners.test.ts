import { describe, expect, it } from 'vitest'
import type { DependencyResult, DependencyStatus } from '../src/shared/deps'
import type { ActionResult, Runner } from '../src/shared/runners'
import { DEP_MARK, checkedAs, environmentText, groupDependencies, headerText, isInstalled, needsTerminal, restartOutcome, runnerMark, serviceNote, sortDependencies, splitAttention, terminalBlock, githubUrl } from '../src/renderer/tools/runners/detailLogic'

const cap = { allowed: true, reason: null }
function runner(o: Partial<Runner> = {}, service: 'running' | 'stopped' | 'none' = 'running', hostKind: 'native' | 'wsl' | 'ssh' = 'wsl'): Runner {
  const host = hostKind === 'wsl' ? { kind: 'wsl' as const, distro: 'Ubuntu-24.04' } : hostKind === 'ssh' ? { kind: 'ssh' as const, host: 'box' } : { kind: 'native' as const }
  return {
    key: 'k', name: 'caissa-pc', status: 'online', platform: 'linux', environment: 'wsl', machine: null, distro: 'Ubuntu-24.04', scope: { kind: 'repo', owner: 'acme', repo: 'app' }, path: '/home/me/r', version: '2.300.0',
    github: null, source: 'local', attention: [], notices: [], manageable: true,
    local: { key: 'k', host, service: { kind: service === 'none' ? 'none' : 'systemd', name: 'x', state: service === 'none' ? 'not-installed' : service, startup: 'automatic', detail: null }, gitHubUrl: 'https://github.com/acme/app' } as never,
    capabilities: { start: cap, stop: cap, restart: cap, inspect: cap, openFolder: cap, logs: cap, checkUpdate: cap, update: cap, unregister: cap, uninstall: cap, retire: cap },
    ...o,
  }
}
function dep(id: string, status: DependencyStatus, o: Partial<DependencyResult> = {}): DependencyResult {
  return { id: id as never, label: id, status, version: null, path: null, verifiedIn: { host: { kind: 'wsl', distro: 'Ubuntu-24.04' }, os: 'linux', label: 'WSL Ubuntu-24.04' }, checkedAt: '', via: 'path-lookup', optional: false, ...o }
}

describe('runner header', () => {
  it('composes environment, status and a noteworthy service state', () => {
    expect(headerText(runner())).toBe('Ubuntu-24.04 · Online')
    expect(headerText(runner({}, 'stopped'))).toBe('Ubuntu-24.04 · Online · Service stopped')
    expect(headerText(runner({ status: 'offline' }, 'none'))).toBe('Ubuntu-24.04 · Offline')
    expect(headerText(runner({ status: 'busy' }))).toBe('Ubuntu-24.04 · Busy')
  })
  it('names the environment by kind and never invents one', () => {
    expect(environmentText(runner({ environment: 'native', platform: 'windows', distro: null }))).toBe('Windows')
    expect(environmentText(runner({ environment: 'remote', machine: 'build-box' }))).toBe('build-box')
    expect(environmentText(runner({ environment: 'unknown', local: null }))).toBe('Not inspected')
  })
  it('mentions the service only when it is local and stopped', () => {
    expect(serviceNote(runner({ local: null }))).toBeNull()
    expect(serviceNote(runner({}, 'running'))).toBeNull()
    expect(serviceNote(runner({}, 'none'))).toBeNull()
    expect(serviceNote(runner({}, 'stopped'))).toBe('Service stopped')
  })
  it('maps status to a mark: unknown stays neutral, offline is not failed', () => {
    expect(runnerMark('online')).toEqual({ state: 'ready', label: 'Online' })
    expect(runnerMark('busy').state).toBe('running')
    expect(runnerMark('offline').state).toBe('stopped')
    expect(runnerMark('unknown')).toEqual({ state: 'neutral', label: 'Unknown' })
  })
  it('shows at most two problems and keeps the rest', () => {
    expect(splitAttention(['a', 'b', 'c', 'd'])).toEqual({ shown: ['a', 'b'], rest: ['c', 'd'] })
    expect(splitAttention(['a'])).toEqual({ shown: ['a'], rest: [] })
  })
})

describe('terminal availability and links', () => {
  it('blocks the terminal without a local installation or over SSH, with a short reason', () => {
    expect(terminalBlock(runner())).toBeNull()
    expect(terminalBlock(runner({ local: null }))).toMatch(/not installed/i)
    expect(terminalBlock(runner({}, 'running', 'ssh'))).toMatch(/ssh/i)
  })
  it('builds the GitHub URL from the scope', () => {
    expect(githubUrl(runner())).toBe('https://github.com/acme/app')
    expect(githubUrl(runner({ scope: { kind: 'org', org: 'acme' } }))).toBe('https://github.com/acme')
    expect(githubUrl(runner({ scope: null }))).toBeNull()
  })
})

describe('dependency table', () => {
  const results = [dep('git', 'found', { version: '2.43' }), dep('node', 'missing', { detail: 'Not on the runner PATH' }), dep('make', 'found', { optional: true }), dep('java', 'unknown'), dep('npm', 'error'), dep('curl', 'missing', { optional: true })]
  it('sorts problems first and keeps report order inside a status', () => {
    expect(sortDependencies(results.filter(d => !d.optional)).map(d => d.id)).toEqual(['npm', 'node', 'java', 'git'])
  })
  it('groups optional tools apart from the main toolchains', () => {
    const g = groupDependencies({ results })
    expect(g.main.map(d => d.id)).toEqual(['npm', 'node', 'java', 'git'])
    expect(g.optional.map(d => d.id)).toEqual(['curl', 'make'])
  })
  it('keeps found, missing, error and unknown distinct, and never counts unknown as installed', () => {
    const labels = (Object.keys(DEP_MARK) as DependencyStatus[]).map(k => DEP_MARK[k].label)
    expect(new Set(labels).size).toBe(4)
    expect(isInstalled(dep('a', 'found'))).toBe(true)
    for (const s of ['unknown', 'missing', 'error'] as const) expect(isInstalled(dep('a', s))).toBe(false)
    expect(DEP_MARK.unknown.state).toBe('neutral')
  })
  it('offers the terminal only for missing or errored rows', () => {
    expect(needsTerminal(dep('a', 'missing'))).toBe(true)
    expect(needsTerminal(dep('a', 'error'))).toBe(true)
    expect(needsTerminal(dep('a', 'unknown'))).toBe(false)
    expect(needsTerminal(dep('a', 'found'))).toBe(false)
  })
  it('states who checked, where', () => {
    expect(checkedAs({ user: 'me', hostLabel: 'WSL Ubuntu-24.04' })).toBe('Checked as me in WSL Ubuntu-24.04')
    expect(checkedAs({ user: null, hostLabel: 'Windows' })).toBe('Checked in Windows')
  })
})

describe('restart outcome', () => {
  const res = (ok: boolean): ActionResult => ({ action: 'restart', ok, message: 'm' })
  it('reports success only when the action says ok', () => {
    expect(restartOutcome(res(true))).toEqual({ ok: true, label: 'Restarted' })
    expect(restartOutcome(res(false))).toEqual({ ok: false, label: 'Restart failed' })
    expect(restartOutcome({ action: 'restart', message: 'm' } as unknown as ActionResult).ok).toBe(false)
  })
})
