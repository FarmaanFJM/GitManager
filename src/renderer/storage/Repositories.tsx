import { useMemo, useState } from 'react'
import { Button, Icon, MenuButton, SearchInput, Tabs, Tag } from '../../../third_party/summa-ui/src/ui'
import type { Artifact, ArtifactClass, RepoInventory, StorageState } from '../../shared/storage'
import { formatBytes, repoTotals } from '../../shared/storageTotals'
import { api } from '../api'
import { plural } from '../util'
import { CATEGORY_LABEL, ClassTag, dateText } from './common'

type SortKey = 'name' | 'type' | 'size' | 'created' | 'workflow' | 'branch' | 'class'
type Filter = 'all' | ArtifactClass
const PAGE = 100
const ORDER: Record<ArtifactClass, number> = { 'delete-candidate': 0, review: 1, keep: 2, protected: 3, expired: 4 }

export function RepoList({ st, onOpen }: { st: StorageState; onOpen: (repo: string) => void }) {
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<{ key: 'name' | 'size' | 'reclaim' | 'count'; dir: 1 | -1 }>({ key: 'size', dir: -1 })
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const list = (st.snapshot?.repos ?? []).filter(r => !needle || r.repo.toLowerCase().includes(needle)).map(r => ({ r, t: repoTotals(r) }))
    const val = { name: (x: typeof list[number]) => x.r.repo.toLowerCase(), size: (x: typeof list[number]) => x.t.retainedBytes, reclaim: (x: typeof list[number]) => x.t.reclaimableBytes, count: (x: typeof list[number]) => x.t.artifacts }[sort.key]
    return list.sort((a, b) => (val(a) < val(b) ? -1 : val(a) > val(b) ? 1 : 0) * sort.dir)
  }, [st.snapshot, q, sort])
  if (!st.snapshot) return <div className="sm-empty sm-empty--center gm-storage-empty"><p className="sm-empty__text">Scan to list your repositories.</p></div>
  const head = (key: typeof sort.key, label: string, cls = '') => {
    const on = sort.key === key
    return (
      <span role="columnheader" aria-sort={on ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'} className={cls}>
        <button type="button" className={`gm-th ${on ? 'on' : ''}`} onClick={() => setSort(s => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : key === 'name' ? 1 : -1 }))}>
          {label}<Icon name={on && sort.dir === 1 ? 'arrow-up' : 'arrow-down'} size={12} />
        </button>
      </span>
    )
  }
  return (
    <div className="gm-storage-pane">
      <div className="gm-toolbar">
        <SearchInput className="gm-branch-search" placeholder="Search repositories" aria-label="Search repositories" value={q} onChange={e => setQ(e.target.value)} />
      </div>
      <div className="gm-btable gm-rtable" role="table" aria-label="Repositories" aria-rowcount={rows.length}>
        <div className="gm-bhead" role="row">
          {head('name', 'Repository')}
          {head('count', 'Artifacts', 'gm-col-num')}
          {head('size', 'Retained', 'gm-col-num')}
          {head('reclaim', 'Reclaimable', 'gm-col-num')}
          <span role="columnheader">Status</span>
        </div>
        <div className="gm-bbody scroll" role="rowgroup">
          {rows.map(({ r, t }) => (
            <button key={r.repo} type="button" role="row" className="gm-brow" onClick={() => onOpen(r.repo)}>
              <span role="cell" className="gm-bname"><span className="truncate">{r.repo}</span>{r.private && <Tag>Private</Tag>}</span>
              <span role="cell" className="gm-col-num num">{r.error ? '' : t.artifacts}</span>
              <span role="cell" className="gm-col-num num">{r.error ? '' : formatBytes(t.retainedBytes)}</span>
              <span role="cell" className={`gm-col-num num ${t.reclaimableBytes ? 'gm-stat-accent' : 'faint'}`}>{r.error ? '' : t.reclaimableBytes ? formatBytes(t.reclaimableBytes) : '–'}</span>
              <span role="cell" className={r.error ? 'gm-warn truncate' : 'muted truncate'} title={r.error ?? undefined}>
                {r.error ? 'Could not read' : r.protectedRepo ? 'Protected repository' : !r.canDelete ? 'Read-only' : r.limits.length ? 'Partial context' : ''}
              </span>
            </button>
          ))}
          {rows.length === 0 && <p className="gm-section-empty muted">No repositories match.</p>}
        </div>
      </div>
    </div>
  )
}

