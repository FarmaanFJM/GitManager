#!/usr/bin/env node
// A stand-in for the GitHub CLI for the Storage acceptance scenario: `gh api -i -X METHOD /path`, answered from a JSON
// world (FAKE_GH_STATE) that DELETE changes, so the real application can be driven end to end without touching GitHub.
// Only the endpoints GitManager's Storage module uses exist. It never reads or prints a credential.
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'

const file = process.env.FAKE_GH_STATE
const args = process.argv.slice(2)
if (args[0] !== 'api' || !file) { console.error('fake gh: unsupported'); process.exit(2) }
const method = args[args.indexOf('-X') + 1] ?? 'GET'
const url = args.find((a, i) => a.startsWith('/') && args[i - 1] !== '-H')
const raw = args.some(a => /raw\+json/.test(a))
const world = JSON.parse(readFileSync(file, 'utf8'))
if (process.env.FAKE_GH_LOG) appendFileSync(process.env.FAKE_GH_LOG, `${method} ${url}\n`)

const out = (status, body, headers = {}) => {
  const text = status === 204 ? 'No Content' : status === 200 ? 'OK' : status === 404 ? 'Not Found' : 'Error'
  const isText = typeof body === 'string'
  process.stdout.write(`HTTP/2.0 ${status} ${text}\r\n${Object.entries({ 'content-type': isText ? 'text/plain' : 'application/json; charset=utf-8', ...headers }).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n${body === null ? '' : isText ? body : JSON.stringify(body)}`)
  process.exit(status >= 400 ? 1 : 0)
}
const err = (status, message, headers) => out(status, { message }, headers)

const [path, qs = ''] = url.split('?')
const q = new URLSearchParams(qs)
const page = Number(q.get('page') ?? 1), per = Number(q.get('per_page') ?? 30)
const slice = l => l.slice((page - 1) * per, page * per)

for (const f of world.fail ?? []) if ((f.method ?? method) === method && new RegExp(f.match).test(path)) err(f.status, f.message)
if (world.auth === 'none') err(401, 'Bad credentials')

if (path === '/user') out(200, { login: world.login, plan: { name: 'pro' } }, { 'x-oauth-scopes': world.scopes ?? 'repo, read:org' })
if (path === '/user/repos') out(200, slice(world.repos.map(repoJson)))
if (path === '/user/packages') out(200, q.get('package_type') === 'container' ? world.packages ?? [] : [])
if (path.startsWith(`/users/${world.login}/settings/billing/usage`)) world.billing ? out(200, world.billing) : err(403, 'Resource not accessible')

const m = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(path)
if (!m) err(404, 'Not Found')
const repo = world.repos.find(r => r.full.toLowerCase() === decodeURIComponent(m[1]).toLowerCase())
if (!repo) err(404, 'Not Found')
const rest = m[2] ?? ''

function repoJson(r) {
  return { full_name: r.full, private: !!r.private, archived: !!r.archived, default_branch: 'main', pushed_at: new Date().toISOString(), owner: { login: r.full.split('/')[0], type: 'User' }, permissions: { push: r.push !== false, admin: r.push !== false } }
}
function artifactJson(a) {
  const run = repo.runs.find(x => x.id === a.run)
  return { id: a.id, name: a.name, size_in_bytes: a.size, expired: !!a.expired, created_at: a.created, expires_at: a.created, workflow_run: a.run == null ? null : { id: a.run, head_branch: run?.branch ?? 'main', head_sha: run?.sha ?? 'abc' } }
}
function runJson(x) {
  return { id: x.id, name: x.name ?? 'CI', path: x.path ?? '.github/workflows/ci.yml', status: x.status ?? 'completed', conclusion: x.conclusion === undefined ? 'success' : x.conclusion, event: x.event ?? 'push', run_number: x.number ?? x.id % 1000, head_branch: x.branch ?? 'main', head_sha: x.sha ?? `sha${x.id}`, html_url: `https://github.com/${repo.full}/actions/runs/${x.id}`, pull_requests: (x.prs ?? []).map(number => ({ number })) }
}

if (rest === '' && method === 'GET') out(200, repoJson(repo))
if (rest === '/actions/artifacts') out(200, { total_count: repo.artifacts.length, artifacts: slice(repo.artifacts).map(artifactJson) })
let am = /^\/actions\/artifacts\/(\d+)$/.exec(rest)
if (am) {
  const a = repo.artifacts.find(x => x.id === Number(am[1]))
  if (!a) err(404, 'Not Found')
  if (method === 'GET') out(200, artifactJson(a))
  if (method === 'DELETE') {
    if (repo.push === false) err(403, 'Resource not accessible by personal access token')
    repo.artifacts = repo.artifacts.filter(x => x.id !== a.id)
    writeFileSync(file, JSON.stringify(world))
    out(204, null)
  }
}
if (rest === '/actions/runs') out(200, { total_count: repo.runs.length, workflow_runs: slice(repo.runs).map(runJson) })
am = /^\/actions\/runs\/(\d+)$/.exec(rest)
if (am) { const r = repo.runs.find(x => x.id === Number(am[1])); r ? out(200, runJson(r)) : err(404, 'Not Found') }
if (rest === '/pulls') out(200, slice(repo.pulls ?? []).map(p => ({ number: p.number, head: { ref: p.ref, sha: p.sha } })))
if (rest === '/releases') out(200, (repo.releases ?? []).map(r => ({ tag_name: r.tag, draft: !!r.draft, prerelease: !!r.prerelease, published_at: '2026-10-01T00:00:00Z' })))
am = /^\/commits\/(.+)$/.exec(rest)
if (am) { const r = (repo.releases ?? []).find(x => x.tag === decodeURIComponent(am[1])); r ? out(200, { sha: r.sha ?? `tag-${r.tag}` }) : err(404, 'Not Found') }
if (rest.startsWith('/git/trees/')) out(200, { sha: 'tree1', tree: Object.keys(repo.docs ?? {}).map(p => ({ type: 'blob', path: p, size: repo.docs[p].length })) })
am = /^\/contents\/(.+)$/.exec(rest)
if (am) { const t = (repo.docs ?? {})[decodeURIComponent(am[1])]; t === undefined ? err(404, 'Not Found') : out(200, t) }
if (rest === '/actions/cache/usage') out(200, { active_caches_size_in_bytes: (repo.caches ?? []).reduce((n, c) => n + c.size, 0), active_caches_count: (repo.caches ?? []).length })
if (rest === '/actions/caches') out(200, { actions_caches: (repo.caches ?? []).map(c => ({ key: c.key, size_in_bytes: c.size, ref: 'refs/heads/main', last_accessed_at: new Date().toISOString(), created_at: new Date().toISOString() })) })
err(404, 'Not Found')
void raw
