import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppShell, useHotkey } from '../../third_party/summa-ui/src/ui'
import type { AppState, Distros } from '../shared/api'
import type { DiscoveryStatus, LogLine, OpError, Platform, Profile, RemoteCheck, Repo, RepoStatus, Result, ServiceStatus } from '../shared/types'
import { api } from './api'
import { AddRepoDialog, FindReposDialog } from './dialogs'
import { ProfileEditor } from './ProfileEditor'
import { SettingsView } from './Settings'
import { Sidebar } from './Sidebar'
import { StorageView } from './Storage'
import { ToolsView, type ToolId } from './tools/Tools'
import { Workspace, WelcomeEmpty } from './Workspace'
import { isTyping } from './util'

export type RepoView = { status?: RepoStatus; error?: OpError; loading: boolean }
export type View = { kind: 'repo' } | { kind: 'settings' } | { kind: 'storage' } | { kind: 'tools'; tool: ToolId | null } | { kind: 'profile'; profile: Profile; isNew: boolean }

/** Everything the screens need, loaded from the main process and kept current by its events. */
export type Model = {
  platform: Platform
  data: AppState
  distros: Distros
  statuses: Record<string, RepoView>
  remotes: Record<string, RemoteCheck | null>
  fetchedAt: Record<string, number>
  services: Record<string, ServiceStatus>
  logs: (key: string) => LogLine[]
  logVersion: number
  discovery: DiscoveryStatus | null
}

export type Actions = {
  reload: () => Promise<void>
  refresh: (repoId: string, opts?: { remote?: boolean }) => Promise<void>
  select: (repoId: string) => void
  setView: (v: View) => void
  markFetched: (repoId: string) => void
  loadLogs: (key: string) => Promise<void>
  addRepoDialog: () => void
  findReposDialog: () => void
  rescan: (scope: 'common' | 'deep') => void
}

