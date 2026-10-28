import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type Ref } from 'react'
import { createPortal } from 'react-dom'
import { Icon, type IconName } from './icons'
import { Popover, useAnchored, type Anchor, type Placement } from './popover'

export { Icon, Popover, useAnchored }
export type { IconName, Anchor, Placement }

/* ------------------------------------------------------------------ Buttons */
type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; size?: 'md' | 'lg'; icon?: IconName; ref?: Ref<HTMLButtonElement>
}
export function Button({ variant = 'secondary', size = 'md', icon, className = '', children, type = 'button', ...rest }: BtnProps) {
  return (
    <button type={type} className={`btn btn-${variant} ${size === 'lg' ? 'btn-lg' : ''} ${className}`} {...rest}>
      {icon && <Icon name={icon} />}
      {children}
    </button>
  )
}

type IconBtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: IconName; label: string; size?: 'md' | 'sm'; on?: boolean; filled?: boolean; iconSize?: number; ref?: Ref<HTMLButtonElement>
}
export function IconButton({ icon, label, size = 'md', on, filled, iconSize, className = '', type = 'button', ...rest }: IconBtnProps) {
  return (
    <button type={type} aria-label={label} title={label} className={`icon-btn ${size === 'sm' ? 'sm' : ''} ${on ? 'on' : ''} ${filled ? 'filled' : ''} ${className}`} {...rest}>
      <Icon name={icon} size={iconSize ?? (size === 'sm' ? 15 : 17)} />
    </button>
  )
}

/* ------------------------------------------------------------------ Inputs */
export function SearchInput({ className = '', ...rest }: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return (
    <label className={`search ${className}`}>
      <Icon name="search" size={15} />
      <input className="input" type="search" autoComplete="off" {...rest} />
    </label>
  )
}

export function Checkbox({ checked, onChange, label, className = '' }: { checked: boolean | 'mixed'; onChange: (v: boolean) => void; label: string; className?: string }) {
  return (
    <button type="button" role="checkbox" aria-checked={checked} aria-label={label} className={`checkbox ${className}`}
      onClick={e => { e.stopPropagation(); onChange(checked !== true) }}>
      <Icon name={checked === 'mixed' ? 'minus' : 'check'} size={12} strokeWidth={3} />
    </button>
  )
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className="switch" onClick={() => onChange(!checked)} />
}

export function Tabs<T extends string>({ items, value, onChange, flat, label }: { items: { value: T; label: string }[]; value: T; onChange: (v: T) => void; flat?: boolean; label?: string }) {
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    const i = items.findIndex(t => t.value === value)
    const n = (i + (e.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length
    onChange(items[n].value)
    ;(e.currentTarget.querySelectorAll('[role=tab]')[n] as HTMLElement | undefined)?.focus()
  }
  return (
    <div role="tablist" aria-label={label} className={`tabs ${flat ? 'flat' : ''}`} onKeyDown={onKey}>
      {items.map(t => (
        <button key={t.value} role="tab" type="button" aria-selected={value === t.value} tabIndex={value === t.value ? 0 : -1} className="tab" onClick={() => onChange(t.value)}>{t.label}</button>
      ))}
    </div>
  )
}

/** Default tag: one background, no border, optional icon, short text (Principle 4). */
export function Tag({ children, icon, accent, color, className = '' }: { children: ReactNode; icon?: IconName; accent?: boolean; color?: string; className?: string }) {
  return (
    <span className={`tag ${accent ? 'accent' : ''} ${className}`}>
      {color && <span className="dot" style={{ color }} />}
      {icon && <Icon name={icon} size={12} />}
      {children}
    </span>
  )
}

/**
 * Avatar: a deliberate opt-in for REAL identity imagery only (Principle 20).
 * Use it when an actual picture exists: pass `src` (or custom `children` such as an <img> or SVG art).
 * Initials render only when the caller passes an explicit `initials` prop, and that should be rare:
 * never generate initials, colours or circles to fill a slot where no real imagery exists.
 * Otherwise show the plain name and relevant metadata instead of an Avatar.
 */
export function Avatar({ name, src, children, initials, large }: { name: string; src?: string; children?: ReactNode; initials?: string; large?: boolean }) {
  const content = children ?? (src ? <img src={src} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "inherit" }} /> : initials)
  if (content == null || content === '') return null
  return <span className={`avatar ${large ? 'lg' : ''}`} title={name} role="img" aria-label={name}>{content}</span>
}

export const Divider = () => <hr className="divider" />

