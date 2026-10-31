// Test doubles for the Runners tool: an in-memory host (file system, services, processes, every command recorded) and an
// in-memory GitHub that speaks the runner endpoints, with failure injection. Nothing here touches the real machine.
import { existsSync } from 'node:fs'
import type { AuthState } from '../../src/shared/storage.js'
import type { RunnerHost, RunnerOs } from '../../src/shared/runners.js'
import type { ExecResult } from '../../src/core/exec.js'
import { GhError, type GhApi, type GhMethod, type GhRequestOptions, type GhResponse } from '../../src/core/storage/gh.js'
import type { HostShell, RunOpts } from '../../src/core/runners/hosts.js'
import { POSIX_SCAN_SCRIPT } from '../../src/core/runners/discovery.js'

export type Call = { file: string; args: string[]; opts: RunOpts; elevated: boolean }
const ok = (stdout = '', code = 0, stderr = ''): ExecResult => ({ code, stdout, stderr, timedOut: false })

type Handler = (c: Call, shell: FakeShell) => ExecResult | undefined | Promise<ExecResult | undefined>

/**
 * A POSIX-like host in memory. `files` holds file contents, `dirs` the directories; `services` the systemd units or
 * launchd labels with their state; `procs` the Runner.Listener processes (pid, cwd). Commands that discovery and the
 * installer send are answered from that model; a test can add handlers for anything else and inspect `calls`.
 */
export class FakeShell implements HostShell {
  files = new Map<string, string>()
  dirs = new Set<string>()
  services = new Map<string, { active: string; enabled: string }>()
  launchd = new Map<string, number | null>()
  procs: { pid: number; cwd: string }[] = []
  calls: Call[] = []
  /** Paths that resolve elsewhere (a symbolic link): realpath answers the target. */
  realpaths: Record<string, string> = {}
  handlers: Handler[] = []
  probe = { sys: 'Linux', machine: 'x86_64', hostname: 'build-box', user: 'me', init: 'systemd', sudo: true }
  elevationAllowed = true
  constructor(readonly host: RunnerHost = { kind: 'native' }, readonly os: RunnerOs = 'linux', private readonly elevatedShell = false) {}

  private sep() { return this.os === 'windows' ? '\\' : '/' }
  private parent(p: string) { const i = p.lastIndexOf(this.sep()); return i > 0 ? p.slice(0, i) : p }
  mkfile(p: string, content = '') { this.files.set(p, content); let d = this.parent(p); while (d && !this.dirs.has(d)) { this.dirs.add(d); const n = this.parent(d); if (n === d) break; d = n } }
  mkdir(p: string) { this.dirs.add(p); let d = this.parent(p); while (d && !this.dirs.has(d)) { this.dirs.add(d); const n = this.parent(d); if (n === d) break; d = n } }
  /** A complete registered installation with a systemd unit. */
  install(dir: string, o: { agentId?: number; name?: string; url?: string; version?: string; service?: string | null; creds?: boolean; running?: boolean; disableUpdate?: boolean } = {}) {
    const name = o.name ?? 'runner-a'
    this.mkfile(`${dir}/.runner`, JSON.stringify({ agentId: o.agentId ?? 11, agentName: name, poolName: 'Default', gitHubUrl: o.url ?? 'https://github.com/acme/app', workFolder: '_work', ephemeral: false, disableUpdate: o.disableUpdate ?? false }))
    if (o.creds !== false) this.mkfile(`${dir}/.credentials`, 'never read')
    this.mkfile(`${dir}/config.sh`, '#!/bin/sh')
    this.mkfile(`${dir}/svc.sh`, '#!/bin/sh')
    this.mkfile(`${dir}/run.sh`, '#!/bin/sh')
    this.mkfile(`${dir}/bin/Runner.Listener`, `version=${o.version ?? '2.319.1'}`)
    this.mkdir(`${dir}/_diag`)
    if (o.service !== null) {
      const unit = o.service ?? `actions.runner.acme-app.${name}.service`
      this.mkfile(`${dir}/.service`, unit)
      this.services.set(unit, { active: o.running ? 'active' : 'inactive', enabled: 'enabled' })
      if (o.running) this.procs.push({ pid: 4000 + this.procs.length, cwd: dir })
    }
    return dir
  }
  listDirSync(p: string): string[] | null {
    if (!this.dirs.has(p)) return null
    const pre = p.endsWith(this.sep()) ? p : p + this.sep()
    const names = new Set<string>()
    for (const f of [...this.files.keys(), ...this.dirs]) if (f.startsWith(pre) && f !== p) names.add(f.slice(pre.length).split(this.sep())[0])
    return [...names].sort()
  }
  private versionOf(dir: string) { const m = /version=([\d.]+)/.exec(this.files.get(`${dir}/bin/Runner.Listener`) ?? ''); return m ? m[1] : null }

