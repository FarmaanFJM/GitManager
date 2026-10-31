// Wording of the repository removal and deletion flows, kept free of React so it is unit-tested directly.
import type { DeletionReport } from '../shared/types'

/** The facts the user needs before a folder is deleted, in the words used for them. Pure, so the wording is tested. */
export function deletionRows(r: DeletionReport): { label: string; value: string; warn?: boolean }[] {
  const c = r.facts.changes, f = r.facts
  const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`
  const rows: { label: string; value: string; warn?: boolean }[] = [
    { label: 'Folder', value: r.display },
    { label: 'Where', value: r.environment },
    { label: 'Uncommitted', value: c === null ? 'Could not be read' : c.staged + c.unstaged + c.conflicted > 0 ? `Yes (${[c.staged ? `${c.staged} staged` : '', c.unstaged ? `${c.unstaged} modified` : '', c.conflicted ? `${c.conflicted} conflicted` : ''].filter(Boolean).join(', ')})` : 'None', warn: c === null || c.staged + c.unstaged + c.conflicted > 0 },
    { label: 'Untracked', value: c === null ? 'Could not be read' : c.untracked > 0 ? `Yes (${n(c.untracked, 'file')})` : 'None', warn: c === null || c.untracked > 0 },
    { label: 'Unpushed', value: f.upstream !== null ? ((f.ahead ?? 0) > 0 ? `${n(f.ahead ?? 0, 'commit')} not on ${f.upstream}` : `None (up to date with ${f.upstream})`) : f.localOnlyCommits === null ? 'Could not be determined' : f.localOnlyCommits > 0 ? `No upstream; ${n(f.localOnlyCommits, 'commit')} ${f.localOnlyCommits === 1 ? 'exists' : 'exist'} on no remote` : 'No upstream; every commit is on a remote', warn: (f.ahead ?? 0) > 0 || (f.upstream === null && (f.localOnlyCommits ?? 0) > 0) },
  ]
  if ((f.stashes ?? 0) > 0) rows.push({ label: 'Stashes', value: n(f.stashes ?? 0, 'stash', 'stashes'), warn: true })
  rows.push({ label: 'Services', value: r.runningServices.length ? `Running: ${r.runningServices.join(', ')}` : 'None running', warn: r.runningServices.length > 0 })
  const shared: string[] = []
  if (r.nestedRepos.length) shared.push(`${n(r.nestedRepos.length, 'nested repository', 'nested repositories')} (${r.nestedRepos.slice(0, 3).join(', ')}${r.nestedRepos.length > 3 ? ', ...' : ''})`)
  if (r.linkedWorktrees.length) shared.push(`${n(r.linkedWorktrees.length, 'linked worktree')}`)
  if (r.worktreeOf) shared.push(`Linked worktree of ${r.worktreeOf}`)
  if (r.submodules.length) shared.push(n(r.submodules.length, 'submodule'))
  rows.push({ label: 'Also in it', value: shared.length ? shared.join('; ') : 'No nested repositories, worktrees or submodules', warn: shared.length > 0 })
  return rows
}

/** Words for the two destructive buttons, kept apart so Remove and Delete are never confused. */
export const removeWords = { title: (name: string) => `Remove ${name} from GitManager?`, confirm: 'Remove from GitManager' }
export const deleteWords = { title: (name: string) => `Delete the local folder of ${name}?`, confirm: (trash: string) => `Move folder to ${trash}`, permanent: 'Delete permanently' }

