import { describe, expect, it } from 'vitest'
import { buildRows, orderedKeys, pathsOf, selectionPlan, summaryLines } from '../src/renderer/changesModel'
import { deleteItems, eligibleNames, groupBranches, riskyCommits, selectAllEligible, selectAllVisible } from '../src/renderer/branchSelection'
import { languageOf, tokenize } from '../src/renderer/highlight'
import * as sel from '../src/renderer/selection'
import { installedMonospaceFonts } from '../src/renderer/fonts'
import type { FileChange, LocalBranchInfo } from '../src/shared/changes'
import type { BranchRow } from '../src/shared/types'

const f = (path: string, o: Partial<FileChange> = {}): FileChange => ({ path, index: null, worktree: null, untracked: false, conflicted: false, submodule: false, ...o })

describe('changes model', () => {
  const files = [f('a.ts', { worktree: 'modified' }), f('b.ts', { index: 'modified', worktree: 'modified' }), f('c.ts', { index: 'added' }), f('d.ts', { worktree: 'deleted' }),
    f('e.ts', { index: 'deleted' }), f('new.ts', { untracked: true }), f('x.ts', { conflicted: true, conflictKind: 'both modified' })]
  const rows = buildRows(files)

  it('groups into conflicts, staged, changes and untracked; a file with both sides appears twice', () => {
    expect(rows.conflict.map(r => r.file.path)).toEqual(['x.ts'])
    expect(rows.staged.map(r => r.file.path)).toEqual(['b.ts', 'c.ts', 'e.ts'])
    expect(rows.unstaged.map(r => r.file.path)).toEqual(['a.ts', 'b.ts', 'd.ts'])
    expect(rows.untracked.map(r => r.file.path)).toEqual(['new.ts'])
    expect(new Set(orderedKeys(rows)).size).toBe(8) // keys are unique per area and path
  })

  it('each action is offered only for the rows it applies to', () => {
    const all = Object.values(rows).flat()
    const plan = selectionPlan(all)
    expect(plan.stage.map(r => r.key)).toEqual(['conflict:x.ts', 'unstaged:a.ts', 'unstaged:b.ts', 'unstaged:d.ts', 'untracked:new.ts'].sort((a, b) => all.findIndex(r => r.key === a) - all.findIndex(r => r.key === b)))
    expect(plan.unstage.map(r => r.file.path)).toEqual(['b.ts', 'c.ts', 'e.ts'])
    expect(plan.discard.map(r => r.file.path)).toEqual(['a.ts', 'b.ts']) // a deletion is restored, not discarded
    expect(plan.restore.map(r => r.file.path).sort()).toEqual(['d.ts', 'e.ts'])
    expect(plan.deleteUntracked.map(r => r.file.path)).toEqual(['new.ts'])
    expect(selectionPlan([rows.staged[1]])).toMatchObject({ stage: [], discard: [], restore: [], deleteUntracked: [] })
    expect(pathsOf([rows.staged[0], rows.unstaged[1]])).toEqual(['b.ts'])
  })

  it('summarizes for the overview', () => {
    const s = summaryLines(files, 3)
    expect(s.shown.map(x => x.label)).toEqual(['Conflict', 'Staged + modified', 'Staged'])
    expect(s.more).toBe(4)
  })
})

describe('selection', () => {
  const order = ['a', 'b', 'c', 'd', 'e']
  it('toggles, selects ranges from the last click, and keeps the selection when the list is filtered', () => {
    let s = sel.click(sel.emptySelection(), 'b', order)
    s = sel.click(s, 'd', order, { range: true })
    expect([...s.keys].sort()).toEqual(['b', 'c', 'd'])
    s = sel.click(s, 'c', order)
    expect([...s.keys].sort()).toEqual(['b', 'd'])
    s = sel.click(s, 'a', order, { range: true }) // range from the anchor (c) to a
    expect([...s.keys].sort()).toEqual(['a', 'b', 'c', 'd'])
    expect(sel.state(s, ['a', 'b'])).toBe('all'); expect(sel.state(s, ['d', 'e'])).toBe('some'); expect(sel.state(s, ['e'])).toBe('none')
    const kept = sel.prune(s, ['b', 'c', 'e'])
    expect([...kept.keys].sort()).toEqual(['b', 'c'])
    expect(sel.remove(s, ['a', 'b']).keys.has('c')).toBe(true)
    expect(sel.emptySelection().keys.size).toBe(0)
  })
})

