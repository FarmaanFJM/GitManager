import { randomUUID } from 'node:crypto'
import type { Artifact, ArtifactRef, CleanupPlan, ItemResult, OperationProgress, OperationResult, Outcome, PlanItem, RepoInventory, Snapshot, StorageConfig } from '../../shared/storage.js'
import type { AuditLog } from './audit.js'
import { repoKey, validRepoName } from './config.js'
import { GhError } from './gh.js'
import type { GitHub } from './github.js'
import { scanRepo, type ScanCache } from './scanner.js'

const same = (a: string, b: string) => repoKey(a) === repoKey(b)
export const findArtifact = (snap: Snapshot | null, ref: ArtifactRef): { inv: RepoInventory; art: Artifact } | null => {
  const inv = snap?.repos.find(r => same(r.repo, ref.repo))
  const art = inv?.artifacts.find(a => a.id === ref.id)
  return inv && art ? { inv, art } : null
}

export const toPlanItem = (a: Artifact): PlanItem => ({
  ref: { repo: a.repo, id: a.id }, name: a.name, sizeBytes: a.sizeBytes, createdAt: a.createdAt, runId: a.runId, runUrl: a.run?.htmlUrl || null,
  class: a.class, reasonCode: a.reasonCode, reason: a.reason,
})

/**
 * What a deletion request would do, from the last scan. Verified delete candidates are always eligible; Review artifacts
 * only when the user picked them one by one (`allowReview`). Protected, Keep and Expired artifacts, repositories the
 * user cannot write to, and anything not in the scan are listed as excluded with the reason.
 */
export function buildPlan(snap: Snapshot | null, refs: ArtifactRef[], opts: { allowReview: boolean }): CleanupPlan {
  const items: PlanItem[] = [], excluded: CleanupPlan['excluded'] = []
  const seen = new Set<string>()
  for (const ref of refs) {
    if (!validRepoName(ref.repo) || !Number.isSafeInteger(ref.id) || ref.id <= 0) continue
    const k = `${repoKey(ref.repo)}#${ref.id}`
    if (seen.has(k)) continue
    seen.add(k)
    const f = findArtifact(snap, ref)
    if (!f) { excluded.push({ ref, name: `#${ref.id}`, sizeBytes: 0, createdAt: null, runId: null, runUrl: null, class: 'review', reasonCode: 'unclassified', reason: '', why: 'Not in the last scan. Scan again.' }); continue }
    const { inv, art } = f
    const item = toPlanItem(art)
    if (!inv.canDelete) excluded.push({ ...item, why: 'Archived or read-only for your account.' })
    else if (art.class === 'delete-candidate' || (art.class === 'review' && opts.allowReview)) items.push(item)
    else excluded.push({ ...item, why: art.class === 'review' ? 'Uncertain: only deleted when you select it yourself.' : art.class === 'expired' ? 'Already expired; nothing is stored.' : art.class === 'protected' ? 'Protected.' : 'Kept by the retention rules.' })
  }
  const repos = [...new Set(items.map(i => i.ref.repo))]
  const selected = new Set(items.map(i => `${repoKey(i.ref.repo)}#${i.ref.id}`))
  const unselectedCandidates = (snap?.repos ?? []).flatMap(r => (r.canDelete ? r.artifacts : [])).filter(a => a.class === 'delete-candidate' && !selected.has(`${repoKey(a.repo)}#${a.id}`)).length
  return { items, excluded, repos, totalBytes: items.reduce((n, i) => n + i.sizeBytes, 0), unselectedCandidates }
}

export type ExecutorDeps = {
  gh: GitHub
  audit: AuditLog
  config: () => StorageConfig
  cache?: ScanCache
  /** Pause between deletions; GitHub asks integrations to wait about a second between requests that change data. */
  paceMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  onProgress?: (p: OperationProgress) => void
}

export type ExecuteOptions = { trigger: 'manual' | 'scheduled'; dryRun: boolean; allowReview: boolean; signal?: { cancelled: boolean } }

/**
 * Deletes the planned artifacts, one by one, after revalidating each against GitHub:
 *  - the repository is read again (permission, archived) and re-classified with the *current* pins and protections;
 *  - the artifact must still exist with the same id, name, size and workflow run, and keep the classification it had in the scan;
 *  - a last GET of the artifact precedes the DELETE;
 *  - the attempt is written to the audit log before the request, the outcome after it;
 *  - the repository is listed again afterwards: only an artifact that is gone is reported as deleted.
 * Only `DELETE /repos/{owner}/{repo}/actions/artifacts/{id}` is ever called, once per artifact.
 */
