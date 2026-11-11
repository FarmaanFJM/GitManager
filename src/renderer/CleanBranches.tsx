import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Checkbox, CopyButton, Details, Dialog, InlineAlert, OperationProgress } from '../../third_party/summa-ui/src/ui'
import { useToast } from '../../third_party/summa-ui/src/presets'
import type { BranchAnalysis, BranchDeleteResult, LocalBranchInfo } from '../shared/changes'
import type { BlockerAction, OpError, Repo } from '../shared/types'
import { api } from './api'
import { blockedSelection, deleteItems, eligibleNames, groupBranches, riskyCommits } from './branchSelection'
import { plural } from './util'

type Phase =
  | { kind: 'start' }
  | { kind: 'loading'; sync: boolean }
  | { kind: 'review'; analysis: BranchAnalysis }
  | { kind: 'running'; analysis: BranchAnalysis }
  | { kind: 'done'; analysis: BranchAnalysis; result: BranchDeleteResult }
  | { kind: 'error'; error: OpError }

const TAG: Record<LocalBranchInfo['category'], string> = { merged: 'Merged', pushed: 'Pushed', gone: 'Upstream gone', unique: 'Unmerged work', protected: 'Protected', current: 'Checked out', worktree: 'In worktree' }

/**
 * Deleting local branches, for one branch, a selection or a whole cleanup. The dialog analyses the branches (optionally after a fetch and prune),
 * shows what is safe, what has commits that exist only on this computer and what cannot be deleted and why, deletes exactly what is selected
 * (every branch is checked again by the backend right before), and reports each outcome with how to get a branch back. Remote branches are never touched.
 */
