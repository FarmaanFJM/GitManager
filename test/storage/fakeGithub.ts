import type { AuthState } from '../../src/shared/storage.js'
import type { GhApi, GhMethod, GhRequestOptions, GhResponse } from '../../src/core/storage/gh.js'
import { GhError } from '../../src/core/storage/gh.js'

export type FakeArtifact = { id: number; name: string; size: number; created: string; expired?: boolean; run: number | null; branch?: string; sha?: string }
export type FakeRun = { id: number; name?: string; path?: string; status?: string; conclusion?: string | null; event?: string; branch?: string; sha?: string; prs?: number[] }
export type FakeRepo = {
  full: string; private?: boolean; archived?: boolean; push?: boolean; owner?: string
  artifacts: FakeArtifact[]; runs: FakeRun[]; pulls?: { number: number; ref: string; sha: string }[]
  tags?: string[]
  releases?: { tag: string; draft?: boolean; prerelease?: boolean; sha?: string }[]; docs?: Record<string, string>
  caches?: { key: string; size: number }[]
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): GhResponse => ({ status, headers: { 'content-type': 'application/json', ...headers }, body })
const err = (status: number, message: string, headers: Record<string, string> = {}) => json(status, { message }, headers)

/** An in-memory GitHub that speaks the endpoints GitManager uses, with failure injection for the destructive tests. */
export class FakeGitHub implements GhApi {
  repos: FakeRepo[] = []
  login = 'me'
  auth: AuthState = { state: 'ok', login: 'me', scopes: ['repo', 'read:org'], scopesKnown: true, canWrite: true, plan: 'free' }
  calls: { method: string; path: string }[] = []
  deleted: { repo: string; id: number }[] = []
  /** Return a response to override the normal handling of a request, or undefined to let it through. */
  intercept: ((method: string, path: string) => GhResponse | undefined | Promise<GhResponse | undefined>) | null = null
  /** Run before a request is answered, to change the world between a scan and a deletion. */
  before: ((method: string, path: string) => void) | null = null
  /** When true, a DELETE answers 204 but the artifact stays (GitHub has not processed it yet). */
  ignoreDeletes = false
  billing: unknown = { usageItems: [{ product: 'actions', sku: 'actions_storage', unitType: 'GigabyteHours', quantity: 12.5, grossAmount: 0.1, netAmount: 0 }, { product: 'actions', sku: 'actions_linux', unitType: 'Minutes', quantity: 340, grossAmount: 2.7, netAmount: 0 }] }
  packages: unknown[] | 'forbidden' = []

  authState = async () => this.auth

  repo(full: string) { return this.repos.find(r => r.full.toLowerCase() === full.toLowerCase()) }
  count(method: string, re: RegExp) { return this.calls.filter(c => c.method === method && re.test(c.path)).length }

