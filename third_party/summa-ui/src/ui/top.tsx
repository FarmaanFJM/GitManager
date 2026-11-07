/*
  TOP primitives: "Show only the information the user needs at the moment they need it" (docs/TOP.md).
  Additive: this file adds components and changes nothing that already exists in ./index.tsx.
  Styles live in src/styles/top.css, which a consumer imports after base.css.
  No em dashes in any copy here (P13).
*/
import {
  cloneElement, isValidElement, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  type ReactElement, type ReactNode, type Ref,
} from 'react'
import { createPortal } from 'react-dom'
import { Button, IconButton, Menu, MenuButton, useContextMenu, type Anchor, type MenuEntry } from './index'
import { Icon, type IconName } from './icons'

const cx = (...a: Array<string | false | null | undefined>) => a.filter(Boolean).join(' ')
const dev = typeof import.meta !== 'undefined' && (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV === true

/* ------------------------------------------------------------------ useCopy / CopyButton */
/** Clipboard with a fallback for insecure contexts and older webviews. `copied` is true for `resetMs` after a success. */
export function useCopy(resetMs = 1600) {
  const [copied, setCopied] = useState(false)
  const timer = useRef(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const copy = useCallback(async (text: string) => {
    let ok = false
    try {
      if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); ok = true }
    } catch { /* fall through to the legacy path */ }
    if (!ok) {
      const ta = document.createElement('textarea')
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0'
      document.body.appendChild(ta); ta.select()
      try { ok = document.execCommand('copy') } catch { ok = false }
      ta.remove()
    }
    if (ok) {
      setCopied(true)
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setCopied(false), resetMs)
    }
    return ok
  }, [resetMs])
  return { copy, copied }
}

/** Icon button that copies `value`. The label announces the result; the full value is always what is copied. */
export function CopyButton({ value, label = 'Copy', copiedLabel = 'Copied', size = 'sm', className = '', onCopied }:
  { value: string | (() => string); label?: string; copiedLabel?: string; size?: 'md' | 'sm'; className?: string; onCopied?: (ok: boolean) => void }) {
  const { copy, copied } = useCopy()
  return (
    <>
      <IconButton icon={copied ? 'check' : 'copy'} label={copied ? copiedLabel : label} size={size} className={cx('top-copy', className)}
        onClick={async () => onCopied?.(await copy(typeof value === 'function' ? value() : value))} />
      <span className="sr-only" role="status" aria-live="polite">{copied ? copiedLabel : ''}</span>
    </>
  )
}

/* ------------------------------------------------------------------ Tooltip */
export type TooltipSide = 'top' | 'bottom'

function setRef<T>(ref: Ref<T> | undefined, node: T | null) {
  if (typeof ref === 'function') ref(node)
  else if (ref && typeof ref === 'object') (ref as { current: T | null }).current = node
}

/**
 * One short sentence for one control. Opens on deliberate mouse hover (after `delay`) or keyboard focus,
 * closes on Escape, blur, leave and scroll. Never opens on touch, never persists, never holds the only copy of
 * a destructive consequence (put that in the confirmation dialog).
 * Wrap exactly one focusable element. The tooltip is a description (aria-describedby), not the name: keep an
 * accessible name on the control. The native `title` is removed so the two never stack.
 */
