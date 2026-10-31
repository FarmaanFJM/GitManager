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

function classify(now: string, over: Record<string, unknown> = {}, policy: Record<string, unknown> = {}) {
  const runs = new Map(fx.runs.map(r => [r.id, { id: r.id, name: r.name, path: r.path, status: r.status, conclusion: r.conclusion, event: r.event, runNumber: r.run_number, headBranch: r.head_branch, headSha: r.head_sha, htmlUrl: r.html_url, pullNumbers: r.pull_requests.map((p: any) => p.number) }]))
  const raws = fx.artifacts.map(a => ({ id: a.id, repo: fx.repo, name: a.name, sizeBytes: a.size_in_bytes, createdAt: a.created_at, expiresAt: a.expires_at, expired: a.expired, runId: a.workflow_run.id, headBranch: a.workflow_run.head_branch, headSha: a.workflow_run.head_sha }))
  return classifyRepo(raws, {
    now: Date.parse(now), policy: { ...DEFAULT_POLICY, ...policy }, protectedRepo: false, pinned: new Set(), runs,
    pulls: fx.pulls.map(p => ({ number: p.number, headRef: p.head.ref, headSha: p.head.sha })), releases: [], releaseTags: new Set(fx.tags), defaultBranch: fx.defaultBranch, docs: '',
    context: { runs: true, pulls: true, releases: true, docs: true }, ...over,
  })
}
const installers = (list: ReturnType<typeof classify>) => list.filter(a => a.name === 'GitManager-windows-x64')
const NOW = '2026-10-29T16:00:00Z'

describe('real GitManager inventory', () => {
  it('has the shape the investigation found', () => {
    expect(fx.artifacts).toHaveLength(78)
    const inst = fx.artifacts.filter(a => a.name === 'GitManager-windows-x64' && !a.expired)
    expect(inst).toHaveLength(27)
    expect(inst.reduce((n, a) => n + a.size_in_bytes, 0)).toBeGreaterThan(7.3e9)
  })

  it('superseded installers are candidates immediately, although every copy is under two days old', () => {
    const c = classify(NOW)
    const cand = installers(c).filter(a => a.class === 'delete-candidate')
    // Independently computed from GitHub's data: per workflow, name and branch, successful builds beyond the newest two
    // (main 2 -> 0, claude/magical-babbage-vwecrt 4 -> 2, claude/serene-babbage-f4pgo9 11 -> 9).
    expect(cand).toHaveLength(11)
    expect(cand.reduce((n, a) => n + a.sizeBytes, 0)).toBe(3_021_250_341)
    expect(new Set(cand.map(a => a.reasonCode))).toEqual(new Set(['superseded-build']))
    expect(totalsOf(c).reclaimableBytes).toBe(3_040_248_255)
  })

  it('the newest two builds of main, of the open pull request branch and of the other branch are kept', () => {
    const c = classify(NOW)
    const by = (branch: string) => installers(c).filter(a => a.headBranch === branch && a.run?.conclusion === 'success').sort((a, b) => Date.parse(b.createdAt!) - Date.parse(a.createdAt!))
    for (const branch of ['main', 'claude/magical-babbage-vwecrt', 'claude/serene-babbage-f4pgo9']) {
      const list = by(branch)
      expect(list.slice(0, 2).every(a => a.class === 'keep'), branch).toBe(true)
      expect(list.slice(2).every(a => a.class === 'delete-candidate'), branch).toBe(true)
    }
    expect(by('claude/magical-babbage-vwecrt').slice(0, 2).every(a => a.reasonCode === 'open-pr')).toBe(true)
  })

  it('failed and cancelled output is Review by default and offered only when the policy allows it', () => {
    const c = classify(NOW)
    expect(installers(c).filter(a => a.reasonCode === 'failed-superseded')).toHaveLength(10) // Review, flagged for deliberate manual review
    const allowed = classify(NOW, {}, { failedOutput: 'delete-superseded', failedGraceDays: 0 })
    expect(installers(allowed).filter(a => a.reasonCode === 'superseded-failed')).toHaveLength(10)
    const graced = classify(NOW, {}, { failedOutput: 'delete-superseded', failedGraceDays: 14 })
    expect(installers(graced).filter(a => a.reasonCode === 'superseded-failed')).toHaveLength(0)
  })

  it('an explicit grace period retains them until it has passed', () => {
    const held = classify(NOW, {}, { graceDays: 3, reportGraceDays: 3 })
    expect(totalsOf(held).reclaimableBytes).toBe(0)
    expect(installers(held).filter(a => a.reasonCode === 'grace-period')).toHaveLength(11)
    const later = classify('2026-11-02T16:00:00Z', {}, { graceDays: 3, reportGraceDays: 3 })
    expect(installers(later).filter(a => a.class === 'delete-candidate')).toHaveLength(11)
  })

  it('without the pull request lookup nothing becomes a candidate', () => {
    const c = classify(NOW, { context: { runs: true, pulls: false, releases: true, docs: true } })
    expect(c.filter(a => a.class === 'delete-candidate')).toHaveLength(0)
    expect(c.some(a => a.reasonCode === 'context-incomplete')).toBe(true)
  })
})
