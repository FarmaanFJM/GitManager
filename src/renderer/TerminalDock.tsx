import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { Button, Dropdown, Icon, IconButton, Menu, MenuButton, useCopy } from '../../third_party/summa-ui/src/ui'
import { useConfirm, useToast } from '../../third_party/summa-ui/src/presets'
import { collectBlocks, formatBlocks, recordCommand, wholeBuffer, type Recorded } from './terminalBlocks'
import type { ShellOption, TerminalInfo, TerminalNote, TerminalOpenRequest, TerminalTarget } from '../shared/terminal'
import { syntaxForShell } from '../shared/placeholders'
import { xtermOptions, type TerminalPrefs } from '../shared/terminalPrefs'
import { TerminalController, type PendingPaste } from './terminalController'
import { PlaceholderDialog } from './PlaceholderDialog'
import { api } from './api'

/** What the rest of the app can ask the dock to do. */
export type DockApi = {
  /** Opens a terminal for a target (a repository, a worktree folder, a runner) and shows the dock. */
  open: (req: TerminalOpenRequest) => Promise<void>
  toggle: () => void
}

const THEME = {
  background: '#232424', foreground: '#dcdedc', cursor: '#dcdedc', cursorAccent: '#232424', selectionBackground: '#3f4141',
  black: '#232424', red: '#ef7070', green: '#34c38f', yellow: '#d9b45b', blue: '#7aa2d6', magenta: '#b58fd1', cyan: '#6fc0bd', white: '#dcdedc',
  brightBlack: '#6f7473', brightRed: '#f58a8a', brightGreen: '#52d6a3', brightYellow: '#e6c776', brightBlue: '#95b8e3', brightMagenta: '#c9a8de', brightCyan: '#8fd3d0', brightWhite: '#f2f4f2',
}

/** Before v1.0.2 Select to copy was a switch in this header, remembered in the browser; Settings now owns it. */
const LEGACY_SELECT_TO_COPY_KEY = 'gm.terminal.selectToCopy'

type Live = { term: Terminal; fit: FitAddon; el: HTMLDivElement; replayed: boolean; controller: TerminalController }

/**
 * The embedded terminal: a bottom panel with Terminal | Shell | New tab | Close. Sessions live in the main process, so
 * switching views never ends one; closing a tab whose shell still runs something asks first. Only the controls are drawn:
 * no instructions around the terminal.
 */