export function Tooltip({ content, children, delay = 500, focusDelay = 150, side = 'bottom', disabled }:
  { content: string; children: ReactElement<Record<string, unknown>>; delay?: number; focusDelay?: number; side?: TooltipSide; disabled?: boolean }) {
  const id = useId()
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [open, setOpen] = useState(false)
  const timer = useRef(0)
  const tip = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const childProps = children.props as Record<string, unknown> & { ref?: Ref<HTMLElement> }

  if (dev) {
    if (content.length > 90 || /[.!?]\s+\S/.test(content)) console.warn('[Tooltip] keep it to one short sentence:', content)
    if (childProps['aria-label'] === content) console.warn('[Tooltip] do not repeat the control label:', content)
  }

  const clear = () => window.clearTimeout(timer.current)
  const show = (ms: number) => { if (disabled) return; clear(); timer.current = window.setTimeout(() => setOpen(true), ms) }
  const hide = (ms = 0) => { clear(); if (ms) timer.current = window.setTimeout(() => setOpen(false), ms); else setOpen(false) }
  useEffect(() => clear, [])
  useEffect(() => { if (disabled) hide() }, [disabled])

  useLayoutEffect(() => {
    if (!open || !anchor || !tip.current) { setPos(null); return }
    const place = () => {
      const t = tip.current; if (!t) return
      const r = anchor.getBoundingClientRect()
      const w = t.offsetWidth, h = t.offsetHeight, vw = window.innerWidth, vh = window.innerHeight
      let top = side === 'top' ? r.top - h - 6 : r.bottom + 6
      if (side === 'bottom' && top + h > vh - 8 && r.top - h - 6 > 8) top = r.top - h - 6 // flip up
      if (side === 'top' && top < 8) top = r.bottom + 6 // flip down
      const left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, vw - w - 8))
      setPos({ left, top })
    }
    place()
    window.addEventListener('resize', place)
    const onScroll = () => hide()
    window.addEventListener('scroll', onScroll, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', onScroll, true) }
  }, [open, anchor, side])

  useEffect(() => {
    if (!open) return
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); hide() } }
    document.addEventListener('keydown', key, true)
    return () => document.removeEventListener('keydown', key, true)
  }, [open])

  if (!isValidElement(children)) return children
  const call = (name: string, e: unknown) => { const f = childProps[name]; if (typeof f === 'function') (f as (e: unknown) => void)(e) }

  const el = cloneElement(children, {
    ref: (node: HTMLElement | null) => { setAnchor(node); setRef(childProps.ref, node) },
    title: undefined,
    'aria-describedby': open ? [childProps['aria-describedby'], id].filter(Boolean).join(' ') : childProps['aria-describedby'],
    onPointerEnter: (e: React.PointerEvent) => { call('onPointerEnter', e); if (e.pointerType !== 'touch') show(delay) },
    onPointerLeave: (e: React.PointerEvent) => { call('onPointerLeave', e); hide(80) },
    onPointerDown: (e: React.PointerEvent) => { call('onPointerDown', e); hide() }, // pressing is acting, not asking
    onFocus: (e: React.FocusEvent<HTMLElement>) => { call('onFocus', e); if (e.currentTarget.matches(':focus-visible')) show(focusDelay) },
    onBlur: (e: React.FocusEvent) => { call('onBlur', e); hide() },
  })

  return (
    <>
      {el}
      {open && createPortal(
        <div ref={tip} id={id} role="tooltip" className="top-tooltip"
          style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
          onPointerEnter={clear} onPointerLeave={() => hide(80)}>
          {content}
        </div>,
        document.body,
      )}
    </>
  )
}

/* ------------------------------------------------------------------ StatusIndicator */
export type StatusState = 'neutral' | 'running' | 'ready' | 'stopped' | 'failed' | 'warn'
const STATUS_WORD: Record<StatusState, string> = { neutral: 'Idle', running: 'Running', ready: 'Ready', stopped: 'Stopped', failed: 'Failed', warn: 'Warning' }

/** A small mark plus a word. The word is always rendered: state is never conveyed by colour alone. Prefer short words ("Synced", "3 changed files"). */
export function StatusIndicator({ state = 'neutral', label, className = '' }: { state?: StatusState; label?: string; className?: string }) {
  return (
    <span className={cx('top-status', className)} data-state={state}>
      {state === 'running'
        ? <span className="top-status__mark top-status__spin" aria-hidden="true" />
        : <span className="top-status__mark" aria-hidden="true" />}
      <span className="top-status__word">{label ?? STATUS_WORD[state]}</span>
    </span>
  )
}

/* ------------------------------------------------------------------ InlineAlert */
export type AlertTone = 'error' | 'warn' | 'info'
const ALERT_ICON: Record<AlertTone, IconName> = { error: 'circle-x', warn: 'triangle-alert', info: 'info' }

/** One concise line with an optional action. role="alert" only for errors; other tones are a polite status. */
export function InlineAlert({ tone = 'info', children, action, className = '' }:
  { tone?: AlertTone; children: ReactNode; action?: { label: string; onClick: () => void }; className?: string }) {
  return (
    <div className={cx('top-alert', className)} data-tone={tone} role={tone === 'error' ? 'alert' : 'status'}>
      <Icon name={ALERT_ICON[tone]} size={15} />
      <span className="top-alert__text">{children}</span>
      {action && <Button variant="ghost" className="top-alert__action" onClick={action.onClick}>{action.label}</Button>}
    </div>
  )
}

