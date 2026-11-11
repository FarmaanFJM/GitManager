// Terminal preferences: one definition shared by the main process (validation, persistence) and the renderer (xterm options).
// Type and pure functions only.

export type CursorStyle = 'block' | 'underline' | 'bar'

export type TerminalPrefs = {
  /** 'auto' (the folder's own shell, as before) or a ShellOption id: 'powershell', 'pwsh', 'posix' or 'wsl:<distro>'. */
  defaultShell: string
  /** '' selects the built-in monospace stack; otherwise the name of one monospace font. */
  fontFamily: string
  fontSize: number
  lineHeight: number
  cursorStyle: CursorStyle
  cursorBlink: boolean
  scrollback: number
  /** Copy the selection when the mouse button is released. */
  selectToCopy: boolean
  /** Right-clicking a selection offers Copy. */
  contextMenuCopy: boolean
  /** Right-clicking without a selection pastes; with a selection the menu offers Paste. */
  rightClickPaste: boolean
}

export const TERMINAL_PREF_LIMITS = {
  fontSize: { min: 8, max: 32 },
  lineHeight: { min: 1, max: 2 },
  scrollback: { min: 100, max: 100_000 },
} as const

export const DEFAULT_TERMINAL_PREFS: TerminalPrefs = {
  defaultShell: 'auto', fontFamily: '', fontSize: 13, lineHeight: 1, cursorStyle: 'block', cursorBlink: true, scrollback: 5000,
  selectToCopy: true, contextMenuCopy: true, rightClickPaste: true,
}

/** The stack used when no font is chosen (what the terminal used before preferences existed). */
export const DEFAULT_FONT_STACK = 'ui-monospace, "Cascadia Code", Consolas, Menlo, monospace'

/** Monospace fonts GitManager offers when they are installed. A font outside this list is refused, so the value can never carry CSS. */
export const MONOSPACE_CANDIDATES = [
  'Cascadia Code', 'Cascadia Mono', 'Consolas', 'Lucida Console', 'Courier New', 'JetBrains Mono', 'Fira Code', 'Fira Mono', 'Source Code Pro',
  'Hack', 'IBM Plex Mono', 'Roboto Mono', 'Ubuntu Mono', 'DejaVu Sans Mono', 'Liberation Mono', 'Noto Sans Mono', 'Menlo', 'Monaco', 'SF Mono',
] as const

const SHELL_ID = /^(auto|powershell|pwsh|posix|wsl:[A-Za-z0-9._ -]{1,64})$/

/** What can be stored for an unvalidated value: out-of-range numbers are clamped, anything else falls back to its default. */
export function sanitizeTerminalPrefs(raw: unknown): TerminalPrefs {
  const d = DEFAULT_TERMINAL_PREFS
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const num = (x: unknown, min: number, max: number, fallback: number, digits = 2) => {
    const n = typeof x === 'number' ? x : Number.NaN
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Number(n.toFixed(digits)))) : fallback
  }
  const bool = (x: unknown, fallback: boolean) => (typeof x === 'boolean' ? x : fallback)
  const L = TERMINAL_PREF_LIMITS
  return {
    defaultShell: typeof o.defaultShell === 'string' && SHELL_ID.test(o.defaultShell) ? o.defaultShell : d.defaultShell,
    fontFamily: typeof o.fontFamily === 'string' && (MONOSPACE_CANDIDATES as readonly string[]).includes(o.fontFamily) ? o.fontFamily : d.fontFamily,
    fontSize: Math.round(num(o.fontSize, L.fontSize.min, L.fontSize.max, d.fontSize, 0)),
    lineHeight: num(o.lineHeight, L.lineHeight.min, L.lineHeight.max, d.lineHeight),
    cursorStyle: o.cursorStyle === 'underline' || o.cursorStyle === 'bar' || o.cursorStyle === 'block' ? o.cursorStyle : d.cursorStyle,
    cursorBlink: bool(o.cursorBlink, d.cursorBlink),
    scrollback: Math.round(num(o.scrollback, L.scrollback.min, L.scrollback.max, d.scrollback, 0)),
    selectToCopy: bool(o.selectToCopy, d.selectToCopy),
    contextMenuCopy: bool(o.contextMenuCopy, d.contextMenuCopy),
    rightClickPaste: bool(o.rightClickPaste, d.rightClickPaste),
  }
}

/** Strict version for user input: the first unsupported value is named, so Settings can say what to fix. */
export function validateTerminalPrefs(raw: unknown): { ok: true; prefs: TerminalPrefs } | { ok: false; message: string } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, message: 'Terminal settings are invalid.' }
  const o = raw as Record<string, unknown>
  const L = TERMINAL_PREF_LIMITS
  const range = (key: keyof typeof L, label: string) => {
    const n = o[key]
    return typeof n === 'number' && Number.isFinite(n) && n >= L[key].min && n <= L[key].max ? null : `${label} must be between ${L[key].min} and ${L[key].max}.`
  }
  const problems = [
    typeof o.defaultShell === 'string' && SHELL_ID.test(o.defaultShell) ? null : 'The default shell is not supported.',
    typeof o.fontFamily === 'string' && (o.fontFamily === '' || (MONOSPACE_CANDIDATES as readonly string[]).includes(o.fontFamily)) ? null : 'That font is not a supported monospace font.',
    range('fontSize', 'Font size'), range('lineHeight', 'Line height'), range('scrollback', 'Scrollback'),
    o.cursorStyle === 'block' || o.cursorStyle === 'underline' || o.cursorStyle === 'bar' ? null : 'The cursor style is not supported.',
    ['cursorBlink', 'selectToCopy', 'contextMenuCopy', 'rightClickPaste'].every(k => typeof o[k] === 'boolean') ? null : 'A terminal switch is invalid.',
  ].filter((x): x is string => x !== null)
  return problems.length ? { ok: false, message: problems[0] } : { ok: true, prefs: sanitizeTerminalPrefs(o) }
}

/** The xterm.js options for a set of preferences. */
export function xtermOptions(p: TerminalPrefs) {
  return {
    fontFamily: p.fontFamily ? `"${p.fontFamily}", ${DEFAULT_FONT_STACK}` : DEFAULT_FONT_STACK,
    fontSize: p.fontSize, lineHeight: p.lineHeight, cursorStyle: p.cursorStyle, cursorBlink: p.cursorBlink, scrollback: p.scrollback,
  }
}

/** Fonts from the candidate list that are installed, judged by `width(font)` against the generic monospace and serif widths. */
export function installedFonts(width: (family: string) => number, candidates: readonly string[] = MONOSPACE_CANDIDATES): string[] {
  const base = [width('monospace'), width('serif')]
  const probe = (f: string) => [width(`"${f}", monospace`), width(`"${f}", serif`)]
  return candidates.filter(f => { const [a, b] = probe(f); return a !== base[0] || b !== base[1] })
}

export type ContextAction = { kind: 'paste' } | { kind: 'menu'; items: ('copy' | 'paste')[] } | { kind: 'none' }

/** What a right-click in the terminal does. Pure so the behaviour is tested without a window. */
export function contextAction(p: Pick<TerminalPrefs, 'contextMenuCopy' | 'rightClickPaste'>, hasSelection: boolean): ContextAction {
  if (!hasSelection) return p.rightClickPaste ? { kind: 'paste' } : { kind: 'none' }
  const items: ('copy' | 'paste')[] = [...(p.contextMenuCopy ? ['copy' as const] : []), ...(p.rightClickPaste ? ['paste' as const] : [])]
  return items.length ? { kind: 'menu', items } : { kind: 'none' }
}
