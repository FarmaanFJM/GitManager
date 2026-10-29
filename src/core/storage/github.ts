import type { BillingInfo, BillingItem, CacheEntry, PackageEntry, RunInfo } from '../../shared/storage.js'
import type { RawArtifact } from './classify.js'
import { validRepoName } from './config.js'
import { errorFor, GhError, type GhApi, type GhMethod, type GhResponse } from './gh.js'

export type RepoSummary = { fullName: string; private: boolean; archived: boolean; canPush: boolean; canAdmin: boolean; defaultBranch: string; owner: string; ownerType: string; pushedAt: string | null }
export type ReleaseSummary = { tag: string; draft: boolean; prerelease: boolean; publishedAt: string | null }
export type PullSummary = { number: number; headRef: string; headSha: string }

type Json = Record<string, unknown>
const s = (x: unknown) => (typeof x === 'string' ? x : null)
const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null)

export type GitHubOptions = {
  sleep?: (ms: number) => Promise<void>
  /** Longest wait for a rate limit to lift before the operation gives up and reports it. */
  maxWaitMs?: number
  /** Called for every request, for tests and the request budget. Never receives credentials. */
  onRequest?: (method: string, path: string) => void
}

const encodeRepo = (full: string) => {
  if (!validRepoName(full)) throw new GhError('request', 'Invalid repository name.')
  const [o, r] = full.split('/')
  return `${encodeURIComponent(o)}/${encodeURIComponent(r)}`
}

