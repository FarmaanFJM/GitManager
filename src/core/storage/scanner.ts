import type { AuthState, BillingInfo, PackagesInventory, RepoInventory, RepoLimit, RunInfo, ScanProgress, Snapshot, StorageConfig } from '../../shared/storage.js'
import { classifyRepo, type ActiveRelease, type OpenPull, type RawArtifact } from './classify.js'
import { policyFor, repoKey } from './config.js'
import { GhError } from './gh.js'
import type { GitHub, RepoSummary } from './github.js'

/** Session caches: completed runs and documentation text rarely change, so a rescan does not download them again. */
export class ScanCache {
  readonly runs = new Map<string, RunInfo>()
  readonly docs = new Map<string, string>() // `${repo}@${treeSha}`
}

const MAX_RUN_LOOKUPS = 60
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

export type ScanOptions = {
  config: StorageConfig
  now?: () => number
  cache?: ScanCache
  signal?: { cancelled: boolean }
}

/** Reads and classifies one repository. Anything that cannot be read is recorded as a limit and lowers confidence; it never throws except for sign-in and rate-limit failures, which end the whole scan. */
export async function scanRepo(gh: GitHub, repo: RepoSummary, o: ScanOptions): Promise<RepoInventory> {
  const now = (o.now ?? Date.now)()
  const cache = o.cache ?? new ScanCache()
  const cfg = o.config
  const key = repoKey(repo.fullName)
  const limits: RepoLimit[] = []
  const inv: RepoInventory = {
    repo: repo.fullName, private: repo.private, archived: repo.archived, canDelete: repo.canPush && !repo.archived, scannedAt: new Date(now).toISOString(),
    protectedRepo: cfg.protectedRepos.includes(key), artifacts: [], cacheBytes: null, cacheCount: null, caches: [], limits, error: null,
    context: { runs: true, pulls: true, releases: true, docs: true },
  }
  const fatal = (e: unknown) => e instanceof GhError && (e.kind === 'auth' || e.kind === 'rate-limit' || e.kind === 'no-gh')

  let raws: RawArtifact[] = []
  try {
    const r = await gh.listArtifacts(repo.fullName)
    raws = r.items
    if (r.truncated) limits.push({ area: 'artifacts', message: 'More artifacts exist than GitManager reads in one scan (5000). Delete some and scan again.' })
  } catch (e) {
    if (fatal(e)) throw e
    inv.error = e instanceof GhError && e.kind === 'permission' ? `No permission to list artifacts (${e.message}). Actions may be disabled or the sign-in lacks access.`
      : e instanceof GhError && e.kind === 'not-found' ? 'Artifacts are not available for this repository (Actions may be disabled).' : `Artifacts could not be read: ${msg(e)}`
    limits.push({ area: 'artifacts', message: inv.error })
    return inv
  }

  const live = raws.filter(a => !a.expired)
  const runs = new Map<number, RunInfo>()
  const pulls: OpenPull[] = []
  const releases: ActiveRelease[] = []
  let docs: string | null = ''

  if (live.length) {
    // Runs: one list call covers recent runs; the rest are fetched individually, bounded.
    try {
      const { items } = await gh.listRuns(repo.fullName)
      for (const r of items) runs.set(r.id, r)
      const need = [...new Set(live.map(a => a.runId).filter((v): v is number => v !== null))].filter(id => !runs.has(id))
      let looked = 0
      for (const id of need) {
        const ck = `${repo.fullName}#${id}`
        const hit = cache.runs.get(ck)
        if (hit) { runs.set(id, hit); continue }
        if (looked >= MAX_RUN_LOOKUPS) { inv.context.runs = false; limits.push({ area: 'runs', message: `Some workflow runs were not looked up (limit ${MAX_RUN_LOOKUPS} per scan); those artifacts stay in Review.` }); break }
        if (o.signal?.cancelled) break
        looked++
        const run = await gh.getRun(repo.fullName, id)
        if (run) runs.set(id, run)
      }
      for (const [id, r] of runs) if (r.status === 'completed') cache.runs.set(`${repo.fullName}#${id}`, r)
    } catch (e) {
      if (fatal(e)) throw e
      inv.context.runs = false
      limits.push({ area: 'runs', message: `Workflow runs could not be read: ${msg(e)}` })
    }

    try {
      for (const p of await gh.listOpenPulls(repo.fullName)) pulls.push(p)
    } catch (e) {
      if (fatal(e)) throw e
      inv.context.pulls = false
      limits.push({ area: 'pulls', message: `Open pull requests could not be read: ${msg(e)}` })
    }

    try {
      const all = await gh.listReleases(repo.fullName)
      const latest = all.find(r => !r.draft && !r.prerelease)
      const pre = all.find(r => !r.draft && r.prerelease)
      const active = [...all.filter(r => r.draft), ...(latest ? [latest] : []), ...(pre ? [pre] : [])]
      for (const r of active) releases.push({ tag: r.tag, sha: await gh.tagCommit(repo.fullName, r.tag), draft: r.draft, prerelease: r.prerelease })
    } catch (e) {
      if (fatal(e)) throw e
      inv.context.releases = false
      limits.push({ area: 'releases', message: `Releases could not be read: ${msg(e)}` })
    }

    try {
      const tree = await gh.docFiles(repo.fullName, 'HEAD')
      const ck = `${repo.fullName}@${tree.treeSha}`
      const hit = tree.treeSha ? cache.docs.get(ck) : undefined
      if (hit !== undefined) docs = hit
      else {
        const parts: string[] = []
        for (const f of tree.files) { if (o.signal?.cancelled) break; parts.push(await gh.fileText(repo.fullName, f.path)) }
        docs = parts.join('\n').toLowerCase()
        if (tree.treeSha && !o.signal?.cancelled) cache.docs.set(ck, docs)
      }
    } catch (e) {
      if (fatal(e)) throw e
      docs = null
      inv.context.docs = false
      limits.push({ area: 'docs', message: `Documentation could not be searched for artifact references: ${msg(e)}` })
    }
  }

  try {
    const u = await gh.cacheUsage(repo.fullName)
    inv.cacheBytes = u.bytes; inv.cacheCount = u.count
    if (u.count > 0) inv.caches = await gh.listCaches(repo.fullName)
  } catch (e) {
    if (fatal(e)) throw e
    limits.push({ area: 'caches', message: `Actions cache usage could not be read: ${msg(e)}` })
  }

  inv.artifacts = classifyRepo(raws, {
    now, policy: policyFor(cfg, repo.fullName), protectedRepo: inv.protectedRepo,
    pinned: new Set(cfg.pins.filter(p => repoKey(p.repo) === key).map(p => p.artifactId)),
    runs, pulls, releases, docs, context: inv.context,
  })
  return inv
}

