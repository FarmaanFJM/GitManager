import type { ChangeKind, FileChange } from '../shared/changes'

// How the working tree is shown and which actions a selection allows. Pure.

export type RowArea = 'conflict' | 'staged' | 'unstaged' | 'untracked'
export type Row = { key: string; area: RowArea; file: FileChange; kind: ChangeKind | 'untracked' | 'conflict' }

export const AREA_TITLE: Record<RowArea, string> = { conflict: 'Conflicts', staged: 'Staged', unstaged: 'Changes', untracked: 'Untracked' }
export const AREA_ORDER: RowArea[] = ['conflict', 'staged', 'unstaged', 'untracked']
export const KIND_LABEL: Record<Row['kind'], string> = {
  modified: 'Modified', added: 'Added', deleted: 'Deleted', renamed: 'Renamed', copied: 'Copied', typechange: 'Type changed', untracked: 'Untracked', conflict: 'Conflict',
}
export const KIND_LETTER: Record<Row['kind'], string> = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', copied: 'C', typechange: 'T', untracked: 'U', conflict: '!' }

export const rowKey = (area: RowArea, path: string) => `${area}:${path}`

/** A file with staged and unstaged changes appears in both groups, as in other Git tools; a conflicted or untracked file in one. */
export function buildRows(files: readonly FileChange[]): Record<RowArea, Row[]> {
  const out: Record<RowArea, Row[]> = { conflict: [], staged: [], unstaged: [], untracked: [] }
  for (const f of files) {
    if (f.conflicted) out.conflict.push({ key: rowKey('conflict', f.path), area: 'conflict', file: f, kind: 'conflict' })
    else if (f.untracked) out.untracked.push({ key: rowKey('untracked', f.path), area: 'untracked', file: f, kind: 'untracked' })
    else {
      if (f.index) out.staged.push({ key: rowKey('staged', f.path), area: 'staged', file: f, kind: f.index })
      if (f.worktree) out.unstaged.push({ key: rowKey('unstaged', f.path), area: 'unstaged', file: f, kind: f.worktree })
    }
  }
  return out
}

export const orderedKeys = (rows: Record<RowArea, Row[]>) => AREA_ORDER.flatMap(a => rows[a].map(r => r.key))

export type SelectionPlan = { stage: Row[]; unstage: Row[]; discard: Row[]; restore: Row[]; deleteUntracked: Row[] }

/** What each action may do with the selected rows. An action is offered only when at least one selected row is eligible for it. */
export function selectionPlan(selected: readonly Row[]): SelectionPlan {
  return {
    stage: selected.filter(r => r.area === 'unstaged' || r.area === 'untracked' || r.area === 'conflict'),
    unstage: selected.filter(r => r.area === 'staged'),
    discard: selected.filter(r => r.area === 'unstaged' && r.file.worktree !== null && r.file.worktree !== 'deleted'),
    restore: selected.filter(r => (r.area === 'unstaged' && r.file.worktree === 'deleted') || (r.area === 'staged' && r.file.index === 'deleted' && r.file.worktree === null)),
    deleteUntracked: selected.filter(r => r.area === 'untracked'),
  }
}

/** The path set sent to Git: every row's path once. */
export const pathsOf = (rows: readonly Row[]) => [...new Set(rows.map(r => r.file.path))]

/** Rows to show for a "Changes — N files" summary: conflicts first, then the rest, one line per file. */
export function summaryLines(files: readonly FileChange[], max = 5): { shown: { path: string; label: string }[]; more: number } {
  const label = (f: FileChange) => (f.conflicted ? 'Conflict' : f.untracked ? 'Untracked' : f.index && f.worktree ? 'Staged + modified' : f.index ? 'Staged' : KIND_LABEL[f.worktree!])
  const sorted = [...files].sort((a, b) => Number(b.conflicted) - Number(a.conflicted) || Number(!!b.index) - Number(!!a.index) || a.path.localeCompare(b.path))
  return { shown: sorted.slice(0, max).map(f => ({ path: f.path, label: label(f) })), more: Math.max(0, files.length - max) }
}
