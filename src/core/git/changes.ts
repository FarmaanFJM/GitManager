import { createHash } from 'node:crypto'
import type { Location, OpError, Result } from '../../shared/types.js'
import type {
  ChangeKind, CommitResult, DeleteUntrackedResult, DiffArea, DiffHunk, DiffLine, DiffOptions, DiscardResult, FileChange, FileDiff, HunkAction, RepoOperation, WorkingTree,
} from '../../shared/changes.js'
import { gitError, parseOverwritten } from './errors.js'
import { defaultGitRun, type GitRun } from './ops.js'

// Working-tree changes: status with every kind of change, readable diffs, staging, restoring, discarding, deleting untracked files
// and committing. Each operation maps to the one Git command with the right meaning:
//   stage        git add            unstage     git restore --staged
//   discard      git restore        (unstaged changes of tracked files only; a recovery snapshot is recorded first)
//   restore      git restore        (a deleted tracked file comes back)
//   delete       trash, or git clean (untracked files only, never ignored or tracked ones)
//   commit       git commit         (staged changes only)
// No reset, no checkout of paths, no revert here. Paths are checked against a fresh status and passed after `--` with
// --literal-pathspecs, so a file name is never read as an option or a pattern, and nothing is ever built into a shell string.

const ok = <T>(value: T): Result<T> => ({ ok: true, value })
const fail = <T>(error: OpError): Result<T> => ({ ok: false, error })
const refuse = <T>(code: string, message: string, extra: Partial<OpError> = {}): Result<T> => fail({ code, message, ...extra })

const LIT = '--literal-pathspecs'
const MAX_FILES = 5000
const MAX_DIFF_LINES = 6000

/* ------------------------------------------------------------------ status */

const KIND: Record<string, ChangeKind | undefined> = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'typechange' }
const CONFLICT: Record<string, string> = { DD: 'both deleted', AU: 'added by us', UD: 'deleted by them', UA: 'added by them', DU: 'deleted by us', AA: 'both added', UU: 'both modified' }

/** Parses `git status --porcelain=v2 -z --untracked-files=all` into one entry per path. */
export function parseChanges(out: string): { files: FileChange[]; branch: string | null; hasCommits: boolean } {
  const files: FileChange[] = []
  let branch: string | null = null
  let hasCommits = true
  const f = out.split('\0')
  for (let i = 0; i < f.length; i++) {
    const e = f[i]
    if (!e) continue
    if (e.startsWith('# ')) {
      if (e.startsWith('# branch.head ')) { const b = e.slice(14); branch = b === '(detached)' ? null : b }
      else if (e.startsWith('# branch.oid ')) hasCommits = e.slice(13) !== '(initial)'
      continue
    }
    const take = (n: number) => { let k = 0, at = 0; while (k < n) { at = e.indexOf(' ', at) + 1; k++ } return at }
    if (e[0] === '1') {
      const xy = e.slice(2, 4)
      files.push({ path: e.slice(take(8)), index: KIND[xy[0]] ?? null, worktree: KIND[xy[1]] ?? null, untracked: false, conflicted: false, submodule: e[5] === 'S' })
    } else if (e[0] === '2') {
      const xy = e.slice(2, 4)
      const from = f[++i]
      files.push({ path: e.slice(take(9)), from, index: KIND[xy[0]] ?? null, worktree: KIND[xy[1]] ?? null, untracked: false, conflicted: false, submodule: e[5] === 'S' })
    } else if (e[0] === 'u') {
      const xy = e.slice(2, 4)
      files.push({ path: e.slice(take(10)), index: null, worktree: null, untracked: false, conflicted: true, conflictKind: CONFLICT[xy] ?? 'conflict', submodule: e[5] === 'S' })
    } else if (e[0] === '?') {
      files.push({ path: e.slice(2), index: null, worktree: null, untracked: true, conflicted: false, submodule: false })
    }
  }
  return { files, branch, hasCommits }
}

export function countChanges(files: FileChange[]): WorkingTree['counts'] {
  return {
    files: files.length, staged: files.filter(x => x.index).length, unstaged: files.filter(x => x.worktree).length,
    untracked: files.filter(x => x.untracked).length, conflicted: files.filter(x => x.conflicted).length,
  }
}

/* ------------------------------------------------------------------ diff parsing */

const hashOf = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 16)

type ParsedHunk = DiffHunk & { raw: string }
export type ParsedDiff = { header: string; binary: boolean; hunks: ParsedHunk[]; added: number; removed: number; truncated: boolean; simple: boolean }

