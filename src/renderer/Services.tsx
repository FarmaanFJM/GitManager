import { useEffect, useState } from 'react'
import { Button, Details, Dialog, Dropdown, Icon, IconButton, InlineAlert, LogViewer, MenuButton, Tooltip } from '../../third_party/summa-ui/src/ui'
import { EnvironmentPanel } from './EnvironmentView'
import { copyText } from './tools/common'
import type { ToastApi } from '../../third_party/summa-ui/src/presets'
import type { LaunchPreview } from '../shared/api'
import type { OpError, Profile, Repo, ServiceDef, ServiceStatus } from '../shared/types'
import { api } from './api'
import type { Actions, Model } from './App'
import { STATE_LABEL } from './util'

const keyOf = (p: Profile, s: ServiceDef) => `${p.id}:${s.id}`

function StateMark({ status }: { status?: ServiceStatus }) {
  const state = status?.state ?? 'stopped'
  if (state === 'starting' || state === 'stopping') return <span className="sm-spinner gm-state-spin" aria-hidden="true" />
  return <span className={`gm-dot gm-dot-${state}`} aria-hidden="true" />
}

function readinessText(s: ServiceDef) {
  if (s.readiness.type === 'http') return s.readiness.url.replace(/^https?:\/\//, '').replace(/\/$/, '')
  if (s.readiness.type === 'port') return `${s.readiness.host || 'localhost'}:${s.readiness.port}`
  return ''
}

/**
 * The development launcher for the selected repository: choose a profile, Run or Stop it, follow each service's state
 * and output. Run turns into Stop while anything runs (P10), with a short guard against double clicks.
 */
export function ServicesPanel({ model, actions, repo, onError, toast }: { model: Model; actions: Actions; repo: Repo; onError: (e: OpError | null) => void; toast: ToastApi }) {
  const profiles = model.data.profiles.filter(p => p.repoId === repo.id)
  const selectedId = model.data.ui.selectedProfile[repo.id]
  const profile = profiles.find(p => p.id === selectedId) ?? profiles[0]
  const [logKey, setLogKey] = useState<string | null>(null)
  const [panel, setPanel] = useState<'logs' | 'env' | null>(null)
  const [portAlert, setPortAlert] = useState<{ port: number; text: string } | null>(null)
  const [guard, setGuard] = useState(false)
  const [preview, setPreview] = useState<LaunchPreview[] | null>(null)

  const statuses = profile ? profile.services.map(s => model.services[keyOf(profile, s)]) : []
  const anyAlive = statuses.some(s => s && s.pid !== null)
  const activeKey = profile && (logKey && profile.services.some(s => keyOf(profile, s) === logKey) ? logKey : profile.services[0] ? keyOf(profile, profile.services[0]) : null)
  const failedKey = profile?.services.map(sv => keyOf(profile, sv)).find(k => model.services[k]?.state === 'failed') ?? null

  useEffect(() => { if (activeKey && panel === 'logs') void actions.loadLogs(activeKey) }, [activeKey, actions, panel])
  // A service that failed opens its own output: the reason is one click closer than looking for it.
  useEffect(() => { if (failedKey) { setLogKey(failedKey); setPanel(p => p ?? 'logs') } }, [failedKey])

  const holdGuard = () => { setGuard(true); window.setTimeout(() => setGuard(false), 700) }

  const run = async (serviceId?: string) => {
    if (!profile) return
    holdGuard()
    const r = await api.startServices(profile.id, serviceId)
    if (!r.ok && r.error.code === 'UNTRUSTED') {
      const p = await api.previewLaunch(profile.id)
      if (p.ok) setPreview(p.value); else onError(p.error)
      return
    }
    if (!r.ok && r.error.code === 'PORT_IN_USE') {
      const port = Number(/Port (\d+)/.exec(r.error.message)?.[1])
      setPortAlert({ port, text: r.error.message }); onError(null); return
    }
    setPortAlert(null)
    onError(r.ok ? null : r.error)
    if (r.ok && serviceId) setLogKey(`${profile.id}:${serviceId}`)
  }
  const trustAndRun = async () => {
    if (!profile) return
    setPreview(null)
    const t = await api.trustProfile(profile.id)
    if (!t.ok) { onError(t.error); return }
    await actions.reload()
    const r = await api.startServices(profile.id)
    onError(r.ok ? null : r.error)
  }
  const stop = async (serviceId?: string) => {
    if (!profile) return
    holdGuard()
    const r = await api.stopServices(profile.id, serviceId)
    onError(r.ok ? null : r.error)
  }
  const restart = async (serviceId: string) => {
    if (!profile) return
    const r = await api.restartService(profile.id, serviceId)
    onError(r.ok ? null : r.error)
    if (r.ok) { toast.success('Restarted'); actions.setRestartHint(repo.id, null) }
  }
  const urlOf = (sv: ServiceDef) => sv.url || ''
  const openUrl = async (sv: ServiceDef) => {
    // A service URL opens in the profile's browser through the same trusted path as the profile URL.
    const r = await api.openUrl(profile!.id, sv.id)
    if (!r.ok) onError(r.error)
  }
  const copyUrl = async (u: string) => { toast[(await copyText(u)) ? 'success' : 'error']((await copyText(u)) ? 'URL copied' : 'Could not copy') }
  const terminalFor = (sv: ServiceDef) => {
    const rel = [profile!.workingDir, sv.cwd].map(x => x.trim()).filter(Boolean)
    const absolute = rel.some(x => x.startsWith('/') || /^[A-Za-z]:[\\/]/.test(x) || x.startsWith('\\\\'))
    if (profile!.worktreePath) {
      actions.openTerminal({ type: 'path', location: { ...repo.location, path: profile!.worktreePath } })
    } else actions.openTerminal({ type: 'repo', repoId: repo.id, ...(rel.length && !absolute ? { subpath: rel.join('/') } : {}) })
  }
  const openBrowser = async () => {
    if (!profile) return
    const r = await api.openUrl(profile.id)
    if (!r.ok) onError(r.error)
    else if (r.value.via.includes('not found')) toast.info(`Opened in ${r.value.via}.`)
  }
  const newProfile = async (name?: string) => {
    const d = await api.draftProfile(repo.id)
    if (d.ok) actions.setView({ kind: 'profile', profile: { ...d.value, name: name || d.value.name }, isNew: true })
    else onError(d.error)
  }

  if (!profile) return (
    <div className="sm-empty gm-panel-empty">
      <h2 className="gm-section-h">Development services</h2>
      <p className="sm-empty__text">No development profile yet. Add the commands that start this project.</p>
      <Button variant="primary" icon="plus" onClick={() => void newProfile()}>Create profile</Button>
    </div>
  )

  return (
    <div className="gm-services">
      <div className="gm-toolbar">
        <Dropdown label="Profile" quiet width={280} value={profile.id} searchable options={profiles.map(p => ({ value: p.id, label: p.name }))}
          onCreate={name => { void newProfile(name); return undefined }} createNoun="profile"
          onChange={id => { void api.selectProfile(repo.id, id).then(actions.reload) }} />
        <IconButton icon="pencil" size="sm" label="Edit profile" onClick={() => actions.setView({ kind: 'profile', profile, isNew: false })} disabled={anyAlive} />
        <span className="grow" />
        {profile.openUrl && (
          <>
            <Button variant="ghost" icon="external" onClick={() => void openBrowser()}>Open URL</Button>
            <IconButton icon="copy" size="sm" label="Copy URL" onClick={() => void copyUrl(profile.openUrl)} />
          </>
        )}
        {anyAlive
          ? <Button variant="secondary" icon="stop" onClick={() => void stop()} disabled={guard}>Stop Profile</Button>
          : <Button variant="primary" icon="play" onClick={() => void run()} disabled={guard || !profile.services.length}>Start Profile</Button>}
      </div>

      {portAlert && (
        <div className="gm-hint-row">
          <InlineAlert tone="error" action={{ label: 'Inspect', onClick: () => actions.setView({ kind: 'processes', focus: { port: portAlert.port } }) }}>{portAlert.text}</InlineAlert>
        </div>
      )}

      <ul className="gm-svc-list" aria-label="Services">
        {profile.services.map((s, i) => {
          const st = statuses[i]
          const key = keyOf(profile, s)
          const alive = !!st && st.pid !== null
          const state = st?.state ?? 'stopped'
          const url = urlOf(s)
          return (
            <li key={s.id} className={`gm-svc ${activeKey === key && panel ? 'selected' : ''}`} onClick={() => setLogKey(key)}>
              <StateMark status={st} />
              <button type="button" className="gm-svc-name truncate" onClick={e => { e.stopPropagation(); setLogKey(key); setPanel(p => p ?? 'logs') }} aria-label={`${s.name}, ${STATE_LABEL[state]}`}>{s.name}</button>
              <span className="gm-svc-cmd" />
              <span className="gm-svc-target truncate">{readinessText(s)}</span>
              <span className={`gm-svc-state gm-state-${state}`}>{state === 'failed' ? `${s.name} failed` : STATE_LABEL[state]}</span>
              <span className="gm-svc-actions" onClick={e => e.stopPropagation()}>
                {url && <Tooltip content={url}><IconButton icon="external" size="sm" label={`Open ${s.name} URL`} onClick={() => void openUrl(s)} /></Tooltip>}
                {url && <IconButton icon="copy" size="sm" label={`Copy ${s.name} URL`} onClick={() => void copyUrl(url)} />}
                <IconButton icon="terminal" size="sm" label={`Terminal, ${s.name}`} onClick={() => terminalFor(s)} />
                {alive
                  ? <IconButton icon="stop" size="sm" label={`Stop ${s.name}`} onClick={() => void stop(s.id)} disabled={state === 'stopping'} />
                  : <IconButton icon="play" size="sm" label={`Start ${s.name}`} onClick={() => void run(s.id)} />}
                <MenuButton size="sm" label={`${s.name} actions`} items={[
                  { label: 'Restart', icon: 'refresh', disabled: !alive || state === 'stopping', onSelect: () => void restart(s.id) },
                  { label: 'Logs', icon: 'file-text', onSelect: () => { setLogKey(key); setPanel('logs') } },
                  { label: 'Environment', icon: 'list', onSelect: () => { setLogKey(key); setPanel('env') } },
                ]} />
              </span>
              {st?.message && state === 'failed' && <div className="gm-svc-msg"><Details label="Details"><p>{st.message}</p></Details></div>}
            </li>
          )
        })}
      </ul>

      {activeKey && panel && (
        <section className="gm-log" aria-label={panel === 'logs' ? 'Logs' : 'Environment'}>
          <div className="gm-log-head">
            <h2 className="gm-section-h">{panel === 'logs' ? 'Logs' : 'Environment'} <span className="muted">{profile.services.find(sv => keyOf(profile, sv) === activeKey)?.name ?? ''}</span></h2>
            <span className="grow" />
            {panel === 'logs' && <IconButton icon="trash" size="sm" label="Clear logs" onClick={() => void api.clearLogs(activeKey)} />}
            <IconButton icon="x" size="sm" label="Close" onClick={() => setPanel(null)} />
          </div>
          {panel === 'logs'
            ? <LogViewer label={`Logs of ${profile.services.find(sv => keyOf(profile, sv) === activeKey)?.name ?? ''}`} height="100%" lines={model.logs(activeKey).map(l => ({ text: l.text || ' ', level: l.stream === 'err' ? undefined : undefined }))} />
            : <EnvironmentPanel source={{ kind: 'service', profileId: profile.id, serviceId: activeKey.split(':')[1], repoId: repo.id }} />}
        </section>
      )}

      <Dialog open={!!preview} onClose={() => setPreview(null)} width={620} title={`Run ${profile.name}?`}
        description="These commands run on this computer."
        footer={<><Button variant="secondary" onClick={() => setPreview(null)}>Cancel</Button><Button variant="primary" data-autofocus onClick={() => void trustAndRun()}>Trust and run</Button></>}>
        <ul className="gm-trust-list">
          {preview?.map(p => (
            <li key={p.service}>
              <div className="gm-trust-head"><strong>{p.service}</strong><span className="muted">{p.runtime}</span></div>
              <code className="gm-code">{p.command}</code>
              <div className="gm-trust-dir faint truncate" title={p.dir}>in {p.dir}{p.envKeys.length ? `, with ${p.envKeys.join(', ')}` : ''}</div>
            </li>
          ))}
        </ul>
      </Dialog>
    </div>
  )
}
