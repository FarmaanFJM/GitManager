import type { AffectedSummary, AffectedVerdict, ServiceAffect, ServiceTech } from '../shared/gitflow.js'
import type { ChangedFile, Location, OpError, Result, ServiceDef } from '../shared/types.js'
import { parseNameStatus } from './git/branches.js'
import { gitError } from './git/errors.js'
import { defaultGitRun, type GitRun } from './git/ops.js'

// After a pull: which services may need attention?
//
// The decision uses only (a) the command the service is configured with, (b) its working directory relative to the
// repository and (c) the repo-relative paths that changed. It never looks at port numbers or guesses from the
// service name. It says "restart-needed" only for files read when the process starts (configuration and dependency
// descriptors) and, for runtimes that definitely do not reload code (plain node, python without --reload, ...),
// source files. Everything probable is "restart-suggested". The caller decides which services are running.
//
// Technology rules (first match over the command's segments, split on && ; | ||):
//   jvm         mvn, mvnw, mvnd, gradle, gradlew, java, spring-boot:run
//   dev-server  vite, next dev, nuxt dev, ng serve, webpack serve / webpack-dev-server, astro dev, and npm|pnpm|yarn|bun
//               scripts named dev, serve or develop (conventionally an HMR server; the script body is not read)
//   node        node, nodemon, ts-node, ts-node-dev, tsx, deno, bun <file>, and npm|pnpm|yarn|bun scripts named start:dev or watch
//               (watching when nodemon, tsx watch, --watch, ts-node-dev, or those script names)
//   python      python, python3, py, uvicorn, gunicorn, flask, fastapi, manage.py (watching with --reload, --debug, runserver)
//   dotnet      dotnet (watching with `dotnet watch`)
//   unknown     anything else, including `npm start` (its script is unknown)
//
// Limits: a JVM service with devtools or a hot-swap agent is not detected (reported as "suggested"); multi-module
// builds are matched by path ancestry only (descriptors in the service directory or its ancestors).

export type ServiceLike = Pick<ServiceDef, 'id' | 'name' | 'command' | 'cwd'>
const MAX_FILES = 5000

// ---- changed files ----

const REV = /^[0-9a-fA-F]{4,64}$/

/** `git diff --name-status` between two commits. Renames are detected, deletions kept, binary files are just paths. */
export async function changedFiles(loc: Location, oldSha: string, newSha: string, git: GitRun = defaultGitRun): Promise<Result<{ files: ChangedFile[]; total: number; truncated: boolean }>> {
  if (!REV.test(oldSha) || !REV.test(newSha)) return fail({ code: 'BAD_REV', message: 'Both commits must be commit ids.' })
  const r = await git(loc, ['diff', '--name-status', '-z', '-M', '--no-color', '--no-ext-diff', oldSha, newSha, '--'], 60_000)
  if (r.code !== 0) return fail(gitError(r, 'Could not list the files changed by the update.'))
  const all = parseNameStatus(r.stdout)
  return { ok: true, value: { files: all.slice(0, MAX_FILES), total: all.length, truncated: all.length > MAX_FILES } }
}
const fail = <T>(error: OpError): Result<T> => ({ ok: false, error })

// ---- technology from the command ----

export type TechInfo = { tech: ServiceTech; watches: boolean }

const PKG = new Set(['npm', 'pnpm', 'yarn', 'bun'])
const exeName = (t: string) => t.replace(/\\/g, '/').split('/').pop()!.replace(/\.(cmd|bat|exe|ps1|sh)$/i, '').toLowerCase()