export function CleanBranchesDialog({ repo, mode, preselect, hasRemote, onClose, onDone, onAction }: {
  repo: Repo; mode: 'delete' | 'clean'; preselect: string[]; hasRemote: boolean
  onClose: () => void; onDone: (deleted: string[]) => void; onAction: (a: BlockerAction) => void
}) {
  const toast = useToast()
  const [phase, setPhase] = useState<Phase>(mode === 'clean' ? { kind: 'start' } : { kind: 'loading', sync: false })
  const [sync, setSync] = useState(hasRemote)
  const [selected, setSelected] = useState<Set<string>>(new Set(preselect))
  const [ack, setAck] = useState(false)
  const seq = useRef(0)
  const started = useRef(false)

  const analyse = (withSync: boolean) => {
    const n = ++seq.current
    setPhase({ kind: 'loading', sync: withSync })
    void api.branchAnalyze(repo.id, { sync: withSync }).then(r => {
      if (n !== seq.current) return
      if (!r.ok) { setPhase({ kind: 'error', error: r.error }); return }
      setSelected(prev => {
        const names = new Set(r.value.branches.map(b => b.name))
        // Cleanup starts with every branch that is safe to delete selected; deleting named branches keeps exactly those.
        const first = !started.current
        started.current = true
        const base = mode === 'clean' && first ? new Set(eligibleNames(r.value.branches)) : prev
        return new Set([...base].filter(x => names.has(x)))
      })
      setPhase({ kind: 'review', analysis: r.value })
    })
  }
  useEffect(() => { if (mode === 'delete') analyse(false); return () => { seq.current++ } }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const analysis = phase.kind === 'review' || phase.kind === 'running' || phase.kind === 'done' ? phase.analysis : null
  const groups = useMemo(() => groupBranches(analysis?.branches ?? []), [analysis])
  const forced = analysis ? analysis.branches.filter(b => selected.has(b.name) && b.tier === 'force') : []
  const risky = analysis ? riskyCommits(analysis.branches, selected) : 0
  const blocked = analysis ? blockedSelection(analysis.branches, selected) : []
  const deletable = analysis ? analysis.branches.filter(b => selected.has(b.name) && b.tier !== 'blocked') : []
  useEffect(() => { if (forced.length === 0) setAck(false) }, [forced.length])

  const toggle = (name: string, on: boolean) => setSelected(s => { const n = new Set(s); if (on) n.add(name); else n.delete(name); return n })
  const setMany = (names: string[], on: boolean) => setSelected(s => { const n = new Set(s); for (const x of names) { if (on) n.add(x); else n.delete(x) } return n })

  const run = async () => {
    if (phase.kind !== 'review') return
    const a = phase.analysis
    setPhase({ kind: 'running', analysis: a })
    const r = await api.branchDelete(repo.id, deleteItems(a.branches, selected, ack))
    if (!r.ok) { setPhase({ kind: 'error', error: r.error }); return }
    setPhase({ kind: 'done', analysis: a, result: r.value })
    onDone(r.value.deleted.map(d => d.name))
    const n = r.value.deleted.length, left = r.value.skipped.length + r.value.failed.length
    if (left === 0) toast.success(`Deleted ${plural(n, 'branch', 'branches')}`); else toast.warning(`${n} deleted, ${left} not deleted`)
  }

  const busy = phase.kind === 'loading' || phase.kind === 'running'
  const close = () => { if (phase.kind !== 'running') onClose() }

  let body: React.ReactNode, footer: React.ReactNode, title = mode === 'clean' ? 'Clean Local Branches' : 'Delete branches'
  if (phase.kind === 'start') {
    body = (
      <label className="gm-ack"><Checkbox checked={sync && hasRemote} onChange={setSync} label="Fetch and prune remote branches first" /><span>{hasRemote ? 'Fetch and prune remote branches first' : 'No remote to fetch from'}</span></label>
    )
    if (!hasRemote) body = <p className="muted gm-line">This repository has no remote. Branches are compared with what is stored locally.</p>
    footer = <><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => analyse(sync && hasRemote)} data-autofocus>Preview</Button></>
  } else if (phase.kind === 'loading') {
    body = <OperationProgress label={phase.sync ? 'Fetching, then checking branches' : 'Checking branches'} />
    footer = <Button variant="secondary" onClick={close}>Cancel</Button>
  } else if (phase.kind === 'error') {
    body = <InlineAlert tone="error">{phase.error.message}</InlineAlert>
    footer = <><Button variant="secondary" onClick={onClose}>Close</Button>{mode === 'clean' && <Button variant="primary" onClick={() => setPhase({ kind: 'start' })}>Back</Button>}</>
  } else if (phase.kind === 'done') {
    const r = phase.result
    title = r.deleted.length ? `${plural(r.deleted.length, 'branch', 'branches')} deleted` : 'Nothing deleted'
    body = <ResultView result={r} repo={repo} onAction={onAction} />
    footer = <Button variant="primary" onClick={onClose} data-autofocus>Close</Button>
  } else if (analysis) {
    const a = analysis
    const nothing = a.branches.length === 0
    body = (
      <div className="gm-clean">
        {a.sync.error && <InlineAlert tone="warn">Fetch did not complete: {a.sync.error.message} The branches below are compared with what was fetched before.</InlineAlert>}
        {a.baseProblem && <InlineAlert tone="info">{a.baseProblem}</InlineAlert>}
        {a.sync.ran && a.sync.pruned.length > 0 && (
          <Details label={`${plural(a.sync.pruned.length, 'remote branch', 'remote branches')} no longer on the remote`}><ul className="wt-plain">{a.sync.pruned.map(n => <li key={n} className="gm-mono-sm">{n}</li>)}</ul></Details>
        )}
        {nothing && <p className="muted gm-line">There are no local branches.</p>}
        {groups.safe.length > 0 && (
          <section className="gm-cl-group" aria-label="Safe to delete">
            <header className="gm-cl-head"><h3 className="gm-section-h">Safe to delete <span className="faint num">{groups.safe.length}</span></h3><span className="grow" />
              <Button variant="ghost" onClick={() => setMany(groups.safe.map(b => b.name), groups.safe.some(b => !selected.has(b.name)))}>{groups.safe.every(b => selected.has(b.name)) ? 'Select none' : 'Select all'}</Button></header>
            <ul className="gm-cl-list">{groups.safe.map(b => <BranchRowItem key={b.name} b={b} checked={selected.has(b.name)} onChange={on => toggle(b.name, on)} />)}</ul>
          </section>
        )}
        {groups.force.length > 0 && (
          <Details label={`Unmerged work, ${groups.force.length}`} defaultOpen={groups.force.some(b => selected.has(b.name))} className="gm-cl-force">
            <header className="gm-cl-head"><span className="faint">Commits that exist only on this computer</span><span className="grow" />
              <Button variant="ghost" onClick={() => setMany(groups.force.map(b => b.name), groups.force.some(b => !selected.has(b.name)))}>{groups.force.every(b => selected.has(b.name)) ? 'Select none' : 'Select all'}</Button></header>
            <ul className="gm-cl-list">{groups.force.map(b => <BranchRowItem key={b.name} b={b} checked={selected.has(b.name)} onChange={on => toggle(b.name, on)} />)}</ul>
          </Details>
        )}
        {groups.blocked.length > 0 && (
          <Details label={`Cannot be deleted, ${groups.blocked.length}`} defaultOpen={blocked.length > 0} className="gm-cl-blocked">
            <ul className="gm-cl-list">
              {groups.blocked.map(b => (
                <li key={b.name} className="gm-cl-item gm-cl-item-blocked">
                  <span className="gm-mono-sm truncate">{b.name}</span><span className="faint gm-cl-why">{b.blocker?.message}</span>
                  {(b.blocker?.blocker?.actions ?? []).map(x => <Button key={x.id} variant="secondary" onClick={() => onAction(x)}>{x.label}</Button>)}
                </li>
              ))}
            </ul>
          </Details>
        )}
        {forced.length > 0 && (
          <InlineAlert tone="warn" className="gm-cl-warn">
            <span>{plural(risky, 'commit')} on {plural(forced.length, 'branch', 'branches')} exist{risky === 1 ? 's' : ''} nowhere else. Force deleting uses <code>git branch -D</code>; the commits stay recoverable from the commit ids shown afterwards, for as long as Git keeps them.</span>
            <label className="gm-ack"><Checkbox checked={ack} onChange={setAck} label="I understand these commits exist only on this computer" /><span>I understand these commits exist only on this computer</span></label>
          </InlineAlert>
        )}
      </div>
    )
    const n = deletable.length
    footer = (
      <>
        <span className="wt-foot-note">Remote branches are not affected.</span>
        <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="danger" icon="trash" disabled={n === 0 || (forced.length > 0 && !ack) || busy} aria-busy={phase.kind === 'running' || undefined} onClick={() => void run()}>
          {forced.length > 0 ? `Force delete ${n}` : n > 0 ? `Delete ${plural(n, 'branch', 'branches')}` : 'Delete branches'}
        </Button>
      </>
    )
  }
  if (phase.kind === 'running') {
    body = <OperationProgress label="Deleting branches" />
    footer = <Button variant="secondary" disabled>Deleting</Button>
  }

  return <Dialog open onClose={close} title={title} role="alertdialog" width={600} footer={footer}>{body}</Dialog>
}

