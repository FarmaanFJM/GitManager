// Placeholder detection for pasted commands, and safe reconstruction of the command once the user supplied the values.
// Pure functions: no DOM, no Node API, no I/O. The renderer uses them before anything reaches the shell; nothing here ever
// runs, stores or logs a value. Detection is deliberately conservative: it recognizes text that is *marked* as a template
// (YOUR_TOKEN, <API_KEY>, {{name}}, ..._HERE) and never treats an ordinary uppercase name as missing.

export type ShellSyntax = 'powershell' | 'posix'

/** Where in the command text a placeholder sits; decides how a value must be escaped. */
export type QuoteContext = 'code' | 'single' | 'double' | 'here-single' | 'here-double'

export type Occurrence = { start: number; end: number; context: QuoteContext }

export type Placeholder = {
  /** The text as written, e.g. `YOUR_TOKEN` or `<API_KEY>`. Repeated references share one entry. */
  token: string
  /** Looks like a secret (token, key, password...): the input is masked by default. */
  sensitive: boolean
  occurrences: Occurrence[]
}

export const MAX_DETECT_CHARS = 256 * 1024
export const MAX_VALUE_CHARS = 4096

/* ------------------------------------------------------------------ paste preparation */

// Control characters other than tab, line feed and carriage return. An ESC inside pasted text could end bracketed paste early
// and turn the rest of the text into typed input, so none of them are passed on.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g

/**
 * Text that is safe to insert: control characters removed and trailing line breaks dropped, so a pasted command is never
 * submitted by its own final newline. Line breaks inside the text are kept (a multi-line command stays multi-line).
 */
export function preparePaste(text: string): string {
  return text.replace(CONTROL, '').replace(/(?:\r\n|\n|\r)+$/, '')
}

/* ------------------------------------------------------------------ quote scanning */

type Ctx = 0 | 1 | 2 | 3 | 4 | 5 // code, single, double, here-single, here-double, comment
const CTX_NAME: QuoteContext[] = ['code', 'single', 'double', 'here-single', 'here-double', 'code']

/** The syntactic context of every character: code, inside quotes, inside a here-string or inside a comment. */
export function scanContexts(text: string, syntax: ShellSyntax): Uint8Array {
  const out = new Uint8Array(text.length)
  type Frame = { kind: 'code' | 'dq'; depth: number }
  const stack: Frame[] = [{ kind: 'code', depth: 0 }]
  const ps = syntax === 'powershell'
  let i = 0
  const set = (from: number, to: number, c: Ctx) => { for (let k = from; k < Math.min(to, text.length); k++) out[k] = c }
  const startOfToken = (k: number) => k === 0 || /[\s;(){}|&]/.test(text[k - 1])
  while (i < text.length) {
    const top = stack[stack.length - 1]
    const ch = text[i]
    if (top.kind === 'dq') {
      if (ch === '`' && ps || ch === '\\' && !ps) { set(i, i + 2, 2); i += 2; continue }
      if (ps && ch === '"' && text[i + 1] === '"') { set(i, i + 2, 2); i += 2; continue }
      if (ch === '"') { set(i, i + 1, 2); stack.pop(); i++; continue }
      if (ch === '$' && text[i + 1] === '(') { set(i, i + 2, 2); stack.push({ kind: 'code', depth: 0 }); i += 2; continue }
      out[i] = 2; i++; continue
    }
    // code
    if (ps && (ch === '@') && (text[i + 1] === '\'' || text[i + 1] === '"')) {
      const q = text[i + 1]
      const nl = /^[ \t]*\r?\n/.exec(text.slice(i + 2))
      if (nl) {
        const bodyStart = i + 2 + nl[0].length
        const closeRe = new RegExp(`\\r?\\n${q}@`)
        const m = closeRe.exec(text.slice(bodyStart - 1))
        const end = m ? bodyStart - 1 + m.index : text.length
        set(i, end, q === '\'' ? 3 : 4)
        const stop = m ? end + m[0].length : text.length
        set(end, stop, 0)
        i = stop; continue
      }
    }
    if (ps && ch === '<' && text[i + 1] === '#') {
      const e = text.indexOf('#>', i + 2)
      const stop = e < 0 ? text.length : e + 2
      set(i, stop, 5); i = stop; continue
    }
    if (ch === '#' && startOfToken(i)) {
      let e = text.indexOf('\n', i)
      if (e < 0) e = text.length
      set(i, e, 5); i = e; continue
    }
    if (ch === '\'') {
      let j = i + 1
      for (; j < text.length; j++) {
        if (text[j] === '\'') { if (ps && text[j + 1] === '\'') { j++; continue } break }
      }
      set(i, j + 1, 1); i = j + 1; continue
    }
    if (ch === '"') { out[i] = 0; stack.push({ kind: 'dq', depth: 0 }); i++; set(i - 1, i, 2); continue }
    if ((ps && ch === '`') || (!ps && ch === '\\')) { i += 2; continue }
    if (ch === '(' ) { top.depth++; i++; continue }
    if (ch === ')') {
      if (top.depth === 0 && stack.length > 1) stack.pop(); else if (top.depth > 0) top.depth--
      i++; continue
    }
    i++
  }
  return out
}

