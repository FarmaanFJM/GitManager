import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, DrawerToggle, Icon, IconButton, InlineAlert, MenuButton, Tabs, Tooltip } from '../../third_party/summa-ui/src/ui'
import { useConfirm, useToast } from '../../third_party/summa-ui/src/presets'
import type { BlockerAction, Commit, Comparison, OpError, Repo, Result } from '../shared/types'
import { api } from './api'
import type { Actions, Model, RepoTab } from './App'
import { WorktreesPanel } from './Worktrees'
import { useRepoOps } from './repoOps'
import { DeleteRepoDialog } from './DeleteRepoDialog'
import { removeWords } from './deleteText'
import { BranchPicker } from './BranchPicker'
import { BranchesPanel } from './Branches'
import { ChangesPanel } from './Changes'
import { ChangesSummary } from './ChangesSummary'
import { ServicesPanel } from './Services'
import { ago, changesText, syncText } from './util'

/**
 * Inline error for a Git operation: what happened, what stands in the way (the files, the services, the worktree) and the actions that
 * resolve exactly that. Actions come only from the error itself (src/core/git), and a button is drawn only when the caller can perform it.
 * Git's own words are one click away.
 */
export function ErrorBanner({ error, onDismiss, onAction }: { error: OpError; onDismiss: () => void; onAction?: (a: BlockerAction) => void }) {
  const [open, setOpen] = useState(false)
  const b = error.blocker
  const files = b?.files ?? []
  const actions = onAction ? b?.actions ?? [] : []
  return (
    <div className="gm-banner" role="alert">
      <Icon name="circle-alert" size={16} className="gm-banner-icon" />
      <div className="gm-banner-body">
        <p>{error.message}</p>
        {files.length > 0 && <ul className="gm-banner-files" aria-label="Affected files">{files.slice(0, 6).map(f => <li key={f} className="gm-mono truncate" title={f}>{f}</li>)}{files.length > 6 && <li className="faint">and {files.length - 6} more</li>}</ul>}
        {b?.services && b.services.length > 0 && <p className="faint gm-banner-svc">Running: {b.services.join(', ')}</p>}
        {actions.length > 0 && <div className="gm-banner-actions">{actions.map(a => <Button key={a.id + (a.target ?? '')} variant="secondary" onClick={() => onAction!(a)}>{a.label}</Button>)}</div>}
        {error.detail && open && <pre className="gm-banner-detail">{error.detail}</pre>}
      </div>
      {error.detail && <button type="button" className="btn btn-ghost gm-banner-btn" aria-expanded={open} onClick={() => setOpen(o => !o)}>{open ? 'Hide details' : 'Details'}</button>}
      <IconButton icon="x" size="sm" label="Dismiss" onClick={onDismiss} />
    </div>
  )
}

type Busy = null | 'fetch' | 'pull' | 'switch'

