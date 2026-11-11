import type { Location, OpError, Result } from '../../shared/types.js'
import type { BranchAnalysis, BranchDeleteItem, BranchDeleteResult, LocalBranchInfo, RecoveryRecord } from '../../shared/changes.js'
import { locationKey } from '../paths.js'
import { BranchInspector } from './branches.js'
import { gitError } from './errors.js'
import { Git, defaultGitRun, isSafeBranchName, type GitRun } from './ops.js'
import { RecoveryLog } from './recovery.js'
import { DEFAULT_PROTECTED, SyncService } from './sync.js'
import { parseWorktrees } from './worktrees.js'

// Local branch management: what each local branch is (merged, pushed, unmerged work, protected, checked out), why it can or cannot be
// deleted and what deleting it would lose; and deletion itself with `git branch -d` for safe cases and a separate `git branch -D`
// only for branches whose commits exist nowhere else and only when asked for by name. Remote branches are never touched.
// A dirty working tree is irrelevant to deleting some other branch, so it is never a blocker here.

const ok = <T>(value: T): Result<T> => ({ ok: true, value })
const fail = <T>(error: OpError): Result<T> => ({ ok: false, error })

function matches(name: string, patterns: string[]) {
  return patterns.some(p => new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(name))
}
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]) } }))
  return out
}

type Ctx = {
  baseRef: string | null
  baseName: string | null
  baseProblem: string | null
  defaultBranch: string | null
  remote: string | null
  current: string | null
  detached: boolean
  worktrees: Map<string, string>
  locals: Map<string, RawLocal>
  protectedNames: string[]
  switchable: boolean
}
type RawLocal = { name: string; sha: string; upstream: string; track: string; head: boolean; subject: string; date: number }

const REF_FIELDS = '--format=%(refname)%1f%(objectname)%1f%(upstream)%1f%(upstream:track)%1f%(HEAD)%1f%(committerdate:unix)%1f%(subject)'
const parseLocals = (out: string): RawLocal[] => out.split('\n').filter(Boolean).map(l => l.split('\x1f')).filter(f => f[0]?.startsWith('refs/heads/'))
  .map(f => ({ name: f[0].slice(11), sha: f[1], upstream: f[2] ?? '', track: f[3] ?? '', head: f[4] === '*', date: Number(f[5]) * 1000, subject: f[6] ?? '' }))

export class BranchCleaner {
  private readonly ops: Git
  constructor(
    private readonly git: GitRun = defaultGitRun,
    private readonly inspector: BranchInspector = new BranchInspector(git),
    private readonly sync: SyncService = new SyncService(git, inspector),
    readonly recovery: RecoveryLog = new RecoveryLog(null),
    private readonly protectedBranches: string[] = DEFAULT_PROTECTED,
  ) { this.ops = new Git(git) }

  private async out(loc: Location, args: string[], t = 30_000) { const r = await this.git(loc, args, t); return r.code === 0 ? r.stdout : null }