const row = (name: string, kind: BranchRow['kind'] = 'local'): BranchRow => ({ ref: `refs/heads/${name}`, name, kind, oid: '1', short: '1', current: false, isBase: false, upstreamState: 'none', upstreamAhead: 0, upstreamBehind: 0, ahead: 0, behind: 0, compare: 'up-to-date', date: 0, subject: '', author: '' })
const info = (name: string, tier: LocalBranchInfo['tier'], onlyHereCount = 0): LocalBranchInfo => ({ name, sha: name.padEnd(40, '0'), short: name, current: false, upstreamState: 'none', category: 'merged', tier, uniqueCount: 0, onlyHereCount, onRemotes: [], subject: '', date: 0 })

describe('branch selection', () => {
  it('select all visible takes only the local branches that match the filter', () => {
    const visible = [row('a'), row('b'), row('origin/c', 'remote')]
    expect([...selectAllVisible(sel.click(sel.emptySelection(), 'z', ['z']), visible).keys].sort()).toEqual(['a', 'b', 'z'])
  })
  it('select all eligible takes every safe branch, never branches with unique commits or blocked ones', () => {
    const a = [info('m1', 'safe'), info('m2', 'safe'), info('u1', 'force', 3), info('main', 'blocked')]
    expect(eligibleNames(a)).toEqual(['m1', 'm2'])
    expect([...selectAllEligible(a).keys]).toEqual(['m1', 'm2'])
    const g = groupBranches(a)
    expect([g.safe.length, g.force.length, g.blocked.length]).toEqual([2, 1, 1])
  })
  it('builds the delete request: force only for acknowledged branches that need it; blocked ones never', () => {
    const a = [info('m1', 'safe'), info('u1', 'force', 3), info('u2', 'force', 2), info('main', 'blocked')]
    const s = new Set(['m1', 'u1', 'u2', 'main'])
    expect(deleteItems(a, s, false).map(i => [i.name, i.force])).toEqual([['m1', false], ['u1', false], ['u2', false]])
    expect(deleteItems(a, s, true).map(i => [i.name, i.force])).toEqual([['m1', false], ['u1', true], ['u2', true]])
    expect(riskyCommits(a, s)).toBe(5)
    expect(riskyCommits(a, new Set(['m1']))).toBe(0)
  })
})

describe('syntax highlighting', () => {
  const join = (t: ReturnType<typeof tokenize>) => t.map(x => x.text).join('')
  it('recognizes languages by file name', () => {
    expect([languageOf('src/App.tsx'), languageOf('a/b/style.css'), languageOf('Dockerfile'), languageOf('x.ps1'), languageOf('pom.xml'), languageOf('README.md'), languageOf('data.bin')]).toEqual(['clike', 'css', 'hash', 'hash', 'markup', 'markdown', null])
  })
  it('tokens always add up to the line', () => {
    for (const [line, lang] of [['const x = "a\\"b" + 12 // note', 'clike'], ['  "name": "gm", "n": 3, "ok": true', 'json'], ['a { color: #fff; margin: 4px } /* c */', 'css'], ['<div class="x">hi</div>', 'markup'], ['# comment', 'hash'], ['', 'clike'], ['unterminated "str', 'clike']] as const) expect(join(tokenize(line, lang))).toBe(line)
  })
  it('classifies keywords, strings, numbers and comments', () => {
    const t = tokenize('const x = "a" + 12 // note', 'clike')
    expect(t.filter(x => x.cls).map(x => [x.text, x.cls])).toEqual([['const', 'kw'], ['"a"', 'str'], ['12', 'num'], ['// note', 'com']])
    expect(tokenize('<div id="a">', 'markup').filter(x => x.cls).map(x => x.cls)).toEqual(['tag', 'str', 'tag'])
    expect(tokenize('plain text', null)).toEqual([{ text: 'plain text' }])
  })
})

describe('fonts', () => {
  it('reports no fonts when there is no canvas (tests, headless)', () => { expect(installedMonospaceFonts()).toEqual([]) })
})
