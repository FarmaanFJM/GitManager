import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button, Dialog, Dropdown, Icon, IconButton } from '../../third_party/summa-ui/src/ui'
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
  const [guard, setGuard] = useState(false)
  const [preview, setPreview] = useState<LaunchPreview[] | null>(null)

  const statuses = profile ? profile.services.map(s => model.services[keyOf(profile, s)]) : []
  const anyAlive = statuses.some(s => s && s.pid !== null)
  const activeKey = profile && (logKey && profile.services.some(s => keyOf(profile, s) === logKey) ? logKey : profile.services[0] ? keyOf(profile, profile.services[0]) : null)

  useEffect(() => { if (activeKey) void actions.loadLogs(activeKey) }, [activeKey, actions])

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
        <h2 className="gm-section-h gm-svc-title">Development services</h2>
        <Dropdown label="Profile" quiet width={280} value={profile.id} searchable options={profiles.map(p => ({ value: p.id, label: p.name }))}
          onCreate={name => { void newProfile(name); return undefined }} createNoun="profile"
          onChange={id => { void api.selectProfile(repo.id, id).then(actions.reload) }} />
        <IconButton icon="pencil" size="sm" label="Edit profile" onClick={() => actions.setView({ kind: 'profile', profile, isNew: false })} disabled={anyAlive}
          title={anyAlive ? 'Stop the services to edit this profile' : 'Edit profile'} />
        <span className="grow" />
        {profile.openUrl && (
          <Button variant="ghost" onClick={() => void openBrowser()} title={profile.openUrl}>
            <Icon name="external" size={15} />Open in browser
          </Button>
        )}
        {anyAlive
          ? <Button variant="secondary" icon="stop" onClick={() => void stop()} disabled={guard}>Stop</Button>
          : <Button variant="primary" icon="play" onClick={() => void run()} disabled={guard || !profile.services.length}>Run</Button>}
      </div>

      <ul className="gm-svc-list" aria-label="Services">
        {profile.services.map((s, i) => {
          const st = statuses[i]
          const key = keyOf(profile, s)
          const alive = !!st && st.pid !== null
          const state = st?.state ?? 'stopped'
          return (
            <li key={s.id} className={`gm-svc ${activeKey === key ? 'selected' : ''}`} aria-selected={activeKey === key} onClick={() => setLogKey(key)}>
              <StateMark status={st} />
              <button type="button" className="gm-svc-name truncate" onClick={e => { e.stopPropagation(); setLogKey(key) }} aria-label={`${s.name}, ${STATE_LABEL[state]}. Show output`}>{s.name}</button>
              <span className="gm-svc-cmd truncate" title={s.command}>{s.command}</span>
              <span className="gm-svc-target truncate">{readinessText(s)}</span>
              <span className={`gm-svc-state gm-state-${state}`}>{STATE_LABEL[state]}</span>
              <span className="gm-svc-actions" onClick={e => e.stopPropagation()}>
                {alive && <IconButton icon="refresh" size="sm" label={`Restart ${s.name}`} onClick={() => void restart(s.id)} disabled={state === 'stopping'} />}
                {alive
                  ? <IconButton icon="stop" size="sm" label={`Stop ${s.name}`} onClick={() => void stop(s.id)} disabled={state === 'stopping'} />
                  : <IconButton icon="play" size="sm" label={`Start ${s.name}`} onClick={() => void run(s.id)} />}
              </span>
              {st?.message && state === 'failed' && <p className="gm-svc-msg">{st.message}</p>}
            </li>
          )
        })}
      </ul>

      {activeKey && <LogView model={model} logKey={activeKey} title={profile.services.find(s => keyOf(profile, s) === activeKey)?.name ?? ''} toast={toast} />}

      <Dialog open={!!preview} onClose={() => setPreview(null)} width={620} title={`Run ${profile.name}?`}
        description="These commands will run on this computer. GitManager asks again whenever they change."
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

/** Output of one service. Follows the end while the user is at the bottom; scrolling up stops following. */
function LogView({ model, logKey, title, toast }: { model: Model; logKey: string; title: string; toast: ToastApi }) {
  const ref = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const lines = model.logs(logKey)
  useLayoutEffect(() => { const el = ref.current; if (el && follow.current) el.scrollTop = el.scrollHeight }, [model.logVersion, logKey])
  useEffect(() => { follow.current = true }, [logKey])
  const copy = async () => {
    try { await navigator.clipboard.writeText(lines.map(l => l.text).join('\n')); toast.success('Output copied') } catch { toast.error('Could not copy the output') }
  }
  return (
    <section className="gm-log" aria-label={`Output of ${title}`}>
      <div className="gm-log-head">
        <h2 className="gm-section-h">Output <span className="muted">{title}</span></h2>
        <span className="grow" />
        <IconButton icon="copy" size="sm" label="Copy output" onClick={() => void copy()} disabled={!lines.length} />
        <IconButton icon="trash" size="sm" label="Clear output" onClick={() => void api.clearLogs(logKey)} disabled={!lines.length} />
      </div>
      <div ref={ref} className="gm-log-body scroll" tabIndex={0} role="log" aria-live="off"
        onScroll={e => { const el = e.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24 }}>
        {lines.length === 0 ? <p className="gm-log-empty faint">No output yet.</p>
          : lines.map(l => <div key={l.seq} className={`gm-log-line ${l.stream === 'sys' ? 'sys' : ''}`}>{l.text || ' '}</div>)}
      </div>
    </section>
  )
}