export function Workspace({ model, actions, repo }: { model: Model; actions: Actions; repo: Repo }) {
  const view = model.statuses[repo.id]
  const st = view?.status
  const [busy, setBusy] = useState<Busy>(null)
  const [banner, setBanner] = useState<OpError | null>(null)
  // Every repository opens on its Overview; the workspace is keyed by repository, so this resets on each selection.
  const [tab, setTab] = useState<RepoTab>(actions.tab && actions.tab.repoId === repo.id ? actions.tab.tab : 'overview')
  const [deleting, setDeleting] = useState(false)
  const ops = useRepoOps(actions, model)
  const [branchCount, setBranchCount] = useState<number | null>(null)
  const [historyKey, setHistoryKey] = useState(0)
  const confirm = useConfirm()
  const toast = useToast()
  const running = Object.values(model.services).filter(s => s.repoId === repo.id && s.pid !== null)

  // The branch count on the tab comes from the cheap branch list; the comparisons load only when the tab opens.
  useEffect(() => { void api.branches(repo.id).then(r => { if (r.ok) setBranchCount(r.value.length) }) }, [repo.id, historyKey])

  const [stashRequested, setStashRequested] = useState(false)
  // Git changes made outside GitManager (a terminal, another tool) refresh this repository once, without polling.
  const actionsRef = useRef(actions)
  actionsRef.current = actions
  useEffect(() => {
    void api.watchRepo(repo.id)
    const off = api.on('repo-changed', e => { if (e.repoId === repo.id) { void actionsRef.current.refresh(repo.id); setHistoryKey(k => k + 1) } })
    return () => { off(); void api.watchRepo(null) }
  }, [repo.id])

  const after = useCallback(async <T,>(r: Result<T>) => {
    if (!r.ok) setBanner(r.error); else setBanner(null)
    await actions.refresh(repo.id)
    setHistoryKey(k => k + 1)
    return r
  }, [actions, repo.id])

  const fetch = async () => {
    setBusy('fetch')
    const r = await api.fetch(repo.id)
    if (r.ok) actions.markFetched(repo.id)
    await after(r)
    if (r.ok) void actions.refresh(repo.id, { remote: true })
    setBusy(null)
  }
  const pull = async () => {
    setBusy('pull')
    const r = await api.pull(repo.id)
    if (r.ok) { actions.markFetched(repo.id); actions.setRestartHint(repo.id, r.value.affected) }
    await after(r)
    setBusy(null)
  }

  /** Services must stop before the branch changes. Asks once, stops them, then switches. */
  const ensureStopped = async (target: string) => {
    if (!running.length) return true
    const names = running.map(s => model.data.profiles.find(p => p.id === s.profileId)?.services.find(x => x.id === s.serviceId)?.name ?? 'service')
    const yes = await confirm({
      title: 'Stop services to switch branches?',
      description: `${names.join(' and ')} ${names.length === 1 ? 'is' : 'are'} running from this repository. ${names.length === 1 ? 'It' : 'They'} must stop before switching to ${target}.`,
      confirmLabel: names.length === 1 ? 'Stop service and switch' : 'Stop services and switch',
    })
    if (!yes) return false
    const profiles = [...new Set(running.map(s => s.profileId))]
    await Promise.all(profiles.map(p => api.stopServices(p)))
    return true
  }
  const switchTo = async (name: string) => {
    if (!(await ensureStopped(name))) return
    setBusy('switch')
    await after(await api.switchBranch(repo.id, name))
    setBusy(null)
  }
  const track = async (ref: string) => {
    if (!(await ensureStopped(ref))) return
    setBusy('switch')
    await after(await api.trackBranch(repo.id, ref))
    setBusy(null)
  }

  /** The actions an error can offer. Each one does exactly what its label says, nothing more. */
  const blockerAction = async (a: BlockerAction) => {
    switch (a.id) {
      case 'view-changes': case 'view-conflicts': setBanner(null); setTab('changes'); break
      case 'stash': setBanner(null); setTab('changes'); setStashRequested(true); break
      case 'stop-services': {
        const profiles = [...new Set(running.map(s => s.profileId))]
        await Promise.all(profiles.map(p => api.stopServices(p)))
        setBanner(null); toast.success('Stopped'); break
      }
      case 'open-worktree': {
        const other = model.data.repos.find(r => r.id !== repo.id && r.location.kind === repo.location.kind && a.target && r.location.path.replace(/[\\/]+$/, '').toLowerCase() === a.target.replace(/[\\/]+$/, '').toLowerCase())
        setBanner(null)
        if (other) actions.select(other.id); else setTab('worktrees')
        break
      }
      case 'switch-default': if (a.target) await switchTo(a.target); break
      case 'inspect-commits': case 'force-delete': setBanner(null); setTab('branches'); break
      case 'retry': setBanner(null); await actions.refresh(repo.id, { remote: true }); setHistoryKey(k => k + 1); break
    }
  }

  const remove = async () => {
    if (running.length) { setBanner({ code: 'SERVICES_RUNNING', message: 'Stop the running services of this repository first.' }); return }
    const yes = await confirm({
      title: removeWords.title(repo.name), description: 'Only GitManager forgets it.', target: repo.location.path,
      consequences: ['Files stay on disk', 'Its profiles are removed', 'Discovery will not add it again'],
      confirmLabel: removeWords.confirm, destructive: true,
    })
    if (!yes) return
    const r = await api.removeRepo(repo.id)
    if (!r.ok) setBanner(r.error); else await actions.reload()
  }
  const open = async (what: 'folder' | 'editor') => {
    const r = what === 'folder' ? await api.openFolder(repo.id) : await api.openEditor(repo.id)
    if (!r.ok) setBanner(r.error)
  }

  const location = repo.location.kind === 'wsl' ? `${repo.location.distro}: ${repo.location.path}` : repo.location.path
  const canPull = st && (st.sync === 'behind' || st.sync === 'diverged')

  return (
    <div className="gm-work">
      <header className="gm-top">
        <DrawerToggle />
        <div className="gm-title">
          <Tooltip content={location}><h1 className="gm-h1 truncate" tabIndex={0}>{repo.name}</h1></Tooltip>
        </div>
        <span className="grow" />
        <BranchPicker repoId={repo.id} current={st?.branch ?? null} detached={st?.sync === 'detached'} disabled={!st || busy !== null} onSwitch={n => void switchTo(n)} onTrack={r => void track(r)} />
        <Button variant="ghost" icon="terminal" onClick={() => ops.terminal(repo)}>Terminal</Button>
        <Button variant="ghost" onClick={() => void fetch()} disabled={busy !== null || !st || !st.remotes.length} aria-busy={busy === 'fetch' || undefined}>
          {busy === 'fetch' ? <span className="sm-spinner" aria-hidden="true" /> : <Icon name="refresh" size={15} />}Fetch
        </Button>
        {canPull && (
          <Button variant="secondary" onClick={() => void pull()} disabled={busy !== null} aria-busy={busy === 'pull' || undefined}>
            {busy === 'pull' ? <span className="sm-spinner" aria-hidden="true" /> : <Icon name="arrow-down" size={15} />}Pull {st.behind}
          </Button>
        )}
        <Button variant="ghost" icon="repeat" onClick={() => actions.sync(repo.id)} disabled={busy !== null || !st || !st.remotes.length}>Sync with Remote</Button>
        <MenuButton label="More actions" items={[
          { label: 'Open Folder', icon: 'folder-open', onSelect: () => void open('folder') },
          { label: 'Open in editor', icon: 'code', onSelect: () => void open('editor') },
          { label: 'Copy Path', icon: 'copy', onSelect: () => void ops.copyPath(repo) },
          { label: 'Refresh', icon: 'refresh', shortcut: 'Ctrl R', onSelect: () => void actions.refresh(repo.id, { remote: true }) },
          { type: 'sep' },
          { label: 'Remove from GitManager', icon: 'eye-off', onSelect: () => void remove() },
          { label: 'Delete Local Repository', icon: 'trash', danger: true, onSelect: () => setDeleting(true) },
        ]} />
      </header>

      {actions.restartHints[repo.id] && (
        <div className="gm-hint-row">
          <InlineAlert tone="info" action={{ label: actions.restartHints[repo.id].needsAttention === 1 ? 'Restart' : 'Restart all', onClick: () => void ops.restartAffected(repo.id) }}>{actions.restartHints[repo.id].text}</InlineAlert>
        </div>
      )}
      <DeleteRepoDialog repo={deleting ? repo : null} onClose={() => setDeleting(false)} onDeleted={(message, notes, removed) => {
        setDeleting(false)
        void actions.reload().then(() => toast.success(message.length > 140 ? 'Moved to the trash' : message))
        for (const n of notes) toast.info(n)
        void removed
      }} />

      <Facts model={model} repoId={repo.id} />
      {banner && <ErrorBanner error={banner} onDismiss={() => setBanner(null)} onAction={a => void blockerAction(a)} />}
      {view?.error && !st && (
        <div className="sm-empty">
          <p className="sm-empty__text">{view.error.message}</p>
          <Button onClick={() => void actions.refresh(repo.id, { remote: true })}>Try again</Button>
        </div>
      )}

      {st && (
        <>
          <div className="gm-tabs-row">
            <Tabs label="Repository" value={tab} onChange={setTab} items={[
              { value: 'overview', label: 'Overview' },
              { value: 'changes', label: st.changes.files ? `Changes ${st.changes.files}` : 'Changes' },
              { value: 'branches', label: branchCount ? `Branches ${branchCount}` : 'Branches' },
              { value: 'worktrees', label: 'Worktrees' },
              { value: 'history', label: 'History' },
            ]} />
          </div>
          {tab === 'overview' && (
            <div className="gm-overview-stack scroll">
              <ChangesSummary repo={repo} status={st} reloadKey={historyKey} onOpen={() => setTab('changes')} />
              <ServicesPanel model={model} actions={actions} repo={repo} onError={setBanner} toast={toast} />
            </div>
          )}
          {tab === 'changes' && <ChangesPanel repo={repo} reloadKey={historyKey} openStash={stashRequested} onStashHandled={() => setStashRequested(false)} onAction={a => void blockerAction(a)} onChanged={() => { void actions.refresh(repo.id); setHistoryKey(k => k + 1) }} />}
          {tab === 'branches' && <BranchesPanel repo={repo} reloadKey={historyKey} onAction={a => void blockerAction(a)} onSwitch={n => void switchTo(n)} onTrack={r => void track(r)} onCount={setBranchCount} />}
          {tab === 'worktrees' && <WorktreesPanel model={model} actions={actions} repo={repo} />}
          {tab === 'history' && <History repoId={repo.id} reloadKey={historyKey} sync={st.sync} />}
        </>
      )}
      {!st && !view?.error && <div className="gm-loading-line"><span className="sm-spinner" aria-hidden="true" /> Reading repository</div>}
    </div>
  )
}

