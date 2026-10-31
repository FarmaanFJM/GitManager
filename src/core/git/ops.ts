import type { Branch, Commit, Comparison, Location, OpError, RemoteCheck, Result } from '../../shared/types.js'
import { gitSpec, run, type ExecResult } from '../exec.js'
import { gitError } from './errors.js'
import { isClean, parsePorcelainV2, planPull, type ParsedStatus } from './status.js'

export type GitRun = (loc: Location, args: string[], timeoutMs?: number) => Promise<ExecResult>
export const defaultGitRun: GitRun = (loc, args, timeoutMs) => run(gitSpec(loc, args), { timeoutMs })

const ok = <T>(value: T): Result<T> => ({ ok: true, value })
const fail = <T>(error: OpError): Result<T> => ({ ok: false, error })
const refuse = <T>(code: string, message: string): Result<T> => fail({ code, message })

const LOG_FORMAT = '--format=%H%x1f%h%x1f%an%x1f%at%x1f%s%x1e'
export function parseLog(out: string): Commit[] {
  return out.split('\x1e').map(r => r.replace(/^\s+/, '')).filter(Boolean).map(r => {
    const [hash, short, author, at, subject] = r.split('\x1f')
    return { hash, short, author, date: Number(at) * 1000, subject: subject ?? '' }
  })
}

const REF_FORMAT = '--format=%(refname)%1f%(HEAD)%1f%(upstream:short)%1f%(committerdate:unix)'
export function parseRefs(out: string, remotes: string[]): Branch[] {
  const rows = out.split('\n').filter(Boolean).map(l => l.split('\x1f'))
  const locals = rows.filter(r => r[0].startsWith('refs/heads/'))
  const upstreams = new Set(locals.map(r => r[2]).filter(Boolean))
  const out2: Branch[] = []
  for (const [ref, head, upstream, date] of rows) {
    if (ref.startsWith('refs/heads/')) out2.push({ name: ref.slice(11), kind: 'local', current: head === '*', upstream: upstream || undefined, date: Number(date) * 1000 })
    else if (ref.startsWith('refs/remotes/')) {
      const name = ref.slice(13)
      if (name.endsWith('/HEAD')) continue
      if (!remotes.some(r => name.startsWith(r + '/'))) continue
      out2.push({ name, kind: 'remote', current: false, tracked: upstreams.has(name), date: Number(date) * 1000 })
    }
  }
  return out2
}

/** Splits origin/feature/x into the remote and the branch, using the configured remote names (which may contain slashes). */
export function splitRemoteRef(ref: string, remotes: string[]): { remote: string; branch: string } | null {
  const remote = [...remotes].sort((a, b) => b.length - a.length).find(r => ref.startsWith(r + '/'))
  return remote ? { remote, branch: ref.slice(remote.length + 1) } : null
}