/* ------------------------------------------------------------------ Menu */
export type MenuEntry =
  | { type: 'sep' }
  | { type: 'heading'; label: string }
  | { type?: 'item'; label: string; icon?: IconName; shortcut?: string; danger?: boolean; disabled?: boolean; checked?: boolean; onSelect: () => void }

export function Menu({ anchor, open, onClose, items, placement, width, label }: { anchor: Anchor; open: boolean; onClose: () => void; items: MenuEntry[]; placement?: Placement; width?: number | 'anchor'; label?: string }) {
  return (
    <Popover anchor={anchor} open={open} onClose={onClose} placement={placement} width={width} label={label}>
      {items.map((it, i) => {
        if (it.type === 'sep') return <hr key={i} className="divider" />
        if (it.type === 'heading') return <div key={i} className="menu-heading eyebrow">{it.label}</div>
        return (
          <button key={i} type="button" role="menuitem" data-item disabled={it.disabled} className={`menu-item ${it.danger ? 'danger' : ''}`}
            onClick={() => { onClose(); it.onSelect() }}>
            {it.icon && <Icon name={it.icon} size={15} />}
            <span className="truncate">{it.label}</span>
            {it.shortcut && <span className="shortcut">{it.shortcut}</span>}
            {it.checked && <Icon name="check" size={14} className="check" />}
          </button>
        )
      })}
    </Popover>
  )
}

/** Button that opens a menu. Convenience for the common icon-button + menu pairing. */
export function MenuButton({ icon = 'more-h', label, items, placement = 'bottom-end', className = '', size }: { icon?: IconName; label: string; items: MenuEntry[]; placement?: Placement; className?: string; size?: 'md' | 'sm' }) {
  const a = useAnchored()
  return (
    <>
      <IconButton ref={a.ref} icon={icon} label={label} size={size} className={className} aria-haspopup="menu" aria-expanded={a.open} onClick={a.toggle} />
      <Menu anchor={a.el} open={a.open} onClose={a.close} items={items} placement={placement} label={label} />
    </>
  )
}

/** Right-click / long-press menu state. */
export function useContextMenu() {
  const [pt, setPt] = useState<{ x: number; y: number } | null>(null)
  const timer = useRef<number>(0)
  const bind = {
    onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); setPt({ x: e.clientX, y: e.clientY }) },
    onTouchStart: (e: React.TouchEvent) => { const t = e.touches[0]; timer.current = window.setTimeout(() => setPt({ x: t.clientX, y: t.clientY }), 550) },
    onTouchEnd: () => window.clearTimeout(timer.current),
    onTouchMove: () => window.clearTimeout(timer.current),
  }
  return { point: pt, open: !!pt, close: useCallback(() => setPt(null), []), openAt: (x: number, y: number) => setPt({ x, y }), bind }
}

/* ------------------------------------------------------------------ Dropdown (select / multiselect, with in-place creation) */
export type Option<T extends string = string> = { value: T; label: string; icon?: IconName; color?: string; meta?: string }

type DropdownBase<T extends string> = {
  options: Option<T>[]; placeholder?: string; searchable?: boolean; label: string; quiet?: boolean; className?: string; width?: number | 'anchor'
  /** When set, typing a name with no exact match offers to create it inside the list. */
  onCreate?: (name: string) => T | void; createNoun?: string
  renderValue?: (selected: Option<T>[]) => ReactNode
}
type DropdownProps<T extends string> = DropdownBase<T> & (
  | { multiple?: false; value: T | null; onChange: (v: T) => void }
  | { multiple: true; value: T[]; onChange: (v: T[]) => void }
)

