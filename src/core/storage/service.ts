import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  ArtifactRef, AuditView, AuthState, CleanupPlan, OpenTarget, OperationProgress, OperationResult, Recommendation, ScanProgress, Snapshot, StorageConfig, StorageState,
} from '../../shared/storage.js'
import { formatBytes } from '../../shared/storageTotals.js'
import { computeAlerts } from './alerts.js'
import { AuditLog } from './audit.js'
import { buildPlan, executePlan, findArtifact, reconcileAudit, toPlanItem } from './cleanup.js'
import { effectiveMode, policyFor, policyHash, PRESETS, repoKey, sanitizePolicy, sanitizeSettings, validRepoName } from './config.js'
import { GhError, type GhApi } from './gh.js'
import { GitHub } from './github.js'
import { isDue, nextRunAt, SCHEDULE_NOTE, scheduledRepos, splitForAuto } from './scheduler.js'
import { limitationsFor, ScanCache, scanAll } from './scanner.js'

export type StorageDeps = {
  /** Folder for the audit log and the last scan (the application data folder). */
  dir: string
  gh: GhApi
  /** The live configuration object (inside the Store); mutated in place, then `saveConfig` persists it. */
  config: () => StorageConfig
  saveConfig: () => void
  openExternal: (url: string) => Promise<void>
  notify?: (title: string, body: string) => void
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  paceMs?: number
  tickMs?: number
}

type Persisted = {
  snapshot: Snapshot | null
  recommendation: Recommendation | null
  lastOperation: OperationResult | null
  anchor: string | null
  lastRunAt: string | null
  lastCleanupAt: string | null
  lastCleanupSummary: string | null
  lastError: string | null
  scanError: string | null
  quotaMessage: string | null
}

const IDLE_SCAN: ScanProgress = { running: false, phase: 'idle', done: 0, total: 0, current: null, startedAt: null, cancelled: false }
const IDLE_OP: OperationProgress = { opId: null, running: false, done: 0, total: 0, current: null, cancelling: false }

export type Res<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string; detail?: string } }
const fail = <T>(code: string, message: string, detail?: string): Res<T> => ({ ok: false, error: { code, message, ...(detail ? { detail } : {}) } })

/**
 * The Storage module's brain in the main process: owns the last scan, the audit log and the optional schedule, and is the
 * only code that talks to GitHub. The interface asks it for state and for explicit actions; it never receives a token.
 */
export class StorageService extends EventEmitter {
  readonly audit: AuditLog
  private readonly github: GitHub
  private readonly cache = new ScanCache()
  private readonly stateFile: string
  private p: Persisted
  private auth: AuthState | null = null
  private scanP: ScanProgress = { ...IDLE_SCAN }
  private opP: OperationProgress = { ...IDLE_OP }
  private busy: 'scan' | 'operation' | null = null
  private signal = { cancelled: false }
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly now: () => number

  constructor(private readonly d: StorageDeps) {
    super()
    this.now = d.now ?? Date.now
    this.audit = new AuditLog(join(d.dir, 'storage-audit.jsonl'), this.now)
    this.github = new GitHub(d.gh, { sleep: d.sleep })
    this.stateFile = join(d.dir, 'storage-state.json')
    this.p = this.load()
  }

  /* ------------------------------------------------------------ persistence */

  private load(): Persisted {
    const empty: Persisted = { snapshot: null, recommendation: null, lastOperation: null, anchor: null, lastRunAt: null, lastCleanupAt: null, lastCleanupSummary: null, lastError: null, scanError: null, quotaMessage: null }
    try {
      if (!existsSync(this.stateFile)) return empty
      const raw = JSON.parse(readFileSync(this.stateFile, 'utf8')) as Partial<Persisted>
      const snap = raw.snapshot && Array.isArray(raw.snapshot.repos) ? raw.snapshot : null
      return { ...empty, ...raw, snapshot: snap }
    } catch {
      try { renameSync(this.stateFile, `${this.stateFile}.corrupt-${this.now()}`) } catch { /* start empty */ }
      return empty
    }
  }