  /** The scan script's output for the model (what the real script would print on this host). */
  scanOutput(args: string[]): string {
    const lines: string[] = []
    const cands = new Set<string>()
    for (const a of args) {
      const depth = Number(a.split(':')[0]); let root = a.slice(a.indexOf(':') + 1)
      if (root.startsWith('~')) root = `/home/${this.probe.user}${root.slice(1)}`
      if (!this.dirs.has(root)) { lines.push(`@@ROOT ${root} missing`); continue }
      lines.push(`@@ROOT ${root} ok`)
      if (depth === 0) cands.add(root)
      else for (const f of this.files.keys()) {
        if (!(f.startsWith(root + '/') || root === '/') ) continue
        const rel = root === '/' ? f.slice(1) : f.slice(root.length + 1)
        const parts = rel.split('/')
        const base = parts[parts.length - 1]
        if ((base === '.runner' || base === 'config.sh') && parts.length <= depth && !parts.slice(0, -1).some(p => p.startsWith('.') || ['bin', '_work', '_diag', 'externals', 'node_modules'].includes(p))) cands.add(f.slice(0, f.lastIndexOf('/')))
      }
    }
    for (const [unit] of this.services) { const dir = [...this.files.entries()].find(([k, v]) => k.endsWith('/.service') && v === unit)?.[0]; if (dir) cands.add(dir.slice(0, -'/.service'.length)) }
    for (const d of [...cands].sort()) {
      const runner = this.files.get(`${d}/.runner`)
      if (!runner && !(this.files.has(`${d}/config.sh`) && this.files.has(`${d}/bin/Runner.Listener`))) continue
      lines.push(`@@DIR ${d}`)
      if (runner !== undefined) lines.push(`@@RUNNER ${Buffer.from(runner).toString('base64')}`)
      const svc = this.files.get(`${d}/.service`)
      if (svc !== undefined) lines.push(`@@SERVICE ${svc}`)
      if (this.files.has(`${d}/.credentials`)) lines.push('@@CREDS yes')
      if (this.files.has(`${d}/bin/Runner.Listener`)) lines.push('@@LISTENER yes')
      if (this.files.has(`${d}/config.sh`)) lines.push('@@CONFIG yes')
      const v = this.versionOf(d); if (v) lines.push(`@@VERSION ${v}`)
      if (svc) {
        if (svc.endsWith('.plist')) { const label = svc.split('/').pop()!.replace(/\.plist$/, ''); const pid = this.launchd.get(label); lines.push(`@@LAUNCHD ${this.launchd.has(label) ? 0 : 113} ${this.launchd.has(label) ? `{ "Label" = "${label}"; ${pid ? `"PID" = ${pid};` : ''} }` : `Could not find service "${label}" in domain for port`}`) }
        else { const unit = svc.includes('/') ? svc.split('/').pop()! : svc; const s = this.services.get(unit); lines.push(s ? `@@SYSTEMD ${s.active}\t${s.enabled}` : this.probe.init === 'systemd' ? `@@SYSTEMD inactive\tnot-found` : `@@SYSTEMD System has not been booted with systemd as init system (PID 1). Can't operate.\tFailed to connect to bus`) }
      }
      for (const p of this.procs) if (p.cwd === d) lines.push(`@@PID ${p.pid}`)
      lines.push('@@END')
    }
    return lines.join('\n') + '\n'
  }