export function Dropdown<T extends string>(props: DropdownProps<T>) {
  const { options, placeholder = 'Select', searchable, label, quiet, className = '', width = 'anchor', onCreate, createNoun = 'item', renderValue } = props
  const a = useAnchored()
  const [q, setQ] = useState('')
  const listId = useId()
  const selected = props.multiple ? props.value : props.value ? [props.value] : []
  const selOpts = options.filter(o => selected.includes(o.value))
  const query = q.trim().toLowerCase()
  const shown = query ? options.filter(o => o.label.toLowerCase().includes(query)) : options
  const exact = options.some(o => o.label.toLowerCase() === query)
  const canCreate = !!onCreate && query.length > 0 && !exact

  const close = useCallback(() => { a.close(); setQ('') }, [a])
  const pick = (v: T) => {
    if (props.multiple) props.onChange(props.value.includes(v) ? props.value.filter(x => x !== v) : [...props.value, v])
    else { props.onChange(v); close() }
  }
  const create = () => {
    const v = onCreate!(q.trim())
    setQ('')
    if (v) { if (props.multiple) props.onChange([...props.value, v]); else { props.onChange(v); close() } }
  }

  return (
    <>
      <button ref={a.ref} type="button" aria-label={label} aria-haspopup="listbox" aria-expanded={a.open} aria-controls={a.open ? listId : undefined}
        className={`select ${quiet ? 'quiet' : ''} ${className}`} onClick={a.toggle}>
        {renderValue ? renderValue(selOpts) : selOpts.length ? (
          <>
            {selOpts.length === 1 && selOpts[0].icon && <Icon name={selOpts[0].icon} size={15} />}
            {selOpts.length === 1 && selOpts[0].color && <span style={{ width: 8, height: 8, borderRadius: '50%', background: selOpts[0].color, flex: 'none' }} />}
            <span className="truncate">{selOpts.length === 1 ? selOpts[0].label : `${selOpts.length} ${label.toLowerCase()}`}</span>
          </>
        ) : <span className="faint truncate">{placeholder}</span>}
        <Icon name="chevron-down" size={14} />
      </button>
      <Popover anchor={a.el} open={a.open} onClose={close} width={width} role="listbox" label={label} focusSelector={searchable ? 'input' : '[data-item]'}>
        <div id={listId}>
          {searchable && (
            <div className="menu-search">
              <input className="input" placeholder={onCreate ? `Search or create ${createNoun}` : 'Search'} value={q} aria-label={`Search ${label}`}
                onChange={e => setQ(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') { e.preventDefault(); if (canCreate && !shown.length) create(); else if (shown.length) pick(shown[0].value) }
                  if (e.key === 'ArrowDown') { e.preventDefault(); (e.currentTarget.closest('.popover')?.querySelector('[data-item]') as HTMLElement | null)?.focus() }
                }} />
            </div>
          )}
          <div className="menu-list">
            {shown.map(o => (
              <button key={o.value} type="button" role="option" data-item aria-selected={selected.includes(o.value)} className="menu-item" onClick={() => pick(o.value)}>
                {props.multiple && <span className="checkbox" aria-checked={selected.includes(o.value)} aria-hidden="true"><Icon name="check" size={12} strokeWidth={3} /></span>}
                {o.color && <span className="dot" style={{ width: 8, height: 8, borderRadius: '50%', background: o.color, flex: 'none' }} />}
                {o.icon && <Icon name={o.icon} size={15} />}
                <span className="truncate">{o.label}</span>
                {o.meta && <span className="shortcut">{o.meta}</span>}
                {!props.multiple && selected.includes(o.value) && <Icon name="check" size={14} className="check" />}
              </button>
            ))}
            {!shown.length && !canCreate && <div className="menu-empty">No matches</div>}
          </div>
          {canCreate && (
            <>
              {shown.length > 0 && <hr className="divider" />}
              <button type="button" data-item className="menu-item create" onClick={create}>
                <Icon name="plus" size={15} />
                <span className="truncate">Create {createNoun} “{q.trim()}”</span>
              </button>
            </>
          )}
        </div>
      </Popover>
    </>
  )
}

/* ------------------------------------------------------------------ Dialog */
/** While any modal dialog is open the page behind it is inert: no focus, no clicks, hidden from assistive technology. */
let modalDepth = 0
function setBackgroundInert(on: boolean) {
  const root = document.getElementById('root')
  if (!root) return
  modalDepth = Math.max(0, modalDepth + (on ? 1 : -1))
  if (modalDepth > 0) root.setAttribute('inert', '')
  else root.removeAttribute('inert')
}

type DialogProps = {
  open: boolean; onClose: () => void; title: string; children?: ReactNode; footer?: ReactNode; width?: number
  /** Short plain text announced after the title. Always provide one for confirmations. */
  description?: ReactNode
  /** Use "alertdialog" for confirmations that interrupt the user, especially destructive ones. */
  role?: 'dialog' | 'alertdialog'
  /** Backdrop click closes a dialog by default. An alertdialog must be answered, so it does not. */
  dismissOnBackdrop?: boolean
}

