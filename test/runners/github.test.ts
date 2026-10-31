import { describe, expect, it } from 'vitest'
import { RunnerGitHub, packageFor, packageKey, parseDownloads, parseReleaseChecksums, parseRunner, trustedDownloadUrl } from '../../src/core/runners/github.js'
import { GhCli, GhError } from '../../src/core/storage/gh.js'
import type { ExecResult, ExecSpec } from '../../src/core/exec.js'
import { FakeRunnerGitHub } from './fakes.js'

describe('GitHub runner API', () => {
  it('parses repository and organization runner records, labels by type, and group ids', () => {
    const at = '2026-10-31T00:00:00Z'
    const r = parseRunner({ id: 7, name: 'box', os: 'Linux', status: 'online', busy: true, runner_group_id: 3, ephemeral: false, labels: [{ name: 'self-hosted', type: 'read-only' }, { name: 'gpu', type: 'custom' }] }, { kind: 'org', org: 'acme' }, at)!
    expect(r).toMatchObject({ id: 7, name: 'box', status: 'online', busy: true, runnerGroupId: 3, labels: [{ name: 'self-hosted', type: 'read-only' }, { name: 'gpu', type: 'custom' }] })
    expect(parseRunner({ id: 8, name: 'x', status: 'weird' }, { kind: 'repo', owner: 'a', repo: 'b' }, at)!.status).toBe('unknown')
    expect(parseRunner({ name: 'no id' }, { kind: 'repo', owner: 'a', repo: 'b' }, at)).toBeNull()
  })

  it('pages through runners and resolves group names for organizations', async () => {
    const gh = new FakeRunnerGitHub()
    gh.scopes.push({ key: 'acme', kind: 'org', runners: Array.from({ length: 130 }, (_, i) => ({ id: i + 1, name: `r${i + 1}`, os: 'Linux', status: 'online' as const, group: 2 })), groups: [{ id: 1, name: 'Default', default: true }, { id: 2, name: 'gpu' }] })
    const api = new RunnerGitHub(gh)
    const r = await api.listRunners({ kind: 'org', org: 'acme' })
    expect(r.runners).toHaveLength(130); expect(r.truncated).toBe(false)
    expect(r.runners[0].runnerGroupName).toBe('gpu')
    expect(gh.count('GET', /\/orgs\/acme\/actions\/runners\?/)).toBe(2)
  })

  it('maps permission, not-found and rate-limit failures so the inventory can say what it could not read', async () => {
    const gh = new FakeRunnerGitHub()
    gh.scopes.push({ key: 'acme/secret', kind: 'repo', admin: false, runners: [] })
    const api = new RunnerGitHub(gh, { sleep: async () => {}, maxWaitMs: 10 })
    await expect(api.listRunners({ kind: 'repo', owner: 'acme', repo: 'secret' })).rejects.toMatchObject({ kind: 'permission' })
    await expect(api.listRunners({ kind: 'repo', owner: 'acme', repo: 'none' })).rejects.toMatchObject({ kind: 'not-found' })
    gh.intercept = (_m, p) => (p.includes('/actions/runners') ? { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600) }, body: { message: 'API rate limit exceeded' } } : undefined)
    await expect(api.listRunners({ kind: 'repo', owner: 'acme', repo: 'secret' })).rejects.toMatchObject({ kind: 'rate-limit' })
  })

  it('requests registration and removal tokens with POST and returns their expiry', async () => {
    const gh = new FakeRunnerGitHub()
    gh.scopes.push({ key: 'acme/app', kind: 'repo', runners: [] })
    const api = new RunnerGitHub(gh)
    const t = await api.registrationToken({ kind: 'repo', owner: 'acme', repo: 'app' })
    expect(t.token).toMatch(/^A[A-Z0-9]{28}$/); expect(t.expiresAt).toBeTruthy()
    await api.removeToken({ kind: 'repo', owner: 'acme', repo: 'app' })
    expect(gh.calls.filter(c => c.method === 'POST').map(c => c.path)).toEqual(['/repos/acme/app/actions/runners/registration-token', '/repos/acme/app/actions/runners/remove-token'])
  })

  it('deletes one runner by id and refuses a busy one as GitHub does', async () => {
    const gh = new FakeRunnerGitHub()
    gh.scopes.push({ key: 'acme/app', kind: 'repo', runners: [{ id: 1, name: 'a', os: 'Linux', status: 'online' }, { id: 2, name: 'b', os: 'Linux', status: 'online', busy: true }] })
    const api = new RunnerGitHub(gh)
    await api.deleteRunner({ kind: 'repo', owner: 'acme', repo: 'app' }, 1)
    expect(gh.scope('repo', 'acme/app')!.runners.map(r => r.id)).toEqual([2])
    await expect(api.deleteRunner({ kind: 'repo', owner: 'acme', repo: 'app' }, 2)).rejects.toBeInstanceOf(GhError)
    await expect(api.deleteRunner({ kind: 'repo', owner: 'acme', repo: 'app' }, -1)).rejects.toBeInstanceOf(GhError)
  })
})

