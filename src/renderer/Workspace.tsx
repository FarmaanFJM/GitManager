import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, DrawerToggle, Icon, IconButton, MenuButton, Tabs } from '../../third_party/summa-ui/src/ui'
import { useConfirm, useToast } from '../../third_party/summa-ui/src/presets'
import type { Commit, Comparison, OpError, Repo, Result } from '../shared/types'
import { api } from './api'
import type { Actions, Model } from './App'
import { BranchPicker } from './BranchPicker'
import { BranchesPanel } from './Branches'
import { ServicesPanel } from './Services'
import { ago, changesText, syncText } from './util'

/** Inline error for a Git operation: what happened and how to recover, with Git's own words one click away. */
export function ErrorBanner({ error, onDismiss }: { error: OpError; onDismiss: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="gm-banner" role="alert">
      <Icon name="circle-alert" size={16} className="gm-banner-icon" />
      <div className="gm-banner-body">
        <p>{error.message}</p>
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
  const [tab, setTab] = useState<'overview' | 'branches' | 'history'>('overview')
  const [branchCount, setBranchCount] = useState<number | null>(null)
  const [historyKey, setHistoryKey] = useState(0)
  const confirm = useConfirm()
  const toast = useToast()
  const running = Object.values(model.services).filter(s => s.repoId === repo.id && s.pid !== null)

  // The branch count on the tab comes from the cheap branch list; the comparisons load only when the tab opens.
  useEffect(() => { void api.branches(repo.id).then(r => { if (r.ok) setBranchCount(r.value.length) }) }, [repo.id, historyKey])

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
    if (r.ok) actions.markFetched(repo.id)
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

  const remove = async () => {
    if (running.length) { setBanner({ code: 'SERVICES_RUNNING', message: 'Stop the running services of this repository first.' }); return }
    const yes = await confirm({
      title: `Remove ${repo.name} from GitManager?`,
      description: 'The folder and its files stay where they are. Its development profiles are removed, and automatic discovery will not add it again.',
      confirmLabel: 'Remove repository', destructive: true,
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
          <h1 className="gm-h1 truncate">{repo.name}</h1>
          <span className="gm-path truncate" title={location}>{location}</span>
        </div>
        <span className="grow" />
        <BranchPicker repoId={repo.id} current={st?.branch ?? null} detached={st?.sync === 'detached'} disabled={!st || busy !== null} onSwitch={n => void switchTo(n)} onTrack={r => void track(r)} />
        <Button variant="ghost" onClick={() => void fetch()} disabled={busy !== null || !st || !st.remotes.length} aria-busy={busy === 'fetch' || undefined}
          title={st && !st.remotes.length ? 'This repository has no remote' : 'Fetch from the remote'}>
          {busy === 'fetch' ? <span className="sm-spinner" aria-hidden="true" /> : <Icon name="refresh" size={15} />}Fetch
        </Button>
        {canPull && (
          <Button variant="secondary" onClick={() => void pull()} disabled={busy !== null} aria-busy={busy === 'pull' || undefined}>
            {busy === 'pull' ? <span className="sm-spinner" aria-hidden="true" /> : <Icon name="arrow-down" size={15} />}Pull {st.behind}
          </Button>
        )}
        <MenuButton label="More actions" items={[
          { label: 'Open folder', icon: 'folder-open', onSelect: () => void open('folder') },
          { label: 'Open in editor', icon: 'code', onSelect: () => void open('editor') },
          { label: 'Refresh status', icon: 'refresh', shortcut: 'Ctrl R', onSelect: () => void actions.refresh(repo.id, { remote: true }) },
          { type: 'sep' },
          { label: 'Remove from GitManager', icon: 'trash', danger: true, onSelect: () => void remove() },
        ]} />
      </header>

      <Facts model={model} repoId={repo.id} />
      {banner && <ErrorBanner error={banner} onDismiss={() => setBanner(null)} />}
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
              { value: 'branches', label: branchCount ? `Branches ${branchCount}` : 'Branches' },
              { value: 'history', label: 'History' },
            ]} />
          </div>
          {tab === 'overview' && <ServicesPanel model={model} actions={actions} repo={repo} onError={setBanner} toast={toast} />}
          {tab === 'branches' && <BranchesPanel repo={repo} reloadKey={historyKey} onSwitch={n => void switchTo(n)} onTrack={r => void track(r)} onCount={setBranchCount} />}
          {tab === 'history' && <History repoId={repo.id} reloadKey={historyKey} sync={st.sync} />}
        </>
      )}
      {!st && !view?.error && <div className="gm-loading-line"><span className="sm-spinner" aria-hidden="true" /> Reading repository</div>}
    </div>
  )
}

/** Branch state in three facts: working tree, relation to the upstream, and the remote. Muted label, value below (P11). */
function Facts({ model, repoId }: { model: Model; repoId: string }) {
  const st = model.statuses[repoId]?.status
  const remote = model.remotes[repoId]
  const fetched = model.fetchedAt[repoId]
  if (!st) return (
    <div className="gm-facts" aria-hidden="true">
      {[0, 1, 2].map(i => <div key={i} className="gm-fact"><span className="skeleton" style={{ width: 56, height: 9 }} /><span className="skeleton" style={{ width: 120, height: 12, marginTop: 8 }} /></div>)}
    </div>
  )
  const attention = st.sync === 'diverged' || st.sync === 'upstream-gone' || st.changes.conflicted > 0
  let remoteText = 'No remote'
  if (st.remotes.length) {
    if (remote === undefined) remoteText = 'Checking…'
    else if (remote === null) remoteText = st.remotes[0]
    else remoteText = remote.reachable ? `${remote.remote}, reachable` : `${remote.remote || st.remotes[0]}, not reachable`
  }
  return (
    <dl className="gm-facts">
      <div className="gm-fact">
        <dt>Working tree</dt>
        <dd className={st.changes.conflicted ? 'gm-warn' : ''}>{changesText(st)}</dd>
      </div>
      <div className="gm-fact">
        <dt>{st.upstream ?? 'Upstream'}</dt>
        <dd className={attention ? 'gm-warn' : ''}>{syncText(st)}</dd>
      </div>
      <div className="gm-fact">
        <dt>Remote</dt>
        <dd className={remote && !remote.reachable ? 'gm-danger' : ''} title={remote?.error}>
          {remoteText}{fetched ? <span className="muted">, fetched {ago(fetched)}</span> : null}
        </dd>
      </div>
    </dl>
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