/** Rejects names that could be read as options or are not valid branch names, before Git ever sees them. */
export function isSafeBranchName(name: string): boolean {
  // eslint-disable-next-line no-control-regex
  const forbidden = /[\s~^:?*[\\\x00-\x1f\x7f]/
  return !!name && !name.startsWith('-') && !name.startsWith('/') && !forbidden.test(name) && !name.includes('..') && !name.includes('@{')
    && name !== '@' && !name.endsWith('/') && !name.endsWith('.lock') && !name.endsWith('.') && !name.includes('//')
}

/**
 * Git operations GitManager performs. Everything here is non-destructive by construction:
 * no reset, no force, no rebase, no stash, no branch deletion. When an operation cannot proceed safely it is refused
 * before Git runs, or Git itself refuses and leaves the repository unchanged.
 */
export class Git {
  constructor(private readonly git: GitRun = defaultGitRun) {}

  /** Runs a read-only Git command for callers that need facts GitManager's own operations do not expose (the deletion preview). */
  exec(loc: Location, args: string[], timeoutMs = 20_000): Promise<ExecResult> { return this.git(loc, args, timeoutMs) }

  async verifyRepo(loc: Location): Promise<Result<void>> {
    const r = await this.git(loc, ['rev-parse', '--is-inside-work-tree'], 20_000)
    if (r.code === 0 && r.stdout.trim() === 'true') return ok(undefined)
    return fail(gitError(r, 'This folder is not a Git repository.'))
  }

  async status(loc: Location): Promise<Result<ParsedStatus & { remotes: string[] }>> {
    const [s, rm] = await Promise.all([
      this.git(loc, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal'], 30_000),
      this.git(loc, ['remote'], 15_000),
    ])
    if (s.code !== 0) return fail(gitError(s, 'Could not read the repository status.'))
    return ok({ ...parsePorcelainV2(s.stdout), remotes: rm.code === 0 ? rm.stdout.split(/\r?\n/).map(x => x.trim()).filter(Boolean) : [] })
  }

  /** Lists the remote's branches without changing anything locally, which proves it is reachable with the user's credentials. */
  async checkRemote(loc: Location, remote: string): Promise<RemoteCheck> {
    const r = await this.git(loc, ['ls-remote', '--heads', '--', remote], 25_000)
    const at = new Date().toISOString()
    return r.code === 0 ? { remote, reachable: true, checkedAt: at } : { remote, reachable: false, error: gitError(r, 'The remote could not be reached.').message, checkedAt: at }
  }

  private async fetchTarget(loc: Location): Promise<Result<string[]>> {
    const s = await this.status(loc)
    if (!s.ok) return s
    const { remotes, upstream } = s.value
    if (!remotes.length) return refuse('NO_REMOTE', 'This repository has no remote to fetch from.')
    const fromUpstream = upstream ? splitRemoteRef(upstream, remotes)?.remote : undefined
    const target = fromUpstream ?? (remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : null)
    return ok(target ? [target] : ['--all'])
  }

  /** `git fetch` from the branch's remote (or origin). Only remote-tracking refs change; local branches and files do not. */
  async fetch(loc: Location): Promise<Result<{ remote: string }>> {
    const t = await this.fetchTarget(loc)
    if (!t.ok) return t
    const r = await this.git(loc, ['fetch', ...(t.value[0] === '--all' ? ['--all'] : ['--', t.value[0]])], 180_000)
    if (r.code !== 0) return fail(gitError(r, 'Fetch failed.'))
    return ok({ remote: t.value[0] === '--all' ? 'all remotes' : t.value[0] })
  }

  /**
   * Fetch, then fast-forward only. Refused before touching anything when the branch diverged, has no upstream, is detached
   * or has conflicts. `--no-autostash` guarantees uncommitted work is never stashed behind the user's back; if the
   * fast-forward would overwrite local changes, Git aborts and nothing changes.
   */
  async pull(loc: Location): Promise<Result<{ commits: number; from: string; to: string }>> {
    const f = await this.fetch(loc)
    if (!f.ok) return f
    const s = await this.status(loc)
    if (!s.ok) return s
    const plan = planPull(s.value)
    if (plan.action === 'refuse') return refuse(plan.code, plan.message)
    if (plan.action === 'none') return refuse(plan.reason === 'ahead' ? 'NOTHING_TO_PULL_AHEAD' : 'UP_TO_DATE',
      plan.reason === 'ahead' ? `${s.value.branch} has local commits and nothing new on ${s.value.upstream}.` : `${s.value.branch} is already up to date.`)
    const from = s.value.oid ?? ''
    const r = await this.git(loc, ['merge', '--ff-only', '--no-autostash', '--no-edit', s.value.upstream!], 120_000)
    if (r.code !== 0) return fail(gitError(r, 'The fast-forward did not complete. Nothing was changed.'))
    const after = await this.status(loc)
    return ok({ commits: plan.commits, from, to: after.ok ? after.value.oid ?? '' : '' })
  }

  async branches(loc: Location): Promise<Result<Branch[]>> {
    const [r, rm] = await Promise.all([this.git(loc, ['for-each-ref', REF_FORMAT, 'refs/heads', 'refs/remotes'], 20_000), this.git(loc, ['remote'], 15_000)])
    if (r.code !== 0) return fail(gitError(r, 'Could not list branches.'))
    return ok(parseRefs(r.stdout, rm.stdout.split(/\r?\n/).map(x => x.trim()).filter(Boolean)))
  }

  private async refExists(loc: Location, ref: string) {
    return (await this.git(loc, ['show-ref', '--verify', '--quiet', ref], 15_000)).code === 0
  }

  /**
   * Switches to an existing local branch. Uncommitted changes that do not conflict come along (standard Git behaviour);
   * if they would be overwritten Git refuses and nothing changes. Never uses --force or --discard-changes.
   */
  async switchBranch(loc: Location, name: string): Promise<Result<{ branch: string; carried: boolean }>> {
    if (!isSafeBranchName(name)) return refuse('BAD_NAME', `"${name}" is not a valid branch name.`)
    if (!(await this.refExists(loc, `refs/heads/${name}`))) return refuse('NO_BRANCH', `There is no local branch named ${name}.`)
    const s = await this.status(loc)
    if (!s.ok) return s
    if (s.value.changes.conflicted) return refuse('CONFLICTS', 'The repository has unresolved conflicts. Resolve them before switching branches.')
    if (s.value.branch === name) return ok({ branch: name, carried: false })
    const r = await this.git(loc, ['switch', '--no-guess', name], 60_000)
    if (r.code !== 0) return fail(gitError(r, `Could not switch to ${name}. Nothing was changed.`))
    return ok({ branch: name, carried: !isClean(s.value.changes) })
  }

  /** Creates a local branch that tracks an existing remote branch and switches to it. Refuses if the local name is taken. */
  async trackRemote(loc: Location, remoteRef: string): Promise<Result<{ branch: string }>> {
    const rm = await this.git(loc, ['remote'], 15_000)
    const parts = splitRemoteRef(remoteRef, rm.stdout.split(/\r?\n/).map(x => x.trim()).filter(Boolean))
    if (!parts || !isSafeBranchName(parts.branch)) return refuse('BAD_NAME', `"${remoteRef}" is not a remote branch.`)
    if (!(await this.refExists(loc, `refs/remotes/${remoteRef}`))) return refuse('NO_BRANCH', `${remoteRef} does not exist. Fetch first.`)
    if (await this.refExists(loc, `refs/heads/${parts.branch}`)) return refuse('EXISTS', `A local branch named ${parts.branch} already exists. Switch to it instead.`)
    const s = await this.status(loc)
    if (s.ok && s.value.changes.conflicted) return refuse('CONFLICTS', 'The repository has unresolved conflicts. Resolve them before switching branches.')
    const r = await this.git(loc, ['switch', '--no-guess', '--track', '-c', parts.branch, remoteRef], 60_000)
    if (r.code !== 0) return fail(gitError(r, `Could not create ${parts.branch}. Nothing was changed.`))
    return ok({ branch: parts.branch })
  }

  async log(loc: Location, limit = 30): Promise<Result<Commit[]>> {
    const r = await this.git(loc, ['log', `-n${limit}`, LOG_FORMAT, 'HEAD', '--'], 20_000)
    if (r.code !== 0) {
      if (/does not have any commits|unknown revision|bad default revision|bad revision 'HEAD'/i.test(r.stderr)) return ok([])
      return fail(gitError(r, 'Could not read the history.'))
    }
    return ok(parseLog(r.stdout))
  }

  /** Commits on the upstream that are not local (incoming) and the reverse (outgoing), from the last fetch. */
  async compare(loc: Location, limit = 50): Promise<Result<Comparison>> {
    const s = await this.status(loc)
    if (!s.ok) return s
    if (!s.value.upstream || s.value.upstreamMissing || !s.value.branch) return ok({ upstream: s.value.upstream, incoming: [], outgoing: [] })
    const [inc, outg] = await Promise.all([
      this.git(loc, ['log', `-n${limit}`, LOG_FORMAT, 'HEAD..@{upstream}', '--'], 20_000),
      this.git(loc, ['log', `-n${limit}`, LOG_FORMAT, '@{upstream}..HEAD', '--'], 20_000),
    ])
    if (inc.code !== 0) return fail(gitError(inc, 'Could not compare with the upstream branch.'))
    return ok({ upstream: s.value.upstream, incoming: parseLog(inc.stdout), outgoing: outg.code === 0 ? parseLog(outg.stdout) : [] })
  }
}
