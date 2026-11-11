import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Backend } from '../src/main/backend.js'
import { Store } from '../src/core/store.js'
import { commit, git, isolateGitConfig, remoteFixture, tempDir } from './helpers.js'

beforeAll(isolateGitConfig)
const linux = process.platform === 'linux'
let cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const c of cleanups.reverse()) await c(); cleanups = [] })

async function freePort(): Promise<number> {
  return new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)) }) })
}

async function setup() {
  const f = remoteFixture()
  const cfg = tempDir()
  const store = new Store(join(cfg.dir, 'gitmanager.json'))
  const b = new Backend(store, { version: 'test', pickFolder: async () => null, openPath: async () => '', openExternal: async () => {} })
  cleanups.push(async () => { b.dev.shutdown(); await b.services.stopAll(); f.cleanup(); cfg.cleanup() })
  const added = await b.addRepo(f.local)
  if (!added.ok) throw new Error('add failed')
  return { f, b, repo: added.value.repo }
}

async function until<T>(fn: () => Promise<T | undefined | false>, ms = 8000): Promise<T> {
  const end = Date.now() + ms
  for (;;) { const r = await fn(); if (r) return r as T; if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 100)) }
}

describe.skipIf(!linux)('terminal in a repository (real pty)', () => {
  it('uses the default shell from Settings, and falls back when that shell cannot open the folder', async () => {
    const { b, repo } = await setup()
    const s0 = b.store.data.settings
    await b.saveSettings({ ...s0, terminal: { ...s0.terminal, defaultShell: 'posix' } })
    const a = await b.terminalOpen({ target: { type: 'repo', repoId: repo.id } })
    expect(a.ok && a.value.info.shell.id).toBe('posix')
    await b.saveSettings({ ...s0, terminal: { ...s0.terminal, defaultShell: 'wsl:Ubuntu' } }) // WSL does not exist here
    const c = await b.terminalOpen({ target: { type: 'repo', repoId: repo.id } })
    expect(c.ok && c.value.info.shell.id).toBe('posix')
  })


  it('opens in the repository root, runs commands and reports the exit', async () => {
    const { b, repo, f } = await setup()
    const shells = await b.terminalShells()
    expect(shells.some(s => s.available)).toBe(true)
    const r = await b.terminalOpen({ target: { type: 'repo', repoId: repo.id } })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    let out = ''
    b.dev.on('terminal-data', p => { if (p.id === r.value.info.id) out += p.data })
    expect(r.value.info.cwd).toContain(f.local)
    await b.terminalWrite(r.value.info.id, 'pwd && git branch --show-current\n')
    await until(async () => out.includes('main') && out.includes(f.local))
    expect(b.dev.list()[0].target).toEqual({ type: 'repo', repoId: repo.id })
    // a subpath cannot leave the repository
    const bad = await b.terminalOpen({ target: { type: 'repo', repoId: repo.id, subpath: '../x' } })
    expect(bad.ok).toBe(false)
    await b.terminalWrite(r.value.info.id, 'exit 3\n')
    const info = await until(async () => { const i = (await b.terminalList()).find(x => x.id === r.value.info.id); return i?.state === 'exited' ? i : false })
    expect(info.exitCode).toBe(3)
    expect(await b.terminalReplay(r.value.info.id)).toContain('main')
    const closed = await b.terminalClose(r.value.info.id)
    expect(closed.ok && closed.value).toEqual({ closed: true })
  })

  it('asks before closing a terminal that is running a command', async () => {
    const { b, repo } = await setup()
    const r = await b.terminalOpen({ target: { type: 'repo', repoId: repo.id } })
    if (!r.ok) throw new Error('open')
    await b.terminalWrite(r.value.info.id, 'sleep 30\n')
    await until(async () => (await b.dev.terminals.inspect(r.value.info.id))?.hasChildren)
    const c = await b.terminalClose(r.value.info.id)
    expect(c.ok && c.value).toMatchObject({ closed: false, needsConfirm: true })
    const f = await b.terminalClose(r.value.info.id, true)
    expect(f.ok && f.value).toEqual({ closed: true })
  })

  it('refuses a folder that is not a registered repository or worktree', async () => {
    const { b } = await setup()
    const r = await b.terminalOpen({ target: { type: 'path', location: { kind: 'native', path: '/etc' } } })
    expect(!r.ok && r.error.code).toBe('NO_TARGET')
  })
})

