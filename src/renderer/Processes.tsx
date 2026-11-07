import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Button, CopyButton, Details, DrawerToggle, Icon, IconButton, InlineAlert, LogViewer, Menu, MenuButton, SearchInput, StatusIndicator, Tabs, useContextMenu, useCopy,
  type Anchor, type MenuEntry, type StatusState,
} from '../../third_party/summa-ui/src/ui'
import { useConfirm, useToast } from '../../third_party/summa-ui/src/presets'
import type { PortBinding, ProcError, ProcInfo, StopCode } from '../shared/procs'
import type { Profile, ServiceState } from '../shared/types'
import { api } from './api'
import type { Actions, Model } from './App'
import { contextLabel, EnvironmentPanel, parseServiceKey } from './EnvironmentView'
import { ago } from './util'

/* ---------------------------------------------------------------- pure helpers (unit tested) */

/** Distinct port numbers of a process, ascending. A port bound on both tcp and tcp6 counts once. */
export function distinctPorts(ports: PortBinding[]): number[] {
  return [...new Set(ports.map(p => p.port))].sort((a, b) => a - b)
}

/** The lowest port, plus how many more there are: "3000 +2". Empty when the process listens on nothing. */
export function portLabel(ports: PortBinding[]): string {
  const all = distinctPorts(ports)
  if (!all.length) return ''
  return all.length === 1 ? String(all[0]) : `${all[0]} +${all.length - 1}`
}

/** The default list: processes that listen on a port, plus the ones GitManager started. */
export function visibleProcs(list: ProcInfo[]): ProcInfo[] {
  return list.filter(p => p.ports.length > 0 || p.owner === 'gitmanager')
}

export type ProcSortKey = 'port' | 'name' | 'repo'

export function sortProcs(list: ProcInfo[], key: ProcSortKey, dir: 1 | -1, repoName: (id: string | undefined) => string): ProcInfo[] {
  const low = (p: ProcInfo) => distinctPorts(p.ports)[0] ?? Number.POSITIVE_INFINITY
  const byName = (a: ProcInfo, b: ProcInfo) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) || a.pid - b.pid
  const byPort = (a: ProcInfo, b: ProcInfo) => { const x = low(a), y = low(b); return x === y ? 0 : x < y ? -1 : 1 }
  const cmp = (a: ProcInfo, b: ProcInfo): number => {
    if (key === 'name') return byName(a, b) * dir
    if (key === 'repo') {
      const x = repoName(a.repoId), y = repoName(b.repoId)
      if (!x !== !y) return x ? -1 : 1 // processes without a repository go last in both directions
      return (x.localeCompare(y, undefined, { sensitivity: 'base' }) * dir) || byPort(a, b) || byName(a, b)
    }
    const x = low(a), y = low(b)
    if (x === y) return byName(a, b)
    if (x === Number.POSITIVE_INFINITY) return 1 // no port goes last in both directions
    if (y === Number.POSITIVE_INFINITY) return -1
    return (x < y ? -1 : 1) * dir
  }
  return [...list].sort(cmp)
}

/** Search over name, PID, ports, command, repository name and owner. */
export function filterProcs(list: ProcInfo[], q: string, repoName: (id: string | undefined) => string): ProcInfo[] {
  const needle = q.trim().toLowerCase()
  if (!needle) return list
  return list.filter(p => {
    const hay = [p.name, String(p.pid), ...distinctPorts(p.ports).map(String), p.command ?? '', repoName(p.repoId), p.owner === 'gitmanager' ? 'gitmanager' : 'external', p.user ?? '']
    return hay.some(h => h.toLowerCase().includes(needle))
  })
}

export const stopTitle = (p: Pick<ProcInfo, 'name' | 'pid'>) => `Stop ${p.name} (PID ${p.pid})?`

export function portsText(p: Pick<ProcInfo, 'ports'>): string {
  const all = distinctPorts(p.ports)
  return all.length === 0 ? '' : all.length === 1 ? `Port ${all[0]}` : `Ports ${all.join(', ')}`
}

/** One short next step for a refused stop. Never suggests elevation. */
export function stopNextStep(code: StopCode): string {
  switch (code) {
    case 'PERMISSION': return 'Stop it from the account that owns it.'
    case 'DENIED': return 'Close it from its own window.'
    case 'CHANGED': return 'It changed. Refresh and try again.'
    case 'STILL_RUNNING': return 'Check its logs, then try again.'
    case 'FAILED': return 'Try again, or close it from its own window.'
    default: return ''
  }
}