/** Typed, paginated, rate-limit-aware GitHub calls. Failures are GhError values with a kind the interface can explain. */
export class GitHub {
  requests = 0
  private readonly sleep: (ms: number) => Promise<void>
  private readonly maxWaitMs: number
  constructor(readonly api: GhApi, private readonly opts: GitHubOptions = {}) {
    this.sleep = opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms)))
    this.maxWaitMs = opts.maxWaitMs ?? 60_000
  }

  /** One request with bounded retries: rate limits that lift soon are waited out, server errors retried twice. */
  async send(method: GhMethod, path: string, raw = false): Promise<GhResponse> {
    let attempt = 0
    for (;;) {
      this.requests++
      this.opts.onRequest?.(method, path)
      let res: GhResponse
      try { res = await this.api.request(method, path, { raw }) } catch (e) {
        if (e instanceof GhError && e.kind === 'network' && attempt < 2) { attempt++; await this.sleep(500 * 2 ** attempt); continue }
        throw e
      }
      if (res.status >= 200 && res.status < 300) return res
      const err = errorFor(res)
      if (err.kind === 'rate-limit') {
        const wait = err.retryAfterMs ?? 60_000
        if (wait > this.maxWaitMs || attempt >= 3) throw new GhError('rate-limit', `GitHub's rate limit was reached${err.resetAt ? `; it resets at ${new Date(err.resetAt).toLocaleTimeString()}` : ''}.`, err.status, err.retryAfterMs, err.resetAt)
        attempt++
        await this.sleep(wait + 250)
        continue
      }
      if (err.kind === 'server' && attempt < 2) { attempt++; await this.sleep(500 * 2 ** attempt); continue }
      throw err
    }
  }

  async get<T = unknown>(path: string): Promise<T> { return (await this.send('GET', path)).body as T }

  /** Pages of a list endpoint. `pick` extracts the items from a page body; paging stops on a short page or at `maxPages`. */
  async paged<T>(path: string, pick: (body: Json) => unknown[], map: (x: Json) => T | null, maxPages = 50, perPage = 100): Promise<{ items: T[]; truncated: boolean }> {
    const items: T[] = []
    const sep = path.includes('?') ? '&' : '?'
    for (let page = 1; page <= maxPages; page++) {
      const body = await this.get<Json>(`${path}${sep}per_page=${perPage}&page=${page}`)
      const raw = pick(Array.isArray(body) ? ({ _: body } as Json) : body)
      for (const x of raw) { const m = map(x as Json); if (m) items.push(m) }
      if (raw.length < perPage) return { items, truncated: false }
    }
    return { items, truncated: true }
  }

  /* ------------------------------------------------------------ repositories */

  private static repo(x: Json): RepoSummary | null {
    const full = s(x.full_name); if (!full) return null
    const perms = (x.permissions ?? {}) as Json
    const owner = (x.owner ?? {}) as Json
    return { fullName: full, private: x.private === true, archived: x.archived === true, canPush: perms.push === true || perms.admin === true || perms.maintain === true, canAdmin: perms.admin === true, defaultBranch: s(x.default_branch) ?? 'main', owner: s(owner.login) ?? full.split('/')[0], ownerType: s(owner.type) ?? 'User', pushedAt: s(x.pushed_at) }
  }

  async listRepos(): Promise<RepoSummary[]> {
    const r = await this.paged<RepoSummary>('/user/repos?affiliation=owner,collaborator,organization_member&sort=pushed', b => (b._ as unknown[]) ?? [], GitHub.repo, 30)
    return r.items
  }

  async getRepo(repo: string): Promise<RepoSummary> {
    const r = GitHub.repo(await this.get<Json>(`/repos/${encodeRepo(repo)}`))
    if (!r) throw new GhError('request', 'GitHub returned a repository GitManager cannot read.')
    return r
  }

  /* ------------------------------------------------------------ artifacts */

  private static artifact(x: Json, repo: string): RawArtifact | null {
    const id = n(x.id); const name = s(x.name)
    if (id === null || id <= 0 || name === null) return null
    const run = (x.workflow_run ?? null) as Json | null
    return {
      id, repo, name, sizeBytes: n(x.size_in_bytes) ?? 0, createdAt: s(x.created_at), expiresAt: s(x.expires_at), expired: x.expired === true,
      runId: run ? n(run.id) : null, headBranch: run ? s(run.head_branch) : null, headSha: run ? s(run.head_sha) : null,
    }
  }

  async listArtifacts(repo: string): Promise<{ items: RawArtifact[]; truncated: boolean }> {
    return this.paged(`/repos/${encodeRepo(repo)}/actions/artifacts`, b => (b.artifacts as unknown[]) ?? [], x => GitHub.artifact(x, repo), 100)
  }

  async getArtifact(repo: string, id: number): Promise<RawArtifact> {
    const a = GitHub.artifact(await this.get<Json>(`/repos/${encodeRepo(repo)}/actions/artifacts/${id}`), repo)
    if (!a) throw new GhError('request', 'GitHub returned an artifact GitManager cannot read.')
    return a
  }

  /** The only destructive call: one artifact, by id, in one repository. */
  async deleteArtifact(repo: string, id: number): Promise<void> {
    if (!Number.isSafeInteger(id) || id <= 0) throw new GhError('request', 'Invalid artifact id.')
    await this.send('DELETE', `/repos/${encodeRepo(repo)}/actions/artifacts/${id}`)
  }

  /* ------------------------------------------------------------ runs, pull requests, releases */

  private static run(x: Json): RunInfo | null {
    const id = n(x.id); if (id === null) return null
    const prs = Array.isArray(x.pull_requests) ? (x.pull_requests as Json[]).map(p => n(p.number)).filter((v): v is number => v !== null) : []
    return {
      id, name: s(x.name), path: s(x.path), status: s(x.status), conclusion: s(x.conclusion), event: s(x.event), runNumber: n(x.run_number),
      headBranch: s(x.head_branch), headSha: s(x.head_sha), htmlUrl: s(x.html_url) ?? '', pullNumbers: prs,
    }
  }

  async listRuns(repo: string, maxPages = 5): Promise<{ items: RunInfo[]; truncated: boolean }> {
    return this.paged(`/repos/${encodeRepo(repo)}/actions/runs`, b => (b.workflow_runs as unknown[]) ?? [], GitHub.run, maxPages)
  }

  async getRun(repo: string, id: number): Promise<RunInfo | null> {
    try { return GitHub.run(await this.get<Json>(`/repos/${encodeRepo(repo)}/actions/runs/${id}`)) } catch (e) {
      if (e instanceof GhError && (e.kind === 'not-found' || e.kind === 'gone')) return null
      throw e
    }
  }

  async listOpenPulls(repo: string): Promise<PullSummary[]> {
    const r = await this.paged<PullSummary>(`/repos/${encodeRepo(repo)}/pulls?state=open`, b => (b._ as unknown[]) ?? [], x => {
      const head = (x.head ?? {}) as Json; const num = n(x.number); const ref = s(head.ref)
      return num !== null && ref ? { number: num, headRef: ref, headSha: s(head.sha) ?? '' } : null
    }, 10)
    return r.items
  }

  async listReleases(repo: string): Promise<ReleaseSummary[]> {
    const r = await this.get<Json[]>(`/repos/${encodeRepo(repo)}/releases?per_page=30`)
    return (Array.isArray(r) ? r : []).flatMap(x => { const tag = s(x.tag_name); return tag ? [{ tag, draft: x.draft === true, prerelease: x.prerelease === true, publishedAt: s(x.published_at) }] : [] })
  }

  /** Commit a tag points at (annotated tags resolved), or null when it cannot be read. */
  async tagCommit(repo: string, tag: string): Promise<string | null> {
    try { return s((await this.get<Json>(`/repos/${encodeRepo(repo)}/commits/${encodeURIComponent(tag)}`)).sha) } catch { return null }
  }

  /* ------------------------------------------------------------ documentation */

  /** Markdown files at the root and under docs/, as {path, sha}, plus the tree sha so unchanged docs are not downloaded again. */
  async docFiles(repo: string, branch: string): Promise<{ treeSha: string; files: { path: string; size: number }[] }> {
    const t = await this.get<Json>(`/repos/${encodeRepo(repo)}/git/trees/${encodeURIComponent(branch)}?recursive=1`)
    const tree = (Array.isArray(t.tree) ? t.tree : []) as Json[]
    const files = tree.filter(e => e.type === 'blob' && typeof e.path === 'string' && /^(?:[^/]+|docs\/.+)\.md$/i.test(e.path as string))
      .map(e => ({ path: e.path as string, size: n(e.size) ?? 0 }))
      .filter(f => f.size <= 256 * 1024)
    const rank = (p: string) => (/audit|qualif|evidence|release|security|changelog|readme/i.test(p) ? 0 : 1)
    files.sort((a, b) => rank(a.path) - rank(b.path) || a.path.localeCompare(b.path))
    return { treeSha: s(t.sha) ?? '', files: files.slice(0, 15) }
  }

  async fileText(repo: string, path: string): Promise<string> {
    const enc = path.split('/').map(encodeURIComponent).join('/')
    const res = await this.send('GET', `/repos/${encodeRepo(repo)}/contents/${enc}`, true)
    return typeof res.body === 'string' ? res.body : JSON.stringify(res.body)
  }

  /* ------------------------------------------------------------ caches, packages, billing */

  async cacheUsage(repo: string): Promise<{ bytes: number; count: number }> {
    const b = await this.get<Json>(`/repos/${encodeRepo(repo)}/actions/cache/usage`)
    return { bytes: n(b.active_caches_size_in_bytes) ?? 0, count: n(b.active_caches_count) ?? 0 }
  }

  async listCaches(repo: string): Promise<CacheEntry[]> {
    const r = await this.paged<CacheEntry>(`/repos/${encodeRepo(repo)}/actions/caches?sort=size_in_bytes&direction=desc`, b => (b.actions_caches as unknown[]) ?? [], x => {
      const key = s(x.key); return key ? { key, ref: s(x.ref), sizeBytes: n(x.size_in_bytes) ?? 0, lastAccessedAt: s(x.last_accessed_at), createdAt: s(x.created_at) } : null
    }, 1)
    return r.items
  }

  async listPackages(): Promise<PackageEntry[]> {
    const out: PackageEntry[] = []
    for (const type of ['container', 'npm', 'maven', 'nuget', 'rubygems']) {
      const r = await this.paged<PackageEntry>(`/user/packages?package_type=${type}`, b => (b._ as unknown[]) ?? [], x => {
        const name = s(x.name); const repo = (x.repository ?? null) as Json | null
        return name ? { name, type, visibility: s(x.visibility), versionCount: n(x.version_count), repository: repo ? s(repo.full_name) : null, updatedAt: s(x.updated_at) } : null
      }, 5)
      out.push(...r.items)
    }
    return out
  }

  /** Billing for the current month from the enhanced billing platform. Quantities are usage, not current stored bytes. */
  async billing(login: string): Promise<BillingInfo> {
    const now = new Date()
    const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
    try {
      const b = await this.get<Json>(`/users/${encodeURIComponent(login)}/settings/billing/usage?year=${now.getUTCFullYear()}&month=${now.getUTCMonth() + 1}`)
      const items: BillingItem[] = (Array.isArray(b.usageItems) ? (b.usageItems as Json[]) : [])
        .filter(i => s(i.product) === 'actions' || s(i.product) === 'packages')
        .map(i => ({ product: s(i.product) ?? '', sku: s(i.sku) ?? '', unit: s(i.unitType) ?? '', quantity: n(i.quantity) ?? 0, gross: n(i.grossAmount), net: n(i.netAmount) }))
      return { available: true, message: null, period, items }
    } catch (e) {
      const err = e as GhError
      const why = err.kind === 'permission' || err.kind === 'auth' ? 'Your GitHub CLI sign-in is not allowed to read billing (a classic token needs the "user" scope: gh auth refresh -s user).'
        : err.kind === 'not-found' ? 'GitHub did not provide billing data for this account through the API (organization-owned repositories are billed to the organization).'
          : err.message
      return { available: false, message: why, period: null, items: [] }
    }
  }
}
