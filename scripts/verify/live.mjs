#!/usr/bin/env node
// Live verification helper for the Storage module. Runs on YOUR machine against YOUR real `gh` session and the real GitHub
// API, independently of the application: it re-reads GitHub with `gh api` and compares the result with what GitManager stored.
//
//   node scripts/verify/live.mjs env
//   node scripts/verify/live.mjs reconcile [--state <storage-state.json>] [--repos a/b,c/d] [--sample 12]
//   node scripts/verify/live.mjs snapshot --repos a/b,c/d --out before.json        (artifact ids per repository, read-only)
//   node scripts/verify/live.mjs diff before.json after.json
//   node scripts/verify/live.mjs requests <request.log> --expect none | --expect canary --repo o/r --id 123
//   node scripts/verify/live.mjs audit [--log <storage-audit.jsonl>]
//   node scripts/verify/live.mjs explain --repo o/r [--grace-days 0] [--plus-days 0] [--save dir | --from dir]   (why artifacts are or are not candidates; what-if)
//   node scripts/verify/live.mjs canary-create --repo o/r             (creates a disposable branch, workflow and artifacts)
//   node scripts/verify/live.mjs canary-cleanup --repo o/r --branch storage-canary-123 --yes
//
// Needs `npm run build` first (it reuses the compiled classifier only to derive artifact families and the audit chain check).
// Read-only except canary-create / canary-cleanup, which are explicit. It never runs `gh auth token`, never prints a credential.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [cmd, ...rest] = process.argv.slice(2)
const flag = (n, d) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : d }
const has = n => rest.includes(`--${n}`)
const positional = () => rest.filter((x, i) => !x.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--') && !['yes'].includes(rest[i - 1].slice(2))))
const ENV = { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_DEBUG: '' }
const run = (file, args, opts = {}) => execFileSync(file, args, { encoding: 'utf8', env: ENV, maxBuffer: 1 << 28, windowsHide: true, ...opts })
const gh = args => run('gh', args)
const api = path => JSON.parse(gh(['api', '-H', 'X-GitHub-Api-Version: 2022-11-28', path]))
const pages = (path, pick, max = 200) => {
  const out = []
  for (let p = 1; p <= max; p++) {
    const b = api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${p}`)
    const items = pick(b)
    out.push(...items)
    if (items.length < 100) return { items: out, pagesRead: p }
  }
  return { items: out, pagesRead: max }
}
const dist = async f => import(pathToFileURL(resolve('dist', 'main', f)).href).catch(() => { console.error(`Run "npm run build" first (missing dist/main/${f}).`); process.exit(2) })
let fails = 0
const ok = (cond, msg, detail = '') => { if (!cond) fails++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${detail ? `: ${detail}` : ''}`) }
const userData = () => process.platform === 'win32' ? join(process.env.APPDATA ?? '', 'GitManager') : process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support', 'GitManager') : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'GitManager')
const MB = n => `${(n / 1048576).toFixed(2)} MiB`

async function envCmd() {
  console.log(run('gh', ['--version']).split('\n')[0])
  // `gh auth status` masks the token, but its token line is dropped here anyway.
  let st = ''
  try { st = run('gh', ['auth', 'status']) } catch (e) { st = `${e.stdout ?? ''}${e.stderr ?? ''}` }
  console.log(st.split('\n').filter(l => !/token/i.test(l)).join('\n').trim())
  const raw = gh(['api', '-i', '/user'])
  const head = raw.split(/\r?\n\r?\n/)[0]
  const scopes = /^x-oauth-scopes:\s*(.*)$/im.exec(head)?.[1]
  const body = JSON.parse(raw.slice(raw.indexOf('{')))
  console.log(`user: ${body.login}`)
  console.log(`oauth scopes: ${scopes === undefined ? '(not reported: fine-grained or app token)' : scopes || '(none)'}`)
  ok(true, 'gh is installed and signed in')
  if (scopes !== undefined) ok(/(^|,\s*)repo(,|$)/.test(scopes), 'token has the "repo" scope needed to delete artifacts (without it GitManager stays read-only)')
}

function load(p) { return JSON.parse(readFileSync(p, 'utf8')) }

async function reconcile() {
  const { parseName } = await dist('core/storage/classify.js')
  const { DEFAULT_EVIDENCE } = await dist('core/storage/config.js')
  const { formatBytes } = await dist('shared/storageTotals.js')
  const statePath = flag('state', join(userData(), 'storage-state.json'))
  const snap = load(statePath).snapshot
  if (!snap) { console.error('No scan stored yet. Run one Scan in GitManager first.'); process.exit(2) }
  const only = flag('repos')?.split(',').map(s => s.toLowerCase())
  const sample = Number(flag('sample', '12'))
  const cfgFile = join(userData(), 'gitmanager.json')
  const cfg = existsSync(cfgFile) ? load(cfgFile).storage ?? {} : {}
  console.log(`state file: ${statePath}\nscan: ${snap.scannedAt} for ${snap.login}, ${snap.repos.length} repositories\n`)

  // repositories: independent list and the default eligibility rule (writable, not archived)
  const all = pages('/user/repos?affiliation=owner,collaborator,organization_member', b => b).items
  const scope = cfg.settings?.scope ?? 'writable'
  const eligible = all.filter(r => (cfg.settings?.includeArchived || !r.archived) && (scope === 'owned' ? r.owner.login.toLowerCase() === snap.login.toLowerCase() : r.permissions?.push || r.permissions?.admin || r.permissions?.maintain))
  const names = new Set(eligible.map(r => r.full_name.toLowerCase()))
  const seen = new Set(snap.repos.map(r => r.repo.toLowerCase()))
  console.log(`GitHub reports ${all.length} accessible repositories; ${eligible.length} eligible by the documented rule (scope "${scope}")`)
  ok(names.size === seen.size && [...names].every(n => seen.has(n)), 'repository set equals the eligible set', `missing in app: ${[...names].filter(n => !seen.has(n)).join(', ') || 'none'}; extra in app: ${[...seen].filter(n => !names.has(n)).join(', ') || 'none'}`)
  ok(snap.skippedRepos === all.length - eligible.length || snap.skippedRepos === undefined, 'skipped-repository count matches', `app ${snap.skippedRepos}, independent ${all.length - eligible.length}`)

  const repos = snap.repos.filter(r => !r.error && (!only || only.includes(r.repo.toLowerCase())))
  let compared = 0, totalIndep = 0, totalApp = 0
  const runCache = new Map()
  const indepRuns = {}
  const releasesBy = {}, pullsBy = {}, docsBy = {}
  const findings = { delete: [], samples: {} }
  for (const r of repos) {
    console.log(`\n=== ${r.repo}`)
    const { items: arts, pagesRead } = pages(`/repos/${r.repo}/actions/artifacts`, b => b.artifacts)
    console.log(`artifact pages read: ${pagesRead}${pagesRead > 1 ? ' (pagination exercised)' : ''}; independent artifacts: ${arts.length}; app: ${r.artifacts.length}`)
    const mine = new Map(r.artifacts.map(a => [a.id, a]))
    const indep = new Map(arts.map(a => [a.id, a]))
    ok(mine.size === indep.size && [...indep.keys()].every(id => mine.has(id)), 'artifact id sets are identical', `only on GitHub: ${[...indep.keys()].filter(i => !mine.has(i)).join(',') || 'none'}; only in app: ${[...mine.keys()].filter(i => !indep.has(i)).join(',') || 'none'}`)
    let bad = 0
    for (const [id, g] of indep) {
      const a = mine.get(id); if (!a) continue
      const diffs = []
      const chk = (k, x, y) => { if (x !== y) diffs.push(`${k}: app=${x} github=${y}`) }
      chk('name', a.name, g.name); chk('size', a.sizeBytes, g.size_in_bytes); chk('created', a.createdAt, g.created_at); chk('expires', a.expiresAt, g.expires_at)
      chk('expired', a.expired, g.expired); chk('runId', a.runId, g.workflow_run?.id ?? null); chk('headBranch', a.headBranch, g.workflow_run?.head_branch ?? null); chk('headSha', a.headSha, g.workflow_run?.head_sha ?? null)
      if (diffs.length) { bad++; console.log(`  artifact ${id}: ${diffs.join('; ')}`) }
    }
    ok(bad === 0, `all ${indep.size} artifacts match field by field (id, name, size, created, expires, expired, run, branch, sha)`)
    compared += indep.size
    const iBytes = arts.filter(a => !a.expired).reduce((n, a) => n + a.size_in_bytes, 0)
    const aBytes = r.artifacts.filter(a => !a.expired).reduce((n, a) => n + a.sizeBytes, 0)
    totalIndep += iBytes; totalApp += aBytes
    ok(iBytes === aBytes, `retained bytes (non-expired) equal`, `${iBytes} B independent (${formatBytes(iBytes)}), ${aBytes} B app`)

    // caches (separate from artifacts)
    try {
      const u = api(`/repos/${r.repo}/actions/cache/usage`)
      ok(u.active_caches_size_in_bytes === (r.cacheBytes ?? -1) && u.active_caches_count === (r.cacheCount ?? -1), 'cache usage equals the app and is kept apart from artifacts', `${u.active_caches_size_in_bytes} B in ${u.active_caches_count} entries`)
    } catch (e) { console.log(`  cache usage not readable independently: ${String(e.message).split('\n')[0]}`) }

    // runs: independent list, and the fallback for runs outside it
    const runs = pages(`/repos/${r.repo}/actions/runs`, b => b.workflow_runs, 5).items
    indepRuns[r.repo] = new Map(runs.map(x => [x.id, x]))
    const outside = [...new Set(arts.filter(a => !a.expired && a.workflow_run).map(a => a.workflow_run.id))].filter(id => !indepRuns[r.repo].has(id))
    console.log(`distinct runs of live artifacts: ${new Set(arts.filter(a => !a.expired && a.workflow_run).map(a => a.workflow_run.id)).size}; outside the first 5 run pages (fallback GET /runs/{id}): ${outside.length}`)
    const toCheck = [...new Set([...outside.slice(0, 6), ...arts.filter(a => !a.expired && a.workflow_run).map(a => a.workflow_run.id).slice(0, sample)])]
    let runBad = 0
    for (const id of toCheck) {
      const run = runCache.get(id) ?? indepRuns[r.repo].get(id) ?? api(`/repos/${r.repo}/actions/runs/${id}`)
      runCache.set(id, run)
      const a = r.artifacts.find(x => x.runId === id)
      const mr = a?.run
      if (!mr) { runBad++; console.log(`  run ${id}: not stored by the app`); continue }
      const d = []
      const c = (k, x, y) => { if (x !== y) d.push(`${k}: app=${x} github=${y}`) }
      c('workflow', mr.name, run.name); c('status', mr.status, run.status); c('conclusion', mr.conclusion, run.conclusion); c('event', mr.event, run.event)
      c('branch', mr.headBranch, run.head_branch); c('sha', mr.headSha, run.head_sha); c('url', mr.htmlUrl, run.html_url); c('path', mr.path, run.path)
      if (d.length) { runBad++; console.log(`  run ${id}: ${d.join('; ')}`) }
    }
    ok(runBad === 0, `${toCheck.length} workflow runs match (${outside.length ? `${Math.min(6, outside.length)} via the fallback lookup` : 'no run needed the fallback in this repository'})`)

    // independent context for the classification audit
    const live = arts.filter(a => !a.expired)
    if (!live.length) continue
    const rel = (() => { try { return api(`/repos/${r.repo}/releases?per_page=30`) } catch { return null } })()
    const pulls = (() => { try { return pages(`/repos/${r.repo}/pulls?state=open`, b => b, 10).items } catch { return null } })()
    releasesBy[r.repo] = rel; pullsBy[r.repo] = pulls
    let docs = ''
    try {
      const tree = api(`/repos/${r.repo}/git/trees/HEAD?recursive=1`)
      const files = tree.tree.filter(e => e.type === 'blob' && /^(?:[^/]+|docs\/.+)\.md$/i.test(e.path) && e.size <= 262144).slice(0, 15)
      for (const f of files) docs += '\n' + gh(['api', '-H', 'Accept: application/vnd.github.raw+json', `/repos/${r.repo}/contents/${f.path.split('/').map(encodeURIComponent).join('/')}`]).toLowerCase()
    } catch { docs = null }
    docsBy[r.repo] = docs
  }

  console.log(`\nTOTAL retained bytes across ${repos.length} compared repositories: independent ${totalIndep} B (${formatBytes(totalIndep)}), app ${totalApp} B (${formatBytes(totalApp)}), ${compared} artifacts compared`)
  ok(totalIndep === totalApp, 'overall retained-bytes total reconciles exactly')

  // Classification audit against independent evidence
  console.log('\n=== classification audit (independent evidence)')
  const patterns = (cfg.defaultPolicy?.evidencePatterns ?? DEFAULT_EVIDENCE)
  const N = cfg.defaultPolicy?.keepLatest ?? 2
  for (const r of repos) {
    const pol = cfg.policies?.[r.repo.toLowerCase()] ?? cfg.defaultPolicy ?? {}
    const pats = pol.evidencePatterns ?? patterns
    const keepN = pol.keepLatest ?? N
    const rel = releasesBy[r.repo], pulls = pullsBy[r.repo], docs = docsBy[r.repo]
    const active = rel ? [...rel.filter(x => x.draft), ...[rel.find(x => !x.draft && !x.prerelease)].filter(Boolean), ...[rel.find(x => !x.draft && x.prerelease)].filter(Boolean)] : []
    const tagSha = {}
    for (const x of active) { try { tagSha[x.tag_name] = api(`/repos/${r.repo}/commits/${encodeURIComponent(x.tag_name)}`).sha } catch { /* unresolved */ } }
    const runOf = a => indepRuns[r.repo]?.get(a.runId) ?? runCache.get(a.runId) ?? (a.runId ? (() => { try { const x = api(`/repos/${r.repo}/actions/runs/${a.runId}`); runCache.set(a.runId, x); return x } catch { return null } })() : null)
    const fam = new Map()
    for (const a of r.artifacts.filter(x => !x.expired)) {
      const p = parseName(a.name); const k = `${p.category}|${p.platform}|${p.family}`
      const run = runOf(a)
      if (!fam.has(k)) fam.set(k, [])
      fam.get(k).push({ a, run, ok: run?.conclusion === 'success', t: Date.parse(a.createdAt) })
    }
    const rankOf = new Map()
    for (const list of fam.values()) list.filter(x => x.ok).sort((x, y) => y.t - x.t || y.a.id - x.a.id).forEach((x, i) => rankOf.set(x.a.id, i))
    const installerNewest = new Map()
    for (const list of fam.values()) for (const x of list) { const p = parseName(x.a.name); if (p.category !== 'installer') continue; const cur = installerNewest.get(p.platform); if (!cur || (x.ok && (!cur.ok || x.t > cur.t))) installerNewest.set(p.platform, x) }
    for (const a of r.artifacts) {
      if (a.expired) { (findings.samples['expired'] ??= []).push([r.repo, a, 'GitHub reports expired=true']); continue }
      const run = runOf(a)
      const lowerName = a.name.toLowerCase()
      const evid = pats.find(p => lowerName.includes(p) || (run?.name ?? '').toLowerCase().includes(p) || (run?.path ?? '').toLowerCase().includes(p))
      const relMatch = active.find(x => run && (run.head_branch === x.tag_name || (tagSha[x.tag_name] && run.head_sha === tagSha[x.tag_name])))
      const prMatch = (pulls ?? []).find(p => run && ((run.pull_requests ?? []).some(q => q.number === p.number) || run.head_branch === p.head.ref || run.head_sha === p.head.sha))
      const rank = rankOf.get(a.id)
      let violation = null, evidence = ''
      if (a.class === 'delete-candidate') {
        if (evid) violation = `matches evidence word "${evid}"`
        else if (!run) violation = 'its run cannot be read independently'
        else if (run.status !== 'completed') violation = `run is ${run.status}`
        else if (relMatch) violation = `built for release ${relMatch.tag_name}`
        else if (prMatch) violation = `belongs to open PR #${prMatch.number}`
        else if (docs && (docs.includes(`/actions/runs/${a.runId}`))) violation = 'run URL cited in documentation'
        else if (rank !== undefined && rank < keepN) violation = `is among the newest ${keepN} successful of its family (rank ${rank})`
        else if (run.conclusion === 'success' && rank === undefined) violation = 'successful but unranked'
        else if (installerNewest.get(parseName(a.name).platform)?.a.id === a.id && parseName(a.name).category === 'installer') violation = 'is the last usable installer of its platform'
        else if (rel === null || pulls === null || docs === null) violation = 'a context lookup failed independently (the app should have said Review)'
        else evidence = `run ${a.runId} ${run.conclusion}, ${rank === undefined ? 'not successful' : `rank ${rank} >= ${keepN}`}; no evidence word, release, open PR, running run or doc reference`
      } else if (a.class === 'protected' && a.reasonCode === 'evidence') {
        if (!evid) violation = 'app says evidence but no evidence word matches'; else evidence = `matches "${evid}"`
      } else if (a.class === 'protected' && a.reasonCode === 'release') {
        if (!relMatch) violation = 'no active release matches'; else evidence = `run branch ${run?.head_branch} / sha ${run?.head_sha?.slice(0, 7)} vs release ${relMatch.tag_name} (${tagSha[relMatch.tag_name]?.slice(0, 7) ?? 'tag commit unresolved'})`
      } else if (a.class === 'protected' && a.reasonCode === 'doc-cited') {
        evidence = 'documentation cites the run URL or a unique artifact name'
      } else if (a.class === 'keep' && a.reasonCode === 'open-pr') {
        if (!prMatch) violation = 'no open PR matches'; else evidence = `open PR #${prMatch.number} (${prMatch.head.ref})`
      } else if (a.class === 'keep' && a.reasonCode === 'run-active') {
        if (run?.status === 'completed') violation = 'the run is completed'; else evidence = `run status ${run?.status}`
      } else if (a.class === 'keep' && a.reasonCode === 'newest-successful') {
        if (rank === undefined || rank >= keepN) violation = `independent rank is ${rank}`; else evidence = `rank ${rank} of ${[...fam.values()].find(l => l.some(x => x.a.id === a.id)).filter(x => x.ok).length} successful`
      } else if (a.class === 'review') evidence = `reason: ${a.reasonCode}`
      else evidence = `reason: ${a.reasonCode}`
      if (violation) { findings.delete.push(`${r.repo} #${a.id} ${a.name} [${a.class}/${a.reasonCode}]: ${violation}`) }
      const key = `${a.class}/${a.reasonCode}`
      ;(findings.samples[key] ??= []).push([r.repo, a, evidence])
    }
  }
  for (const [k, list] of Object.entries(findings.samples).sort()) {
    console.log(`\n[${k}] ${list.length} artifact(s); samples:`)
    for (const [repo, a, ev] of list.slice(0, 3)) console.log(`  ${repo}  #${a.id}  ${a.name}  ${MB(a.sizeBytes)}  ${a.createdAt?.slice(0, 10)}\n      rule: ${a.reason}\n      GitHub evidence: ${ev}`)
  }
  console.log()
  ok(findings.delete.length === 0, 'no artifact violates a safety rule according to independent evidence', findings.delete.length ? '\n  ' + findings.delete.join('\n  ') : '')
  const cand = repos.flatMap(r => r.artifacts).filter(a => a.class === 'delete-candidate')
  console.log(`delete candidates: ${cand.length} artifacts, ${cand.reduce((n, a) => n + a.sizeBytes, 0)} B (${formatBytes(cand.reduce((n, a) => n + a.sizeBytes, 0))}); compare with the Review cleanup preview total`)

  // packages
  try {
    let n = 0
    for (const t of ['container', 'npm', 'maven', 'nuget', 'rubygems']) n += pages(`/user/packages?package_type=${t}`, b => b, 5).items.length
    ok(!snap.packages.available || snap.packages.packages.length === n, 'package count equals GitHub (sizes are not exposed by the API, none are shown)', `${n} packages`)
  } catch (e) { console.log(`packages not readable independently: ${String(e.message).split('\n')[0]} (app shows: ${snap.packages.available ? 'available' : snap.packages.message})`) }
  console.log(`billing in app: ${snap.billing.available ? `available for ${snap.billing.period}, ${snap.billing.items.length} items` : `UNAVAILABLE (${snap.billing.message})`}`)
  process.exit(fails ? 1 : 0)
}

function snapshotCmd() {
  const repos = (flag('repos') ?? '').split(',').filter(Boolean)
  if (!repos.length) { console.error('--repos required'); process.exit(2) }
  const out = {}
  for (const r of repos) out[r] = pages(`/repos/${r}/actions/artifacts`, b => b.artifacts).items.map(a => ({ id: a.id, name: a.name, size: a.size_in_bytes, expired: a.expired, run: a.workflow_run?.id ?? null }))
  writeFileSync(flag('out', 'artifact-snapshot.json'), JSON.stringify({ at: new Date().toISOString(), repos: out }, null, 2))
  console.log(`saved ${Object.values(out).reduce((n, l) => n + l.length, 0)} artifacts from ${repos.length} repositories`)
}

function diffCmd() {
  const [a, b] = positional().map(load)
  let gone = [], added = []
  for (const r of new Set([...Object.keys(a.repos), ...Object.keys(b.repos)])) {
    const x = new Map((a.repos[r] ?? []).map(i => [i.id, i])), y = new Map((b.repos[r] ?? []).map(i => [i.id, i]))
    for (const [id, i] of x) if (!y.has(id)) gone.push(`${r} #${id} ${i.name} ${i.size} B`)
    for (const [id, i] of y) if (!x.has(id)) added.push(`${r} #${id} ${i.name}`)
  }
  console.log(`disappeared (${gone.length}):\n  ${gone.join('\n  ') || 'none'}\nnew (${added.length}):\n  ${added.join('\n  ') || 'none'}`)
  const expect = flag('expect-id')
  if (expect) ok(gone.length === 1 && gone[0].includes(`#${expect} `), `exactly artifact ${expect} disappeared`)
  process.exit(fails ? 1 : 0)
}

function requestsCmd() {
  const file = positional()[0]
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { const [at, method, path] = l.split(' '); return { at, method, path } })
  const by = {}
  for (const l of lines) by[l.method] = (by[l.method] ?? 0) + 1
  console.log(`requests: ${JSON.stringify(by)} (${lines.length} total)`)
  const muts = lines.filter(l => l.method !== 'GET')
  if (flag('expect') === 'none') ok(muts.length === 0, 'zero mutating requests (no DELETE, POST, PUT, PATCH)', muts.map(m => `${m.method} ${m.path}`).join(', '))
  if (flag('expect') === 'canary') {
    const repo = flag('repo'), id = flag('id')
    const want = `/repos/${repo}/actions/artifacts/${id}`
    const del = muts.filter(m => m.method === 'DELETE')
    ok(muts.length === 1 && del.length === 1 && del[0].path === want, `exactly one mutating request: DELETE ${want}`, muts.map(m => `${m.method} ${m.path}`).join(', '))
    const i = lines.findIndex(l => l.method === 'DELETE')
    ok(i > 0 && lines.slice(0, i).some(l => l.method === 'GET' && l.path === want), 'the artifact was re-read (GET) before the DELETE')
    ok(lines.slice(i + 1).some(l => l.path.startsWith(`/repos/${repo}/actions/artifacts?`)), 'the repository artifact list was read again after the DELETE')
    ok(!lines.some(l => /\/releases|\/actions\/caches|\/packages|\/branches|\/git\/refs/.test(l.path) && l.method !== 'GET'), 'no release, cache, package or branch endpoint was mutated')
  }
  process.exit(fails ? 1 : 0)
}

