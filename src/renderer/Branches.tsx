import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Dropdown, Icon, IconButton, SearchInput, Tabs, Tag } from '../../third_party/summa-ui/src/ui'
import type { BranchDetail, BranchOverview, BranchRow, OpError, Repo } from '../shared/types'
import { api } from './api'
import { CommitRow, ErrorBanner } from './Workspace'
import { ago, plural } from './util'

type SortKey = 'name' | 'ahead' | 'behind' | 'date'
type Filter = 'all' | 'local' | 'remote'

const COMPARE_LABEL: Record<BranchRow['compare'], string> = {
  base: 'Default', 'up-to-date': 'Up to date', ahead: 'Ahead', behind: 'Behind', diverged: 'Diverged', unrelated: 'Unrelated', unknown: '',
}

function upstreamText(b: BranchRow): string {
  if (b.kind !== 'local') return ''
  switch (b.upstreamState) {
    case 'none': return 'No upstream'
    case 'gone': return 'Upstream gone'
    case 'in-sync': return 'In sync'
    default: return [b.upstreamAhead ? `↑${b.upstreamAhead}` : '', b.upstreamBehind ? `↓${b.upstreamBehind}` : ''].filter(Boolean).join(' ')
  }
}

const SOURCE_TEXT = { 'remote-head': 'default branch of', 'ls-remote': 'default branch advertised by', user: 'chosen by you' } as const

/**
 * Every local and remote-tracking branch compared with the repository's default branch, from the last fetched state.
 * Opening a branch shows its details; nothing is checked out until the user presses the switch action.
 */
