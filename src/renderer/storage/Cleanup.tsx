import { useEffect, useMemo, useState } from 'react'
import { Button, Checkbox, Dialog, Icon } from '../../../third_party/summa-ui/src/ui'
import type { Artifact, ArtifactClass, OperationProgress, OperationResult, Outcome, StorageState } from '../../shared/storage'
import { formatBytes } from '../../shared/storageTotals'
import { api } from '../api'
import { plural } from '../util'
import { dateText } from './common'

const SHOW = 50
const key = (a: { repo: string; id: number }) => `${a.repo}#${a.id}`

const OUTCOME_TEXT: Record<Outcome, string> = {
  deleted: 'Deleted, confirmed by GitHub', 'deleted-unconfirmed': 'Accepted by GitHub, not yet confirmed', 'already-gone': 'Already gone', 'skipped-changed': 'Skipped: changed since the scan',
  'skipped-protected': 'Skipped: protected', 'skipped-not-found': 'Skipped: not found', 'skipped-dry-run': 'Would be deleted (dry run)', denied: 'Not allowed', 'rate-limited': 'Stopped by GitHub rate limit',
  failed: 'Failed', 'not-attempted': 'Not attempted',
}

type Group = { repo: string; items: Artifact[] }
const groupBy = (list: Artifact[]): Group[] => {
  const m = new Map<string, Artifact[]>()
  for (const a of list) { if (!m.has(a.repo)) m.set(a.repo, []); m.get(a.repo)!.push(a) }
  return [...m.entries()].map(([repo, items]) => ({ repo, items: items.sort((a, b) => b.sizeBytes - a.sizeBytes) })).sort((a, b) => b.items.reduce((n, x) => n + x.sizeBytes, 0) - a.items.reduce((n, x) => n + x.sizeBytes, 0))
}

/**
 * The cleanup preview and the deletion itself. Nothing is selected for deletion that is not a verified delete candidate
 * unless the user ticks a Review artifact by hand. The one red button is the authorization; GitHub's answers are shown after.
 */