export async function executePlan(snap: Snapshot | null, items: PlanItem[], deps: ExecutorDeps, o: ExecuteOptions): Promise<OperationResult> {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)))
  const pace = deps.paceMs ?? 1000
  const opId = randomUUID().slice(0, 8)
  const startedAt = new Date(now()).toISOString()
  const results: ItemResult[] = []
  let stopReason: string | null = null
  let done = 0
  const progress = (current: string | null, cancelling = false) => deps.onProgress?.({ opId, running: true, done, total: items.length, current, cancelling })

  const record = (it: PlanItem, outcome: Outcome, message: string | null, audit = true) => {
    results.push({ ref: it.ref, name: it.name, sizeBytes: it.sizeBytes, runId: it.runId, outcome, message })
    if (audit && !o.dryRun) deps.audit.append({ opId, type: 'result', trigger: o.trigger, repo: it.ref.repo, artifactId: it.ref.id, name: it.name, runId: it.runId, sizeBytes: it.sizeBytes, outcome, message })
    done++
  }
  const rest = (list: PlanItem[], outcome: Outcome, message: string) => { for (const it of list) record(it, outcome, message, false) }

  const byRepo = new Map<string, PlanItem[]>()
  for (const it of items) { const k = repoKey(it.ref.repo); if (!byRepo.has(k)) byRepo.set(k, []); byRepo.get(k)!.push(it) }
  const groups = [...byRepo.values()]

  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi]
    const repo = group[0].ref.repo
    if (stopReason) { rest(group, 'not-attempted', stopReason); continue }
    if (o.signal?.cancelled) { stopReason = 'Cancelled before this repository.'; rest(group, 'not-attempted', stopReason); continue }
    progress(repo)

    // Revalidate the repository itself: permission, archived state, protections and classification as of now.
    let fresh: RepoInventory
    try {
      const summary = await deps.gh.getRepo(repo)
      fresh = await scanRepo(deps.gh, summary, { config: deps.config(), cache: deps.cache, now, signal: o.signal })
    } catch (e) {
      const err = e as GhError
      if (err instanceof GhError && (err.kind === 'auth' || err.kind === 'rate-limit' || err.kind === 'no-gh')) {
        stopReason = err.message
        rest(group, err.kind === 'rate-limit' ? 'rate-limited' : 'denied', err.message)
      } else rest(group, 'failed', `Could not revalidate ${repo}: ${err.message}`)
      continue
    }
    if (fresh.error) { rest(group, 'failed', `Could not revalidate ${repo}: ${fresh.error}`); continue }

    const toVerify: PlanItem[] = []
    let repoDenied: string | null = null
    for (let i = 0; i < group.length; i++) {
      const it = group[i]
      if (stopReason || repoDenied || o.signal?.cancelled) {
        if (o.signal?.cancelled && !stopReason) stopReason = 'Cancelled by you.'
        record(it, repoDenied ? 'denied' : 'not-attempted', repoDenied ?? stopReason, false)
        continue
      }
      progress(it.name, !!o.signal?.cancelled)
      const scanned = findArtifact(snap, it.ref)?.art
      const cur = fresh.artifacts.find(a => a.id === it.ref.id)
      if (!cur || cur.expired) { record(it, 'already-gone', 'GitHub no longer lists this artifact.'); continue }
      if (!scanned) { record(it, 'skipped-changed', 'It was not part of the scan this plan was made from.'); continue }
      if (cur.name !== scanned.name || cur.sizeBytes !== scanned.sizeBytes || cur.runId !== scanned.runId || !same(cur.repo, scanned.repo)) { record(it, 'skipped-changed', 'Its name, size or workflow run changed since the scan.'); continue }
      if (cur.class === 'protected') { record(it, 'skipped-protected', cur.reason); continue }
      if (cur.class !== scanned.class) { record(it, 'skipped-changed', `Its classification changed since the scan (${scanned.class} → ${cur.class}): ${cur.reason}`); continue }
      if (!(cur.class === 'delete-candidate' || (cur.class === 'review' && o.allowReview))) { record(it, 'skipped-protected', cur.reason); continue }
      if (!fresh.canDelete) { record(it, 'denied', 'You do not have permission to delete artifacts in this repository.'); continue }
      if (o.dryRun) { record(it, 'skipped-dry-run', 'Would be deleted. Dry run: nothing was changed.'); continue }

      try {
        // the final check, immediately before the request
        const last = await deps.gh.getArtifact(repo, it.ref.id)
        if (last.expired) { record(it, 'already-gone', 'It expired just now.'); continue }
        if (last.name !== cur.name || last.sizeBytes !== cur.sizeBytes || last.runId !== cur.runId) { record(it, 'skipped-changed', 'Its metadata changed just before deletion.'); continue }
        deps.audit.append({ opId, type: 'attempt', trigger: o.trigger, repo, artifactId: it.ref.id, name: it.name, runId: it.runId, sizeBytes: it.sizeBytes })
        await deps.gh.deleteArtifact(repo, it.ref.id)
        record(it, 'deleted-unconfirmed', 'GitHub accepted the deletion; confirming.')
        toVerify.push(it)
        if (pace > 0 && i < group.length - 1) await sleep(pace)
      } catch (e) {
        if (!(e instanceof GhError)) { record(it, 'failed', (e as Error).message); continue }
        const err = e
        if (err.kind === 'not-found' || err.kind === 'gone') record(it, 'already-gone', 'GitHub no longer has this artifact.')
        else if (err.kind === 'rate-limit') { stopReason = err.message; record(it, 'rate-limited', err.message) }
        else if (err.kind === 'auth') { stopReason = err.message; record(it, 'denied', err.message) }
        else if (err.kind === 'permission') { repoDenied = `GitHub refused: ${err.message}`; record(it, 'denied', repoDenied) }
        else record(it, 'failed', err.message)
      }
    }

    // Confirm with GitHub: the artifact must be gone from a fresh listing before it counts as deleted.
    if (toVerify.length) {
      try {
        const listing = await deps.gh.listArtifacts(repo)
        const present = new Set(listing.items.map(a => a.id))
        for (const it of toVerify) {
          const r = results.find(x => x.ref.id === it.ref.id && same(x.ref.repo, repo) && x.outcome === 'deleted-unconfirmed')
          if (!r) continue
          if (!present.has(it.ref.id)) {
            r.outcome = 'deleted'; r.message = 'Confirmed gone by GitHub.'
            deps.audit.append({ opId, type: 'result', trigger: o.trigger, repo, artifactId: it.ref.id, name: it.name, runId: it.runId, sizeBytes: it.sizeBytes, outcome: 'deleted', message: r.message })
          } else {
            r.message = 'GitHub accepted the deletion but still lists the artifact. Scan again later.'
            deps.audit.append({ opId, type: 'result', trigger: o.trigger, repo, artifactId: it.ref.id, name: it.name, runId: it.runId, sizeBytes: it.sizeBytes, outcome: 'deleted-unconfirmed', message: r.message })
          }
        }
      } catch (e) {
        for (const it of toVerify) { const r = results.find(x => x.ref.id === it.ref.id && same(x.ref.repo, repo)); if (r) r.message = `GitHub accepted the deletion; the confirming listing failed (${(e as Error).message}).` }
      }
    }
  }

  const confirmed = results.filter(r => r.outcome === 'deleted')
  return {
    opId, trigger: o.trigger, dryRun: o.dryRun, startedAt, finishedAt: new Date(now()).toISOString(), items: results,
    confirmedDeleted: confirmed.length, confirmedBytes: confirmed.reduce((n, r) => n + r.sizeBytes, 0),
    interrupted: !!o.signal?.cancelled || results.some(r => r.outcome === 'not-attempted'), stopReason,
  }
}

/**
 * Closes audit attempts left open by an interrupted run, using what a later scan shows: gone means deleted, still
 * listed means the deletion did not happen. Returns how many were resolved.
 */
export function reconcileAudit(audit: AuditLog, snap: Snapshot): number {
  let n = 0
  for (const a of audit.unresolved()) {
    const inv = snap.repos.find(r => same(r.repo, a.repo))
    if (!inv || inv.error) continue
    const present = inv.artifacts.some(x => x.id === a.artifactId && !x.expired)
    audit.append({ opId: a.opId, type: 'result', trigger: a.trigger, repo: a.repo, artifactId: a.artifactId, name: a.name, runId: a.runId, sizeBytes: a.sizeBytes, outcome: present ? 'not-attempted' : 'deleted', message: present ? 'The operation was interrupted; a later scan shows the artifact is still there.' : 'The operation was interrupted; a later scan shows the artifact is gone.' })
    n++
  }
  return n
}