export function selectRepos(all: RepoSummary[], login: string, cfg: StorageConfig): RepoSummary[] {
  return all.filter(r => (cfg.settings.includeArchived || !r.archived) && (cfg.settings.scope === 'owned' ? r.owner.toLowerCase() === login.toLowerCase() : r.canPush))
}

export type ScanResult = { snapshot: Snapshot; failed: number; aborted: string | null }

/** A scan of every selected repository, four at a time. One repository failing leaves the others intact. */
export async function scanAll(gh: GitHub, auth: Extract<AuthState, { state: 'ok' }>, o: ScanOptions & { concurrency?: number; only?: ReadonlySet<string>; onProgress?: (p: Partial<ScanProgress>) => void }): Promise<ScanResult> {
  const now = (o.now ?? Date.now)()
  const cache = o.cache ?? new ScanCache()
  o.onProgress?.({ phase: 'repos', done: 0, total: 0, current: null })
  const all = await gh.listRepos()
  const repos = selectRepos(all, auth.login, o.config).filter(r => !o.only || o.only.has(repoKey(r.fullName)))
  const out: RepoInventory[] = new Array(repos.length)
  let next = 0, done = 0, aborted: string | null = null
  o.onProgress?.({ phase: 'inventory', done: 0, total: repos.length })
  const worker = async () => {
    for (;;) {
      if (aborted || o.signal?.cancelled) return
      const i = next++
      if (i >= repos.length) return
      const r = repos[i]
      o.onProgress?.({ current: r.fullName })
      try { out[i] = await scanRepo(gh, r, { ...o, cache }) } catch (e) {
        if (e instanceof GhError && (e.kind === 'auth' || e.kind === 'rate-limit' || e.kind === 'no-gh')) aborted = e.message
        else out[i] = { repo: r.fullName, private: r.private, archived: r.archived, canDelete: false, scannedAt: new Date(now).toISOString(), protectedRepo: false, artifacts: [], cacheBytes: null, cacheCount: null, caches: [], limits: [], error: msg(e), context: { runs: false, pulls: false, releases: false, docs: false } }
      }
      done++
      o.onProgress?.({ done })
    }
  }
  await Promise.all(Array.from({ length: Math.min(o.concurrency ?? 4, Math.max(1, repos.length)) }, worker))
  const repoInv = out.filter(Boolean)

  let packages: PackagesInventory = { available: false, message: 'Not read.', packages: [] }
  let billing: BillingInfo = { available: false, message: 'Not read.', period: null, items: [] }
  if (!o.only && !aborted && !o.signal?.cancelled) {
    o.onProgress?.({ phase: 'extras', current: 'Packages and billing' })
    try { packages = { available: true, message: null, packages: await gh.listPackages() } } catch (e) {
      const err = e as GhError
      packages = { available: false, message: err.kind === 'permission' || err.kind === 'auth' ? 'The GitHub CLI sign-in cannot read packages. Add the scope with: gh auth refresh -s read:packages' : `Packages could not be read: ${err.message}`, packages: [] }
    }
    billing = await gh.billing(auth.login)
  }
  const failed = repoInv.filter(r => r.error).length
  const complete = !aborted && !o.signal?.cancelled && repoInv.length === repos.length
  const snapshot: Snapshot = {
    scannedAt: new Date(now).toISOString(), lastSuccessfulScanAt: complete && failed === 0 ? new Date(now).toISOString() : null,
    login: auth.login, repos: repoInv, packages, billing, limitations: limitationsFor(auth, repoInv, packages, billing, aborted), alerts: [],
  }
  return { snapshot, failed, aborted }
}

