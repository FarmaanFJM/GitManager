import { useEffect, useRef, useState } from 'react'
import { Button, Checkbox, CopyButton, Details, Dialog, InlineAlert, OperationProgress } from '../../third_party/summa-ui/src/ui'
import type { OpError, Repo } from '../shared/types'
import type { StaleBranch, SyncPlan, SyncResult, SyncSelection } from '../shared/gitflow'
import { api } from './api'
import { plural } from './util'

/* ------------------------------------------------------------------ pure helpers (unit tested) */

/** What a stale branch is for the current choices: a stale current branch can be deleted once the switch is on. */
export function effectiveKind(b: StaleBranch, plan: SyncPlan, switchFirst: boolean): StaleBranch['kind'] {
  if (b.kind === 'protected' && b.worktree?.current && b.wouldBe && b.name !== plan.defaultBranch && switchFirst && plan.switchTo?.safe) return b.wouldBe
  return b.kind
}

/** Delete-safe branches start selected. Needs-review and protected ones never do: forcing is an explicit choice. */
export function defaultSelected(plan: SyncPlan): string[] {
  return plan.stale.filter(b => b.kind === 'delete-safe').map(b => b.name)
}

/** The plan has nothing to decide: close and say Synced. */
export function isNothingToDo(plan: SyncPlan): boolean { return plan.stale.length === 0 }

/** Dialog title. The backend's summary text ('4 stale branches found'), with a fallback so the title is never empty. */
export function planTitle(plan: SyncPlan): string {
  return plan.summary.text || (plan.stale.length ? `${plural(plan.stale.length, 'stale branch', 'stale branches')} found` : 'Synced')
}

/** Selected names that can really be deleted, in plan order, and the subset that needs the force choice. */
export function buildSelection(plan: SyncPlan, selected: ReadonlySet<string>, switchFirst: boolean): SyncSelection {
  const rows = plan.stale.filter(b => selected.has(b.name) && effectiveKind(b, plan, switchFirst) !== 'protected')
  const forceBranches = rows.filter(b => effectiveKind(b, plan, switchFirst) === 'needs-review').map(b => b.name)
  return { branches: rows.map(b => b.name), ...(forceBranches.length ? { forceBranches } : {}), ...(switchFirst && plan.switchTo?.safe ? { switchToDefault: true } : {}) }
}

export const deleteLabel = (n: number) => (n > 0 ? `Delete ${plural(n, 'branch', 'branches')}` : 'Delete branches')

/** Toast text after executing: 'Synced' only when everything requested succeeded. */
export function finishText(r: SyncResult): string {
  if (r.failed.length === 0) return 'Synced'
  return `${r.deleted.length} deleted, ${r.failed.length} failed`
}

export function resultTitle(r: SyncResult): string {
  if (r.failed.length === 0) return r.deleted.length ? `${r.deleted.length} deleted` : 'Nothing deleted'
  return `${r.deleted.length} deleted, ${r.failed.length} failed`
}

/* ------------------------------------------------------------------ dialog */

type Phase = { kind: 'planning' } | { kind: 'error'; error: OpError } | { kind: 'plan'; plan: SyncPlan } | { kind: 'running'; plan: SyncPlan } | { kind: 'done'; plan: SyncPlan; result: SyncResult }

function ErrorAlert({ error, label }: { error: OpError; label: string }) {
  return (
    <>
      <InlineAlert tone="error">{error.message || label}</InlineAlert>
      {error.detail && <Details label="Details"><pre className="wt-pre">{error.detail}</pre></Details>}
    </>
  )
}

/**
 * Sync with Remote. Opening it fetches and prunes (api.syncPlan, which deletes nothing) and shows what is stale.
 * With nothing stale it closes at once and reports 'Synced'. Otherwise the user picks the branches to delete.
 * `onFinished` is called once with 'Synced' or a short failure summary, right after the delete finishes (the dialog stays open
 * on its result so recovery commands are never lost); the parent should refresh and toast, and must not close the dialog itself.
 */