  async run(file: string, args: string[], opts: RunOpts = {}): Promise<ExecResult> {
    const call: Call = { file, args, opts, elevated: this.elevatedShell }
    this.calls.push(call)
    for (const h of this.handlers) { const r = await h(call, this); if (r) return r }
    const cwd = opts.cwd ?? ''
    const abs = (p: string) => (p.startsWith('/') || /^[A-Za-z]:\\/.test(p) ? p : `${cwd}/${p.replace(/^\.\//, '')}`)
    switch (file) {
      case 'sh': {
        const script = args[1], sargs = args.slice(3)
        if (script === POSIX_SCAN_SCRIPT) return ok(this.scanOutput(sargs))
        if (script.includes('uname -s')) return ok(`${this.probe.sys}\n${this.probe.machine}\n${this.probe.hostname}\n${this.probe.user}\n${this.probe.init}\nsudo=${this.probe.sudo ? 'yes' : 'no'}\n`)
        if (script.includes('_diag')) { const dir = sargs[0]; const logs = (this.listDirSync(`${dir}/_diag`) ?? []).filter(f => f.endsWith('.log')); return ok(logs.map(f => `@@FILE ${f}\t1730000000\t${(this.files.get(`${dir}/_diag/${f}`) ?? '').length}\n${this.files.get(`${dir}/_diag/${f}`) ?? ''}`).join('\n')) }
        return ok('', 127, `sh: unknown script`)
      }
      case 'test': return ok('', (args[0] === '-d' ? this.dirs.has(args[1]) : this.files.has(args[1]) || this.dirs.has(args[1])) ? 0 : 1)
      case 'head': { const p = args[args.length - 1]; const c = this.files.get(p); return c === undefined ? ok('', 1, 'No such file') : ok(c.slice(0, Number(args[1]))) }
      case 'ls': { const l = this.listDirSync(args[args.length - 1]); return l ? ok(l.join('\n')) : ok('', 2, 'No such file or directory') }
      case 'mkdir': { this.mkdir(args[args.length - 1]); return ok() }
      case 'rm': { const p = args[args.length - 1]; for (const k of [...this.files.keys()]) if (k === p || k.startsWith(p + '/')) this.files.delete(k); for (const d of [...this.dirs]) if (d === p || d.startsWith(p + '/')) this.dirs.delete(d); return ok() }
      case 'mv': { const [from, to] = args.slice(-2); for (const k of [...this.files.keys()]) if (k === from || k.startsWith(from + '/')) { this.files.set(to + k.slice(from.length), this.files.get(k)!); this.files.delete(k) } for (const d of [...this.dirs]) if (d === from || d.startsWith(from + '/')) { this.dirs.add(to + d.slice(from.length)); this.dirs.delete(d) } return ok() }
      case 'tar': {
        if (args[0] === '--version') return ok('tar (GNU tar) 1.35')
        const dir = args[args.indexOf('-C') + 1]
        const pkg = args[args.indexOf('-xzf') + 1]
        // the archive is either a file the test put on the fake host, or a real temporary file the installer downloaded (any platform's temp folder)
        if (!this.files.has(pkg) && !existsSync(pkg)) return ok('', 2, `tar: ${pkg}: Cannot open: No such file`)
        for (const f of ['config.sh', 'svc.sh', 'run.sh', 'bin/installdependencies.sh']) this.mkfile(`${dir}/${f}`, '#!/bin/sh')
        this.mkfile(`${dir}/bin/Runner.Listener`, `version=${this.packageVersion}`)
        this.mkdir(`${dir}/externals`)
        return ok()
      }
      case './bin/Runner.Listener': { const v = this.versionOf(cwd); return v ? ok(v) : ok('', 1, 'not found') }
      case './config.sh': {
        if (args[0] === 'remove') { const t = args[args.indexOf('--token') + 1]; if (!t?.startsWith('A')) return ok('', 1, 'Invalid configuration provided for token'); this.files.delete(`${cwd}/.runner`); this.files.delete(`${cwd}/.credentials`); return ok('# Runner removed successfully') }
        const token = args[args.indexOf('--token') + 1]
        if (this.configureFails) return ok('', 1, this.configureFails)
        if (!/^A[A-Z0-9]{28}$/.test(token)) return ok('', 1, 'Http response code: NotFound (invalid token)')
        const name = args[args.indexOf('--name') + 1]
        this.mkfile(`${cwd}/.runner`, JSON.stringify({ agentId: this.nextAgentId++, agentName: name, poolName: 'Default', gitHubUrl: args[args.indexOf('--url') + 1], workFolder: args[args.indexOf('--work') + 1], ephemeral: args.includes('--ephemeral'), disableUpdate: args.includes('--disableupdate') }))
        this.mkfile(`${cwd}/.credentials`, 'secret')
        this.configured.push({ dir: cwd, args })
        return ok(`√ Connected to GitHub\n√ Runner successfully added\n√ Runner connection is good\n√ Settings Saved.`)
      }
      case './svc.sh': {
        if (!this.elevatedShell && this.os === 'linux') return ok('', 1, 'Must run as sudo')
        const unit = `actions.runner.${(this.files.get(`${cwd}/.runner`) ? JSON.parse(this.files.get(`${cwd}/.runner`)!) : { gitHubUrl: 'https://github.com/x/y', agentName: 'r' }).gitHubUrl.replace('https://github.com/', '').replace('/', '-')}.${JSON.parse(this.files.get(`${cwd}/.runner`) ?? '{"agentName":"r"}').agentName}${this.os === 'linux' ? '.service' : ''}`
        if (args[0] === 'install') { if (this.os === 'linux' && !args[1]) return ok('', 1, 'Must specify user'); this.mkfile(`${cwd}/.service`, this.os === 'macos' ? `/Users/${this.probe.user}/Library/LaunchAgents/${unit}.plist` : unit); if (this.os === 'macos') this.launchd.set(unit, null); else this.services.set(unit, { active: 'inactive', enabled: 'enabled' }); return ok(`Creating ${unit}`) }
        if (args[0] === 'start') { if (this.os === 'macos') this.launchd.set(unit, 777); else { const s = this.services.get(unit); if (!s) return ok('', 5, 'Unit not found'); s.active = 'active' } this.procs.push({ pid: 9000 + this.procs.length, cwd }); return ok() }
        if (args[0] === 'stop') { if (this.os === 'macos') this.launchd.set(unit, null); else { const s = this.services.get(unit); if (s) s.active = 'inactive' } this.procs = this.procs.filter(p => p.cwd !== cwd); return ok() }
        if (args[0] === 'uninstall') { this.services.delete(unit); this.launchd.delete(unit); this.files.delete(`${cwd}/.service`); return ok() }
        return ok('', 1, 'unknown')
      }
      case 'systemctl': {
        if (!this.elevatedShell) return ok('', 1, 'Interactive authentication required.')
        const s = this.services.get(args[1]); if (!s) return ok('', 5, `Failed to ${args[0]} ${args[1]}: Unit not found.`)
        const dir = [...this.files.entries()].find(([k, v]) => k.endsWith('/.service') && v === args[1])?.[0].slice(0, -'/.service'.length)
        if (args[0] === 'start' || args[0] === 'restart') { s.active = 'active'; if (dir && !this.procs.some(p => p.cwd === dir)) this.procs.push({ pid: 9100, cwd: dir }) }
        if (args[0] === 'stop') { s.active = 'inactive'; this.procs = this.procs.filter(p => p.cwd !== dir) }
        return ok()
      }
      case 'realpath': { const t = args[args.length - 1]; return this.realpaths[t] ? ok(this.realpaths[t] + '\n') : this.dirs.has(t) || this.files.has(t) ? ok(t + '\n') : ok('', 1, 'No such file') }
      case 'kill': { const pid = Number(args[args.length - 1]); this.procs = this.procs.filter(p => p.pid !== pid); return ok() }
      case 'sudo': return this.elevationAllowed ? this.run(args[args.indexOf('--') + 1], args.slice(args.indexOf('--') + 2), opts) : ok('', 1, 'sudo: a password is required')
    }
    return ok('', 127, `${file}: command not found`)
  }
  packageVersion = '2.321.0'
  configureFails: string | null = null
  removeFails = false
  configured: { dir: string; args: string[] }[] = []
  nextAgentId = 500

