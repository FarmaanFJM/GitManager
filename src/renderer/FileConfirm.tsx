import { useEffect, useState } from 'react'
import { Button, Checkbox, Dialog } from '../../third_party/summa-ui/src/ui'
import { plural } from './util'

/**
 * A confirmation that names exactly what will be affected: every path, in a scrollable list, and what happens to it. Used before
 * anything that discards or deletes. An optional acknowledgement (a checkbox) must be ticked first for the riskiest cases.
 */
export function FileConfirm({ open, title, files, consequences, confirmLabel, acknowledge, busy, onConfirm, onCancel }: {
  open: boolean; title: string; files: string[]; consequences: string[]; confirmLabel: string; acknowledge?: string; busy?: boolean
  onConfirm: () => void; onCancel: () => void
}) {
  const [ack, setAck] = useState(false)
  useEffect(() => { if (open) setAck(false) }, [open])
  return (
    <Dialog open={open} onClose={busy ? () => {} : onCancel} title={title} role="alertdialog" width={520}
      footer={(
        <>
          <Button variant="secondary" onClick={onCancel} disabled={busy} data-autofocus>Cancel</Button>
          <Button variant="danger" icon={busy ? undefined : 'trash'} disabled={busy || (!!acknowledge && !ack)} aria-busy={busy || undefined} onClick={onConfirm}>
            {busy && <span className="sm-spinner" aria-hidden="true" />}{confirmLabel}
          </Button>
        </>
      )}>
      <div className="gm-fc">
        <ul className="gm-fc-list" aria-label={plural(files.length, 'file')}>{files.map(f => <li key={f} className="gm-mono truncate" title={f}>{f}</li>)}</ul>
        <ul className="gm-fc-notes">{consequences.map(c => <li key={c}>{c}</li>)}</ul>
        {acknowledge && <label className="gm-ack"><Checkbox checked={ack} onChange={setAck} label={acknowledge} /><span>{acknowledge}</span></label>}
      </div>
    </Dialog>
  )
}