/* ------------------------------------------------------------------ Details / DetailPanel */
/** Technical details behind a disclosure button. Closed by default. The content mounts only when opened. */
export function Details({ label = 'Details', children, defaultOpen = false, open: controlled, onOpenChange, className = '' }:
  { label?: string; children: ReactNode; defaultOpen?: boolean; open?: boolean; onOpenChange?: (open: boolean) => void; className?: string }) {
  const [inner, setInner] = useState(defaultOpen)
  const open = controlled ?? inner
  const id = useId()
  const toggle = () => { const n = !open; if (controlled === undefined) setInner(n); onOpenChange?.(n) }
  return (
    <div className={cx('top-details', className)}>
      <button type="button" className="top-details__toggle" aria-expanded={open} aria-controls={open ? id : undefined} onClick={toggle}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
        <span>{label}</span>
      </button>
      {open && <div id={id} className="top-details__body">{children}</div>}
    </div>
  )
}

/**
 * Contextual detail surface. It REPLACES the content of the main region (render it instead of the list) or fills
 * the region it is placed in. It is not a navigation sidebar and must not be placed beside one (P14).
 * Focus moves to the panel when it appears and returns to the opener when it is removed. Escape calls `onBack`.
 */
export function DetailPanel({ title, onBack, backLabel = 'Back', actions, children, className = '', autoFocus = true }:
  { title: string; onBack?: () => void; backLabel?: string; actions?: ReactNode; children: ReactNode; className?: string; autoFocus?: boolean }) {
  const ref = useRef<HTMLElement>(null)
  const titleId = useId()
  useEffect(() => {
    if (!autoFocus) return
    const prev = document.activeElement as HTMLElement | null
    ref.current?.focus({ preventScroll: true })
    return () => { if (prev?.isConnected) prev.focus({ preventScroll: true }) }
  }, [autoFocus])
  return (
    <section ref={ref} tabIndex={-1} aria-labelledby={titleId} className={cx('top-panel', className)}
      onKeyDown={e => { if (e.key === 'Escape' && onBack && !e.defaultPrevented) { e.stopPropagation(); onBack() } }}>
      <header className="top-panel__head">
        {onBack && <IconButton icon="chevron-left" label={backLabel} onClick={onBack} />}
        <h2 id={titleId} className="top-panel__title truncate">{title}</h2>
        {actions && <div className="top-panel__actions">{actions}</div>}
      </header>
      <div className="top-panel__body scroll">{children}</div>
    </section>
  )
}

/* ------------------------------------------------------------------ ActionRow */
/**
 * Compact actionable row: name, one status slot, one primary action, overflow menu.
 * The menu opens from the "..." button, from a right click or long press, and from the ContextMenu key or Shift+F10.
 * Enter on the row calls `onOpen`. Secondary actions belong in `menu`, not as more buttons.
 */
