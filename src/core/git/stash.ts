import type { Location, OpError, Result } from '../../shared/types.js'
import type { StashApplyResult, StashEntry, StashFile, StashPreview, StashPushResult, FileDiff } from '../../shared/changes.js'
import { gitError, parseOverwritten } from './errors.js'
import { ChangesService, parseUnifiedDiff, safeRelativePath } from './changes.js'
import { defaultGitRun, type GitRun } from './ops.js'

// Stashes: list, preview, stash, apply, pop, drop. A stash is always addressed by its commit (sha) as well as its position, so a
// list that changed since the view was read (another stash pushed from a terminal) can never make an operation hit the wrong one.
// Applying never overwrites local work: a stash that touches a file with local changes is refused before Git runs.

const ok = <T>(value: T): Result<T> => ({ ok: true, value })
const fail = <T>(error: OpError): Result<T> => ({ ok: false, error })
const refuse = <T>(code: string, message: string, extra: Partial<OpError> = {}): Result<T> => fail({ code, message, ...extra })

const FORMAT = '--format=%gd%x1f%H%x1f%gs%x1f%ct%x1e'

export function parseStashList(out: string): Omit<StashEntry, 'hasUntracked'>[] {
  return out.split('\x1e').map(r => r.replace(/^\s+/, '')).filter(Boolean).map(r => {
    const [gd, sha, gs, ct] = r.split('\x1f')
    const m = /^(?:WIP on|On) ([^:]+): ([\s\S]*)$/.exec(gs ?? '')
    return { index: Number(/\{(\d+)\}/.exec(gd)?.[1] ?? 0), ref: gd, sha, message: (m ? m[2] : gs ?? '').trim(), branch: m ? m[1] : null, date: Number(ct) * 1000 }
  })
}

export class StashService {
  private readonly changes: ChangesService
  constructor(private readonly git: GitRun = defaultGitRun) { this.changes = new ChangesService(git) }

  private async out(loc: Location, args: string[], t = 30_000) { const r = await this.git(loc, args, t); return r.code === 0 ? r.stdout : null }

  async list(loc: Location): Promise<Result<StashEntry[]>> {
    const r = await this.git(loc, ['stash', 'list', FORMAT], 30_000)
    if (r.code !== 0) return fail(gitError(r, 'Could not list the stashes.'))
    const base = parseStashList(r.stdout)
    const entries: StashEntry[] = []
    for (const e of base) entries.push({ ...e, hasUntracked: (await this.git(loc, ['rev-parse', '-q', '--verify', `${e.sha}^3`], 10_000)).code === 0 })
    return ok(entries)
  }