async function auditCmd() {
  const { AuditLog } = await dist('core/storage/audit.js')
  const log = flag('log', join(userData(), 'storage-audit.jsonl'))
  const a = new AuditLog(log)
  const r = a.read()
  ok(r.intact, `hash chain valid over ${r.entries.length} entries`, r.brokenAt ? `broken at ${r.brokenAt}` : '')
  const byKey = new Map()
  r.entries.forEach((e, i) => { const k = `${e.opId}:${e.repo}:${e.artifactId}`; (byKey.get(k) ?? byKey.set(k, []).get(k)).push({ ...e, i }) })
  let order = true, final = 0
  for (const list of byKey.values()) { const att = list.find(e => e.type === 'attempt'); const res = list.filter(e => e.type === 'result'); if (att && res.length && res[0].i < att.i) order = false; if (res.some(e => e.outcome === 'deleted')) final++ }
  ok(order, 'every attempt precedes its result')
  console.log(`artifacts with a confirmed "deleted" result: ${final}; unresolved attempts: ${a.unresolved().length}`)
  ok(r.entries.every(e => e.repo && e.artifactId && e.name !== undefined && e.sizeBytes !== undefined && 'runId' in e), 'entries carry repository, id, name, run and size')
  ok(!/(ghp_|gho_|ghu_|ghs_|github_pat_|authorization|bearer|token)/i.test(readFileSync(log, 'utf8')), 'no credential-like text in the log')
  // tamper test on a copy
  const dir = mkdtempSync(join(tmpdir(), 'gm-audit-copy-')); const copy = join(dir, 'copy.jsonl'); copyFileSync(log, copy)
  const lines = readFileSync(copy, 'utf8').split('\n').filter(Boolean)
  if (lines.length > 2) {
    lines[0] = lines[0].replace(/"name":"[^"]*"/, '"name":"TAMPERED"'); writeFileSync(copy, lines.join('\n') + '\n')
    const t = new AuditLog(copy).read()
    ok(!t.intact, 'editing an old entry in a COPY is detected', `reported at ${t.brokenAt}`)
  } else console.log('(too few entries for the tamper test; run it after the canary deletion)')
  process.exit(fails ? 1 : 0)
}

