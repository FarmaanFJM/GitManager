import { useEffect, useState } from 'react'
import { Button, Checkbox, Dialog, Icon } from '../../third_party/summa-ui/src/ui'
import type { DeletionReport, OpError, Repo } from '../shared/types'
import { api } from './api'
import { deleteWords, deletionRows, removeWords } from './deleteText'

/**
 * Delete local folder: inspects the repository first (nothing is changed by opening it), shows the exact folder and everything
 * that would be lost, and moves the folder to the trash. Permanent deletion is a separate, second confirmation that appears only
 * when the trash is unavailable or failed.
 */
export function DeleteRepoDialog({ repo, onClose, onDeleted }: { repo: Repo | null; onClose: () => void; onDeleted: (message: string, notes: string[], removed: string[]) => void }) {
  const [report, setReport] = useState<DeletionReport | null>(null)
  const [error, setError] = useState<OpError | null>(null)
  const [ack, setAck] = useState(false)
  const [busy, setBusy] = useState(false)
  const [permanent, setPermanent] = useState(false)
  const [permAck, setPermAck] = useState(false)
  const load = async (id: string) => { const r = await api.deletionPreview(id); if (r.ok) setReport(r.value); else setError(r.error) }
  useEffect(() => {
    setReport(null); setError(null); setAck(false); setBusy(false); setPermanent(false); setPermAck(false)
    if (repo) void load(repo.id)
  }, [repo?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!repo) return null

  const blocked = !report || report.blockers.length > 0
  const gone = report && !report.exists
  const needsAck = !!report?.losesWork
  const trashOk = !!report?.trash.available && !permanent
  const run = async (perm: boolean) => {
    if (!report) return
    setBusy(true); setError(null)
    const r = await api.deleteRepoFolder(repo.id, { confirmPath: repo.location.path, ...(perm ? { permanent: true, confirmPermanent: true } : {}) })
    setBusy(false)
    if (r.ok) { onDeleted(r.value.message, r.value.notes, r.value.removedRepoIds); return }
    setError(r.error)
    if (r.error.code === 'TRASH_UNAVAILABLE' || r.error.code === 'TRASH_FAILED') setPermanent(true)
    void load(repo.id)
  }

  const trashLabel = report?.trash.label ?? 'Trash'
  const footer = (
    <>
      <Button variant="secondary" onClick={onClose} data-autofocus disabled={busy}>Cancel</Button>
      {gone
        ? <Button variant="danger" disabled={busy} aria-busy={busy || undefined} onClick={() => void run(false)}>{removeWords.confirm}</Button>
        : permanent
          ? <Button variant="danger" icon="trash" disabled={blocked || busy || !permAck || (needsAck && !ack)} aria-busy={busy || undefined} onClick={() => void run(true)}>{deleteWords.permanent}</Button>
          : <Button variant="danger" icon="trash" disabled={blocked || busy || (needsAck && !ack) || !trashOk} aria-busy={busy || undefined} onClick={() => void run(false)}>
            {busy && <span className="sm-spinner" aria-hidden="true" />}{deleteWords.confirm(trashLabel)}
          </Button>}
    </>
  )

  return (
    <Dialog open onClose={busy ? () => {} : onClose} title={gone ? `${repo.name} is already gone` : deleteWords.title(repo.name)} role="alertdialog" width={560} footer={footer}
      description={gone ? 'The folder no longer exists, so nothing needs deleting. You can remove the repository from GitManager.' : 'This deletes the folder on this computer, including its .git directory and every file in it. The repository on GitHub, its branches, releases and workflows are not touched.'}>
      <div className="gm-delete">
        {!report && !error && <p className="muted row"><span className="sm-spinner" aria-hidden="true" /> Inspecting the repository</p>}
        {report && !gone && (
          <dl className="gm-props gm-delete-props">
            {deletionRows(report).map(row => <><dt key={`${row.label}-t`}>{row.label}</dt><dd key={`${row.label}-d`} className={`${row.label === 'Folder' ? 'gm-mono-sm gm-delete-path' : ''} ${row.warn ? 'gm-warn' : ''}`}>{row.value}</dd></>)}
          </dl>
        )}
        {report && report.blockers.length > 0 && (
          <ul className="gm-alerts gm-delete-alerts" aria-label="Deletion is blocked">{report.blockers.map((b, i) => <li key={i} className="gm-alert warn"><Icon name="triangle-alert" size={15} /><span>{b}</span></li>)}</ul>
        )}
        {report && report.blockers.length === 0 && report.warnings.length > 0 && !gone && (
          <ul className="gm-alerts gm-delete-alerts" aria-label="Before you delete">{report.warnings.map((w, i) => <li key={i} className="gm-alert"><Icon name="info" size={15} /><span>{w}</span></li>)}</ul>
        )}
        {report && !gone && !report.trash.available && !permanent && <p className="gm-hint">Recoverable deletion is not available here. {report.trash.reason}</p>}
        {report && !gone && report.trash.available && !permanent && <p className="gm-hint">The folder is moved to the {report.trash.label}, so it can be restored from there.</p>}
        {report && !gone && report.blockers.length === 0 && needsAck && <label className="gm-ack"><Checkbox checked={ack} onChange={setAck} label="I understand the work listed above will be lost" /><span>I understand the work listed above will be lost</span></label>}
        {permanent && report && (
          <div className="gm-delete-perm">
            <p><strong>Permanent deletion.</strong> The {trashLabel.toLowerCase()} could not be used, so the folder would be deleted for good and cannot be restored.</p>
            <label className="gm-ack"><Checkbox checked={permAck} onChange={setPermAck} label={`Delete ${report.display} permanently`} /><span>Delete {report.display} permanently</span></label>
          </div>
        )}
        {error && <p className="gm-warn gm-delete-error" role="alert">{error.message}{error.detail ? <span className="faint"> {error.detail}</span> : null}</p>}
      </div>
    </Dialog>
  )
}