/* ------------------------------------------------------------------ detection */

const SECRET = /(TOKEN|KEY|SECRET|PASSWORD|PASSWD|PASS|PWD|CREDENTIAL|AUTH|BEARER|PRIVATE|SIGNATURE|CERT)/i
const VOCAB = /(TOKEN|KEY|SECRET|PASSWORD|PASSWD|PASS|PWD|CREDENTIAL|CLIENT|USERNAME|URI|URL|HOST|ID)/
const BRACKET_WORDS = /^(api[-_ ]?key|token|access[-_ ]?token|password|secret|client[-_ ]?id|client[-_ ]?secret|username|user[-_ ]?name|host|url|uri|key|value)$/i

type Raw = { start: number; end: number; token: string; rule: 'named' | 'bracket' | 'template' | 'uri-key' | 'generic' }

function lineBounds(text: string, at: number) {
  const s = text.lastIndexOf('\n', at - 1) + 1
  const e = text.indexOf('\n', at)
  return { start: s, end: e < 0 ? text.length : e }
}

/** The token names a variable or parameter rather than a value: `$X`, `${X}`, `$env:X`, `Env:X`, `%X%`, `@X`, `-X`, or `X=` at an assignment. */
function isNameUse(text: string, start: number, end: number): boolean {
  const before = text.slice(Math.max(0, start - 8), start)
  if (/(\$\{?|%|@)$/.test(before) || /\benv:$/i.test(before)) return true
  if (/^-$/.test(text[start - 1] ?? '') && (start === 1 || /[\s;(|]/.test(text[start - 2]))) return true
  const after = text.slice(end, end + 12)
  if (/^[ \t]*=(?!=)/.test(after) && !/^[ \t]*=\s*$/.test(after.slice(0, 0))) {
    // an assignment target when it begins the statement or follows `$env:`/`$`/export/set; a query string (`?key=`) never reaches here
    const lb = lineBounds(text, start)
    const head = text.slice(lb.start, start)
    if (/^\s*(?:\$(?:env:)?|export\s+|set\s+|setx\s+)?$/i.test(head) || /[;|&(]\s*(?:\$(?:env:)?)?$/.test(head)) return true
  }
  return false
}

// Not preceded by a letter, digit, underscore or hyphen: `SHIFT-INSERT-TEXT` is ordinary text, `YOUR_TOKEN` and `--key=YOUR_TOKEN` are not.
const NAMED = /(?<![A-Za-z0-9_-])(?:YOUR[_-][A-Z0-9]+(?:[_-][A-Z0-9]+)*|(?:INSERT|ENTER|PASTE|REPLACE)[_-][A-Z0-9]+(?:[_-][A-Z0-9]+)*|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_HERE|CHANGE_?ME|[A-Z0-9]*(?:_[A-Z0-9]+)*PLACEHOLDER(?:_[A-Z0-9]+)*|URI_KEY)\b/g
const ANGLE = /<([A-Za-z][A-Za-z0-9_ -]{0,48})>/g
const MUSTACHE = /\{\{\s*([A-Za-z_][\w.-]{0,48})\s*\}\}/g
const SQUARE = /\[(YOUR_[A-Z0-9_]+)\]/g
const GENERIC = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g

function angleIsPlaceholder(inner: string): boolean {
  const t = inner.trim()
  if (/^[A-Z][A-Z0-9_ -]*$/.test(t)) return true
  return /^(your|my|the)[-_ ][A-Za-z0-9_ -]+$/i.test(t) || BRACKET_WORDS.test(t)
}

/**
 * Finds obviously unresolved placeholders. Recognized: names starting YOUR_, INSERT_, ENTER_, PASTE_ or REPLACE_, names ending _HERE,
 * CHANGE_ME, names containing PLACEHOLDER, URI_KEY (as a value), <TOKEN>, <your-token>, {{name}}, [YOUR_X], and a credential-like NAME that is a quoted
 * value equal to its own variable (`$env:API_TOKEN = "API_TOKEN"`) or that a nearby comment says to replace.
 * Never recognized: variables ($TOKEN, $env:TOKEN, ${TOKEN}, %TOKEN%), assignment targets, parameters, comments, ${{ }}, plain uppercase text.
 */
export function detectPlaceholders(text: string, syntax: ShellSyntax = 'powershell'): Placeholder[] {
  if (!text || text.length > MAX_DETECT_CHARS) return []
  const ctx = scanContexts(text, syntax)
  const raws: Raw[] = []
  const inCode = (i: number) => ctx[i] !== 5
  const push = (r: Raw) => { if (inCode(r.start)) raws.push(r) }

  for (const m of text.matchAll(ANGLE)) {
    const start = m.index!, end = start + m[0].length
    if (/[\w$]/.test(text[start - 1] ?? '') || !angleIsPlaceholder(m[1])) continue
    push({ start, end, token: m[0], rule: 'bracket' })
  }
  for (const m of text.matchAll(MUSTACHE)) {
    const start = m.index!
    if (text[start - 1] === '$') continue
    push({ start, end: start + m[0].length, token: m[0], rule: 'template' })
  }
  for (const m of text.matchAll(SQUARE)) {
    const start = m.index!
    if (/[\w$)\]]/.test(text[start - 1] ?? '')) continue
    push({ start, end: start + m[0].length, token: m[0], rule: 'bracket' })
  }
  for (const m of text.matchAll(NAMED)) {
    const start = m.index!, end = start + m[0].length
    if (isNameUse(text, start, end)) continue
    push({ start, end, token: m[0], rule: m[0] === 'URI_KEY' ? 'uri-key' : 'named' })
  }

  // Context rule: a credential-like NAME that is the whole quoted value and repeats its own variable, or a comment says to replace it.
  let hinted: boolean | null = null
  const commentHint = () => {
    if (hinted !== null) return hinted
    hinted = false
    let k = 0
    while (k < text.length && !hinted) {
      if (ctx[k] === 5) { let e = k; while (e < text.length && ctx[e] === 5) e++; hinted = /\b(replace|fill in|insert|substitute|placeholder|your)\b/i.test(text.slice(k, e)); k = e } else k++
    }
    return hinted
  }
  for (const m of text.matchAll(GENERIC)) {
    const start = m.index!, end = start + m[0].length
    if (!VOCAB.test(m[0]) || (ctx[start] !== 1 && ctx[start] !== 2)) continue
    const open = text[start - 1], close = text[end]
    if (!open || open !== close || (open !== '"' && open !== '\'')) continue // the whole string, not part of one
    const lb = lineBounds(text, start)
    const head = text.slice(lb.start, start - 1)
    const lhs = /(?:^|[\s;])(?:\$(?:env:)?|export\s+|set\s+|setx\s+)?([A-Za-z_]\w*)\s*(?:=|\s)\s*$/.exec(head)?.[1]
    if (lhs === m[0] || commentHint()) push({ start, end, token: m[0], rule: 'generic' })
  }

  // Overlaps (<YOUR_TOKEN> contains YOUR_TOKEN): the earliest and longest match wins.
  raws.sort((a, b) => a.start - b.start || b.end - a.end)
  const taken: Raw[] = []
  for (const r of raws) { const last = taken[taken.length - 1]; if (!last || r.start >= last.end) taken.push(r) }

  const byToken = new Map<string, Placeholder>()
  for (const r of taken) {
    let p = byToken.get(r.token)
    if (!p) { p = { token: r.token, sensitive: SECRET.test(r.token), occurrences: [] }; byToken.set(r.token, p) }
    p.occurrences.push({ start: r.start, end: r.end, context: CTX_NAME[ctx[r.start]] })
  }
  return [...byToken.values()]
}

/* ------------------------------------------------------------------ reconstruction */

export type Problem = { token: string; reason: string }
export type Reconstruction = { ok: true; text: string; replaced: string[]; unchanged: string[] } | { ok: false; problems: Problem[] }

const SAFE_BARE = /^[A-Za-z0-9_.:/+~=][A-Za-z0-9_.:/+~=-]*$/
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\x00-\x1f\x7f]/