export function App() {
  const [platform, setPlatform] = useState<Platform | null>(null)
  const [data, setData] = useState<AppState | null>(null)
  const [distros, setDistros] = useState<Distros>({ available: false, distros: [] })
  const [statuses, setStatuses] = useState<Record<string, RepoView>>({})
  const [remotes, setRemotes] = useState<Record<string, RemoteCheck | null>>({})
  const [fetchedAt, setFetchedAt] = useState<Record<string, number>>({})
  const [services, setServices] = useState<Record<string, ServiceStatus>>({})
  const [view, setView] = useState<View>({ kind: 'repo' })
  const [dialog, setDialog] = useState<'add' | 'find' | null>(null)
  const [discovery, setDiscovery] = useState<DiscoveryStatus | null>(null)
  const logStore = useRef(new Map<string, LogLine[]>())
  const [logVersion, setLogVersion] = useState(0)

  const reload = useCallback(async () => {
    const s = await api.state()
    setData(s)
    setServices(Object.fromEntries(s.services.map(x => [x.key, x])))
  }, [])

  const refresh = useCallback(async (repoId: string, opts: { remote?: boolean } = {}) => {
    setStatuses(m => ({ ...m, [repoId]: { ...m[repoId], loading: true } }))
    const r: Result<RepoStatus> = await api.status(repoId)
    setStatuses(m => ({ ...m, [repoId]: r.ok ? { status: r.value, loading: false } : { error: r.error, loading: false } }))
    if (opts.remote && r.ok) {
      const c = await api.checkRemote(repoId)
      setRemotes(m => ({ ...m, [repoId]: c.ok ? c.value : { remote: '', reachable: false, error: c.error.message, checkedAt: new Date().toISOString() } }))
    }
  }, [])

  // Initial load, then status for every repository (four at a time, so WSL is not flooded with processes).
  useEffect(() => {
    void (async () => {
      const [p, s] = await Promise.all([api.platform(), api.state()])
      setPlatform(p); setData(s); setDiscovery(s.discovery)
      setServices(Object.fromEntries(s.services.map(x => [x.key, x])))
      if (p.os === 'windows') void api.wslDistros().then(setDistros)
      const ids = s.repos.map(r => r.id)
      const sel = s.ui.selectedRepoId
      if (sel) void refresh(sel, { remote: true })
      const rest = ids.filter(i => i !== sel)
      for (let i = 0; i < rest.length; i += 4) await Promise.all(rest.slice(i, i + 4).map(id => refresh(id)))
    })()
  }, [refresh])

  useEffect(() => {
    const offStatus = api.on('service-status', s => setServices(m => ({ ...m, [s.key]: s })))
    const offLogs = api.on('service-logs', b => {
      const cur = logStore.current.get(b.key)
      if (cur) { cur.push(...b.lines); if (cur.length > 5000) cur.splice(0, cur.length - 5000) }
      setLogVersion(v => v + 1)
    })
    const offClear = api.on('logs-cleared', k => { logStore.current.set(k, []); setLogVersion(v => v + 1) })
    return () => { offStatus(); offLogs(); offClear() }
  }, [])

  // Discovery runs in the main process; repositories appear in the list as they are registered.
  useEffect(() => {
    let timer = 0
    const offStatus = api.on('discovery-status', setDiscovery)
    const offAdded = api.on('repo-added', repo => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => { void reload() }, 250)
      void refresh(repo.id)
    })
    return () => { offStatus(); offAdded(); window.clearTimeout(timer) }
  }, [reload, refresh])

  const selectedId = data?.ui.selectedRepoId ?? null

  // Coming back to the window refreshes the selected repository (the user may have used a terminal meanwhile).
  useEffect(() => {
    let last = 0
    const onFocus = () => { if (selectedId && Date.now() - last > 3000) { last = Date.now(); void refresh(selectedId) } }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [selectedId, refresh])

  const select = useCallback((repoId: string) => {
    setData(d => (d ? { ...d, ui: { ...d.ui, selectedRepoId: repoId } } : d))
    setView({ kind: 'repo' })
    void api.selectRepo(repoId)
    void refresh(repoId, { remote: true })
  }, [refresh])

  const loadLogs = useCallback(async (key: string) => {
    if (logStore.current.has(key)) return
    logStore.current.set(key, [])
    const lines = await api.logs(key)
    const cur = logStore.current.get(key) ?? []
    const seen = new Set(cur.map(l => l.seq))
    logStore.current.set(key, [...lines.filter(l => !seen.has(l.seq)), ...cur].sort((a, b) => a.seq - b.seq))
    setLogVersion(v => v + 1)
  }, [])

  useHotkey('mod+r', e => { e.preventDefault(); if (selectedId) void refresh(selectedId, { remote: true }) }, [selectedId])
  useHotkey('f5', e => { e.preventDefault(); if (selectedId) void refresh(selectedId, { remote: true }) }, [selectedId])
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === '/' && !isTyping(e.target) && !document.querySelector('[role=dialog],[role=alertdialog],.popover')) {
        e.preventDefault(); document.querySelector<HTMLInputElement>('.gm-repo-search input')?.focus()
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  const repo: Repo | undefined = data?.repos.find(r => r.id === selectedId)
  useEffect(() => { if (view.kind === 'repo' || view.kind === 'profile') document.title = repo ? `${repo.name} · GitManager` : 'GitManager' }, [repo, view.kind])

  const model: Model | null = useMemo(() => platform && data ? ({
    platform, data, distros, statuses, remotes, fetchedAt, services, logVersion, discovery, logs: (k: string) => logStore.current.get(k) ?? [],
  }) : null, [platform, data, distros, statuses, remotes, fetchedAt, services, logVersion, discovery])

  const actions: Actions = useMemo(() => ({
    reload, refresh, select, setView, loadLogs,
    markFetched: (id: string) => setFetchedAt(m => ({ ...m, [id]: Date.now() })),
    addRepoDialog: () => setDialog('add'),
    findReposDialog: () => setDialog('find'),
    rescan: (scope: 'common' | 'deep') => { void api.rescan(scope).then(r => { if (r.ok) setDiscovery(r.value) }) },
  }), [reload, refresh, select, loadLogs])

  if (!model) return <AppShell sidebar={<Sidebar.Skeleton />}><div /></AppShell>

  const onAdded = async (repoIds: string[]) => {
    setDialog(null)
    await reload()
    for (const id of repoIds) void refresh(id)
    if (repoIds[0]) select(repoIds[0])
  }

  return (
    <AppShell sidebar={<Sidebar model={model} actions={actions} view={view} />}>
      {view.kind === 'settings' ? <SettingsView model={model} actions={actions} />
        : view.kind === 'storage' ? <StorageView />
        : view.kind === 'tools' ? <ToolsView tool={view.tool} model={model} actions={actions} />
        : view.kind === 'profile' && repo ? <ProfileEditor key={view.profile.id} model={model} actions={actions} repo={repo} initial={view.profile} isNew={view.isNew} />
          : repo ? <Workspace key={repo.id} model={model} actions={actions} repo={repo} />
            : <WelcomeEmpty hasRepos={model.data.repos.length > 0} searching={!!model.discovery?.running} onAdd={actions.addRepoDialog} />}
      <AddRepoDialog open={dialog === 'add'} model={model} onClose={() => setDialog(null)} onAdded={id => void onAdded([id])} />
      <FindReposDialog open={dialog === 'find'} model={model} onClose={() => setDialog(null)} onAdded={ids => void onAdded(ids)} onRootsChanged={reload} />
    </AppShell>
  )
}
