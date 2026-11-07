import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActionRow, Button, Checkbox, Details, Dialog, Dropdown, InlineAlert, MenuButton, Tabs, Tag, useCopy, type MenuEntry } from '../../third_party/summa-ui/src/ui'
import { useConfirm, useToast } from '../../third_party/summa-ui/src/presets'
import type { Branch, OpError, Repo, ServiceState } from '../shared/types'
import type { WorktreeBlocker, WorktreeInfo, WorktreeRemovalCheck } from '../shared/gitflow'
import { api } from './api'
import type { Actions, Model } from './App'
import { ErrorBanner } from './Workspace'
import { plural } from './util'

/* ------------------------------------------------------------------ pure helpers (unit tested) */

const slashes = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')

/** Same folder? Windows paths (drive letter or UNC) compare case-insensitively. */
export function samePath(a: string, b: string): boolean {
  const x = slashes(a), y = slashes(b)
  const win = /^([a-z]:|\/\/)/i.test(x)
  return win ? x.toLowerCase() === y.toLowerCase() : x === y
}

/** Middle-shortened path for a row; the full path stays in the title and in Copy Path. */
export function shortPath(p: string, max = 44): string {
  const s = slashes(p)
  if (s.length <= max) return s
  const parts = s.split('/').filter(Boolean)
  if (parts.length <= 3) return s
  const lead = s.startsWith('//') ? `//${parts[0]}` : s.startsWith('/') ? '' : parts[0]
  return `${lead}/…/${parts.slice(-2).join('/')}`
}

export function changedCount(w: WorktreeInfo): number {
  const c = w.changes
  return c ? c.staged + c.unstaged + c.untracked + c.conflicted : 0
}

/** 'Clean' or '3 changed files', then plain-text flags. Nothing is shown for status that was not read. */
export function statusText(w: WorktreeInfo, running = 0): string {
  const parts: string[] = []
  if (w.changes) { const n = changedCount(w); parts.push(n === 0 ? 'Clean' : plural(n, 'changed file')) }
  if (w.locked) parts.push('Locked')
  if (w.prunable) parts.push('Prunable')
  if (running > 0) parts.push(`${running} running`)
  return parts.join(', ')
}

/** Local branches that can still get a worktree: git allows a branch in only one worktree. */
export function availableBranches(branches: Branch[], worktrees: WorktreeInfo[]): Branch[] {
  const used = new Set(worktrees.map(w => w.branch).filter((b): b is string => !!b))
  return branches.filter(b => b.kind === 'local' && !used.has(b.name))
}

export const hasPrunable = (list: WorktreeInfo[]) => list.some(w => w.prunable)

const ALIVE: ServiceState[] = ['starting', 'running', 'ready']

/** Profiles bound to a worktree folder; a profile without worktreePath runs in the repository root (the current worktree). */
export function profileIdsAt(w: WorktreeInfo, profiles: { id: string; repoId: string; worktreePath?: string }[], repoId: string): Set<string> {
  return new Set(profiles.filter(p => p.repoId === repoId && (p.worktreePath ? samePath(p.worktreePath, w.path) : w.isCurrent)).map(p => p.id))
}

/** How the user confirms discarding what the blocker stands for. */
export function discardLabel(b: WorktreeBlocker, w: WorktreeInfo): string {
  if (b.code === 'dirty') { const n = changedCount(w); return n > 0 ? `Discard ${plural(n, 'changed file')}` : 'Discard changes' }
  if (b.code === 'detached-commits') return 'Discard commits not on any branch'
  return b.message
}

/** One short line each, for the confirmation dialog. */
export function removeConsequences(c: WorktreeRemovalCheck): string[] {
  const w = c.worktree
  const out = ['Deletes the folder and its checkout']
  if (w.branch) out.push(`Branch ${w.branch} is kept`)
  if (c.unpushed > 0) out.push(`${plural(c.unpushed, 'commit')} not on any remote`)
  return out
}

export const hardBlockers = (c: WorktreeRemovalCheck) => c.blockers.filter(b => !b.overridable)
export const softBlockers = (c: WorktreeRemovalCheck) => c.blockers.filter(b => b.overridable)

/** The remove button is enabled when nothing hard blocks it and every overridable blocker was acknowledged. */
export function canRemove(c: WorktreeRemovalCheck, acked: ReadonlySet<string>): boolean {
  return hardBlockers(c).length === 0 && softBlockers(c).every(b => acked.has(b.code))
}

