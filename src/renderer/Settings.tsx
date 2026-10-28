import { useState } from 'react'
import { Button, Dropdown, IconButton } from '../../third_party/summa-ui/src/ui'
import type { OpError, Settings } from '../shared/types'
import { api } from './api'
import type { Actions, Model } from './App'
import { Field } from './ProfileEditor'
import { ErrorBanner } from './Workspace'

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
