// Read-only environment inspector. Nothing here modifies a process or a file, and nothing logs a value.
// Values are always returned in full (never truncated or masked) so the person can reveal them; `sensitive` only tells
// the UI to hide them by default. Environment data leaves this module only through return values.
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { ConfigEntry, ConfigFileEnv, EnvEntry, EnvSnapshot, ProcInfo } from '../../shared/procs.js'
import { flavorOf } from '../paths.js'
import type { ProcAdapter } from './model.js'
import { procKey } from './model.js'
import type { OwnershipSource } from './inspector.js'

/* ------------------------------------------------------------ sensitivity */

const STRONG = ['SECRET', 'PASSWORD', 'PASSWD', 'PASSPHRASE', 'TOKEN', 'CREDENTIAL', 'PRIVATE', 'APIKEY', 'ACCESSKEY', 'SIGNATURE', 'CONNECTIONSTRING', 'SESSIONID']
const TOKEN_WORDS = new Set(['KEY', 'KEYS', 'PWD', 'PASS', 'AUTH', 'JWT', 'DSN', 'COOKIE', 'BEARER', 'SALT', 'SIG'])
const URI_NAMES = /(^|[^A-Z])(MONGO(DB)?|DATABASE|DB|REDIS|AMQP|RABBITMQ|POSTGRES(QL)?|MYSQL|MARIADB|JDBC|BROKER|CACHE)[A-Z_]*(URI|URL|DSN)$/

/** Splits SNAKE_CASE, kebab-case, dotted.keys and camelCase into upper-case words. */
function words(name: string): string[] {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+|\s+/).filter(Boolean).map(w => w.toUpperCase())
}

/** Heuristic only: used to pre-conceal values in the UI. */
export function isSensitiveName(name: string): boolean {
  const w = words(name)
  const joined = w.join('')
  const underscored = w.join('_')
  if (STRONG.some(s => joined.includes(s))) return true
  if (w.some(x => TOKEN_WORDS.has(x))) return true
  if (URI_NAMES.test(underscored)) return true
  return false
}

const CRED_URL = /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i
const JWT = /^eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*$/
const TOKEN_PREFIX = /^(ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|glpat-|xox[abprs]-|sk-[A-Za-z0-9]|sk_live_|rk_live_|pk_live_|AKIA[0-9A-Z]{12}|AIza[0-9A-Za-z_-]{20}|npm_[A-Za-z0-9]{20})/
const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----/

export function isSensitiveValue(value: string): boolean {
  return CRED_URL.test(value) || JWT.test(value.trim()) || TOKEN_PREFIX.test(value.trim()) || PEM.test(value) || /^Bearer\s+\S{12,}/i.test(value)
}

export const isSensitive = (name: string, value: string) => isSensitiveName(name) || isSensitiveValue(value)

