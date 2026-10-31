import { useEffect, useMemo, useState } from 'react'
import { Icon } from '../../../third_party/summa-ui/src/ui'
import type { AuditView, StorageState } from '../../shared/storage'
import { formatBytes } from '../../shared/storageTotals'
import { api } from '../api'
import { dateTimeText } from './common'

/** The local audit log: every deletion attempt and its GitHub-confirmed outcome. It lives on this computer only. */
export function Activity({ st }: { st: StorageState }) {
  const [view, setView] = useState<AuditView | null>(null)
  useEffect(() => { void api.storageAudit().then(setView) }, [st.lastOperation, st.snapshot?.scannedAt])
  const last = st.lastOperation
  // One row per artifact and operation: the latest word on it. The file keeps every line (request, accepted, confirmed).
  const rows = useMemo(() => {
    const latest = new Map<string, AuditView['entries'][number]>()
    for (const e of [...(view?.entries ?? [])].reverse()) latest.set(`${e.opId}:${e.repo}:${e.artifactId}`, e)
    return [...latest.values()].reverse()
  }, [view])
  return (
    <div className="gm-scroll scroll">
      <section className="gm-section" aria-label="Last operation">
        <h2 className="gm-section-h">Last cleanup</h2>
        {last ? (
          <p className="gm-pad">
            {last.dryRun ? 'Check without deleting' : last.trigger === 'scheduled' ? 'Scheduled cleanup' : 'Manual cleanup'}, {dateTimeText(last.finishedAt)}:{' '}
            {last.dryRun ? `${last.items.filter(i => i.outcome === 'skipped-dry-run').length} would be deleted` : `${last.confirmedDeleted} confirmed deleted by GitHub (${formatBytes(last.confirmedBytes)})`}
            {last.items.some(i => !['deleted', 'skipped-dry-run'].includes(i.outcome)) ? `, ${last.items.filter(i => !['deleted', 'skipped-dry-run'].includes(i.outcome)).length} not deleted` : ''}.
          </p>
        ) : <p className="gm-section-empty muted">No cleanup has run yet.</p>}
      </section>
      <section className="gm-section" aria-label="Audit log">
        <h2 className="gm-section-h">Audit log <span className="faint num">{rows.length} {rows.length === 1 ? 'artifact' : 'artifacts'}, {view?.total ?? 0} entries</span></h2>
        {view && !view.intact && <p className="gm-branch-problem" role="status"><Icon name="triangle-alert" size={15} />The audit log was changed or damaged outside GitManager (first problem at entry {view.brokenAt}). Entries are shown as found.</p>}
        {view && view.unresolved > 0 && <p className="gm-branch-problem" role="status"><Icon name="info" size={15} />{view.unresolved} deletion {view.unresolved === 1 ? 'attempt was' : 'attempts were'} interrupted before an outcome was recorded. The next scan settles them.</p>}
        <div className="gm-btable gm-audit" role="table" aria-label="Audit log">
          <div className="gm-bhead" role="row">
            <span role="columnheader">Time</span><span role="columnheader">Repository</span><span role="columnheader">Artifact</span>
            <span role="columnheader" className="gm-col-num">Size</span><span role="columnheader">Run</span><span role="columnheader">Result</span>
          </div>
          <div className="gm-bbody scroll" role="rowgroup">
            {rows.map(e => (
              <div key={e.seq} role="row" className="gm-brow gm-arow">
                <span role="cell" className="muted truncate">{new Date(e.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                <span role="cell" className="truncate">{e.repo}</span>
                <span role="cell" className="truncate" title={`${e.name} (#${e.artifactId})`}>{e.name}</span>
                <span role="cell" className="gm-col-num num">{formatBytes(e.sizeBytes)}</span>
                <span role="cell" className="muted">{e.runId ?? '–'}</span>
                <span role="cell" className={e.type === 'attempt' ? 'faint' : e.outcome === 'deleted' ? '' : 'gm-warn'} title={e.message ?? undefined}>{e.type === 'attempt' ? 'Requested' : e.outcome}{e.trigger === 'scheduled' ? ' · scheduled' : ''}</span>
              </div>
            ))}
            {view && rows.length === 0 && <p className="gm-section-empty muted">Nothing has been deleted by GitManager.</p>}
          </div>
        </div>
        <p className="gm-hint gm-pad">Recorded: artifact id, name, repository, workflow run, size, time and outcome. Stored in <span className="gm-mono">storage-audit.jsonl</span> next to your settings; nothing is sent anywhere.</p>
      </section>
    </div>
  )
}
