// Live process and port discovery. Adapters (per context) report raw processes; the inspector adds ownership
// (GitManager vs external) and repository association, caches briefly, and isolates failures per context.
// Association is only ever by working directory / executable / command path prefix against registered repository
// locations (worktrees and WSL path namespaces included), longest prefix wins. Never by port number.
import type { Location } from '../../shared/types.js'
import type { PortBinding, PortConflict, ProcContext, ProcError, ProcInfo, ProcsSnapshot } from '../../shared/procs.js'
import { locationKey } from '../paths.js'
import { contextKey, procKey, type ProcAdapter, type RawProcess } from './model.js'

/* ------------------------------------------------------------ repositories */

export interface RepoIndex {
  /** The repository whose folder contains `path` (a path in the syntax of `context`), longest match first. */
  findRepoByPath(context: ProcContext, path: string): { repoId: string } | null
}

export type IndexedRepo = { id: string; location: Location; /** Other folders that belong to the repository (worktrees, profile worktree paths). */ extra?: Location[] }

/** Builds a RepoIndex from registered repositories using paths.ts identities (one namespace-aware key per folder). */
export function buildRepoIndex(repos: IndexedRepo[]): RepoIndex {
  const roots: { key: string; sep: string; id: string }[] = []
  for (const r of repos) for (const loc of [r.location, ...(r.extra ?? [])]) {
    const key = locationKey(loc)
    if (key === 'posix:/' || /^win:[a-z]:\\?$/.test(key)) continue // a filesystem root would claim everything
    roots.push({ key, sep: key.startsWith('win:') ? '\\' : '/', id: r.id })
  }
  roots.sort((a, b) => b.key.length - a.key.length)
  return {
    findRepoByPath(context, path) {
      const p = path.trim().replace(/^\\\\\?\\/, '')
      if (!p) return null
      let key: string
      try { key = locationKey(context.kind === 'wsl' ? { kind: 'wsl', distro: context.distro, path: p } : { kind: 'native', path: p }) } catch { return null }
      for (const r of roots) if (key === r.key || key.startsWith(r.key + r.sep)) return { repoId: r.id }
      return null
    },
  }
}