function escapeFor(ctxName: QuoteContext, value: string, syntax: ShellSyntax): string | { problem: string } {
  const ps = syntax === 'powershell'
  switch (ctxName) {
    case 'single':
      return ps ? value.replace(/['\u2018\u2019\u201A\u201B]/g, c => c + c) : value.replace(/'/g, '\'\\\'\'')
    case 'double':
    case 'here-double':
      if (ps) return value.replace(/[`$"\u201C\u201D\u201E]/g, c => '`' + c)
      if (value.includes('!')) return { problem: 'contains "!", which the shell would expand inside double quotes' }
      return value.replace(/[\\"$`]/g, c => '\\' + c)
    case 'here-single':
      return value
    case 'code':
      return value
  }
}

function quoteWhole(value: string, syntax: ShellSyntax): string {
  return syntax === 'powershell' ? `'${value.replace(/['\u2018\u2019\u201A\u201B]/g, c => c + c)}'` : `'${value.replace(/'/g, '\'\\\'\'')}'`
}

const DELIM_BEFORE = /[\s;|(){]/
const DELIM_AFTER = /[\s;|()}]/

/**
 * Replaces placeholders by values, preserving everything else byte for byte. Each value is escaped for the quote context it lands in;
 * a bare placeholder whose value needs quoting becomes a single-quoted word. When a substitution cannot be done safely (the value has a line
 * break, or needs quoting but sits inside a larger unquoted word) nothing is returned but the reasons, so no value is changed silently.
 * Placeholders without a value are left as they are. `maskedTokens` render as dots, for a preview that must not show a secret.
 */
export function reconstruct(text: string, placeholders: Placeholder[], values: Record<string, string>, opts: { syntax?: ShellSyntax; maskedTokens?: ReadonlySet<string> } = {}): Reconstruction {
  const syntax = opts.syntax ?? 'powershell'
  const problems: Problem[] = []
  const edits: { start: number; end: number; text: string }[] = []
  const replaced: string[] = [], unchanged: string[] = []
  for (const p of placeholders) {
    const value = values[p.token]
    if (value === undefined || value === '') { unchanged.push(p.token); continue }
    if (value.length > MAX_VALUE_CHARS) { problems.push({ token: p.token, reason: `is longer than ${MAX_VALUE_CHARS} characters` }); continue }
    if (CONTROLS.test(value)) { problems.push({ token: p.token, reason: 'must be a single line without control characters' }); continue }
    const masked = opts.maskedTokens?.has(p.token) ?? false
    let bad = false
    for (const o of p.occurrences) {
      if (masked) { edits.push({ start: o.start, end: o.end, text: '\u2022'.repeat(8) }); continue }
      if (o.context === 'code') {
        const before = text[o.start - 1], after = text[o.end]
        const whole = (before === undefined || DELIM_BEFORE.test(before)) && (after === undefined || DELIM_AFTER.test(after))
        const safeBare = SAFE_BARE.test(value) && !(syntax === 'powershell' && value.length > 1 && /^-/.test(value))
        if (safeBare) edits.push({ start: o.start, end: o.end, text: value })
        else if (whole) edits.push({ start: o.start, end: o.end, text: quoteWhole(value, syntax) })
        else { problems.push({ token: p.token, reason: 'needs quoting but is part of a larger unquoted word. Put the value in quotes in the command, or edit it by hand' }); bad = true; break }
        continue
      }
      if (o.context === 'here-single') {
        const lineStart = o.start === 0 || text[o.start - 1] === '\n'
        if (lineStart && value.startsWith('\'@')) { problems.push({ token: p.token, reason: 'would end the here-string' }); bad = true; break }
      }
      const esc = escapeFor(o.context, value, syntax)
      if (typeof esc !== 'string') { problems.push({ token: p.token, reason: esc.problem }); bad = true; break }
      edits.push({ start: o.start, end: o.end, text: esc })
    }
    if (!bad) replaced.push(p.token)
  }
  if (problems.length) return { ok: false, problems }
  let out = text
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end)
  return { ok: true, text: out, replaced, unchanged }
}

/** Shell syntax for a terminal's shell kind (the kinds in shared/terminal.ts). */
export const syntaxForShell = (kind: string | undefined): ShellSyntax => (kind === 'powershell' || kind === 'pwsh' ? 'powershell' : 'posix')