/** Branch state on one quiet line: upstream relation, working tree, and a remote only when it is a problem. */
function Facts({ model, repoId }: { model: Model; repoId: string }) {
  const st = model.statuses[repoId]?.status
  const remote = model.remotes[repoId]
  const fetched = model.fetchedAt[repoId]
  if (!st) return <div className="gm-facts" aria-hidden="true"><span className="skeleton" style={{ width: 240, height: 12 }} /></div>
  const attention = st.sync === 'diverged' || st.sync === 'upstream-gone'
  return (
    <p className="gm-facts-line">
      {st.upstream && <span className="gm-mono">{st.upstream}</span>}
      <span className={attention ? 'gm-warn' : ''}>{syncText(st)}</span>
      <span className={st.changes.conflicted ? 'gm-warn' : ''}>{st.clean ? 'Clean' : changesText(st)}</span>
      {remote && !remote.reachable && <span className="gm-danger" title={remote.error}>Remote unreachable</span>}
      {!st.remotes.length && <span>No remote</span>}
      {fetched ? <span className="faint">Fetched {ago(fetched)}</span> : null}
    </p>
  )
}

export function CommitRow({ c, compact }: { c: Commit; compact?: boolean }) {
  return (
    <li className="gm-commit">
      <span className="gm-hash">{c.short}</span>
      <span className="gm-commit-subject truncate" title={c.subject}>{c.subject}</span>
      {!compact && <span className="gm-commit-author truncate">{c.author}</span>}
      <time className="gm-commit-date" dateTime={new Date(c.date).toISOString()} title={new Date(c.date).toLocaleString()}>{ago(c.date)}</time>
    </li>
  )
}