describe.skipIf(!linux)('port occupied by an outside process', () => {
  it('finds it, shows its repository, reads its live environment, and stops only after confirmation', async () => {
    const { b, repo, f } = await setup()
    const port = await freePort()
    const script = `require('net').createServer().listen(${port},'127.0.0.1');setInterval(()=>{},1000)`
    const child: ChildProcess = spawn(process.execPath, ['-e', script], { cwd: f.local, env: { ...process.env, GM_TEST_SECRET: 'hunter2-token' }, stdio: 'ignore' })
    cleanups.push(() => { child.kill('SIGKILL') })
    const proc = await until(async () => {
      const s = await b.procsScan(true)
      return s.ok ? s.value.processes.find(p => p.pid === child.pid && p.ports.some(x => x.port === port)) : undefined
    })
    expect(proc.owner).toBe('external')
    expect(proc.repoId).toBe(repo.id)
    expect(proc.cwd).toContain(f.local)

    const env = await b.procsEnv(proc.key)
    expect(env.ok && env.value.source).toBe('runtime-live')
    const entry = env.ok ? env.value.entries.find(e => e.name === 'GM_TEST_SECRET') : undefined
    expect(entry).toMatchObject({ value: 'hunter2-token', sensitive: true })

    // a profile that expects the port is told who holds it before anything starts
    const draft = await b.draftProfile(repo.id)
    if (!draft.ok) throw new Error('draft')
    const prof = { ...draft.value, services: [{ ...draft.value.services[0], command: 'echo hi', ports: [port] }] }
    const saved = await b.saveProfile(prof)
    if (!saved.ok) throw new Error('save')
    await b.trustProfile(saved.value.id)
    const start = await b.startServices(saved.value.id)
    expect(!start.ok && start.error.code).toBe('PORT_IN_USE')
    expect(!start.ok && start.error.detail).toContain(String(child.pid))

    const refused = await b.procsStop(proc.key)
    expect(refused.ok && refused.value).toMatchObject({ ok: false, code: 'CONFIRM_REQUIRED' })
    expect(() => process.kill(child.pid!, 0)).not.toThrow()
    const stopped = await b.procsStop(proc.key, true)
    expect(stopped.ok && stopped.value.ok).toBe(true)
    await until(async () => { try { process.kill(child.pid!, 0); return false } catch { return true } })
  })
})