/** Finds the profile and service behind a managed process's service key. Both must exist to offer Restart. */
export function resolveService(serviceKey: string | undefined, profiles: Pick<Profile, 'id' | 'services'>[]): { profileId: string; serviceId: string } | null {
  const k = parseServiceKey(serviceKey)
  if (!k) return null
  const profile = profiles.find(p => p.id === k.profileId)
  return profile?.services.some(s => s.id === k.serviceId) ? k : null
}

const STATE_MARK: Record<ServiceState, StatusState> = { stopped: 'stopped', starting: 'running', running: 'running', ready: 'ready', stopping: 'warn', failed: 'failed' }
const STATE_WORD: Record<ServiceState, string> = { stopped: 'Stopped', starting: 'Starting', running: 'Running', ready: 'Ready', stopping: 'Stopping', failed: 'Failed' }

type StopFail = { key: string; name: string; message: string; code?: StopCode }
type Row = { p: ProcInfo; gone?: boolean }

const ownerWord = (p: ProcInfo) => (p.owner === 'gitmanager' ? 'GitManager' : 'External')
const STOP_PERMISSION = 'Could not stop it'

/* ---------------------------------------------------------------- view */

/**
 * Processes that listen on a port, and the ones GitManager started. Ports come from discovered sockets only.
 * `focus` selects the process on a port (from a "Port 8080 occupied" alert) or a given process key.
 */