function BranchRowItem({ b, checked, onChange }: { b: LocalBranchInfo; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <li className="gm-cl-item">
      <label className="gm-cl-main">
        <Checkbox checked={checked} onChange={onChange} label={`${b.name}, ${TAG[b.category]}`} />
        <span className="gm-mono-sm truncate" title={b.name}>{b.name}</span>
        <span className={`gm-cl-tag ${b.tier === 'force' ? 'gm-warn' : 'faint'}`} title={b.note}>{b.tier === 'force' ? `${plural(b.onlyHereCount, 'commit')} only here` : TAG[b.category]}</span>
      </label>
      {b.tier === 'force' && <p className="faint gm-cl-note">{b.note}{b.onRemotes.length ? ` Part of it is also on ${b.onRemotes.slice(0, 2).join(', ')}.` : ' No remote has any of them.'}</p>}
    </li>
  )
}

function ResultView({ result, repo, onAction }: { result: BranchDeleteResult; repo: Repo; onAction: (a: BlockerAction) => void }) {
  const toast = useToast()
  const [restored, setRestored] = useState<Set<string>>(new Set())
  const restore = async (name: string) => {
    const recs = await api.branchRecovery(repo.id)
    const rec = recs.ok ? recs.value.find(r => r.name === name) : null
    if (!rec) { toast.error('No recovery record'); return }
    const r = await api.branchRestore(repo.id, rec.id)
    if (r.ok) { setRestored(s => new Set(s).add(name)); toast.success(`Restored ${name}`) } else toast.error(r.error.message)
  }
  return (
    <div className="gm-clean">
      {[...result.skipped.map(s => ({ ...s, kind: 'Skipped' })), ...result.failed.map(s => ({ ...s, kind: 'Failed' }))].length > 0 && (
        <ul className="wt-failures" aria-label="Not deleted">
          {[...result.skipped, ...result.failed].map(s => (
            <li key={s.name}><span className="gm-mono-sm">{s.name}</span><span className="gm-warn">{s.error.message}</span>
              {(s.error.blocker?.actions ?? []).filter(a => a.id !== 'force-delete').map(a => <Button key={a.id} variant="secondary" onClick={() => onAction(a)}>{a.label}</Button>)}
            </li>
          ))}
        </ul>
      )}
      {result.deleted.length > 0 && (
        <Details label={`Recover ${plural(result.deleted.length, 'branch', 'branches')}`} defaultOpen={result.deleted.some(d => d.forced)}>
          <ul className="wt-recover">
            {result.deleted.map(d => (
              <li key={d.name}>
                <span className="gm-mono-sm">{d.recoverWith}</span>
                <CopyButton value={d.recoverWith} label={`Copy recovery command for ${d.name}`} />
                <Button variant="ghost" disabled={restored.has(d.name)} onClick={() => void restore(d.name)}>{restored.has(d.name) ? 'Restored' : 'Restore'}</Button>
              </li>
            ))}
          </ul>
        </Details>
      )}
      {result.deleted.length === 0 && result.skipped.length + result.failed.length === 0 && <p className="muted gm-line">Nothing was selected.</p>}
    </div>
  )
}
