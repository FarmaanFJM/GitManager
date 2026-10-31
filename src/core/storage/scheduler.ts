import type { ArtifactRef, Frequency, PlanItem, RepoInventory, StorageConfig } from '../../shared/storage.js'
import { effectiveMode, policyFor, repoKey } from './config.js'

export const SCHEDULE_NOTE = 'Scheduled scans and cleanups run only while GitManager is running (including minimized to the tray). Nothing runs when it is closed, and no Windows service or scheduled task is installed.'

export function addPeriod(from: Date, f: Frequency): Date {
  const d = new Date(from)
  if (f === 'daily') d.setUTCDate(d.getUTCDate() + 1)
  else if (f === 'weekly') d.setUTCDate(d.getUTCDate() + 7)
  else {
    const day = d.getUTCDate()
    d.setUTCDate(1)
    d.setUTCMonth(d.getUTCMonth() + 1)
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
    d.setUTCDate(Math.min(day, last))
  }
  return d
}

/** When the next scheduled scan is due: one period after the last scan of any kind (or after the schedule was switched on). */
export function nextRunAt(enabled: boolean, anchor: string | null, f: Frequency): string | null {
  if (!enabled || !anchor || Number.isNaN(Date.parse(anchor))) return null
  return addPeriod(new Date(anchor), f).toISOString()
}

export const isDue = (next: string | null, now: number) => next !== null && Date.parse(next) <= now

/** Repositories a scheduled scan covers: manual mode means "only when I ask", so those are left out. */
export function scheduledRepos(cfg: StorageConfig, names: string[]): string[] {
  return names.filter(n => effectiveMode(policyFor(cfg, n)) !== 'manual')
}

/** Reasons that mean a superseded temporary build or obsolete report; a failed run's output is only ever recommended. */
const HIGH_CONFIDENCE = new Set(['superseded-build', 'obsolete-report'])

export type AutoSplit = { auto: PlanItem[]; recommend: ArtifactRef[]; heldLarge: string[] }

/**
 * Splits delete candidates into what automatic safe cleanup may delete and what is only recommended:
 *  - the repository must be in automatic safe mode with an approval that still matches its policy;
 *  - the candidate must be high confidence (superseded build or obsolete report) and every context lookup must have succeeded;
 *  - a repository whose deletion would exceed its large-deletion limit waits for approval.
 */
export function splitForAuto(cfg: StorageConfig, repos: RepoInventory[], toItem: (repo: RepoInventory, id: number) => PlanItem): AutoSplit {
  const out: AutoSplit = { auto: [], recommend: [], heldLarge: [] }
  for (const r of repos) {
    if (r.error || !r.canDelete) continue
    const policy = policyFor(cfg, r.repo)
    const mode = effectiveMode(policy)
    if (mode === 'manual') continue
    const candidates = r.artifacts.filter(a => a.class === 'delete-candidate')
    if (!candidates.length) continue
    const complete = Object.values(r.context).every(Boolean)
    const sure = mode === 'auto-safe' && complete ? candidates.filter(a => HIGH_CONFIDENCE.has(a.reasonCode)) : []
    const sureIds = new Set(sure.map(a => a.id))
    const bytes = sure.reduce((n, a) => n + a.sizeBytes, 0)
    if (sure.length && bytes > policy.largeDeleteBytes) { out.heldLarge.push(r.repo); sure.length = 0; sureIds.clear() }
    for (const a of sure) out.auto.push(toItem(r, a.id))
    for (const a of candidates) if (!sureIds.has(a.id)) out.recommend.push({ repo: r.repo, id: a.id })
  }
  return out
}

export { repoKey }