export function ProcessesView({ model, actions, focus }: { model: Model; actions: Actions; focus?: { port?: number; key?: string } }) {
  const confirm = useConfirm()
  const toast = useToast()
  const [procs, setProcs] = useState<ProcInfo[]>([])
  const [errors, setErrors] = useState<ProcError[]>([])
  const [scanError, setScanError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<{ key: ProcSortKey; dir: 1 | -1 }>({ key: 'port', dir: 1 })
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const [stopFail, setStopFail] = useState<StopFail | null>(null)
  const [focusMiss, setFocusMiss] = useState<string | null>(null)
  const lastSel = useRef<ProcInfo | null>(null)
  const inflight = useRef(false)
  const alive = useRef(true)
  const focusDone = useRef<string | null>(null)
  const { copy } = useCopy()

  useEffect(() => { document.title = 'Processes · GitManager' }, [])
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const repoName = useCallback((id: string | undefined) => (id ? model.data.repos.find(r => r.id === id)?.name ?? '' : ''), [model.data.repos])

  const scan = useCallback(async (force = false) => {
    if (inflight.current) return
    inflight.current = true
    setRefreshing(true)
    try {
      const r = await api.procsScan(force)
      if (!alive.current) return
      if (r.ok) { setProcs(r.value.processes); setErrors(r.value.errors); setScanError(null) } else setScanError(r.error.message)
    } catch (e) {
      if (alive.current) setScanError(e instanceof Error ? e.message : 'Scan failed')
    } finally {
      inflight.current = false
      if (alive.current) { setLoaded(true); setRefreshing(false) }
    }
  }, [])

  // On mount, on window focus, and every 5 s while this view is mounted and the window is visible. Nothing runs after unmount.
  useEffect(() => {
    void scan()
    let last = Date.now()
    const onFocus = () => { if (Date.now() - last > 1500) { last = Date.now(); void scan() } }
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') { last = Date.now(); void scan() } }, 5000)
    window.addEventListener('focus', onFocus)
    return () => { window.clearInterval(timer); window.removeEventListener('focus', onFocus) }
  }, [scan])

  // Select what the alert pointed at, once per focus value, after the first snapshot.
  useEffect(() => {
    if (!loaded || !focus) return
    const id = `${focus.key ?? ''}|${focus.port ?? ''}`
    if (focusDone.current === id) return
    focusDone.current = id
    const hit = focus.key ? procs.find(p => p.key === focus.key) : focus.port !== undefined ? procs.find(p => p.ports.some(b => b.port === focus.port)) : undefined
    if (hit) { setSelected(hit.key); setFocusMiss(null) }
    else if (focus.port !== undefined) setFocusMiss(`Nothing is listening on port ${focus.port} now`)
  }, [loaded, focus, procs])

  const shown = useMemo(() => sortProcs(filterProcs(visibleProcs(procs), q, repoName), sort.key, sort.dir, repoName), [procs, q, sort, repoName])
  const found = selected ? procs.find(p => p.key === selected) : undefined
  if (found) lastSel.current = found
  const sel: Row | null = selected ? (found ? { p: found } : lastSel.current?.key === selected ? { p: lastSel.current, gone: true } : null) : null

  const stateOf = (p: ProcInfo): { word: string; mark: StatusState } | null => {
    if (busy.has(p.key)) return { word: 'Stopping', mark: 'warn' }
    const st = p.serviceKey ? model.services[p.serviceKey]?.state : undefined
    return st ? { word: STATE_WORD[st], mark: STATE_MARK[st] } : null
  }

  const stop = useCallback(async (p: ProcInfo) => {
    const external = p.owner !== 'gitmanager'
    if (external) {
      const ok = await confirm({
        title: stopTitle(p), confirmLabel: 'Stop process', destructive: true, description: portsText(p) || undefined,
        target: p.command ?? p.name, consequences: ['GitManager did not start it.', 'Unsaved work in it is lost.'],
      })
      if (!ok) return
    }
    setBusy(b => new Set(b).add(p.key))
    setStopFail(null)
    try {
      const r = await api.procsStop(p.key, external ? true : undefined)
      if (!r.ok) setStopFail({ key: p.key, name: p.name, message: r.error.message })
      else if (!r.value.ok) setStopFail({ key: p.key, name: p.name, message: r.value.message || STOP_PERMISSION, code: r.value.code })
      else toast.success('Stopped')
    } catch (e) {
      setStopFail({ key: p.key, name: p.name, message: e instanceof Error ? e.message : STOP_PERMISSION })
    } finally {
      if (alive.current) { setBusy(b => { const n = new Set(b); n.delete(p.key); return n }); void scan(true) }
    }
  }, [confirm, toast, scan])

  const restart = useCallback(async (p: ProcInfo) => {
    const s = resolveService(p.serviceKey, model.data.profiles)
    if (!s) return
    setBusy(b => new Set(b).add(p.key))
    try {
      const r = await api.restartService(s.profileId, s.serviceId)
      if (r.ok) toast.success('Restarted'); else toast.error(r.error.message)
    } finally {
      if (alive.current) { setBusy(b => { const n = new Set(b); n.delete(p.key); return n }); void scan(true) }
    }
  }, [model.data.profiles, toast, scan])

  const copyText = useCallback(async (text: string) => { if (await copy(text)) toast.success('Copied') }, [copy, toast])

  const menuFor = (p: ProcInfo): MenuEntry[] => [
    { label: 'Inspect', icon: 'info', onSelect: () => setSelected(p.key) },
    { label: 'Open terminal', icon: 'terminal', disabled: !p.repoId, onSelect: () => { if (p.repoId) actions.openTerminal({ type: 'repo', repoId: p.repoId }) } },
    { label: 'Open repository', icon: 'folder-open', disabled: !p.repoId, onSelect: () => { if (p.repoId) actions.openRepo(p.repoId) } },
    { label: 'Copy PID', icon: 'copy', onSelect: () => void copyText(String(p.pid)) },
    { label: 'Copy command', icon: 'copy', disabled: !p.command, onSelect: () => { if (p.command) void copyText(p.command) } },
    { type: 'sep' },
    { label: 'Stop', icon: 'stop', danger: true, disabled: !p.canStop || busy.has(p.key), onSelect: () => void stop(p) },
  ]

  const head = (key: ProcSortKey, label: string) => {
    const on = sort.key === key
    return (
      <span role="columnheader" aria-sort={on ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
        <button type="button" className={`gm-th ${on ? 'on' : ''}`} onClick={() => setSort(s => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : 1 }))}>
          {label}<Icon name={on && sort.dir === 1 ? 'arrow-up' : 'arrow-down'} size={12} />
        </button>
      </span>
    )
  }
  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('.gm-prow'))
    const i = items.indexOf(document.activeElement as HTMLElement)
    const n = items[Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]
    if (n) { e.preventDefault(); n.focus() }
  }

  const listFail = stopFail && stopFail.key !== selected ? stopFail : null
  const empty = loaded && visibleProcs(procs).length === 0

  return (
    <div className="gm-work">
      <header className="gm-top">
        <DrawerToggle />
        <h1 className="gm-h1">Processes</h1>
        <span className="grow" />
        <IconButton icon="refresh" label="Refresh" onClick={() => void scan(true)} aria-busy={refreshing || undefined} className={refreshing ? 'gm-spin' : ''} />
      </header>
      <div className="gm-branches">
        <div className="gm-branch-pane">
          <div className="gm-toolbar">
            <SearchInput className="gm-branch-search" placeholder="Search" aria-label="Search processes" value={q} onChange={e => setQ(e.target.value)} />
          </div>
          {scanError && <div className="gm-palert"><InlineAlert tone="error" action={{ label: 'Retry', onClick: () => void scan(true) }}>Scan failed</InlineAlert><Details label="Details"><p className="gm-mono gm-pwrap">{scanError}</p></Details></div>}
          {errors.length > 0 && (
            <div className="gm-palert">
              <InlineAlert tone="warn">{errors.length === 1 ? `${contextLabel(errors[0].context, model.platform.os)} failed` : `${errors.length} environments failed`}</InlineAlert>
              <Details label="Details">
                <ul className="gm-envperr">{errors.map((e, i) => <li key={i}><span className="faint">{contextLabel(e.context, model.platform.os)}</span> {e.message}</li>)}</ul>
              </Details>
            </div>
          )}
          {focusMiss && <div className="gm-palert"><InlineAlert tone="info" action={{ label: 'Dismiss', onClick: () => setFocusMiss(null) }}>{focusMiss}</InlineAlert></div>}
          {listFail && <div className="gm-palert"><StopAlert fail={listFail} onDismiss={() => setStopFail(null)} /></div>}

          {!loaded ? (
            <div className="gm-loading-line" aria-busy="true"><span className="sm-spinner" aria-hidden="true" /> Loading</div>
          ) : empty && !scanError ? (
            <div className="sm-empty"><p className="sm-empty__text">No listening processes</p><Button onClick={() => void scan(true)}>Refresh</Button></div>
          ) : (
            <div className="gm-btable gm-ptable" role="table" aria-label="Processes" aria-rowcount={shown.length}>
              <div className="gm-bhead" role="row">
                {head('port', 'Port')}
                {head('name', 'Process')}
                {head('repo', 'Repository')}
                <span role="columnheader">Owner</span>
                <span role="columnheader"><span className="sr-only">Action</span></span>
                <span role="columnheader"><span className="sr-only">More</span></span>
              </div>
              <div className="gm-bbody scroll" role="rowgroup" onKeyDown={onListKey}>
                {shown.map(p => (
                  <ProcRow key={p.key} p={p} selected={selected === p.key} repo={repoName(p.repoId)} state={stateOf(p)} busy={busy.has(p.key)} menu={menuFor(p)}
                    onOpen={() => setSelected(p.key)} onStop={() => void stop(p)} />
                ))}
                {shown.length === 0 && <p className="gm-section-empty muted">No processes match</p>}
              </div>
            </div>
          )}
        </div>
        {sel && (
          <ProcessDetail key={sel.p.key} row={sel} model={model} actions={actions} state={stateOf(sel.p)} busy={busy.has(sel.p.key)} repo={repoName(sel.p.repoId)}
            fail={stopFail?.key === sel.p.key ? stopFail : null} onDismissFail={() => setStopFail(null)}
            onClose={() => setSelected(null)} onStop={() => void stop(sel.p)} onRestart={() => void restart(sel.p)} onCopy={t => void copyText(t)} toast={toast} />
        )}
      </div>
    </div>
  )
}

