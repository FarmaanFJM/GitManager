import { useId, useState, type ReactNode } from 'react'
import { Button, Dropdown, IconButton } from '../../third_party/summa-ui/src/ui'
import { useConfirm } from '../../third_party/summa-ui/src/presets'
import type { Browser, OpError, Profile, Readiness, Repo, Runtime, ServiceDef } from '../shared/types'
import { api } from './api'
import type { Actions, Model } from './App'
import { ErrorBanner } from './Workspace'

/** Label above the control, both on the same left edge (P11). */
export function Field({ label, children, wide, hint }: { label: string; children: (id: string) => ReactNode; wide?: boolean; hint?: string }) {
  const id = useId()
  return (
    <div className={`gm-field ${wide ? 'wide' : ''}`}>
      <label htmlFor={id} className="gm-label">{label}</label>
      {children(id)}
      {hint && <p className="gm-hint">{hint}</p>}
    </div>
  )
}

const envToText = (env: Record<string, string>) => Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n')
function textToEnv(text: string): { env: Record<string, string>; bad: string | null } {
  const env: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const i = line.indexOf('=')
    const k = (i < 0 ? line : line.slice(0, i)).trim()
    if (i < 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) return { env, bad: line }
    env[k] = line.slice(i + 1)
  }
  return { env, bad: null }
}

const runtimeValue = (r: Runtime) => (r.kind === 'wsl' ? `wsl:${r.distro}` : 'native')
const valueRuntime = (v: string): Runtime => (v.startsWith('wsl:') ? { kind: 'wsl', distro: v.slice(4) } : { kind: 'native' })
const newKey = () => Math.random().toString(36).slice(2, 12)

type Draft = Omit<Profile, 'services'> & { services: (ServiceDef & { envText: string })[] }

