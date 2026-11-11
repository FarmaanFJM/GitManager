import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Checkbox, Details, Dropdown, Icon, IconButton, InlineAlert, Menu, type MenuEntry } from '../../third_party/summa-ui/src/ui'
import { useToast } from '../../third_party/summa-ui/src/presets'
import type { DiffHunk, DiffArea, FileDiff, HunkAction, StashEntry, StashFile, StashPreview, WorkingTree } from '../shared/changes'
import type { BlockerAction, OpError, Repo } from '../shared/types'
import { api } from './api'
import { DiffView } from './DiffView'
import { FileConfirm } from './FileConfirm'
import { AREA_ORDER, AREA_TITLE, KIND_LABEL, KIND_LETTER, buildRows, orderedKeys, pathsOf, selectionPlan, rowKey, type Row, type RowArea } from './changesModel'
import * as sel from './selection'
import { StashDialog, StashPanel } from './Stashes'
import { copyText } from './tools/common'
import { ErrorBanner } from './Workspace'
import { plural } from './util'

type Target = { kind: 'file'; row: Row } | { kind: 'stash'; entry: StashEntry }

/**
 * Working-tree changes of the selected repository. The list shows what Git reports (staged, unstaged, untracked, conflicts), a file
 * opens as a diff on the right, and the selected files can be staged, unstaged, restored, discarded or deleted, or committed.
 * Everything here is read from Git when the panel opens, after each operation, when the window regains focus and when the
 * repository changes outside GitManager (the watcher); nothing polls.
 */