export function SyncDialog({ repo, open, onClose, onFinished }: { repo: Repo; open: boolean; onClose: () => void; onFinished: (text: string) => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'planning' })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [switchFirst, setSwitchFirst] = useState(false)
  const [runError, setRunError] = useState<OpError | null>(null)
  const seq = useRef(0)
  const cbs = useRef({ onClose, onFinished })
  cbs.current = { onClose, onFinished }

  const load = () => {
    const n = ++seq.current
    setPhase({ kind: 'planning' }); setSelected(new Set()); setSwitchFirst(false); setRunError(null)
    void api.syncPlan(repo.id).then(r => {
      if (n !== seq.current) return
      if (!r.ok) { setPhase({ kind: 'error', error: r.error }); return }
      if (isNothingToDo(r.value)) { cbs.current.onClose(); cbs.current.onFinished('Synced'); return }
      setSelected(new Set(defaultSelected(r.value)))
      setPhase({ kind: 'plan', plan: r.value })
    })
  }
  useEffect(() => {
    if (!open) { seq.current++; return }
    load()
    return () => { seq.current++ }
  }, [open, repo.id]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null
  const busy = phase.kind === 'planning' || phase.kind === 'running'
  const safeClose = () => { if (phase.kind !== 'running') onClose() }

  if (phase.kind === 'planning') {
    return <Dialog open onClose={safeClose} title="Sync with Remote" width={520}><OperationProgress label="Syncing" /></Dialog>
  }
  if (phase.kind === 'error') {
    return (
      <Dialog open onClose={onClose} title="Sync failed" width={520}
        footer={<><Button variant="secondary" onClick={onClose}>Close</Button><Button variant="primary" onClick={load}>Try again</Button></>}>
        <ErrorAlert error={phase.error} label="Sync failed" />
      </Dialog>
    )
  }
  if (phase.kind === 'done') {
    const { result } = phase
    return (
      <Dialog open onClose={onClose} title={resultTitle(result)} width={520} footer={<Button variant="primary" onClick={onClose} data-autofocus>Close</Button>}>
        <div className="wt-stack">
          {result.switched && <p className="muted wt-line">Switched to {result.switched.to}</p>}
          {result.failed.length > 0 && (
            <ul className="wt-failures" aria-label="Not deleted">
              {result.failed.map(f => <li key={f.name}><span className="gm-mono-sm">{f.name}</span><span className="gm-warn">{f.reason}</span></li>)}
            </ul>
          )}
          {result.deleted.length > 0 && (
            <Details label={`Recover ${plural(result.deleted.length, 'branch', 'branches')}`}>
              <ul className="wt-recover">
                {result.deleted.map(d => (
                  <li key={d.name}>
                    <span className="gm-mono-sm">{d.recoverWith}</span>
                    <CopyButton value={d.recoverWith} label={`Copy recovery command for ${d.name}`} />
                  </li>
                ))}
              </ul>
            </Details>
          )}
          {phase.plan.pruned.length > 0 && <PrunedDetails pruned={phase.plan.pruned} />}
        </div>
      </Dialog>
    )
  }

  const { plan } = phase
  const running = phase.kind === 'running'
  const sel = buildSelection(plan, selected, switchFirst)
  const forced = sel.forceBranches?.length ?? 0
  const toggle = (name: string, on: boolean) => setSelected(s => { const n = new Set(s); if (on) n.add(name); else n.delete(name); return n })
  const onSwitch = (on: boolean) => {
    setSwitchFirst(on)
    // A stale current branch that is merged becomes deletable with the switch, so it is chosen along with it.
    const cur = plan.stale.find(b => b.worktree?.current && b.wouldBe === 'delete-safe' && b.kind === 'protected' && b.name !== plan.defaultBranch)
    if (cur) toggle(cur.name, on)
    else if (!on) setSelected(s => new Set([...s].filter(n => plan.stale.find(b => b.name === n)?.kind !== 'protected')))
  }

  const run = async () => {
    setRunError(null)
    setPhase({ kind: 'running', plan })
    const r = await api.syncExecute(repo.id, sel)
    if (!r.ok) { setRunError(r.error); setPhase({ kind: 'plan', plan }); return }
    setPhase({ kind: 'done', plan, result: r.value })
    cbs.current.onFinished(finishText(r.value))
  }

  const footer = (
    <>
      {forced > 0 && <span className="wt-foot-note" role="status">Deletes branches with commits not on {plan.defaultBranch}</span>}
      <Button variant="secondary" onClick={onClose} data-autofocus disabled={running}>Cancel</Button>
      <Button variant="danger" icon="trash" disabled={sel.branches.length === 0 || running} aria-busy={running || undefined} onClick={() => void run()}>
        {running && <span className="sm-spinner" aria-hidden="true" />}{deleteLabel(sel.branches.length)}
      </Button>
    </>
  )

  return (
    <Dialog open onClose={running ? () => {} : onClose} title={planTitle(plan)} role="alertdialog" width={560} footer={footer}>
      <div className="wt-stack">
        {runError && <ErrorAlert error={runError} label="Delete failed" />}
        <ul className="wt-stale" aria-label="Stale branches">
          {plan.stale.map(b => <StaleRow key={b.name} b={b} plan={plan} switchFirst={switchFirst} checked={selected.has(b.name)} disabled={running} onChange={on => toggle(b.name, on)} />)}
        </ul>
        {plan.switchTo && (
          plan.switchTo.safe
            ? <label className="gm-ack wt-switch"><Checkbox checked={switchFirst} onChange={onSwitch} label={`Switch to ${plan.switchTo.branch} first`} /><span>Switch to {plan.switchTo.branch} first</span></label>
            : <p className="muted wt-line">Cannot switch to {plan.switchTo.branch}. {plan.switchTo.reason}</p>
        )}
        {plan.kept.length > 0 && (
          <Details label={`${plural(plan.kept.length, 'local-only branch', 'local-only branches')} kept`}>
            <ul className="wt-plain">{plan.kept.map(n => <li key={n} className="gm-mono-sm">{n}</li>)}</ul>
          </Details>
        )}
        {plan.pruned.length > 0 && <PrunedDetails pruned={plan.pruned} />}
      </div>
    </Dialog>
  )
}