async function explain() {
  const { classifyRepo } = await dist('core/storage/classify.js')
  const { DEFAULT_POLICY } = await dist('core/storage/config.js')
  const { formatBytes } = await dist('shared/storageTotals.js')
  const repo = flag('repo', 'FarmaanFJM/GitManager')
  const from = flag('from'), save = flag('save')
  let d
  if (from) d = JSON.parse(readFileSync(join(from, 'inventory.json'), 'utf8'))
  else {
    const info = api(`/repos/${repo}`)
    const artifacts = pages(`/repos/${repo}/actions/artifacts`, b => b.artifacts).items
    const runs = new Map(pages(`/repos/${repo}/actions/runs`, b => b.workflow_runs, 5).items.map(r => [r.id, r]))
    for (const id of new Set(artifacts.filter(a => !a.expired && a.workflow_run).map(a => a.workflow_run.id))) if (!runs.has(id)) { try { runs.set(id, api(`/repos/${repo}/actions/runs/${id}`)) } catch { /* unknown run */ } }
    const pulls = pages(`/repos/${repo}/pulls?state=open`, b => b, 10).items
    const releases = api(`/repos/${repo}/releases?per_page=30`)
    const tags = pages(`/repos/${repo}/tags`, b => b, 3).items.map(t => t.name)
    let docs = ''
    try {
      const tree = api(`/repos/${repo}/git/trees/HEAD?recursive=1`)
      for (const f of tree.tree.filter(e => e.type === 'blob' && /^(?:[^/]+|docs\/.+)\.md$/i.test(e.path) && e.size <= 262144).slice(0, 15)) docs += '\n' + gh(['api', '-H', 'Accept: application/vnd.github.raw+json', `/repos/${repo}/contents/${f.path.split('/').map(encodeURIComponent).join('/')}`]).toLowerCase()
    } catch { docs = null }
    d = { repo, defaultBranch: info.default_branch, artifacts, runs: [...runs.values()], pulls, releases, tags, docs, fetchedAt: new Date().toISOString() }
    if (save) { mkdirSync(save, { recursive: true }); writeFileSync(join(save, 'inventory.json'), JSON.stringify(d)); console.log(`saved the raw inventory to ${join(save, 'inventory.json')}`) }
  }
  const runMap = new Map(d.runs.map(r => [r.id, { id: r.id, name: r.name, path: r.path, status: r.status, conclusion: r.conclusion, event: r.event, runNumber: r.run_number, headBranch: r.head_branch, headSha: r.head_sha, htmlUrl: r.html_url, pullNumbers: (r.pull_requests ?? []).map(p => p.number) }]))
  const raws = d.artifacts.map(a => ({ id: a.id, repo: d.repo, name: a.name, sizeBytes: a.size_in_bytes, createdAt: a.created_at, expiresAt: a.expires_at, expired: a.expired, runId: a.workflow_run?.id ?? null, headBranch: a.workflow_run?.head_branch ?? null, headSha: a.workflow_run?.head_sha ?? null }))
  const active = [...d.releases.filter(r => r.draft), ...d.releases.filter(r => !r.draft && !r.prerelease).slice(0, 1), ...d.releases.filter(r => !r.draft && r.prerelease).slice(0, 1)].map(r => ({ tag: r.tag_name, sha: null, draft: r.draft, prerelease: r.prerelease }))
  const base = Date.now() + Number(flag('plus-days', '0')) * 86400000
  const classify = (graceDays, now) => classifyRepo(raws, { now, policy: { ...DEFAULT_POLICY, graceDays, reportGraceDays: graceDays }, protectedRepo: false, pinned: new Set(), runs: runMap, pulls: d.pulls.map(p => ({ number: p.number, headRef: p.head.ref, headSha: p.head.sha })), releases: active, releaseTags: new Set([...d.releases.map(r => r.tag_name), ...d.tags]), defaultBranch: d.defaultBranch, docs: d.docs, context: { runs: true, pulls: true, releases: true, docs: d.docs !== null } })
  const out = classify(Number(flag('grace-days', '0')), base)
  const live = out.filter(a => !a.expired)
  console.log(`${d.repo}: ${live.length} live artifacts, ${formatBytes(live.reduce((n, a) => n + a.sizeBytes, 0))}; default branch ${d.defaultBranch}; ${d.releases.length} releases, ${d.tags.length} tags, ${d.pulls.length} open PRs; docs ${d.docs === null ? 'NOT READ' : 'read'}\n`)
  const fam = {}
  for (const a of live) { const k = a.name; (fam[k] ??= []).push(a) }
  for (const [name, list] of Object.entries(fam).sort((x, y) => y[1].reduce((n, a) => n + a.sizeBytes, 0) - x[1].reduce((n, a) => n + a.sizeBytes, 0))) {
    const ages = list.map(a => (base - Date.parse(a.createdAt)) / 86400000)
    console.log(`${name}: ${list.length} copies, ${formatBytes(list.reduce((n, a) => n + a.sizeBytes, 0))}, age ${Math.min(...ages).toFixed(1)} to ${Math.max(...ages).toFixed(1)} days`)
    const by = {}
    for (const a of list) { const k = `${a.class}/${a.reasonCode}`; by[k] ??= [0, 0]; by[k][0]++; by[k][1] += a.sizeBytes }
    for (const [k, v] of Object.entries(by).sort()) console.log(`    ${k}: ${v[0]} (${formatBytes(v[1])})`)
  }
  const sum = (o) => o.filter(a => a.class === 'delete-candidate').reduce((n, a) => n + a.sizeBytes, 0)
  console.log(`\nreclaimable now with a ${flag('grace-days', '0')} d grace period: ${formatBytes(sum(out))}`)
  for (const days of [0, 1, 3, 7]) console.log(`  what-if grace period ${days} d: ${formatBytes(sum(classify(days, Date.now())))}`)
  console.log('\nWhy nothing more is a candidate is the reason histogram above: grace-period = superseded but inside the optional grace period; failed-run = output of a failed or cancelled run (only you decide, unless the policy allows it); open-pr, newest-successful, newest-default-branch, last-installer = retained by rule; tag-build = built from a release tag.')
}