/** Absolute path-looking tokens in a command line (quoted or not, also after `=` as in -Dx=/path). */
export function pathCandidates(command: string): string[] {
  const out = new Set<string>()
  const consider = (s: string) => {
    const t = s.trim().replace(/^["']|["']$/g, '')
    if (/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(t)) out.add(t.replace(/[;,]+$/, ''))
  }
  for (const m of command.matchAll(/"([^"]*)"|'([^']*)'/g)) { const q = m[1] ?? m[2]; consider(q); const eq = q.indexOf('='); if (eq > 0) consider(q.slice(eq + 1)) }
  for (const tok of command.replace(/"[^"]*"|'[^']*'/g, ' ').split(/\s+/)) { consider(tok); const eq = tok.indexOf('='); if (eq > 0) consider(tok.slice(eq + 1)) }
  return [...out]
}

/* ------------------------------------------------------------ ownership */

export type ManagedProc = { serviceKey: string; repoId: string; launchEnv?: Record<string, string> }

export interface OwnershipSource {
  /**
   * Processes GitManager started, keyed by procKey(context, pid). For a native service the pid is the child's pid.
   * For a WSL service register the pid INSIDE the distribution (the process-group leader the start script prints),
   * with that distribution as context. Descendants (npm -> node -> java) are recognized through their parent chain.
   */
  managedPids(): Map<string, ManagedProc>
}

/* ------------------------------------------------------------ inspector */

export type InspectorDeps = {
  adapters: ProcAdapter[]
  repos: RepoIndex
  ownership?: OwnershipSource
  ttlMs?: number
  now?: () => number
  /** GitManager's own pid in the native context (never offered for stopping). */
  selfPid?: number
}

export type ScanOptions = { contexts?: ProcContext[]; includeAll?: boolean; /** Accept cached data up to this age (default: ttl). 0 forces a fresh scan. */ maxAgeMs?: number }
export type ConflictQuery = { ports: (number | { port: number; protocol?: 'tcp' | 'udp' })[]; contexts?: ProcContext[]; ignoreServiceKeys?: string[]; maxAgeMs?: number }

type Cached = { at: number; procs?: RawProcess[]; error?: string }

const WIN_PROTECTED = new Set(['system', 'system idle process', 'registry', 'smss.exe', 'csrss.exe', 'wininit.exe', 'services.exe', 'lsass.exe', 'winlogon.exe', 'memory compression', 'secure system'])

export class ProcessInspector {
  private readonly cache = new Map<string, Cached>()
  private readonly inflight = new Map<string, Promise<Cached>>()
  private readonly ttl: number
  private readonly now: () => number
  constructor(private readonly deps: InspectorDeps) {
    this.ttl = deps.ttlMs ?? 2000
    this.now = deps.now ?? Date.now
  }

  get contexts(): ProcContext[] { return this.deps.adapters.map(a => a.context) }
  adapterFor(context: ProcContext): ProcAdapter | undefined { return this.deps.adapters.find(a => contextKey(a.context) === contextKey(context)) }

  /** Drops cached scans so the next call looks at the system again (after a stop or a start). */
  invalidate() { this.cache.clear() }

  private load(adapter: ProcAdapter, maxAge: number): Promise<Cached> {
    const key = contextKey(adapter.context)
    const hit = this.cache.get(key)
    if (hit && this.now() - hit.at < maxAge) return Promise.resolve(hit)
    const running = this.inflight.get(key)
    if (running) return running
    const p = adapter.scan().then<Cached, Cached>(
      procs => ({ at: this.now(), procs }),
      (e: unknown) => ({ at: this.now(), error: e instanceof Error ? e.message : String(e) }),
    ).then(c => { this.cache.set(key, c); this.inflight.delete(key); return c })
    this.inflight.set(key, p)
    return p
  }

  async scan(opts: ScanOptions = {}): Promise<ProcsSnapshot> {
    const wanted = opts.contexts?.map(contextKey)
    const adapters = this.deps.adapters.filter(a => !wanted || wanted.includes(contextKey(a.context)))
    const maxAge = opts.maxAgeMs ?? this.ttl
    const results = await Promise.all(adapters.map(async a => ({ a, c: await this.load(a, maxAge) })))
    const processes: ProcInfo[] = []
    const errors: ProcError[] = []
    for (const { a, c } of results) {
      if (c.error !== undefined || !c.procs) { errors.push({ context: a.context, message: c.error ?? 'No data.' }); continue }
      processes.push(...this.classify(a, c.procs, !!opts.includeAll))
    }
    processes.sort((x, y) => Number(y.owner === 'gitmanager') - Number(x.owner === 'gitmanager') || Number(y.ports.length > 0) - Number(x.ports.length > 0) || x.name.localeCompare(y.name) || x.pid - y.pid)
    return { processes, scannedAt: new Date(this.now()).toISOString(), errors }
  }

  private classify(adapter: ProcAdapter, raws: RawProcess[], includeAll: boolean): ProcInfo[] {
    const ctx = adapter.context
    const byPid = new Map(raws.map(r => [r.pid, r]))
    const managed = this.deps.ownership?.managedPids() ?? new Map()
    const selfPid = ctx.kind === 'native' ? this.deps.selfPid ?? process.pid : undefined
    const walk = <T>(r: RawProcess, hit: (pid: number) => T | undefined): T | undefined => {
      let cur: RawProcess | undefined = r
      for (let depth = 0; cur && depth < 64; depth++) {
        const h = hit(cur.pid)
        if (h !== undefined) return h
        cur = cur.ppid !== undefined && cur.ppid !== cur.pid ? byPid.get(cur.ppid) : undefined
      }
      return undefined
    }
    const out: ProcInfo[] = []
    for (const r of raws) {
      const m: ManagedProc | undefined = walk(r, pid => managed.get(procKey(ctx, pid)))
      // GitManager itself, or one of its Chromium helper processes (--type=renderer, gpu-process, ...). Other children are not ours by default.
      const isSelf = selfPid !== undefined && (r.pid === selfPid || (/\s--type=\w/.test(r.command ?? '') && walk(r, pid => (pid === selfPid ? true : undefined)) === true))
      let repoId: string | undefined, repoMatch: ProcInfo['repoMatch']
      if (m) { repoId = m.repoId; repoMatch = 'service' }
      else {
        const byCwd = r.cwd ? this.deps.repos.findRepoByPath(ctx, r.cwd) : null
        if (byCwd) { repoId = byCwd.repoId; repoMatch = 'cwd' }
        else {
          let best: { repoId: string } | null = null
          for (const c of [...(r.exe ? [r.exe] : []), ...(r.command ? pathCandidates(r.command) : [])]) { const f = this.deps.repos.findRepoByPath(ctx, c); if (f) { best = f; break } }
          if (best) { repoId = best.repoId; repoMatch = 'command' }
        }
      }
      const listening = r.ports.length > 0
      const relevant = listening || !!m || repoMatch === 'cwd' || (repoMatch === 'command' && r.cwd === undefined)
      if (!relevant && !includeAll) continue
      const deny = this.stopDenied(adapter, r, isSelf)
      out.push({
        key: procKey(ctx, r.pid), context: ctx, pid: r.pid, ppid: r.ppid, name: r.name, command: r.command, exe: r.exe, cwd: r.cwd, user: r.user,
        startedAt: r.startedAt, state: r.state, ports: r.ports as PortBinding[], owner: m ? 'gitmanager' : 'external',
        serviceKey: m?.serviceKey, repoId, repoMatch, canStop: !deny, stopDeniedReason: deny,
      })
    }
    return out
  }

  private stopDenied(adapter: ProcAdapter, r: RawProcess, isSelf: boolean): string | undefined {
    if (isSelf) return 'This is GitManager itself.'
    if (adapter.os === 'windows') {
      if (r.pid <= 4 || WIN_PROTECTED.has(r.name.toLowerCase())) return 'This is a Windows system process.'
    } else {
      if (r.pid === 1) return 'This is the init process of the environment.'
      if (r.command === null && (r.pid === 2 || r.ppid === 2 || r.ppid === 0)) return 'This is a kernel process.'
    }
    return undefined
  }

  /** Every process listening on `port` (TCP by default), in all contexts. */
  async portOwner(port: number, opts: { protocol?: 'tcp' | 'udp'; contexts?: ProcContext[]; maxAgeMs?: number } = {}): Promise<ProcInfo[]> {
    const snap = await this.scan({ contexts: opts.contexts, maxAgeMs: opts.maxAgeMs })
    return snap.processes.filter(p => p.ports.some(b => b.port === port && b.protocol.startsWith(opts.protocol ?? 'tcp')))
  }

  /** Who occupies each expected port, and whether GitManager started it. A service's own process can be ignored (restart). */
  async conflictsFor(q: ConflictQuery): Promise<{ conflicts: PortConflict[]; errors: ProcError[] }> {
    const snap = await this.scan({ contexts: q.contexts, maxAgeMs: q.maxAgeMs })
    const ignore = new Set(q.ignoreServiceKeys ?? [])
    const conflicts: PortConflict[] = []
    for (const want of q.ports) {
      const port = typeof want === 'number' ? want : want.port
      const proto = typeof want === 'number' ? 'tcp' : want.protocol ?? 'tcp'
      for (const p of snap.processes) {
        if (p.serviceKey && ignore.has(p.serviceKey)) continue
        const b = p.ports.find(x => x.port === port && x.protocol.startsWith(proto))
        if (b) conflicts.push({ port, protocol: b.protocol, address: b.address, process: p, managed: p.owner === 'gitmanager', serviceKey: p.serviceKey })
      }
    }
    return { conflicts, errors: snap.errors }
  }
}
