import { appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AuthState } from '../../shared/storage.js'
import { firstLine, run, type ExecSpec } from '../exec.js'

export type GhMethod = 'GET' | 'DELETE'
export type GhResponse = { status: number; headers: Record<string, string>; body: unknown }
export type GhRequestOptions = { raw?: boolean }

/** The one door to GitHub. The real implementation shells out to the GitHub CLI; tests substitute an in-memory GitHub. */
export interface GhApi {
  request(method: GhMethod, path: string, opts?: GhRequestOptions): Promise<GhResponse>
  /** Authentication as the CLI sees it. Never returns or logs a token. */
  authState(): Promise<AuthState>
}

export type GhErrorKind = 'auth' | 'permission' | 'not-found' | 'gone' | 'rate-limit' | 'quota' | 'request' | 'server' | 'network' | 'no-gh'

export class GhError extends Error {
  constructor(readonly kind: GhErrorKind, message: string, readonly status = 0, readonly retryAfterMs: number | null = null, readonly resetAt: number | null = null) {
    super(message)
    this.name = 'GhError'
  }
}

const QUOTA = /storage quota|artifact storage|quota (has been )?(hit|exceeded|reached)/i
const msgOf = (body: unknown) => (body && typeof body === 'object' && typeof (body as { message?: unknown }).message === 'string' ? (body as { message: string }).message : '')

/** Maps an HTTP failure to what the user can act on: missing sign-in, missing permission, a rate limit, or a plain failure. */
export function errorFor(res: GhResponse): GhError {
  const { status, headers } = res
  const message = msgOf(res.body) || `GitHub answered ${status}.`
  const remaining = headers['x-ratelimit-remaining']
  const reset = headers['x-ratelimit-reset'] ? Number(headers['x-ratelimit-reset']) * 1000 : null
  const retry = headers['retry-after'] ? Number(headers['retry-after']) * 1000 : null
  if (QUOTA.test(message)) return new GhError('quota', message, status)
  if (status === 401) return new GhError('auth', 'GitHub rejected the sign-in. Run "gh auth login" (or "gh auth refresh") and try again.', status)
  if (status === 429 || (status === 403 && (remaining === '0' || retry !== null || /rate limit|abuse|secondary/i.test(message)))) {
    return new GhError('rate-limit', message, status, retry ?? (reset !== null ? Math.max(0, reset - Date.now()) : null), reset)
  }
  if (status === 403) return new GhError('permission', message, status)
  if (status === 404) return new GhError('not-found', message, status)
  if (status === 410) return new GhError('gone', message, status)
  if (status >= 500) return new GhError('server', message, status)
  return new GhError('request', message, status)
}

/** Parses `gh api -i` output: a status line, headers, a blank line, then the body. */
export function parseInclude(out: string): GhResponse | null {
  const m = /^HTTP\/[\d.]+\s+(\d{3})[^\r\n]*\r?\n/.exec(out)
  if (!m) return null
  const rest = out.slice(m[0].length)
  const split = /\r?\n\r?\n/.exec(rest)
  const head = split ? rest.slice(0, split.index) : rest
  const bodyText = split ? rest.slice(split.index + split[0].length) : ''
  const headers: Record<string, string> = {}
  for (const line of head.split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim()
  }
  let body: unknown = bodyText
  if (bodyText.trim() && /json/i.test(headers['content-type'] ?? '')) { try { body = JSON.parse(bodyText) } catch { /* keep text */ } }
  else if (!bodyText.trim()) body = null
  return { status: Number(m[1]), headers, body }
}

const PATH = /^\/[A-Za-z0-9_./?=&%,:+-]*$/
/** The only request that changes anything: one artifact, by id, in one repository. Releases, assets, caches, packages and branches cannot match. */
export const DELETE_PATH = /^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/artifacts\/[1-9]\d{0,15}$/
/** Dot segments, doubled or encoded slashes and encoded dots could redirect a request; none is ever needed. */
const SUSPICIOUS = /(^|\/)\.{1,2}(\/|$|\?)|\/\/|%2e|%5c/i