export function ActionRow({ name, status, action, menu, menuLabel = 'More actions', onOpen, selected, label, className = '' }:
  { name: ReactNode; status?: ReactNode; action?: ReactNode; menu?: MenuEntry[]; menuLabel?: string; onOpen?: () => void; selected?: boolean; label?: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const cm = useContextMenu()
  const viaKeyboard = useRef(false)
  const { onContextMenu: _ignored, ...bind } = cm.bind
  void _ignored
  const items = menu ?? []

  const openFromKeyboard = () => {
    const r = ref.current?.getBoundingClientRect(); if (!r) return
    viaKeyboard.current = true
    cm.openAt(r.left + 24, r.top + r.height / 2)
  }
  const close = () => { cm.close(); if (viaKeyboard.current) { viaKeyboard.current = false; ref.current?.focus() } }

  return (
    <div
      ref={ref} role="group" aria-label={label} tabIndex={0} data-selected={selected || undefined}
      className={cx('top-row', className)}
      {...bind}
      onContextMenu={e => {
        if (!items.length) return
        e.preventDefault()
        if (e.clientX === 0 && e.clientY === 0) openFromKeyboard() // keyboard-initiated contextmenu events carry no pointer position
        else { viaKeyboard.current = false; cm.openAt(e.clientX, e.clientY) }
      }}
      onKeyDown={e => {
        if (e.target !== e.currentTarget) return
        if (items.length && (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) { e.preventDefault(); openFromKeyboard() }
        else if (e.key === 'Enter' && onOpen) { e.preventDefault(); onOpen() }
      }}
      onDoubleClick={onOpen}
    >
      <div className="top-row__name truncate">{name}</div>
      {status && <div className="top-row__status">{status}</div>}
      {action && <div className="top-row__action">{action}</div>}
      {items.length > 0 && <MenuButton label={menuLabel} items={items} size="sm" className="top-row__menu" />}
      {items.length > 0 && <Menu anchor={cm.point as Anchor} open={cm.open} onClose={close} items={items} label={menuLabel} placement="bottom-start" />}
    </div>
  )
}

/* ------------------------------------------------------------------ SecretValue / useRevealAll */
/** Controls for a set of secrets: Show all, Hide all, and per-item state. Pass the ids of the secrets on screen. */
export function useRevealAll(ids: string[]) {
  const [shown, setShown] = useState<Record<string, boolean>>({})
  const key = ids.join('\u0000')
  const isRevealed = useCallback((id: string) => !!shown[id], [shown])
  const set = useCallback((id: string, v: boolean) => setShown(s => ({ ...s, [id]: v })), [])
  const toggle = useCallback((id: string) => setShown(s => ({ ...s, [id]: !s[id] })), [])
  const showAll = useCallback(() => setShown(Object.fromEntries(ids.map(i => [i, true]))), [key]) // eslint-disable-line react-hooks/exhaustive-deps
  const hideAll = useCallback(() => setShown({}), [])
  const count = ids.filter(i => shown[i]).length
  return useMemo(() => ({ isRevealed, set, toggle, showAll, hideAll, allRevealed: ids.length > 0 && count === ids.length, anyRevealed: count > 0 }),
    [isRevealed, set, toggle, showAll, hideAll, count, key]) // eslint-disable-line react-hooks/exhaustive-deps
}
export type RevealAll = ReturnType<typeof useRevealAll>

/** One button that flips between "Show all" and "Hide all" for a useRevealAll set. */
export function SecretToggleAll({ controls, className = '', showLabel = 'Show all', hideLabel = 'Hide all' }:
  { controls: RevealAll; className?: string; showLabel?: string; hideLabel?: string }) {
  const all = controls.allRevealed
  return <Button variant="ghost" icon={all ? 'eye-off' : 'eye'} className={className} onClick={all ? controls.hideAll : controls.showAll}>{all ? hideLabel : showLabel}</Button>
}

/**
 * A value hidden by default behind a fixed-length mask (the mask does not leak the length). Reveal/Hide and Copy are
 * buttons with accessible names. The value is never truncated and never masked permanently: revealed, it wraps.
 * Controlled (`revealed` + `onRevealedChange`) or uncontrolled (`defaultRevealed`).
 */
export function SecretValue({ value, label, revealed: controlled, defaultRevealed = false, onRevealedChange, className = '' }:
  { value: string; label: string; revealed?: boolean; defaultRevealed?: boolean; onRevealedChange?: (v: boolean) => void; className?: string }) {
  const [inner, setInner] = useState(defaultRevealed)
  const revealed = controlled ?? inner
  const flip = () => { const n = !revealed; if (controlled === undefined) setInner(n); onRevealedChange?.(n) }
  return (
    <span className={cx('top-secret', className)} data-revealed={revealed}>
      <code className="top-secret__value">
        {revealed ? value : <><span aria-hidden="true">••••••••••</span><span className="sr-only">{label} hidden</span></>}
      </code>
      <IconButton icon={revealed ? 'eye-off' : 'eye'} label={`${revealed ? 'Hide' : 'Reveal'} ${label}`} size="sm" onClick={flip} />
      <CopyButton value={value} label={`Copy ${label}`} />
    </span>
  )
}

/* ------------------------------------------------------------------ LogViewer / TerminalFrame */
export type LogLine = string | { text: string; level?: 'error' | 'warn' }
const lineText = (l: LogLine) => (typeof l === 'string' ? l : l.text)

/**
 * Monospace log on an --s2 surface (P02: one step lighter than the --s1 panel it sits in). Follows new lines until
 * the user scrolls up; "Jump to latest" resumes. role="log" with aria-live off, so a busy log does not flood a screen reader.
 */
export function LogViewer({ lines, label = 'Log', follow: followProp = true, searchable, height = 240, className = '', copyLabel = 'Copy log', emptyLabel = 'No output yet' }:
  { lines: LogLine[]; label?: string; follow?: boolean; searchable?: boolean; height?: number | string; className?: string; copyLabel?: string; emptyLabel?: string }) {
  const body = useRef<HTMLDivElement>(null)
  const [following, setFollowing] = useState(followProp)
  const [q, setQ] = useState('')
  const query = q.trim().toLowerCase()
  const shown = useMemo(() => (query ? lines.filter(l => lineText(l).toLowerCase().includes(query)) : lines), [lines, query])

  useLayoutEffect(() => { const el = body.current; if (el && following) el.scrollTop = el.scrollHeight }, [shown, following])
  const onScroll = () => {
    const el = body.current; if (!el) return
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    setFollowing(f => (f === atEnd ? f : atEnd))
  }
  const resume = () => { setFollowing(true); const el = body.current; if (el) el.scrollTop = el.scrollHeight }

  return (
    <div className={cx('top-log', className)}>
      <div className="top-log__bar">
        {searchable && (
          <label className="top-log__search">
            <Icon name="search" size={14} />
            <input className="input" type="search" aria-label={`Search ${label.toLowerCase()}`} placeholder="Search" value={q} autoComplete="off" onChange={e => setQ(e.target.value)} />
          </label>
        )}
        <span className="grow" />
        {!following && <Button variant="ghost" icon="arrow-down" onClick={resume}>Jump to latest</Button>}
        <CopyButton value={() => lines.map(lineText).join('\n')} label={copyLabel} />
      </div>
      <div ref={body} role="log" aria-live="off" aria-label={label} tabIndex={0} className="top-log__body scroll" style={{ height }} onScroll={onScroll}>
        {shown.length === 0 && <div className="top-log__empty">{query ? 'No matching lines' : emptyLabel}</div>}
        {shown.map((l, i) => <div key={i} className="top-log__line" data-level={typeof l === 'string' ? undefined : l.level}>{lineText(l) || ' '}</div>)}
      </div>
    </div>
  )
}

/**
 * A container only. Summa-UI contains no terminal emulator: mount xterm (or anything else) as `children`.
 * Header slots: title (default "Terminal"), shell (a label or picker), new tab, close, plus free `actions`.
 */
export function TerminalFrame({ title = 'Terminal', shell, onNewTab, newTab, onClose, close, actions, children, height = 280, className = '', newTabLabel = 'New tab', closeLabel = 'Close terminal' }:
  { title?: ReactNode; shell?: ReactNode; onNewTab?: () => void; newTab?: ReactNode; onClose?: () => void; close?: ReactNode; actions?: ReactNode; children?: ReactNode; height?: number | string; className?: string; newTabLabel?: string; closeLabel?: string }) {
  const id = useId()
  return (
    <section className={cx('top-term', className)} aria-labelledby={id}>
      <header className="top-term__head">
        <span id={id} className="top-term__title">{title}</span>
        {shell && <span className="top-term__shell">{shell}</span>}
        <span className="grow" />
        {actions}
        {newTab ?? (onNewTab && <IconButton icon="plus" label={newTabLabel} size="sm" onClick={onNewTab} />)}
        {close ?? (onClose && <IconButton icon="x" label={closeLabel} size="sm" onClick={onClose} />)}
      </header>
      <div className="top-term__body" style={{ height }}>{children}</div>
    </section>
  )
}

/* ------------------------------------------------------------------ OperationProgress */
/** Compact inline progress: spinner, a short label and, when `value` is given, a thin determinate bar. */
export function OperationProgress({ label, value, className = '' }: { label: string; value?: number; className?: string }) {
  const determinate = typeof value === 'number'
  const pct = determinate ? Math.max(0, Math.min(100, Math.round(value))) : undefined
  return (
    <div className={cx('top-op', className)} role={determinate ? undefined : 'status'}>
      <span className="spinner" aria-hidden="true" />
      <span className="top-op__label truncate">{label}</span>
      {determinate && (
        <>
          <span className="top-op__bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            <span style={{ width: `${pct}%` }} />
          </span>
          <span className="top-op__pct num">{pct}%</span>
        </>
      )}
    </div>
  )
}