  async request(method: GhMethod, path: string, _o: GhRequestOptions = {}): Promise<GhResponse> {
    this.calls.push({ method, path })
    this.before?.(method, path)
    const over = await this.intercept?.(method, path)
    if (over) return over
    const [p, qs = ''] = path.split('?')
    const q = new URLSearchParams(qs)
    const page = Number(q.get('page') ?? 1), per = Number(q.get('per_page') ?? 30)
    const slice = <T>(l: T[]) => l.slice((page - 1) * per, page * per)

    if (p === '/user') return json(200, { login: this.login, plan: { name: 'free' } }, { 'x-oauth-scopes': 'repo, read:org' })
    if (p === '/user/repos') return json(200, slice(this.repos.map(r => this.repoJson(r))))
    if (p === '/user/packages') return this.packages === 'forbidden' ? err(403, 'You need at least read:packages scope') : json(200, q.get('package_type') === 'container' ? this.packages : [])
    if (p === `/users/${this.login}/settings/billing/usage`) return json(200, this.billing)

    const m = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(p)
    if (!m) return err(404, 'Not Found')
    const repo = this.repo(decodeURIComponent(m[1]).replace('%2F', '/'))
    if (!repo) return err(404, 'Not Found')
    const rest = m[2] ?? ''
    if (rest === '' && method === 'GET') return json(200, this.repoJson(repo))
    if (rest === '/actions/artifacts' && method === 'GET') {
      const list = repo.artifacts
      return json(200, { total_count: list.length, artifacts: slice(list).map(a => this.artifactJson(repo, a)) })
    }
    const am = /^\/actions\/artifacts\/(\d+)$/.exec(rest)
    if (am) {
      const a = repo.artifacts.find(x => x.id === Number(am[1]))
      if (!a) return err(404, 'Not Found')
      if (method === 'GET') return json(200, this.artifactJson(repo, a))
      if (method === 'DELETE') {
        if (repo.push === false) return err(403, 'Resource not accessible by integration')
        if (!this.ignoreDeletes) repo.artifacts = repo.artifacts.filter(x => x.id !== a.id)
        this.deleted.push({ repo: repo.full, id: a.id })
        return { status: 204, headers: {}, body: null }
      }
    }
    if (rest === '/actions/runs') return json(200, { total_count: repo.runs.length, workflow_runs: slice(repo.runs).map(r => this.runJson(repo, r)) })
    const rm = /^\/actions\/runs\/(\d+)$/.exec(rest)
    if (rm) { const r = repo.runs.find(x => x.id === Number(rm[1])); return r ? json(200, this.runJson(repo, r)) : err(404, 'Not Found') }
    if (rest === '/pulls') return json(200, slice(repo.pulls ?? []).map(x => ({ number: x.number, head: { ref: x.ref, sha: x.sha } })))
    if (rest === '/tags') return json(200, (repo.tags ?? repo.releases?.map(r => r.tag) ?? []).map(name => ({ name })))
    if (rest === '/releases') return json(200, (repo.releases ?? []).map(r => ({ tag_name: r.tag, draft: !!r.draft, prerelease: !!r.prerelease, published_at: '2026-01-01T00:00:00Z' })))
    const cm = /^\/commits\/(.+)$/.exec(rest)
    if (cm) { const r = repo.releases?.find(x => x.tag === decodeURIComponent(cm[1])); return r ? json(200, { sha: r.sha ?? `tag-${r.tag}` }) : err(404, 'Not Found') }
    if (rest.startsWith('/git/trees/')) {
      const docs = repo.docs ?? {}
      return json(200, { sha: `tree-${Object.keys(docs).length}`, tree: Object.keys(docs).map(path => ({ type: 'blob', path, size: docs[path].length })) })
    }
    const fm = /^\/contents\/(.+)$/.exec(rest)
    if (fm) { const t = (repo.docs ?? {})[decodeURIComponent(fm[1])]; return t === undefined ? err(404, 'Not Found') : { status: 200, headers: { 'content-type': 'text/plain' }, body: t } }
    if (rest === '/actions/cache/usage') return json(200, { active_caches_size_in_bytes: (repo.caches ?? []).reduce((n, c) => n + c.size, 0), active_caches_count: (repo.caches ?? []).length })
    if (rest === '/actions/caches') return json(200, { actions_caches: (repo.caches ?? []).map(c => ({ key: c.key, size_in_bytes: c.size, ref: 'refs/heads/main', last_accessed_at: '2026-10-01T00:00:00Z', created_at: '2026-09-01T00:00:00Z' })) })
    return err(404, 'Not Found')
  }

  private repoJson(r: FakeRepo) {
    return { full_name: r.full, private: !!r.private, archived: !!r.archived, default_branch: 'main', pushed_at: '2026-10-01T00:00:00Z', owner: { login: r.owner ?? r.full.split('/')[0], type: 'User' }, permissions: { push: r.push !== false, admin: r.push !== false } }
  }
  private artifactJson(r: FakeRepo, a: FakeArtifact) {
    const run = a.run !== null ? { id: a.run, repository_id: 1, head_repository_id: 1, head_branch: a.branch ?? r.runs.find(x => x.id === a.run)?.branch ?? 'main', head_sha: a.sha ?? r.runs.find(x => x.id === a.run)?.sha ?? 'abc' } : null
    return { id: a.id, name: a.name, size_in_bytes: a.size, expired: !!a.expired, created_at: a.created, expires_at: a.created, workflow_run: run }
  }
  private runJson(r: FakeRepo, x: FakeRun) {
    return { id: x.id, name: x.name ?? 'CI', path: x.path ?? '.github/workflows/ci.yml', status: x.status ?? 'completed', conclusion: x.conclusion === undefined ? 'success' : x.conclusion, event: x.event ?? 'push', run_number: x.id, head_branch: x.branch ?? 'main', head_sha: x.sha ?? `sha${x.id}`, html_url: `https://github.com/${r.full}/actions/runs/${x.id}`, pull_requests: (x.prs ?? []).map(number => ({ number })) }
  }
}

/** Builds a repository with `n` successful builds of one family, newest first, for quick scenarios. */
export function builds(full: string, name: string, ages: number[], now: number, idBase: number, over: Partial<FakeArtifact> = {}): Pick<FakeRepo, 'artifacts' | 'runs'> & { full: string } {
  const artifacts: FakeArtifact[] = [], runs: FakeRun[] = []
  ages.forEach((d, i) => {
    const run = idBase + i
    runs.push({ id: run, conclusion: 'success' })
    artifacts.push({ id: idBase * 10 + i, name, size: 20 * 1024 * 1024, created: new Date(now - d * 86_400_000).toISOString(), run, ...over })
  })
  return { full, artifacts, runs }
}

export { GhError }
