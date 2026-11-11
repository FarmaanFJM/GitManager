import { useMemo, useState } from 'react'
import { ActionRow, DrawerToggle, IconButton, MenuButton, SearchInput, StatusIndicator, Tooltip } from '../../third_party/summa-ui/src/ui'
import type { Repo } from '../shared/types'
import type { Actions, Model } from './App'
import { RepoMenu, type RepoMenuTarget } from './RepoMenu'
import { useRepoOps } from './repoOps'
import { groupByEnvironment, plural } from './util'

/** What, if anything, needs the user's attention on a repository row. Level 1 only: one short phrase. */
export function rowIssue(model: Model, repo: Repo, hasHint: boolean): { text: string; tone: 'warn' | 'danger' | 'restart' } | null {
  const view = model.statuses[repo.id]
  const st = view?.status
  if (view?.error && !st) return { text: view.error.code === 'NOT_FOUND' || view.error.code === 'NO_DIR' ? 'Folder missing' : 'Unavailable', tone: 'danger' }
  if (hasHint) return { text: 'Restart suggested', tone: 'restart' }
  if (!st) return null
  if (st.changes.conflicted) return { text: plural(st.changes.conflicted, 'conflict'), tone: 'warn' }
  if (st.sync === 'diverged') return { text: 'Diverged', tone: 'warn' }
  if (st.sync === 'upstream-gone') return { text: 'Upstream gone', tone: 'warn' }
  const remote = model.remotes[repo.id]
  if (remote && !remote.reachable) return { text: 'Remote unreachable', tone: 'danger' }
  return null
}

/** The landing view: every discovered repository as one compact row. Everything else opens from a row or its menu. */
export function OverviewView({ model, actions }: { model: Model; actions: Actions }) {
  const [q, setQ] = useState('')
  const [menu, setMenu] = useState<RepoMenuTarget | null>(null)
  const ops = useRepoOps(actions, model)
  const repos = model.data.repos
  const shown = useMemo(() => {
    const n = q.trim().toLowerCase()
    return n ? repos.filter(r => r.name.toLowerCase().includes(n) || r.location.path.toLowerCase().includes(n)) : repos
  }, [repos, q])
  const groups = useMemo(() => groupByEnvironment(shown, model.platform.os), [shown, model.platform.os])
  const grouped = useMemo(() => groupByEnvironment(repos, model.platform.os).length > 1, [repos, model.platform.os])
  const running = new Set(Object.values(model.services).filter(s => s.pid !== null).map(s => s.repoId))

  const row = (r: Repo) => {
    const st = model.statuses[r.id]?.status
    const hint = actions.restartHints[r.id]
    const issue = rowIssue(model, r, !!hint)
    const sync = st ? [st.behind ? `↓${st.behind}` : '', st.ahead ? `↑${st.ahead}` : ''].filter(Boolean).join(' ') : ''
    const changed = st && !st.clean ? plural(st.changes.files, 'changed file') : ''
    return (
      <ActionRow key={r.id} label={r.name} onOpen={() => actions.select(r.id)}
        name={<button type="button" className="gm-ov-name truncate" onClick={() => actions.select(r.id)}>{r.name}</button>}
        status={(
          <span className="gm-ov-meta">
            {st && <span className="gm-mono gm-ov-branch truncate">{st.branch ?? 'detached'}</span>}
            {sync && <span className="num muted" aria-label={sync.replace('↓', 'behind ').replace('↑', 'ahead ')}>{sync}</span>}
            {changed && !issue && <span className="muted">{changed}</span>}
            {running.has(r.id) && <StatusIndicator state="ready" label="Running" />}
            {issue && (issue.tone === 'restart'
              ? <button type="button" className="gm-ov-issue gm-ov-restart" onClick={() => void ops.restartAffected(r.id)}>{hint?.text || 'Restart suggested'}</button>
              : <span className={`gm-ov-issue ${issue.tone === 'danger' ? 'gm-danger' : 'gm-warn'}`}>{issue.text}</span>)}
          </span>
        )}
        action={(
          <span className="gm-ov-actions">
            <Tooltip content="Open terminal"><IconButton icon="terminal" size="sm" label={`Terminal, ${r.name}`} onClick={() => ops.terminal(r)} /></Tooltip>
            <IconButton icon="more-h" size="sm" label={`Actions for ${r.name}`} aria-haspopup="menu"
              onClick={e => { const b = e.currentTarget.getBoundingClientRect(); setMenu({ repoId: r.id, x: b.right, y: b.bottom }) }} />
          </span>
        )}
        className="gm-ov-row"
      />
    )
  }

  return (
    <div className="gm-work">
      <header className="gm-top">
        <DrawerToggle />
        <h1 className="gm-h1">Repositories</h1>
        <span className="grow" />
        <SearchInput className="gm-ov-search" placeholder="Search" aria-label="Search repositories" value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') setQ('') }} />
        <MenuButton icon="plus" label="Add repositories" items={[
          { label: 'Add repository…', icon: 'folder-open', onSelect: actions.addRepoDialog },
          { label: 'Find repositories in a folder…', icon: 'search', onSelect: actions.findReposDialog },
          { type: 'sep' },
          { label: 'Rescan', icon: 'refresh', disabled: !!model.discovery?.running, onSelect: () => actions.rescan('common') },
        ]} />
      </header>
      <div className="gm-scroll scroll gm-ov-list" onKeyDown={e => {
        if (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return
        const rowEl = (e.target as HTMLElement).closest<HTMLElement>('[data-repo-id]')
        if (!rowEl) return
        e.preventDefault(); const b = rowEl.getBoundingClientRect(); setMenu({ repoId: rowEl.dataset.repoId!, x: b.left + 24, y: b.top + b.height / 2 })
      }} onContextMenu={e => {
        const rowEl = (e.target as HTMLElement).closest<HTMLElement>('[data-repo-id]')
        if (!rowEl) return
        e.preventDefault(); setMenu({ repoId: rowEl.dataset.repoId!, x: e.clientX, y: e.clientY })
      }}>
        {grouped
          ? groups.map(g => <section key={g.key} aria-label={g.label}><h2 className="eyebrow gm-ov-group">{g.label}</h2>{g.repos.map(r => <div key={r.id} data-repo-id={r.id}>{row(r)}</div>)}</section>)
          : shown.map(r => <div key={r.id} data-repo-id={r.id}>{row(r)}</div>)}
        {repos.length === 0 && (
          <div className="sm-empty sm-empty--center">
            <p className="sm-empty__text">{model.discovery?.running ? 'Looking for repositories' : 'No repositories'}</p>
          </div>
        )}
        {repos.length > 0 && shown.length === 0 && <p className="faint gm-side-empty">No matches</p>}
      </div>
      <RepoMenu model={model} actions={actions} target={menu} onClose={() => setMenu(null)} />
    </div>
  )
}
