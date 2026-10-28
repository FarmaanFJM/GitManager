import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button, Dialog, type IconName } from '../ui'
import '../../guidance/css/presets.css'

/*
  preset.confirm-dialog: React reference implementation. Wraps the shared Dialog.
  Initial focus: Cancel for destructive, Confirm for non-destructive, the field for type-to-confirm.
*/

export type ConfirmOptions = {
  /** A question with a specific verb: Delete project "Atlas"? */
  title: string
  /** One sentence of consequence. */
  description?: ReactNode
  /** The verb button label: Delete project. Never OK or Yes. */
  confirmLabel: string
  cancelLabel?: string
  /** Solid destructive button (.btn-danger) with a trash icon by default. */
  destructive?: boolean
  icon?: IconName
  /** Type-to-confirm: the button stays disabled until this exact text is typed. */
  requireText?: string
}

export function ConfirmDialog({ open, onConfirm, onCancel, title, description, confirmLabel, cancelLabel = 'Cancel', destructive, icon, requireText }:
  ConfirmOptions & { open: boolean; onConfirm: () => void | Promise<void>; onCancel: () => void }) {
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const cancelRef = useRef(onCancel)
  cancelRef.current = onCancel
  const close = useCallback(() => cancelRef.current(), []) // stable, so the Dialog does not re-run its focus effect
  useEffect(() => { if (open) { setTyped(''); setBusy(false) } }, [open])

  const blocked = busy || (!!requireText && typed !== requireText)
  const confirm = async () => {
    if (blocked) return
    setBusy(true)
    try { await onConfirm() } finally { setBusy(false) }
  }
  const trash: IconName | undefined = icon ?? (destructive ? 'trash' : undefined)

  return (
    <Dialog open={open} onClose={close} title={title} description={description} role={destructive ? 'alertdialog' : 'dialog'}
      footer={
        <>
          <Button variant="secondary" onClick={close} data-autofocus={destructive && !requireText ? true : undefined}>{cancelLabel}</Button>
          <Button variant={destructive ? 'danger' : 'primary'} icon={busy ? undefined : trash} disabled={blocked} aria-busy={busy || undefined}
            data-autofocus={!destructive ? true : undefined} onClick={confirm}>
            {busy && <span className="sm-spinner" aria-hidden="true" />}
            {confirmLabel}
          </Button>
        </>
      }>
      {requireText && (
        <div className="sm-dialog__field">
          <label className="sm-dialog__label" htmlFor="confirm-text">Type <strong>{requireText}</strong> to confirm</label>
          <input id="confirm-text" className="input" data-autofocus value={typed} autoComplete="off" spellCheck={false}
            onChange={e => setTyped(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void confirm() } }} />
        </div>
      )}
    </Dialog>
  )
}

/* ------------------------------------------------------------ promise helper */
type Pending = { opts: ConfirmOptions; resolve: (ok: boolean) => void }
const Ctx = createContext<((opts: ConfirmOptions) => Promise<boolean>) | null>(null)

/** `const confirm = useConfirm(); if (await confirm({ title: 'Delete project?', confirmLabel: 'Delete project', destructive: true })) ...` */
export function useConfirm() {
  const c = useContext(Ctx)
  if (!c) throw new Error('useConfirm must be used inside <ConfirmProvider>')
  return c
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null)
  const confirm = useCallback((opts: ConfirmOptions) => new Promise<boolean>(resolve => setPending({ opts, resolve })), [])
  const settle = useCallback((ok: boolean) => { setPending(p => { p?.resolve(ok); return null }) }, [])
  const last = useRef<ConfirmOptions | null>(null)
  if (pending) last.current = pending.opts // keep the copy while the dialog animates away
  const value = useMemo(() => confirm, [confirm])
  return (
    <Ctx.Provider value={value}>
      {children}
      {last.current && <ConfirmDialog {...last.current} open={!!pending} onConfirm={() => settle(true)} onCancel={() => settle(false)} />}
    </Ctx.Provider>
  )
}
