// GitHub's self-hosted runner API, through the same GitHub CLI session the Storage module uses (a GhCli with the
// 'runners' profile: GET anywhere, POST only for registration and removal tokens, DELETE only for one runner by id).
// Tokens returned here are handed to the install or remove step and are never persisted or logged.
import type { GitHubRunner, LatestRelease, PackageInfo, RunnerArch, RunnerGroupInfo, RunnerOs, RunnerScope } from '../../shared/runners.js'
import { GhError, type GhApi } from '../storage/gh.js'
import { GitHub, type GitHubOptions, type RepoSummary } from '../storage/github.js'
import { scopeApiBase, scopeLabel, validOwner, validRepoFull, validVersion } from './model.js'

type Json = Record<string, unknown>
const s = (x: unknown) => (typeof x === 'string' ? x : null)
const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null)

export type TokenResult = { token: string; expiresAt: string | null }

export const RUNNER_RELEASES = 'https://github.com/actions/runner/releases'

/** Package key as the runner project names its assets: linux-x64, osx-arm64, win-x64, linux-arm. */
export function packageKey(os: RunnerOs, arch: RunnerArch): string | null {
  const o = os === 'windows' ? 'win' : os === 'macos' ? 'osx' : os === 'linux' ? 'linux' : null
  const a = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : arch === 'arm' && os === 'linux' ? 'arm' : null
  return o && a ? `${o}-${a}` : null
}

export function packageFor(os: RunnerOs, arch: RunnerArch, version: string, checksums: Record<string, string>): PackageInfo | null {
  const key = packageKey(os, arch)
  if (!key || !validVersion(version)) return null
  const filename = `actions-runner-${key}-${version}.${os === 'windows' ? 'zip' : 'tar.gz'}`
  const sha = checksums[key] ?? null
  return { version, os, arch, filename, downloadUrl: `${RUNNER_RELEASES}/download/v${version}/${filename}`, sha256: sha, checksumSource: sha ? 'release-notes' : 'none' }
}

/** The release notes of actions/runner carry one SHA-256 per package between HTML comment markers. */
export function parseReleaseChecksums(body: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /<!--\s*BEGIN SHA ([a-z]+-[a-z0-9]+)\s*-->\s*([0-9a-fA-F]{64})\s*<!--\s*END SHA \1\s*-->/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body))) out[m[1]] = m[2].toLowerCase()
  return out
}

export function parseRunner(x: Json, scope: RunnerScope, fetchedAt: string): GitHubRunner | null {
  const id = n(x.id), name = s(x.name)
  if (id === null || !name) return null
  const status = s(x.status)
  const labels = (Array.isArray(x.labels) ? (x.labels as Json[]) : []).flatMap(l => { const ln = s(l.name); return ln ? [{ name: ln, type: l.type === 'read-only' ? 'read-only' as const : 'custom' as const }] : [] })
  return {
    id, name, os: s(x.os) ?? 'unknown', status: status === 'online' ? 'online' : status === 'offline' ? 'offline' : 'unknown', busy: x.busy === true, labels, scope,
    runnerGroupId: n(x.runner_group_id), runnerGroupName: null, ephemeral: typeof x.ephemeral === 'boolean' ? x.ephemeral : null, fetchedAt,
  }
}

const OS_FROM_DOWNLOAD: Record<string, RunnerOs> = { linux: 'linux', osx: 'macos', win: 'windows' }
const ARCH_FROM_DOWNLOAD: Record<string, RunnerArch> = { x64: 'x64', arm64: 'arm64', arm: 'arm' }

export function parseDownloads(body: unknown): PackageInfo[] {
  if (!Array.isArray(body)) return []
  return (body as Json[]).flatMap(d => {
    const os = OS_FROM_DOWNLOAD[s(d.os) ?? ''], arch = ARCH_FROM_DOWNLOAD[s(d.architecture) ?? ''], url = s(d.download_url), filename = s(d.filename)
    if (!os || !arch || !url || !filename) return []
    const version = /-(\d+\.\d+\.\d+)\.(?:tar\.gz|zip)$/.exec(filename)?.[1]
    if (!version) return []
    const sha = s(d.sha256_checksum)
    return [{ version, os, arch, filename, downloadUrl: url, sha256: sha ? sha.toLowerCase() : null, checksumSource: sha ? 'downloads-api' as const : 'none' as const }]
  })
}

/** Only GitHub's own release hosts may serve a runner package. */
export function trustedDownloadUrl(url: string): boolean {
  let u: URL
  try { u = new URL(url) } catch { return false }
  if (u.protocol !== 'https:') return false
  const host = u.hostname.toLowerCase()
  if (host === 'github.com') return /^\/actions\/runner\/releases\/download\/v\d+\.\d+\.\d+\/actions-runner-[a-z]+-[a-z0-9]+-\d+\.\d+\.\d+\.(tar\.gz|zip)$/.test(u.pathname)
  return host === 'objects.githubusercontent.com' || host === 'release-assets.githubusercontent.com' || /^[a-z0-9-]+\.actions\.githubusercontent\.com$/.test(host)
}

export class RunnerGitHub {
  readonly gh: GitHub
  constructor(api: GhApi, opts: GitHubOptions = {}) { this.gh = new GitHub(api, opts) }

  async listRunners(scope: RunnerScope): Promise<{ runners: GitHubRunner[]; truncated: boolean }> {
    const at = new Date().toISOString()
    const r = await this.gh.paged<GitHubRunner>(`${scopeApiBase(scope)}/actions/runners`, b => (b.runners as unknown[]) ?? [], x => parseRunner(x, scope, at), 20)
    if (scope.kind === 'org' && r.items.some(x => x.runnerGroupId !== null)) {
      try {
        const groups = await this.runnerGroups(scope.org)
        for (const x of r.items) x.runnerGroupName = groups.find(g => g.id === x.runnerGroupId)?.name ?? null
      } catch { /* group names are a convenience; listing works without them */ }
    }
    return { runners: r.items, truncated: r.truncated }
  }

