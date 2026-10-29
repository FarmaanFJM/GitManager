import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { classifyRepo } from '../../src/core/storage/classify.js'
import { DEFAULT_POLICY } from '../../src/core/storage/config.js'
import { totalsOf } from '../../src/shared/storageTotals.js'

// A frozen copy of FarmaanFJM/GitManager's real Actions inventory (public data, 2026-10-29): 78 live artifacts, 27 copies of
// GitManager-windows-x64 (about 6.9 GB) from post-merge, pull request and failed runs, an open pull request, no releases or tags.
type Fx = { repo: string; defaultBranch: string; artifacts: any[]; runs: any[]; pulls: any[]; releases: any[]; tags: string[] }
const fx: Fx = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'gitmanager-inventory-2026-10-29.json'), 'utf8'))

function classify(now: string, tempDays = 7, over: Record<string, unknown> = {}) {
  const runs = new Map(fx.runs.map(r => [r.id, { id: r.id, name: r.name, path: r.path, status: r.status, conclusion: r.conclusion, event: r.event, runNumber: r.run_number, headBranch: r.head_branch, headSha: r.head_sha, htmlUrl: r.html_url, pullNumbers: r.pull_requests.map((p: any) => p.number) }]))
  const raws = fx.artifacts.map(a => ({ id: a.id, repo: fx.repo, name: a.name, sizeBytes: a.size_in_bytes, createdAt: a.created_at, expiresAt: a.expires_at, expired: a.expired, runId: a.workflow_run.id, headBranch: a.workflow_run.head_branch, headSha: a.workflow_run.head_sha }))
  return classifyRepo(raws, {
    now: Date.parse(now), policy: { ...DEFAULT_POLICY, tempDays, reportDays: Math.max(tempDays, 1) }, protectedRepo: false, pinned: new Set(), runs,
    pulls: fx.pulls.map(p => ({ number: p.number, headRef: p.head.ref, headSha: p.head.sha })), releases: [], releaseTags: new Set(fx.tags), defaultBranch: fx.defaultBranch, docs: '',
    context: { runs: true, pulls: true, releases: true, docs: true }, ...over,
  })
}
const installers = (list: ReturnType<typeof classify>) => list.filter(a => a.name === 'GitManager-windows-x64')

describe('real GitManager inventory', () => {
  it('has the shape the investigation found', () => {
    expect(fx.artifacts).toHaveLength(78)
    const inst = fx.artifacts.filter(a => a.name === 'GitManager-windows-x64' && !a.expired)
    expect(inst).toHaveLength(27)
    expect(inst.reduce((n, a) => n + a.size_in_bytes, 0)).toBeGreaterThan(7.3e9)
  })

  it('nothing is reclaimable on the day: every copy is younger than the retention age', () => {
    const c = classify('2026-10-29T16:00:00Z')
    expect(totalsOf(c).reclaimableBytes).toBe(0)
    const inst = installers(c)
    expect(inst.filter(a => a.reasonCode === 'recent')).toHaveLength(13)
    expect(inst.filter(a => a.reasonCode === 'failed-run')).toHaveLength(10) // failed or cancelled runs wait for supersession and age
  })

  it('a week later the superseded installers, including superseded failed builds, become candidates', () => {
    const c = classify('2026-11-06T16:00:00Z')
    const inst = installers(c)
    const cand = inst.filter(a => a.class === 'delete-candidate')
    expect(cand).toHaveLength(23)
    expect(cand.reduce((n, a) => n + a.sizeBytes, 0)).toBeGreaterThan(6.2e9)
    expect(new Set(cand.map(a => a.reasonCode))).toEqual(new Set(['superseded-build', 'superseded-failed']))
  })

  it('whatever the age, the newest builds on main and on the open pull request are kept', () => {
    const c = classify('2027-01-01T00:00:00Z', 1)
    const keep = installers(c).filter(a => a.class === 'keep')
    expect(keep.map(a => a.reasonCode).sort()).toEqual(['newest-default-branch', 'newest-default-branch', 'open-pr', 'open-pr'])
    const mainNewest = installers(c).filter(a => a.headBranch === 'main' && a.run?.conclusion === 'success').sort((a, b) => Date.parse(b.createdAt!) - Date.parse(a.createdAt!)).slice(0, 2)
    for (const a of mainNewest) expect(a.class).toBe('keep')
    const prNewest = installers(c).filter(a => a.headBranch === 'claude/magical-babbage-vwecrt').sort((a, b) => Date.parse(b.createdAt!) - Date.parse(a.createdAt!)).slice(0, 2)
    for (const a of prNewest) expect(a.class).toBe('keep')
  })

  it('without the pull request lookup nothing becomes a candidate', () => {
    const c = classify('2026-11-06T16:00:00Z', 7, { context: { runs: true, pulls: false, releases: true, docs: true } })
    expect(c.filter(a => a.class === 'delete-candidate')).toHaveLength(0)
    expect(c.some(a => a.reasonCode === 'context-incomplete')).toBe(true)
  })
})
