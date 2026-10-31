import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Backend } from '../../src/main/backend.js'
import { RunnerManager } from '../../src/core/runners/manager.js'
import { Store, sanitize } from '../../src/core/store.js'
import { API_METHODS } from '../../src/shared/api.js'
import { FakeRunnerGitHub, FakeShell } from './fakes.js'

let dirs: string[] = []
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = [] })

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'gm-rb-')); dirs.push(dir)
  const store = new Store(join(dir, 'gitmanager.json'))
  const gh = new FakeRunnerGitHub()
  const shell = new FakeShell(); shell.mkdir('/opt')
  const runners = new RunnerManager({ dir, gh, config: () => store.data.runners, saveConfig: () => store.save(), os: 'linux', tmpDir: dir, repos: () => store.data.repos, openExternal: async () => {}, openPath: async () => '', shellFor: () => shell, sleep: async () => {} })
  const b = new Backend(store, { version: 't', pickFolder: async () => null, openPath: async () => '', openExternal: async () => {} }, { runners, os: 'linux' })
  return { b, store, gh, shell, dir }
}

describe('runners through the backend (IPC argument validation)', () => {
  it('exposes the runner methods in the API list and the preload', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'main', 'preload.ts'), 'utf8')
    for (const m of ['runnersState', 'runnersScan', 'runnersPlan', 'runnersInstall', 'runnersAction', 'runnersOpen']) { expect(API_METHODS).toContain(m); expect(src).toContain(`'${m}'`) }
    expect(src).toContain("'runners-status'"); expect(src).toContain("'runners-changed'")
  })
  it('rejects malformed arguments before anything runs', async () => {
    const { b, shell } = setup()
    await expect(b.runnersAction('x', 'format-disk', {})).rejects.toThrow(/Unknown operation/)
    await expect(b.runnersAction('', 'stop', {})).rejects.toThrow()
    await expect(b.runnersAddRoot({ kind: 'wsl', distro: 'Ubuntu;rm' }, '/x')).rejects.toThrow(/Invalid host/)
    await expect(b.runnersAddRoot({ kind: 'native' }, '')).rejects.toThrow()
    await expect(b.runnersRemoveRoot('../x')).rejects.toThrow()
    await expect(b.runnersAllowSsh('-oProxyCommand=x', true)).rejects.toThrow(/Invalid SSH/)
    await expect(b.runnersGroups('bad org')).rejects.toThrow()
    await expect(b.runnersWorkflows('nope')).rejects.toThrow(/Invalid repository/)
    expect(await b.runnersOpen({ kind: 'shell', cmd: 'rm' })).toMatchObject({ ok: false, error: { code: 'INVALID' } })
    expect(await b.runnersInstall('abc', 'yes')).toMatchObject({ ok: false, error: { code: 'NOT_CONFIRMED' } })
    expect(await b.runnersPlan({ host: { kind: 'native' }, scope: { kind: 'repo', owner: 'a', repo: 'b' }, name: 'x y', directory: '/opt/x' })).toMatchObject({ ok: false, error: { code: 'INVALID' } })
    expect(shell.calls.filter(c => c.file !== 'sh')).toHaveLength(0)
  })
  it('coerces options to booleans so a string can never count as confirmation', async () => {
    const { b, shell, gh } = setup()
    shell.install('/opt/actions-runner', { agentId: 11 })
    gh.scopes.push({ key: 'acme/app', kind: 'repo', runners: [{ id: 11, name: 'runner-a', os: 'Linux', status: 'online' }] })
    await b.runners.scanAndWait()
    const key = b.runners.inventory().runners[0].key
    const r = await b.runnersAction(key, 'uninstall', { confirm: 'true', unregisterFirst: 1 })
    expect(r.ok && r.value.ok).toBe(false)
    expect(r.ok && r.value.message).toMatch(/explicit confirmation/)
    expect(shell.dirs.has('/opt/actions-runner')).toBe(true)
  })
  it('returns the state, settings and scan results through the API surface', async () => {
    const { b } = setup()
    const st = await b.runnersState()
    expect(st.config.settings.autoDiscover).toBe(true)
    expect(st.hosts[0].host).toEqual({ kind: 'native' })
    expect(st.security).toMatch(/executes the code/)
    expect(await b.runnersScan({ localOnly: true })).toEqual({ ok: true, value: { started: true } })
    await b.runners.whenIdle()
    expect((await b.runnersState()).inventory.localScannedAt).toBeTruthy()
    expect(await b.runnersSaveSettings({ autoDiscover: false })).toEqual({ ok: true, value: undefined })
    expect((await b.runnersState()).config.settings.autoDiscover).toBe(false)
  })
})

