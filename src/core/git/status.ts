import type { SyncState } from '../../shared/types.js'

export type ParsedStatus = {
  oid: string | null
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  /** Upstream is configured but `branch.ab` is missing: the remote branch no longer exists (or was never fetched). */
  upstreamMissing: boolean
  changes: { staged: number; unstaged: number; untracked: number; conflicted: number }
}

/** Parses `git status --porcelain=v2 --branch -z`. */
export function parsePorcelainV2(out: string): ParsedStatus {
  const s: ParsedStatus = { oid: null, branch: null, upstream: null, ahead: 0, behind: 0, upstreamMissing: false, changes: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 } }
  let sawAb = false
  const fields = out.split('\0')
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]
    if (!f) continue
    if (f.startsWith('# ')) {
      const [key, ...rest] = f.slice(2).split(' ')
      const val = rest.join(' ')
      if (key === 'branch.oid') s.oid = val === '(initial)' ? null : val
      else if (key === 'branch.head') s.branch = val === '(detached)' ? null : val
      else if (key === 'branch.upstream') s.upstream = val
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(val)
        if (m) { s.ahead = Number(m[1]); s.behind = Number(m[2]); sawAb = true }
      }
      continue
    }
    const kind = f[0]
    if (kind === '1' || kind === '2') {
      const xy = f.slice(2, 4)
      if (xy[0] !== '.') s.changes.staged++
      if (xy[1] !== '.') s.changes.unstaged++
      if (kind === '2') i++ // a rename or copy is followed by its original path as a separate field
    } else if (kind === 'u') s.changes.conflicted++
    else if (kind === '?') s.changes.untracked++
  }
  s.upstreamMissing = !!s.upstream && !sawAb
  return s
}

export function classifySync(p: Pick<ParsedStatus, 'branch' | 'upstream' | 'ahead' | 'behind' | 'upstreamMissing'>): SyncState {
  if (!p.branch) return 'detached'
  if (!p.upstream) return 'no-upstream'
  if (p.upstreamMissing) return 'upstream-gone'
  if (p.ahead > 0 && p.behind > 0) return 'diverged'
  if (p.ahead > 0) return 'ahead'
  if (p.behind > 0) return 'behind'
  return 'up-to-date'
}

export const isClean = (c: ParsedStatus['changes']) => c.staged + c.unstaged + c.untracked + c.conflicted === 0

/** What a fast-forward-only pull would do, decided before running anything. */
export type PullPlan =
  | { action: 'pull'; commits: number }
  | { action: 'none'; reason: 'up-to-date' | 'ahead' }
  | { action: 'refuse'; code: 'DIVERGED' | 'NO_UPSTREAM' | 'UPSTREAM_GONE' | 'DETACHED' | 'CONFLICTS'; message: string }

export function planPull(p: ParsedStatus): PullPlan {
  const sync = classifySync(p)
  if (p.changes.conflicted > 0) return { action: 'refuse', code: 'CONFLICTS', message: 'The repository has unresolved conflicts. Resolve them before pulling.' }
  switch (sync) {
    case 'detached': return { action: 'refuse', code: 'DETACHED', message: 'HEAD is detached, so there is no branch to pull into. Switch to a branch first.' }
    case 'no-upstream': return { action: 'refuse', code: 'NO_UPSTREAM', message: `${p.branch} has no upstream branch, so there is nothing to pull from.` }
    case 'upstream-gone': return { action: 'refuse', code: 'UPSTREAM_GONE', message: `${p.upstream} no longer exists on the remote.` }
    case 'diverged': return { action: 'refuse', code: 'DIVERGED', message: `${p.branch} and ${p.upstream} have diverged (${p.ahead} local, ${p.behind} remote commits). GitManager only fast-forwards; merge or rebase yourself, then pull again.` }
    case 'ahead': return { action: 'none', reason: 'ahead' }
    case 'up-to-date': return { action: 'none', reason: 'up-to-date' }
    case 'behind': return { action: 'pull', commits: p.behind }
  }
}
