import type { Snapshot, StorageAlert, StorageConfig } from '../../shared/storage.js'
import { formatBytes, snapshotTotals } from '../../shared/storageTotals.js'
import { MIB } from './config.js'
import { parseName } from './classify.js'

export type AlertInput = { snapshot: Snapshot; previous: Snapshot | null; config: StorageConfig; at: string; quotaMessage?: string | null; cleanupError?: string | null; scanError?: string | null }

/** Informative warnings derived from a scan. Each has a stable id so the interface can show it once. None needs an allowance figure GitHub does not provide. */
export function computeAlerts(i: AlertInput): StorageAlert[] {
  const out: StorageAlert[] = []
  const { alerts } = i.config.settings
  const t = snapshotTotals(i.snapshot)
  const add = (a: Omit<StorageAlert, 'at'>) => out.push({ ...a, at: i.at })
  if (i.quotaMessage) add({ id: 'quota-error', kind: 'quota-error', severity: 'warn', message: `GitHub reported a storage quota problem: ${i.quotaMessage}. Review cleanup below, then re-run the failed workflow; GitHub may take a while to recalculate after deletions.` })
  if (i.cleanupError) add({ id: 'cleanup-failed', kind: 'cleanup-failed', severity: 'warn', message: `The last scheduled cleanup failed: ${i.cleanupError}` })
  if (i.scanError) add({ id: 'scan-failed', kind: 'scan-failed', severity: 'warn', message: `The last scan did not finish: ${i.scanError}` })
  if (alerts.highBytes !== null && t.retainedBytes >= alerts.highBytes) {
    add({ id: 'high-storage', kind: 'high-storage', severity: 'warn', message: `Retained artifact storage is ${formatBytes(t.retainedBytes)}, above your warning level of ${formatBytes(alerts.highBytes)}.` })
  }
  if (alerts.growth && i.previous) {
    const before = snapshotTotals(i.previous).retainedBytes
    if (before > 0 && t.retainedBytes >= before * 1.5 && t.retainedBytes - before >= 100 * MIB) {
      add({ id: 'growth', kind: 'growth', severity: 'info', message: `Retained artifact storage grew from ${formatBytes(before)} to ${formatBytes(t.retainedBytes)} since the previous scan.` })
    }
  }
  if (alerts.repeatedBuilds) {
    const found: { repo: string; message: string; bytes: number }[] = []
    for (const r of i.snapshot.repos) {
      const groups = new Map<string, { n: number; bytes: number }>()
      for (const a of r.artifacts) {
        if (a.expired) continue
        const p = parseName(a.name)
        const k = `${p.category}|${p.platform}|${p.family}`
        const g = groups.get(k) ?? { n: 0, bytes: 0 }
        g.n++; g.bytes += a.sizeBytes; groups.set(k, g)
      }
      const worst = [...groups.entries()].filter(([, g]) => g.n >= 4 && g.bytes >= 200 * MIB).sort((a, b) => b[1].bytes - a[1].bytes)[0]
      if (worst) found.push({ repo: r.repo, bytes: worst[1].bytes, message: `${r.repo} keeps ${worst[1].n} copies of "${worst[0].split('|')[2]}" totalling ${formatBytes(worst[1].bytes)}.` })
    }
    // quiet by design: only the two largest, not one line per repository
    for (const f of found.sort((a, b) => b.bytes - a.bytes).slice(0, 2)) add({ id: `repeated:${f.repo}`, kind: 'repeated-builds', severity: 'info', repo: f.repo, message: f.message })
  }
  if (alerts.oldBuilds && t.retainedBytes > 0 && t.reclaimableBytes >= 100 * MIB && t.reclaimableBytes / t.retainedBytes >= 0.3) {
    add({ id: 'old-builds', kind: 'old-builds', severity: 'info', message: `${formatBytes(t.reclaimableBytes)} (${Math.round((100 * t.reclaimableBytes) / t.retainedBytes)}%) of retained artifacts are superseded builds that can be cleaned up.` })
  }
  return out
}
