import { useMemo, useState } from 'react'
import { Brand, Icon, MenuButton, NavItem, SearchInput } from '../../third_party/summa-ui/src/ui'
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
    return n ? repos.filter(r => r.name.toLowerCase().includes(n) || r.location.path.toLowerCase().includes(n)) : repos
  }, [repos, q])
  const running = new Set(Object.values(model.services).filter(s => s.pid !== null).map(s => s.repoId))

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('.nav-item'))
    const i = items.indexOf(document.activeElement as HTMLElement)
    const n = items[Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]
    if (n) { e.preventDefault(); n.focus() }
  }

  return (
    <div className="gm-side">
      <Brand name="GitManager" />
      {repos.length > 0 && (
        <SearchInput className="gm-repo-search" placeholder="Search" aria-label="Search repositories" value={q} onChange={e => setQ(e.target.value)}
          onKeyDown={e => { if (e.key === 'Escape') setQ(''); if (e.key === 'ArrowDown') { e.preventDefault(); document.querySelector<HTMLElement>('.gm-repo-list .nav-item')?.focus() } }} />
      )}
      <div className="gm-side-head">
        <span className="eyebrow">Repositories</span>
        <MenuButton icon="plus" size="sm" label="Add repositories" items={[
          { label: 'Add repository…', icon: 'folder-open', onSelect: actions.addRepoDialog },
          { label: 'Find repositories in a folder…', icon: 'search', onSelect: actions.findReposDialog },
        ]} />
      </div>
      <nav className="gm-repo-list col scroll grow" aria-label="Repositories" onKeyDown={onKeyDown}>
        {shown.map(r => {
          const st = model.statuses[r.id]?.status
          const meta = st ? [st.behind ? `↓${st.behind}` : '', st.ahead ? `↑${st.ahead}` : ''].filter(Boolean).join(' ') : ''
          const current = view.kind !== 'settings' && model.data.ui.selectedRepoId === r.id
          return (
            <button key={r.id} type="button" className="nav-item" aria-current={current ? 'true' : undefined} onClick={() => actions.select(r.id)}
              title={r.location.kind === 'wsl' ? `${r.location.distro}: ${r.location.path}` : r.location.path}>
              <Icon name="folder" size={16} />
              <span className="truncate">{r.name}</span>
              <span className="gm-nav-meta">
                {meta && <span className="num" aria-label={[st?.behind ? `${st.behind} to pull` : '', st?.ahead ? `${st.ahead} to push` : ''].filter(Boolean).join(', ')}>{meta}</span>}
                {running.has(r.id) && <span className="gm-run-dot" role="img" aria-label="Services running" title="Services running" />}
              </span>
            </button>
          )
        })}
        {repos.length > 0 && !shown.length && <p className="gm-side-empty faint">No matches</p>}
      </nav>
      <div className="gm-side-foot">
        <NavItem icon="settings" label="Settings" current={view.kind === 'settings'} onClick={() => actions.setView({ kind: 'settings' })} />
      </div>
    </div>
  )
}

Sidebar.Skeleton = function SidebarSkeleton() {
  return (
    <div className="gm-side" aria-busy="true">
      <Brand name="GitManager" />
      <div className="gm-side-head"><span className="eyebrow">Repositories</span></div>
      {[64, 48, 72].map((w, i) => <div key={i} className="gm-sk-nav"><span className="skeleton" style={{ width: `${w}%`, height: 10 }} /></div>)}
    </div>
  )
}
