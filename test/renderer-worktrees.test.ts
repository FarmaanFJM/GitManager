import { describe, expect, it, vi } from 'vitest'

// The renderer modules read the preload bridge at import time.
vi.hoisted(() => { (globalThis as unknown as { window: unknown }).window = { gitmanager: {}, addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) } })
import type { StaleBranch, SyncPlan, WorktreeInfo, WorktreeRemovalCheck } from '../src/shared/gitflow'
import type { Branch } from '../src/shared/types'
import { buildSelection, defaultSelected, deleteLabel, effectiveKind, finishText, isNothingToDo, planTitle, resultTitle } from '../src/renderer/SyncDialog'
import { availableBranches, canRemove, changedCount, discardLabel, hasPrunable, profileIdsAt, removeConsequences, samePath, shortPath, statusText } from '../src/renderer/Worktrees'

const stale = (o: Partial<StaleBranch> & { name: string }): StaleBranch => ({ sha: 'abc', upstream: `origin/${o.name}`, kind: 'delete-safe', reason: '', ahead: 0, uniqueCommits: [], ...o })
const plan = (s: StaleBranch[], o: Partial<SyncPlan> = {}): SyncPlan => ({
  remote: 'origin', defaultBranch: 'main', baseRef: 'refs/remotes/origin/main', current: 'main', detached: false, pruned: [], stale: s, kept: [],
  summary: { text: `${s.length} stale branches found`, counts: { stale: s.length, deleteSafe: 0, needsReview: 0, protected: 0, kept: 0, pruned: 0 } }, fetchedAt: '', ...o,
})
const wt = (o: Partial<WorktreeInfo> = {}): WorktreeInfo => ({ path: '/r', head: 'x', branch: 'main', detached: false, bare: false, locked: false, prunable: false, main: true, isCurrent: true, ...o })

describe('sync selection', () => {
  const p = plan([stale({ name: 'a' }), stale({ name: 'b', kind: 'needs-review', ahead: 2 }), stale({ name: 'c', kind: 'protected', worktree: { path: '/w', current: false } })])
  it('preselects delete-safe only', () => { expect(defaultSelected(p)).toEqual(['a']) })
  it('forces only selected needs-review and ignores protected', () => {
    expect(buildSelection(p, new Set(['a', 'b', 'c']), false)).toEqual({ branches: ['a', 'b'], forceBranches: ['b'] })
    expect(buildSelection(p, new Set(['a']), false)).toEqual({ branches: ['a'] })
  })
  it('a stale current branch is deletable only with the switch', () => {
    const cur = stale({ name: 'x', kind: 'protected', wouldBe: 'delete-safe', worktree: { path: '/r', current: true } })
    const q = plan([cur], { switchTo: { branch: 'main', safe: true } })
    expect(effectiveKind(cur, q, false)).toBe('protected')
    expect(effectiveKind(cur, q, true)).toBe('delete-safe')
    expect(buildSelection(q, new Set(['x']), true)).toEqual({ branches: ['x'], switchToDefault: true })
    expect(effectiveKind(cur, plan([cur], { switchTo: { branch: 'main', safe: false, reason: 'dirty' } }), true)).toBe('protected')
  })
  it('texts', () => {
    expect(isNothingToDo(plan([]))).toBe(true)
    expect(planTitle(p)).toBe('3 stale branches found')
    expect(deleteLabel(1)).toBe('Delete 1 branch'); expect(deleteLabel(3)).toBe('Delete 3 branches'); expect(deleteLabel(0)).toBe('Delete branches')
    const r = { deleted: [{ name: 'a', sha: 's', forced: false, recoverWith: 'x' }, { name: 'b', sha: 's', forced: false, recoverWith: 'y' }], failed: [], refreshed: true as const }
    expect(finishText(r)).toBe('Synced'); expect(resultTitle(r)).toBe('2 deleted')
    const f = { ...r, failed: [{ name: 'c', code: 'X', reason: 'r' }] }
    expect(finishText(f)).toBe('2 deleted, 1 failed')
  })
})

describe('worktree helpers', () => {
  const br = (name: string, kind: Branch['kind'] = 'local'): Branch => ({ name, kind, current: false, date: 0 })
  it('excludes branches already checked out and remote branches', () => {
    expect(availableBranches([br('main'), br('dev'), br('origin/dev', 'remote')], [wt({ branch: 'main' }), wt({ branch: null, detached: true })]).map(b => b.name)).toEqual(['dev'])
  })
  it('status text', () => {
    expect(statusText(wt({ changes: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 } }))).toBe('Clean')
    expect(statusText(wt({ changes: { staged: 1, unstaged: 1, untracked: 1, conflicted: 0 }, locked: true }), 2)).toBe('3 changed files, Locked, 2 running')
    expect(statusText(wt({ prunable: true }))).toBe('Prunable')
    expect(hasPrunable([wt(), wt({ prunable: true })])).toBe(true)
  })
  it('paths', () => {
    expect(samePath('C:\\a\\b\\', 'c:/A/b')).toBe(true); expect(samePath('/a/B', '/a/b')).toBe(false)
    expect(shortPath('/a/b')).toBe('/a/b')
    expect(shortPath('/home/user/projects/very/long/folder/name/repo.worktrees/feature-x')).toBe('/…/repo.worktrees/feature-x')
  })
  it('profiles bound to a worktree', () => {
    const ps = [{ id: '1', repoId: 'r' }, { id: '2', repoId: 'r', worktreePath: '/w' }, { id: '3', repoId: 'o' }]
    expect([...profileIdsAt(wt({ path: '/r', isCurrent: true }), ps, 'r')]).toEqual(['1'])
    expect([...profileIdsAt(wt({ path: '/w/', isCurrent: false }), ps, 'r')]).toEqual(['2'])
  })
  it('removal gating', () => {
    const w = wt({ isCurrent: false, main: false, changes: { staged: 0, unstaged: 2, untracked: 0, conflicted: 0 } })
    const dirty: WorktreeRemovalCheck = { worktree: w, unpushed: 1, services: [], blockers: [{ code: 'dirty', message: 'm', overridable: true }] }
    expect(changedCount(w)).toBe(2)
    expect(canRemove(dirty, new Set())).toBe(false); expect(canRemove(dirty, new Set(['dirty']))).toBe(true)
    expect(discardLabel(dirty.blockers[0], w)).toBe('Discard 2 changed files')
    expect(canRemove({ ...dirty, blockers: [{ code: 'services', message: 'm', overridable: false }] }, new Set(['services']))).toBe(false)
    expect(removeConsequences(dirty)).toEqual(['Deletes the folder and its checkout', 'Branch main is kept', '1 commit not on any remote'])
  })
})