/** Masks sensitive material in free text for logs and exports. Not used for what the UI shows to the owner of the data. */
export function redactForLog(text: string): string {
  const MASK = '***'
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, `[private key ${MASK}]`)
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+@/gi, `$1${MASK}@`)
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, MASK)
    .replace(/\b(Bearer\s+)\S{8,}/gi, `$1${MASK}`)
    .replace(/\b(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|glpat-|xox[abprs]-|sk_live_|rk_live_)[A-Za-z0-9_-]{8,}/g, MASK)
    .replace(/\bAKIA[0-9A-Z]{12,}\b/g, MASK)
    .replace(/(^|[\s;,&?"'])((?:export\s+)?[A-Za-z_][A-Za-z0-9_.-]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s"';,&]+)/g, (all, pre: string, name: string, sep: string, val: string) => {
      const bare = name.replace(/^export\s+/, '')
      return !val.includes(MASK) && (isSensitiveName(bare) || isSensitiveValue(val.replace(/^["']|["']$/g, ''))) ? `${pre}${name}${sep}${MASK}` : all
    })
}

export const toEntries = (pairs: { name: string; value: string }[]): EnvEntry[] =>
  pairs.map(p => ({ name: p.name, value: p.value, sensitive: isSensitive(p.name, p.value) })).sort((a, b) => a.name.localeCompare(b.name))

/* ------------------------------------------------------------ launch environment */

/** Exactly the environment GitManager hands to spawn: base, then env file, then the service's own variables. */
export function captureLaunchEnv(baseEnv: Record<string, string | undefined>, serviceEnv: Record<string, string | undefined> = {}, envFileEnv: Record<string, string | undefined> = {}): Record<string, string> {
  const out: Record<string, string> = {}
  for (const src of [baseEnv, envFileEnv, serviceEnv]) for (const [k, v] of Object.entries(src)) if (v !== undefined) out[k] = v
  return out
}

/** Bounded memory of the environments services were started with, keyed by serviceKey + pid. Oldest entries go first. */
export class LaunchEnvStore {
  private map = new Map<string, { serviceKey: string; pid: number; env: Record<string, string>; at: number }>()
  constructor(private readonly maxEntries = 64, private readonly now: () => number = Date.now) {}
  private k = (serviceKey: string, pid: number) => `${serviceKey}\u0000${pid}`
  record(serviceKey: string, pid: number, env: Record<string, string>) {
    const key = this.k(serviceKey, pid)
    this.map.delete(key)
    this.map.set(key, { serviceKey, pid, env: { ...env }, at: this.now() })
    while (this.map.size > this.maxEntries) this.map.delete(this.map.keys().next().value as string)
  }
  get(serviceKey: string, pid: number) { return this.map.get(this.k(serviceKey, pid)) }
  /** The most recent launch of a service (any pid). */
  latest(serviceKey: string) { let r; for (const v of this.map.values()) if (v.serviceKey === serviceKey) r = v; return r }
  forget(serviceKey: string, pid?: number) { for (const [k, v] of this.map) if (v.serviceKey === serviceKey && (pid === undefined || v.pid === pid)) this.map.delete(k) }
  get size() { return this.map.size }
}

export type RuntimeEnvDeps = { launchEnv?: LaunchEnvStore; ownership?: OwnershipSource; adapter?: ProcAdapter; now?: () => number }

const LAUNCH_NOTE = 'This is the environment GitManager passed when it started the service. It does not include variables the program or its start script set afterwards.'

export async function runtimeEnvOf(info: ProcInfo, deps: RuntimeEnvDeps = {}): Promise<EnvSnapshot> {
  const capturedAt = new Date((deps.now ?? Date.now)()).toISOString()
  const base = { context: info.context, pid: info.pid, capturedAt }
  const managed = deps.ownership?.managedPids().get(procKey(info.context, info.pid))
  const serviceKey = info.serviceKey ?? managed?.serviceKey

  if (info.owner === 'gitmanager' && serviceKey) {
    const exact = deps.launchEnv?.get(serviceKey, info.pid)
    if (exact) return { ...base, source: 'runtime-launch', entries: toEntries(Object.entries(exact.env).map(([name, value]) => ({ name, value }))), note: LAUNCH_NOTE }
    if (managed?.launchEnv) return { ...base, source: 'runtime-launch', entries: toEntries(Object.entries(managed.launchEnv).map(([name, value]) => ({ name, value }))), note: LAUNCH_NOTE }
  }

  let liveReason: string | undefined
  if (deps.adapter) {
    const r = await deps.adapter.liveEnv(info.pid)
    if (r.ok) return { ...base, source: 'runtime-live', entries: toEntries(r.entries), note: r.note }
    liveReason = r.reason
  } else liveReason = 'No adapter is available for this environment.'

  if (info.owner === 'gitmanager' && serviceKey) {
    const latest = deps.launchEnv?.latest(serviceKey)
    if (latest) return { ...base, source: 'runtime-launch', entries: toEntries(Object.entries(latest.env).map(([name, value]) => ({ name, value }))), note: `${LAUNCH_NOTE} This process was started by the service's command, so it normally inherits that environment.` }
  }
  return { ...base, source: 'unavailable', entries: [], reason: liveReason, note: 'The environment of this process cannot be shown.' }
}

/* ------------------------------------------------------------ config files */

export const CONFIG_NOTE = 'Read from the file on disk. This is not what a running process resolved: changing the file does not update a process that is already running, and placeholders are not expanded.'

type Parsed = { entries: ConfigEntry[]; parseErrors: { line: number; message: string }[] }

function finish(raw: Omit<ConfigEntry, 'sensitive' | 'overridden'>[], parseErrors: Parsed['parseErrors']): Parsed {
  const last = new Map<string, number>()
  raw.forEach((e, i) => last.set(e.name, i))
  return { parseErrors, entries: raw.map((e, i) => ({ ...e, sensitive: isSensitive(e.name, e.value), ...(last.get(e.name) !== i ? { overridden: true } : {}) })) }
}

/** dotenv syntax: comments, `export`, quotes, escapes in double quotes, multi-line quoted values, duplicates (last wins). */
export function parseDotenv(text: string): Parsed {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  const raw: Omit<ConfigEntry, 'sensitive'>[] = []
  const errors: Parsed['parseErrors'] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s?(.*)$/.exec(line)
    if (!m) { errors.push({ line: i + 1, message: 'Expected NAME=value.' }); continue }
    const name = m[1]
    const rest = m[2].replace(/^\s+/, '')
    const q = rest[0]
    if (q === '"' || q === "'" || q === '`') {
      // find the closing quote, possibly on a later line
      let buf = rest.slice(1), j = i, closed = -1
      for (;;) {
        for (let k = 0; k < buf.length; k++) {
          if (q === '"' && buf[k] === '\\') { k++; continue }
          if (buf[k] === q) { closed = k; break }
        }
        if (closed >= 0 || j + 1 >= lines.length) break
        j++
        buf += '\n' + lines[j]
      }
      if (closed < 0) { errors.push({ line: i + 1, message: 'Unterminated quoted value.' }); raw.push({ name, value: rest, line: i + 1 }); continue }
      let value = buf.slice(0, closed)
      if (q === '"') value = value.replace(/\\([nrt"\\$'`])/g, (_a, c: string) => (c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c))
      const after = buf.slice(closed + 1).trim()
      if (after && !after.startsWith('#')) errors.push({ line: j + 1, message: 'Unexpected text after the closing quote.' })
      raw.push({ name, value, line: i + 1 })
      i = j
      continue
    }
    raw.push({ name, value: rest.replace(/\s+#.*$/, '').trim(), line: i + 1 })
  }
  return finish(raw, errors)
}

/** Java .properties as Spring reads them: key=value, key:value, key value, # and ! comments, trailing backslash continues. */
export function parseProperties(text: string): Parsed {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  const raw: Omit<ConfigEntry, 'sensitive'>[] = []
  const errors: Parsed['parseErrors'] = []
  const unescape = (s: string) => s.replace(/\\u([0-9a-fA-F]{4})/g, (_a, h: string) => String.fromCharCode(parseInt(h, 16))).replace(/\\([tnrf])/g, (_a, c: string) => ({ t: '\t', n: '\n', r: '\r', f: '\f' })[c as 't'] ?? c).replace(/\\(.)/g, '$1')
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].replace(/^\s+/, '')
    if (!line || line[0] === '#' || line[0] === '!') continue
    const start = i + 1
    while (/(^|[^\\])(\\\\)*\\$/.test(line) && i + 1 < lines.length) { line = line.slice(0, -1) + lines[++i].replace(/^\s+/, '') }
    let k = 0
    while (k < line.length && !/[=:\s]/.test(line[k])) { if (line[k] === '\\') k++; k++ }
    const key = unescape(line.slice(0, k))
    let rest = line.slice(k).replace(/^\s*[=:]?\s*/, '')
    if (!key) { errors.push({ line: start, message: 'Missing key.' }); continue }
    rest = unescape(rest)
    raw.push({ name: key, value: rest, line: start })
  }
  return finish(raw, errors)
}

const unquoteYaml = (v: string): string => {
  const t = v.trim()
  if (t.length >= 2 && t[0] === '"' && t.endsWith('"')) return t.slice(1, -1).replace(/\\(["\\nt/])/g, (_a, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c))
  if (t.length >= 2 && t[0] === "'" && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'")
  return t
}

function stripYamlComment(s: string): string {
  let q = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (q) { if (c === q) q = ''; else if (c === '\\' && q === '"') i++ } else if (c === '"' || c === "'") q = c
    else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i)
  }
  return s
}

function splitKey(content: string): { key: string; value: string } | null {
  if (content[0] === '"' || content[0] === "'") {
    const end = content.indexOf(content[0], 1)
    if (end > 0 && /^\s*:(\s|$)/.test(content.slice(end + 1))) return { key: content.slice(1, end), value: content.slice(end + 1).replace(/^\s*:\s*/, '') }
  }
  const m = /^(.*?):(?:\s+(.*))?$/.exec(content)
  if (m && m[1].trim() && !/^[[{&*!|>%@`-]/.test(m[1])) return { key: m[1].trim(), value: m[2] ?? '' }
  return null
}

/**
 * A deliberately small YAML reader for Spring configuration: nested mappings and lists are flattened to dotted keys
 * (a.b.c, a.list[0]). Anchors, aliases, merge keys and tab indentation are reported as parse errors, not guessed.
 */
export function parseYamlFlat(text: string): Parsed {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  const raw: Omit<ConfigEntry, 'sensitive'>[] = []
  const errors: Parsed['parseErrors'] = []
  let stack: { indent: number; path: string }[] = [{ indent: -1, path: '' }]
  let counters = new Map<string, number>()
  const nextIndent = (from: number): number => {
    for (let j = from; j < lines.length; j++) { const s = stripYamlComment(lines[j]); if (s.trim() && !/^---/.test(s)) return s.length - s.trimStart().length }
    return -1
  }
  const nextIsList = (from: number): boolean => {
    for (let j = from; j < lines.length; j++) { const s = stripYamlComment(lines[j]); if (s.trim()) return /^\s*-(\s|$)/.test(s) }
    return false
  }
  for (let i = 0; i < lines.length; i++) {
    const noComment = stripYamlComment(lines[i]).replace(/\s+$/, '')
    if (!noComment.trim()) continue
    if (/^(---|\.\.\.)(\s|$)/.test(noComment)) { stack = [{ indent: -1, path: '' }]; counters = new Map(); continue }
    if (noComment.startsWith('%')) continue
    if (/^\s*\t/.test(noComment)) { errors.push({ line: i + 1, message: 'Tab indentation is not valid YAML.' }); continue }
    const indent = noComment.length - noComment.trimStart().length
    let content = noComment.trim()
    const isItem = content === '-' || content.startsWith('- ')
    while (stack.length > 1 && (isItem ? stack[stack.length - 1].indent > indent : stack[stack.length - 1].indent >= indent)) stack.pop()
    let parent = stack[stack.length - 1].path
    let keyIndent = indent
    if (isItem) {
      const n = counters.get(parent) ?? 0
      counters.set(parent, n + 1)
      const itemPath = `${parent}[${n}]`
      const rest = content.slice(1).trim()
      if (!rest) { stack.push({ indent, path: itemPath }); continue }
      const kv = splitKey(rest)
      if (!kv) { raw.push({ name: itemPath, value: unquoteYaml(rest), line: i + 1 }); continue }
      keyIndent = indent + (content.length - content.slice(1).trimStart().length)
      stack.push({ indent: keyIndent - 1, path: itemPath }) // its keys sit at keyIndent: siblings, not children
      parent = itemPath
      content = rest
    }
    const kv = splitKey(content)
    if (!kv) { errors.push({ line: i + 1, message: 'Unsupported YAML syntax; line skipped.' }); continue }
    if (kv.key === '<<') { errors.push({ line: i + 1, message: 'Merge keys are not expanded.' }); continue }
    const path = parent ? `${parent}.${kv.key}` : kv.key
    const val = kv.value.trim()
    if (val === '') {
      if (nextIndent(i + 1) > keyIndent || (nextIsList(i + 1) && nextIndent(i + 1) >= keyIndent)) stack.push({ indent: keyIndent, path })
      else raw.push({ name: path, value: '', line: i + 1 })
    } else if (/^[|>][+-]?\d*$/.test(val)) {
      const parts: string[] = []
      let j = i + 1
      for (; j < lines.length; j++) {
        const l = lines[j]
        if (l.trim() && l.length - l.trimStart().length <= keyIndent) break
        parts.push(l.trim())
      }
      while (parts.length && !parts[parts.length - 1]) parts.pop()
      raw.push({ name: path, value: parts.join(val[0] === '|' ? '\n' : ' '), line: i + 1 })
      i = j - 1
    } else if (/^[&*]/.test(val)) {
      errors.push({ line: i + 1, message: 'Anchors and aliases are not expanded.' })
    } else raw.push({ name: path, value: unquoteYaml(val), line: i + 1 })
  }
  return finish(raw, errors)
}

export type ConfigFs = {
  listDir(dir: string): Promise<string[] | null>
  readFile(file: string, maxBytes?: number): Promise<string | null>
}

export const localConfigFs: ConfigFs = {
  async listDir(dir) { try { return await readdir(dir) } catch { return null } },
  async readFile(file, maxBytes = 512 * 1024) { try { return (await readFile(file)).subarray(0, maxBytes).toString('utf8') } catch { return null } },
}

const DOTENV_NAME = /^\.env(\.[A-Za-z0-9_.-]+)?$/
const DOTENV_TEMPLATE = /\.(example|sample|template|dist|defaults?)$/i
const SPRING_NAME = /^application(-[A-Za-z0-9_.-]+)?\.(properties|ya?ml)$/i

export function configFormatOf(name: string): ConfigFileEnv['format'] | null {
  if (DOTENV_NAME.test(name) && !DOTENV_TEMPLATE.test(name)) return 'dotenv'
  const m = SPRING_NAME.exec(name)
  return m ? (m[2].toLowerCase() === 'properties' ? 'properties' : 'yaml') : null
}

/**
 * Finds and parses configuration files in a service directory: .env, .env.local, .env.development, .env.*.local and
 * Spring's application*.properties / .yml / .yaml (in the directory, ./config, src/main/resources and its config/).
 * `names` restricts to exact file names. Templates such as .env.example are skipped unless named explicitly.
 * Pass a `fs` backed by the right runtime (for WSL, a HostShell) so the path is read where it lives.
 */
export async function readConfigFiles(dir: string, names?: string[], fs: ConfigFs = localConfigFs): Promise<ConfigFileEnv[]> {
  const p = flavorOf(dir) === 'win32' ? path.win32 : path.posix
  const dirs = [dir, p.join(dir, 'config'), p.join(dir, 'src', 'main', 'resources'), p.join(dir, 'src', 'main', 'resources', 'config')]
  const out: ConfigFileEnv[] = []
  for (const d of dirs) {
    const listing = await fs.listDir(d)
    if (!listing) continue
    const wanted = (names ? listing.filter(n => names.includes(n)) : listing.filter(n => configFormatOf(n) !== null)).sort((a, b) => a.localeCompare(b))
    for (const n of wanted) {
      const format = names ? configFormatOf(n) ?? (/\.ya?ml$/i.test(n) ? 'yaml' : /\.properties$/i.test(n) ? 'properties' : 'dotenv') : configFormatOf(n)
      if (!format) continue
      const file = p.join(d, n)
      const text = await fs.readFile(file, 512 * 1024)
      if (text === null) { out.push({ kind: 'config-file', path: file, format, entries: [], parseErrors: [{ line: 0, message: 'The file could not be read.' }], note: CONFIG_NOTE }); continue }
      const parsed = format === 'dotenv' ? parseDotenv(text) : format === 'properties' ? parseProperties(text) : parseYamlFlat(text)
      out.push({ kind: 'config-file', path: file, format, entries: parsed.entries, parseErrors: parsed.parseErrors, note: CONFIG_NOTE })
    }
  }
  return out
}