/** The profile form, in the main region with a back control (P14), not a second sidebar. */
export function ProfileEditor({ model, actions, repo, initial, isNew }: { model: Model; actions: Actions; repo: Repo; initial: Profile; isNew: boolean }) {
  const [d, setD] = useState<Draft>(() => ({ ...initial, services: initial.services.map(s => ({ ...s, envText: envToText(s.env) })) }))
  const [error, setError] = useState<OpError | null>(null)
  const [saving, setSaving] = useState(false)
  const confirm = useConfirm()

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD(x => ({ ...x, [k]: v }))
  const setSvc = (i: number, patch: Partial<Draft['services'][number]>) => setD(x => ({ ...x, services: x.services.map((s, j) => (j === i ? { ...s, ...patch } : s)) }))

  const os = model.platform.os
  const runtimeOptions = repo.location.kind === 'wsl'
    ? [{ value: `wsl:${repo.location.distro}`, label: `WSL: ${repo.location.distro}` }]
    : [{ value: 'native', label: os === 'windows' ? 'Windows' : 'This computer' }, ...(os === 'windows' && /^[a-zA-Z]:/.test(repo.location.path) ? model.distros.distros.map(x => ({ value: `wsl:${x.name}`, label: `WSL: ${x.name}` })) : [])]

  const back = () => actions.setView({ kind: 'repo' })
  const save = async () => {
    const services: ServiceDef[] = []
    for (const s of d.services) {
      const { env, bad } = textToEnv(s.envText)
      if (bad) { setError({ code: 'INVALID', message: `${s.name || 'A service'}: "${bad}" is not a KEY=VALUE line.` }); return }
      const { envText: _envText, ...rest } = s
      services.push({ ...rest, env })
    }
    setSaving(true)
    const r = await api.saveProfile({ ...d, services })
    setSaving(false)
    if (!r.ok) { setError(r.error); return }
    await actions.reload()
    back()
  }
  const remove = async () => {
    const yes = await confirm({ title: `Delete profile ${initial.name}?`, description: 'Its services and settings are removed from GitManager. Your repository is not changed.', confirmLabel: 'Delete profile', destructive: true })
    if (!yes) return
    const r = await api.removeProfile(initial.id)
    if (!r.ok) { setError(r.error); return }
    await actions.reload()
    back()
  }

  return (
    <div className="gm-work">
      <header className="gm-top">
        <IconButton icon="chevron-left" label="Back to repository" onClick={back} />
        <h1 className="gm-h1 truncate">{isNew ? 'New profile' : initial.name}</h1>
        <span className="gm-path truncate">{repo.name}</span>
        <span className="grow" />
        {!isNew && <Button variant="ghost" onClick={() => void remove()}>Delete</Button>}
        <Button variant="ghost" onClick={back}>Cancel</Button>
        <Button variant="primary" onClick={() => void save()} disabled={saving} aria-busy={saving || undefined}>{saving && <span className="sm-spinner" aria-hidden="true" />}Save</Button>
      </header>
      {error && <ErrorBanner error={error} onDismiss={() => setError(null)} />}
      <div className="gm-scroll scroll">
        <form className="gm-form" onSubmit={e => { e.preventDefault(); void save() }}>
          <div className="gm-grid">
            <Field label="Name">{id => <input id={id} className="input" value={d.name} onChange={e => set('name', e.target.value)} />}</Field>
            <Field label="Runs in">{() => <Dropdown label="Runs in" value={runtimeValue(d.runtime)} options={runtimeOptions} onChange={v => set('runtime', valueRuntime(v))} />}</Field>
            <Field label="Working directory">{id => <input id={id} className="input gm-mono" placeholder="Repository root" value={d.workingDir} onChange={e => set('workingDir', e.target.value)} />}</Field>
            <Field label="Open when ready">{id => <input id={id} className="input gm-mono" placeholder="http://localhost:5173" value={d.openUrl} onChange={e => set('openUrl', e.target.value)} />}</Field>
            <Field label="Browser">{() => <Dropdown<Browser> label="Browser" value={d.browser} onChange={v => set('browser', v)}
              options={[{ value: 'chrome', label: 'Chrome' }, { value: 'edge', label: 'Edge' }, { value: 'default', label: 'System default' }]} />}</Field>
          </div>

          <div className="gm-form-head">
            <h2 className="gm-section-h">Services</h2>
          </div>
          {d.services.map((s, i) => (
            <fieldset key={s.id} className="gm-svc-edit surface-2">
              <legend className="sr-only">{s.name || `Service ${i + 1}`}</legend>
              <div className="gm-svc-edit-head">
                <input className="input gm-svc-edit-name" aria-label="Service name" placeholder="Name" value={s.name} onChange={e => setSvc(i, { name: e.target.value })} />
                <span className="grow" />
                <IconButton icon="x" size="sm" label={`Remove ${s.name || 'service'}`} disabled={d.services.length === 1}
                  onClick={() => set('services', d.services.filter((_, j) => j !== i))} />
              </div>
              <div className="gm-grid">
                <Field label="Command" wide>{id => <input id={id} className="input gm-mono" placeholder="npm run dev" value={s.command} onChange={e => setSvc(i, { command: e.target.value })} spellCheck={false} />}</Field>
                <Field label="Directory">{id => <input id={id} className="input gm-mono" placeholder="Same as profile" value={s.cwd} onChange={e => setSvc(i, { cwd: e.target.value })} spellCheck={false} />}</Field>
                <Field label="Ready when" hint={s.readiness.type === 'none' ? 'Without a check the service shows as running, never ready.' : undefined}>
                  {() => (
                    <div className="row gm-ready">
                      <Dropdown<Readiness['type']> label="Ready when" value={s.readiness.type}
                        options={[{ value: 'none', label: 'No check' }, { value: 'http', label: 'URL responds' }, { value: 'port', label: 'Port is open' }]}
                        onChange={t => setSvc(i, { readiness: t === 'http' ? { type: 'http', url: s.readiness.type === 'http' ? s.readiness.url : 'http://localhost:5173' } : t === 'port' ? { type: 'port', port: s.readiness.type === 'port' ? s.readiness.port : 8080 } : { type: 'none' } })} />
                      {s.readiness.type === 'http' && <input className="input gm-mono" aria-label="Readiness URL" value={s.readiness.url} onChange={e => setSvc(i, { readiness: { type: 'http', url: e.target.value } })} />}
                      {s.readiness.type === 'port' && <input className="input gm-mono gm-port" aria-label="Port" inputMode="numeric" value={String(s.readiness.port || '')}
                        onChange={e => setSvc(i, { readiness: { type: 'port', port: Number(e.target.value.replace(/\D/g, '')) || 0 } })} />}
                    </div>
                  )}
                </Field>
                {s.readiness.type !== 'none' && (
                  <Field label="Wait up to (seconds)">{id => <input id={id} className="input gm-port" inputMode="numeric" value={String(s.readyTimeout)} onChange={e => setSvc(i, { readyTimeout: Number(e.target.value.replace(/\D/g, '')) || 0 })} />}</Field>
                )}
                <Field label="Environment variables">{id => <textarea id={id} className="input gm-mono gm-env" rows={Math.max(2, s.envText.split('\n').length)} placeholder="KEY=value" value={s.envText} onChange={e => setSvc(i, { envText: e.target.value })} spellCheck={false} />}</Field>
                <Field label="Env file">{id => <input id={id} className="input gm-mono" placeholder=".env.local" value={s.envFile} onChange={e => setSvc(i, { envFile: e.target.value })} spellCheck={false} />}</Field>
              </div>
            </fieldset>
          ))}
          <div>
            <Button variant="ghost" icon="plus" onClick={() => set('services', [...d.services, { id: newKey(), name: '', command: '', cwd: '', env: {}, envText: '', envFile: '', readiness: { type: 'none' }, readyTimeout: 120 }])}>Add service</Button>
          </div>
          <button type="submit" hidden />
        </form>
      </div>
    </div>
  )
}