function canaryCreate() {
  const repo = flag('repo', 'FarmaanFJM/GitManager')
  const stamp = Date.now()
  const branch = `storage-canary-${stamp}`
  const dir = mkdtempSync(join(tmpdir(), 'gm-canary-'))
  const git = (...a) => run('git', a, { cwd: dir })
  // An orphan branch holding only the canary workflow: the repository's own CI workflow does not exist there, so nothing else runs.
  git('init', '-q'); git('checkout', '-q', '--orphan', branch)
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true })
  writeFileSync(join(dir, '.github', 'workflows', 'storage-canary.yml'), `name: Storage canary (temporary, safe to delete)
on: push
permissions: { contents: read }
jobs:
  canary:
    runs-on: ubuntu-latest
    steps:
      - run: echo "disposable data for verifying GitManager Storage deletion" > canary.txt
      - uses: actions/upload-artifact@v4
        with: { name: gitmanager-storage-canary, path: canary.txt, retention-days: 1 }
`)
  writeFileSync(join(dir, 'README.md'), 'Temporary branch for verifying GitManager Storage deletion. Safe to delete.\n')
  git('add', '-A'); git('-c', 'user.name=storage-canary', '-c', 'user.email=canary@example.invalid', 'commit', '-q', '-m', 'canary 1')
  git('remote', 'add', 'origin', `https://github.com/${repo}.git`)
  console.log(`Pushing temporary branch ${branch} (three tiny commits: three runs, three artifacts named gitmanager-storage-canary, 1-day retention).`)
  for (let i = 1; i <= 3; i++) {
    if (i > 1) { writeFileSync(join(dir, 'README.md'), `canary ${i}\n`); git('add', '-A'); git('-c', 'user.name=storage-canary', '-c', 'user.email=canary@example.invalid', 'commit', '-q', '-m', `canary ${i}`) }
    run('git', ['push', '-q', 'origin', branch], { cwd: dir, stdio: 'inherit' })
    // wait for this run to finish so the three artifacts have different creation times
    for (let t = 0; t < 60; t++) {
      const rs = api(`/repos/${repo}/actions/runs?branch=${branch}&per_page=10`).workflow_runs
      if (rs.length >= i && rs.every(r => r.status === 'completed')) break
      execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},5000)'])
    }
  }
  const runs = api(`/repos/${repo}/actions/runs?branch=${branch}&per_page=10`).workflow_runs
  const arts = pages(`/repos/${repo}/actions/artifacts?name=gitmanager-storage-canary`, b => b.artifacts).items
  console.log(`\ncanary branch: ${branch}\nruns: ${runs.map(r => `${r.id} (${r.conclusion})`).join(', ')}`)
  for (const a of arts) console.log(`artifact ${a.id}  ${a.name}  ${a.size_in_bytes} B  run ${a.workflow_run?.id}  sha ${a.workflow_run?.head_sha}  created ${a.created_at}`)
  const oldest = [...arts].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))[0]
  console.log(`\nIn GitManager, scan, open ${repo}, filter Review: the OLDEST artifact (${oldest?.id}) is classified Review (purpose not recognised, superseded in its family) and is never selected for you.\nTick only that one in Review cleanup and delete it. Do not weaken any policy.`)
  console.log(`Afterwards: node scripts/verify/live.mjs canary-cleanup --repo ${repo} --branch ${branch} --yes`)
}

function canaryCleanup() {
  const repo = flag('repo'), branch = flag('branch')
  if (!repo || !/^storage-canary-\d+$/.test(branch ?? '')) { console.error('--repo and a --branch named storage-canary-<number> are required (only canary branches can be removed).'); process.exit(2) }
  if (!has('yes')) { console.error('Add --yes to remove the temporary canary branch.'); process.exit(2) }
  gh(['api', '-X', 'DELETE', `/repos/${repo}/git/refs/heads/${branch}`])
  console.log(`removed temporary branch ${branch}. Remaining canary artifacts expire after 1 day (or delete them in GitManager).`)
}

const table = { explain, env: envCmd, reconcile, snapshot: snapshotCmd, diff: diffCmd, requests: requestsCmd, audit: auditCmd, 'canary-create': canaryCreate, 'canary-cleanup': canaryCleanup }
if (!table[cmd]) { console.error(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 16).join('\n')); process.exit(2) }
await table[cmd]()