export function BranchesPanel({ repo, reloadKey, onSwitch, onTrack, onCount }: {
  repo: Repo; reloadKey: number; onSwitch: (name: string) => void; onTrack: (remoteRef: string) => void; onCount: (n: number) => void
}) {
  const [data, setData] = useState<BranchOverview | null>(null)
  const [error, setError] = useState<OpError | null>(null)
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'date', dir: -1 })
  const [selected, setSelected] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  const seq = useRef(0)

  useEffect(() => {
    const n = ++seq.current
    setLoading(true)
    void api.branchOverview(repo.id).then(r => {
      if (n !== seq.current) return
      setLoading(false)
      if (r.ok) { setData(r.value); setError(null); onCount(r.value.branches.length) } else setError(r.error)
    })
  }, [repo.id, reloadKey, version, onCount])

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const list = (data?.branches ?? []).filter(b => (filter === 'all' || b.kind === filter) && (!needle || b.name.toLowerCase().includes(needle)))
    const num = (v: number | null) => (v === null ? -1 : v)
    const cmp: Record<SortKey, (a: BranchRow, b: BranchRow) => number> = {
      name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }),
      ahead: (a, b) => num(a.ahead) - num(b.ahead),
      behind: (a, b) => num(a.behind) - num(b.behind),
      date: (a, b) => a.date - b.date,
    }
    // The base and the checked-out branch stay on top: they are what the others are read against.
    const pin = (b: BranchRow) => (b.isBase ? 0 : b.current ? 1 : 2)
    return list.sort((a, b) => pin(a) - pin(b) || cmp[sort.key](a, b) * sort.dir || a.name.localeCompare(b.name))
  }, [data, q, filter, sort])

  const sel = data?.branches.find(b => b.ref === selected) ?? null
  const setBase = async (name: string | null) => {
    const r = await api.setCompareBase(repo.id, name)
    if (!r.ok) setError(r.error); else setVersion(v => v + 1)
  }
  const head = (key: SortKey, label: string, cls = '') => {
    const on = sort.key === key
    return (
      <span role="columnheader" aria-sort={on ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'} className={cls}>
        <button type="button" className={`gm-th ${on ? 'on' : ''}`} onClick={() => setSort(s => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : key === 'name' ? 1 : -1 }))}>
          {label}<Icon name={on && sort.dir === 1 ? 'arrow-up' : 'arrow-down'} size={12} />
        </button>
      </span>
    )
  }
  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('.gm-brow'))
    const i = items.indexOf(document.activeElement as HTMLElement)
    const n = items[Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]
    if (n) { e.preventDefault(); n.focus() }
  }

  const base = data?.base
  const baseOptions = (data?.branches ?? []).map(b => ({ value: b.name, label: b.name, meta: b.kind === 'remote' ? 'remote' : undefined }))

  return (
    <div className="gm-branches">
      <div className="gm-branch-pane">
        <div className="gm-toolbar gm-branch-toolbar">
          <SearchInput className="gm-branch-search" placeholder="Search branches" aria-label="Search branches" value={q} onChange={e => setQ(e.target.value)} />
          <Tabs label="Show" flat value={filter} onChange={setFilter} items={[{ value: 'all', label: 'All' }, { value: 'local', label: 'Local' }, { value: 'remote', label: 'Remote' }]} />
          <span className="grow" />
          {loading && data && <span className="sm-spinner" aria-label="Updating" />}
          <span className="gm-label">Compared with</span>
          <Dropdown label="Comparison base" quiet searchable width={300} value={base?.name ?? null} placeholder="Choose a base"
            options={[...(data && data.base?.source === 'user' ? [{ value: '\u0000auto', label: 'Detect automatically' }] : []), ...baseOptions]}
            onChange={v => void setBase(v === '\u0000auto' ? null : v)} />
        </div>
        <p className="gm-branch-meta">
          {base
            ? <>{base.name} is the {SOURCE_TEXT[base.source]}{base.source !== 'user' && base.remote ? ` ${base.remote}` : ''}. Ahead and behind count commits against it. </>
            : null}
          {data?.remotes.length ? <span className="faint">Remote branches as of the last fetch{data.lastFetch ? `, ${ago(data.lastFetch)}` : ' (never fetched)'}.</span> : null}
        </p>
        {data?.baseProblem && <p className="gm-branch-problem" role="status"><Icon name="info" size={15} />{data.baseProblem}</p>}
        {error && <ErrorBanner error={error} onDismiss={() => setError(null)} />}
        {data?.detached && <p className="gm-branch-meta faint">HEAD is detached at {data.head}; no branch is checked out.</p>}

        {!data && loading ? (
          <div className="gm-scroll" aria-busy="true">{[60, 44, 70, 52, 38].map((w, i) => <div key={i} className="gm-brow sk"><span /><span className="skeleton" style={{ width: `${w}%`, height: 10 }} /></div>)}</div>
        ) : data && data.branches.length === 0 ? (
          <div className="sm-empty"><p className="sm-empty__text">This repository has no branches yet.</p></div>
        ) : (
          <div className="gm-btable" role="table" aria-label="Branches" aria-rowcount={rows.length}>
            <div className="gm-bhead" role="row">
              <span role="columnheader"><span className="sr-only">Checked out</span></span>
              {head('name', 'Branch')}
              <span role="columnheader" className="gm-col-kind">Type</span>
              {head('behind', 'Behind', 'gm-col-num')}
              {head('ahead', 'Ahead', 'gm-col-num')}
              <span role="columnheader">Status</span>
              <span role="columnheader" className="gm-col-up">Upstream</span>
              <span role="columnheader" className="gm-col-commit">Last commit</span>
              {head('date', 'Date', 'gm-col-date')}
            </div>
            <div className="gm-bbody scroll" role="rowgroup" onKeyDown={onListKey}>
              {rows.map(b => (
                <button key={b.ref} type="button" role="row" className={`gm-brow ${selected === b.ref ? 'selected' : ''}`} aria-selected={selected === b.ref} onClick={() => setSelected(b.ref)}
                  title={`${b.ref} at ${b.short}`}>
                  <span role="cell" className="gm-bmark">{b.current && <Icon name="check" size={14} aria-label="Checked out" role="img" />}</span>
                  <span role="cell" className="gm-bname"><span className="truncate">{b.name}</span>{b.isBase && <Tag>Default</Tag>}{b.current && <span className="sr-only">, checked out</span>}</span>
                  <span role="cell" className="gm-col-kind muted">{b.kind === 'local' ? 'Local' : 'Remote'}</span>
                  <span role="cell" className="gm-col-num num">{b.isBase || b.compare === 'unrelated' ? '' : b.behind ?? ''}</span>
                  <span role="cell" className="gm-col-num num">{b.isBase || b.compare === 'unrelated' ? '' : b.ahead ?? ''}</span>
                  <span role="cell" className={`gm-bstate gm-cmp-${b.compare}`}>{COMPARE_LABEL[b.compare]}</span>
                  <span role="cell" className={`gm-col-up ${b.upstreamState === 'gone' ? 'gm-warn' : 'muted'}`}>{upstreamText(b)}</span>
                  <span role="cell" className="gm-col-commit truncate muted">{b.subject}</span>
                  <span role="cell" className="gm-col-date muted">{ago(b.date)}</span>
                </button>
              ))}
              {rows.length === 0 && <p className="gm-section-empty muted">No branches match.</p>}
            </div>
          </div>
        )}
      </div>
      {sel && data && (
        <BranchDetailPane key={sel.ref} repo={repo} row={sel} overview={data} onClose={() => setSelected(null)}
          onSwitch={onSwitch} onTrack={onTrack} onMissing={() => { setSelected(null); setVersion(v => v + 1) }} />
      )}
    </div>
  )
}