describe('pull while services run, Sync with Remote and worktrees', () => {
  // The stand-in services are POSIX shell scripts.
  it.skipIf(process.platform === 'win32')('suggests a restart only for the service the change affects', async () => {
    const { b, repo, f } = await setup()
    mkdirSync(join(f.local, 'backend'), { recursive: true }); mkdirSync(join(f.local, 'frontend'), { recursive: true })
    writeFileSync(join(f.local, 'backend', 'pom.xml'), '<p/>'); writeFileSync(join(f.local, 'frontend', 'app.ts'), '1')
    git(f.local, 'add', '-A'); git(f.local, 'commit', '-q', '-m', 'layout'); git(f.local, 'push', '-q')
    git(f.other, 'pull', '-q')
    const draft = await b.draftProfile(repo.id)
    if (!draft.ok) throw new Error('draft')
    const base = draft.value.services[0]
    const mk = (id: string, name: string, cwd: string, command: string) => ({ ...base, id, name, cwd, command })
    // Stand-ins that just stay alive, in the service folders, so the real command shapes (./mvnw, ./vite) are what the profile holds.
    // (A login shell rebuilds PATH, so a shim on PATH would lose to a real mvn or npm installed on the machine.)
    writeFileSync(join(f.local, 'backend', 'mvnw'), '#!/bin/sh\nexec sleep 300\n', { mode: 0o755 })
    writeFileSync(join(f.local, 'frontend', 'vite'), '#!/bin/sh\nexec sleep 300\n', { mode: 0o755 })
    git(f.local, 'add', '-A'); git(f.local, 'commit', '-q', '-m', 'shims'); git(f.local, 'push', '-q'); git(f.other, 'pull', '-q')
    await new Promise(r => setTimeout(r, 300)) // a just-written executable can be 'text file busy' while other processes fork
    const saved = await b.saveProfile({ ...draft.value, services: [mk('be', 'Backend', 'backend', './mvnw spring-boot:run'), mk('fe', 'Frontend', 'frontend', './vite')] })
    if (!saved.ok) throw new Error('save')
    await b.trustProfile(saved.value.id)
    const started = await b.startServices(saved.value.id)
    expect(started.ok).toBe(true)
    for (const sid of ['be', 'fe']) { const st = await b.services.settled(`${saved.value.id}:${sid}`, { aliveMs: 500 }); expect(`${st?.state} ${st?.message ?? ''}`).toBe('running ') }

    commit(f.other, 'backend/pom.xml', '<p>changed</p>', 'dependency'); commit(f.other, 'frontend/app.ts', '2', 'ui')
    git(f.other, 'push', '-q')
    const pulled = await b.pull(repo.id)
    expect(pulled.ok).toBe(true)
    if (!pulled.ok) return
    const a = pulled.value.affected!
    expect(a.text).toBe('Backend updated · Restart')
    expect(a.services.find(s => s.serviceId === 'fe')!.verdict).not.toBe('restart-needed')
    expect(a.services.find(s => s.serviceId === 'be')!.verdict).toBe('restart-needed')
  })

  it('syncs: prunes, keeps unmerged work, deletes only what is safe, and records recovery', async () => {
    const { b, repo, f } = await setup()
    // merged-and-deleted on the remote, and one with unique local work
    git(f.local, 'checkout', '-q', '-b', 'done'); commit(f.local, 'a.txt', 'a'); git(f.local, 'push', '-q', '-u', 'origin', 'done')
    git(f.local, 'checkout', '-q', '-b', 'wip'); commit(f.local, 'w.txt', 'w'); git(f.local, 'push', '-q', '-u', 'origin', 'wip')
    git(f.local, 'checkout', '-q', 'main'); git(f.local, 'merge', '-q', '--no-ff', '-m', 'merge done', 'done'); git(f.local, 'push', '-q')
    git(f.local, 'branch', 'local-only')
    git(f.local, 'push', '-q', 'origin', '--delete', 'done', 'wip')
    const plan = await b.syncPlan(repo.id)
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.value.defaultBranch).toBe('main')
    const kinds = Object.fromEntries(plan.value.stale.map(s => [s.name, s.kind]))
    expect(kinds).toMatchObject({ done: 'delete-safe', wip: 'needs-review' })
    expect(plan.value.kept).toContain('local-only')
    const res = await b.syncExecute(repo.id, { branches: ['done', 'wip', 'local-only'] })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.value.deleted.map(d => d.name)).toEqual(['done'])
    expect(res.value.deleted[0].recoverWith).toContain('git branch done')
    expect(res.value.failed.map(x => x.name).sort()).toEqual(['local-only', 'wip'])
    expect(git(f.local, 'branch', '--list', 'wip')).toContain('wip')
    expect(git(f.local, 'branch', '--list', 'local-only')).toContain('local-only')
  })

  it('creates a worktree, opens a terminal in it, and refuses to remove it while dirty', async () => {
    const { b, repo, f } = await setup()
    const wt = join(f.dir, 'wt-feature')
    const added = await b.worktreeAdd(repo.id, { path: wt, branch: 'feature', create: true })
    expect(added.ok).toBe(true)
    const list = await b.worktreeList(repo.id)
    expect(list.ok && list.value.map(w => w.branch)).toContain('feature')
    if (linux) {
      const t = await b.terminalOpen({ target: { type: 'path', location: { kind: 'native', path: wt } } })
      expect(t.ok && t.value.info.cwd).toContain('wt-feature')
    }
    writeFileSync(join(wt, 'dirty.txt'), 'x')
    const chk = await b.worktreeCheck(repo.id, wt)
    expect(chk.ok && chk.value.blockers.map(x => x.code)).toContain('dirty')
    const refused = await b.worktreeRemove(repo.id, wt, false)
    expect(refused.ok).toBe(false)
    expect(git(f.local, 'worktree', 'list')).toContain('wt-feature')
  })
})
