import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { Button, Dropdown, Icon, IconButton } from '../../third_party/summa-ui/src/ui'
import { useConfirm } from '../../third_party/summa-ui/src/presets'
import type { ShellOption, TerminalInfo, TerminalNote, TerminalOpenRequest, TerminalTarget } from '../shared/terminal'
import { api } from './api'

/** What the rest of the app can ask the dock to do. */
export type DockApi = {
  /** Opens a terminal for a target (a repository, a worktree folder, a runner) and shows the dock. */
  open: (req: TerminalOpenRequest) => Promise<void>
  toggle: () => void
}

const THEME = {
  background: '#1b1c1c', foreground: '#dcdedc', cursor: '#dcdedc', cursorAccent: '#1b1c1c', selectionBackground: '#3a3d3c',
  black: '#1b1c1c', red: '#ef7070', green: '#34c38f', yellow: '#d9b45b', blue: '#7aa2d6', magenta: '#b58fd1', cyan: '#6fc0bd', white: '#dcdedc',
  brightBlack: '#6f7473', brightRed: '#f58a8a', brightGreen: '#52d6a3', brightYellow: '#e6c776', brightBlue: '#95b8e3', brightMagenta: '#c9a8de', brightCyan: '#8fd3d0', brightWhite: '#f2f4f2',
}

type Live = { term: Terminal; fit: FitAddon; el: HTMLDivElement; replayed: boolean }

/**
 * The embedded terminal: a bottom panel with Terminal | Shell | New tab | Close. Sessions live in the main process, so
 * switching views never ends one; closing a tab whose shell still runs something asks first. Only the controls are drawn:
 * no instructions around the terminal.
 */
export function TerminalDock({ register, target, onNote }: {
  register: (d: DockApi) => void
  /** The target a New tab opens in when no tab is active: the selected repository. */
  target: TerminalTarget | null
  onNote: (n: TerminalNote[]) => void
}) {
  const [sessions, setSessions] = useState<TerminalInfo[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [visible, setVisible] = useState(false)
  const [height, setHeight] = useState(() => Number(localStorage.getItem('gm.dock.h')) || 320)
  const [shells, setShells] = useState<ShellOption[]>([])
  const [shellId, setShellId] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const confirm = useConfirm()
  const host = useRef<HTMLDivElement>(null)
  const live = useRef(new Map<string, Live>())
  const activeRef = useRef<string | null>(null)
  activeRef.current = active

  const refreshShells = useCallback(() => { void api.terminalShells().then(s => { setShells(s); setShellId(cur => cur || s.find(x => x.available)?.id || '') }) }, [])
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
      if (closed) { const l = live.current.get(closed); if (l) { l.term.dispose(); l.el.remove(); live.current.delete(closed) } setActive(a => (a === closed ? null : a)) }
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
    const term = new Terminal({ fontFamily: 'ui-monospace, "Cascadia Code", Consolas, Menlo, monospace', fontSize: 13, cursorBlink: true, scrollback: 5000, theme: THEME, allowProposedApi: false, convertEol: false })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    term.onData(d => { void api.terminalWrite(info.id, d) })
    term.onResize(({ cols, rows }) => { void api.terminalResize(info.id, cols, rows) })
    // Copy with Ctrl+Shift+C / Ctrl+Insert and paste with Ctrl+Shift+V, leaving Ctrl+C for the shell (interrupt).
    term.attachCustomKeyEventHandler(e => {
      if (e.type === 'keydown' && e.ctrlKey && e.shiftKey && e.code === 'KeyC') { void navigator.clipboard.writeText(term.getSelection()); return false }
      if (e.type === 'keydown' && e.ctrlKey && e.shiftKey && e.code === 'KeyV') { void navigator.clipboard.readText().then(t => { if (t) term.paste(t) }); return false }
      return true
    })
    l = { term, fit, el, replayed: false }
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

  useEffect(() => () => { for (const l of live.current.values()) l.term.dispose(); live.current.clear() }, [])

  const close = async (id: string) => {
    const r = await api.terminalClose(id, false)
    if (r.ok && !r.value.closed) {
      const yes = await confirm({ title: 'Close terminal?', description: r.value.reason, confirmLabel: 'Close terminal', destructive: true })
      if (yes) await api.terminalClose(id, true)
    }
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
    </section>
  )
}