export function CleanupDialog({ st, open, onClose, repos }: { st: StorageState; open: boolean; onClose: () => void; repos: string[] | null }) {
  const snap = st.snapshot
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [phase, setPhase] = useState<'review' | 'running' | 'result'>('review')
  const [result, setResult] = useState<OperationResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [showReview, setShowReview] = useState(false)
  const [showExcluded, setShowExcluded] = useState(false)

  const scope = useMemo(() => (snap?.repos ?? []).filter(r => !repos || repos.includes(r.repo)), [snap, repos])
  const candidates = useMemo(() => scope.filter(r => r.canDelete && !r.error).flatMap(r => r.artifacts.filter(a => a.class === 'delete-candidate')), [scope])
  const review = useMemo(() => scope.filter(r => r.canDelete && !r.error).flatMap(r => r.artifacts.filter(a => a.class === 'review')), [scope])
  const excluded = useMemo(() => {
    const by: Record<ArtifactClass, Artifact[]> = { protected: [], keep: [], review: [], 'delete-candidate': [], expired: [] }
    for (const r of scope) for (const a of r.artifacts) if (a.class !== 'delete-candidate' && a.class !== 'review' && a.class !== 'expired') by[a.class].push(a)
    const readOnly = scope.filter(r => !r.canDelete).flatMap(r => r.artifacts).filter(a => a.class === 'delete-candidate' || a.class === 'review')
    return { protected: by.protected, keep: by.keep, readOnly }
  }, [scope])

  useEffect(() => {
    if (!open) return
    setPicked(new Set(candidates.map(key))); setPhase('review'); setResult(null); setError(null); setExpanded(new Set()); setShowReview(false); setShowExcluded(false)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const [progress, setProgress] = useState<OperationProgress | null>(null)
  useEffect(() => api.on('storage-status', p => setProgress(p.operation)), [])

  const byKey = useMemo(() => new Map([...candidates, ...review].map(a => [key(a), a])), [candidates, review])
  const selected = [...picked].map(k => byKey.get(k)).filter((a): a is Artifact => !!a)
  const bytes = selected.reduce((n, a) => n + a.sizeBytes, 0)
  const selRepos = new Set(selected.map(a => a.repo)).size
  const reviewSelected = selected.filter(a => a.class === 'review').length
  const allCandidates = candidates.length > 0 && candidates.every(a => picked.has(key(a)))
  const someCandidates = candidates.some(a => picked.has(key(a)))

  const toggle = (a: Artifact) => setPicked(s => { const n = new Set(s); if (n.has(key(a))) n.delete(key(a)); else n.add(key(a)); return n })
  const toggleAllCandidates = () => setPicked(s => { const n = new Set(s); for (const a of candidates) { if (allCandidates) n.delete(key(a)); else n.add(key(a)) } return n })
  const toggleGroup = (g: Group) => setPicked(s => { const n = new Set(s); const all = g.items.every(a => n.has(key(a))); for (const a of g.items) { if (all) n.delete(key(a)); else n.add(key(a)) } return n })

  const run = async (dryRun: boolean) => {
    setError(null); setPhase('running'); setProgress({ opId: null, running: true, done: 0, total: selected.length, current: null, cancelling: false })
    const r = await api.storageDelete(selected.map(a => ({ repo: a.repo, id: a.id })), { dryRun, confirm: !dryRun })
    if (!r.ok) { setError(r.error.message); setPhase('review'); return }
    setResult(r.value); setPhase('result')
  }

  const renderGroup = (g: Group, tone: 'candidate' | 'review') => {
    const open = expanded.has(g.repo + tone)
    const items = open ? g.items : g.items.slice(0, 8)
    const all = g.items.every(a => picked.has(key(a)))
    const some = g.items.some(a => picked.has(key(a)))
    return (
      <section key={g.repo + tone} className="gm-cgroup" aria-label={g.repo}>
        <div className="gm-cgroup-head">
          <Checkbox checked={all ? true : some ? 'mixed' : false} onChange={() => toggleGroup(g)} label={`Select all in ${g.repo}`} />
          <span className="gm-bname truncate">{g.repo}</span>
          <span className="grow" />
          <span className="faint num">{plural(g.items.length, 'artifact')} · {formatBytes(g.items.reduce((n, a) => n + a.sizeBytes, 0))}</span>
        </div>
        <ul className="gm-clist">
          {items.map(a => (
            <li key={a.id} className="gm-citem">
              <Checkbox checked={picked.has(key(a))} onChange={() => toggle(a)} label={`Delete ${a.name}`} />
              <div className="gm-citem-main">
                <div className="gm-citem-top"><span className="truncate" title={a.name}>{a.name}</span><span className="num faint">{formatBytes(a.sizeBytes)} · {dateText(a.createdAt)}</span></div>
                <div className="gm-reason-line">{a.reason}{a.runId ? <> <button type="button" className="gm-linkbtn" onClick={() => void api.storageOpen({ kind: 'run', repo: a.repo, runId: a.runId! })}>Run #{a.run?.runNumber ?? a.runId}</button></> : null}</div>
              </div>
            </li>
          ))}
        </ul>
        {g.items.length > 8 && !open && <button type="button" className="btn btn-ghost gm-banner-btn gm-showall" onClick={() => setExpanded(s => new Set(s).add(g.repo + tone))}>Show all {g.items.length}</button>}
      </section>
    )
  }

  const footer = phase === 'review' ? (
    <>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button variant="secondary" disabled={!selected.length} onClick={() => void run(true)} title="Revalidates the selection against GitHub and deletes nothing">Check without deleting</Button>
      <Button variant="danger" icon="trash" disabled={!selected.length} onClick={() => void run(false)}>Delete {plural(selected.length, 'artifact')} permanently{selected.length ? ` (${formatBytes(bytes)})` : ''}</Button>
    </>
  ) : phase === 'running' ? (
    <Button variant="secondary" disabled={progress?.cancelling} onClick={() => void api.storageCancel()}>{progress?.cancelling ? 'Stopping after the current artifact…' : 'Stop'}</Button>
  ) : <Button variant="primary" onClick={onClose}>Close</Button>

  return (
    <Dialog open={open} onClose={phase === 'running' ? () => {} : onClose} title={phase === 'result' ? (result?.dryRun ? 'Check complete' : 'Cleanup finished') : 'Review cleanup'} width={760} dismissOnBackdrop={phase !== 'running'} footer={footer}>
      {phase === 'review' && (
        <div className="gm-cleanup">
          <p className="gm-cleanup-sum" aria-live="polite">
            <strong>{plural(selected.length, 'artifact')}</strong> from {plural(selRepos, 'repository', 'repositories')} selected · recovers <strong className="gm-stat-accent">{formatBytes(bytes)}</strong>
            {reviewSelected ? <span className="gm-warn"> · includes {plural(reviewSelected, 'artifact')} you picked from Review</span> : null}
          </p>
          <p className="gm-hint">Deleting an artifact is permanent. GitManager rechecks each one with GitHub immediately before deleting and skips anything that changed, became protected, or is no longer a candidate. Your GitHub CLI sign-in is used; no token is shown or stored.</p>
          {error && <p className="gm-field-error" role="alert">{error}</p>}
          {st.auth?.state === 'ok' && st.auth.canWrite === false && <p className="gm-field-error" role="alert">This sign-in cannot delete artifacts. Run <span className="gm-mono">gh auth refresh -s repo</span>, or use “Check without deleting”.</p>}

          {candidates.length === 0 ? <p className="muted">No verified delete candidates{repos ? ' in this selection' : ''}.</p> : (
            <>
              <div className="gm-cleanup-bulk"><Checkbox checked={allCandidates ? true : someCandidates ? 'mixed' : false} onChange={toggleAllCandidates} label="Select all verified delete candidates" /><span>All verified delete candidates <span className="faint num">({candidates.length}, {formatBytes(candidates.reduce((n, a) => n + a.sizeBytes, 0))})</span></span></div>
              {groupBy(candidates).map(g => renderGroup(g, 'candidate'))}
            </>
          )}

          {review.length > 0 && (
            <section className="gm-cleanup-extra">
              <button type="button" className="gm-disclose" aria-expanded={showReview} onClick={() => setShowReview(v => !v)}><Icon name={showReview ? 'chevron-down' : 'chevron-right'} size={14} />Review: {plural(review.length, 'uncertain artifact')} not selected</button>
              <p className="gm-hint">These are older or ambiguous. They are never selected for you; tick one only if you know it is no longer needed.</p>
              {showReview && groupBy(review).map(g => renderGroup(g, 'review'))}
            </section>
          )}

          <section className="gm-cleanup-extra">
            <button type="button" className="gm-disclose" aria-expanded={showExcluded} onClick={() => setShowExcluded(v => !v)}>
              <Icon name={showExcluded ? 'chevron-down' : 'chevron-right'} size={14} />Excluded: {excluded.protected.length} protected, {excluded.keep.length} kept{excluded.readOnly.length ? `, ${excluded.readOnly.length} in read-only repositories` : ''}
            </button>
            {showExcluded && (
              <ul className="gm-notes">
                {[...excluded.protected, ...excluded.keep].slice(0, SHOW).map(a => <li key={key(a)}><span className="gm-mono-sm">{a.repo}</span> {a.name} <span className="faint">({a.reason})</span></li>)}
                {excluded.protected.length + excluded.keep.length > SHOW && <li className="faint">and {excluded.protected.length + excluded.keep.length - SHOW} more</li>}
              </ul>
            )}
          </section>
        </div>
      )}

      {phase === 'running' && (
        <div className="gm-cleanup" aria-busy="true">
          <p className="row"><span className="sm-spinner" aria-hidden="true" /> {progress?.done ?? 0} of {progress?.total ?? selected.length} · {progress?.current ?? 'Preparing'}</p>
          <progress className="gm-progress" value={progress?.done ?? 0} max={Math.max(1, progress?.total ?? selected.length)} />
          <p className="gm-hint">Each artifact is revalidated with GitHub before it is deleted, then the repository is listed again to confirm.</p>
        </div>
      )}

      {phase === 'result' && result && <ResultView result={result} />}
    </Dialog>
  )
}

function ResultView({ result }: { result: OperationResult }) {
  const counts = new Map<Outcome, number>()
  for (const i of result.items) counts.set(i.outcome, (counts.get(i.outcome) ?? 0) + 1)
  const problems = result.items.filter(i => i.outcome !== 'deleted' && i.outcome !== 'skipped-dry-run')
  return (
    <div className="gm-cleanup">
      {result.dryRun ? (
        <p className="gm-cleanup-sum"><strong>{counts.get('skipped-dry-run') ?? 0}</strong> of {result.items.length} artifacts would be deleted. Nothing was changed.</p>
      ) : (
        <p className="gm-cleanup-sum" aria-live="polite">GitHub confirmed <strong className="gm-stat-accent">{plural(result.confirmedDeleted, 'artifact')}</strong> deleted, <strong className="gm-stat-accent">{formatBytes(result.confirmedBytes)}</strong>.</p>
      )}
      {result.stopReason && <p className="gm-field-error" role="alert">Stopped: {result.stopReason}</p>}
      <ul className="gm-notes">
        {[...counts.entries()].map(([o, n]) => <li key={o}><strong className="num">{n}</strong> {OUTCOME_TEXT[o]}</li>)}
      </ul>
      {!result.dryRun && <p className="gm-hint">Only artifacts GitHub no longer lists count as deleted. GitHub can take time to recalculate storage usage and billing after deletion, so github.com may still show the old figure for a while. The audit log in the Activity tab records each outcome.</p>}
      {problems.length > 0 && (
        <>
          <h3 className="gm-section-h">Not deleted</h3>
          <ul className="gm-notes gm-scroll-list">
            {problems.slice(0, 100).map(i => <li key={`${i.ref.repo}#${i.ref.id}`}><span className="gm-mono-sm">{i.ref.repo}</span> {i.name} <span className="faint">({OUTCOME_TEXT[i.outcome]}{i.message ? `: ${i.message}` : ''})</span></li>)}
            {problems.length > 100 && <li className="faint">and {problems.length - 100} more (see the audit log)</li>}
          </ul>
        </>
      )}
    </div>
  )
}