/* ------------------------------------------------------------------ panel */

function ErrorLine({ error }: { error: OpError }) {
  return (
    <>
      <InlineAlert tone="error">{error.message}</InlineAlert>
      {error.detail && <Details><pre className="wt-pre">{error.detail}</pre></Details>}
    </>
  )
}

/** The repository's Worktrees tab: one compact row per worktree, with Create worktree in the header. */
export function WorktreesPanel({ model, actions, repo }: { model: Model; actions: Actions; repo: Repo }) {
  const [list, setList] = useState<WorktreeInfo[] | null>(null)
  const [error, setError] = useState<OpError | null>(null)
  const [creating, setCreating] = useState(false)
  const [removing, setRemoving] = useState<WorktreeRemovalCheck | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const seq = useRef(0)
  const confirm = useConfirm()
  const toast = useToast()
  const { copy } = useCopy()

  const load = useCallback(async () => {
    const n = ++seq.current
    const r = await api.worktreeList(repo.id)
    if (n !== seq.current) return
    if (r.ok) { setList(r.value); setError(null) } else setError(r.error)
  }, [repo.id])
  useEffect(() => { setList(null); void load() }, [load])

  const changed = useCallback(async () => { await load(); await actions.refresh(repo.id) }, [load, actions, repo.id])

  const running = useCallback((w: WorktreeInfo) => {
    const ids = profileIdsAt(w, model.data.profiles, repo.id)
    return Object.values(model.services).filter(s => ids.has(s.profileId) && ALIVE.includes(s.state)).length
  }, [model.data.profiles, model.services, repo.id])

  const locationOf = (w: WorktreeInfo) => ({ ...repo.location, path: w.path })

  const switchView = async (w: WorktreeInfo) => {
    const loc = locationOf(w)
    const known = model.data.repos.find(r => r.location.kind === loc.kind && (r.location.kind !== 'wsl' || loc.kind !== 'wsl' || r.location.distro === loc.distro) && samePath(r.location.path, w.path))
    if (known) { actions.select(known.id); return }
    setBusy(w.path)
    const r = await api.addRepo(w.path, repo.location.kind === 'wsl' ? repo.location.distro : undefined)
    setBusy(null)
    if (!r.ok) { setError(r.error); return }
    await actions.reload()
    actions.select(r.value.repo.id)
  }

  const startRemove = async (w: WorktreeInfo) => {
    setBusy(w.path); setError(null)
    const r = await api.worktreeCheck(repo.id, w.path)
    setBusy(null)
    if (!r.ok) { setError(r.error); return }
    const c = r.value
    if (c.blockers.length > 0) { setRemoving(c); return }
    const ok = await confirm({ title: 'Remove worktree?', confirmLabel: 'Remove worktree', destructive: true, target: w.path, consequences: removeConsequences(c) })
    if (!ok) return
    const done = await api.worktreeRemove(repo.id, w.path, false)
    if (!done.ok) { setError(done.error); void load(); return }
    toast.neutral('Worktree removed')
    await changed()
  }

  const prune = async () => {
    const targets = (list ?? []).filter(w => w.prunable)
    const ok = await confirm({ title: 'Prune worktrees?', confirmLabel: 'Prune', consequences: targets.map(w => w.path), description: 'Forgets worktrees whose folders are missing.' })
    if (!ok) return
    const r = await api.worktreePrune(repo.id)
    if (!r.ok) { setError(r.error); return }
    toast.neutral(r.value.pruned.length ? `${r.value.pruned.length} pruned` : 'Nothing to prune')
    await changed()
  }

  const menuFor = (w: WorktreeInfo): MenuEntry[] => [
    { label: 'Terminal Here', icon: 'terminal', onSelect: () => actions.openTerminal({ type: 'path', location: locationOf(w) }) },
    ...(w.isCurrent ? [{ label: 'Open Folder', icon: 'folder-open' as const, onSelect: () => { void api.openFolder(repo.id).then(r => { if (!r.ok) setError(r.error) }) } }] : []),
    { label: 'Copy Path', icon: 'copy', onSelect: () => { void copy(w.path) } },
    ...(!w.isCurrent ? [{ label: 'Switch View', icon: 'arrow-right' as const, onSelect: () => { void switchView(w) } }] : []),
    { type: 'sep' },
    { label: 'Remove Worktree', icon: 'trash', danger: true, onSelect: () => { void startRemove(w) } },
  ]

  const prunable = list ? hasPrunable(list) : false

  return (
    <div className="wt-panel">
      <div className="gm-toolbar wt-toolbar">
        <span className="grow" />
        {prunable && <MenuButton label="More worktree actions" items={[{ label: 'Prune', icon: 'refresh', onSelect: () => { void prune() } }]} />}
        <Button variant="primary" icon="plus" onClick={() => setCreating(true)} disabled={!list}>Create worktree</Button>
      </div>
      {error && <ErrorBanner error={error} onDismiss={() => setError(null)} />}
      {!list && !error ? (
        <div className="gm-scroll" aria-busy="true">{[60, 44].map((w, i) => <div key={i} className="gm-brow sk"><span /><span className="skeleton" style={{ width: `${w}%`, height: 10 }} /></div>)}</div>
      ) : list && (
        <div className="gm-scroll scroll wt-list" role="list" aria-label="Worktrees">
          {list.map(w => {
            const name = w.branch ?? 'detached'
            const status = statusText(w, running(w))
            return (
              <div role="listitem" key={w.path}>
                <ActionRow
                  label={`Worktree ${name}`}
                  name={<span className="wt-name"><span className="wt-branch truncate">{name}</span>{w.isCurrent && <Tag>Current</Tag>}<span className="wt-path gm-mono-sm truncate faint" title={w.path}>{shortPath(w.path)}</span></span>}
                  status={status ? <span className={`wt-status ${w.prunable ? 'gm-warn' : 'muted'}`} title={w.prunableReason ?? w.lockReason}>{status}</span> : undefined}
                  action={<Button icon="terminal" disabled={busy === w.path} aria-label={`Terminal in ${name}`} onClick={() => actions.openTerminal({ type: 'path', location: locationOf(w) })}>Terminal</Button>}
                  menu={menuFor(w)} menuLabel={`Actions for ${name}`}
                  onOpen={() => actions.openTerminal({ type: 'path', location: locationOf(w) })}
                />
              </div>
            )
          })}
        </div>
      )}
      {creating && list && <CreateDialog repo={repo} worktrees={list} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); toast.neutral('Worktree created'); void changed() }} />}
      {removing && <RemoveDialog repo={repo} check={removing} onClose={() => setRemoving(null)} onRemoved={() => { setRemoving(null); toast.neutral('Worktree removed'); void changed() }} />}
    </div>
  )
}

