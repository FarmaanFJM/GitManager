import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../ui'
import '../../guidance/css/presets.css'

/*
  preset.notification: React reference implementation.
  Appearance comes entirely from guidance/css/presets.css (.sm-toast*). This file only adds behaviour:
  timers, pause on hover and focus, Esc, de-duplication, stacking. Copy the behaviour, not the React.
*/

export type ToastType = 'success' | 'error' | 'warning' | 'info' | 'neutral'
export type ToastAction = { label: string; onClick?: () => void }
export type ToastOptions = {
  /** Expanded form: a bold title. The message then becomes the description unless `description` is given. */
  title?: string
  description?: string
  action?: ToastAction
  /** Expanded form only: a second action. */
  secondaryAction?: ToastAction
  /** Milliseconds. Infinity keeps the toast until dismissed. Defaults depend on the type. */
  duration?: number
  /** Force the one-line form even when a title or description is given. */
  compact?: boolean
}

const DEFAULT_MS: Record<ToastType, number> = { success: 4000, info: 4000, neutral: 4000, warning: 8000, error: Infinity }
const ACTION_MIN_MS = 6000 // a toast with an action stays long enough to be used
const MAX_VISIBLE = 3
const EXIT_MS = 170

type Item = { id: number; key: string; type: ToastType; message: string; opts: ToastOptions; bump: number; leaving: boolean }

export type ToastApi = {
  success: (message: string, opts?: ToastOptions) => number
  error: (message: string, opts?: ToastOptions) => number
  warning: (message: string, opts?: ToastOptions) => number
  info: (message: string, opts?: ToastOptions) => number
  neutral: (message: string, opts?: ToastOptions) => number
  dismiss: (id: number) => void
  clear: () => void
}

const Ctx = createContext<ToastApi | null>(null)

export function useToast(): ToastApi {
  const api = useContext(Ctx)
  if (!api) throw new Error('useToast must be used inside <ToastProvider>')
  return api
}

function ToastIcon({ type }: { type: ToastType }) {
  if (type === 'neutral') return null // neutral has no icon
  return (
    <span className="sm-toast__icon">
      {type === 'success' && <Icon name="circle-check" size={16} />}
      {type === 'error' && <Icon name="circle-x" size={16} />}
      {type === 'info' && <Icon name="info" size={16} />}
      {type === 'warning' && <Icon name="triangle-alert" size={16} />}
    </span>
  )
}

