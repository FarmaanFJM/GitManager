import type { LocalBranchInfo } from '../shared/changes'
import type { BranchRow } from '../shared/types'
import { add, only, type Selection } from './selection'

// Branch selection rules for the Branches view and the cleanup dialog. Pure.

/** Local branches that are shown (remote-tracking branches are never selectable here: deleting them is not offered). */
export const visibleLocal = (rows: readonly BranchRow[]) => rows.filter(r => r.kind === 'local')

/** "Select all visible": every local branch the current search and filter show. Blocked ones are included so the dialog can explain them. */
export const selectAllVisible = (sel: Selection, rows: readonly BranchRow[]): Selection => add(sel, visibleLocal(rows).map(r => r.name))

/** "Select all eligible": every local branch that can be deleted without force. Branches with commits only here are never added in bulk. */
export const eligibleNames = (analysis: readonly LocalBranchInfo[]) => analysis.filter(b => b.tier === 'safe').map(b => b.name)
export const selectAllEligible = (analysis: readonly LocalBranchInfo[]): Selection => only(eligibleNames(analysis))

export type Groups = { safe: LocalBranchInfo[]; force: LocalBranchInfo[]; blocked: LocalBranchInfo[] }
export const groupBranches = (analysis: readonly LocalBranchInfo[]): Groups => ({
  safe: analysis.filter(b => b.tier === 'safe'), force: analysis.filter(b => b.tier === 'force'), blocked: analysis.filter(b => b.tier === 'blocked'),
})

/** The items sent to the backend for the selected names: the commit the user saw, and force only for branches that need it. */
export function deleteItems(analysis: readonly LocalBranchInfo[], selected: ReadonlySet<string>, acknowledgedForce: boolean) {
  return analysis.filter(b => selected.has(b.name) && b.tier !== 'blocked').map(b => ({ name: b.name, sha: b.sha, force: b.tier === 'force' && acknowledgedForce }))
}

/** A selected branch the dialog should explain instead of deleting. */
export const blockedSelection = (analysis: readonly LocalBranchInfo[], selected: ReadonlySet<string>) => analysis.filter(b => selected.has(b.name) && b.tier === 'blocked')

/** Commits that exist only on this computer across the selected force branches (what the confirmation counts). */
export const riskyCommits = (analysis: readonly LocalBranchInfo[], selected: ReadonlySet<string>) => analysis.filter(b => selected.has(b.name) && b.tier === 'force').reduce((n, b) => n + b.onlyHereCount, 0)
