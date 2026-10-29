import { describe, expect, it } from 'vitest'
import { errorFor, ghCandidates, GhCli, GhError, parseInclude } from '../../src/core/storage/gh.js'
import type { ExecResult, ExecSpec } from '../../src/core/exec.js'

const ok = (stdout: string, stderr = '', code = 0): ExecResult => ({ code, stdout, stderr, timedOut: false })
const http = (status: number, headers: Record<string, string>, body: unknown) =>
  `HTTP/2.0 ${status} X\r\n${Object.entries({ 'content-type': 'application/json', ...headers }).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n${typeof body === 'string' ? body : JSON.stringify(body)}`

function cli(handler: (spec: ExecSpec) => ExecResult) {
  const calls: ExecSpec[] = []
  const runner = async (spec: ExecSpec) => { calls.push(spec); return handler(spec) }
  return { calls, gh: new GhCli({ runner: runner as never, candidates: ['gh'] }) }
}

describe('gh api output', () => {
  it('parses status, headers and a JSON body, and an empty 204', () => {
    const r = parseInclude(http(200, { 'x-ratelimit-remaining': '4999' }, { a: 1 }))!
    expect(r).toMatchObject({ status: 200, body: { a: 1 }, headers: { 'x-ratelimit-remaining': '4999' } })
    expect(parseInclude('HTTP/2.0 204 No Content\r\n\r\n')).toMatchObject({ status: 204, body: null })
    expect(parseInclude('not http')).toBeNull()
  })

  it('maps failures to what the user can act on', () => {
    const e = (status: number, headers: Record<string, string>, message: string) => errorFor({ status, headers, body: { message } })
    expect(e(401, {}, 'Bad credentials').kind).toBe('auth')
    expect(e(403, {}, 'Resource not accessible by personal access token').kind).toBe('permission')
    expect(e(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 30) }, 'API rate limit exceeded')).toMatchObject({ kind: 'rate-limit' })
    expect(e(403, { 'retry-after': '12' }, 'secondary rate limit').retryAfterMs).toBe(12_000)
    expect(e(429, {}, 'slow down').kind).toBe('rate-limit')
    expect(e(404, {}, 'Not Found').kind).toBe('not-found')
    expect(e(410, {}, 'gone').kind).toBe('gone')
    expect(e(502, {}, 'bad gateway').kind).toBe('server')
    expect(e(403, {}, 'Artifact storage quota has been hit. Wait for usage to refresh.').kind).toBe('quota')
  })
})

describe('GitHub CLI access', () => {
  it('passes arguments as an array, never a shell string, and turns prompts, colour and debug output off', async () => {
    const { calls, gh } = cli(() => ok(http(200, {}, { ok: true })))
    await gh.request('GET', '/repos/o/r/actions/artifacts?per_page=100&page=1')
    expect(calls[0].file).toBe('gh')
    expect(calls[0].args.slice(0, 4)).toEqual(['api', '-i', '-X', 'GET'])
    expect(calls[0].env).toMatchObject({ GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_DEBUG: '' })
    expect(calls[0].args.join(' ')).not.toMatch(/token|authorization/i)
  })

  it('refuses paths that are not plain GitHub API paths', async () => {
    const { gh, calls } = cli(() => ok(http(200, {}, {})))
    for (const bad of ['https://evil.example/x', '/repos/o/r; rm -rf /', '/repos/o/r\n/x', 'repos/o/r', '/repos/o/r && echo']) await expect(gh.request('GET', bad)).rejects.toBeInstanceOf(GhError)
    expect(calls).toHaveLength(0)
  })

  it('tells missing sign-in, missing CLI and insufficient scope apart', async () => {
    const signedOut = cli(() => ok('', 'To get started with GitHub CLI, please run:  gh auth login', 4))
    expect(await signedOut.gh.authState()).toMatchObject({ state: 'unauthenticated' })
    const missing = new GhCli({ runner: (async () => ({ code: null, stdout: '', stderr: '', timedOut: false, spawnError: 'ENOENT' })) as never, candidates: ['gh'] })
    expect(await missing.authState()).toMatchObject({ state: 'no-gh' })
    const expired = cli(() => ok(http(401, {}, { message: 'Bad credentials' })))
    expect(await expired.gh.authState()).toMatchObject({ state: 'unauthenticated' })
    const readOnly = cli(() => ok(http(200, { 'x-oauth-scopes': 'read:org, gist' }, { login: 'me', plan: { name: 'free' } })))
    expect(await readOnly.gh.authState()).toMatchObject({ state: 'ok', login: 'me', canWrite: false, scopes: ['read:org', 'gist'] })
    const full = cli(() => ok(http(200, { 'x-oauth-scopes': 'repo, read:org' }, { login: 'me' })))
    expect(await full.gh.authState()).toMatchObject({ state: 'ok', canWrite: true })
    const fine = cli(() => ok(http(200, {}, { login: 'me' })))
    expect(await fine.gh.authState()).toMatchObject({ state: 'ok', scopesKnown: false, canWrite: null })
  })

  it('never asks for or reads a token: the CLI session is the only credential', async () => {
    const { calls, gh } = cli(() => ok(http(200, { 'x-oauth-scopes': 'repo' }, { login: 'me' })))
    await gh.authState()
    expect(calls.flatMap(c => c.args)).not.toContain('token')
    expect(JSON.stringify(calls)).not.toMatch(/ghp_|gho_|github_pat_/)
  })

  it('finds gh in the usual Windows install folders when the PATH of a GUI app lacks it', () => {
    const list = ghCandidates({ ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' } as never, 'win32')
    expect(list[0]).toBe('gh')
    expect(list.some(p => /Program Files.*GitHub CLI.*gh\.exe$/.test(p))).toBe(true)
  })
})
