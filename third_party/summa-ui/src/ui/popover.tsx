import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export type Anchor = HTMLElement | { x: number; y: number } | null
export type Placement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end' | 'right-start'

/** Tracks an anchor element + open state for a popover. Spread `ref` onto the trigger. */
export function useAnchored() {
  const [el, setEl] = useState<HTMLElement | null>(null)
  const [open, setOpen] = useState(false)
  const ref = useCallback((node: HTMLElement | null) => setEl(node), [])
  return { el, ref, open, setOpen, toggle: () => setOpen(o => !o), close: () => setOpen(false) }
}

type PopoverProps = {
  anchor: Anchor; open: boolean; onClose: () => void; placement?: Placement; className?: string
  width?: number | 'anchor'; children: ReactNode; label?: string; role?: string; focusSelector?: string
}

const GAP = 4
const MARGIN = 8

export function Popover({ anchor, open, onClose, placement = 'bottom-start', className = '', width, children, label, role = 'menu', focusSelector }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const isEl = anchor instanceof HTMLElement

  useLayoutEffect(() => {
    if (!open || !anchor || !ref.current) { setPos(null); return }
    const place = () => {
      const pop = ref.current
      if (!pop) return
      const r = isEl ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y, width: 0, height: 0 }
      const pw = pop.offsetWidth, ph = pop.offsetHeight
      const vw = window.innerWidth, vh = window.innerHeight
      let left = r.left, top = r.bottom + GAP
      if (placement === 'bottom-end' || placement === 'top-end') left = r.right - pw
      if (placement === 'top-start' || placement === 'top-end') top = r.top - ph - GAP
      if (placement === 'right-start') { left = r.right + GAP; top = r.top }
      if (top + ph > vh - MARGIN && r.top - ph - GAP > MARGIN) top = r.top - ph - GAP // flip up
      if (placement === 'right-start' && left + pw > vw - MARGIN) left = r.left - pw - GAP
      left = Math.max(MARGIN, Math.min(left, vw - pw - MARGIN))
      top = Math.max(MARGIN, Math.min(top, vh - ph - MARGIN))
      setPos({ left, top })
    }
    place()
    window.addEventListener('resize', place)
    const onScroll = (e: Event) => { if (!ref.current?.contains(e.target as Node)) onClose() }
    window.addEventListener('scroll', onScroll, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', onScroll, true) }
  }, [open, anchor, placement, isEl, onClose])

  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node
      if (ref.current?.contains(t)) return
      if (isEl && anchor.contains(t)) return
      onClose()
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); if (isEl) anchor.focus() }
    }
    document.addEventListener('mousedown', down)
    document.addEventListener('touchstart', down)
    document.addEventListener('keydown', key, true)
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('touchstart', down); document.removeEventListener('keydown', key, true) }
  }, [open, anchor, isEl, onClose])

  useEffect(() => {
    if (!open || !pos) return
    const root = ref.current
    if (!root || root.contains(document.activeElement)) return
    const target = root.querySelector<HTMLElement>(focusSelector ?? '[data-item]:not(:disabled)') ?? root
    target.focus({ preventScroll: true })
  }, [open, pos, focusSelector])

  if (!open || !anchor) return null

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return
    const items = Array.from(ref.current!.querySelectorAll<HTMLElement>('[data-item]:not(:disabled)'))
    if (!items.length) return
    e.preventDefault()
    const i = items.indexOf(document.activeElement as HTMLElement)
    let n = e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowUp' ? i - 1 : e.key === 'Home' ? 0 : items.length - 1
    if (n >= items.length) n = 0
    if (n < 0) n = items.length - 1
    items[n].focus()
    items[n].scrollIntoView({ block: 'nearest' })
  }

  const w = width === 'anchor' && isEl ? Math.max(anchor.offsetWidth, 200) : typeof width === 'number' ? width : undefined
  return createPortal(
    <div
      ref={ref} role={role} aria-label={label} tabIndex={-1} onKeyDown={onKeyDown}
      className={`popover ${className}`}
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, width: w, visibility: pos ? 'visible' : 'hidden' }}
    >
      {children}
    </div>,
    document.body,
  )
}
