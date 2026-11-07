import type { Location, OpError, Result } from '../../shared/types.js'
import type { StaleBranch, SyncCommit, SyncDeleted, SyncFailure, SyncPlan, SyncResult, SyncSelection } from '../../shared/gitflow.js'
import { locationKey } from '../paths.js'
import { BranchInspector } from './branches.js'
import { gitError } from './errors.js'
import { Git, defaultGitRun, isSafeBranchName, parseLog, type GitRun } from './ops.js'
import { isClean } from './status.js'
import { parseWorktrees } from './worktrees.js'

// Sync with Remote: clean up local branches whose remote branch is gone and return to an orderly relationship with the
// default branch. It is built from the described intent of the owner's PowerShell script (git-clean-branches.ps1),
// which could not be located; it does NOT replicate that script line by line.
//
// What it does: `git fetch --prune` (remote-tracking refs only), classifies local branches whose upstream is gone, and
// deletes only the ones the user selected after re-verifying each one. What it never does: pull, merge, hard reset,
// force push, stash, touch the working tree, or delete a branch with commits the default branch lacks unless that
// single branch was explicitly forced. Fetch, Pull and Sync stay distinct operations.
//
// Deleting a branch whose commits are all contained in a remote ref loses nothing, so `git branch -d` is tried first;
// because the upstream is gone, Git then compares with HEAD and may call a branch merged on the remote "not fully
// merged". That fallback to -D is taken only after this module itself verified containment in a remote ref.

const ok = <T>(value: T): Result<T> => ({ ok: true, value })
const fail = <T>(error: OpError): Result<T> => ({ ok: false, error })
const refuse = <T>(code: string, message: string, detail?: string): Result<T> => fail({ code, message, ...(detail ? { detail } : {}) })

export const DEFAULT_PROTECTED = ['main', 'master', 'develop', 'development', 'trunk', 'release/*']

function matchesAny(name: string, patterns: string[]) {
  return patterns.some(p => new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(name))
}

type LocalRef = { name: string; sha: string; upstream: string; track: string; head: boolean }
const REF_FIELDS = '--format=%(refname)%1f%(objectname)%1f%(upstream)%1f%(upstream:track)%1f%(HEAD)'

function parseLocals(out: string): LocalRef[] {
  return out.split('\n').filter(Boolean).map(l => l.split('\x1f')).filter(f => f[0]?.startsWith('refs/heads/'))
    .map(f => ({ name: f[0].slice(11), sha: f[1], upstream: f[2] ?? '', track: f[3] ?? '', head: f[4] === '*' }))
}

export type SyncOptions = { protectedBranches?: string[] }

export class SyncService {
  private readonly ops: Git
  private readonly inspector: BranchInspector

  constructor(private readonly git: GitRun = defaultGitRun, inspector?: BranchInspector, private readonly defaults: SyncOptions = {}) {
    this.ops = new Git(git)
    this.inspector = inspector ?? new BranchInspector(git)
  }

  private async out(loc: Location, args: string[], t = 20_000) {
    const r = await this.git(loc, args, t)
    return r.code === 0 ? r.stdout : null
  }

  private async worktrees(loc: Location) {
    const r = await this.out(loc, ['worktree', 'list', '--porcelain', '-z'])
    const top = (await this.out(loc, ['rev-parse', '--show-toplevel']))?.trim()
    const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    const map = new Map<string, { path: string; current: boolean }>()
    for (const w of r ? parseWorktrees(r) : []) if (w.branch) map.set(w.branch, { path: w.path, current: !!top && norm(top) === norm(w.path) })
    return map
  }

  private async remoteRefs(loc: Location, remote: string): Promise<Set<string>> {
    const o = await this.out(loc, ['for-each-ref', '--format=%(refname)', `refs/remotes/${remote}/`])
    return new Set((o ?? '').split('\n').map(s => s.trim()).filter(s => s && !s.endsWith('/HEAD')).map(s => s.slice(13)))
  }