  async getRunner(scope: RunnerScope, id: number): Promise<GitHubRunner | null> {
    try { return parseRunner(await this.gh.get<Json>(`${scopeApiBase(scope)}/actions/runners/${id}`), scope, new Date().toISOString()) } catch (e) {
      if (e instanceof GhError && e.kind === 'not-found') return null
      throw e
    }
  }

  private async token(scope: RunnerScope, kind: 'registration-token' | 'remove-token'): Promise<TokenResult> {
    const res = await this.gh.send('POST', `${scopeApiBase(scope)}/actions/runners/${kind}`)
    const b = (res.body ?? {}) as Json
    const token = s(b.token)
    if (!token) throw new GhError('request', `GitHub did not return a ${kind === 'registration-token' ? 'registration' : 'removal'} token for ${scopeLabel(scope)}.`)
    return { token, expiresAt: s(b.expires_at) }
  }
  /** A registration token (valid about an hour). Needs repository administration or organization self-hosted runner permission. */
  registrationToken(scope: RunnerScope) { return this.token(scope, 'registration-token') }
  removeToken(scope: RunnerScope) { return this.token(scope, 'remove-token') }

  /** Removes one registration. GitHub refuses while the runner is busy unless it is offline. */
  async deleteRunner(scope: RunnerScope, id: number): Promise<void> {
    if (!Number.isSafeInteger(id) || id <= 0) throw new GhError('request', 'Invalid runner id.')
    await this.gh.send('DELETE', `${scopeApiBase(scope)}/actions/runners/${id}`)
  }

  /** Official packages for every platform, with GitHub's SHA-256 (needs the same permission as registering). */
  async downloads(scope: RunnerScope): Promise<PackageInfo[]> {
    return parseDownloads(await this.gh.get(`${scopeApiBase(scope)}/actions/runners/downloads`))
  }

  async runnerGroups(org: string): Promise<RunnerGroupInfo[]> {
    if (!validOwner(org)) throw new GhError('request', 'Invalid organization.')
    const r = await this.gh.paged<RunnerGroupInfo>(`/orgs/${encodeURIComponent(org)}/actions/runner-groups`, b => (b.runner_groups as unknown[]) ?? [], x => {
      const id = n(x.id), name = s(x.name)
      return id !== null && name ? { id, name, default: x.default === true, visibility: s(x.visibility) ?? 'unknown', allowsPublic: x.allows_public_repositories === true, selectedRepos: null } : null
    }, 5)
    return r.items
  }

  async groupRepos(org: string, groupId: number): Promise<string[]> {
    const r = await this.gh.paged<string>(`/orgs/${encodeURIComponent(org)}/actions/runner-groups/${groupId}/repositories`, b => (b.repositories as unknown[]) ?? [], x => s(x.full_name), 10)
    return r.items
  }

  async userOrgs(): Promise<string[]> {
    const r = await this.gh.paged<string>('/user/orgs', b => (b._ as unknown[]) ?? [], x => s(x.login), 5)
    return r.items.filter(validOwner)
  }

  /** admin, member, or null when the membership cannot be read. */
  async orgRole(org: string): Promise<'admin' | 'member' | null> {
    try { const m = await this.gh.get<Json>(`/user/memberships/orgs/${encodeURIComponent(org)}`); return m.role === 'admin' ? 'admin' : m.role === 'member' ? 'member' : null } catch { return null }
  }

  async latestRelease(): Promise<LatestRelease & { checksums: Record<string, string> }> {
    const r = await this.gh.get<Json>('/repos/actions/runner/releases/latest')
    const tag = s(r.tag_name) ?? ''
    const version = tag.replace(/^v/, '')
    if (!validVersion(version)) throw new GhError('request', 'GitHub returned an unexpected runner release.')
    return { version, checkedAt: new Date().toISOString(), url: s(r.html_url) ?? `${RUNNER_RELEASES}/tag/${tag}`, checksums: parseReleaseChecksums(s(r.body) ?? '') }
  }

  async adminRepos(): Promise<RepoSummary[]> { return (await this.gh.listRepos()).filter(r => r.canAdmin) }

  async repo(fullName: string): Promise<RepoSummary> {
    if (!validRepoFull(fullName)) throw new GhError('request', 'Invalid repository name.')
    return this.gh.getRepo(fullName)
  }

  /** Workflow files of a repository's default branch (name and text), for the label analysis. */
  async workflowFiles(repo: string, branch: string): Promise<{ path: string; text: string }[]> {
    if (!validRepoFull(repo)) throw new GhError('request', 'Invalid repository name.')
    const [o, r] = repo.split('/')
    const t = await this.gh.get<Json>(`/repos/${encodeURIComponent(o)}/${encodeURIComponent(r)}/git/trees/${encodeURIComponent(branch)}?recursive=1`)
    const tree = (Array.isArray(t.tree) ? t.tree : []) as Json[]
    const files = tree.filter(e => e.type === 'blob' && typeof e.path === 'string' && /^\.github\/workflows\/[^/]+\.ya?ml$/i.test(e.path as string) && (n(e.size) ?? 0) <= 256 * 1024).slice(0, 40)
    const out: { path: string; text: string }[] = []
    for (const f of files) out.push({ path: f.path as string, text: await this.gh.fileText(repo, f.path as string) })
    return out
  }
}