function StopAlert({ fail, onDismiss }: { fail: StopFail; onDismiss: () => void }) {
  const next = fail.code ? stopNextStep(fail.code) : ''
  return <InlineAlert tone="error" action={{ label: 'Dismiss', onClick: onDismiss }}>{`${fail.name}: ${fail.message}${next ? ` ${next}` : ''}`}</InlineAlert>
}

function ProcRow({ p, selected, repo, state, busy, menu, onOpen, onStop }: {
  p: ProcInfo; selected: boolean; repo: string; state: { word: string; mark: StatusState } | null; busy: boolean; menu: MenuEntry[]; onOpen: () => void; onStop: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const cm = useContextMenu()
  const viaKeyboard = useRef(false)
  const { onContextMenu: _ignored, ...bind } = cm.bind
  void _ignored
  const managed = p.owner === 'gitmanager'
  const all = distinctPorts(p.ports)
  const openFromKeyboard = () => {
    const r = ref.current?.getBoundingClientRect(); if (!r) return
    viaKeyboard.current = true
    cm.openAt(r.left + 24, r.top + r.height / 2)
  }
  const closeMenu = () => { cm.close(); if (viaKeyboard.current) { viaKeyboard.current = false; ref.current?.focus() } }
  const stop = (e: React.SyntheticEvent) => e.stopPropagation()

  return (
    <div ref={ref} role="row" tabIndex={0} aria-selected={selected} className={`gm-brow gm-prow ${selected ? 'selected' : ''}`} {...bind}
      aria-label={`${p.name}, PID ${p.pid}${all.length ? `, ${portsText(p).toLowerCase()}` : ''}`}
      onClick={onOpen}
      onContextMenu={e => {
        e.preventDefault()
        if (e.clientX === 0 && e.clientY === 0) openFromKeyboard()
        else { viaKeyboard.current = false; cm.openAt(e.clientX, e.clientY) }
      }}
      onKeyDown={e => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); openFromKeyboard() }
        else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() }
      }}>
      <span role="cell" className="gm-mono num" title={all.length > 1 ? all.join(', ') : undefined}>{portLabel(p.ports)}</span>
      <span role="cell" className="gm-pname"><span className="truncate" title={p.command ?? p.name}>{p.name}</span><span className="faint num">PID {p.pid}</span></span>
      <span role="cell" className="truncate muted" title={repo || undefined}>{repo}</span>
      <span role="cell" className="gm-powner">
        <span>{ownerWord(p)}</span>
        {state && <span className="gm-pstate" data-state={state.mark}>{state.word}</span>}
      </span>
      <span role="cell" className="gm-pact" onClick={stop} onKeyDown={stop}>
        {managed
          ? <Button disabled={busy || !p.canStop} onClick={onStop}>Stop</Button>
          : <Button onClick={onOpen}>Inspect</Button>}
      </span>
      <span role="cell" className="gm-pmenu" onClick={stop} onKeyDown={stop}>
        <MenuButton label={`More actions for ${p.name}`} items={menu} size="sm" />
        <Menu anchor={cm.point as Anchor} open={cm.open} onClose={closeMenu} items={menu} label={`Actions for ${p.name}`} placement="bottom-start" />
      </span>
    </div>
  )
}

