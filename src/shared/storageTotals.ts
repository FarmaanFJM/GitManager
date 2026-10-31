// Pure arithmetic over a scan, used by the main process (alerts, scheduler) and the interface (overview, tables).
import type { Artifact, ArtifactCategory, ArtifactClass, RepoInventory, Snapshot } from './storage.js'

export type Bucket = { count: number; bytes: number }
export type Totals = {
  artifacts: number // not expired
  expired: number
  retainedBytes: number // current stored bytes: artifacts that have not expired
  byClass: Record<ArtifactClass, Bucket>
  byCategory: Record<ArtifactCategory, Bucket>
  /** Verified delete candidates in repositories the user can delete from. */
  reclaimableBytes: number
  /** Superseded builds that an optional grace period still retains: eligible later, not now. */
  graceBytes: number
  graceCount: number
}

const emptyBucket = (): Bucket => ({ count: 0, bytes: 0 })
export const CLASSES: ArtifactClass[] = ['protected', 'keep', 'review', 'delete-candidate', 'expired']
export const CATEGORIES: ArtifactCategory[] = ['installer', 'build', 'report', 'logs', 'evidence', 'other']

export function totalsOf(artifacts: readonly Artifact[], canDelete = true): Totals {
  const t: Totals = {
    artifacts: 0, expired: 0, retainedBytes: 0, reclaimableBytes: 0, graceBytes: 0, graceCount: 0,
    byClass: { protected: emptyBucket(), keep: emptyBucket(), review: emptyBucket(), 'delete-candidate': emptyBucket(), expired: emptyBucket() },
    byCategory: { installer: emptyBucket(), build: emptyBucket(), report: emptyBucket(), logs: emptyBucket(), evidence: emptyBucket(), other: emptyBucket() },
  }
  for (const a of artifacts) {
    t.byClass[a.class].count++
    if (a.expired) { t.expired++; continue } // an expired artifact holds no bytes, whatever size GitHub still reports
    t.artifacts++
    t.retainedBytes += a.sizeBytes
    t.byClass[a.class].bytes += a.sizeBytes
    t.byCategory[a.category].count++
    t.byCategory[a.category].bytes += a.sizeBytes
    if (a.class === 'delete-candidate' && canDelete) t.reclaimableBytes += a.sizeBytes
    if (a.reasonCode === 'grace-period' && canDelete) { t.graceBytes += a.sizeBytes; t.graceCount++ }
  }
  return t
}

export const repoTotals = (r: RepoInventory) => totalsOf(r.artifacts, r.canDelete)

export function snapshotTotals(s: Snapshot): Totals & { repos: number; failedRepos: number; cacheBytes: number; cacheKnown: number } {
  const parts = s.repos.map(repoTotals)
  const sum = totalsOf([])
  for (const p of parts) {
    sum.artifacts += p.artifacts; sum.expired += p.expired; sum.retainedBytes += p.retainedBytes; sum.reclaimableBytes += p.reclaimableBytes; sum.graceBytes += p.graceBytes; sum.graceCount += p.graceCount
    for (const c of CLASSES) { sum.byClass[c].count += p.byClass[c].count; sum.byClass[c].bytes += p.byClass[c].bytes }
    for (const c of CATEGORIES) { sum.byCategory[c].count += p.byCategory[c].count; sum.byCategory[c].bytes += p.byCategory[c].bytes }
  }
  return {
    ...sum, repos: s.repos.length, failedRepos: s.repos.filter(r => r.error).length,
    cacheBytes: s.repos.reduce((n, r) => n + (r.cacheBytes ?? 0), 0), cacheKnown: s.repos.filter(r => r.cacheBytes !== null).length,
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024, i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`
}