/** Parses one file's unified diff. Keeps the raw header and hunk text, which is what a hunk operation applies. */
export function parseUnifiedDiff(text: string): ParsedDiff {
  const lines = text.split('\n')
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  const headerLines: string[] = []
  const hunks: ParsedHunk[] = []
  let cur: { header: string; raw: string[]; lines: DiffLine[] } | null = null
  let oldNo = 0, newNo = 0, added = 0, removed = 0, truncated = false, shown = 0
  let binary = false
  const close = () => { if (cur) { const raw = cur.raw.join('\n') + '\n'; hunks.push({ id: hashOf(raw), header: cur.header, lines: cur.lines, raw }); cur = null } }
  for (const line of lines) {
    if (line.startsWith('@@')) {
      close()
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
      oldNo = m ? Number(m[1]) : 0; newNo = m ? Number(m[2]) : 0
      cur = { header: line, raw: [line], lines: [] }
      continue
    }
    if (!cur) {
      if (/^Binary files .* differ$|^GIT binary patch/.test(line)) binary = true
      headerLines.push(line)
      continue
    }
    cur.raw.push(line)
    if (shown >= MAX_DIFF_LINES) { truncated = true; continue }
    shown++
    const c = line[0]
    if (c === '+') { added++; cur.lines.push({ type: 'add', text: line.slice(1), newNo: newNo++ }) }
    else if (c === '-') { removed++; cur.lines.push({ type: 'del', text: line.slice(1), oldNo: oldNo++ }) }
    else if (c === '\\') cur.lines.push({ type: 'meta', text: line.slice(2) })
    else cur.lines.push({ type: 'context', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ })
  }
  close()
  const header = headerLines.join('\n') + (headerLines.length ? '\n' : '')
  const simple = !binary && hunks.length > 0 && !/^(new|deleted) file mode|^rename (from|to) |^copy (from|to) |^old mode|^new mode/m.test(header)
  return { header, binary, hunks, added, removed, truncated, simple }
}

const toFileDiff = (p: ParsedDiff, path: string, area: DiffArea, notice?: string): FileDiff => ({
  path, area, binary: p.binary, added: p.added, removed: p.removed, truncated: p.truncated, hunkable: p.simple && area !== 'untracked' && !p.truncated,
  hunks: p.hunks.map(h => ({ id: h.id, header: h.header, lines: h.lines })), ...(notice ? { notice } : {}),
})

/* ------------------------------------------------------------------ path checks */

/** A repository-relative path that cannot reach outside the repository. */
export function safeRelativePath(p: unknown): p is string {
  if (typeof p !== 'string' || !p || p.length > 4096) return false
  // eslint-disable-next-line no-control-regex
  if (/[\x00\r\n]/.test(p)) return false
  if (p.startsWith('/') || p.startsWith('\\') || /^[A-Za-z]:/.test(p)) return false
  return !p.split(/[\\/]/).includes('..')
}

function chunks<T>(items: T[], size = (x: T) => String(x).length, limit = 20_000): T[][] {
  const out: T[][] = []
  let cur: T[] = [], n = 0
  for (const it of items) { const w = size(it) + 1; if (cur.length && n + w > limit) { out.push(cur); cur = []; n = 0 } cur.push(it); n += w }
  if (cur.length) out.push(cur)
  return out
}

export type TrashFn = (loc: Location, relPath: string) => Promise<void>

export class ChangesService {
  constructor(private readonly git: GitRun = defaultGitRun) {}

  private async out(loc: Location, args: string[], t = 20_000) { const r = await this.git(loc, args, t); return r.code === 0 ? r.stdout : null }