/** Details of one ref, side by side with the list (a content pane, not a second navigation sidebar: P14). */
function BranchDetailPane({ repo, row, overview, onClose, onSwitch, onTrack, onMissing }: {
  repo: Repo; row: BranchRow; overview: BranchOverview; onClose: () => void; onSwitch: (n: string) => void; onTrack: (r: string) => void; onMissing: () => void
}) {
  const [d, setD] = useState<BranchDetail | null>(null)
  const [error, setError] = useState<OpError | null>(null)
  const base = overview.base
  useEffect(() => {
    if (!base || row.isBase) return
    void api.branchDetail(repo.id, row.ref, base.ref).then(r => { if (r.ok) setD(r.value); else setError(r.error) })
  }, [repo.id, row.ref, row.isBase, base])

  const short = row.kind === 'remote' && row.remote ? row.name.slice(row.remote.length + 1) : row.name
  const localTwin = row.kind === 'remote' ? overview.branches.find(b => b.kind === 'local' && b.name === short) : undefined
  const compareText = row.isBase ? 'This is the comparison base.'
    : row.compare === 'unrelated' ? 'No common history with the base.'
      : row.ahead === null ? '' : `${plural(row.ahead, 'commit')} ahead, ${plural(row.behind ?? 0, 'commit')} behind`

  return (
    <aside className="gm-bdetail" aria-label={`Branch ${row.name}`}>
      <div className="gm-bdetail-head">
        <h2 className="gm-h1 truncate" title={row.name}>{row.name}</h2>
        <span className="grow" />
        <IconButton icon="x" size="sm" label="Close details" onClick={onClose} />
      </div>
      <div className="gm-bdetail-body scroll">
        <dl className="gm-props">
          <dt>Reference</dt><dd className="gm-mono truncate" title={row.ref}>{row.ref}</dd>
          <dt>Compared with</dt><dd>{base ? base.name : 'No base'}</dd>
          {compareText && <><dt>Against base</dt><dd>{compareText}</dd></>}
          {row.kind === 'local' && <><dt>Upstream</dt><dd>{row.upstream ? `${row.upstream}, ${upstreamText(row).toLowerCase()}` : 'None'}</dd></>}
          <dt>Latest commit</dt><dd><span className="gm-mono faint">{row.short}</span> {row.subject}<div className="faint">{row.author}, {ago(row.date)}</div></dd>
        </dl>

        <div className="gm-bdetail-actions">
          {row.current ? <span className="muted"><Icon name="check" size={14} /> Checked out</span>
            : row.kind === 'local' ? <Button variant="primary" onClick={() => onSwitch(row.name)}>Switch to {row.name}</Button>
              : localTwin ? <span className="muted">Tracked by the local branch {localTwin.name}.</span>
                : <Button variant="primary" onClick={() => onTrack(row.name)}>Create local branch {short}</Button>}
        </div>

        {error && <ErrorBanner error={error} onDismiss={() => { setError(null); if (error.code === 'NO_REF') onMissing() }} />}
        {!row.isBase && base && !d && !error && <div className="gm-loading-line"><span className="sm-spinner" aria-hidden="true" /> Comparing</div>}
        {d && (
          <>
            <section className="gm-section" aria-label="Commits only on this branch">
              <h3 className="gm-section-h">Only on {d.name} <span className="faint num">{d.unique.length >= 100 ? '100+' : d.unique.length}</span></h3>
              {d.unique.length ? <ul className="gm-commits">{d.unique.map(c => <CommitRow key={c.hash} c={c} compact />)}</ul> : <p className="gm-section-empty muted">None.</p>}
            </section>
            <section className="gm-section" aria-label="Commits on the base missing from this branch">
              <h3 className="gm-section-h">On {d.baseName}, not on {d.name} <span className="faint num">{d.missing.length >= 100 ? '100+' : d.missing.length}</span></h3>
              {d.missing.length ? <ul className="gm-commits">{d.missing.map(c => <CommitRow key={c.hash} c={c} compact />)}</ul> : <p className="gm-section-empty muted">None.</p>}
            </section>
            {d.mergeBase && (
              <section className="gm-section" aria-label="Changed files">
                <h3 className="gm-section-h">Changed since {d.mergeBase.slice(0, 7)} <span className="faint">{d.stat}</span></h3>
                {d.files.length ? (
                  <ul className="gm-files">
                    {d.files.map(f => <li key={f.path + (f.from ?? '')}><span className="gm-fstatus">{f.status}</span><span className="truncate gm-mono" title={f.from ? `${f.from} → ${f.path}` : f.path}>{f.from ? `${f.from} → ${f.path}` : f.path}</span></li>)}
                    {d.filesTotal > d.files.length && <li className="faint">and {d.filesTotal - d.files.length} more</li>}
                  </ul>
                ) : <p className="gm-section-empty muted">No changes.</p>}
              </section>
            )}
          </>
        )}
      </div>
    </aside>
  )
}
