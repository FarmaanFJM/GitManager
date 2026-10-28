import { useState } from 'react'
import { Button, Dropdown, IconButton, Switch } from '../../third_party/summa-ui/src/ui'
import type { OpError, Settings } from '../shared/types'
import { api } from './api'
import type { Actions, Model } from './App'
import { Field } from './ProfileEditor'
import { ErrorBanner } from './Workspace'
import { ago } from './util'

export function SettingsView({ model, actions }: { model: Model; actions: Actions }) {
  const [s, setS] = useState<Settings>(model.data.settings)
  const [error, setError] = useState<OpError | null>(null)
  const [saved, setSaved] = useState(true)
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => { setS(x => ({ ...x, [k]: v })); setSaved(false) }

  const save = async () => {
    const r = await api.saveSettings(s)
    if (!r.ok) { setError(r.error); return }
    setError(null); setSaved(true)
    await actions.reload()
  }
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
          <div className="gm-grid">
            <Field label="Editor command" hint={model.platform.os === 'windows' ? 'Runs with the repository folder, for example code or cursor. WSL repositories open from inside WSL.' : 'Runs with the repository folder, for example code.'}>
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
          <div className="gm-switch-row">
            <Switch checked={s.autoDiscover} onChange={v => set('autoDiscover', v)} label="Find repositories automatically at startup" />
            <span>Find repositories automatically at startup</span>
          </div>
          <p className="gm-hint" style={{ marginTop: -8 }}>
            {model.platform.os === 'windows' ? 'Looks in common development folders such as C:\\Projects and source\\repos, and in the home folders of your WSL distributions.' : 'Looks in common development folders in your home folder.'} It only adds repositories; it never runs anything in them.
          </p>
          <div className="row">
            <Button onClick={() => actions.rescan('common')} disabled={!!disc?.running} icon="refresh">Rescan now</Button>
            <Button variant="ghost" onClick={() => actions.rescan('deep')} disabled={!!disc?.running}>{deepLabel}</Button>
            <span className="gm-hint">
              {disc?.running ? `Searching, ${disc.locationsScanned} of ${disc.locationsTotal} locations` : disc?.finishedAt ? `Last search ${ago(disc.finishedAt)}: ${disc?.found ?? 0} found, ${disc?.added ?? 0} added` : ''}
            </span>
          </div>

          {model.data.ignored.length > 0 && (
            <>
              <div className="gm-form-head">
                <h2 className="gm-section-h">Removed repositories</h2>
              </div>
              <p className="gm-hint" style={{ marginTop: -8 }}>Discovery does not add these again.</p>
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
            ? <p className="muted gm-section-empty">GitManager can look for repositories inside folders you choose.</p>
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

          <p className="gm-data-path faint">Settings and profiles are stored on this computer in <span className="gm-mono">{model.platform.dataPath}</span>. GitManager {model.platform.version}.</p>
          <button type="submit" hidden />
        </form>
      </div>
    </div>
  )
}