export function detectTech(command: string): TechInfo {
  const segments = command.split(/&&|\|\||;|\|/).map(s => s.trim()).filter(Boolean)
  const found: TechInfo[] = []
  for (const seg of segments) {
    let toks = seg.match(/"[^"]*"|'[^']*'|\S+/g)?.map(t => t.replace(/^["']|["']$/g, '')) ?? []
    while (toks.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[0]) || ['cross-env', 'env', 'exec', 'call', 'npx', 'pnpx', 'bunx', 'start', 'dlx'].includes(exeName(toks[0])))) {
      const wasXenv = exeName(toks[0]) === 'cross-env'
      toks = toks.slice(1)
      if (wasXenv) while (toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[0])) toks = toks.slice(1)
    }
    if (!toks.length) continue
    const exe = exeName(toks[0]), args = toks.slice(1).map(a => a.toLowerCase()), all = [exe, ...args]
    const has = (re: RegExp) => all.some(a => re.test(a))
    let t: TechInfo | null = null
    if (['mvn', 'mvnw', 'mvnd', 'gradle', 'gradlew', 'java'].includes(exe) || has(/spring-boot:run/)) t = { tech: 'jvm', watches: false }
    else if (PKG.has(exe)) {
      const script = args[0] === 'run' || args[0] === 'run-script' ? args[1] : args[0]
      if (exe === 'bun' && args[0] && /\.(m?[jt]s|cjs)$/.test(args[0])) t = { tech: 'node', watches: args.includes('--watch') || args.includes('--hot') }
      else if (script && ['dev', 'serve', 'develop'].includes(script)) t = { tech: 'dev-server', watches: true }
      else if (script && ['start:dev', 'watch', 'dev:watch'].includes(script)) t = { tech: 'node', watches: true }
      else if (script === 'vite' || script === 'next' || script === 'nuxt') t = detectTech(`${script} ${args.slice(args.indexOf(script) + 1).join(' ')}`)
    }
    else if (exe === 'vite' || exe === 'webpack-dev-server' || exe === 'astro' && args[0] === 'dev' || exe === 'ng' && args[0] === 'serve'
      || (exe === 'next' || exe === 'nuxt') && args[0] === 'dev' || exe === 'webpack' && (args[0] === 'serve' || args[0] === 'server')) t = { tech: 'dev-server', watches: true }
    else if (exe === 'dotnet') t = { tech: 'dotnet', watches: args[0] === 'watch' }
    else if (['node', 'nodemon', 'ts-node', 'ts-node-dev', 'tsx', 'deno'].includes(exe)) {
      t = { tech: 'node', watches: ['nodemon', 'ts-node-dev'].includes(exe) || has(/^--watch/) || (exe === 'tsx' && args[0] === 'watch') || (exe === 'deno' && has(/^--watch/)) }
    }
    else if (/^python[\d.]*$/.test(exe) || exe === 'py' || ['uvicorn', 'gunicorn', 'flask', 'fastapi', 'hypercorn'].includes(exe)) {
      t = { tech: 'python', watches: has(/^--reload$/) || has(/^--debug$/) || has(/^runserver$/) && !has(/^--noreload$/) || (exe === 'fastapi' && args[0] === 'dev') }
    }
    if (t) found.push(t)
  }
  return found[found.length - 1] ?? { tech: 'unknown', watches: false }
}

// ---- paths ----

const toSlashes = (p: string) => p.replace(/\\/g, '/')
const isAbsoluteLike = (p: string) => p.startsWith('/') || /^[a-zA-Z]:/.test(p) || p.startsWith('//')

/** Repo-relative service directory ('' for the root) in `/` form, or null when the directory is not inside the repository. */
export function serviceDir(workingDir: string, cwd: string): string | null {
  const c = toSlashes(cwd.trim()), w = toSlashes(workingDir.trim())
  if (isAbsoluteLike(c)) return null
  const parts: string[] = []
  for (const seg of `${w}/${c}`.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') { if (!parts.length) return null; parts.pop() } else parts.push(seg)
  }
  return parts.join('/')
}

type Cat = 'ignore' | 'config' | 'deps' | 'tsconfig' | 'source' | 'asset' | 'other'
const base = (p: string) => p.split('/').pop()!.toLowerCase()
const LOCKS = /^(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|poetry\.lock|pipfile\.lock|packages\.lock\.json|gradle\.lockfile)$/
const DESCRIPTORS = /^(pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|gradle\.properties|package\.json|requirements[\w.-]*\.txt|pyproject\.toml|pipfile|setup\.py|setup\.cfg|directory\.build\.(props|targets)|global\.json|nuget\.config)$|\.(csproj|fsproj|vbproj|sln)$/
const ENVFILE = /^\.env(\..+)?$/
const TOOLCONFIG = /^(vite|next|nuxt|webpack|rollup|astro|svelte|angular|nest-cli|nodemon)\.config\.\w+$|^(angular|nest-cli|nodemon)\.json$|^\.env/