  script(script: string, args: string[], opts: RunOpts = {}) { return this.run('sh', ['-c', script, 'sh', ...args], opts) }
  async readFile(p: string) { return this.files.get(p) ?? null }
  async exists(p: string) { return this.files.has(p) || this.dirs.has(p) }
  async isDir(p: string) { return this.dirs.has(p) }
  async listDir(p: string) { return this.listDirSync(p) }
  async mkdirp(p: string) { this.mkdir(p); return { ok: true } }
  async remove(p: string) { await this.run('rm', ['-rf', '--', p]); return { ok: true } }
  async move(a: string, b: string) { await this.run('mv', ['--', a, b]); return { ok: true } }
  async putFile(_local: string, hostPath: string) { this.mkfile(hostPath, 'archive'); this.calls.push({ file: 'putFile', args: [hostPath], opts: {}, elevated: false }); return { ok: true } }
  elevated(): HostShell { const e = new FakeShell(this.host, this.os, true); Object.assign(e, { files: this.files, dirs: this.dirs, services: this.services, launchd: this.launchd, probe: this.probe, handlers: this.handlers, calls: this.calls, elevationAllowed: this.elevationAllowed }); Object.defineProperty(e, 'procs', { get: () => this.procs, set: v => { this.procs = v } }); Object.defineProperty(e, 'configured', { get: () => this.configured }); return e }
  elevationNote() { return 'fake elevation' }
}

