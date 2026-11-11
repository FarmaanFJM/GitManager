import { useCallback, useEffect, useState } from 'react'
import { Button, Dialog, MenuButton, Switch, Tag } from '../../third_party/summa-ui/src/ui'
import { useConfirm, useToast } from '../../third_party/summa-ui/src/presets'
import type { StashEntry } from '../shared/changes'
import type { OpError, Repo } from '../shared/types'
import { api } from './api'
import { ago, plural } from './util'

/**
 * Stashes of one repository: stash the current changes (with an optional message and untracked files), see what each one holds, and
 * apply, pop or drop it. Apply and pop never overwrite local changes: a stash that touches a changed file is refused and the files named.
 */
export function StashPanel({ repo, reloadKey, previewing, onStash, onPreview, onChanged, onError, onCount }: {
  repo: Repo; reloadKey: number; previewing: string | null; onStash: () => void
  onPreview: (e: StashEntry | null) => void; onChanged: () => void; onError: (e: OpError) => void; onCount: (n: number) => void
}) {
  const [list, setList] = useState<StashEntry[] | null>(null)
  const confirm = useConfirm()
  const toast = useToast()

  const load = useCallback(async () => {
    const r = await api.stashList(repo.id)
    if (r.ok) { setList(r.value); onCount(r.value.length) } else onError(r.error)
  }, [repo.id, onError, onCount])
  useEffect(() => { void load() }, [load, reloadKey])
  const apply = async (e: StashEntry, pop: boolean) => {
    const r = pop ? await api.stashPop(repo.id, e.index, e.sha) : await api.stashApply(repo.id, e.index, e.sha)
    if (!r.ok) { onError(r.error); return }
    if (r.value.conflicts.length) toast.warning(`${plural(r.value.conflicts.length, 'conflict')}${pop ? '. The stash was kept.' : ''}`)
    else toast.success(pop ? 'Popped' : 'Applied')
    onChanged()
  }
  const drop = async (e: StashEntry) => {
    const yes = await confirm({
      title: 'Drop this stash?', description: 'The changes in it are removed from the list.', target: `${e.ref}: ${e.message}`, destructive: true, confirmLabel: 'Drop stash',
      consequences: [`Recover afterwards with: git stash apply ${e.sha.slice(0, 12)}`],
    })
    if (!yes) return
    const r = await api.stashDrop(repo.id, e.index, e.sha, true)
    if (!r.ok) { onError(r.error); return }
    if (previewing === e.sha) onPreview(null)
    toast.success('Dropped')
    onChanged()
  }

  return (
    <div className="gm-stashes">
      <div className="gm-stash-top">
        <Button variant="ghost" icon="archive" onClick={onStash}>Stash changes</Button>
      </div>
      {list && list.length === 0 && <p className="faint gm-stash-empty">No stashes</p>}
      <ul className="gm-stash-list">
        {(list ?? []).map(e => (
          <li key={e.sha} className="gm-stash" data-active={previewing === e.sha || undefined}>
            <button type="button" className="gm-stash-main" onClick={() => onPreview(previewing === e.sha ? null : e)} aria-pressed={previewing === e.sha}>
              <span className="truncate">{e.message || e.ref}</span>
              <span className="faint">{e.branch ?? ''} · {ago(e.date)}</span>
              {e.hasUntracked && <Tag>+ untracked</Tag>}
            </button>
            <MenuButton label={`Actions for ${e.ref}`} size="sm" items={[
              { label: 'Preview', icon: 'search', onSelect: () => onPreview(e) },
              { label: 'Apply', icon: 'download', onSelect: () => void apply(e, false) },
              { label: 'Pop', icon: 'upload', onSelect: () => void apply(e, true) },
              { type: 'sep' },
              { label: 'Drop…', icon: 'trash', danger: true, onSelect: () => void drop(e) },
            ]} />
          </li>
        ))}
      </ul>
    </div>
  )
}

/** The "Stash changes" form: an optional message and whether untracked files go too. Lives outside the (collapsible) list so a blocked pull can open it directly. */
export function StashDialog({ repo, open, onClose, onError, onDone }: { repo: Repo; open: boolean; onClose: () => void; onError: (e: OpError) => void; onDone: () => void }) {
  const toast = useToast()
  const [message, setMessage] = useState('')
  const [untracked, setUntracked] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (open) { setMessage(''); setBusy(false) } }, [open])
  const push = async () => {
    setBusy(true)
    const r = await api.stashPush(repo.id, { message: message.trim() || undefined, includeUntracked: untracked })
    setBusy(false)
    onClose()
    if (!r.ok) { onError(r.error); return }
    toast.success('Stashed')
    onDone()
  }
  return (
    <Dialog open={open} onClose={() => { if (!busy) onClose() }} title="Stash changes" width={440}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" onClick={() => void push()} disabled={busy} aria-busy={busy || undefined}>{busy && <span className="sm-spinner" aria-hidden="true" />}Stash</Button></>}>
      <form className="gm-stash-form" onSubmit={e => { e.preventDefault(); void push() }}>
        <input className="input" aria-label="Stash message" placeholder="Message (optional)" maxLength={300} value={message} onChange={e => setMessage(e.target.value)} data-autofocus />
        <label className="gm-switch-row"><Switch checked={untracked} onChange={setUntracked} label="Include untracked files" /><span>Include untracked files</span></label>
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}