function category(rel: string, tech: ServiceTech, shared: boolean): Cat {
  const low = rel.toLowerCase(), b = base(rel)
  if (DESCRIPTORS.test(b) || LOCKS.test(b)) return 'deps'
  if (shared) return /^tsconfig([\w.-]*)\.json$/.test(b) ? 'tsconfig' : ENVFILE.test(b) ? 'config' : 'ignore'
  if (/\.(md|mdx|txt|rst|adoc)$/.test(b) && !/^requirements/.test(b) || /^(license|licence|notice|changelog|readme|contributing|\.gitignore|\.gitattributes|\.editorconfig|dockerfile|\.dockerignore)/.test(b)) return 'ignore'
  if (/(^|\/)(docs?|\.github|\.vscode|\.idea)\//.test(low)) return 'ignore'
  if (/(^|\/)(__tests__|tests?|spec|e2e|cypress|__mocks__)\//.test(low) || /\.(test|spec)\.\w+$/.test(b) || /(^|\/)src\/test\//.test(low) || /^test_.*\.py$|_test\.(py|go)$|tests?\.cs$/.test(b)) return 'ignore'
  if (ENVFILE.test(b) || TOOLCONFIG.test(b)) return 'config'
  if (/^tsconfig([\w.-]*)\.json$/.test(b) || b === 'jsconfig.json') return 'tsconfig'
  if (tech === 'jvm') {
    if (/^(application|bootstrap)([\w-]*)\.(properties|ya?ml)$/.test(b) || /^logback([\w-]*)\.xml$/.test(b)) return /(^|\/)src\/main\//.test(low) || !low.includes('/') ? 'config' : 'other'
    return /(^|\/)src\/main\//.test(low) ? 'source' : 'other'
  }
  if (tech === 'dotnet') {
    if (/^appsettings([\w.-]*)\.json$/.test(b) || b === 'web.config' || b === 'launchsettings.json') return 'config'
    return /\.(cs|razor|cshtml|fs|vb)$/.test(b) ? 'source' : 'other'
  }
  if (tech === 'python') return /\.(py|ini|cfg|toml|ya?ml|json|html|jinja2?)$/.test(b) ? 'source' : 'other'
  if (tech === 'dev-server') return /\.(css|scss|sass|less|styl|html|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|json|md)$/.test(b) && /(^|\/)(public|assets|static)\//.test(low) ? 'asset'
    : /\.(m?[jt]sx?|cjs|vue|svelte|astro|css|scss|sass|less|html|svg|json)$/.test(b) ? 'source' : 'other'
  if (tech === 'node') return /\.(m?[jt]sx?|cjs|json|ya?ml|hbs|ejs|pug|html)$/.test(b) ? 'source' : 'other'
  return 'other'
}

type Hit = { verdict: AffectedVerdict; reason: string }

function judge(cat: Cat, t: TechInfo, rel: string): Hit | null {
  const b = base(rel)
  switch (cat) {
    case 'ignore': case 'other': return t.tech === 'unknown' && cat === 'other' ? { verdict: 'restart-suggested', reason: 'The command is not recognized, so it is unknown whether the service reloads this file.' } : null
    case 'config': return { verdict: 'restart-needed', reason: 'Configuration is read when the service starts.' }
    case 'deps':
      if (t.tech === 'jvm' || t.tech === 'dotnet') return { verdict: 'restart-needed', reason: 'Build or dependency descriptors are read at build and start.' }
      if (/^package\.json$/.test(b) || LOCKS.test(b) || /^requirements|^pyproject|^pipfile|^poetry/.test(b)) return { verdict: 'restart-suggested', reason: 'Dependencies changed; restart after installing them.' }
      return { verdict: 'restart-suggested', reason: 'A dependency descriptor changed.' }
    case 'tsconfig': return t.tech === 'dev-server' || t.tech === 'node' ? { verdict: 'restart-suggested', reason: 'TypeScript configuration changed.' } : null
    case 'asset': return { verdict: t.watches ? 'hot-reload' : 'restart-suggested', reason: t.watches ? 'The dev server reloads assets by itself.' : 'The service may need a restart to serve it.' }
    case 'source':
      if (t.tech === 'unknown') return { verdict: 'restart-suggested', reason: 'The command is not recognized, so it is unknown whether the service reloads source files.' }
      if (t.watches) return { verdict: 'hot-reload', reason: t.tech === 'dev-server' ? 'The dev server hot-reloads source files.' : 'The command watches for source changes.' }
      if (t.tech === 'jvm') return { verdict: 'restart-suggested', reason: 'Application code changed; a JVM service usually needs a rebuild and restart (hot swap is not detected).' }
      if (t.tech === 'dotnet') return { verdict: 'restart-suggested', reason: 'Application code changed; it needs a rebuild and restart unless `dotnet watch` is used.' }
      if (t.tech === 'dev-server') return { verdict: 'hot-reload', reason: 'The dev server hot-reloads source files.' }
      return { verdict: 'restart-needed', reason: `${t.tech === 'node' ? 'Node' : 'Python'} loads source code at start and this command does not watch for changes.` }
  }
}

const RANK: Record<AffectedVerdict, number> = { none: 0, 'hot-reload': 1, 'restart-suggested': 2, 'restart-needed': 3 }

/** Dirs from the repo root down to (and excluding) `dir`, as prefixes: '' , 'a', 'a/b'. */
const ancestors = (dir: string) => { const p = dir ? dir.split('/') : []; return p.map((_, i) => p.slice(0, i).join('/')) }

/**
 * Verdict for one service. `files` are repo-relative (renames contribute both paths); `workingDir` is the profile's
 * directory relative to the repository root. A file counts when it is inside the service directory, or is a
 * dependency/config descriptor in one of its ancestor directories (for example a workspace root package.json).
 */
export function classifyChange(files: (ChangedFile | string)[], service: ServiceLike, workingDir = '', opts: { truncated?: boolean } = {}): ServiceAffect {
  const t = detectTech(service.command)
  const out: ServiceAffect = { serviceId: service.id, serviceName: service.name, tech: t.tech, watches: t.watches, verdict: 'none', reasons: [], files: [] }
  const dir = serviceDir(workingDir, service.cwd)
  if (dir === null) { out.reasons.push('The service runs outside the repository, so repository changes do not apply to it.'); return out }
  const anc = new Set(ancestors(dir))
  const hits: { file: string; hit: Hit }[] = []
  const seen = new Set<string>()
  for (const f of files) {
    const paths = typeof f === 'string' ? [f] : [f.path, ...(f.from ? [f.from] : [])]
    for (const raw of paths) {
      const p = toSlashes(raw).replace(/^\.?\//, '')
      if (seen.has(p)) continue
      seen.add(p)
      let rel: string, shared = false
      if (!dir || p === dir || p.startsWith(dir + '/')) rel = dir ? p.slice(dir.length + 1) : p
      else {
        const parent = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''
        if (!anc.has(parent)) continue
        rel = p; shared = true
      }
      const hit = judge(category(rel, t.tech, shared), t, rel)
      if (hit) hits.push({ file: p, hit })
    }
  }
  if (opts.truncated) hits.push({ file: '', hit: { verdict: 'restart-suggested', reason: 'The update changed too many files to inspect them all.' } })
  if (!hits.length) return out
  const top = Math.max(...hits.map(h => RANK[h.hit.verdict]))
  out.verdict = (Object.keys(RANK) as AffectedVerdict[]).find(v => RANK[v] === top)!
  out.reasons = [...new Set(hits.filter(h => RANK[h.hit.verdict] === top).map(h => h.hit.reason))]
  const lower = [...new Set(hits.filter(h => RANK[h.hit.verdict] < top && RANK[h.hit.verdict] > 0).map(h => h.hit.reason))]
  out.reasons.push(...lower.filter(r => !out.reasons.includes(r)).slice(0, 2))
  out.files = hits.filter(h => RANK[h.hit.verdict] === top && h.file).slice(0, 5).map(h => h.file)
  return out
}

/**
 * Verdicts for every service of a profile plus the label for the UI. The caller filters by running state (pass only the
 * running services, or ignore the others in the result); nothing here knows what runs.
 */
export function summarizeAffected(files: (ChangedFile | string)[], services: ServiceLike[], workingDir = '', opts: { truncated?: boolean } = {}): AffectedSummary {
  const list = services.map(s => classifyChange(files, s, workingDir, opts))
  const attention = list.filter(s => s.verdict === 'restart-needed' || s.verdict === 'restart-suggested')
  const text = attention.length === 0 ? ''
    : attention.length === 1 ? `${attention[0].serviceName} updated · ${attention[0].verdict === 'restart-needed' ? 'Restart' : 'Restart suggested'}`
    : `${attention.length} services need attention`
  return { services: list, text, needsAttention: attention.length, filesChanged: files.length, truncated: !!opts.truncated }
}