export function ghCandidates(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string[] {
  const list: string[] = []
  if (env.GITMANAGER_GH) list.push(env.GITMANAGER_GH)
  list.push('gh')
  // A program started from the Start menu may not see the PATH of a terminal; the installer's default folders are tried too.
  if (platform === 'win32') {
    for (const base of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs')]) if (base) list.push(join(base, 'GitHub CLI', 'gh.exe'))
  }
  return list
}

export class GhCli implements GhApi {
  private exe: string | null = null
  constructor(private readonly opts: { runner?: typeof run; candidates?: string[]; timeoutMs?: number } = {}) {}

  private env(): NodeJS.ProcessEnv {
    // No prompts, colour or pager; debug output (which can echo request headers) is switched off.
    return { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_PAGER: 'cat', GH_DEBUG: '', DEBUG: '' }
  }

  private async exec(args: string[], timeoutMs: number) {
    const runner = this.opts.runner ?? run
    const list = this.exe ? [this.exe] : this.opts.candidates ?? ghCandidates()
    for (const file of list) {
      if (file.includes('\\') || file.includes('/')) { if (!this.opts.runner && !existsSync(file)) continue }
      const spec: ExecSpec = { file, args, env: this.env() }
      const r = await runner(spec, { timeoutMs })
      if (r.spawnError) continue
      this.exe = file
      return r
    }
    throw new GhError('no-gh', 'The GitHub CLI (gh) was not found. Install it from https://cli.github.com and run "gh auth login".')
  }

  async request(method: GhMethod, path: string, opts: GhRequestOptions = {}): Promise<GhResponse> {
    if (!PATH.test(path) || SUSPICIOUS.test(path)) throw new GhError('request', 'Invalid GitHub API path.')
    if (method === 'DELETE' && !DELETE_PATH.test(path)) throw new GhError('request', 'Refused: GitManager only deletes single Actions artifacts.')
    // Optional, for verification: method and path only, never headers, bodies or credentials.
    const log = process.env.GITMANAGER_GH_REQUEST_LOG
    if (log) { try { appendFileSync(log, `${new Date().toISOString()} ${method} ${path}\n`) } catch { /* logging must never break a request */ } }
    const args = ['api', '-i', '-X', method, path, '-H', 'X-GitHub-Api-Version: 2022-11-28', '-H', `Accept: ${opts.raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json'}`]
    const r = await this.exec(args, this.opts.timeoutMs ?? 60_000)
    if (r.timedOut) throw new GhError('network', 'GitHub did not answer in time.')
    const parsed = parseInclude(r.stdout)
    if (parsed) {
      return parsed
    }
    const text = firstLine(r.stderr) || firstLine(r.stdout)
    if (/gh auth login|not logged in|authentication required|no oauth token/i.test(r.stderr + r.stdout)) throw new GhError('auth', 'GitHub CLI is not signed in. Run "gh auth login".')
    throw new GhError('network', text || 'Could not reach GitHub through the GitHub CLI.')
  }

  async authState(): Promise<AuthState> {
    let res: GhResponse
    try { res = await this.request('GET', '/user') } catch (e) {
      const err = e as GhError
      if (err.kind === 'no-gh') return { state: 'no-gh', message: err.message }
      if (err.kind === 'auth') return { state: 'unauthenticated', message: 'GitHub CLI is not signed in. Run "gh auth login" in a terminal, then scan again.' }
      return { state: 'error', message: err.message }
    }
    if (res.status === 401) return { state: 'unauthenticated', message: 'GitHub CLI is not signed in, or its sign-in expired. Run "gh auth login" (or "gh auth refresh") in a terminal, then scan again.' }
    if (res.status < 200 || res.status >= 300) return { state: 'error', message: errorFor(res).message }
    const body = res.body as { login?: string; plan?: { name?: string } }
    const header = res.headers['x-oauth-scopes']
    const scopesKnown = header !== undefined
    const scopes = scopesKnown ? header.split(',').map(s => s.trim()).filter(Boolean) : null
    const canWrite = scopes ? scopes.includes('repo') || scopes.includes('public_repo') : null
    return { state: 'ok', login: String(body.login ?? ''), scopes, scopesKnown, canWrite, plan: body.plan?.name ?? null }
  }
}
