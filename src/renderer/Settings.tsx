import { useEffect, useState } from 'react'
import { Button, Dropdown, IconButton, Switch, Tooltip, CopyButton } from '../../third_party/summa-ui/src/ui'
import type { OpError, Settings, StartupState } from '../shared/types'
import { api } from './api'
import type { Actions, Model } from './App'
import { Field } from './ProfileEditor'
import { ErrorBanner } from './Workspace'
import { ago } from './util'
import type { RunnersSettings } from '../shared/runners'

/** A Summa-UI switch with its visible label and an optional hint; the fieldset disables it for pointer and keyboard alike. */
function SwitchRow({ label, hint, checked, onChange, disabled }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  const row = (
    <fieldset className="gm-switch-row" disabled={disabled}>
      <Switch checked={checked} onChange={onChange} label={label} />
      <span>{label}</span>
    </fieldset>
  )
  // A hint is supplementary: one short sentence on hover or focus, never printed under the control.
  return <div className="gm-switch-field">{hint ? <Tooltip content={hint} side="bottom">{row}</Tooltip> : row}</div>
}

export function SettingsView({ model, actions }: { model: Model; actions: Actions }) {
  const [s, setS] = useState<Settings>(model.data.settings)
  const [error, setError] = useState<OpError | null>(null)
  const [saved, setSaved] = useState(true)
  const [startup, setStartup] = useState<StartupState | null>(null)
  const [runners, setRunners] = useState<RunnersSettings | null>(null)
  useEffect(() => { void api.runnersState().then(st => setRunners(st.config.settings)) }, [])
  const saveRunners = async (patch: Partial<RunnersSettings>) => {
    if (!runners) return
    const next = { ...runners, ...patch }
    setRunners(next)
    const r = await api.runnersSaveSettings(next)
    if (!r.ok) setError(r.error)
  }
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => { setS(x => ({ ...x, [k]: v })); setSaved(false) }
  const windows = model.platform.os === 'windows'

  // The startup switch shows what Windows will do, read each time Settings opens (Task Manager can turn the entry off).
  useEffect(() => {
    void api.startupState().then(st => {
      setStartup(st)
      if (st.supported && st.active !== model.data.settings.launchAtStartup) { setS(x => ({ ...x, launchAtStartup: st.active })); void actions.reload() }
    })
  }, [])

  const save = async () => {
    const r = await api.saveSettings(s)
    setStartup(await api.startupState())
    if (!r.ok) { setError(r.error); return }
    setS(r.value)
    setError(null); setSaved(true)
    await actions.reload()
  }
  const startupHint = !startup ? undefined
    : !startup.supported ? startup.reason ?? undefined
      : startup.disabledByWindows && !s.launchAtStartup ? 'Turned off in Windows Startup apps.'
        : 'Opens GitManager at sign-in.'
  /** Adds a removed repository back (a manual add also lifts the removal). If the folder is gone, only the removal is forgotten. */
  const restore = async (key: string) => {
    const i = model.data.ignored.find(x => x.key === key)
    if (!i) return
    const r = await api.addRepo(i.location.path, i.location.kind === 'wsl' ? i.location.distro : undefined)
    if (!r.ok) { await api.unignoreRepo(key); setError(r.error) }
    await actions.reload()
  }
  const disc = model.discovery
  const deepLabel = model.platform.os === 'windows' ? 'Search all drives' : 'Search the whole home folder'
  const removeRoot = async (id: string) => {
    const r = await api.removeRoot(id)
    if (!r.ok) setError(r.error); else await actions.reload()
  }

  return (
    <div className="gm-work">
      <header className="gm-top">
        <h1 className="gm-h1">Settings</h1>
        <span className="grow" />
        <Button variant="primary" onClick={() => void save()} disabled={saved}>Save</Button>
      </header>
      {error && <ErrorBanner error={error} onDismiss={() => setError(null)} />}
      <div className="gm-scroll scroll">
        <form className="gm-form" onSubmit={e => { e.preventDefault(); void save() }}>
          <div className="gm-form-head gm-form-head-first">
            <h2 className="gm-section-h">General</h2>
          </div>
          {windows && (
            <>
              <SwitchRow label="Launch at Windows startup" hint={startupHint} checked={s.launchAtStartup} disabled={!startup?.supported}
                onChange={v => set('launchAtStartup', v)} />
              <SwitchRow label="Start minimized" hint="Waits in the notification area at Windows startup."
                checked={s.startMinimized} disabled={!startup?.supported || !s.launchAtStartup} onChange={v => set('startMinimized', v)} />
            </>
          )}
          {model.platform.os !== 'mac' && (
            <SwitchRow label="Minimize to system tray" hint="Minimizing hides the window in the notification area."
              checked={s.minimizeToTray} onChange={v => set('minimizeToTray', v)} />
          )}
          <div className="gm-grid">
            <Field label="Editor command">
              {id => <input id={id} className="input gm-mono" value={s.editor} placeholder="code" onChange={e => set('editor', e.target.value)} spellCheck={false} />}
            </Field>
            <Field label="Chrome location">
              {id => <input id={id} className="input gm-mono" value={s.chromePath} placeholder="Found automatically" onChange={e => set('chromePath', e.target.value)} spellCheck={false} />}
            </Field>
            <Field label="Search depth for repository folders">
              {() => <Dropdown label="Search depth" value={String(s.discoveryDepth)} onChange={v => set('discoveryDepth', Number(v))}
                options={[1, 2, 3, 4, 5, 6].map(n => ({ value: String(n), label: n === 1 ? '1 level' : `${n} levels` }))} />}
            </Field>
          </div>

          <div className="gm-form-head">
            <h2 className="gm-section-h">Automatic discovery</h2>
          </div>
          <SwitchRow label="Find repositories automatically at startup" checked={s.autoDiscover} onChange={v => set('autoDiscover', v)}
            hint="Only adds repositories; runs nothing in them." />
          <div className="row">
            <Button onClick={() => actions.rescan('common')} disabled={!!disc?.running} icon="refresh">Rescan now</Button>
            <Button variant="ghost" onClick={() => actions.rescan('deep')} disabled={!!disc?.running}>{deepLabel}</Button>
            <span className="gm-hint">
              {disc?.running ? `Searching, ${disc.locationsScanned} of ${disc.locationsTotal} locations` : disc?.finishedAt ? `Last search ${ago(disc.finishedAt)}: ${disc?.found ?? 0} found, ${disc?.added ?? 0} added` : ''}
            </span>
          </div>

          <div className="gm-form-head">
            <h2 className="gm-section-h">Runners</h2>
            <span className="grow" />
            <Button variant="ghost" onClick={() => actions.setView({ kind: 'tools', tool: 'runners' })}>Open Runners</Button>
          </div>
          <SwitchRow label="Find GitHub Actions runners at startup" checked={runners?.autoDiscover ?? true} disabled={!runners} onChange={v => void saveRunners({ autoDiscover: v })}
            hint="Only reads; nothing is started or changed." />
          <SwitchRow label="Also read GitHub at startup" checked={runners?.githubAtStartup ?? false} disabled={!runners} onChange={v => void saveRunners({ githubAtStartup: v })}
            hint="Off keeps startup offline." />

          {model.data.ignored.length > 0 && (
            <>
              <div className="gm-form-head">
                <h2 className="gm-section-h">Removed repositories</h2>
              </div>
              <ul className="gm-roots">
                {model.data.ignored.map(i => (
                  <li key={i.key} className="gm-ignored-row">
                    <span className="gm-mono truncate">{i.location.kind === 'wsl' ? `${i.location.distro}: ${i.location.path}` : i.location.path}</span>
                    <span className="grow" />
                    <Button variant="ghost" onClick={() => void restore(i.key)}>Restore</Button>
                  </li>
                ))}
              </ul>
            </>
          )}

          <div className="gm-form-head">
            <h2 className="gm-section-h">Repository folders</h2>
            <span className="grow" />
            <Button variant="ghost" icon="plus" onClick={actions.findReposDialog}>Add folder</Button>
          </div>
          {model.data.roots.length === 0
            ? <p className="muted gm-section-empty">No folders</p>
            : (
              <ul className="gm-roots">
                {model.data.roots.map(r => (
                  <li key={r.id} className="gm-root-row">
                    <span className="gm-mono truncate">{r.location.kind === 'wsl' ? `${r.location.distro}: ${r.location.path}` : r.location.path}</span>
                    <span className="faint num">{r.depth === 1 ? '1 level' : `${r.depth} levels`}</span>
                    <span className="grow" />
                    <IconButton icon="x" size="sm" label="Forget folder" onClick={() => void removeRoot(r.id)} />
                  </li>
                ))}
              </ul>
            )}

          <p className="gm-data-path faint">GitManager {model.platform.version} <CopyButton value={model.platform.dataPath} label="Copy data path" /></p>
          <button type="submit" hidden />
        </form>
      </div>
    </div>
  )
}
