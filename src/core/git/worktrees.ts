import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Location, OpError, Result } from '../../shared/types.js'
import type { WorktreeBlocker, WorktreeInfo, WorktreeRemovalCheck } from '../../shared/gitflow.js'
import { programSpec, run } from '../exec.js'
import { flavorOf, locationRuntime, normalizePath, type PathFlavor } from '../paths.js'
import { gitError, trimGitOutput } from './errors.js'
import { defaultGitRun, isSafeBranchName, type GitRun } from './ops.js'
import { parsePorcelainV2 } from './status.js'

// Linked worktrees. Nothing here uses --force unless the caller sets `force` after seeing the blockers, and the
// blockers that protect work in progress (main worktree, current worktree, locked, running services) cannot be forced.

const ok = <T>(value: T): Result<T> => ({ ok: true, value })
const fail = <T>(error: OpError): Result<T> => ({ ok: false, error })
const refuse = <T>(code: string, message: string, detail?: string): Result<T> => fail({ code, message, ...(detail ? { detail } : {}) })

/** Parses `git worktree list --porcelain -z`. Fields end with NUL, records with an extra NUL. */
export function parseWorktrees(out: string): WorktreeInfo[] {
  const list: WorktreeInfo[] = []
  let cur: WorktreeInfo | null = null
  for (const f of out.split('\0')) {
    if (!f) { cur = null; continue }
    if (f.startsWith('worktree ')) {
      cur = { path: f.slice(9), head: null, branch: null, detached: false, bare: false, locked: false, prunable: false, main: list.length === 0, isCurrent: false }
      list.push(cur)
    } else if (cur) {
      if (f.startsWith('HEAD ')) cur.head = /^0+$/.test(f.slice(5)) ? null : f.slice(5)
      else if (f.startsWith('branch ')) cur.branch = f.slice(7).replace(/^refs\/heads\//, '')
      else if (f === 'detached') cur.detached = true
      else if (f === 'bare') cur.bare = true
      else if (f === 'locked' || f.startsWith('locked ')) { cur.locked = true; if (f.length > 7) cur.lockReason = f.slice(7) }
      else if (f === 'prunable' || f.startsWith('prunable ')) { cur.prunable = true; if (f.length > 9) cur.prunableReason = f.slice(9) }
    }
  }
  return list
}

const flavorFor = (loc: Location, p: string): PathFlavor => (loc.kind === 'wsl' ? 'posix' : flavorOf(p))
function samePath(a: string, b: string, flavor: PathFlavor) {
  const n = (p: string) => { const x = normalizePath(p, flavor); return flavor === 'win32' ? x.toLowerCase() : x }
  return n(a) === n(b)
}
/** True when `child` is `parent` or inside it. */
function isInside(child: string, parent: string, flavor: PathFlavor) {
  const lib = flavor === 'win32' ? path.win32 : path.posix
  const c = normalizePath(child, flavor), p = normalizePath(parent, flavor)
  const rel = lib.relative(flavor === 'win32' ? p.toLowerCase() : p, flavor === 'win32' ? c.toLowerCase() : c)
  return rel === '' || (!rel.startsWith('..') && !lib.isAbsolute(rel))
}

/** The same repository, addressed at another folder (a worktree) in the same namespace. */
export function locationAt(loc: Location, p: string): Location {
  return loc.kind === 'wsl' ? { kind: 'wsl', distro: loc.distro, path: p } : { kind: 'native', path: p }
}

/**
 * Suggested folder for a new worktree: `<repo-parent>/<repo-name>.worktrees/<branch-slug>`, in the repository's own
 * path syntax (Windows drive or UNC, WSL Linux path, POSIX). Branch slashes become dashes.
 */
export function suggestWorktreePath(repo: Location, branch: string): string {
  const flavor = flavorFor(repo, repo.path)
  const lib = flavor === 'win32' ? path.win32 : path.posix
  const root = normalizePath(repo.path, flavor)
  const name = lib.basename(root) || 'repo'
  const slug = branch.replace(/[\\/]+/g, '-').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'worktree'
  return lib.join(lib.dirname(root), `${name}.worktrees`, slug)
}

export type DirState = 'missing' | 'empty' | 'nonempty' | 'file'
export type WorktreeDeps = {
  git?: GitRun
  /** Inspects a target folder. Default: node fs for native repositories, `sh` inside the distribution for WSL. */
  dirState?: (loc: Location, p: string) => Promise<DirState>
}

async function defaultDirState(loc: Location, p: string): Promise<DirState> {
  if (loc.kind === 'wsl') {
    const script = 'if [ -e "$1" ]; then if [ -d "$1" ]; then if [ -n "$(ls -A "$1")" ]; then echo nonempty; else echo empty; fi; else echo file; fi; else echo missing; fi'
    const r = await run(programSpec(locationRuntime(loc), 'sh', ['-c', script, 'sh', p]), { timeoutMs: 15_000 })
    const v = r.stdout.trim()
    return v === 'nonempty' || v === 'empty' || v === 'file' ? v : 'missing'
  }
  try {
    const s = await stat(p)
    if (!s.isDirectory()) return 'file'
    return (await readdir(p)).length ? 'nonempty' : 'empty'
  } catch { return 'missing' }
}

export class WorktreeService {
  private readonly git: GitRun
  private readonly dirState: NonNullable<WorktreeDeps['dirState']>

  constructor(deps: WorktreeDeps = {}) {
    this.git = deps.git ?? defaultGitRun
    this.dirState = deps.dirState ?? defaultDirState
  }

  /** All worktrees with status counts. `withStatus: false` skips the per-worktree `git status` calls. */
  async list(loc: Location, opts: { withStatus?: boolean } = {}): Promise<Result<WorktreeInfo[]>> {
    const [r, top] = await Promise.all([
      this.git(loc, ['worktree', 'list', '--porcelain', '-z'], 20_000),
      this.git(loc, ['rev-parse', '--show-toplevel'], 15_000),
    ])
    if (r.code !== 0) return fail(gitError(r, 'Could not list worktrees.'))
    const items = parseWorktrees(r.stdout)
    const here = top.code === 0 ? top.stdout.trim() : loc.path
    for (const w of items) w.isCurrent = samePath(w.path, here, flavorFor(loc, w.path))
    if (opts.withStatus !== false) {
      await Promise.all(items.filter(w => !w.bare && !w.prunable).map(async w => {
        const s = await this.git(locationAt(loc, w.path), ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal'], 30_000)
        if (s.code !== 0) return
        w.changes = parsePorcelainV2(s.stdout).changes
        w.dirty = w.changes.staged + w.changes.unstaged + w.changes.untracked + w.changes.conflicted > 0
      }))
    }
    return ok(items)
  }

  /**
   * Adds a worktree for an existing local branch (`create: false`) or for a new branch (`create: true`, from `base`
   * or HEAD). Refused before Git runs for: a branch checked out elsewhere, a non-empty target, a target inside the
   * working tree that is not ignored, and invalid names or paths.
   */
  async add(loc: Location, o: { path: string; branch: string; create: boolean; base?: string }): Promise<Result<{ path: string; branch: string }>> {
    if (!isSafeBranchName(o.branch)) return refuse('BAD_NAME', `"${o.branch}" is not a valid branch name.`)
    if (o.base !== undefined && (!o.base || o.base.startsWith('-') || /[\s\0]/.test(o.base))) return refuse('BAD_BASE', `"${o.base}" is not a valid starting point.`)
    const target = (o.path ?? '').trim()
    const flavor = flavorFor(loc, target)
    if (!target || target.includes('\0') || target.startsWith('-')) return refuse('BAD_PATH', 'Choose a folder for the worktree.')
    if (loc.kind === 'wsl' ? !target.startsWith('/') : !(flavor === 'win32' ? path.win32 : path.posix).isAbsolute(target)) {
      return refuse('BAD_PATH', loc.kind === 'wsl' ? `The worktree folder must be a Linux path inside ${loc.distro} (for example /home/you/project.worktrees/x).` : 'The worktree folder must be an absolute path.')
    }
    if (loc.kind === 'wsl' && target.includes('\\')) return refuse('BAD_PATH', `"${target}" is a Windows path; use a Linux path inside ${loc.distro}.`)

    const listed = await this.list(loc, { withStatus: false })
    if (!listed.ok) return listed
    const wts = listed.value
    const taken = wts.find(w => samePath(w.path, target, flavor))
    if (taken) return refuse('PATH_IN_USE', `A worktree already exists at ${taken.path}.`)
    const exists = (await this.git(loc, ['show-ref', '--verify', '--quiet', `refs/heads/${o.branch}`], 15_000)).code === 0
    if (o.create) {
      if (exists) return refuse('EXISTS', `A branch named ${o.branch} already exists. Add a worktree for the existing branch instead.`)
    } else {
      if (!exists) return refuse('NO_BRANCH', `There is no local branch named ${o.branch}.`)
      const co = wts.find(w => w.branch === o.branch)
      if (co) return refuse('CHECKED_OUT', `${o.branch} is already checked out in ${co.path}. Git allows a branch in one worktree at a time.`)
    }
    if (o.base) {
      const v = await this.git(loc, ['rev-parse', '-q', '--verify', `${o.base}^{commit}`], 15_000)
      if (v.code !== 0) return refuse('NO_BASE', `"${o.base}" does not exist.`)
    }

    const state = await this.dirState(loc, target)
    if (state === 'file') return refuse('PATH_EXISTS', `${target} is a file.`)
    if (state === 'nonempty') return refuse('PATH_EXISTS', `${target} already exists and is not empty.`)

    for (const w of wts) {
      if (!isInside(target, w.path, flavor)) continue
      if (w.main !== true && !w.isCurrent) continue // only the repository's own working tree matters
      const lib = flavor === 'win32' ? path.win32 : path.posix
      const rel = lib.relative(normalizePath(w.path, flavor), normalizePath(target, flavor)).split(/[\\/]/).join('/')
      const ign = rel === '' ? 1 : (await this.git(locationAt(loc, w.path), ['check-ignore', '-q', '--', `${rel}/x`], 15_000)).code
      if (ign !== 0) return refuse('INSIDE_REPO', `${target} is inside the repository's working tree and is not an ignored folder. Choose a folder outside it, or add it to .gitignore first.`)
    }

    const args = o.create ? ['worktree', 'add', '-b', o.branch, '--', target, ...(o.base ? [o.base] : [])] : ['worktree', 'add', '--', target, o.branch]
    const r = await this.git(loc, args, 120_000)
    if (r.code !== 0) return fail(gitError(r, `Could not add a worktree for ${o.branch}. Nothing was changed.`))
    return ok({ path: target, branch: o.branch })
  }

  /** Everything that would stop a removal, and the facts the confirmation dialog needs. */
  async removalCheck(loc: Location, target: string, runningServicesAt?: (p: string) => string[] | Promise<string[]>): Promise<Result<WorktreeRemovalCheck>> {
    const listed = await this.list(loc)
    if (!listed.ok) return listed
    const flavor = flavorFor(loc, target)
    const wt = listed.value.find(w => samePath(w.path, target, flavor))
    if (!wt) return refuse('NOT_A_WORKTREE', `${target} is not a worktree of this repository.`)
    const blockers: WorktreeBlocker[] = []
    if (wt.main) blockers.push({ code: 'main', overridable: false, message: 'This is the main worktree. It cannot be removed.' })
    if (wt.isCurrent) blockers.push({ code: 'current', overridable: false, message: 'This is the worktree you are using. Open another worktree to remove this one.' })
    if (wt.locked) blockers.push({ code: 'locked', overridable: false, message: `The worktree is locked${wt.lockReason ? ` (${wt.lockReason})` : ''}. Unlock it with git worktree unlock first.` })
    if (wt.prunable) blockers.push({ code: 'missing', overridable: true, message: 'The worktree folder is missing. Use Prune to clear its record.' })
    if (wt.dirty && wt.changes) {
      const c = wt.changes
      const parts = [c.staged && `${c.staged} staged`, c.unstaged && `${c.unstaged} modified`, c.untracked && `${c.untracked} untracked`, c.conflicted && `${c.conflicted} conflicted`].filter(Boolean)
      blockers.push({ code: 'dirty', overridable: true, message: `It has uncommitted changes (${parts.join(', ')}) that removal would discard.` })
    }
    const services = runningServicesAt ? await runningServicesAt(wt.path) : []
    if (services.length) blockers.push({ code: 'services', overridable: false, message: `Running services use this folder: ${services.join(', ')}. Stop them first.` })

    let unpushed = 0
    if (!wt.bare && !wt.prunable && wt.head) {
      const wl = locationAt(loc, wt.path)
      const r = await this.git(wl, ['rev-list', '--count', 'HEAD', '--not', '--remotes'], 20_000)
      if (r.code === 0) unpushed = Number(r.stdout.trim()) || 0
      if (wt.detached) {
        const u = await this.git(wl, ['rev-list', '--count', 'HEAD', '--not', '--branches', '--remotes', '--tags'], 20_000)
        const n = u.code === 0 ? Number(u.stdout.trim()) || 0 : 0
        if (n > 0) blockers.push({ code: 'detached-commits', overridable: true, message: `HEAD is detached and ${n} commit${n === 1 ? ' is' : 's are'} not on any branch; removing the worktree would leave them reachable only through the reflog.` })
      }
    }
    return ok({ worktree: wt, blockers, unpushed, services })
  }

  /**
   * Removes a linked worktree (not its branch). `confirmed` must be true. Non-overridable blockers always refuse;
   * overridable ones (uncommitted changes, detached commits) refuse unless `force` is set, and only then is `--force` used.
   */
  async remove(loc: Location, target: string, o: { force?: boolean; confirmed: boolean; runningServicesAt?: (p: string) => string[] | Promise<string[]> }): Promise<Result<{ removed: string; branch: string | null; unpushed: number }>> {
    if (!o.confirmed) return refuse('NOT_CONFIRMED', 'Removing a worktree needs confirmation.')
    const c = await this.removalCheck(loc, target, o.runningServicesAt)
    if (!c.ok) return c
    const hard = c.value.blockers.filter(b => !b.overridable)
    if (hard.length) return refuse('BLOCKED', hard[0].message, hard.slice(1).map(b => b.message).join('\n') || undefined)
    const soft = c.value.blockers.filter(b => b.code !== 'missing')
    if (soft.length && !o.force) return refuse('BLOCKED', soft[0].message, soft.slice(1).map(b => b.message).join('\n') || undefined)
    const wt = c.value.worktree
    const r = await this.git(loc, ['worktree', 'remove', ...(o.force ? ['--force'] : []), '--', wt.path], 120_000)
    if (r.code !== 0) {
      const e = gitError(r, 'Git could not remove the worktree. Nothing was changed.')
      return fail({ ...e, message: trimGitOutput(r.stderr).split('\n')[0] || e.message })
    }
    return ok({ removed: wt.path, branch: wt.branch, unpushed: c.value.unpushed })
  }

  /** Clears records of worktrees whose folder no longer exists. `dryRun` only reports. */
  async prune(loc: Location, o: { dryRun?: boolean } = {}): Promise<Result<{ pruned: string[] }>> {
    const r = await this.git(loc, ['worktree', 'prune', '--verbose', ...(o.dryRun ? ['--dry-run'] : [])], 30_000)
    if (r.code !== 0) return fail(gitError(r, 'Could not prune worktrees.'))
    const pruned = `${r.stdout}\n${r.stderr}`.split(/\r?\n/).map(l => /^Removing (.+?): /.exec(l)?.[1]).filter((x): x is string => !!x)
    return ok({ pruned })
  }
}
