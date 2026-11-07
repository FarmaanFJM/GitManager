// Types shared by the main process and the renderer for Sync with Remote, worktrees and "services affected by a pull".
// Types only: no runtime code, so the renderer can import this file freely.

// ---- Sync with Remote ----

/**
 * delete-safe   every commit of the branch is already contained in the remote default branch (or another remote ref)
 * needs-review  the branch has commits that are not in the default branch: unmerged work OR a squash/rebase merge. Never auto-deleted.
 * protected     must not be deleted: default branch, configured protected name, or checked out in a worktree
 */
export type StaleKind = 'delete-safe' | 'needs-review' | 'protected'

export type SyncCommit = { hash: string; short: string; subject: string }

export type StaleBranch = {
  name: string
  /** Tip of the local branch when the plan was made; execute refuses if it moved. */
  sha: string
  /** The upstream that no longer exists, e.g. origin/feature/x. */
  upstream: string
  kind: StaleKind
  reason: string
  /** Commits on the branch that are not in the default branch (0 for delete-safe). */
  ahead: number
  /** Up to 20 of those commits, newest first. */
  uniqueCommits: SyncCommit[]
  /** Set when the branch is checked out in a worktree (the current one included). */
  worktree?: { path: string; current: boolean }
  /** What the branch would be if it were not checked out: lets the UI explain a stale current branch. */
  wouldBe?: 'delete-safe' | 'needs-review'
}

export type SyncPlan = {
  remote: string
  /** Name of the default branch on the remote, e.g. main, master or dev (from repository metadata, never guessed). */
  defaultBranch: string
  /** Full ref of the comparison base, e.g. refs/remotes/origin/main. */
  baseRef: string
  current: string | null
  detached: boolean
  /** Remote-tracking refs removed by `fetch --prune`, e.g. origin/feature/x. */
  pruned: string[]
  stale: StaleBranch[]
  /** Local branches without an upstream: intentionally local, never stale. Information only. */
  kept: string[]
  /** Offered only when the current branch is stale. safe=false carries the reason (dirty tree, conflicts, ...). */
  switchTo?: { branch: string; safe: boolean; reason?: string; tracksRemote?: boolean }
  summary: { text: string; counts: { stale: number; deleteSafe: number; needsReview: number; protected: number; kept: number; pruned: number } }
  fetchedAt: string
}

export type SyncSelection = {
  /** Stale branches to delete. delete-safe ones are removed with `git branch -d`. */
  branches: string[]
  /** Needs-review branches the user explicitly chose to delete with -D. Must also be listed in `branches`. */
  forceBranches?: string[]
  /** Switch to the default branch first (only when plan.switchTo.safe). */
  switchToDefault?: boolean
}

export type SyncDeleted = { name: string; sha: string; forced: boolean; recoverWith: string }
export type SyncFailure = { name: string; code: string; reason: string }

export type SyncResult = {
  deleted: SyncDeleted[]
  failed: SyncFailure[]
  switched?: { from: string; to: string }
  /** The caller should refresh branches and status. */
  refreshed: true
}

// ---- Worktrees ----

export type WorktreeInfo = {
  path: string
  head: string | null
  branch: string | null
  detached: boolean
  bare: boolean
  locked: boolean
  lockReason?: string
  prunable: boolean
  prunableReason?: string
  /** The first entry of `git worktree list` (the original checkout). */
  main: boolean
  /** The worktree the repository location points at. */
  isCurrent: boolean
  changes?: { staged: number; unstaged: number; untracked: number; conflicted: number }
  dirty?: boolean
}

export type WorktreeBlockerCode = 'main' | 'current' | 'locked' | 'dirty' | 'services' | 'detached-commits' | 'missing'
export type WorktreeBlocker = {
  code: WorktreeBlockerCode
  message: string
  /** True when `force` may override it. main, current, locked and services never can. */
  overridable: boolean
}

export type WorktreeRemovalCheck = {
  worktree: WorktreeInfo
  blockers: WorktreeBlocker[]
  /** Commits on the worktree's branch that no remote has (information; removing a worktree never deletes the branch). */
  unpushed: number
  services: string[]
}

// ---- Services affected by a pull ----

export type AffectedVerdict = 'restart-needed' | 'restart-suggested' | 'hot-reload' | 'none'
export type ServiceTech = 'jvm' | 'dev-server' | 'node' | 'python' | 'dotnet' | 'unknown'

export type ServiceAffect = {
  serviceId: string
  serviceName: string
  tech: ServiceTech
  /** The command reloads code itself (HMR, nodemon, --watch, --reload, dotnet watch). */
  watches: boolean
  verdict: AffectedVerdict
  reasons: string[]
  /** Up to 5 changed files that led to the verdict. */
  files: string[]
}

export type AffectedSummary = {
  services: ServiceAffect[]
  /** 'Backend updated · Restart', '3 services need attention' or ''. */
  text: string
  /** Services with restart-needed or restart-suggested. */
  needsAttention: number
  filesChanged: number
  /** The change list was too large to inspect completely. */
  truncated: boolean
}