/* ------------------------------------------------------------ GitHub */

export type FakeRunner = { id: number; name: string; os: string; status: 'online' | 'offline'; busy?: boolean; labels?: string[]; group?: number; ephemeral?: boolean }
export type FakeScope = { key: string; kind: 'repo' | 'org'; admin?: boolean; runners: FakeRunner[]; groups?: { id: number; name: string; default?: boolean; visibility?: string; repos?: string[] }[] }

const json = (status: number, body: unknown, headers: Record<string, string> = {}): GhResponse => ({ status, headers: { 'content-type': 'application/json', ...headers }, body })
const err = (status: number, message: string, headers: Record<string, string> = {}) => json(status, { message }, headers)

export class FakeRunnerGitHub implements GhApi {
  scopes: FakeScope[] = []
  orgs: { login: string; role: 'admin' | 'member' }[] = []
  repos: { full: string; admin: boolean; private?: boolean; workflows?: Record<string, string>; id?: number }[] = []
  /** Former names of renamed repositories (lower-case owner/name to the current full name). GitHub redirects them, so every request under an old name is answered as the current repository. */
  aliases: Record<string, string> = {}
  latest = { version: '2.321.0', checksums: { 'linux-x64': 'a'.repeat(64), 'win-x64': 'b'.repeat(64), 'osx-arm64': 'c'.repeat(64) } as Record<string, string> }
  downloads: boolean | 'forbidden' = true
  auth: AuthState = { state: 'ok', login: 'me', scopes: ['repo', 'admin:org'], scopesKnown: true, canWrite: true, plan: null }
  calls: { method: string; path: string }[] = []
  tokens: string[] = []
  tokenExpiresAt: string | null = null
  intercept: ((method: string, path: string) => GhResponse | undefined) | null = null
  nextId = 900
  authState = async () => this.auth

