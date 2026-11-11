// Small, dependency-free syntax highlighting for diff lines. Each line is tokenized on its own (a comment or string that spans lines
// is coloured only on the lines where it starts), which is enough to make a diff readable. Unknown file types are shown plain.

export type TokClass = 'kw' | 'str' | 'num' | 'com' | 'tag'
export type Tok = { text: string; cls?: TokClass }
export type Lang = 'clike' | 'hash' | 'json' | 'css' | 'markup' | 'sql' | 'markdown'

const EXT: Record<string, Lang> = {
  ts: 'clike', tsx: 'clike', js: 'clike', jsx: 'clike', mjs: 'clike', cjs: 'clike', mts: 'clike', java: 'clike', kt: 'clike', kts: 'clike', cs: 'clike', go: 'clike',
  rs: 'clike', c: 'clike', h: 'clike', cpp: 'clike', hpp: 'clike', cc: 'clike', swift: 'clike', scala: 'clike', php: 'clike', dart: 'clike', gradle: 'clike',
  py: 'hash', sh: 'hash', bash: 'hash', zsh: 'hash', ps1: 'hash', psm1: 'hash', rb: 'hash', yml: 'hash', yaml: 'hash', toml: 'hash', ini: 'hash', properties: 'hash', env: 'hash', dockerfile: 'hash',
  json: 'json', jsonc: 'json', css: 'css', scss: 'css', less: 'css', html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup', xaml: 'markup', vue: 'markup', pom: 'markup',
  sql: 'sql', md: 'markdown', markdown: 'markdown',
}

export function languageOf(path: string): Lang | null {
  const file = path.split(/[\\/]/).pop()!.toLowerCase()
  if (file === 'dockerfile' || file === 'makefile') return 'hash'
  const ext = file.includes('.') ? file.split('.').pop()! : ''
  return EXT[ext] ?? null
}

const KW = {
  clike: 'abstract|as|async|await|break|case|catch|class|const|continue|default|defer|delete|do|else|enum|export|extends|false|final|finally|fn|for|from|func|function|go|if|implements|import|in|instanceof|interface|let|match|mod|new|null|nil|of|override|package|private|protected|public|pub|return|static|struct|super|switch|this|throw|throws|trait|true|try|type|typeof|undefined|use|val|var|void|while|with|yield',
  hash: 'and|as|async|await|break|class|continue|def|del|elif|else|elsif|end|except|export|false|fi|finally|for|from|function|if|import|in|is|lambda|local|nil|none|not|null|or|pass|raise|return|then|true|try|while|with|yield|param|foreach|switch|begin|process|do|done|case|esac',
  json: 'true|false|null', css: 'important|inherit|initial|none|auto|var|calc', markup: '', markdown: '',
  sql: 'select|from|where|insert|into|values|update|set|delete|create|table|alter|drop|index|join|left|right|inner|outer|on|group|by|order|having|limit|and|or|not|null|as|distinct|union|primary|key|foreign|references|default|constraint',
} as const

const STR = '"(?:\\\\.|[^"\\\\])*"?|\'(?:\\\\.|[^\'\\\\])*\'?'
const NUM = '\\b0x[0-9a-fA-F]+\\b|\\b\\d+(?:\\.\\d+)?(?:px|em|rem|%|ms|s|vh|vw)?\\b'
const make = (comment: string, strings: string, extra = '') => (kw: string) => new RegExp(`(${comment})|(${strings})|(${NUM})${extra}${kw ? `|\\b(${kw})\\b` : ''}`, 'gi')
const RE: Record<Lang, RegExp> = {
  clike: make('//.*|/\\*.*?(?:\\*/|$)', `${STR}|\`(?:\\\\.|[^\`\\\\])*\`?`)(KW.clike),
  hash: make('#.*|--.*(?=$)', STR)(KW.hash),
  json: make('//.*', STR)(KW.json),
  css: make('/\\*.*?(?:\\*/|$)', STR, '|(@[\\w-]+|#[0-9a-fA-F]{3,8}\\b)')(KW.css),
  markup: make('<!--.*?(?:-->|$)', STR, '|(</?[\\w:.-]+|/?>)')(''),
  sql: make('--.*|/\\*.*?(?:\\*/|$)', STR)(KW.sql),
  markdown: make('<!--.*?(?:-->|$)', '`[^`]*`?')(''),
}

/** Splits one line into tokens. Concatenating the token texts always gives the line back. */
export function tokenize(line: string, lang: Lang | null): Tok[] {
  if (!lang || line.length > 2000) return [{ text: line }]
  if (lang === 'markdown' && /^#{1,6}\s/.test(line)) return [{ text: line, cls: 'kw' }]
  const re = new RegExp(RE[lang].source, 'gi')
  const out: Tok[] = []
  let last = 0
  for (const m of line.matchAll(re)) {
    if (m.index! > last) out.push({ text: line.slice(last, m.index) })
    const cls: TokClass = m[1] !== undefined ? 'com' : m[2] !== undefined ? 'str' : m[3] !== undefined ? 'num' : lang === 'markup' && m[4] !== undefined ? 'tag' : lang === 'css' && m[4] !== undefined ? 'kw' : 'kw'
    out.push({ text: m[0], cls })
    last = m.index! + m[0].length
    if (m[0].length === 0) break
  }
  if (last < line.length) out.push({ text: line.slice(last) })
  return out.length ? out : [{ text: line }]
}