const cmpFor = (key: SortKey): ((a: Artifact, b: Artifact) => number) => {
  switch (key) {
    case 'name': return (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })
    case 'type': return (a, b) => a.category.localeCompare(b.category) || a.platform.localeCompare(b.platform)
    case 'size': return (a, b) => a.sizeBytes - b.sizeBytes
    case 'created': return (a, b) => Date.parse(a.createdAt ?? '0') - Date.parse(b.createdAt ?? '0')
    case 'workflow': return (a, b) => (a.run?.name ?? '').localeCompare(b.run?.name ?? '') || (a.runId ?? 0) - (b.runId ?? 0)
    case 'branch': return (a, b) => (a.headBranch ?? '').localeCompare(b.headBranch ?? '')
    case 'class': return (a, b) => ORDER[a.class] - ORDER[b.class]
  }
}

export function RepoDetail({ st, repo, onBack, onEditPolicy, onReview }: { st: StorageState; repo: RepoInventory; onBack: () => void; onEditPolicy: (repo: string) => void; onReview: (repos: string[]) => void }) {
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'class', dir: 1 })
  const [shown, setShown] = useState(PAGE)
  const t = repoTotals(repo)
  const counts = (c: ArtifactClass) => t.byClass[c].count
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const list = repo.artifacts.filter(a => (filter === 'all' || a.class === filter) && (!needle || [a.name, a.run?.name, a.headBranch, a.headSha, a.reason, String(a.runId)].some(v => v?.toLowerCase().includes(needle))))
    const c = cmpFor(sort.key)
    return list.sort((a, b) => c(a, b) * sort.dir || Date.parse(b.createdAt ?? '0') - Date.parse(a.createdAt ?? '0'))
  }, [repo.artifacts, q, filter, sort])
  const head = (key: SortKey, label: string, cls = '') => {
    const on = sort.key === key
    return (
      <span role="columnheader" aria-sort={on ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'} className={cls}>
        <button type="button" className={`gm-th ${on ? 'on' : ''}`} onClick={() => setSort(s => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : key === 'name' || key === 'class' ? 1 : -1 }))}>
          {label}<Icon name={on && sort.dir === 1 ? 'arrow-up' : 'arrow-down'} size={12} />
        </button>
      </span>
    )
  }
  const policy = st.config.policies[repo.repo.toLowerCase()] ?? st.config.defaultPolicy
  const modeText = { manual: 'Manual', recommend: 'Recommendations', 'auto-safe': 'Automatic safe cleanup' }[policy.mode]
  const tabs: { value: Filter; label: string }[] = [
    { value: 'all', label: `All ${repo.artifacts.length}` },
    { value: 'protected', label: `Protected ${counts('protected')}` }, { value: 'keep', label: `Keep ${counts('keep')}` },
    { value: 'review', label: `Review ${counts('review')}` }, { value: 'delete-candidate', label: `Delete candidate ${counts('delete-candidate')}` },
    { value: 'expired', label: `Expired ${counts('expired')}` },
  ]

  return (
    <div className="gm-storage-pane">
      <div className="gm-toolbar gm-repo-head">
        <Button variant="ghost" icon="arrow-left" onClick={onBack}>Repositories</Button>
        <h2 className="gm-h1 truncate">{repo.repo}</h2>
        {repo.protectedRepo && <Tag icon="shield">Protected repository</Tag>}
        {!repo.canDelete && <Tag icon="lock">Read-only</Tag>}
        <span className="grow" />
        <span className="muted gm-repo-sum">{formatBytes(t.retainedBytes)} retained · <span className={t.reclaimableBytes ? 'gm-stat-accent' : ''}>{formatBytes(t.reclaimableBytes)} reclaimable</span></span>
        <Button variant="secondary" icon="trash" disabled={!t.byClass['delete-candidate'].count || !repo.canDelete} onClick={() => onReview([repo.repo])}>Review cleanup</Button>
        <MenuButton label="Repository actions" items={[
          { label: repo.protectedRepo ? 'Remove repository protection' : 'Protect this repository', icon: 'shield', onSelect: () => void api.storageProtectRepo(repo.repo, !repo.protectedRepo) },
          { label: `Cleanup policy (${modeText})…`, icon: 'sliders', onSelect: () => onEditPolicy(repo.repo) },
          { type: 'sep' },
          { label: 'Open Actions on GitHub', icon: 'external', onSelect: () => void api.storageOpen({ kind: 'repo-actions', repo: repo.repo }) },
        ]} />
      </div>
      {repo.error && <p className="gm-branch-problem" role="status"><Icon name="circle-alert" size={15} />{repo.error}</p>}
      {repo.limits.filter(l => l.area !== 'artifacts' || !repo.error).map(l => <p key={l.area + l.message} className="gm-branch-problem" role="status"><Icon name="info" size={15} />{l.message}</p>)}
      <div className="gm-toolbar gm-filter-row">
        <SearchInput className="gm-branch-search" placeholder="Search artifacts, workflows, branches, commits" aria-label="Search artifacts" value={q} onChange={e => { setQ(e.target.value); setShown(PAGE) }} />
        <Tabs label="Classification" flat value={filter} onChange={v => { setFilter(v); setShown(PAGE) }} items={tabs} />
      </div>
      <div className="gm-btable gm-atable" role="table" aria-label="Artifacts" aria-rowcount={rows.length}>
        <div className="gm-bhead" role="row">
          {head('name', 'Artifact')}
          {head('type', 'Type')}
          {head('size', 'Size', 'gm-col-num')}
          {head('created', 'Created')}
          {head('workflow', 'Workflow · run')}
          {head('branch', 'Branch · commit')}
          {head('class', 'Classification')}
          <span role="columnheader">Reason</span>
          <span role="columnheader"><span className="sr-only">Actions</span></span>
        </div>
        <div className="gm-bbody scroll" role="rowgroup">
          {rows.slice(0, shown).map(a => (
            <div key={a.id} role="row" className="gm-brow gm-arow">
              <span role="cell" className="gm-bname"><span className="truncate" title={a.name}>{a.name}</span>{a.pinned && <Icon name="bookmark" size={13} aria-label="Pinned" />}</span>
              <span role="cell" className="muted truncate">{CATEGORY_LABEL[a.category]}{a.platform !== 'unknown' ? ` · ${a.platform}` : ''}</span>
              <span role="cell" className="gm-col-num num">{a.expired ? '–' : formatBytes(a.sizeBytes)}</span>
              <span role="cell" className="muted" title={a.createdAt ?? undefined}>{dateText(a.createdAt)}</span>
              <span role="cell" className="truncate" title={a.run?.path ?? undefined}>
                {a.runId ? <button type="button" className="gm-linkbtn" title="Open this workflow run on GitHub" onClick={() => void api.storageOpen({ kind: 'run', repo: repo.repo, runId: a.runId! })}>{a.run?.name ?? 'Run'} #{a.run?.runNumber ?? a.runId}</button> : <span className="faint">Unknown run</span>}
                {a.run?.conclusion && a.run.conclusion !== 'success' && <span className="gm-warn"> {a.run.conclusion}</span>}
              </span>
              <span role="cell" className="truncate gm-mono-sm" title={`${a.headBranch ?? ''} ${a.headSha ?? ''}`}>{a.headBranch ?? '–'} <span className="faint">{a.headSha ? a.headSha.slice(0, 7) : ''}</span></span>
              <span role="cell"><ClassTag cls={a.class} reasonCode={a.reasonCode} /></span>
              <span role="cell" className="gm-reason" title={a.reason}>{a.reason}</span>
              <span role="cell" className="gm-row-actions">
                <MenuButton size="sm" label={`Actions for ${a.name}`} items={[
                  { label: 'Open workflow run', icon: 'external', disabled: !a.runId, onSelect: () => void api.storageOpen({ kind: 'run', repo: repo.repo, runId: a.runId! }) },
                  ...(a.expired ? [] : [a.pinned
                    ? { label: 'Unpin', icon: 'bookmark' as const, onSelect: () => void api.storagePin(repo.repo, a.id, false) }
                    : { label: 'Pin (never delete)', icon: 'bookmark' as const, onSelect: () => void api.storagePin(repo.repo, a.id, true) }]),
                ]} />
              </span>
            </div>
          ))}
          {rows.length > shown && <div className="gm-more"><Button variant="ghost" onClick={() => setShown(s => s + PAGE * 2)}>Show {Math.min(PAGE * 2, rows.length - shown)} more of {rows.length - shown}</Button></div>}
          {rows.length === 0 && <p className="gm-section-empty muted">{repo.artifacts.length ? 'No artifacts match.' : repo.error ? '' : 'This repository has no artifacts.'}</p>}
        </div>
      </div>
      <section className="gm-section gm-caches" aria-label="Actions caches">
        <h3 className="gm-section-h">Actions caches (separate allowance, read-only) <span className="faint num">{repo.cacheBytes === null ? 'not read' : `${formatBytes(repo.cacheBytes)} · ${plural(repo.cacheCount ?? 0, 'entry', 'entries')}`}</span></h3>
        {repo.caches.length > 0 && (
          <ul className="gm-notes">
            {repo.caches.slice(0, 5).map(c => <li key={c.key}><span className="gm-mono-sm">{c.key}</span> <span className="faint">{formatBytes(c.sizeBytes)}{c.lastAccessedAt ? `, used ${dateText(c.lastAccessedAt)}` : ''}</span></li>)}
          </ul>
        )}
      </section>
    </div>
  )
}
