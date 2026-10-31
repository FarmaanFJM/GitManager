import { useMemo, useState } from 'react'
import { Icon, MenuButton, NavItem, SearchInput } from '../../third_party/summa-ui/src/ui'
import logo from '../../assets/brand/GitManager-Summa.svg'
import { groupByEnvironment } from './util'

/** Summa-UI's brand row (.brand) with GitManager's own logo in place of the generic mark (see docs/BRANDING.md). */
function Brand() {
  return (
    <div className="brand">
      <img className="gm-brand-logo" src={logo} width={24} height={24} alt="" />
      <span>GitManager</span>
    </div>
  )
}
import type { Actions, Model, View } from './App'

/**
 * Repository navigation: one flat list (P11), a search field, and Settings in a lower region of the same sidebar (P14).
 * Each row shows only what helps choosing: the name, commits waiting to be pulled or pushed, and whether services run.
 */
export function Sidebar({ model, actions, view }: { model: Model; actions: Actions; view: View }) {
  const [q, setQ] = useState('')
  const repos = model.data.repos
  const shown = useMemo(() => {
    const n = q.trim().toLowerCase()
    const env = (r: typeof repos[number]) => r.location.kind === 'wsl' ? `wsl ${r.location.distro}`.toLowerCase() : ''
    return n ? repos.filter(r => r.name.toLowerCase().includes(n) || r.location.path.toLowerCase().includes(n) || env(r).includes(n)) : repos
  }, [repos, q])
  // Headings only when repositories live in more than one environment (Windows and a WSL distribution, or two distributions)
  const grouped = useMemo(() => groupByEnvironment(repos, model.platform.os).length > 1, [repos, model.platform.os])
  const groups = useMemo(() => groupByEnvironment(shown, model.platform.os), [shown, model.platform.os])
  const running = new Set(Object.values(model.services).filter(s => s.pid !== null).map(s => s.repoId))

  const row = (r: typeof repos[number]) => {
    const st = model.statuses[r.id]?.status
    const meta = st ? [st.behind ? `↓${st.behind}` : '', st.ahead ? `↑${st.ahead}` : ''].filter(Boolean).join(' ') : ''
    const current = view.kind !== 'settings' && view.kind !== 'storage' && model.data.ui.selectedRepoId === r.id
    return (
      <button key={r.id} type="button" className="nav-item" aria-current={current ? 'true' : undefined} onClick={() => actions.select(r.id)}
        title={`${r.location.kind === 'wsl' ? `${r.location.distro}: ${r.location.path}` : r.location.path}${r.worktree ? ' (worktree)' : ''}`}>
        <Icon name="folder" size={16} />
        <span className="truncate">{r.name}</span>
        <span className="gm-nav-meta">
          {meta && <span className="num" aria-label={[st?.behind ? `${st.behind} to pull` : '', st?.ahead ? `${st.ahead} to push` : ''].filter(Boolean).join(', ')}>{meta}</span>}
          {running.has(r.id) && <span className="gm-run-dot" role="img" aria-label="Services running" title="Services running" />}
        </span>
      </button>
    )
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('.nav-item'))
    const i = items.indexOf(document.activeElement as HTMLElement)
    const n = items[Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]
    if (n) { e.preventDefault(); n.focus() }
  }

  return (
    <div className="gm-side">
      <Brand />
      {repos.length > 0 && (
        <SearchInput className="gm-repo-search" placeholder="Search" aria-label="Search repositories" value={q} onChange={e => setQ(e.target.value)}
          onKeyDown={e => { if (e.key === 'Escape') setQ(''); if (e.key === 'ArrowDown') { e.preventDefault(); document.querySelector<HTMLElement>('.gm-repo-list .nav-item')?.focus() } }} />
      )}
      <div className="gm-side-head">
        <span className="eyebrow">Repositories</span>
        <MenuButton icon="plus" size="sm" label="Add repositories" items={[
          { label: 'Add repository…', icon: 'folder-open', onSelect: actions.addRepoDialog },
          { label: 'Find repositories in a folder…', icon: 'search', onSelect: actions.findReposDialog },
          { type: 'sep' },
          { label: 'Rescan for repositories', icon: 'refresh', disabled: !!model.discovery?.running, onSelect: () => actions.rescan('common') },
        ]} />
      </div>
      <nav className="gm-repo-list col scroll grow" aria-label="Repositories" onKeyDown={onKeyDown}>
        {grouped
          ? groups.map(g => (
            <section key={g.key} className="gm-repo-group" aria-label={g.label}>
              <h2 className="eyebrow">{g.label}</h2>
              {g.repos.map(row)}
            </section>
          ))
          : shown.map(row)}
        {repos.length > 0 && !shown.length && <p className="gm-side-empty faint">No matches</p>}
      </nav>
      {model.discovery?.running && (
        <p className="gm-discovery" role="status"><span className="sm-spinner" aria-hidden="true" />Finding repositories{model.discovery.added ? `, ${model.discovery.added} added` : ''}</p>
      )}
      <div className="gm-side-foot">
        <NavItem icon="drive" label="Storage" current={view.kind === 'storage'} onClick={() => actions.setView({ kind: 'storage' })} />
        <NavItem icon="settings" label="Settings" current={view.kind === 'settings'} onClick={() => actions.setView({ kind: 'settings' })} />
      </div>
    </div>
  )
}

Sidebar.Skeleton = function SidebarSkeleton() {
  return (
    <div className="gm-side" aria-busy="true">
      <Brand />
      <div className="gm-side-head"><span className="eyebrow">Repositories</span></div>
      {[64, 48, 72].map((w, i) => <div key={i} className="gm-sk-nav"><span className="skeleton" style={{ width: `${w}%`, height: 10 }} /></div>)}
    </div>
  )
}