export function limitationsFor(auth: Extract<AuthState, { state: 'ok' }>, repos: RepoInventory[], packages: PackagesInventory, billing: BillingInfo, aborted: string | null): string[] {
  const out: string[] = []
  if (aborted) out.push(`The scan stopped early: ${aborted}`)
  if (auth.canWrite === false) out.push('This GitHub CLI sign-in has no write scope, so GitManager is read-only: it can scan but not delete. Add the scope with: gh auth refresh -s repo')
  else if (auth.canWrite === null) out.push('GitHub did not report this sign-in\'s scopes (fine-grained or app token). Scanning works; deletion needs "Actions: write" and is only confirmed when GitHub accepts it.')
  const failed = repos.filter(r => r.error)
  if (failed.length) out.push(`${failed.length} ${failed.length === 1 ? 'repository' : 'repositories'} could not be inventoried: ${failed.slice(0, 4).map(r => r.repo).join(', ')}${failed.length > 4 ? ', …' : ''}. Their numbers are not included.`)
  const noWrite = repos.filter(r => !r.canDelete && !r.error)
  if (noWrite.length) out.push(`${noWrite.length} scanned ${noWrite.length === 1 ? 'repository is' : 'repositories are'} archived or read-only for you; their artifacts are listed but cannot be deleted.`)
  const lowConf = repos.filter(r => !r.error && Object.values(r.context).some(v => !v))
  if (lowConf.length) out.push(`${lowConf.length} ${lowConf.length === 1 ? 'repository' : 'repositories'} had incomplete context (pull requests, releases, documentation or runs); their delete candidates were moved to Review.`)
  if (repos.some(r => r.limits.some(l => l.area === 'artifacts' && !r.error))) out.push('At least one repository has more artifacts than a single scan reads.')
  if (!packages.available) out.push(`Packages: ${packages.message ?? 'unavailable'}`)
  else out.push('Packages are listed without sizes: the GitHub API does not expose package storage in bytes.')
  if (!billing.available) out.push('Billing data unavailable. ' + (billing.message ?? ''))
  out.push('Artifact types and purposes are inferred from names and workflow metadata, not from file contents.')
  out.push('Organization-owned repositories are billed to the organization, not to your personal allowance.')
  return out
}