export function TerminalDock({ register, target, onNote, prefs, onPrefsChange }: {
  register: (d: DockApi) => void
  /** The target a New tab opens in when no tab is active: the selected repository. */
  target: TerminalTarget | null
  onNote: (n: TerminalNote[]) => void
  /** Terminal preferences from Settings; changes apply to open terminals at once. */
  prefs: TerminalPrefs
  /** Saves a preference the dock itself migrated (the old Select to copy switch). */
  onPrefsChange?: (p: TerminalPrefs) => void
}) {
  const [sessions, setSessions] = useState<TerminalInfo[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [visible, setVisible] = useState(false)
  const [height, setHeight] = useState(() => Number(localStorage.getItem('gm.dock.h')) || 320)
  const [shells, setShells] = useState<ShellOption[]>([])
  const [shellId, setShellId] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const confirm = useConfirm()
  const toast = useToast()
  const clipboard = useCopy()
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs
  const [pendingPaste, setPendingPaste] = useState<{ sessionId: string; paste: PendingPaste } | null>(null)
  const [ctxMenu, setCtxMenu] = useState<{ sessionId: string; x: number; y: number; items: ('copy' | 'paste')[] } | null>(null)
  const clipboardRef = useRef(clipboard)
  clipboardRef.current = clipboard
  const toastRef = useRef(toast)
  toastRef.current = toast
  const records = useRef(new Map<string, Recorded[]>())
  const host = useRef<HTMLDivElement>(null)
  const live = useRef(new Map<string, Live>())
  const activeRef = useRef<string | null>(null)
  activeRef.current = active
  const sessionsRef = useRef<TerminalInfo[]>([])
  sessionsRef.current = sessions

  const refreshShells = useCallback(() => {
    void api.terminalShells().then(s => {
      setShells(s)
      const wanted = prefsRef.current.defaultShell
      setShellId(cur => cur || s.find(x => x.available && x.id === wanted)?.id || s.find(x => x.available)?.id || '')
    })
  }, [])
  // A new default shell in Settings is what New tab uses from then on.
  useEffect(() => { const s = shells.find(x => x.available && x.id === prefs.defaultShell); if (s) setShellId(s.id) }, [prefs.defaultShell, shells])
  // The old header switch: carry an explicit "off" over to Settings once.
  useEffect(() => {
    try {
      const old = localStorage.getItem(LEGACY_SELECT_TO_COPY_KEY)
      if (old === null) return
      localStorage.removeItem(LEGACY_SELECT_TO_COPY_KEY)
      if (old === '0' && prefsRef.current.selectToCopy) onPrefsChange?.({ ...prefsRef.current, selectToCopy: false })
    } catch { /* storage unavailable: the default stays */ }
  }, [onPrefsChange])
  useEffect(() => { refreshShells(); void api.terminalList().then(l => { setSessions(l); if (l.length) { setActive(l[0].id) } }) }, [refreshShells])

  const open = useCallback(async (req: TerminalOpenRequest) => {
    setError(null)
    const r = await api.terminalOpen(req)
    if (!r.ok) { setError(r.error.message); setVisible(true); return }
    setSessions(s => (s.some(x => x.id === r.value.info.id) ? s : [...s, r.value.info]))
    setActive(r.value.info.id)
    setVisible(true)
    if (r.value.notes.length) onNote(r.value.notes)
  }, [onNote])

  useEffect(() => { register({ open, toggle: () => setVisible(v => !v) }) }, [register, open])

  useEffect(() => {
    const offList = api.on('terminal-changed', ({ info, closed }) => {
      setSessions(s => {
        if (closed) return s.filter(x => x.id !== closed)
        if (!info) return s
        return s.some(x => x.id === info.id) ? s.map(x => (x.id === info.id ? info : x)) : [...s, info]
      })
      if (closed) { records.current.delete(closed); const l = live.current.get(closed); if (l) { l.term.dispose(); l.el.remove(); live.current.delete(closed) } setActive(a => (a === closed ? null : a)) }
    })
    const offData = api.on('terminal-data', ({ id, data }) => { live.current.get(id)?.term.write(data) })
    return () => { offList(); offData() }
  }, [])

  // Make sure the active tab always points at an existing session.
  useEffect(() => { if (!sessions.find(s => s.id === active)) setActive(sessions[0]?.id ?? null) }, [sessions, active])

  // One xterm instance per session, kept alive while the session exists so scrollback survives switching tabs.
  const ensure = useCallback((info: TerminalInfo): Live | null => {
    const container = host.current
    if (!container) return null
    let l = live.current.get(info.id)
    if (l) return l
    const el = document.createElement('div')
    el.className = 'gm-term-pane'
    el.dataset.session = info.id
    container.appendChild(el)
    const term = new Terminal({ ...xtermOptions(prefsRef.current), theme: THEME, allowProposedApi: false, convertEol: false })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    const controller = new TerminalController({
      term, prefs: () => prefsRef.current, syntax: () => syntaxForShell(sessionsRef.current.find(x => x.id === info.id)?.shell.kind),
      readClipboard: () => api.clipboardRead(), writeClipboard: t => clipboardRef.current.copy(t),
      ask: p => setPendingPaste({ sessionId: info.id, paste: p }),
      menu: (at, items) => setCtxMenu({ sessionId: info.id, x: at.x, y: at.y, items }),
      notify: (k, m) => (k === 'error' ? toastRef.current.error(m) : toastRef.current.info(m)),
    })
    // Select to copy: a selection made with the left button is copied when the button is released (not while dragging, not for
    // programmatic selections or output changes). The selection stays highlighted; focus returns to the terminal.
    el.addEventListener('mousedown', e => {
      if (e.button !== 0) return
      const up = () => { document.removeEventListener('mouseup', up, true); window.setTimeout(() => { void controller.selectionReleased() }, 0) }
      document.addEventListener('mouseup', up, true)
    })
    // Right-click pastes, or opens the small Copy / Paste menu over a selection (see contextAction).
    el.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); controller.contextMenu({ x: e.clientX, y: e.clientY }) })
    // Anything the browser pastes on its own (the system menu, middle click) goes through the same inspection as the keyboard.
    el.addEventListener('paste', e => { e.preventDefault(); e.stopPropagation(); controller.paste(e.clipboardData?.getData('text/plain') ?? '') }, true)
    term.onData(d => {
      // Enter marks the start of an output: remember which line the command is on (the text is read back from the buffer when copying).
      if (d === '\r') { const r = recordCommand(term); const list = records.current.get(info.id) ?? []; list.push(r); records.current.set(info.id, list.slice(-500)) }
      void api.terminalWrite(info.id, d)
    })
    term.onResize(({ cols, rows }) => { void api.terminalResize(info.id, cols, rows) })
    // Ctrl+V, Shift+Insert and Ctrl+Shift+V paste; Ctrl+Shift+C and Ctrl+Insert copy; Ctrl+C stays the interrupt.
    term.attachCustomKeyEventHandler(e => controller.key(e))
    l = { term, fit, el, replayed: false, controller }
    live.current.set(info.id, l)
    void api.terminalReplay(info.id).then(text => { if (text) term.write(text); l!.replayed = true })
    return l
  }, [])

  useEffect(() => {
    for (const s of sessions) ensure(s)
    for (const [id, l] of live.current) l.el.style.display = id === active && visible ? 'block' : 'none'
    const cur = active ? live.current.get(active) : null
    if (cur && visible) { requestAnimationFrame(() => { try { cur.fit.fit() } catch { /* not laid out yet */ } cur.term.focus() }) }
  }, [sessions, active, visible, ensure])

  useEffect(() => {
    const el = host.current
    if (!el) return
    const ro = new ResizeObserver(() => { const l = activeRef.current ? live.current.get(activeRef.current) : null; if (l) { try { l.fit.fit() } catch { /* hidden */ } } })
    ro.observe(el)
    return () => ro.disconnect()
  }, [visible])

  // Appearance changes made in Settings reach terminals that are already open.
  useEffect(() => {
    const o = xtermOptions(prefs)
    for (const l of live.current.values()) {
      const t = l.term.options
      if (t.fontFamily !== o.fontFamily) t.fontFamily = o.fontFamily
      if (t.fontSize !== o.fontSize) t.fontSize = o.fontSize
      if (t.lineHeight !== o.lineHeight) t.lineHeight = o.lineHeight
      if (t.cursorStyle !== o.cursorStyle) t.cursorStyle = o.cursorStyle
      if (t.cursorBlink !== o.cursorBlink) t.cursorBlink = o.cursorBlink
      if (t.scrollback !== o.scrollback) t.scrollback = o.scrollback
      requestAnimationFrame(() => { try { l.fit.fit() } catch { /* hidden */ } })
    }
  }, [prefs])

  useEffect(() => () => { for (const l of live.current.values()) l.term.dispose(); live.current.clear() }, [])

  const close = async (id: string) => {
    const r = await api.terminalClose(id, false)
    if (r.ok && !r.value.closed) {
      const yes = await confirm({ title: 'Close terminal?', description: r.value.reason, confirmLabel: 'Close terminal', destructive: true })
      if (yes) await api.terminalClose(id, true)
    }
  }

  /** Copies what the active terminal showed: the last command with its output, every command with its output, or the whole buffer. */
  const copyOutput = async (what: 'last' | 'all' | 'everything') => {
    const l = active ? live.current.get(active) : null
    if (!l) return
    const blocks = collectBlocks(l.term, records.current.get(active!) ?? [])
    const text = what === 'everything' ? wholeBuffer(l.term) : formatBlocks(what === 'last' ? blocks.slice(-1) : blocks)
    if (!text.trim()) { toast.info(what === 'everything' ? 'Nothing to copy' : 'No commands yet'); return }
    if (await clipboard.copy(text)) toast.success('Copied'); else toast.error('Could not copy')
  }

  const newTab = () => {
    const cur = sessions.find(s => s.id === active)
    const t = cur?.target ?? target
    if (!t) { setError('Select a repository first.'); setVisible(true); return }
    void open({ target: t, shellId: shellId || undefined })
  }

  const drag = (e: React.PointerEvent) => {
    e.preventDefault()
    const startY = e.clientY, startH = height
    const move = (ev: PointerEvent) => setHeight(Math.max(140, Math.min(window.innerHeight - 160, startH + (startY - ev.clientY))))
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); setHeight(h => { localStorage.setItem('gm.dock.h', String(h)); return h }) }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }

  const current = useMemo(() => sessions.find(s => s.id === active) ?? null, [sessions, active])
  const options = useMemo(() => shells.filter(s => s.available).map(s => ({ value: s.id, label: s.label })), [shells])

  if (!visible && sessions.length === 0) return null
  if (!visible) return (
    <div className="gm-dock-bar" role="region" aria-label="Terminal">
      <Button variant="ghost" icon="terminal" onClick={() => setVisible(true)}>Terminal {sessions.length}</Button>
    </div>
  )

  return (
    <section className="gm-dock" style={{ height }} aria-label="Terminal">
      <div className="gm-dock-grip" onPointerDown={drag} role="separator" aria-orientation="horizontal" aria-label="Resize terminal" />
      <div className="gm-dock-head">
        <div role="tablist" aria-label="Terminals" className="gm-dock-tabs">
          {sessions.map(s => (
            <span key={s.id} className="gm-dock-tab" data-active={s.id === active || undefined}>
              <button type="button" role="tab" aria-selected={s.id === active} className="gm-dock-tab-btn" onClick={() => setActive(s.id)} title={`${s.cwd} · ${s.shell.label}`}>
                <span className={`gm-dot gm-dot-${s.state === 'running' ? 'running' : 'stopped'}`} aria-hidden="true" />
                <span className="truncate">{s.title}</span>
                {s.state === 'exited' && <span className="faint">exited</span>}
              </button>
              <IconButton icon="x" size="sm" label={`Close ${s.title}`} onClick={() => void close(s.id)} />
            </span>
          ))}
        </div>
        <span className="grow" />
        {current && <MenuButton icon="copy" size="sm" label="Copy output" items={[
          { label: 'Last command and output', icon: 'copy', onSelect: () => void copyOutput('last') },
          { label: 'All commands and outputs', icon: 'copy', onSelect: () => void copyOutput('all') },
          { type: 'sep' },
          { label: 'Everything in the terminal', icon: 'copy', onSelect: () => void copyOutput('everything') },
        ]} />}
        {options.length > 0 && <Dropdown label="Shell" quiet width={220} value={shellId || null} options={options} onChange={setShellId} />}
        <IconButton icon="plus" size="sm" label="New tab" onClick={newTab} />
        <IconButton icon="chevron-down" size="sm" label="Hide terminal" onClick={() => setVisible(false)} />
      </div>
      {error && <p className="gm-dock-error" role="alert"><Icon name="circle-alert" size={14} />{error}</p>}
      {current?.state === 'exited' && (
        <div className="gm-dock-exit" role="status">
          <span>Exited{current.exitCode !== null ? ` ${current.exitCode}` : ''}</span>
          {current.target && <Button variant="ghost" onClick={() => void open({ target: current.target!, shellId: current.shell.id })}>Reopen</Button>}
          <Button variant="ghost" onClick={() => void close(current.id)}>Close</Button>
        </div>
      )}
      <div ref={host} className="gm-term-host" />
      <PlaceholderDialog pending={pendingPaste?.paste ?? null} onResolve={(p, choice) => { const l = pendingPaste ? live.current.get(pendingPaste.sessionId) : null; setPendingPaste(null); l?.controller.resolvePaste(p, choice) }} />
      <Menu anchor={ctxMenu ? { x: ctxMenu.x, y: ctxMenu.y } : null} open={!!ctxMenu} onClose={() => { const l = ctxMenu ? live.current.get(ctxMenu.sessionId) : null; setCtxMenu(null); l?.term.focus() }} label="Terminal"
        items={(ctxMenu?.items ?? []).map(i => i === 'copy'
          ? { label: 'Copy', icon: 'copy' as const, shortcut: 'Ctrl Shift C', onSelect: () => void live.current.get(ctxMenu!.sessionId)?.controller.choose('copy') }
          : { label: 'Paste', icon: 'clipboard' as const, shortcut: 'Ctrl V', onSelect: () => void live.current.get(ctxMenu!.sessionId)?.controller.choose('paste') })} />
    </section>
  )
}
