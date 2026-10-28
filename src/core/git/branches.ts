import type { BranchBase, BranchDetail, BranchOverview, BranchRow, ChangedFile, Location, Result } from '../../shared/types.js'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { GIT_ENV, programSpec, run, type ExecSpec } from '../exec.js'
import { flavorOf } from '../paths.js'
import { gitError } from './errors.js'
import { defaultGitRun, parseLog, type GitRun } from './ops.js'

// Branch overview: every local and remote-tracking branch compared with the repository's default branch.
// Everything here is read-only: for-each-ref, rev-list, merge-base, log, diff and ls-remote. Nothing is checked out,
// fetched, written or switched, and refs/remotes/<remote>/HEAD is read but never set.

const ok = <T>(value: T): Result<T> => ({ ok: true, value })
const fail = <T>(code: string, message: string, detail?: string): Result<T> => ({ ok: false, error: { code, message, ...(detail ? { detail } : {}) } })

const FIELDS = ['%(refname)', '%(objectname)', '%(HEAD)', '%(upstream)', '%(upstream:track)', '%(committerdate:unix)', '%(authorname)', '%(subject)']

type RawRef = { ref: string; oid: string; head: boolean; upstream: string; track: string; date: number; author: string; subject: string; ab?: string }

export function parseRefLines(out: string, withAb: boolean): RawRef[] {
  return out.split('\n').filter(Boolean).map(line => {
    const f = line.split('\x1f')
    return { ref: f[0], oid: f[1], head: f[2] === '*', upstream: f[3], track: f[4], date: Number(f[5]) * 1000, author: f[6], subject: f[7] ?? '', ...(withAb ? { ab: f[8] } : {}) }
  })
}

/** `[ahead 2, behind 1]`, `[gone]` or empty (in sync, or no upstream). */
export function parseTrack(upstream: string, track: string): Pick<BranchRow, 'upstreamState' | 'upstreamAhead' | 'upstreamBehind'> {
  if (!upstream) return { upstreamState: 'none', upstreamAhead: 0, upstreamBehind: 0 }
  if (/gone/.test(track)) return { upstreamState: 'gone', upstreamAhead: 0, upstreamBehind: 0 }
  const a = Number(/ahead (\d+)/.exec(track)?.[1] ?? 0), b = Number(/behind (\d+)/.exec(track)?.[1] ?? 0)
  return { upstreamState: a && b ? 'diverged' : a ? 'ahead' : b ? 'behind' : 'in-sync', upstreamAhead: a, upstreamBehind: b }
}

/** Parses `git ls-remote --symref <remote> HEAD`: `ref: refs/heads/dev\tHEAD`. */
export function parseSymref(out: string): string | null {
  const m = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m.exec(out)
  return m ? m[1] : null
}

export function compareState(ahead: number | null, behind: number | null, related: boolean): BranchRow['compare'] {
  if (ahead === null || behind === null) return 'unknown'
  if (!related) return 'unrelated'
  if (ahead && behind) return 'diverged'
  if (ahead) return 'ahead'
  if (behind) return 'behind'
  return 'up-to-date'
}

/** A shell loop run inside WSL with the refs as positional arguments (never interpolated), so many comparisons cost one wsl.exe start. */
function wslBatchSpec(loc: Extract<Location, { kind: 'wsl' }>, script: string, args: string[]): ExecSpec {
  const env = Object.entries(GIT_ENV).map(([k, v]) => `${k}=${v}`)
  return { file: 'wsl.exe', args: ['-d', loc.distro, '--cd', loc.path, '--exec', 'env', ...env, 'sh', '-c', script, 'sh', ...args] }
}

async function limit<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]) } }))
  return out
}

/** related: null until a merge-base check ran (only needed when a ref is both ahead and behind). */
type Counts = { ahead: number; behind: number; related: boolean | null }

export class BranchInspector {
  /** Per repository: counts by `<baseOid>:<refOid>`, so unchanged refs are never recomputed. Cleared on fetch, pull and switch. */
  private cache = new Map<string, Map<string, Counts>>()
  /** Default branch advertised by the remote (ls-remote), remembered until the next fetch. */
  private advertised = new Map<string, string | null>()

  constructor(private readonly git: GitRun = defaultGitRun, private readonly runner = run) {}

  invalidate(repoKey: string) { this.cache.delete(repoKey); this.advertised.delete(repoKey) }