/** Incoming and outgoing commits against the upstream (from the last fetch), then recent history. */
function History({ repoId, reloadKey, sync }: { repoId: string; reloadKey: number; sync: string }) {
  const [cmp, setCmp] = useState<Comparison | null>(null)
  const [log, setLog] = useState<Commit[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)
  useEffect(() => {
    const n = ++seq.current
    void Promise.all([api.compare(repoId), api.log(repoId)]).then(([c, l]) => {
      if (n !== seq.current) return
      if (c.ok) setCmp(c.value)
      if (l.ok) setLog(l.value); else setError(l.error.message)
    })
  }, [repoId, reloadKey, sync])

  if (error) return <div className="sm-empty"><p className="sm-empty__text">{error}</p></div>
  if (!log) return (
    <div className="gm-scroll scroll" aria-busy="true">
      {[70, 52, 64, 45, 58].map((w, i) => <div key={i} className="gm-commit"><span className="skeleton" style={{ width: 52, height: 10 }} /><span className="skeleton" style={{ width: `${w}%`, height: 10 }} /></div>)}
    </div>
  )
  return (
    <div className="gm-scroll scroll">
      {cmp && cmp.incoming.length > 0 && (
        <section className="gm-section" aria-label="Incoming commits">
          <h2 className="gm-section-h">Incoming from {cmp.upstream} <span className="faint num">{cmp.incoming.length}</span></h2>
          <ul className="gm-commits">{cmp.incoming.map(c => <CommitRow key={c.hash} c={c} />)}</ul>
        </section>
      )}
      {cmp && cmp.outgoing.length > 0 && (
        <section className="gm-section" aria-label="Commits not pushed">
          <h2 className="gm-section-h">Not pushed <span className="faint num">{cmp.outgoing.length}</span></h2>
          <ul className="gm-commits">{cmp.outgoing.map(c => <CommitRow key={c.hash} c={c} />)}</ul>
        </section>
      )}
      <section className="gm-section" aria-label="Recent commits">
        <h2 className="gm-section-h">Recent commits</h2>
        {log.length ? <ul className="gm-commits">{log.map(c => <CommitRow key={c.hash} c={c} />)}</ul> : <p className="gm-section-empty muted">No commits yet.</p>}
      </section>
    </div>
  )
}

export function WelcomeEmpty({ hasRepos, searching, onAdd }: { hasRepos: boolean; searching: boolean; onAdd: () => void }) {
  return (
    <div className="gm-work">
      <header className="gm-top"><DrawerToggle /></header>
      <div className="sm-empty sm-empty--center gm-welcome" aria-busy={searching && !hasRepos}>
        {!hasRepos && searching
          ? <p className="sm-empty__text row"><span className="sm-spinner" aria-hidden="true" /> Looking for repositories on this computer.</p>
          : <p className="sm-empty__text">{hasRepos ? 'Select a repository.' : 'No repositories found yet.'}</p>}
        {!hasRepos && <Button variant={searching ? 'secondary' : 'primary'} icon="plus" onClick={onAdd}>Add repository</Button>}
      </div>
    </div>
  )
}