type DetailTab = 'details' | 'environment' | 'logs'

function ProcessDetail({ row, model, actions, state, busy, repo, fail, onDismissFail, onClose, onStop, onRestart, onCopy, toast }: {
  row: Row; model: Model; actions: Actions; state: { word: string; mark: StatusState } | null; busy: boolean; repo: string
  fail: StopFail | null; onDismissFail: () => void; onClose: () => void; onStop: () => void; onRestart: () => void; onCopy: (t: string) => void
  toast: { success: (m: string) => unknown }
}) {
  const { p, gone } = row
  const [tab, setTab] = useState<DetailTab>('details')
  const managed = p.owner === 'gitmanager'
  const logKey = managed ? p.serviceKey : undefined
  const canRestart = managed && !gone && !!resolveService(p.serviceKey, model.data.profiles)
  const tabs: { value: DetailTab; label: string }[] = [{ value: 'details', label: 'Details' }, { value: 'environment', label: 'Environment' }, ...(logKey ? [{ value: 'logs' as const, label: 'Logs' }] : [])]
  const mark: { word: string; mark: StatusState } = gone ? { word: 'Ended', mark: 'stopped' } : state ?? { word: 'Running', mark: 'neutral' }
  const ports = [...p.ports].sort((a, b) => a.port - b.port || a.protocol.localeCompare(b.protocol))

  useEffect(() => { if (tab === 'logs' && logKey) void actions.loadLogs(logKey) }, [tab, logKey, actions])
  const logLines = useMemo(() => (logKey ? model.logs(logKey).map(l => ({ text: l.text, level: l.stream === 'err' ? ('error' as const) : undefined })) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [logKey, model.logVersion])

  return (
    <aside className="gm-bdetail gm-pdetail" aria-label={`Process ${p.name}`} onKeyDown={e => { if (e.key === 'Escape' && !e.defaultPrevented && !(e.target as HTMLElement).closest('input,[role=menu]')) onClose() }}>
      <div className="gm-bdetail-head">
        <h2 className="gm-h1 truncate" title={p.name}>{p.name}</h2>
        <span className="faint num">PID {p.pid}</span>
        <StatusIndicator state={mark.mark} label={mark.word} />
        <span className="grow" />
        <IconButton icon="x" size="sm" label="Close details" onClick={onClose} />
      </div>
      <div className="gm-pdtabs"><Tabs label="Process sections" flat value={tab} onChange={setTab} items={tabs} /></div>
      <div className="gm-bdetail-body scroll">
        {tab === 'details' && (
          <>
            <div className="gm-bdetail-actions gm-pactions">
              <Button disabled={gone || busy || !p.canStop} onClick={onStop}>Stop</Button>
              {canRestart && <Button disabled={busy} onClick={onRestart}>Restart</Button>}
              <Button icon="terminal" disabled={!p.repoId} onClick={() => { if (p.repoId) actions.openTerminal({ type: 'repo', repoId: p.repoId }) }}>Terminal</Button>
              <MenuButton label="More actions" items={[
                { label: 'Copy PID', icon: 'copy', onSelect: () => onCopy(String(p.pid)) },
                { label: 'Copy command', icon: 'copy', disabled: !p.command, onSelect: () => { if (p.command) onCopy(p.command) } },
                { label: 'Open repository', icon: 'folder-open', disabled: !p.repoId, onSelect: () => { if (p.repoId) actions.openRepo(p.repoId) } },
              ]} />
            </div>
            {fail && <div className="gm-palert"><StopAlert fail={fail} onDismiss={onDismissFail} /></div>}
            {!fail && !p.canStop && !gone && p.stopDeniedReason && <div className="gm-palert"><InlineAlert tone="info">{p.stopDeniedReason}</InlineAlert></div>}
            <dl className="gm-props">
              <dt>Owner</dt><dd>{managed ? 'Started by GitManager' : 'Not started by GitManager'}</dd>
              {ports.length > 0 && <><dt>{ports.length === 1 ? 'Port' : 'Ports'}</dt>
                <dd><ul className="gm-plist">{ports.map(b => <li key={`${b.port}-${b.protocol}-${b.address}`}><span className="gm-mono num">{b.port}</span> <span className="faint">{b.protocol}, {b.address}</span></li>)}</ul></dd></>}
              {p.repoId && <><dt>Repository</dt><dd><button type="button" className="gm-plink" onClick={() => actions.openRepo(p.repoId!)}>{repo || 'Open repository'}</button></dd></>}
              {p.user && <><dt>User</dt><dd>{p.user}</dd></>}
              {p.startedAt && <><dt>Started</dt><dd title={p.startedAt}>{ago(p.startedAt)}</dd></>}
              <dt>Environment</dt><dd>{contextLabel(p.context, model.platform.os)}</dd>
              {p.cwd && <><dt>Folder</dt><dd className="gm-pvalue"><span className="gm-mono gm-pwrap">{p.cwd}</span><CopyButton value={p.cwd} label="Copy folder" onCopied={ok => ok && toast.success('Copied')} /></dd></>}
              <dt>Command</dt>
              <dd className="gm-pvalue">
                {p.command === null ? <span className="muted">Not available</span> : p.command.length > 140
                  ? <Details label="Show command"><span className="gm-mono gm-pwrap">{p.command}</span></Details>
                  : <span className="gm-mono gm-pwrap">{p.command}</span>}
                {p.command !== null && <CopyButton value={p.command} label="Copy command" onCopied={ok => ok && toast.success('Copied')} />}
              </dd>
              {p.exe && <><dt>Executable</dt><dd className="gm-pvalue"><span className="gm-mono gm-pwrap">{p.exe}</span><CopyButton value={p.exe} label="Copy executable path" onCopied={ok => ok && toast.success('Copied')} /></dd></>}
            </dl>
          </>
        )}
        {tab === 'environment' && (gone
          ? <p className="gm-envempty muted">Ended</p>
          : <EnvironmentPanel source={{ kind: 'process', key: p.key }} toast={toast} />)}
        {tab === 'logs' && logKey && <div className="gm-plogs"><LogViewer lines={logLines} label="Logs" searchable height={360} /></div>}
      </div>
    </aside>
  )
}