  private async context(repoKey: string, loc: Location, chosen: string | null | undefined): Promise<Result<Ctx>> {
    const st = await this.ops.status(loc)
    if (!st.ok) return st
    const { base, problem } = await this.inspector.resolveBase(repoKey, loc, { chosen, network: false })
    const refs = await this.git(loc, ['for-each-ref', REF_FIELDS, 'refs/heads'], 30_000)
    if (refs.code !== 0) return fail(gitError(refs, 'Could not list the local branches.'))
    const locals = new Map(parseLocals(refs.stdout).map(l => [l.name, l]))
    const wtOut = await this.out(loc, ['worktree', 'list', '--porcelain', '-z'])
    const top = (await this.out(loc, ['rev-parse', '--show-toplevel']))?.trim()
    const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    const worktrees = new Map<string, string>()
    for (const w of wtOut ? parseWorktrees(wtOut) : []) if (w.branch && !(top && norm(top) === norm(w.path) && w.branch === st.value.branch)) worktrees.set(w.branch, w.path)
    let defaultBranch: string | null = null
    if (base) defaultBranch = base.remote && base.ref.startsWith(`refs/remotes/${base.remote}/`) ? base.ref.slice(`refs/remotes/${base.remote}/`.length) : base.ref.replace(/^refs\/heads\//, '')
    const switchable = !!defaultBranch && (locals.has(defaultBranch) || (!!base && base.ref.startsWith('refs/remotes/')))
    return ok({
      baseRef: base?.ref ?? null, baseName: base?.name ?? null, baseProblem: problem, defaultBranch, remote: base?.remote ?? null,
      current: st.value.branch, detached: !st.value.branch, worktrees, locals, protectedNames: this.protectedBranches, switchable,
    })
  }

  private async classify(loc: Location, ctx: Ctx, b: RawLocal): Promise<LocalBranchInfo> {
    const track = /gone/.test(b.track) ? 'gone' : !b.upstream ? 'none' : /ahead/.test(b.track) && /behind/.test(b.track) ? 'diverged' : /ahead/.test(b.track) ? 'ahead' : /behind/.test(b.track) ? 'behind' : 'in-sync'
    const isDefault = b.name === ctx.defaultBranch
    const isCurrent = b.name === ctx.current
    const wt = ctx.worktrees.get(b.name)
    const rule = !isDefault && matches(b.name, ctx.protectedNames)
    const base: Pick<LocalBranchInfo, 'name' | 'sha' | 'short' | 'current' | 'upstream' | 'upstreamState' | 'subject' | 'date'> = {
      name: b.name, sha: b.sha, short: b.sha.slice(0, 7), current: isCurrent, ...(b.upstream ? { upstream: b.upstream.replace(/^refs\/remotes\//, '') } : {}), upstreamState: track, subject: b.subject, date: b.date,
    }
    const blocked = (category: LocalBranchInfo['category'], blocker: OpError): LocalBranchInfo => ({ ...base, category, tier: 'blocked', uniqueCount: 0, onlyHereCount: 0, onRemotes: [], blocker })

    if (isCurrent) {
      return blocked('current', {
        code: 'CURRENT_BRANCH', message: `${b.name} is checked out. Switch to another branch first.`,
        blocker: { branch: b.name, actions: ctx.switchable && ctx.defaultBranch && ctx.defaultBranch !== b.name ? [{ id: 'switch-default', label: `Switch to ${ctx.defaultBranch}`, target: ctx.defaultBranch }] : [] },
      })
    }
    if (wt) return blocked('worktree', { code: 'WORKTREE_CHECKED_OUT', message: `${b.name} is checked out in another worktree (${wt}).`, blocker: { worktree: wt, branch: b.name, actions: [{ id: 'open-worktree', label: 'Open Worktree', target: wt }] } })
    if (isDefault) return blocked('protected', { code: 'DEFAULT_BRANCH', message: `${b.name} is the default branch of this repository.` })
    if (rule) return blocked('protected', { code: 'PROTECTED', message: `${b.name} matches a protected branch rule (${ctx.protectedNames.join(', ')}).` })

    const merged = async (ref: string) => (await this.git(loc, ['merge-base', '--is-ancestor', b.sha, ref], 20_000)).code === 0
    const isMerged = (ctx.baseRef ? await merged(ctx.baseRef) : false) || (ctx.defaultBranch && ctx.locals.has(ctx.defaultBranch) ? await merged(`refs/heads/${ctx.defaultBranch}`) : false)
    const containing = (await this.out(loc, ['for-each-ref', '--contains', b.sha, '--format=%(refname:short)', 'refs/remotes'])) ?? ''
    const onRemotes = containing.split('\n').map(s => s.trim()).filter(s => s && !s.endsWith('/HEAD')).slice(0, 8)
    if (isMerged) {
      return { ...base, category: 'merged', tier: 'safe', uniqueCount: 0, onlyHereCount: 0, onRemotes, note: `Merged into ${ctx.baseName ?? ctx.defaultBranch}.` }
    }
    const [uc, oc] = await Promise.all([
      ctx.baseRef ? this.out(loc, ['rev-list', '--count', b.sha, '--not', ctx.baseRef]) : Promise.resolve(null),
      this.out(loc, ['rev-list', '--count', b.sha, '--not', '--remotes']),
    ])
    const uniqueCount = Number(uc?.trim()) || 0
    const onlyHereCount = Number(oc?.trim()) || 0
    if (onlyHereCount === 0) {
      return { ...base, category: track === 'gone' ? 'gone' : 'pushed', tier: 'safe', uniqueCount, onlyHereCount, onRemotes, note: `Not merged into ${ctx.baseName ?? 'the default branch'}, but every commit exists on ${onRemotes[0] ?? 'a remote'}.` }
    }
    const why = track === 'gone' ? 'its upstream no longer exists' : track === 'none' ? 'it has no upstream' : 'they were never pushed'
    return {
      ...base, category: 'unique', tier: 'force', uniqueCount, onlyHereCount, onRemotes,
      note: `${plural(onlyHereCount, 'commit')} ${onlyHereCount === 1 ? 'exists' : 'exist'} only on this computer (${why}).`,
      blocker: {
        code: 'UNIQUE_COMMITS', message: `${b.name} has ${plural(onlyHereCount, 'commit')} that exist on no remote. Deleting it needs a forced delete.`,
        blocker: { branch: b.name, actions: [{ id: 'inspect-commits', label: 'Inspect Commits', target: b.name }, { id: 'force-delete', label: 'Force Delete', target: b.name }] },
      },
    }
  }

  /**
   * Classifies every local branch against the repository's default branch and the remote-tracking refs. With `sync`, the existing
   * Sync with Remote plan runs first (fetch and prune: only remote-tracking refs change). Read-only apart from that.
   */
  async analyze(repoKey: string, loc: Location, o: { sync?: boolean; chosenBase?: string | null } = {}): Promise<Result<BranchAnalysis>> {
    const syncInfo: BranchAnalysis['sync'] = { ran: false, pruned: [] }
    if (o.sync) {
      const p = await this.sync.plan(loc)
      if (p.ok) { syncInfo.ran = true; syncInfo.pruned = p.value.pruned } else if (!['NO_REMOTE', 'EMPTY_REPO', 'NO_DEFAULT_BRANCH'].includes(p.error.code)) syncInfo.error = p.error
      this.inspector.invalidate(repoKey)
    }
    const ctx = await this.context(repoKey, loc, o.chosenBase)
    if (!ctx.ok) return ctx
    const branches = await pool([...ctx.value.locals.values()], 6, b => this.classify(loc, ctx.value, b))
    branches.sort((a, b) => Number(b.current) - Number(a.current) || a.name.localeCompare(b.name, undefined, { numeric: true }))
    return ok({
      defaultBranch: ctx.value.defaultBranch, baseName: ctx.value.baseName, baseProblem: ctx.value.baseProblem, current: ctx.value.current, detached: ctx.value.detached,
      remote: ctx.value.remote, branches, sync: syncInfo, analyzedAt: new Date().toISOString(),
    })
  }

  /**
   * Deletes the named branches, each re-checked right before: it must still exist at the commit the user saw, must not be checked out,
   * protected or the default, and may be deleted without force only when it is safe. One failure never stops the others.
   */
  async delete(repoKey: string, repoId: string, loc: Location, items: BranchDeleteItem[], chosenBase?: string | null): Promise<Result<BranchDeleteResult>> {
    const result: BranchDeleteResult = { deleted: [], skipped: [], failed: [] }
    const ctx = await this.context(repoKey, loc, chosenBase)
    if (!ctx.ok) return ctx
    const seen = new Set<string>()
    for (const item of items) {
      const skip = (error: OpError) => result.skipped.push({ name: item.name, error })
      if (!item || typeof item.name !== 'string' || !isSafeBranchName(item.name) || typeof item.sha !== 'string' || !/^[0-9a-f]{40,64}$/.test(item.sha)) { skip({ code: 'BAD_NAME', message: `"${String(item?.name)}" is not a valid branch.` }); continue }
      if (seen.has(item.name)) continue
      seen.add(item.name)
      // Re-read this branch and the checked-out branch now: the analysis the user saw may be old.
      const fresh = parseLocals((await this.out(loc, ['for-each-ref', REF_FIELDS, `refs/heads/${item.name}`])) ?? '')[0]
      if (!fresh) { skip({ code: 'GONE', message: `${item.name} no longer exists.` }); continue }
      if (fresh.sha !== item.sha) { skip({ code: 'TIP_CHANGED', message: `${item.name} changed since you looked at it (now ${fresh.sha.slice(0, 7)}, was ${item.sha.slice(0, 7)}). Review it again.` }); continue }
      const head = (await this.out(loc, ['symbolic-ref', '-q', '--short', 'HEAD']))?.trim() || null
      const now: Ctx = { ...ctx.value, current: head, locals: new Map(ctx.value.locals).set(fresh.name, fresh) }
      const info = await this.classify(loc, now, fresh)
      if (info.tier === 'blocked') { skip(info.blocker!); continue }
      if (info.tier === 'force' && !item.force) { skip(info.blocker!); continue }

      const forced = info.tier === 'force'
      const rec = this.recovery.add({ repoId, name: fresh.name, sha: fresh.sha, forced, recoverWith: `git branch ${fresh.name} ${fresh.sha}` })
      let method: 'd' | 'D' = forced ? 'D' : 'd'
      let r = await this.git(loc, ['branch', `-${method}`, '--', fresh.name], 30_000)
      // `-d` compares with the branch's own upstream or HEAD, not with the default branch. A branch this module has just proved is merged
      // or fully pushed loses nothing either way, so the stricter flag is used only after that proof.
      if (r.code !== 0 && !forced && /not fully merged/i.test(r.stderr)) { method = 'D'; r = await this.git(loc, ['branch', '-D', '--', fresh.name], 30_000) }
      if (r.code !== 0) {
        this.recovery.remove(rec.id)
        result.failed.push({ name: item.name, error: gitError(r, `Could not delete ${item.name}.`) })
        continue
      }
      result.deleted.push({ name: fresh.name, sha: fresh.sha, forced, method, recoverWith: rec.recoverWith, onRemotes: info.onRemotes })
    }
    this.inspector.invalidate(repoKey)
    return ok(result)
  }

  /** Recovery records for a repository, each marked with whether the commit can still be found. */
  async records(loc: Location, repoId: string): Promise<RecoveryRecord[]> {
    const out: RecoveryRecord[] = []
    for (const r of this.recovery.list(repoId).slice(0, 50)) out.push({ ...r, available: (await this.git(loc, ['cat-file', '-e', `${r.sha}^{commit}`], 10_000)).code === 0 })
    return out
  }

  /** Recreates a deleted branch at its recorded commit. Refuses when the name is taken or the commit is gone. */
  async restore(loc: Location, repoId: string, id: string): Promise<Result<{ name: string }>> {
    const r = this.recovery.get(id)
    if (!r || r.repoId !== repoId) return fail({ code: 'NO_RECORD', message: 'That recovery record no longer exists.' })
    if (!isSafeBranchName(r.name)) return fail({ code: 'BAD_NAME', message: `"${r.name}" is not a valid branch name.` })
    if ((await this.git(loc, ['show-ref', '--verify', '--quiet', `refs/heads/${r.name}`], 10_000)).code === 0) return fail({ code: 'EXISTS', message: `A branch named ${r.name} already exists.` })
    if ((await this.git(loc, ['cat-file', '-e', `${r.sha}^{commit}`], 10_000)).code !== 0) return fail({ code: 'COMMIT_GONE', message: `The commit ${r.sha.slice(0, 7)} no longer exists in this repository, so ${r.name} cannot be recreated.` })
    const c = await this.git(loc, ['branch', '--', r.name, r.sha], 20_000)
    if (c.code !== 0) return fail(gitError(c, `Could not recreate ${r.name}.`))
    this.recovery.remove(r.id)
    return ok({ name: r.name })
  }
}

export { locationKey }