  async read(loc: Location): Promise<Result<WorkingTree>> {
    const r = await this.git(loc, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], 60_000)
    if (r.code !== 0) return fail(gitError(r, 'Could not read the changes.'))
    const parsed = parseChanges(r.stdout)
    const truncated = parsed.files.length > MAX_FILES
    const files = parsed.files.slice(0, MAX_FILES).sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }))
    const [merge, pick, rev] = await Promise.all(['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'].map(h => this.git(loc, ['rev-parse', '-q', '--verify', h], 10_000)))
    const operation: RepoOperation = merge.code === 0 ? 'merge' : pick.code === 0 ? 'cherry-pick' : rev.code === 0 ? 'revert' : null
    return ok({ files, truncated, counts: countChanges(parsed.files), operation, hasCommits: parsed.hasCommits, branch: parsed.branch, readAt: new Date().toISOString() })
  }

  /** The files of the request that really are in the state the operation needs, or a refusal naming the ones that are not. */
  private async select(loc: Location, paths: unknown, need: (f: FileChange) => boolean, what: string): Promise<Result<{ files: FileChange[]; tree: WorkingTree }>> {
    if (!Array.isArray(paths) || paths.length === 0) return refuse('NOTHING_SELECTED', 'Select at least one file.')
    if (paths.length > MAX_FILES || !paths.every(safeRelativePath)) return refuse('BAD_PATH', 'A selected path is not valid.')
    const t = await this.read(loc)
    if (!t.ok) return t
    const byPath = new Map(t.value.files.map(f => [f.path, f]))
    const files: FileChange[] = [], bad: string[] = []
    for (const p of new Set(paths as string[])) { const f = byPath.get(p); if (f && need(f)) files.push(f); else bad.push(p) }
    if (bad.length) return refuse('STALE_SELECTION', `${bad.length === 1 ? 'This file has' : `${bad.length} files have`} changed since the list was read, so ${what} was not performed. Refresh and select again.`, { blocker: { files: bad, actions: [] } })
    return ok({ files, tree: t.value })
  }

  private async batched(loc: Location, head: string[], paths: string[], t = 120_000): Promise<OpError | null> {
    for (const part of chunks(paths)) {
      const r = await this.git(loc, [LIT, ...head, '--', ...part], t)
      if (r.code !== 0) return gitError(r, 'Git could not complete the operation.')
    }
    return null
  }

  /* ---------------------------------------------------------------- diffs */

  async diff(loc: Location, o: DiffOptions): Promise<Result<FileDiff>> {
    if (!safeRelativePath(o.path) || (o.from !== undefined && !safeRelativePath(o.from))) return refuse('BAD_PATH', 'That path is not valid.')
    const ctx = Math.max(0, Math.min(200, Math.floor(o.context ?? 3)))
    const common = ['--no-color', '--no-ext-diff', '--no-textconv', `-U${ctx}`]
    const paths = o.from ? [o.from, o.path] : [o.path]
    let r
    if (o.area === 'staged') r = await this.git(loc, [LIT, 'diff', '--cached', ...common, '-M', '--', ...paths], 60_000)
    else if (o.area === 'unstaged') r = await this.git(loc, [LIT, 'diff', ...common, '--', o.path], 60_000)
    else {
      // --no-index exits 1 when the files differ, which is the normal outcome here.
      r = await this.git(loc, [LIT, 'diff', '--no-index', ...common, '--', '/dev/null', o.path], 60_000)
      if (r.code === 1) r = { ...r, code: 0 }
    }
    if (r.code !== 0) return fail(gitError(r, 'Could not read the diff.'))
    if (!r.stdout.trim()) return ok({ path: o.path, area: o.area, binary: false, hunks: [], added: 0, removed: 0, truncated: false, hunkable: false, notice: 'No textual changes (the file is empty, or only its mode changed).' })
    const p = parseUnifiedDiff(r.stdout)
    return ok(toFileDiff(p, o.path, o.area, p.binary ? 'Binary file: no text diff.' : p.truncated ? 'The diff is long; only the first lines are shown.' : undefined))
  }

  /* ---------------------------------------------------------------- staging */

  async stage(loc: Location, paths: unknown): Promise<Result<{ staged: string[] }>> {
    const s = await this.select(loc, paths, f => f.worktree !== null || f.untracked || f.conflicted, 'staging')
    if (!s.ok) return s
    const all = s.value.files.flatMap(f => [f.path, ...(f.from && f.worktree ? [f.from] : [])])
    const e = await this.batched(loc, ['add', '-A'], all)
    return e ? fail(e) : ok({ staged: s.value.files.map(f => f.path) })
  }

  /** Everything that can be staged without a decision: changed and untracked files. Conflicted files are left, they need a resolution. */
  async stageAll(loc: Location): Promise<Result<{ staged: string[]; skippedConflicts: string[] }>> {
    const t = await this.read(loc)
    if (!t.ok) return t
    const eligible = t.value.files.filter(f => !f.conflicted && (f.worktree || f.untracked))
    const skippedConflicts = t.value.files.filter(f => f.conflicted).map(f => f.path)
    if (!eligible.length) return ok({ staged: [], skippedConflicts })
    const e = await this.batched(loc, ['add', '-A'], eligible.flatMap(f => [f.path, ...(f.from && f.worktree ? [f.from] : [])]))
    return e ? fail(e) : ok({ staged: eligible.map(f => f.path), skippedConflicts })
  }

  async unstage(loc: Location, paths: unknown): Promise<Result<{ unstaged: string[] }>> {
    const s = await this.select(loc, paths, f => f.index !== null, 'unstaging')
    if (!s.ok) return s
    return this.unstageFiles(loc, s.value.files, s.value.tree.hasCommits)
  }

  async unstageAll(loc: Location): Promise<Result<{ unstaged: string[] }>> {
    const t = await this.read(loc)
    if (!t.ok) return t
    return this.unstageFiles(loc, t.value.files.filter(f => f.index !== null), t.value.hasCommits)
  }

  private async unstageFiles(loc: Location, files: FileChange[], hasCommits: boolean): Promise<Result<{ unstaged: string[] }>> {
    if (!files.length) return ok({ unstaged: [] })
    const all = files.flatMap(f => [f.path, ...(f.from ? [f.from] : [])])
    // Before the first commit there is no HEAD to restore from: the index entries are simply removed (the files stay).
    const e = await this.batched(loc, hasCommits ? ['restore', '--staged'] : ['rm', '--cached', '-r', '-q', '--ignore-unmatch'], all)
    return e ? fail(e) : ok({ unstaged: files.map(f => f.path) })
  }

  /* ---------------------------------------------------------------- discarding and restoring */

  /**
   * Discards the unstaged changes of tracked files (`git restore --worktree`): the working copy goes back to what is staged.
   * Staged changes stay. Untracked files and conflicted files are refused. A snapshot of the working state is recorded first
   * (`git stash create` writes an object and changes nothing else) so the content can be recovered.
   */
  async discard(loc: Location, paths: unknown, confirm: boolean): Promise<Result<DiscardResult>> {
    if (confirm !== true) return refuse('CONFIRM_REQUIRED', 'Discarding changes needs your confirmation.')
    const s = await this.select(loc, paths, f => f.worktree !== null && f.worktree !== 'deleted' && !f.untracked && !f.conflicted, 'discarding')
    if (!s.ok) return s
    const snap = await this.out(loc, ['stash', 'create'], 60_000)
    const sha = snap?.trim() || ''
    const e = await this.batched(loc, ['restore', '--worktree'], s.value.files.map(f => f.path))
    if (e) return fail(e)
    return ok({ discarded: s.value.files.map(f => f.path), ...(sha ? { recoverWith: `git stash apply ${sha}` } : {}) })
  }

  /** Brings back tracked files that were deleted: unstaged deletions from the index, staged deletions from HEAD. */
  async restoreDeleted(loc: Location, paths: unknown): Promise<Result<{ restored: string[] }>> {
    const s = await this.select(loc, paths, f => f.worktree === 'deleted' || (f.index === 'deleted' && f.worktree === null), 'restoring')
    if (!s.ok) return s
    const unstagedDel = s.value.files.filter(f => f.worktree === 'deleted').map(f => f.path)
    const stagedDel = s.value.files.filter(f => f.worktree !== 'deleted').map(f => f.path)
    if (unstagedDel.length) { const e = await this.batched(loc, ['restore', '--worktree'], unstagedDel); if (e) return fail(e) }
    if (stagedDel.length) { const e = await this.batched(loc, ['restore', '--source=HEAD', '--staged', '--worktree'], stagedDel); if (e) return fail(e) }
    return ok({ restored: s.value.files.map(f => f.path) })
  }

  /**
   * Deletes untracked files only. By default they go to the trash (recoverable) when `trash` is available; otherwise, or when
   * `permanent` is set, `git clean -f` removes them, which Git itself restricts to untracked, non-ignored files.
   */
  async deleteUntracked(loc: Location, paths: unknown, opts: { confirm: boolean; permanent?: boolean; trash?: TrashFn | null }): Promise<Result<DeleteUntrackedResult>> {
    if (opts.confirm !== true) return refuse('CONFIRM_REQUIRED', 'Deleting files needs your confirmation.')
    const s = await this.select(loc, paths, f => f.untracked, 'deleting')
    if (!s.ok) return s
    const rel = s.value.files.map(f => f.path)
    if (opts.trash && !opts.permanent) {
      const deleted: string[] = [], failed: { path: string; reason: string }[] = []
      for (const p of rel) { try { await opts.trash(loc, p); deleted.push(p) } catch (e) { failed.push({ path: p, reason: (e as Error).message }) } }
      return ok({ deleted, method: 'trash', failed })
    }
    if (!opts.permanent) return refuse('TRASH_UNAVAILABLE', 'The trash is not available for this repository, so these files cannot be moved there. They can be deleted permanently after a separate confirmation.')
    const failed: { path: string; reason: string }[] = []
    const deleted: string[] = []
    for (const part of chunks(rel)) {
      const r = await this.git(loc, [LIT, 'clean', '-f', '-q', '--', ...part], 120_000)
      if (r.code === 0) deleted.push(...part); else failed.push(...part.map(path => ({ path, reason: gitError(r, 'Git could not delete the file.').message })))
    }
    return ok({ deleted, method: 'permanent', failed })
  }

  /* ---------------------------------------------------------------- hunks */

  /**
   * Stages, unstages or discards one hunk. The diff is read again and the hunk must still have the same content (its id),
   * so a stale view can never apply the wrong lines. The patch goes to `git apply` on standard input.
   */
  async hunk(loc: Location, o: { path: string; area: 'staged' | 'unstaged'; hunkId: string; action: HunkAction; confirm?: boolean }): Promise<Result<{ path: string }>> {
    if (!safeRelativePath(o.path)) return refuse('BAD_PATH', 'That path is not valid.')
    if ((o.action === 'stage' || o.action === 'discard') && o.area !== 'unstaged') return refuse('BAD_ACTION', `A staged hunk cannot be ${o.action === 'stage' ? 'staged' : 'discarded'}.`)
    if (o.action === 'unstage' && o.area !== 'staged') return refuse('BAD_ACTION', 'Only a staged hunk can be unstaged.')
    if (o.action === 'discard' && o.confirm !== true) return refuse('CONFIRM_REQUIRED', 'Discarding changes needs your confirmation.')
    const common = ['--no-color', '--no-ext-diff', '--no-textconv', '-U3']
    const r = o.area === 'staged' ? await this.git(loc, [LIT, 'diff', '--cached', ...common, '--', o.path], 60_000) : await this.git(loc, [LIT, 'diff', ...common, '--', o.path], 60_000)
    if (r.code !== 0) return fail(gitError(r, 'Could not read the diff.'))
    const p = parseUnifiedDiff(r.stdout)
    if (!p.simple || p.truncated) return refuse('NOT_HUNKABLE', 'This file can only be staged or discarded as a whole.')
    const h = p.hunks.find(x => x.id === o.hunkId)
    if (!h) return refuse('STALE_HUNK', 'The file changed since this hunk was read. Refresh and try again.')
    const patch = p.header + h.raw
    const args = o.action === 'stage' ? ['apply', '--cached', '--recount', '--whitespace=nowarn', '-']
      : o.action === 'unstage' ? ['apply', '--cached', '--reverse', '--recount', '--whitespace=nowarn', '-']
        : ['apply', '--reverse', '--recount', '--whitespace=nowarn', '-']
    // Discarding a hunk is recoverable the same way discarding a file is.
    if (o.action === 'discard') await this.out(loc, ['stash', 'create'], 60_000)
    const a = await this.git(loc, args, 60_000, patch)
    if (a.code !== 0) return fail(gitError(a, 'Git could not apply the hunk. Nothing was changed.'))
    return ok({ path: o.path })
  }

  /* ---------------------------------------------------------------- commit */

  async commit(loc: Location, message: unknown): Promise<Result<CommitResult>> {
    if (typeof message !== 'string' || !message.trim()) return refuse('NO_MESSAGE', 'Write a commit message first.')
    if (message.length > 20_000) return refuse('BAD_MESSAGE', 'The commit message is too long.')
    const t = await this.read(loc)
    if (!t.ok) return t
    if (t.value.counts.conflicted) return refuse('CONFLICTS', 'Resolve the conflicts first. Conflicted files cannot be committed.', { blocker: { files: t.value.files.filter(f => f.conflicted).map(f => f.path), actions: [{ id: 'view-conflicts', label: 'View conflicts' }] } })
    if (!t.value.counts.staged) return refuse('NOTHING_STAGED', 'Nothing is staged. Stage the files to commit first.')
    const r = await this.git(loc, ['commit', '-F', '-'], 120_000, message.replace(/\r\n/g, '\n').trimEnd() + '\n')
    if (r.code !== 0) return fail(gitError(r, 'The commit was not created.'))
    const head = await this.out(loc, ['log', '-1', '--format=%H%x1f%h%x1f%s'])
    const [hash = '', short = '', summary = ''] = (head ?? '').trim().split('\x1f')
    return ok({ hash, short, summary })
  }
}

export { parseOverwritten }