  /** The stash the caller means: its position must still hold the commit the view showed. */
  private async resolve(loc: Location, index: unknown, sha: unknown): Promise<Result<StashEntry>> {
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > 10_000 || typeof sha !== 'string' || !/^[0-9a-f]{40,64}$/.test(sha)) return refuse('BAD_STASH', 'That stash is not valid.')
    const l = await this.list(loc)
    if (!l.ok) return l
    const e = l.value.find(x => x.index === index)
    if (!e || e.sha !== sha) return refuse('STASH_CHANGED', 'The list of stashes changed since it was read. Refresh and choose the stash again.')
    return ok(e)
  }

  private async files(loc: Location, e: StashEntry): Promise<StashFile[]> {
    const tracked = await this.out(loc, ['diff', '--name-status', '-M', '-z', `${e.sha}^1`, e.sha, '--'])
    const files: StashFile[] = []
    const f = (tracked ?? '').split('\0')
    for (let i = 0; i < f.length; i++) {
      const st = f[i]
      if (!st) continue
      const k = st[0] as StashFile['status']
      if (k === 'R' || k === 'C') { files.push({ status: k, from: f[i + 1], path: f[i + 2], untracked: false }); i += 2 } else { files.push({ status: k, path: f[i + 1], untracked: false }); i += 1 }
    }
    if (e.hasUntracked) {
      const u = await this.out(loc, ['ls-tree', '-r', '--name-only', '-z', `${e.sha}^3`])
      for (const p of (u ?? '').split('\0').filter(Boolean)) files.push({ status: 'A', path: p, untracked: true })
    }
    return files
  }

  async preview(loc: Location, index: unknown, sha: unknown): Promise<Result<StashPreview>> {
    const e = await this.resolve(loc, index, sha)
    if (!e.ok) return e
    const [files, stat] = await Promise.all([this.files(loc, e.value), this.out(loc, ['diff', '--shortstat', `${e.value.sha}^1`, e.value.sha, '--'])])
    return ok({ entry: e.value, files, stat: (stat ?? '').trim() })
  }

  async fileDiff(loc: Location, index: unknown, sha: unknown, path: string, untracked: boolean): Promise<Result<FileDiff>> {
    if (!safeRelativePath(path)) return refuse('BAD_PATH', 'That path is not valid.')
    const e = await this.resolve(loc, index, sha)
    if (!e.ok) return e
    const r = untracked
      ? await this.git(loc, ['--literal-pathspecs', 'show', '--format=', '--no-color', '--no-ext-diff', '-U3', `${e.value.sha}^3`, '--', path], 60_000)
      : await this.git(loc, ['--literal-pathspecs', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '-U3', `${e.value.sha}^1`, e.value.sha, '--', path], 60_000)
    if (r.code !== 0) return fail(gitError(r, 'Could not read the stash diff.'))
    const p = parseUnifiedDiff(r.stdout)
    return ok({ path, area: 'staged', binary: p.binary, added: p.added, removed: p.removed, truncated: p.truncated, hunkable: false, hunks: p.hunks.map(h => ({ id: h.id, header: h.header, lines: h.lines })), ...(p.binary ? { notice: 'Binary file: no text diff.' } : {}) })
  }

  async push(loc: Location, o: { message?: unknown; includeUntracked?: unknown }): Promise<Result<StashPushResult>> {
    const message = typeof o.message === 'string' ? o.message.trim() : ''
    // eslint-disable-next-line no-control-regex
    if (message.length > 300 || /[\x00-\x1f]/.test(message)) return refuse('BAD_MESSAGE', 'The stash message must be one line of at most 300 characters.')
    const includeUntracked = o.includeUntracked === true
    const t = await this.changes.read(loc)
    if (!t.ok) return t
    const c = t.value.counts
    if (c.conflicted) return refuse('CONFLICTS', 'Resolve the conflicts before stashing.', { blocker: { files: t.value.files.filter(f => f.conflicted).map(f => f.path), actions: [{ id: 'view-conflicts', label: 'View conflicts' }] } })
    if (!t.value.hasCommits) return refuse('NO_COMMITS', 'A stash needs at least one commit. Commit first.')
    if (!c.staged && !c.unstaged && !(includeUntracked && c.untracked)) {
      return refuse('NOTHING_TO_STASH', c.untracked && !includeUntracked ? 'Only untracked files changed. Turn on "Include untracked files" to stash them.' : 'There are no changes to stash.')
    }
    const before = await this.list(loc)
    const r = await this.git(loc, ['stash', 'push', ...(includeUntracked ? ['--include-untracked'] : []), ...(message ? ['-m', message] : [])], 120_000)
    if (r.code !== 0) return fail(gitError(r, 'The changes were not stashed. Nothing was changed.'))
    const after = await this.list(loc)
    const top = after.ok ? after.value[0] ?? null : null
    const created = top && !(before.ok && before.value[0]?.sha === top.sha) ? top : null
    return ok({ entry: created })
  }

  /** Files the stash would write that also have local changes: applying over them could lose either side. */
  private async overlap(loc: Location, e: StashEntry): Promise<{ overlap: string[]; conflicted: string[] } | OpError> {
    const [t, files] = await Promise.all([this.changes.read(loc), this.files(loc, e)])
    if (!t.ok) return t.error
    const touched = new Set(files.flatMap(f => [f.path, ...(f.from ? [f.from] : [])]))
    const local = t.value.files
    return { overlap: local.filter(f => touched.has(f.path) || (f.from && touched.has(f.from))).map(f => f.path), conflicted: local.filter(f => f.conflicted).map(f => f.path) }
  }

  async apply(loc: Location, index: unknown, sha: unknown, pop: boolean): Promise<Result<StashApplyResult>> {
    const e = await this.resolve(loc, index, sha)
    if (!e.ok) return e
    const o = await this.overlap(loc, e.value)
    if ('code' in o) return fail(o)
    if (o.conflicted.length) return refuse('CONFLICTS', 'Resolve the conflicts before applying a stash.', { blocker: { files: o.conflicted, actions: [{ id: 'view-conflicts', label: 'View conflicts' }] } })
    if (o.overlap.length) {
      return refuse('STASH_OVERLAP', `This stash changes ${o.overlap.length === 1 ? 'a file' : `${o.overlap.length} files`} that already ${o.overlap.length === 1 ? 'has' : 'have'} local changes. Nothing was applied, so neither side is lost.`,
        { blocker: { files: o.overlap, actions: [{ id: 'view-changes', label: 'View Changes' }, { id: 'stash', label: 'Stash Changes' }] } })
    }
    const r = await this.git(loc, ['stash', pop ? 'pop' : 'apply', '--quiet', e.value.ref], 120_000)
    const after = await this.changes.read(loc)
    const conflicts = after.ok ? after.value.files.filter(f => f.conflicted).map(f => f.path) : []
    if (r.code !== 0 && !conflicts.length) {
      const err = gitError(r, 'The stash was not applied.')
      const files = parseOverwritten(`${r.stderr}\n${r.stdout}`)
      return fail(err.code === 'GIT_FAILED' && !files.length ? err : { ...err, ...(files.length ? { blocker: { files, actions: [{ id: 'view-changes' as const, label: 'View Changes' }, { id: 'stash' as const, label: 'Stash Changes' }] } } : {}) })
    }
    // Git keeps the stash when a pop ends in conflicts; so does this.
    const still = pop && conflicts.length ? true : pop ? await this.stillThere(loc, e.value) : true
    return ok({ applied: true, conflicts, dropped: pop && !still, sha: e.value.sha })
  }

  private async stillThere(loc: Location, e: StashEntry) { const l = await this.list(loc); return l.ok && l.value.some(x => x.sha === e.sha) }

  /** Removes the stash. The commit stays in the object database for a while: `git stash apply <sha>` brings it back. */
  async drop(loc: Location, index: unknown, sha: unknown, confirm: boolean): Promise<Result<{ sha: string; recoverWith: string }>> {
    if (confirm !== true) return refuse('CONFIRM_REQUIRED', 'Dropping a stash needs your confirmation.')
    const e = await this.resolve(loc, index, sha)
    if (!e.ok) return e
    const r = await this.git(loc, ['stash', 'drop', '--quiet', e.value.ref], 30_000)
    if (r.code !== 0) return fail(gitError(r, 'The stash was not dropped.'))
    return ok({ sha: e.value.sha, recoverWith: `git stash apply ${e.value.sha}` })
  }
}