  private repoJson(r: { full: string; admin: boolean; private?: boolean; id?: number }) {
    return { ...(r.id ? { id: r.id } : {}), full_name: r.full, private: !!r.private, archived: false, default_branch: 'main', owner: { login: r.full.split('/')[0], type: 'User' }, permissions: { admin: r.admin, push: true } }
  }
  scope(kind: 'repo' | 'org', key: string) { return this.scopes.find(s => s.kind === kind && s.key.toLowerCase() === key.toLowerCase()) }
  count(method: string, re: RegExp) { return this.calls.filter(c => c.method === method && re.test(c.path)).length }

  async request(method: GhMethod, path: string, _o: GhRequestOptions = {}): Promise<GhResponse> {
    this.calls.push({ method, path })
    const over = this.intercept?.(method, path)
    if (over) return over
    if (this.auth.state !== 'ok') return err(401, 'Bad credentials')
    const [p, qs = ''] = path.split('?')
    const q = new URLSearchParams(qs)
    const page = Number(q.get('page') ?? 1), per = Number(q.get('per_page') ?? 30)
    const slice = <T>(l: T[]) => l.slice((page - 1) * per, page * per)
    if (p === '/user') return json(200, { login: 'me' }, { 'x-oauth-scopes': 'repo, admin:org' })
    if (p === '/user/orgs') return json(200, slice(this.orgs.map(o => ({ login: o.login }))))
    if (p === '/user/repos') return json(200, slice(this.repos.map(r => ({ full_name: r.full, private: !!r.private, archived: false, default_branch: 'main', owner: { login: r.full.split('/')[0], type: 'User' }, permissions: { admin: r.admin, push: true } }))))
    const mem = /^\/user\/memberships\/orgs\/([^/]+)$/.exec(p)
    if (mem) { const o = this.orgs.find(x => x.login.toLowerCase() === decodeURIComponent(mem[1]).toLowerCase()); return o ? json(200, { role: o.role }) : err(404, 'Not Found') }
    if (p === '/repos/actions/runner/releases/latest') return json(200, { tag_name: `v${this.latest.version}`, html_url: `https://github.com/actions/runner/releases/tag/v${this.latest.version}`, body: Object.entries(this.latest.checksums).map(([k, v]) => `<!-- BEGIN SHA ${k} -->${v}<!-- END SHA ${k} -->`).join('\n') })
    const byId = /^\/repositories\/(\d+)$/.exec(p)
    if (byId) { const r = this.repos.find(x => x.id === Number(byId[1])); return r ? json(200, this.repoJson(r)) : err(404, 'Not Found') }
    const m = /^\/(repos\/([^/]+\/[^/]+)|orgs\/([^/]+))(\/.*)?$/.exec(p)
    if (!m) return err(404, 'Not Found')
    const kind = m[2] ? 'repo' : 'org'
    const asked = decodeURIComponent(m[2] ?? m[3])
    const key = kind === 'repo' ? this.aliases[asked.toLowerCase()] ?? asked : asked
    const rest = m[4] ?? ''
    const sc = this.scope(kind, key)
    if (kind === 'repo' && rest === '') { const r = this.repos.find(x => x.full.toLowerCase() === key.toLowerCase()); return r ? json(200, this.repoJson(r)) : err(404, 'Not Found') }
    if (kind === 'repo' && rest.startsWith('/git/trees/')) { const r = this.repos.find(x => x.full.toLowerCase() === key.toLowerCase()); return r ? json(200, { sha: 't', tree: Object.entries(r.workflows ?? {}).map(([path, text]) => ({ type: 'blob', path, size: text.length })) }) : err(404, 'Not Found') }
    if (kind === 'repo' && rest.startsWith('/contents/')) { const r = this.repos.find(x => x.full.toLowerCase() === key.toLowerCase()); const t = r?.workflows?.[decodeURIComponent(rest.slice('/contents/'.length))]; return t === undefined ? err(404, 'Not Found') : { status: 200, headers: { 'content-type': 'text/plain' }, body: t } }
    if (!sc) return err(404, 'Not Found')
    if (sc.admin === false) return err(403, 'Resource not accessible by integration')
    const runnerJson = (r: FakeRunner) => ({ id: r.id, name: r.name, os: r.os, status: r.status, busy: !!r.busy, ephemeral: r.ephemeral ?? false, runner_group_id: r.group ?? (kind === 'org' ? 1 : undefined), labels: [{ id: 1, name: 'self-hosted', type: 'read-only' }, { id: 2, name: r.os, type: 'read-only' }, { id: 3, name: 'X64', type: 'read-only' }, ...(r.labels ?? []).map((l, i) => ({ id: 10 + i, name: l, type: 'custom' }))] })
    if (rest === '/actions/runners' && method === 'GET') return json(200, { total_count: sc.runners.length, runners: slice(sc.runners).map(runnerJson) })
    const one = /^\/actions\/runners\/(\d+)$/.exec(rest)
    if (one) {
      const r = sc.runners.find(x => x.id === Number(one[1]))
      if (!r) return err(404, 'Not Found')
      if (method === 'GET') return json(200, runnerJson(r))
      if (method === 'DELETE') { if (r.busy) return err(422, 'Runner is busy'); sc.runners = sc.runners.filter(x => x !== r); return { status: 204, headers: {}, body: null } }
    }
    if ((rest === '/actions/runners/registration-token' || rest === '/actions/runners/remove-token') && method === 'POST') {
      const token = 'A' + Math.random().toString(36).toUpperCase().replace(/[^A-Z0-9]/g, '').padEnd(28, 'X').slice(0, 28)
      this.tokens.push(token)
      return json(201, { token, expires_at: this.tokenExpiresAt ?? new Date(Date.now() + 3600_000).toISOString() })
    }
    if (rest === '/actions/runners/downloads') {
      if (this.downloads === 'forbidden') return err(403, 'Resource not accessible by integration')
      if (!this.downloads) return err(404, 'Not Found')
      return json(200, Object.entries(this.latest.checksums).map(([k, v]) => { const [os, arch] = k.split('-'); return { os, architecture: arch, filename: `actions-runner-${k}-${this.latest.version}.${os === 'win' ? 'zip' : 'tar.gz'}`, download_url: `https://github.com/actions/runner/releases/download/v${this.latest.version}/actions-runner-${k}-${this.latest.version}.${os === 'win' ? 'zip' : 'tar.gz'}`, sha256_checksum: v } }))
    }
    if (kind === 'org' && rest === '/actions/runner-groups') return json(200, { total_count: (sc.groups ?? []).length, runner_groups: (sc.groups ?? []).map(g => ({ id: g.id, name: g.name, default: !!g.default, visibility: g.visibility ?? 'all', allows_public_repositories: false })) })
    const gr = /^\/actions\/runner-groups\/(\d+)\/repositories$/.exec(rest)
    if (kind === 'org' && gr) return json(200, { total_count: 0, repositories: (sc.groups?.find(g => g.id === Number(gr[1]))?.repos ?? []).map(full => ({ full_name: full })) })
    return err(404, 'Not Found')
  }

  /** Registers a runner as the fake config step would have, so verification finds it. */
  addRunner(kind: 'repo' | 'org', key: string, r: Partial<FakeRunner> & { name: string }) { const sc = this.scope(kind, key)!; const full = { id: r.id ?? this.nextId++, os: 'Linux', status: 'online' as const, ...r }; sc.runners.push(full); return full }
}

export { GhError }