function ToastItem({ item, depth, onDismiss, lastOutside }: { item: Item; depth: number; onDismiss: (id: number) => void; lastOutside: React.RefObject<HTMLElement | null> }) {
  const { type, message, opts } = item
  const expanded = !opts.compact && !!(opts.title || opts.description)
  let duration = opts.duration ?? DEFAULT_MS[type]
  if (opts.action && Number.isFinite(duration)) duration = Math.max(duration, ACTION_MIN_MS)
  const persistent = !Number.isFinite(duration)

  const ref = useRef<HTMLDivElement>(null)
  const remaining = useRef(duration)
  const startedAt = useRef(0)
  const timer = useRef(0)
  const paused = useRef(false)

  const arm = useCallback(() => {
    window.clearTimeout(timer.current)
    if (!Number.isFinite(duration)) return
    startedAt.current = Date.now()
    timer.current = window.setTimeout(() => onDismiss(item.id), remaining.current)
  }, [duration, item.id, onDismiss])

  // (Re)start whenever the toast is created or de-duplicated (bump changes).
  useEffect(() => {
    remaining.current = duration
    const held = !!ref.current && (ref.current.matches(':hover') || ref.current.contains(document.activeElement))
    paused.current = held
    if (!held) arm()
    return () => window.clearTimeout(timer.current)
  }, [item.bump, duration, arm])

  const pause = () => {
    if (!Number.isFinite(duration) || paused.current) return
    paused.current = true
    window.clearTimeout(timer.current)
    remaining.current -= Date.now() - startedAt.current
  }
  const resume = () => { if (!paused.current) return; paused.current = false; arm() }

  const dismiss = () => {
    if (ref.current?.contains(document.activeElement) && lastOutside.current?.isConnected) lastOutside.current.focus()
    onDismiss(item.id)
  }
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); dismiss() } }
  const run = (a: ToastAction) => { dismiss(); a.onClick?.() }

  const alertish = type === 'error' || type === 'warning'
  const title = expanded ? (opts.title ?? message) : undefined
  const desc = expanded ? (opts.description ?? (opts.title ? message : undefined)) : undefined
  const actions = [opts.action, expanded ? opts.secondaryAction : undefined].filter(Boolean) as ToastAction[]

  return (
    <div
      ref={ref} className={`sm-toast ${expanded ? 'sm-toast--expanded' : 'sm-toast--compact'}`}
      data-type={type} data-depth={depth} data-state={item.leaving ? 'leaving' : undefined}
      role={alertish ? 'alert' : 'status'} aria-live={alertish ? 'assertive' : 'polite'} aria-atomic="true"
      onMouseEnter={pause}
      onMouseLeave={() => { if (!ref.current?.contains(document.activeElement)) resume() }}
      onFocus={pause}
      onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null) && !e.currentTarget.matches(':hover')) resume() }}
      onKeyDown={onKey}
    >
      <ToastIcon type={type} />
      <div className="sm-toast__body">
        {expanded ? (
          <>
            <div className="sm-toast__title">{title}</div>
            {desc && <div className="sm-toast__desc">{desc}</div>}
            {actions.length > 0 && (
              <div className="sm-toast__actions">
                {actions.map(a => <button key={a.label} type="button" className="sm-toast__action" onClick={() => run(a)}>{a.label}</button>)}
              </div>
            )}
          </>
        ) : <span className="sm-toast__message">{message}</span>}
      </div>
      {!expanded && actions.slice(0, 1).map(a => <button key={a.label} type="button" className="sm-toast__action" onClick={() => run(a)}>{a.label}</button>)}
      {(expanded || persistent) && (
        <button type="button" className="sm-toast__dismiss" aria-label="Dismiss notification" onClick={dismiss}><Icon name="x" size={14} /></button>
      )}
    </div>
  )
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Item[]>([])
  const nextId = useRef(1)
  const lastOutside = useRef<HTMLElement | null>(null)
  const region = useRef<HTMLElement | null>(null)

  // Remember where focus was so Esc on a focused toast can hand it back.
  useEffect(() => {
    const f = (e: FocusEvent) => { const t = e.target as HTMLElement; if (region.current && !region.current.contains(t)) lastOutside.current = t }
    document.addEventListener('focusin', f)
    return () => document.removeEventListener('focusin', f)
  }, [])

  const dismiss = useCallback((id: number) => {
    setItems(list => list.map(i => (i.id === id ? { ...i, leaving: true } : i)))
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    window.setTimeout(() => setItems(list => list.filter(i => i.id !== id)), reduced ? 0 : EXIT_MS)
  }, [])

  const push = useCallback((type: ToastType, message: string, opts: ToastOptions = {}) => {
    const key = [type, opts.title ?? '', message].join('|')
    let id = 0
    setItems(list => {
      const dup = list.find(i => i.key === key && !i.leaving)
      if (dup) { id = dup.id; return list.map(i => (i.id === dup.id ? { ...i, bump: i.bump + 1 } : i)) } // identical: restart the timer, do not stack
      id = nextId.current++
      return [...list, { id, key, type, message, opts, bump: 0, leaving: false }]
    })
    return id
  }, [])

  const api = useMemo<ToastApi>(() => ({
    success: (m, o) => push('success', m, o),
    error: (m, o) => push('error', m, o),
    warning: (m, o) => push('warning', m, o),
    info: (m, o) => push('info', m, o),
    neutral: (m, o) => push('neutral', m, o),
    dismiss,
    clear: () => setItems(list => list.map(i => ({ ...i, leaving: true }))),
  }), [push, dismiss])

  // Remove items that have been marked leaving through clear().
  useEffect(() => {
    if (!items.some(i => i.leaving)) return
    const t = window.setTimeout(() => setItems(list => list.filter(i => !i.leaving)), EXIT_MS)
    return () => window.clearTimeout(t)
  }, [items])

  return (
    <Ctx.Provider value={api}>
      {children}
      {createPortal(
        <section className="sm-toast-region" aria-label="Notifications" ref={n => { region.current = n }}>
          {items.map((item, i) => (
            <ToastItem key={item.id} item={item} depth={Math.min(items.length - 1 - i, MAX_VISIBLE)} onDismiss={dismiss} lastOutside={lastOutside} />
          ))}
        </section>,
        document.body,
      )}
    </Ctx.Provider>
  )
}