export function ChangesPanel({ repo, reloadKey, openStash, onStashHandled, onChanged, onAction }: {
  repo: Repo; reloadKey: number; /** A blocked operation asked for the stash form. */ openStash: boolean; onStashHandled: () => void; onChanged: () => void; onAction: (a: BlockerAction) => void
}) {
  const toast = useToast()
  const [tree, setTree] = useState<WorkingTree | null>(null)
  const [error, setError] = useState<OpError | null>(null)
  const [loading, setLoading] = useState(true)
  const [selection, setSelection] = useState<sel.Selection>(sel.emptySelection())
  const [target, setTarget] = useState<Target | null>(null)
  const [context, setContext] = useState(3)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; row: Row } | null>(null)
  const [confirm, setConfirm] = useState<null | { kind: 'discard' | 'delete'; rows: Row[]; permanent?: boolean }>(null)
  const [recovery, setRecovery] = useState<string | null>(null)
  const [stashCount, setStashCount] = useState(0)
  const [stashKey, setStashKey] = useState(0)
  const [stashForm, setStashForm] = useState(false)
  useEffect(() => { if (openStash) { setStashForm(true); onStashHandled() } }, [openStash, onStashHandled])
  const seq = useRef(0)
  const shift = useRef(false)

  const load = useCallback(async () => {
    const n = ++seq.current
    const r = await api.changesRead(repo.id)
    if (n !== seq.current) return
    setLoading(false)
    if (!r.ok) { setError(r.error); return }
    setTree(r.value)
  }, [repo.id])
  useEffect(() => { void load() }, [load, reloadKey])
  useEffect(() => {
    let last = 0
    const onFocus = () => { if (Date.now() - last > 2000) { last = Date.now(); void load() } }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [load])

  // The stash count on the section label is known before the section is opened.
  useEffect(() => { let live = true; void api.stashList(repo.id).then(r => { if (live && r.ok) setStashCount(r.value.length) }); return () => { live = false } }, [repo.id, reloadKey, stashKey])
  const rows = useMemo(() => buildRows(tree?.files ?? []), [tree])
  const order = useMemo(() => orderedKeys(rows), [rows])
  const byKey = useMemo(() => new Map(AREA_ORDER.flatMap(a => rows[a].map(r => [r.key, r] as const))), [rows])
  useEffect(() => {
    setSelection(s => sel.prune(s, order))
    setTarget(t => (t?.kind === 'file' ? (byKey.get(t.row.key) ? { kind: 'file', row: byKey.get(t.row.key)! } : null) : t))
  }, [order, byKey])

  const selected = useMemo(() => [...selection.keys].map(k => byKey.get(k)).filter((r): r is Row => !!r), [selection, byKey])
  const plan = selectionPlan(selected)

  /** Runs one operation: busy state, the error banner or a toast, then a fresh read and a refresh of the repository header. */
  const run = async <T,>(what: string, fn: () => Promise<{ ok: true; value: T } | { ok: false; error: OpError }>, done?: (v: T) => string | null) => {
    setBusy(what); setError(null)
    const r = await fn()
    setBusy(null)
    if (!r.ok) setError(r.error)
    else { const t = done?.(r.value); if (t) toast.success(t) }
    await load()
    onChanged()
    return r
  }

  const stage = (rs: Row[]) => run('stage', () => api.changesStage(repo.id, pathsOf(rs)), v => `Staged ${plural(v.staged.length, 'file')}`)
  const unstage = (rs: Row[]) => run('unstage', () => api.changesUnstage(repo.id, pathsOf(rs)), v => `Unstaged ${plural(v.unstaged.length, 'file')}`)
  const stageAll = () => run('stage', () => api.changesStageAll(repo.id), v => (v.skippedConflicts.length ? `Staged ${plural(v.staged.length, 'file')}. ${plural(v.skippedConflicts.length, 'conflict')} left.` : `Staged ${plural(v.staged.length, 'file')}`))
  const unstageAll = () => run('unstage', () => api.changesUnstageAll(repo.id), v => `Unstaged ${plural(v.unstaged.length, 'file')}`)
  const restore = (rs: Row[]) => run('restore', () => api.changesRestore(repo.id, pathsOf(rs)), v => `Restored ${plural(v.restored.length, 'file')}`)
  const discard = async (rs: Row[]) => {
    const r = await run('discard', () => api.changesDiscard(repo.id, pathsOf(rs), true), v => `Discarded ${plural(v.discarded.length, 'file')}`)
    setConfirm(null)
    if (r.ok && r.value.recoverWith) setRecovery(r.value.recoverWith)
  }
  const del = async (rs: Row[], permanent: boolean) => {
    setBusy('delete'); setError(null)
    const r = await api.changesDeleteUntracked(repo.id, pathsOf(rs), { confirm: true, permanent })
    setBusy(null)
    if (!r.ok && r.error.code === 'TRASH_UNAVAILABLE') { setConfirm({ kind: 'delete', rows: rs, permanent: true }); return }
    setConfirm(null)
    if (!r.ok) setError(r.error)
    else {
      if (r.value.failed.length) setError({ code: 'PARTIAL', message: `${plural(r.value.failed.length, 'file')} could not be deleted.`, detail: r.value.failed.map(f => `${f.path}: ${f.reason}`).join('\n') })
      if (r.value.deleted.length) toast.success(r.value.method === 'trash' ? `Moved ${plural(r.value.deleted.length, 'file')} to the trash` : `Deleted ${plural(r.value.deleted.length, 'file')}`)
    }
    await load(); onChanged()
  }
  const commit = async () => {
    const r = await run('commit', () => api.changesCommit(repo.id, message), v => `Committed ${v.short}`)
    if (r.ok) setMessage('')
  }
  const openFile = async (row: Row) => { const r = await api.changesOpenFile(repo.id, row.file.path); if (!r.ok) setError(r.error) }

  /* ---------------------------------------------------------------- diff */
  const [diff, setDiff] = useState<FileDiff | null>(null)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [stashView, setStashView] = useState<{ preview: StashPreview; file: StashFile | null; diff: FileDiff | null } | null>(null)
  const dseq = useRef(0)
  const rowForDiff = target?.kind === 'file' ? target.row : null
  useEffect(() => {
    if (!rowForDiff) { setDiff(null); setDiffError(null); return }
    const n = ++dseq.current
    const area: DiffArea = rowForDiff.area === 'staged' ? 'staged' : rowForDiff.area === 'untracked' ? 'untracked' : 'unstaged'
    if (rowForDiff.area === 'conflict') { setDiff(null); setDiffError('This file has conflicts. Open it in the editor to resolve them, then stage it.'); return }
    void api.changesDiff(repo.id, { path: rowForDiff.file.path, area, context, ...(area === 'staged' && rowForDiff.file.from ? { from: rowForDiff.file.from } : {}) }).then(r => {
      if (n !== dseq.current) return
      if (r.ok) { setDiff(r.value); setDiffError(null) } else { setDiff(null); setDiffError(r.error.message) }
    })
  }, [repo.id, rowForDiff?.key, rowForDiff?.file.index, rowForDiff?.file.worktree, context, tree?.readAt]) // eslint-disable-line react-hooks/exhaustive-deps

  const hunk = async (h: DiffHunk, action: HunkAction) => {
    if (!rowForDiff || !diff) return
    if (action === 'discard') { setHunkConfirm({ hunk: h, path: rowForDiff.file.path }); return }
    await run('hunk', () => api.changesHunk(repo.id, { path: rowForDiff.file.path, area: diff.area as 'staged' | 'unstaged', hunkId: h.id, action }), () => (action === 'stage' ? 'Hunk staged' : 'Hunk unstaged'))
  }
  const [hunkConfirm, setHunkConfirm] = useState<{ hunk: DiffHunk; path: string } | null>(null)

  const previewStash = async (e: StashEntry | null) => {
    if (!e) { setStashView(null); return }
    setTarget({ kind: 'stash', entry: e })
    const r = await api.stashPreview(repo.id, e.index, e.sha)
    if (!r.ok) { setError(r.error); return }
    setStashView({ preview: r.value, file: null, diff: null })
  }
  const stashFile = async (f: StashFile) => {
    if (!stashView) return
    const e = stashView.preview.entry
    const r = await api.stashDiff(repo.id, e.index, e.sha, f.path, f.untracked)
    setStashView(v => (v ? { ...v, file: f, diff: r.ok ? r.value : null } : v))
    if (!r.ok) setError(r.error)
  }

  /* ---------------------------------------------------------------- rows */
  const focusRow = (key: string) => document.querySelector<HTMLElement>(`[data-rowkey="${CSS.escape(key)}"]`)?.focus()
  const onRowKey = (e: React.KeyboardEvent, r: Row) => {
    const i = order.indexOf(r.key)
    if (e.key === 'ArrowDown' && order[i + 1]) { e.preventDefault(); focusRow(order[i + 1]) }
    else if (e.key === 'ArrowUp' && order[i - 1]) { e.preventDefault(); focusRow(order[i - 1]) }
    else if (e.key === ' ') { e.preventDefault(); setSelection(s => sel.click(s, r.key, order, { range: e.shiftKey })) }
    else if (e.key === 'Enter') { e.preventDefault(); setTarget({ kind: 'file', row: r }) }
    else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); const b = e.currentTarget.getBoundingClientRect(); setMenu({ x: b.left + 40, y: b.bottom, row: r }) }
  }
  const menuItems = (row: Row): MenuEntry[] => {
    const rs = selection.keys.has(row.key) ? selected : [row]
    const p = selectionPlan(rs)
    return [
      ...(p.stage.length ? [{ label: 'Stage', icon: 'plus' as const, onSelect: () => void stage(p.stage) }] : []),
      ...(p.unstage.length ? [{ label: 'Unstage', icon: 'minus' as const, onSelect: () => void unstage(p.unstage) }] : []),
      ...(p.restore.length ? [{ label: 'Restore deleted file', icon: 'undo' as const, onSelect: () => void restore(p.restore) }] : []),
      ...(p.discard.length ? [{ label: 'Discard changes…', icon: 'trash' as const, danger: true, onSelect: () => setConfirm({ kind: 'discard', rows: p.discard }) }] : []),
      ...(p.deleteUntracked.length ? [{ label: 'Delete file…', icon: 'trash' as const, danger: true, onSelect: () => setConfirm({ kind: 'delete', rows: p.deleteUntracked }) }] : []),
      { type: 'sep' as const },
      { label: 'Open in editor', icon: 'code' as const, disabled: row.kind === 'deleted', onSelect: () => void openFile(row) },
      { label: 'Copy path', icon: 'copy' as const, onSelect: () => void copyText(row.file.path).then(ok => (ok ? toast.success('Path copied') : toast.error('Could not copy'))) },
    ]
  }

  const section = (area: RowArea) => {
    const list = rows[area]
    if (!list.length) return null
    const keys = list.map(r => r.key)
    const st = sel.state(selection, keys)
    return (
      <section key={area} className="gm-chg-group" aria-label={`${AREA_TITLE[area]}, ${plural(list.length, 'file')}`}>
        <header className="gm-chg-ghead">
          <Checkbox checked={st === 'all' ? true : st === 'some' ? 'mixed' : false} onChange={on => setSelection(s => (on ? sel.add(s, keys) : sel.remove(s, keys)))} label={`Select all in ${AREA_TITLE[area]}`} />
          <h3 className="gm-section-h">{AREA_TITLE[area]} <span className="faint num">{list.length}</span></h3>
          <span className="grow" />
          {area === 'staged' && <Button variant="ghost" disabled={!!busy} onClick={() => void unstageAll()}>Unstage all</Button>}
          {area === 'unstaged' && <Button variant="ghost" disabled={!!busy} onClick={() => void stageAll()}>Stage all</Button>}
          {area === 'untracked' && !rows.unstaged.length && <Button variant="ghost" disabled={!!busy} onClick={() => void stageAll()}>Stage all</Button>}
        </header>
        <ul className="gm-chg-rows">
          {list.map(r => {
            const dir = r.file.path.includes('/') ? r.file.path.slice(0, r.file.path.lastIndexOf('/') + 1) : ''
            const name = r.file.path.slice(dir.length)
            return (
              <li key={r.key} data-rowkey={r.key} tabIndex={0} role="option" aria-selected={selection.keys.has(r.key)} className="gm-chg-row" data-focus={(target?.kind === 'file' && target.row.key === r.key) || undefined}
                onClickCapture={e => { shift.current = e.shiftKey }} onClick={() => setTarget({ kind: 'file', row: r })} onKeyDown={e => onRowKey(e, r)}
                onContextMenu={e => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, row: r }) }}>
                <Checkbox checked={selection.keys.has(r.key)} label={`Select ${r.file.path}`} onChange={() => setSelection(s => sel.click(s, r.key, order, { range: shift.current }))} />
                <span className={`gm-kind gm-kind-${r.kind}`} title={r.kind === 'conflict' ? r.file.conflictKind : KIND_LABEL[r.kind]} aria-label={KIND_LABEL[r.kind]}>{KIND_LETTER[r.kind]}</span>
                <span className="gm-chg-path" title={r.file.from ? `${r.file.from} → ${r.file.path}` : r.file.path}>{name}{dir && <span className="faint"> {dir}</span>}{r.file.from && <span className="faint"> ← {r.file.from.split('/').pop()}</span>}</span>
                <span className="gm-chg-state faint">{r.kind === 'conflict' ? r.file.conflictKind : KIND_LABEL[r.kind]}</span>
              </li>
            )
          })}
        </ul>
      </section>
    )
  }

  const nothing = tree && tree.files.length === 0
  const staged = tree?.counts.staged ?? 0

  return (
    <div className="gm-chg">
      <div className="gm-chg-list-pane">
        <div className="gm-toolbar gm-chg-bar">
          <span className="gm-section-h">{tree ? (nothing ? 'No changes' : `${plural(tree.counts.files, 'file')} changed`) : 'Changes'}</span>
          <span className="grow" />
          {(loading || busy) && <span className="sm-spinner" aria-label="Working" />}
          <IconButton icon="refresh" size="sm" label="Refresh changes" onClick={() => void load()} />
        </div>
        {selected.length > 0 && (
          <div className="gm-chg-actions" role="toolbar" aria-label={`${plural(selected.length, 'row')} selected`}>
            <span className="num muted">{selected.length} selected</span>
            <span className="grow" />
            {plan.stage.length > 0 && <Button variant="secondary" disabled={!!busy} onClick={() => void stage(plan.stage)}>Stage</Button>}
            {plan.unstage.length > 0 && <Button variant="secondary" disabled={!!busy} onClick={() => void unstage(plan.unstage)}>Unstage</Button>}
            {plan.restore.length > 0 && <Button variant="secondary" disabled={!!busy} onClick={() => void restore(plan.restore)}>Restore</Button>}
            {plan.discard.length > 0 && <Button variant="ghost" disabled={!!busy} onClick={() => setConfirm({ kind: 'discard', rows: plan.discard })}>Discard…</Button>}
            {plan.deleteUntracked.length > 0 && <Button variant="ghost" disabled={!!busy} onClick={() => setConfirm({ kind: 'delete', rows: plan.deleteUntracked })}>Delete…</Button>}
            <IconButton icon="x" size="sm" label="Clear selection" onClick={() => setSelection(sel.emptySelection())} />
          </div>
        )}
        {error && <ErrorBanner error={error} onDismiss={() => setError(null)} onAction={a => { if (a.id === 'stash') { setStashForm(true); return } onAction(a) }} />}
        {tree?.operation && <InlineAlert tone="info">{tree.operation === 'merge' ? 'A merge' : tree.operation === 'revert' ? 'A revert' : 'A cherry-pick'} is in progress. Resolve the conflicts, stage the files, then commit.</InlineAlert>}
        {recovery && <InlineAlert tone="info" action={{ label: 'Dismiss', onClick: () => setRecovery(null) }}>Recover discarded changes with <code className="gm-mono">{recovery}</code> <IconButton icon="copy" size="sm" label="Copy recovery command" onClick={() => void copyText(recovery)} /></InlineAlert>}
        {tree?.truncated && <InlineAlert tone="warn">Only the first 5000 changed files are listed.</InlineAlert>}

        <div className="gm-chg-scroll scroll" role="listbox" aria-multiselectable="true" aria-label="Changed files">
          {!tree && loading && <div aria-busy="true">{[60, 44, 70].map((w, i) => <div key={i} className="gm-chg-row"><span className="skeleton" style={{ width: `${w}%`, height: 10 }} /></div>)}</div>}
          {nothing && <div className="sm-empty"><p className="sm-empty__text">The working tree is clean.</p></div>}
          {AREA_ORDER.map(section)}
        </div>

        <form className="gm-commit-box" onSubmit={e => { e.preventDefault(); void commit() }}>
          <textarea className="input" rows={2} aria-label="Commit message" placeholder={staged ? 'Message' : 'Stage files to commit'} value={message} onChange={e => setMessage(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void commit() } }} />
          <Button variant="primary" type="submit" disabled={!staged || !message.trim() || !!busy || !!tree?.counts.conflicted} aria-busy={busy === 'commit' || undefined}>{busy === 'commit' && <span className="sm-spinner" aria-hidden="true" />}Commit{staged ? ` ${staged}` : ''}</Button>
        </form>

        <Details label={stashCount ? `Stashes ${stashCount}` : 'Stashes'} className="gm-chg-stashes">
          <StashPanel repo={repo} reloadKey={reloadKey + stashKey} onStash={() => setStashForm(true)} previewing={target?.kind === 'stash' ? target.entry.sha : null}
            onPreview={e => void previewStash(e)} onCount={setStashCount} onError={setError} onChanged={() => { void load(); onChanged(); setStashKey(k => k + 1) }} />
        </Details>
      </div>

      <div className="gm-chg-diff-pane">
        {!target && <div className="sm-empty"><p className="sm-empty__text">{nothing ? '' : 'Select a file to see its changes.'}</p></div>}
        {target?.kind === 'file' && (
          <>
            <header className="gm-diff-head">
              <h2 className="gm-h1 truncate" title={target.row.file.path}>{target.row.file.path}</h2>
              <span className="faint">{AREA_TITLE[target.row.area]}</span>
              <span className="grow" />
              <Dropdown label="Context lines" quiet width={150} value={String(context)} onChange={v => setContext(Number(v))} options={[{ value: '3', label: '3 lines' }, { value: '10', label: '10 lines' }, { value: '30', label: '30 lines' }, { value: '200', label: 'Whole file' }]} />
              <IconButton icon="code" size="sm" label="Open in editor" disabled={target.row.kind === 'deleted'} onClick={() => void openFile(target.row)} />
            </header>
            <div className="gm-diff-scroll scroll">
              {diffError ? <p className="gm-diff-note muted">{diffError}</p> : diff ? <DiffView diff={diff} busy={!!busy} onHunk={(h, a) => void hunk(h, a)} /> : <div className="gm-loading-line"><span className="sm-spinner" aria-hidden="true" /> Reading changes</div>}
            </div>
          </>
        )}
        {target?.kind === 'stash' && (
          <>
            <header className="gm-diff-head">
              <Icon name="archive" size={15} />
              <h2 className="gm-h1 truncate">{target.entry.message || target.entry.ref}</h2>
              <span className="faint">{stashView?.preview.stat}</span>
              <span className="grow" />
              <IconButton icon="x" size="sm" label="Close preview" onClick={() => { setTarget(null); setStashView(null) }} />
            </header>
            <ul className="gm-stash-files">
              {(stashView?.preview.files ?? []).map(f => (
                <li key={`${f.untracked}:${f.path}`}><button type="button" className="gm-stash-file" aria-pressed={stashView?.file?.path === f.path && stashView.file.untracked === f.untracked} onClick={() => void stashFile(f)}>
                  <span className={`gm-kind gm-kind-${f.status === 'A' ? 'added' : f.status === 'D' ? 'deleted' : f.status === 'R' ? 'renamed' : 'modified'}`}>{f.status}</span><span className="truncate gm-mono">{f.path}</span>{f.untracked && <span className="faint">untracked</span>}
                </button></li>
              ))}
            </ul>
            <div className="gm-diff-scroll scroll">{stashView?.diff ? <DiffView diff={stashView.diff} /> : <p className="gm-diff-note muted">{stashView ? 'Select a file.' : ''}</p>}</div>
          </>
        )}
      </div>

      <StashDialog repo={repo} open={stashForm} onClose={() => setStashForm(false)} onError={setError} onDone={() => { void load(); onChanged(); setStashKey(k => k + 1) }} />
      <Menu anchor={menu ? { x: menu.x, y: menu.y } : null} open={!!menu} onClose={() => setMenu(null)} label="File actions" items={menu ? menuItems(menu.row) : []} />
      <FileConfirm open={confirm?.kind === 'discard'} title={`Discard changes to ${plural(confirm?.rows.length ?? 0, 'file')}?`} files={pathsOf(confirm?.rows ?? [])} confirmLabel="Discard changes" busy={busy === 'discard'}
        consequences={['Unstaged changes in these files are lost. Staged changes are kept.', 'A recovery command is shown afterwards.']}
        onCancel={() => setConfirm(null)} onConfirm={() => void discard(confirm!.rows)} />
      <FileConfirm open={confirm?.kind === 'delete'} title={confirm?.permanent ? `Delete ${plural(confirm.rows.length, 'file')} permanently?` : `Delete ${plural(confirm?.rows.length ?? 0, 'file')}?`} files={pathsOf(confirm?.rows ?? [])}
        confirmLabel={confirm?.permanent ? 'Delete permanently' : 'Move to trash'} busy={busy === 'delete'} acknowledge={confirm?.permanent ? 'These files cannot be recovered' : undefined}
        consequences={confirm?.permanent ? ['The trash is not available here, so Git deletes them for good.'] : ['Untracked files only. They go to the trash, from where they can be restored.']}
        onCancel={() => setConfirm(null)} onConfirm={() => void del(confirm!.rows, !!confirm?.permanent)} />
      <FileConfirm open={!!hunkConfirm} title="Discard this hunk?" files={hunkConfirm ? [hunkConfirm.path] : []} confirmLabel="Discard hunk" busy={busy === 'hunk'}
        consequences={['The lines of this hunk go back to what is staged.', 'Other hunks of the file are not touched.']}
        onCancel={() => setHunkConfirm(null)}
        onConfirm={() => { const h = hunkConfirm!; setHunkConfirm(null); void run('hunk', () => api.changesHunk(repo.id, { path: h.path, area: 'unstaged', hunkId: h.hunk.id, action: 'discard', confirm: true }), () => 'Hunk discarded') }} />
    </div>
  )
}

export { rowKey }
