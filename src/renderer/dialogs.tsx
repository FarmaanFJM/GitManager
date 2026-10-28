import { useEffect, useState } from 'react'
import { Button, Checkbox, Dialog, Dropdown } from '../../third_party/summa-ui/src/ui'
import type { DiscoveredRepo } from '../shared/types'
import { api } from './api'
import type { Model } from './App'

/** A folder path with Browse, and where it lives when WSL is available. Typing a \\wsl.localhost path also works. */
function LocationInput({ model, path, setPath, where, setWhere, autoFocus }: {
  model: Model; path: string; setPath: (v: string) => void; where: string; setWhere: (v: string) => void; autoFocus?: boolean
}) {
  const wsl = model.distros.available && model.distros.distros.length > 0
  const browse = async () => {
    const p = await api.pickFolder()
    if (p) { setPath(p); if (/^[\\/]{2}wsl/i.test(p)) setWhere('native') }
  }
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="row">
        <input className="input gm-mono" autoFocus={autoFocus} aria-label="Folder" spellCheck={false}
          placeholder={model.platform.os === 'windows' ? 'C:\\code\\project or /home/you/project' : '/home/you/project'} value={path} onChange={e => setPath(e.target.value)} />
        <Button variant="secondary" icon="folder-open" onClick={() => void browse()}>Browse</Button>
      </div>
      {wsl && (
        <div className="row gm-where">
          <span className="gm-label">Location</span>
          <Dropdown label="Location" value={where} onChange={setWhere}
            options={[{ value: 'native', label: 'Windows' }, ...model.distros.distros.map(d => ({ value: d.name, label: `WSL: ${d.name}` }))]} />
        </div>
      )}
    </div>
  )
}

const distroOf = (where: string, path: string) => (where !== 'native' && path.trim().startsWith('/') ? where : undefined)

export function AddRepoDialog({ open, model, onClose, onAdded }: { open: boolean; model: Model; onClose: () => void; onAdded: (repoId: string) => void }) {
  const [path, setPath] = useState('')
  const [where, setWhere] = useState('native')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (open) { setPath(''); setError(null); setWhere('native') } }, [open])
  const submit = async () => {
    if (!path.trim()) return
    setBusy(true)
    const r = await api.addRepo(path, distroOf(where, path))
    setBusy(false)
    if (!r.ok) { setError(r.error.message); return }
    onAdded(r.value.repo.id)
  }
  return (
    <Dialog open={open} onClose={onClose} title="Add repository" width={540}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!path.trim() || busy} aria-busy={busy || undefined} onClick={() => void submit()}>{busy && <span className="sm-spinner" aria-hidden="true" />}Add repository</Button></>}>
      <form onSubmit={e => { e.preventDefault(); void submit() }}>
        <LocationInput model={model} path={path} setPath={p => { setPath(p); setError(null) }} where={where} setWhere={setWhere} autoFocus />
        {error && <p className="gm-field-error" role="alert">{error}</p>}
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}

/** Choose a folder, search it (bounded depth), pick which repositories to add. The folder is remembered for later. */
export function FindReposDialog({ open, model, onClose, onAdded, onRootsChanged }: {
  open: boolean; model: Model; onClose: () => void; onAdded: (repoIds: string[]) => void; onRootsChanged: () => Promise<void>
}) {
  const [path, setPath] = useState('')
  const [where, setWhere] = useState('native')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [found, setFound] = useState<DiscoveredRepo[] | null>(null)
  const [picked, setPicked] = useState<Set<number>>(new Set())
  useEffect(() => { if (open) { setPath(''); setError(null); setFound(null); setWhere('native') } }, [open])

  const search = async () => {
    if (!path.trim()) return
    setBusy(true); setError(null)
    const root = await api.addRoot(path, distroOf(where, path))
    if (!root.ok) { setBusy(false); setError(root.error.message); return }
    await onRootsChanged()
    const r = await api.scanRoot(root.value.id)
    setBusy(false)
    if (!r.ok) { setError(r.error.message); return }
    setFound(r.value)
    setPicked(new Set(r.value.map((x, i) => (x.registered ? -1 : i)).filter(i => i >= 0)))
  }
  const add = async () => {
    if (!found) return
    setBusy(true)
    const r = await api.addRepos(found.filter((_, i) => picked.has(i)).map(x => x.location))
    setBusy(false)
    if (!r.ok) { setError(r.error.message); return }
    onAdded(r.value.map(x => x.id))
  }
  const toggle = (i: number) => setPicked(s => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n })

  return (
    <Dialog open={open} onClose={onClose} title="Find repositories" width={560}
      footer={found
        ? <><Button variant="secondary" onClick={() => setFound(null)}>Back</Button><Button variant="primary" disabled={!picked.size || busy} onClick={() => void add()}>{picked.size === 1 ? 'Add 1 repository' : `Add ${picked.size} repositories`}</Button></>
        : <><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!path.trim() || busy} aria-busy={busy || undefined} onClick={() => void search()}>{busy && <span className="sm-spinner" aria-hidden="true" />}Search</Button></>}>
      {!found ? (
        <form onSubmit={e => { e.preventDefault(); void search() }}>
          <LocationInput model={model} path={path} setPath={p => { setPath(p); setError(null) }} where={where} setWhere={setWhere} autoFocus />
          <p className="gm-hint">Searches {model.data.settings.discoveryDepth} levels deep and skips hidden and dependency folders.</p>
          {error && <p className="gm-field-error" role="alert">{error}</p>}
          <button type="submit" hidden />
        </form>
      ) : found.length === 0 ? (
        <p className="dialog-desc">No repositories found in this folder.</p>
      ) : (
        <ul className="gm-found" aria-label="Repositories found">
          {found.map((f, i) => (
            <li key={i} className="list-row gm-found-row">
              <Checkbox checked={f.registered || picked.has(i)} onChange={() => { if (!f.registered) toggle(i) }} label={`Add ${f.name}`} className={f.registered ? 'gm-disabled' : ''} />
              <span className="col grow" onClick={() => { if (!f.registered) toggle(i) }}>
                <span className="truncate">{f.name}</span>
                <span className="faint truncate gm-found-path">{f.location.kind === 'wsl' ? `${f.location.distro}: ${f.location.path}` : f.location.path}</span>
              </span>
              {f.registered && <span className="faint">Added</span>}
            </li>
          ))}
        </ul>
      )}
      {found && error && <p className="gm-field-error" role="alert">{error}</p>}
    </Dialog>
  )
}