export function Dialog({ open, onClose, title, description, role = 'dialog', dismissOnBackdrop, children, footer, width }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const descId = useId()
  const closeRef = useRef(onClose)
  closeRef.current = onClose // keeps the effect below from re-running (and re-stealing focus) on every parent render
  useEffect(() => {
    if (!open) return
    const prev = document.activeElement as HTMLElement | null
    const el = ref.current!
    setBackgroundInert(true)
    const preferred = role === 'alertdialog'
      ? el.querySelector<HTMLElement>('[data-autofocus]') ?? el.querySelector<HTMLElement>('.dialog-foot button')
      : el.querySelector<HTMLElement>('[data-autofocus],[autofocus],input,textarea,select')
    ;(preferred ?? el.querySelector<HTMLElement>('button') ?? el).focus()
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); closeRef.current() }
      if (e.key === 'Tab') {
        const f = Array.from(el.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),textarea,select,[tabindex]:not([tabindex="-1"])'))
        if (!f.length) { e.preventDefault(); return }
        const first = f[0], last = f[f.length - 1]
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
      }
    }
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('keydown', key); setBackgroundInert(false); prev?.focus() }
  }, [open, role])
  if (!open) return null
  const backdropCloses = dismissOnBackdrop ?? role === 'dialog'
  return createPortal(
    <div className="backdrop" onMouseDown={e => { if (backdropCloses && e.target === e.currentTarget) onClose() }}>
      <div ref={ref} className="dialog" role={role} aria-modal="true" aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined} tabIndex={-1}
        style={width ? { width: `min(${width}px, 100%)` } : undefined}>
        <h2 id={titleId} className="dialog-head">{title}</h2>
        <div className="dialog-body">
          {description && <p id={descId} className="dialog-desc">{description}</p>}
          {children}
        </div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}

/* ------------------------------------------------------------------ App shell */
const ShellCtx = createContext<{ openDrawer: () => void; closeDrawer: () => void }>({ openDrawer: () => {}, closeDrawer: () => {} })
export const useShell = () => useContext(ShellCtx)

/** Dark page with a lighter main panel. Sidebar collapses to a drawer on narrow viewports. */
export function AppShell({ sidebar, children, sideWidth }: { sidebar: ReactNode; children: ReactNode; sideWidth?: number }) {
  const [open, setOpen] = useState(false)
  const ctx = useMemo(() => ({ openDrawer: () => setOpen(true), closeDrawer: () => setOpen(false) }), [])
  useEffect(() => {
    if (!open) return
    const k = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('keydown', k)
    return () => document.removeEventListener('keydown', k)
  }, [open])
  return (
    <ShellCtx.Provider value={ctx}>
      <div className="shell" data-drawer={open ? 'open' : 'closed'}>
        <aside className="shell-side" style={sideWidth ? { width: sideWidth } : undefined} onClick={e => { if ((e.target as HTMLElement).closest('[data-closes-drawer]')) setOpen(false) }}>{sidebar}</aside>
        <div className="shell-scrim" onClick={() => setOpen(false)} />
        <main className="shell-main">{children}</main>
      </div>
    </ShellCtx.Provider>
  )
}

export function DrawerToggle() {
  const { openDrawer } = useShell()
  return <IconButton icon="menu" label="Open navigation" className="mobile-only" onClick={openDrawer} />
}

export function Brand({ name }: { name: string }) {
  return (
    <div className="brand">
      <span className="brand-mark"><Icon name="layers" size={13} strokeWidth={2.4} /></span>
      <span>{name}</span>
    </div>
  )
}

export function NavItem({ icon, label, current, count, onClick, closesDrawer = true }: { icon?: IconName; label: string; current?: boolean; count?: number | string; onClick?: () => void; closesDrawer?: boolean }) {
  return (
    <button type="button" className="nav-item" aria-current={current ? 'true' : undefined} onClick={onClick} {...(closesDrawer ? { 'data-closes-drawer': true } : {})}>
      {icon && <Icon name={icon} size={16} />}
      <span className="truncate">{label}</span>
      {count !== undefined && <span className="count num">{count}</span>}
    </button>
  )
}

/** Small hook: matches a media query. */
export function useMedia(query: string) {
  const [m, setM] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const f = () => setM(mq.matches)
    mq.addEventListener('change', f)
    return () => mq.removeEventListener('change', f)
  }, [query])
  return m
}

/** Closes on Escape / calls handler on a key combination. */
export function useHotkey(combo: string, fn: (e: KeyboardEvent) => void, deps: unknown[] = []) {
  useEffect(() => {
    const parts = combo.toLowerCase().split('+')
    const key = parts[parts.length - 1]
    const mod = parts.includes('mod'), shift = parts.includes('shift')
    const h = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== key) return
      if (mod !== (e.metaKey || e.ctrlKey)) return
      if (shift !== e.shiftKey) return
      fn(e)
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}