  private async lines(loc: Location, args: string[], t = 20_000) {
    const r = await this.git(loc, args, t)
    return r.code === 0 ? r.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean) : []
  }

  /**
   * The comparison base, from reliable metadata only:
   * 1. a base the user chose for this repository,
   * 2. refs/remotes/<remote>/HEAD (recorded when the repository was cloned),
   * 3. the remote's advertised HEAD (`git ls-remote --symref`, read-only, needs the network).
   * The remote is the current branch's upstream remote, else origin, else the only remote. Nothing is guessed:
   * when none of these works the result is null with a reason, and the user picks a base.
   */
  async resolveBase(repoKey: string, loc: Location, opts: { chosen?: string | null; network?: boolean } = {}): Promise<{ base: BranchBase | null; problem: string | null; remotes: string[] }> {
    const remotes = await this.lines(loc, ['remote'])
    const verify = async (ref: string) => {
      const r = await this.git(loc, ['rev-parse', '-q', '--verify', `${ref}^{commit}`], 15_000)
      return r.code === 0 ? r.stdout.trim() : null
    }
    if (opts.chosen) {
      const full = opts.chosen.startsWith('refs/') ? opts.chosen : (await verify(`refs/heads/${opts.chosen}`)) ? `refs/heads/${opts.chosen}` : `refs/remotes/${opts.chosen}`
      const oid = await verify(full)
      if (oid) return { base: { ref: full, name: shortName(full), source: 'user', remote: null, oid }, problem: null, remotes }
      return { base: null, problem: `The comparison base you chose (${opts.chosen}) no longer exists. Choose another.`, remotes }
    }
    if (!remotes.length) return { base: null, problem: 'This repository has no remote, so it has no default branch to detect. Choose a comparison base.', remotes }
    const up = (await this.git(loc, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], 10_000)).stdout.trim()
    const remote = remotes.find(r => up.startsWith(r + '/')) ?? (remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : null)
    if (!remote) return { base: null, problem: `This repository has several remotes (${remotes.join(', ')}) and none is origin. Choose a comparison base.`, remotes }

    const sym = await this.git(loc, ['symbolic-ref', '-q', `refs/remotes/${remote}/HEAD`], 10_000)
    if (sym.code === 0 && sym.stdout.trim().startsWith(`refs/remotes/${remote}/`)) {
      const ref = sym.stdout.trim()
      const oid = await verify(ref)
      if (oid) return { base: { ref, name: shortName(ref), source: 'remote-head', remote, oid }, problem: null, remotes }
    }
    if (opts.network !== false) {
      let branch = this.advertised.get(repoKey)
      if (branch === undefined) {
        const r = await this.git(loc, ['ls-remote', '--symref', '--', remote, 'HEAD'], 20_000)
        branch = r.code === 0 ? parseSymref(r.stdout) : null
        this.advertised.set(repoKey, branch)
      }
      if (branch) {
        const ref = `refs/remotes/${remote}/${branch}`
        const oid = await verify(ref)
        if (oid) return { base: { ref, name: shortName(ref), source: 'ls-remote', remote, oid }, problem: null, remotes }
        return { base: null, problem: `${remote} says its default branch is ${branch}, but ${remote}/${branch} has not been fetched yet. Fetch, or choose a comparison base.`, remotes }
      }
    }
    return { base: null, problem: `The default branch of ${remote} could not be determined. Choose a comparison base.`, remotes }
  }

  private async counts(repoKey: string, loc: Location, base: BranchBase, refs: RawRef[]): Promise<Map<string, Counts>> {
    const cache = this.cache.get(repoKey) ?? new Map<string, Counts>()
    this.cache.set(repoKey, cache)
    const key = (r: RawRef) => `${base.oid}:${r.oid}`
    const todo = refs.filter(r => !cache.has(key(r)) && r.oid !== base.oid)
    for (const r of refs) if (r.oid === base.oid) cache.set(key(r), { ahead: 0, behind: 0, related: true })

    // Git 2.41+ computes every ahead/behind pair in the for-each-ref call itself (see overview()).
    const pending: RawRef[] = []
    for (const r of todo) {
      const m = r.ab ? /^(\d+) (\d+)$/.exec(r.ab.trim()) : null
      if (m) cache.set(key(r), { ahead: Number(m[1]), behind: Number(m[2]), related: null })
      else pending.push(r)
    }
    // Older Git: `git rev-list --left-right --count <base>...<ref>` (left = only on the base = behind, right = ahead).
    if (pending.length) {
      if (loc.kind === 'wsl') {
        const script = 'b=$1; shift; for r; do printf "%s\\t" "$r"; git rev-list --left-right --count "$b...$r" 2>/dev/null || echo; done'
        const r = await this.runner(wslBatchSpec(loc, script, [base.oid, ...pending.map(p => p.oid)]), { timeoutMs: 120_000 })
        for (const line of r.stdout.split('\n')) {
          const [oid, counts] = line.split('\t'); const m = /^(\d+)\s+(\d+)$/.exec((counts ?? '').trim())
          if (m) for (const p of pending.filter(x => x.oid === oid)) cache.set(key(p), { behind: Number(m[1]), ahead: Number(m[2]), related: null })
        }
      } else {
        await limit(pending, 6, async p => {
          const r = await this.git(loc, ['rev-list', '--left-right', '--count', `${base.oid}...${p.oid}`], 30_000)
          const m = /^(\d+)\s+(\d+)$/.exec(r.stdout.trim())
          if (m) cache.set(key(p), { behind: Number(m[1]), ahead: Number(m[2]), related: null })
        })
      }
    }
    // Unrelated histories look like "diverged" to the counts. Only refs that are both ahead and behind need a merge-base check.
    for (const r of todo) { const c = cache.get(key(r)); if (c && c.related === null && !(c.ahead > 0 && c.behind > 0)) c.related = true }
    const both = todo.filter(r => { const c = cache.get(key(r)); return c && c.related === null })
    if (both.length) {
      if (loc.kind === 'wsl') {
        const script = 'b=$1; shift; for r; do if git merge-base "$b" "$r" >/dev/null 2>&1; then echo "$r 1"; else echo "$r 0"; fi; done'
        const r = await this.runner(wslBatchSpec(loc, script, [base.oid, ...both.map(p => p.oid)]), { timeoutMs: 120_000 })
        for (const line of r.stdout.split('\n')) { const [oid, rel] = line.trim().split(' '); for (const p of both.filter(x => x.oid === oid)) cache.set(key(p), { ...cache.get(key(p))!, related: rel === '1' }) }
      } else {
        await limit(both, 6, async p => {
          const r = await this.git(loc, ['merge-base', base.oid, p.oid], 30_000)
          cache.set(key(p), { ...cache.get(key(p))!, related: r.code === 0 })
        })
      }
    }
    return cache
  }

  async overview(repoKey: string, loc: Location, opts: { chosen?: string | null; network?: boolean } = {}): Promise<Result<BranchOverview>> {
    const { base, problem, remotes } = await this.resolveBase(repoKey, loc, opts)
    const withAb = !!base
    const format = `--format=${[...FIELDS, ...(base ? [`%(ahead-behind:${base.oid})`] : [])].join('%1f')}`
    let r = await this.git(loc, ['for-each-ref', format, 'refs/heads', 'refs/remotes'], 30_000)
    let abSupported = withAb
    if (r.code !== 0 && withAb) { // Git before 2.41 does not know %(ahead-behind)
      abSupported = false
      r = await this.git(loc, ['for-each-ref', `--format=${FIELDS.join('%1f')}`, 'refs/heads', 'refs/remotes'], 30_000)
    }
    if (r.code !== 0) return { ok: false, error: gitError(r, 'Could not list branches.') }
    const raw = parseRefLines(r.stdout, abSupported).filter(x => !x.ref.endsWith('/HEAD'))
    const counts = base ? await this.counts(repoKey, loc, base, raw) : null
    const [head, lastFetch] = await Promise.all([this.git(loc, ['rev-parse', '--short', 'HEAD'], 10_000), this.lastFetch(loc)])
    const branches: BranchRow[] = raw.map(x => {
      const local = x.ref.startsWith('refs/heads/')
      const name = shortName(x.ref)
      const c = counts?.get(`${base!.oid}:${x.oid}`)
      const isBase = !!base && x.ref === base.ref
      return {
        ref: x.ref, name, kind: local ? 'local' : 'remote', remote: local ? undefined : remotes.find(rm => name.startsWith(rm + '/')),
        oid: x.oid, short: x.oid.slice(0, 7), current: x.head, isBase,
        upstream: x.upstream ? shortName(x.upstream) : undefined, ...(local ? parseTrack(x.upstream, x.track) : { upstreamState: 'none' as const, upstreamAhead: 0, upstreamBehind: 0 }),
        ahead: c ? c.ahead : null, behind: c ? c.behind : null,
        compare: isBase ? 'base' : c ? compareState(c.ahead, c.behind, c.related !== false) : 'unknown',
        date: x.date, subject: x.subject, author: x.author,
      }
    })
    return ok({
      base, baseProblem: problem, remotes, branches, lastFetch,
      detached: head.code === 0 && !raw.some(x => x.head), head: head.code === 0 ? head.stdout.trim() : null,
    })
  }

  /** When a fetch last updated the remote-tracking refs (mtime of FETCH_HEAD), or null if this clone was never fetched. */
  async lastFetch(loc: Location): Promise<number | null> {
    const r = await this.git(loc, ['rev-parse', '--git-path', 'FETCH_HEAD'], 10_000)
    if (r.code !== 0) return null
    const p = r.stdout.trim()
    if (loc.kind === 'wsl') {
      const s = await this.runner(programSpec({ kind: 'wsl', distro: loc.distro }, 'stat', ['-c', '%Y', '--', p], loc.path), { timeoutMs: 10_000 })
      return s.code === 0 && /^\d+$/.test(s.stdout.trim()) ? Number(s.stdout.trim()) * 1000 : null
    }
    const lib = flavorOf(loc.path) === 'win32' ? path.win32 : path.posix
    try { return (await stat(lib.isAbsolute(p) ? p : lib.join(loc.path, p))).mtimeMs } catch { return null }
  }

  /** One branch against the base: unique commits each way and the files changed since their merge base. Read-only. */
  async detail(loc: Location, baseRef: string, ref: string): Promise<Result<BranchDetail>> {
    if (!/^refs\/(heads|remotes)\/[^\s~^:?*[\\]+$/.test(ref) || !/^refs\/(heads|remotes)\/[^\s~^:?*[\\]+$/.test(baseRef) || ref.includes('..') || baseRef.includes('..')) return fail('BAD_REF', 'That is not a branch reference.')
    const exists = await this.git(loc, ['rev-parse', '-q', '--verify', `${ref}^{commit}`], 10_000)
    if (exists.code !== 0) return fail('NO_REF', `${shortName(ref)} no longer exists. Refresh the list.`)
    const baseOk = await this.git(loc, ['rev-parse', '-q', '--verify', `${baseRef}^{commit}`], 10_000)
    if (baseOk.code !== 0) return fail('NO_REF', `${shortName(baseRef)} no longer exists. Refresh the list.`)
    const LOG = '--format=%H%x1f%h%x1f%an%x1f%at%x1f%s%x1e'
    const [mb, only, missing, latest] = await Promise.all([
      this.git(loc, ['merge-base', baseRef, ref], 20_000),
      this.git(loc, ['log', '-n100', LOG, `${baseRef}..${ref}`, '--'], 20_000),
      this.git(loc, ['log', '-n100', LOG, `${ref}..${baseRef}`, '--'], 20_000),
      this.git(loc, ['log', '-n1', LOG, ref, '--'], 10_000),
    ])
    let files: ChangedFile[] = []
    let stat = ''
    if (mb.code === 0) {
      const [d, s] = await Promise.all([
        this.git(loc, ['diff', '--name-status', '-M', '-z', `${baseRef}...${ref}`, '--'], 30_000),
        this.git(loc, ['diff', '--shortstat', `${baseRef}...${ref}`, '--'], 30_000),
      ])
      files = parseNameStatus(d.stdout)
      stat = s.stdout.trim()
    }
    return ok({
      ref, name: shortName(ref), baseRef, baseName: shortName(baseRef), mergeBase: mb.code === 0 ? mb.stdout.trim() : null,
      unique: parseLog(only.stdout), missing: parseLog(missing.stdout), latest: parseLog(latest.stdout)[0] ?? null,
      files: files.slice(0, 300), filesTotal: files.length, stat,
    })
  }
}

export function shortName(ref: string) { return ref.replace(/^refs\/(heads|remotes)\//, '') }

/** `git diff --name-status -z`: status, path (and the old path first for renames and copies). */
export function parseNameStatus(out: string): ChangedFile[] {
  const f = out.split('\0').filter((x, i, a) => x !== '' || i < a.length - 1)
  const files: ChangedFile[] = []
  for (let i = 0; i < f.length; i++) {
    const st = f[i]
    if (!st) continue
    const kind = st[0] as ChangedFile['status']
    if (kind === 'R' || kind === 'C') { files.push({ status: kind, from: f[i + 1], path: f[i + 2] }); i += 2 }
    else { files.push({ status: kind, path: f[i + 1] }); i += 1 }
  }
  return files
}