  private persist() {
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true })
      const tmp = `${this.stateFile}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(this.p), { mode: 0o600 })
      renameSync(tmp, this.stateFile)
    } catch (e) { console.error('[gitmanager] could not save storage state', e) }
  }

  private cfg() { return this.d.config() }
  private changed() { this.emit('changed') }
  private status() { this.emit('status', { scan: this.scanP, operation: this.opP, scheduler: this.scheduler(), auth: this.auth }) }

  /* ------------------------------------------------------------ state */

  scheduler(): StorageState['scheduler'] {
    const s = this.cfg().settings
    return {
      enabled: s.scheduleEnabled, frequency: s.frequency, lastRunAt: this.p.lastRunAt, nextRunAt: nextRunAt(s.scheduleEnabled, this.p.anchor, s.frequency),
      lastCleanupAt: this.p.lastCleanupAt, lastCleanupSummary: this.p.lastCleanupSummary, lastError: this.p.lastError, note: SCHEDULE_NOTE,
    }
  }

  state(): StorageState {
    const snap = this.p.snapshot
    // Alerts are derived from the scan and the current settings each time; only growth (needs the previous scan) is stored.
    const snapshot = snap ? { ...snap, alerts: [...computeAlerts({ snapshot: snap, previous: null, config: this.cfg(), at: snap.scannedAt ?? '', quotaMessage: this.p.quotaMessage, cleanupError: this.p.lastError, scanError: this.p.scanError }), ...snap.alerts.filter(a => a.kind === 'growth')] } : null
    return {
      snapshot, auth: this.auth, config: this.cfg(), scan: this.scanP, operation: this.opP, scheduler: this.scheduler(),
      recommendation: this.p.recommendation, lastOperation: this.p.lastOperation,
      effectiveModes: { default: effectiveMode(this.cfg().defaultPolicy), ...Object.fromEntries(Object.entries(this.cfg().policies).map(([k, v]) => [k, effectiveMode(v)])) },
      presets: PRESETS.map(({ id, label, description, policy }) => ({ id, label, description, policy })),
    }
  }

  async refreshAuth(): Promise<AuthState> {
    this.auth = await this.d.gh.authState()
    this.status()
    return this.auth
  }

  /* ------------------------------------------------------------ scanning */

  async scan(opts: { only?: string[]; trigger?: 'manual' | 'scheduled' } = {}): Promise<Res<{ started: true }>> {
    if (this.busy) return fail('BUSY', this.busy === 'scan' ? 'A scan is already running.' : 'A cleanup is running. Wait for it to finish.')
    const auth = await this.refreshAuth()
    if (auth.state !== 'ok') return fail(auth.state === 'no-gh' ? 'NO_GH' : auth.state === 'unauthenticated' ? 'NOT_SIGNED_IN' : 'AUTH_ERROR', auth.message)
    this.busy = 'scan'
    this.signal = { cancelled: false }
    this.scanP = { running: true, phase: 'repos', done: 0, total: 0, current: null, startedAt: new Date(this.now()).toISOString(), cancelled: false }
    this.status()
    // Runs in the background; progress and the result arrive as events.
    void this.runScan(auth, opts.only)
    return { ok: true, value: { started: true } }
  }

  /** Awaitable form of `scan`, used by the scheduler and tests. */
  async scanAndWait(opts: { only?: string[] } = {}): Promise<Res<{ started: true }>> {
    const r = await this.scan(opts)
    if (r.ok) await this.idle()
    return r
  }

  private readonly bg = new Set<Promise<unknown>>()
  private track<T>(p: Promise<T>): Promise<T> { this.bg.add(p); void p.finally(() => this.bg.delete(p)); return p }
  /** Resolves when no scan, cleanup or background refresh is running. */
  async whenIdle(): Promise<void> { while (this.bg.size || this.busy) { await this.idle(); await Promise.allSettled([...this.bg]) } }

  private idleWaiters: (() => void)[] = []
  private idle(): Promise<void> { return this.busy ? new Promise(r => this.idleWaiters.push(r)) : Promise.resolve() }
  private release() { this.busy = null; const w = this.idleWaiters; this.idleWaiters = []; for (const f of w) f() }

  private async runScan(auth: Extract<AuthState, { state: 'ok' }>, only?: string[]) {
    const old = this.p.snapshot
    try {
      const res = await scanAll(this.github, auth, {
        config: this.cfg(), now: this.now, cache: this.cache, signal: this.signal, only: only ? new Set(only.map(repoKey)) : undefined,
        onProgress: pr => { this.scanP = { ...this.scanP, ...pr }; this.status() },
      })
      if (this.signal.cancelled) { this.scanP = { ...this.scanP, running: false, cancelled: true, phase: 'idle' }; return }
      let snap = res.snapshot
      if (only && old) {
        const keys = new Set(snap.repos.map(r => repoKey(r.repo)))
        const repos = [...old.repos.filter(r => !keys.has(repoKey(r.repo))), ...snap.repos]
        snap = { ...old, repos, scannedAt: snap.scannedAt, skippedRepos: res.snapshot.skippedRepos, limitations: limitationsFor(auth, repos, old.packages, old.billing, res.aborted, res.snapshot.skippedRepos) }
      } else {
        snap.lastSuccessfulScanAt = snap.lastSuccessfulScanAt ?? old?.lastSuccessfulScanAt ?? null
      }
      const growth = old ? computeAlerts({ snapshot: snap, previous: old, config: this.cfg(), at: snap.scannedAt ?? '' }).filter(a => a.kind === 'growth') : []
      snap.alerts = growth
      this.p.snapshot = snap
      this.p.anchor = snap.scannedAt
      // a quota message from any repository's responses is surfaced as its own alert
      this.p.quotaMessage = res.snapshot.repos.map(r => r.error ?? '').find(e => /storage quota|artifact storage|quota (has been )?(hit|exceeded|reached)/i.test(e)) ?? null
      this.p.scanError = res.aborted ? `${res.aborted} (partial results were kept)` : null
      reconcileAudit(this.audit, snap)
      this.persist()
    } catch (e) {
      if (e instanceof GhError && e.kind === 'quota') this.p.quotaMessage = e.message
      this.p.scanError = (e as Error).message
      this.persist()
    } finally {
      this.scanP = { ...this.scanP, running: false, phase: 'idle', current: null }
      this.release()
      this.status()
      this.changed()
    }
  }

  cancel(): boolean {
    if (!this.busy) return false
    this.signal.cancelled = true
    if (this.busy === 'scan') this.scanP = { ...this.scanP, cancelled: true }
    else this.opP = { ...this.opP, cancelling: true }
    this.status()
    return true
  }

  /* ------------------------------------------------------------ cleanup */

  preview(refs: ArtifactRef[]): CleanupPlan { return buildPlan(this.p.snapshot, refs, { allowReview: true }) }

  /** Every verified delete candidate: the bulk selection offered in the preview. */
  candidates(): ArtifactRef[] {
    return (this.p.snapshot?.repos ?? []).filter(r => r.canDelete && !r.error).flatMap(r => r.artifacts.filter(a => a.class === 'delete-candidate').map(a => ({ repo: a.repo, id: a.id })))
  }

  async execute(refs: ArtifactRef[], o: { dryRun: boolean }): Promise<Res<OperationResult>> {
    if (this.busy) return fail('BUSY', 'Another scan or cleanup is running.')
    const plan = buildPlan(this.p.snapshot, refs, { allowReview: true })
    if (!plan.items.length) return fail('NOTHING', 'There is nothing eligible to delete in that selection.')
    const auth = await this.refreshAuth()
    if (auth.state !== 'ok') return fail(auth.state === 'unauthenticated' ? 'NOT_SIGNED_IN' : 'AUTH_ERROR', auth.message)
    if (!o.dryRun && auth.canWrite === false) return fail('READ_ONLY', 'This GitHub CLI sign-in cannot delete artifacts (no "repo" scope). GitManager stays read-only. To allow deletion run: gh auth refresh -s repo')
    this.busy = 'operation'
    this.signal = { cancelled: false }
    try {
      const result = await executePlan(this.p.snapshot, plan.items, {
        gh: this.github, audit: this.audit, config: () => this.cfg(), cache: this.cache, paceMs: this.d.paceMs, sleep: this.d.sleep, now: this.now,
        onProgress: pr => { this.opP = pr; this.status() },
      }, { trigger: 'manual', dryRun: o.dryRun, allowReview: true, signal: this.signal })
      this.p.lastOperation = result
      this.persist()
      return { ok: true, value: result }
    } catch (e) {
      return fail('FAILED', (e as Error).message)
    } finally {
      this.opP = { ...IDLE_OP }
      this.release()
      this.status()
      this.changed()
      if (!o.dryRun) void this.track(this.refreshRepos(plan.repos))
    }
  }

  /** Re-reads the repositories a cleanup touched, so the numbers on screen are GitHub's, not a prediction. */
  private async refreshRepos(repos: string[]) {
    if (!repos.length) return
    await this.scanAndWait({ only: repos })
  }

  /* ------------------------------------------------------------ protections and policies */

  setPinned(repo: string, id: number, pinned: boolean): Res<void> {
    if (!validRepoName(repo) || !Number.isSafeInteger(id) || id <= 0) return fail('INVALID', 'Invalid artifact.')
    const c = this.cfg()
    const key = repoKey(repo)
    const i = c.pins.findIndex(p => p.repo === key && p.artifactId === id)
    const found = findArtifact(this.p.snapshot, { repo, id })
    if (pinned && i < 0) c.pins.push({ repo: key, artifactId: id, name: found?.art.name ?? '', at: new Date(this.now()).toISOString() })
    if (!pinned && i >= 0) c.pins.splice(i, 1)
    this.d.saveConfig()
    if (found) {
      if (pinned) { found.art.class = 'protected'; found.art.reasonCode = 'pinned'; found.art.reason = 'Pinned by you.'; found.art.pinned = true; this.persist(); this.changed() }
      else { found.art.pinned = false; void this.track(this.scanAndWait({ only: [repo] })) }
    }
    return { ok: true, value: undefined }
  }

  setRepoProtected(repo: string, on: boolean): Res<void> {
    if (!validRepoName(repo)) return fail('INVALID', 'Invalid repository.')
    const c = this.cfg(); const key = repoKey(repo)
    c.protectedRepos = on ? [...new Set([...c.protectedRepos, key])] : c.protectedRepos.filter(r => r !== key)
    this.d.saveConfig()
    const inv = this.p.snapshot?.repos.find(r => repoKey(r.repo) === key)
    if (inv) inv.protectedRepo = on
    void this.track(this.scanAndWait({ only: [repo] }))
    this.changed()
    return { ok: true, value: undefined }
  }

  /**
   * Saves a repository's policy (or the default for repositories without one when `repo` is null). Automatic safe cleanup
   * only takes effect with an explicit approval of exactly these values; any later change to them voids it.
   */
  savePolicy(repo: string | null, raw: unknown, approve: boolean): Res<{ effective: string }> {
    if (repo !== null && !validRepoName(repo)) return fail('INVALID', 'Invalid repository.')
    const c = this.cfg()
    const prev = repo === null ? c.defaultPolicy : c.policies[repoKey(repo)] ?? null
    const next = sanitizePolicy(raw, c.defaultPolicy)
    if (next.mode === 'auto-safe') {
      if (approve) { next.approvedHash = policyHash(next); next.approvedAt = new Date(this.now()).toISOString() }
      else if (prev?.approvedHash === policyHash(next)) { next.approvedHash = prev.approvedHash; next.approvedAt = prev.approvedAt }
      else { next.approvedHash = null; next.approvedAt = null }
    } else { next.approvedHash = null; next.approvedAt = null }
    if (repo === null) c.defaultPolicy = next; else c.policies[repoKey(repo)] = next
    this.d.saveConfig()
    const affected = repo ? [repo] : (this.p.snapshot?.repos ?? []).filter(r => !c.policies[repoKey(r.repo)]).map(r => r.repo)
    if (affected.length && this.p.snapshot) void this.track(this.scanAndWait({ only: affected }))
    const effective = next.mode === 'auto-safe' && next.approvedHash !== policyHash(next) ? 'recommend' : next.mode
    return { ok: true, value: { effective } }
  }

  saveSettings(raw: unknown): Res<void> {
    const c = this.cfg()
    const next = sanitizeSettings(raw)
    if (next.scheduleEnabled && !c.settings.scheduleEnabled) this.p.anchor = new Date(this.now()).toISOString()
    c.settings = next
    this.d.saveConfig()
    this.persist()
    this.status(); this.changed()
    return { ok: true, value: undefined }
  }

  clearRecommendation() { this.p.recommendation = null; this.persist(); this.changed() }

  auditView(): AuditView { return this.audit.view() }

  /* ------------------------------------------------------------ opening links */

  async open(t: OpenTarget): Promise<Res<void>> {
    let url: string
    switch (t.kind) {
      case 'run': if (!validRepoName(t.repo) || !Number.isSafeInteger(t.runId) || t.runId <= 0) return fail('INVALID', 'Invalid run.'); url = `https://github.com/${t.repo}/actions/runs/${t.runId}`; break
      case 'repo-actions': if (!validRepoName(t.repo)) return fail('INVALID', 'Invalid repository.'); url = `https://github.com/${t.repo}/actions`; break
      case 'billing': url = 'https://github.com/settings/billing'; break
      case 'billing-docs': url = 'https://docs.github.com/en/billing'; break
      case 'scopes': url = 'https://cli.github.com/manual/gh_auth_refresh'; break
      default: return fail('INVALID', 'Unknown link.')
    }
    await this.d.openExternal(url)
    return { ok: true, value: undefined }
  }

  /* ------------------------------------------------------------ schedule */

  start() {
    if (this.timer) return
    this.timer = setInterval(() => { void this.tick() }, this.d.tickMs ?? 60_000)
    this.timer.unref?.()
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null }

  /** Runs the schedule if it is switched on and due. Safe to call at any time; it does nothing while busy. */
  async tick(): Promise<boolean> {
    const s = this.cfg().settings
    if (!s.scheduleEnabled || this.busy) return false
    if (!isDue(nextRunAt(true, this.p.anchor, s.frequency), this.now())) return false
    await this.runAutomation()
    return true
  }

  /**
   * One automation pass: scan the repositories whose mode is not manual, record suggestions for Recommend mode, and delete
   * only what an approved automatic safe policy allows (high-confidence candidates, complete context, below the large-deletion limit).
   */
  async runAutomation(): Promise<{ scanned: string[]; deleted: number; recommended: number }> {
    const cfg = this.cfg()
    const known = (this.p.snapshot?.repos ?? []).map(r => r.repo)
    const explicit = Object.keys(cfg.policies)
    const defaultAuto = cfg.defaultPolicy.mode !== 'manual'
    const targets = defaultAuto ? undefined : scheduledRepos(cfg, [...new Set([...explicit, ...known.filter(k => cfg.policies[repoKey(k)])])])
    this.p.lastRunAt = new Date(this.now()).toISOString()
    this.p.lastError = null
    if (targets && !targets.length) { this.p.anchor = this.p.lastRunAt; this.persist(); this.status(); return { scanned: [], deleted: 0, recommended: 0 } }
    const r = await this.scanAndWait({ only: targets })
    if (!r.ok) { this.p.lastError = r.error.message; this.p.anchor = this.p.lastRunAt; this.persist(); this.fail(r.error.message); return { scanned: [], deleted: 0, recommended: 0 } }
    const snap = this.p.snapshot
    if (!snap) return { scanned: [], deleted: 0, recommended: 0 }
    const scope = snap.repos.filter(x => !targets || targets.some(t => repoKey(t) === repoKey(x.repo)))
    const auth = this.auth
    const split = splitForAuto(cfg, scope, (inv, id) => toPlanItem(inv.artifacts.find(a => a.id === id)!))
    let deleted = 0, bytes = 0
    const problems: string[] = []
    if (split.auto.length && auth?.state === 'ok' && auth.canWrite !== false) {
      this.busy = 'operation'
      this.signal = { cancelled: false }
      try {
        const res = await executePlan(snap, split.auto, { gh: this.github, audit: this.audit, config: () => this.cfg(), cache: this.cache, paceMs: this.d.paceMs, sleep: this.d.sleep, now: this.now, onProgress: pr => { this.opP = pr; this.status() } }, { trigger: 'scheduled', dryRun: false, allowReview: false, signal: this.signal })
        this.p.lastOperation = res
        deleted = res.confirmedDeleted; bytes = res.confirmedBytes
        const bad = res.items.filter(i => ['denied', 'rate-limited', 'failed', 'not-attempted'].includes(i.outcome))
        if (bad.length) problems.push(`${bad.length} of ${res.items.length} could not be deleted (${res.stopReason ?? bad[0].message ?? bad[0].outcome})`)
      } catch (e) { problems.push((e as Error).message) } finally {
        this.opP = { ...IDLE_OP }; this.release()
      }
      await this.refreshRepos([...new Set(split.auto.map(i => i.ref.repo))])
    } else if (split.auto.length) problems.push('Automatic cleanup was due but this sign-in cannot delete artifacts.')
    const rec = split.recommend.concat(split.heldLarge.flatMap(h => (this.p.snapshot?.repos.find(x => repoKey(x.repo) === repoKey(h))?.artifacts ?? []).filter(a => a.class === 'delete-candidate').map(a => ({ repo: a.repo, id: a.id }))))
    const unique = new Map(rec.map(x => [`${repoKey(x.repo)}#${x.id}`, x]))
    const live = [...unique.values()].filter(x => findArtifact(this.p.snapshot, x)?.art.class === 'delete-candidate')
    this.p.recommendation = live.length ? { at: this.p.lastRunAt, refs: live, bytes: live.reduce((n, x) => n + (findArtifact(this.p.snapshot, x)?.art.sizeBytes ?? 0), 0) } : null
    if (deleted || split.auto.length) { this.p.lastCleanupAt = new Date(this.now()).toISOString(); this.p.lastCleanupSummary = `${deleted} deleted (${formatBytes(bytes)}), confirmed by GitHub` }
    if (problems.length) { this.p.lastError = problems.join('; '); this.fail(this.p.lastError) }
    this.p.anchor = new Date(this.now()).toISOString()
    this.persist()
    if (!problems.length && this.cfg().settings.notify && (deleted || this.p.recommendation)) {
      this.d.notify?.('GitManager storage', deleted ? `Cleaned ${deleted} artifacts (${formatBytes(bytes)}).` : `${this.p.recommendation!.refs.length} artifacts are ready to review (${formatBytes(this.p.recommendation!.bytes)}).`)
    }
    this.status(); this.changed()
    return { scanned: scope.map(x => x.repo), deleted, recommended: this.p.recommendation?.refs.length ?? 0 }
  }

  private fail(message: string) {
    if (this.cfg().settings.notify) this.d.notify?.('GitManager storage', `Scheduled cleanup failed: ${message}`)
  }

  policyOf(repo: string) { return policyFor(this.cfg(), repo) }
}
