import { useMemo, useState } from 'react'
import { Icon, MenuButton, SearchInput, Tabs, type IconName, type MenuEntry } from '../../../../third_party/summa-ui/src/ui'
import type { RetiredRunner, Runner, RunnerAction, RunnersInventory } from '../../../shared/runners'
import { plural } from '../../util'
import { ENV_TEXT, OS_TEXT, StatusMark, machineText, scopeText } from '../common'
import { RetiredList } from './RetiredList'
import { matchesSearch, sortRunners, type SortKey } from './tableLogic'

type Filter = 'all' | 'online' | 'offline' | 'attention' | 'local' | 'github'
export function RunnerTable({ inv, selected, busy, onSelect, onAction, onRestore, onCleanup }: {
  inv: RunnersInventory; selected: string | null; busy: Record<string, RunnerAction>; onSelect: (key: string) => void; onAction: (r: Runner, action: RunnerAction | 'retire') => void
  onRestore: (r: RetiredRunner) => void; onCleanup: (r: RetiredRunner) => void
}) {
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'name', dir: 1 })
  const rows = useMemo(() => {
    const needle = q.trim()
    const list = inv.runners.filter(r => matchesSearch(r, needle) && (filter === 'all' || (filter === 'online' ? r.status === 'online' || r.status === 'busy' : filter === 'offline' ? r.status === 'offline' : filter === 'attention' ? r.attention.length > 0 : filter === 'local' ? !!r.local : !r.local)))
    return sortRunners(list, sort.key, sort.dir)
  }, [inv.runners, q, filter, sort])
  const head = (key: SortKey, label: string, cls = '') => {
    const on = sort.key === key
    return (
      <span role="columnheader" aria-sort={on ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'} className={cls}>
        <button type="button" className={`gm-th ${on ? 'on' : ''}`} onClick={() => setSort(s => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : 1 }))}>
          {label}<Icon name={on && sort.dir === -1 ? 'arrow-down' : 'arrow-up'} size={12} />
        </button>
      </span>
    )
  }
  const count = (f: Filter) => inv.runners.filter(r => f === 'all' || (f === 'online' ? r.status === 'online' || r.status === 'busy' : f === 'offline' ? r.status === 'offline' : f === 'attention' ? r.attention.length > 0 : f === 'local' ? !!r.local : !r.local)).length
  const tabs: { value: Filter; label: string }[] = [
    { value: 'all', label: `All ${inv.runners.length}` }, { value: 'online', label: `Online ${count('online')}` }, { value: 'offline', label: `Offline ${count('offline')}` },
    { value: 'attention', label: `Needs attention ${count('attention')}` }, { value: 'local', label: `Here ${count('local')}` }, { value: 'github', label: `GitHub only ${count('github')}` },
  ]
  const menu = (r: Runner): MenuEntry[] => {
    const c = r.capabilities
    const item = (label: string, action: RunnerAction | 'retire', cap: { allowed: boolean }, icon: IconName, danger = false): MenuEntry => ({ label, icon, danger, disabled: !cap.allowed || !!busy[r.local?.key ?? r.key], onSelect: () => onAction(r, action) })
    return [
      item('Start', 'start', c.start, 'play'), item('Stop', 'stop', c.stop, 'stop'), item('Restart', 'restart', c.restart, 'refresh'),
      { type: 'sep' },
      item('Inspect service state', 'inspect', c.inspect, 'activity'), item('Check for updates', 'check-update', c.checkUpdate, 'download'),
      { type: 'sep' },
      ...(r.local && !r.github ? [item('Retire installation', 'retire', c.retire, 'archive')] : []),
      item('Remove registration', 'unregister', c.unregister, 'unlock', true), item('Uninstall', 'uninstall', c.uninstall, 'trash', true),
    ]
  }
  return (
    <div className="gm-rtab">
      <div className="gm-toolbar gm-filter-row gm-rtab-tools">
        <SearchInput className="gm-branch-search" placeholder="Search name, repository, machine, path, label" aria-label="Search runners" value={q} onChange={e => setQ(e.target.value)} />
        <Tabs label="Filter runners" flat value={filter} onChange={setFilter} items={tabs} />
      </div>
      <div className="gm-btable gm-rtable2" role="table" aria-label="Runners" aria-rowcount={rows.length}>
        <div className="gm-bhead" role="row">
          {head('name', 'Runner')}
          {head('status', 'Status')}
          {head('platform', 'Platform', 'gm-col-plat')}
          {head('environment', 'Environment', 'gm-col-env')}
          {head('machine', 'Machine', 'gm-col-machine')}
          <span role="columnheader" className="gm-col-distro">Distribution</span>
          {head('scope', 'Project or scope', 'gm-col-scope')}
          <span role="columnheader" className="gm-col-path">Installation path</span>
          {head('version', 'Version', 'gm-col-ver')}
          <span role="columnheader" className="gm-col-act"><span className="sr-only">Actions</span></span>
        </div>
        <div className="gm-bbody scroll" role="rowgroup">
          {rows.map(r => (
            <div key={r.key} role="row" className={`gm-brow gm-rrow ${selected === r.key ? 'selected' : ''}`} aria-selected={selected === r.key}
              onClick={() => onSelect(r.key)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(r.key) } }} tabIndex={0}>
              <span role="cell" className="gm-bname gm-rname">
                <span className="truncate" title={r.name}>{r.name}</span>
                {r.attention.length > 0 && <Icon name="triangle-alert" size={13} className="gm-warn" aria-label={plural(r.attention.length, 'note')} />}
              </span>
              <span role="cell" className="gm-col-status"><StatusMark status={r.status} /></span>
              <span role="cell" className="gm-col-plat muted">{OS_TEXT[r.platform]}</span>
              <span role="cell" className="gm-col-env muted">{ENV_TEXT[r.environment]}</span>
              <span role="cell" className="gm-col-machine muted truncate">{machineText(r)}</span>
              <span role="cell" className="gm-col-distro muted truncate">{r.distro ?? ''}</span>
              <span role="cell" className="gm-col-scope truncate" title={scopeText(r.scope)}>{r.scope ? scopeText(r.scope) : <span className="faint">Unknown</span>}</span>
              <span role="cell" className="gm-col-path gm-mono-sm truncate" title={r.path ?? undefined}>{r.path ?? ''}</span>
              <span role="cell" className="gm-col-ver num muted">{r.version ?? ''}</span>
              <span role="cell" className="gm-col-act gm-row-actions" onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
                <MenuButton size="sm" label={`Actions for ${r.name}`} items={menu(r)} />
              </span>
            </div>
          ))}
          {rows.length === 0 && <p className="gm-section-empty muted">{inv.runners.length ? 'No runners match.' : 'No runners yet.'}</p>}
        </div>
      </div>
      <RetiredList items={inv.retired} busy={busy} onRestore={onRestore} onCleanup={onCleanup} />
    </div>
  )
}