describe('packages and checksums', () => {
  it('selects the official package for a platform and architecture', () => {
    expect(packageKey('linux', 'x64')).toBe('linux-x64'); expect(packageKey('macos', 'arm64')).toBe('osx-arm64'); expect(packageKey('windows', 'x64')).toBe('win-x64')
    expect(packageKey('windows', 'arm')).toBeNull(); expect(packageKey('unknown', 'x64')).toBeNull()
    const p = packageFor('linux', 'arm64', '2.321.0', { 'linux-arm64': 'f'.repeat(64) })!
    expect(p).toMatchObject({ filename: 'actions-runner-linux-arm64-2.321.0.tar.gz', downloadUrl: 'https://github.com/actions/runner/releases/download/v2.321.0/actions-runner-linux-arm64-2.321.0.tar.gz', sha256: 'f'.repeat(64), checksumSource: 'release-notes' })
    expect(packageFor('windows', 'x64', '2.321.0', {})).toMatchObject({ filename: 'actions-runner-win-x64-2.321.0.zip', sha256: null, checksumSource: 'none' })
    expect(packageFor('linux', 'x64', 'latest', {})).toBeNull()
  })
  it('reads SHA-256 values from the release notes markers and from the downloads endpoint', () => {
    const body = 'notes\n<!-- BEGIN SHA linux-x64 -->ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef0123456789<!-- END SHA linux-x64 -->\n<!-- BEGIN SHA win-x64 -->' + '1'.repeat(64) + '<!-- END SHA win-x64 -->'
    expect(parseReleaseChecksums(body)).toEqual({ 'linux-x64': 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789', 'win-x64': '1'.repeat(64) })
    const d = parseDownloads([{ os: 'osx', architecture: 'arm64', download_url: 'https://github.com/actions/runner/releases/download/v2.321.0/actions-runner-osx-arm64-2.321.0.tar.gz', filename: 'actions-runner-osx-arm64-2.321.0.tar.gz', sha256_checksum: 'A'.repeat(64) }, { os: 'plan9', architecture: 'x64' }])
    expect(d).toEqual([{ version: '2.321.0', os: 'macos', arch: 'arm64', filename: 'actions-runner-osx-arm64-2.321.0.tar.gz', downloadUrl: 'https://github.com/actions/runner/releases/download/v2.321.0/actions-runner-osx-arm64-2.321.0.tar.gz', sha256: 'a'.repeat(64), checksumSource: 'downloads-api' }])
  })
  it('trusts only GitHub release hosts for downloads', () => {
    expect(trustedDownloadUrl('https://github.com/actions/runner/releases/download/v2.321.0/actions-runner-linux-x64-2.321.0.tar.gz')).toBe(true)
    expect(trustedDownloadUrl('https://objects.githubusercontent.com/github-production-release-asset/x?y=z')).toBe(true)
    expect(trustedDownloadUrl('https://github.com/evil/runner/releases/download/v1/x.tar.gz')).toBe(false)
    expect(trustedDownloadUrl('http://github.com/actions/runner/releases/download/v2.321.0/actions-runner-linux-x64-2.321.0.tar.gz')).toBe(false)
    expect(trustedDownloadUrl('https://example.com/actions-runner.tar.gz')).toBe(false)
  })
})

describe('the GitHub CLI boundary for runners', () => {
  const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '', timedOut: false })
  const http = (status: number, body: unknown) => `HTTP/2.0 ${status} X\r\ncontent-type: application/json\r\n\r\n${JSON.stringify(body)}`
  const cli = (profile: 'storage' | 'runners') => { const calls: ExecSpec[] = []; const gh = new GhCli({ runner: (async (s: ExecSpec) => { calls.push(s); return ok(http(200, {})) }) as never, candidates: ['gh'], profile, logFile: null }); return { calls, gh } }

  it('allows POST only for registration and removal tokens and DELETE only for one runner registration', async () => {
    const { gh, calls } = cli('runners')
    await gh.request('POST', '/repos/o/r/actions/runners/registration-token')
    await gh.request('POST', '/orgs/o/actions/runners/remove-token')
    await gh.request('DELETE', '/repos/o/r/actions/runners/12')
    await gh.request('DELETE', '/orgs/o/actions/runners/3')
    expect(calls).toHaveLength(4)
    for (const [m, p] of [['POST', '/repos/o/r/actions/runners'], ['POST', '/repos/o/r/actions/runs/1/rerun'], ['POST', '/repos/o/r/actions/runners/registration-token/../x'], ['DELETE', '/repos/o/r/actions/artifacts/1'], ['DELETE', '/repos/o/r/actions/runners'], ['DELETE', '/repos/o/r/actions/runners/0'], ['DELETE', '/repos/o/r'], ['DELETE', '/orgs/o/actions/runner-groups/1']] as const) {
      await expect(gh.request(m, p), `${m} ${p}`).rejects.toBeInstanceOf(GhError)
    }
    expect(calls).toHaveLength(4)
  })
  it('keeps the Storage profile exactly as before: no POST at all, DELETE only for one artifact', async () => {
    const { gh, calls } = cli('storage')
    await expect(gh.request('POST', '/repos/o/r/actions/runners/registration-token')).rejects.toBeInstanceOf(GhError)
    await expect(gh.request('DELETE', '/repos/o/r/actions/runners/12')).rejects.toBeInstanceOf(GhError)
    await gh.request('DELETE', '/repos/o/r/actions/artifacts/12')
    expect(calls).toHaveLength(1)
  })
})