describe('persistence and migration', () => {
  it('loads a configuration written before the Runners tool existed with defaults, and drops only invalid runner entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gm-mig-')); dirs.push(dir)
    const file = join(dir, 'gitmanager.json')
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, repos: [{ id: 'r1', name: 'app', location: { kind: 'native', path: '/x/app' }, addedAt: '' }], roots: [], profiles: [], settings: { editor: 'code' }, ui: { selectedRepoId: 'r1', selectedProfile: {} }, storage: { settings: { scheduleEnabled: true } } }))
    const s = new Store(file)
    expect(s.loadWarning).toBeNull()
    expect(s.data.repos).toHaveLength(1); expect(s.data.ui.selectedRepoId).toBe('r1'); expect(s.data.storage.settings.scheduleEnabled).toBe(true)
    expect(s.data.runners).toEqual({ settings: { autoDiscover: true, githubAtStartup: false, roots: [], orgs: [], repos: [], sshHosts: [], refreshMinutes: 5 }, known: [] })
    const { data, dropped } = sanitize({ schemaVersion: 1, repos: [], runners: { settings: { autoDiscover: false, roots: [{ id: 'a', host: { kind: 'native' }, path: '/srv' }, { host: { kind: 'ssh', host: 'bad host' }, path: '/x' }, { host: { kind: 'native' }, path: '' }], orgs: ['ok', 'not ok'], sshHosts: ['nas'], refreshMinutes: -5 }, known: [{ key: 'k', host: { kind: 'wsl', distro: 'Ubuntu' }, path: '/home/me/r', name: 'r', scope: { kind: 'repo', owner: 'a', repo: 'b' }, agentId: 3, at: '' }, { host: {}, path: '/x' }] } })
    expect(dropped).toBe(0)
    expect(data.runners.settings).toMatchObject({ autoDiscover: false, orgs: ['ok'], sshHosts: ['nas'], refreshMinutes: 0 })
    expect(data.runners.settings.roots).toEqual([{ id: 'a', host: { kind: 'native' }, path: '/srv' }])
    expect(data.runners.known).toEqual([{ key: 'wsl:ubuntu:/home/me/r', host: { kind: 'wsl', distro: 'Ubuntu' }, path: '/home/me/r', name: 'r', scope: { kind: 'repo', owner: 'a', repo: 'b' }, agentId: 3, at: '' }])
  })
  it('sets a corrupt runners state file aside and starts empty, keeping the configuration file intact', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gm-cor-')); dirs.push(dir)
    writeFileSync(join(dir, 'runners-state.json'), '{not json')
    const store = new Store(join(dir, 'gitmanager.json'))
    const m = new RunnerManager({ dir, gh: new FakeRunnerGitHub(), config: () => store.data.runners, saveConfig: () => store.save(), os: 'linux', tmpDir: dir, repos: () => [], openExternal: async () => {}, openPath: async () => '' })
    expect(m.inventory().runners).toEqual([])
    const { readdirSync } = require('node:fs') as typeof import('node:fs')
    expect(readdirSync(dir).some(f => f.startsWith('runners-state.json.corrupt-'))).toBe(true)
  })
})