  /** Is every commit of `sha` contained in the base or in any other remote-tracking ref? Returns where, or null. */
  private async containedIn(loc: Location, sha: string, baseRef: string): Promise<string | null> {
    if ((await this.git(loc, ['merge-base', '--is-ancestor', sha, baseRef], 20_000)).code === 0) return baseRef.replace(/^refs\/remotes\//, '')
    const o = await this.out(loc, ['for-each-ref', '--contains', sha, '--format=%(refname)', 'refs/remotes'])
    const hit = (o ?? '').split('\n').map(s => s.trim()).find(s => s && !s.endsWith('/HEAD'))
    return hit ? hit.replace(/^refs\/remotes\//, '') : null
  }

  private async uniqueCommits(loc: Location, sha: string, baseRef: string): Promise<{ ahead: number; commits: SyncCommit[] }> {
    const [n, l] = await Promise.all([
      this.out(loc, ['rev-list', '--count', sha, '--not', baseRef]),
      this.out(loc, ['log', '-n20', '--format=%H%x1f%h%x1f%an%x1f%at%x1f%s%x1e', sha, '--not', baseRef, '--']),
    ])
    return { ahead: Number(n?.trim()) || 0, commits: parseLog(l ?? '').map(c => ({ hash: c.hash, short: c.short, subject: c.subject })) }
  }

  /**
   * Fetches with --prune, then classifies. Changes only remote-tracking refs. Error codes: NOT_A_REPO, EMPTY_REPO,
   * NO_REMOTE, AMBIGUOUS_REMOTE (several remotes, none is origin or the upstream's), FETCH_FAILED / NETWORK / AUTH /
   * REMOTE_NOT_FOUND (nothing was changed), NO_DEFAULT_BRANCH.
   */
  async plan(loc: Location, opts: SyncOptions = {}): Promise<Result<SyncPlan>> {
    const key = locationKey(loc)
    const st = await this.ops.status(loc)
    if (!st.ok) return st
    const s = st.value
    const hasCommit = (await this.git(loc, ['rev-parse', '-q', '--verify', 'HEAD^{commit}'], 15_000)).code === 0
    const anyBranch = ((await this.out(loc, ['for-each-ref', '--count=1', '--format=%(refname)', 'refs/heads'])) ?? '').trim()
    if (!hasCommit && !anyBranch) return refuse('EMPTY_REPO', 'This repository has no commits yet, so there is nothing to sync.')
    if (!s.remotes.length) return refuse('NO_REMOTE', 'This repository has no remote, so there is nothing to sync with.')
    const upRemote = s.upstream ? [...s.remotes].sort((a, b) => b.length - a.length).find(r => s.upstream!.startsWith(r + '/')) : undefined
    const remote = upRemote ?? (s.remotes.includes('origin') ? 'origin' : s.remotes.length === 1 ? s.remotes[0] : null)
    if (!remote) return refuse('AMBIGUOUS_REMOTE', `This repository has several remotes (${s.remotes.join(', ')}) and none is origin. Choose which remote to sync with.`, s.remotes.join('\n'))

    const before = await this.remoteRefs(loc, remote)
    const f = await this.git(loc, ['fetch', '--prune', '--', remote], 180_000)
    if (f.code !== 0) {
      const e = gitError(f, `Could not fetch from ${remote}.`)
      return fail({ ...e, code: e.code === 'GIT_FAILED' ? 'FETCH_FAILED' : e.code, message: `${e.message} Nothing was changed.` })
    }
    this.inspector.invalidate(key)
    const after = await this.remoteRefs(loc, remote)
    const pruned = [...before].filter(r => !after.has(r)).sort()

    const { base, problem } = await this.inspector.resolveBase(key, loc)
    if (!base || !base.remote) return refuse('NO_DEFAULT_BRANCH', problem ?? 'The default branch could not be determined.')
    const defaultBranch = base.ref.replace(`refs/remotes/${base.remote}/`, '')

    const protectedNames = opts.protectedBranches ?? this.defaults.protectedBranches ?? DEFAULT_PROTECTED
    const locals = parseLocals((await this.out(loc, ['for-each-ref', REF_FIELDS, 'refs/heads'])) ?? '')
    const wts = await this.worktrees(loc)
    const stale: StaleBranch[] = []
    const kept: string[] = []
    for (const b of locals) {
      if (!b.upstream) { kept.push(b.name); continue }
      if (!/gone/.test(b.track) || !b.upstream.startsWith(`refs/remotes/${remote}/`)) continue
      const wt = wts.get(b.name)
      const where = await this.containedIn(loc, b.sha, base.ref)
      const uniq = where ? { ahead: 0, commits: [] } : await this.uniqueCommits(loc, b.sha, base.ref)
      const wouldBe: 'delete-safe' | 'needs-review' = where ? 'delete-safe' : 'needs-review'
      const entry: StaleBranch = {
        name: b.name, sha: b.sha, upstream: b.upstream.slice(13), kind: wouldBe, ahead: uniq.ahead, uniqueCommits: uniq.commits,
        reason: where ? `All commits are already in ${where}.` : `${uniq.ahead} commit${uniq.ahead === 1 ? '' : 's'} not in ${base.name}. Unmerged, or merged by squash or rebase. Review before deleting.`,
      }
      if (wt) { entry.kind = 'protected'; entry.wouldBe = wouldBe; entry.worktree = wt; entry.reason = `Checked out in ${wt.current ? 'this worktree' : 'a worktree'} (${wt.path}).` }
      else if (b.name === defaultBranch || matchesAny(b.name, protectedNames)) { entry.kind = 'protected'; entry.wouldBe = wouldBe; entry.reason = `${b.name} is a protected branch.` }
      stale.push(entry)
    }

    let switchTo: SyncPlan['switchTo']
    const cur = stale.find(b => b.name === s.branch)
    if (cur && s.branch && s.branch !== defaultBranch) {
      const reasonNo = (reason: string) => ({ branch: defaultBranch, safe: false, reason })
      const localDefault = locals.find(l => l.name === defaultBranch)
      if (s.changes.conflicted) switchTo = reasonNo('The repository has unresolved conflicts.')
      else if (!isClean(s.changes)) switchTo = reasonNo('The working tree has uncommitted changes, so GitManager will not switch branches.')
      else if (wts.has(defaultBranch)) switchTo = reasonNo(`${defaultBranch} is checked out in ${wts.get(defaultBranch)!.path}.`)
      else if (!localDefault && !after.has(defaultBranch)) switchTo = reasonNo(`${defaultBranch} does not exist locally or on ${remote}.`)
      else switchTo = { branch: defaultBranch, safe: true, tracksRemote: !localDefault }
    }

    const counts = {
      stale: stale.length, deleteSafe: stale.filter(b => b.kind === 'delete-safe').length, needsReview: stale.filter(b => b.kind === 'needs-review').length,
      protected: stale.filter(b => b.kind === 'protected').length, kept: kept.length, pruned: pruned.length,
    }
    return ok({
      remote, defaultBranch, baseRef: base.ref, current: s.branch, detached: !s.branch && hasCommit, pruned, stale, kept, ...(switchTo ? { switchTo } : {}),
      summary: { text: stale.length ? `${stale.length} stale branch${stale.length === 1 ? '' : 'es'} found` : 'Synced', counts },
      fetchedAt: new Date().toISOString(),
    })
  }

  /**
   * Deletes the selected branches. Every branch is re-verified immediately before deletion against the plan: tip
   * unchanged, upstream still gone, not checked out anywhere, not protected, and (unless forced) still contained in a
   * remote ref. Results are partial and never lost: `deleted` records each tip sha with the command that restores it.
   */
  async execute(loc: Location, plan: SyncPlan, sel: SyncSelection, opts: SyncOptions = {}): Promise<Result<SyncResult>> {
    const protectedNames = opts.protectedBranches ?? this.defaults.protectedBranches ?? DEFAULT_PROTECTED
    const result: SyncResult = { deleted: [], failed: [], refreshed: true }
    const wanted = [...new Set(sel.branches)]
    const forced = new Set(sel.forceBranches ?? [])
    for (const n of forced) if (!wanted.includes(n)) result.failed.push({ name: n, code: 'NOT_SELECTED', reason: 'A forced branch must also be selected.' })

    if (sel.switchToDefault) {
      const sw = await this.switchToDefault(loc, plan)
      if (!sw.ok) return sw
      result.switched = sw.value
    }

    const baseOid = (await this.out(loc, ['rev-parse', '-q', '--verify', `${plan.baseRef}^{commit}`]))?.trim()
    const wts = await this.worktrees(loc)
    for (const name of wanted) {
      const bad = (code: string, reason: string) => { result.failed.push({ name, code, reason } satisfies SyncFailure) }
      if (!isSafeBranchName(name)) { bad('BAD_NAME', `"${name}" is not a valid branch name.`); continue }
      const entry = plan.stale.find(b => b.name === name)
      if (!entry) { bad('NOT_IN_PLAN', `${name} was not in the sync plan. Run Sync again.`); continue }
      const ref = parseLocals((await this.out(loc, ['for-each-ref', REF_FIELDS, `refs/heads/${name}`])) ?? '')[0]
      if (!ref) { bad('GONE', `${name} no longer exists.`); continue }
      if (ref.sha !== entry.sha) { bad('TIP_CHANGED', `${name} changed since the plan (now ${ref.sha.slice(0, 8)}, was ${entry.sha.slice(0, 8)}). Run Sync again.`); continue }
      if (!ref.upstream || !/gone/.test(ref.track)) { bad('NOT_STALE', `${name} is no longer a branch whose remote branch is gone.`); continue }
      const wt = wts.get(name)
      if (wt) { bad('CHECKED_OUT', `${name} is checked out in ${wt.path}.`); continue }
      if (name === plan.defaultBranch || matchesAny(name, protectedNames)) { bad('PROTECTED', `${name} is a protected branch.`); continue }
      if (!baseOid) { bad('NO_BASE', `${plan.baseRef} no longer exists. Run Sync again.`); continue }

      const where = await this.containedIn(loc, ref.sha, plan.baseRef)
      let force = false
      if (!where) {
        if (!forced.has(name)) { bad('NEEDS_REVIEW', `${name} has commits that are not in ${plan.defaultBranch}. Review it, then delete it explicitly.`); continue }
        force = true
      }
      let r = await this.git(loc, ['branch', force ? '-D' : '-d', '--', name], 30_000)
      if (r.code !== 0 && !force && where && /not fully merged/i.test(r.stderr)) r = await this.git(loc, ['branch', '-D', '--', name], 30_000)
      if (r.code !== 0) { bad('DELETE_FAILED', gitError(r, `Could not delete ${name}.`).detail ?? `Could not delete ${name}.`); continue }
      result.deleted.push({ name, sha: ref.sha, forced: force, recoverWith: `git branch ${name} ${ref.sha}` } satisfies SyncDeleted)
    }
    return ok(result)
  }

  /** Re-checks the switch preconditions right now and switches (or tracks the remote default). Nothing is forced. */
  private async switchToDefault(loc: Location, plan: SyncPlan): Promise<Result<{ from: string; to: string }>> {
    if (!plan.switchTo?.safe) return refuse('SWITCH_NOT_SAFE', plan.switchTo?.reason ?? 'The plan offers no safe switch.')
    const st = await this.ops.status(loc)
    if (!st.ok) return st
    if (st.value.branch !== plan.current) return refuse('SWITCH_NOT_SAFE', 'The checked-out branch changed since the plan. Run Sync again.')
    if (!isSafeBranchName(plan.switchTo.branch)) return refuse('BAD_NAME', 'The default branch name is not valid.')
    if (!isClean(st.value.changes)) return refuse('DIRTY', 'The working tree has uncommitted changes, so GitManager will not switch branches.')
    const exists = (await this.git(loc, ['show-ref', '--verify', '--quiet', `refs/heads/${plan.switchTo.branch}`], 15_000)).code === 0
    const sw = exists ? await this.ops.switchBranch(loc, plan.switchTo.branch) : await this.ops.trackRemote(loc, `${plan.remote}/${plan.switchTo.branch}`)
    if (!sw.ok) return sw
    return ok({ from: plan.current ?? '', to: plan.switchTo.branch })
  }
}
