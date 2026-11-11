// Types shared by the main process and the renderer for working-tree changes, diffs and stashes. Types only.

export type ChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'typechange'

/** One path with everything Git says about it: the staged side, the unstaged side, or that it is untracked or conflicted. */
export type FileChange = {
  path: string
  /** The path before a rename or copy (staged or unstaged). */
  from?: string
  /** Staged change (index compared with HEAD); null when nothing is staged. */
  index: ChangeKind | null
  /** Unstaged change (working tree compared with the index); null when none. */
  worktree: ChangeKind | null
  untracked: boolean
  conflicted: boolean
  /** For a conflict: what each side did, e.g. 'both modified'. */
  conflictKind?: string
  submodule: boolean
}

export type RepoOperation = 'merge' | 'cherry-pick' | 'revert' | null

export type WorkingTree = {
  files: FileChange[]
  truncated: boolean
  counts: { files: number; staged: number; unstaged: number; untracked: number; conflicted: number }
  /** A merge, cherry-pick or revert is in progress (its conflicts are listed with the files). */
  operation: RepoOperation
  hasCommits: boolean
  branch: string | null
  readAt: string
}

export type DiffArea = 'staged' | 'unstaged' | 'untracked'

export type DiffLine = { type: 'context' | 'add' | 'del' | 'meta'; text: string; oldNo?: number; newNo?: number }

export type DiffHunk = {
  /** Stable for the hunk's content: hunk actions are refused when the file changed since the id was read. */
  id: string
  header: string
  lines: DiffLine[]
}

export type FileDiff = {
  path: string
  area: DiffArea
  binary: boolean
  hunks: DiffHunk[]
  added: number
  removed: number
  /** Output was cut at the size limit. */
  truncated: boolean
  /** Hunks of this file can be staged, unstaged or discarded one at a time. */
  hunkable: boolean
  notice?: string
}

export type DiffOptions = { path: string; from?: string; area: DiffArea; context?: number }

export type HunkAction = 'stage' | 'unstage' | 'discard'

export type DiscardResult = { discarded: string[]; /** Restores the discarded content: `git stash apply <sha>`. Absent when nothing could be recorded. */ recoverWith?: string }
export type DeleteUntrackedResult = { deleted: string[]; method: 'trash' | 'permanent'; failed: { path: string; reason: string }[] }
export type CommitResult = { hash: string; short: string; summary: string }

/* ------------------------------------------------------------------ stashes */

export type StashEntry = {
  index: number
  ref: string
  sha: string
  /** The message given when stashing, or Git's default ("WIP on main: abc123 subject"). */
  message: string
  branch: string | null
  date: number
  /** Includes untracked files (a third parent exists). */
  hasUntracked: boolean
}

export type StashFile = { path: string; from?: string; status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T'; untracked: boolean }
export type StashPreview = { entry: StashEntry; files: StashFile[]; stat: string }
export type StashApplyResult = { applied: true; conflicts: string[]; /** Pop only: the stash was removed. It is kept when there were conflicts. */ dropped: boolean; sha: string }
export type StashPushResult = { entry: StashEntry | null }

/* ------------------------------------------------------------------ branches */

export type BranchCategory = 'merged' | 'pushed' | 'gone' | 'unique' | 'protected' | 'current' | 'worktree'

export type DeletionTier =
  /** `git branch -d` is enough: nothing is lost (merged into the default branch, or every commit exists on a remote). */
  | 'safe'
  /** Commits exist only on this computer: needs `git branch -D` and an explicit confirmation. */
  | 'force'
  | 'blocked'

export type LocalBranchInfo = {
  name: string
  sha: string
  short: string
  current: boolean
  upstream?: string
  upstreamState: 'none' | 'gone' | 'in-sync' | 'ahead' | 'behind' | 'diverged'
  category: BranchCategory
  tier: DeletionTier
  /** Commits not in the default branch. */
  uniqueCount: number
  /** Commits that exist on no remote-tracking branch (what deleting the branch would lose). */
  onlyHereCount: number
  /** Remote-tracking branches that contain the branch tip, e.g. origin/feature. */
  onRemotes: string[]
  subject: string
  date: number
  /** Why the branch cannot be deleted, with the actions that resolve that. */
  blocker?: import('./types.js').OpError
  /** Plain statement of the consequence for a force deletion or a note for a safe one. */
  note?: string
}

export type BranchAnalysis = {
  defaultBranch: string | null
  baseName: string | null
  baseProblem: string | null
  current: string | null
  detached: boolean
  remote: string | null
  branches: LocalBranchInfo[]
  /** Result of the optional fetch and prune that precedes the analysis. */
  sync: { ran: boolean; pruned: string[]; error?: import('./types.js').OpError }
  analyzedAt: string
}

export type BranchDeleteItem = { name: string; sha: string; force: boolean }
export type DeletedBranch = { name: string; sha: string; forced: boolean; method: 'd' | 'D'; recoverWith: string; onRemotes: string[] }
export type SkippedBranch = { name: string; error: import('./types.js').OpError }
export type BranchDeleteResult = { deleted: DeletedBranch[]; skipped: SkippedBranch[]; failed: SkippedBranch[] }

export type RecoveryRecord = { id: string; repoId: string; name: string; sha: string; at: string; forced: boolean; recoverWith: string; /** The commit still exists in the repository. */ available?: boolean }