function PrunedDetails({ pruned }: { pruned: string[] }) {
  return (
    <Details label={`${plural(pruned.length, 'remote ref', 'remote refs')} pruned`}>
      <ul className="wt-plain">{pruned.map(n => <li key={n} className="gm-mono-sm">{n}</li>)}</ul>
    </Details>
  )
}

function StaleRow({ b, plan, switchFirst, checked, disabled, onChange }: { b: StaleBranch; plan: SyncPlan; switchFirst: boolean; checked: boolean; disabled: boolean; onChange: (on: boolean) => void }) {
  const kind = effectiveKind(b, plan, switchFirst)
  const note = kind === 'needs-review' ? `Unmerged work, ${plural(b.ahead, 'commit')}` : kind === 'protected' ? b.reason : b.worktree?.current ? 'Current branch' : ''
  const recover = `git branch ${b.name} ${b.sha}`
  return (
    <li className="wt-srow" data-kind={kind}>
      {kind === 'protected'
        ? (
          <div className="wt-srow-main" title={b.reason}>
            <span className="checkbox" role="checkbox" aria-checked={false} aria-disabled="true" tabIndex={0} aria-label={`${b.name}, cannot be deleted. ${b.reason}`} />
            <span className="gm-mono-sm truncate">{b.name}</span>
            <span className="wt-srow-note faint">{note}</span>
          </div>
        )
        : (
          <label className="wt-srow-main">
            <Checkbox checked={checked} onChange={disabled ? () => {} : onChange} label={`${b.name}${kind === 'needs-review' ? `, unmerged work, ${plural(b.ahead, 'commit')}` : ''}`} />
            <span className="gm-mono-sm truncate">{b.name}</span>
            {note && <span className={`wt-srow-note ${kind === 'needs-review' ? 'gm-warn' : 'faint'}`}>{note}</span>}
          </label>
        )}
      {kind === 'needs-review' && (
        <Details label="Details">
          <ul className="wt-commits">
            {b.uniqueCommits.map(c => <li key={c.hash}><span className="gm-mono-sm faint">{c.short}</span><span className="truncate">{c.subject}</span></li>)}
            {b.ahead > b.uniqueCommits.length && <li className="faint">and {b.ahead - b.uniqueCommits.length} more</li>}
          </ul>
          <div className="wt-recover-line"><span className="faint">Recover with</span><span className="gm-mono-sm">{recover}</span><CopyButton value={recover} label={`Copy recovery command for ${b.name}`} /></div>
        </Details>
      )}
    </li>
  )
}