/* ------------------------------------------------------------------ create */

function CreateDialog({ repo, worktrees, onClose, onCreated }: { repo: Repo; worktrees: WorktreeInfo[]; onClose: () => void; onCreated: () => void }) {
  const [branches, setBranches] = useState<Branch[] | null>(null)
  const [mode, setMode] = useState<'existing' | 'new'>('existing')
  const [existing, setExisting] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [base, setBase] = useState<string | null>(null)
  const [folder, setFolder] = useState('')
  const [touched, setTouched] = useState(false)
  const [error, setError] = useState<OpError | null>(null)
  const [busy, setBusy] = useState(false)
  const suggestSeq = useRef(0)

  useEffect(() => {
    void api.branches(repo.id).then(r => {
      if (!r.ok) { setError(r.error); setBranches([]); return }
      setBranches(r.value)
      setBase(r.value.find(b => b.kind === 'local' && b.current)?.name ?? null)
      if (availableBranches(r.value, worktrees).length === 0) setMode('new')
    })
  }, [repo.id, worktrees])

  const available = useMemo(() => availableBranches(branches ?? [], worktrees), [branches, worktrees])
  const branch = (mode === 'existing' ? existing : name.trim()) ?? ''

  // The folder follows the branch until the user edits it.
  useEffect(() => {
    if (touched || !branch) return
    const n = ++suggestSeq.current
    const t = window.setTimeout(() => {
      void api.worktreeSuggest(repo.id, branch).then(r => { if (n === suggestSeq.current && r.ok) setFolder(r.value.path) })
    }, 200)
    return () => window.clearTimeout(t)
  }, [branch, touched, repo.id])

  const ready = !!branch && !!folder.trim() && !busy
  const submit = async () => {
    if (!ready) return
    setBusy(true); setError(null)
    const r = await api.worktreeAdd(repo.id, { path: folder.trim(), branch, create: mode === 'new', ...(mode === 'new' && base ? { base } : {}) })
    setBusy(false)
    if (r.ok) onCreated(); else setError(r.error)
  }
  const enter = (e: React.KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); void submit() } }

  return (
    <Dialog open onClose={busy ? () => {} : onClose} title="Create worktree" width={520}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" disabled={!ready} aria-busy={busy || undefined} onClick={() => void submit()}>{busy && <span className="sm-spinner" aria-hidden="true" />}Create worktree</Button></>}>
      <div className="wt-form">
        <Tabs label="Branch source" flat value={mode} onChange={m => { setMode(m); setError(null) }} items={[{ value: 'existing', label: 'Existing branch' }, { value: 'new', label: 'New branch' }]} />
        {mode === 'existing' ? (
          <div className="sm-dialog__field">
            <span className="sm-dialog__label">Branch</span>
            <Dropdown label="Branch" searchable value={existing} onChange={setExisting} placeholder={branches && available.length === 0 ? 'None available' : 'Choose a branch'}
              options={available.map(b => ({ value: b.name, label: b.name }))} />
          </div>
        ) : (
          <>
            <div className="sm-dialog__field">
              <label className="sm-dialog__label" htmlFor="wt-new-branch">Branch name</label>
              <input id="wt-new-branch" className="input" value={name} autoComplete="off" spellCheck={false} autoFocus onChange={e => setName(e.target.value)} onKeyDown={enter} />
            </div>
            <div className="sm-dialog__field">
              <span className="sm-dialog__label">Based on</span>
              <Dropdown label="Base" searchable value={base} onChange={setBase} placeholder="Current commit"
                options={(branches ?? []).map(b => ({ value: b.name, label: b.name, meta: b.kind === 'remote' ? 'remote' : undefined }))} />
            </div>
          </>
        )}
        <div className="sm-dialog__field">
          <label className="sm-dialog__label" htmlFor="wt-folder">Folder</label>
          <input id="wt-folder" className="input gm-mono-sm" value={folder} autoComplete="off" spellCheck={false} onChange={e => { setFolder(e.target.value); setTouched(true) }} onKeyDown={enter} />
        </div>
        {error && <ErrorLine error={error} />}
      </div>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ remove (with blockers) */

function RemoveDialog({ repo, check, onClose, onRemoved }: { repo: Repo; check: WorktreeRemovalCheck; onClose: () => void; onRemoved: () => void }) {
  const [acked, setAcked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<OpError | null>(null)
  const w = check.worktree
  const hard = hardBlockers(check), soft = softBlockers(check)
  const ok = canRemove(check, acked) && !busy

  const run = async () => {
    if (!ok) return
    setBusy(true); setError(null)
    const r = await api.worktreeRemove(repo.id, w.path, soft.length > 0)
    setBusy(false)
    if (r.ok) onRemoved(); else setError(r.error)
  }

  return (
    <Dialog open onClose={busy ? () => {} : onClose} title="Remove worktree?" role="alertdialog" width={520}
      footer={<>
        <Button variant="secondary" data-autofocus onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="danger" icon="trash" disabled={!ok} aria-busy={busy || undefined} onClick={() => void run()}>{busy && <span className="sm-spinner" aria-hidden="true" />}Remove worktree</Button>
      </>}>
      <p className="top-confirm__target">{w.path}</p>
      {hard.length > 0 && <div className="wt-stack">{hard.map(b => <InlineAlert key={b.code} tone="warn">{b.message}</InlineAlert>)}</div>}
      {hard.length === 0 && (
        <>
          <ul className="top-confirm__list">{removeConsequences(check).map(c => <li key={c}>{c}</li>)}</ul>
          {soft.map(b => (
            <div key={b.code} className="wt-ack">
              <p className="gm-warn wt-line">{b.message}</p>
              <label className="gm-ack"><Checkbox checked={acked.has(b.code)} label={discardLabel(b, w)} onChange={on => setAcked(s => { const n = new Set(s); if (on) n.add(b.code); else n.delete(b.code); return n })} /><span>{discardLabel(b, w)}</span></label>
            </div>
          ))}
        </>
      )}
      {error && <ErrorLine error={error} />}
    </Dialog>
  )
}
