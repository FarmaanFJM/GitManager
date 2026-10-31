import { useEffect, useState } from 'react'
import { Button, Dropdown, Icon, IconButton, Switch } from '../../../../third_party/summa-ui/src/ui'
import type { ToastApi } from '../../../../third_party/summa-ui/src/presets'
import type { RunnerHost, RunnersState, SshConfigHost } from '../../../shared/runners'
import { api } from '../../api'
import { dateTime, hostText, scopeText } from '../common'

const HOST_STATUS = { ok: 'Inspected', inaccessible: 'Not reachable', skipped: 'Skipped', error: 'Failed', cancelled: 'Cancelled' }
const SCOPE_STATUS = { ok: 'Read', forbidden: 'No permission', 'not-found': 'Not found or no permission', 'rate-limited': 'Rate limit', error: 'Failed', skipped: 'Not read' }

function SwitchRow({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="gm-switch-field">
      <fieldset className="gm-switch-row"><Switch checked={checked} onChange={onChange} label={label} /><span>{label}</span></fieldset>
      {hint && <p className="gm-hint">{hint}</p>}
    </div>
  )
}

/** Where the last scan looked and what it could read, plus the places and scopes to add. Settings save at once. */
export function DiscoveryTab({ st, toast }: { st: RunnersState; toast: ToastApi }) {
  const s = st.config.settings
  const inv = st.inventory
  const [rootPath, setRootPath] = useState('')
  const [rootHost, setRootHost] = useState<string>('native')
  const [repo, setRepo] = useState('')
  const [org, setOrg] = useState('')
  const [ssh, setSsh] = useState<SshConfigHost[] | null>(null)
  useEffect(() => { void api.runnersSshHosts().then(setSsh) }, [s.sshHosts.length])
  const save = async (patch: Partial<typeof s>) => { const r = await api.runnersSaveSettings({ ...s, ...patch }); if (!r.ok) toast.error(r.error.message) }
  const hostOf = (v: string): RunnerHost => (v === 'native' ? { kind: 'native' } : v.startsWith('wsl:') ? { kind: 'wsl', distro: v.slice(4) } : { kind: 'ssh', host: v.slice(4) })
  const addRoot = async () => {
    if (!rootPath.trim()) return
    const r = await api.runnersAddRoot(hostOf(rootHost), rootPath.trim())
    if (!r.ok) { toast.error(r.error.message); return }
    setRootPath('')
  }
  const addRepo = async () => { const v = repo.trim(); if (!/^[^/\s]+\/[^/\s]+$/.test(v)) { toast.error('Enter the repository as owner/name'); return } await save({ repos: [...new Set([...s.repos, v])] }); setRepo('') }
  const addOrg = async () => { const v = org.trim(); if (!v) return; await save({ orgs: [...new Set([...s.orgs, v])] }); setOrg('') }
  const hostOptions = st.hosts.map(h => ({ value: h.host.kind === 'native' ? 'native' : h.host.kind === 'wsl' ? `wsl:${h.host.distro}` : `ssh:${h.host.host}`, label: h.label }))

  return (
    <div className="gm-scroll scroll">
      <section className="gm-section" aria-label="Last scan">
        <h3 className="gm-section-h">Where the last scan looked <span className="muted">{inv.localScannedAt ? dateTime(inv.localScannedAt) : 'not yet'}</span></h3>
        {inv.hosts.length === 0 ? <p className="gm-section-empty muted">No scan yet.</p> : (
          <ul className="gm-roots gm-disc-list">
            {inv.hosts.map(h => (
              <li key={hostText(h.host)} className="gm-root-row gm-disc-row">
                <Icon name={h.status === 'ok' ? 'circle-check' : h.status === 'skipped' || h.status === 'cancelled' ? 'circle' : 'circle-alert'} size={15} className={h.status === 'ok' ? 'muted' : 'gm-warn'} />
                <span className="col grow">
                  <span>{h.label} <span className="muted">{HOST_STATUS[h.status]}{h.status === 'ok' ? `, ${h.found} found in ${(h.durationMs / 1000).toFixed(1)} s` : ''}</span></span>
                  <span className="faint gm-found-path truncate" title={h.roots.join(', ')}>{h.message ?? h.roots.join(', ')}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="gm-section" aria-label="GitHub scopes">
        <h3 className="gm-section-h">Read from GitHub <span className="muted">{inv.githubScannedAt ? dateTime(inv.githubScannedAt) : 'not yet'}</span></h3>
        {inv.scopes.length === 0 ? <p className="gm-section-empty muted">Nothing read from GitHub yet. A scan asks GitHub for the runners of the repositories registered here, of the scopes local installations point at, and of the entries below.</p> : (
          <ul className="gm-roots gm-disc-list">
            {inv.scopes.map(sc => (
              <li key={scopeText(sc.scope)} className="gm-root-row gm-disc-row">
                <Icon name={sc.status === 'ok' ? 'circle-check' : sc.status === 'skipped' ? 'circle' : 'lock'} size={15} className={sc.status === 'ok' ? 'muted' : 'gm-warn'} />
                <span className="col grow">
                  <span>{scopeText(sc.scope)} <span className="faint">{sc.scope.kind === 'org' ? 'organization' : 'repository'}</span> <span className="muted">{SCOPE_STATUS[sc.status]}{sc.status === 'ok' ? `, ${sc.count} runner${sc.count === 1 ? '' : 's'}${sc.truncated ? ' (more exist)' : ''}` : ''}</span></span>
                  {sc.message && <span className="faint gm-found-path">{sc.message}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="gm-section gm-form gm-disc-form" aria-label="Discovery settings">
        <h3 className="gm-section-h">Automatic discovery</h3>
        <SwitchRow label="Find runners at startup" hint="Reads installation folders and services on this computer and in WSL distributions. It changes nothing." checked={s.autoDiscover} onChange={v => void save({ autoDiscover: v })} />
        <SwitchRow label="Also read GitHub at startup" hint="Uses GitHub API requests through your GitHub CLI sign-in at every launch. Off keeps startup to local files; Scan reads GitHub when you ask." checked={s.githubAtStartup} onChange={v => void save({ githubAtStartup: v })} />
        <div className="gm-grid">
          <div className="gm-field">
            <span className="gm-label">Refresh GitHub status while this tool is open</span>
            <Dropdown label="Refresh interval" value={String(s.refreshMinutes)} onChange={v => void save({ refreshMinutes: Number(v) })} options={[{ value: '0', label: 'Only when I return to the window' }, { value: '2', label: 'Every 2 minutes' }, { value: '5', label: 'Every 5 minutes' }, { value: '15', label: 'Every 15 minutes' }]} />
          </div>
        </div>
        <h3 className="gm-section-h">Folders to inspect</h3>
        <p className="gm-hint">Common locations are always checked (for example /opt, /home, C:\ and your profile folder). Add a folder for runners installed elsewhere.</p>
        {s.roots.length > 0 && (
          <ul className="gm-roots">
            {s.roots.map(r => (
              <li key={r.id} className="gm-root-row">
                <span className="gm-mono truncate">{hostText(r.host)}: {r.path}</span>
                <span className="grow" />
                <IconButton icon="x" size="sm" label="Forget folder" onClick={() => void api.runnersRemoveRoot(r.id)} />
              </li>
            ))}
          </ul>
        )}
        <div className="row gm-add-row">
          <Dropdown label="Where" value={rootHost} onChange={setRootHost} options={hostOptions} width={240} />
          <input className="input gm-mono grow" aria-label="Folder to inspect" placeholder={rootHost === 'native' && st.hosts[0]?.os === 'windows' ? 'D:\\runners' : '/srv/runners'} value={rootPath} onChange={e => setRootPath(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void addRoot() }} spellCheck={false} />
          <Button variant="secondary" icon="plus" onClick={() => void addRoot()} disabled={!rootPath.trim()}>Add folder</Button>
        </div>
        <h3 className="gm-section-h">GitHub repositories and organizations to read</h3>
        <p className="gm-hint">Repositories registered in GitManager with a github.com remote, and scopes found in local installations, are read without being listed here. Organization runners need organization administration.</p>
        {(s.repos.length > 0 || s.orgs.length > 0) && (
          <ul className="gm-roots">
            {s.repos.map(r => <li key={`r:${r}`} className="gm-root-row"><span className="gm-mono truncate">{r}</span><span className="faint">repository</span><span className="grow" /><IconButton icon="x" size="sm" label={`Forget ${r}`} onClick={() => void save({ repos: s.repos.filter(x => x !== r) })} /></li>)}
            {s.orgs.map(o => <li key={`o:${o}`} className="gm-root-row"><span className="gm-mono truncate">{o}</span><span className="faint">organization</span><span className="grow" /><IconButton icon="x" size="sm" label={`Forget ${o}`} onClick={() => void save({ orgs: s.orgs.filter(x => x !== o) })} /></li>)}
          </ul>
        )}
        <div className="row gm-add-row">
          <input className="input gm-mono grow" aria-label="Repository to read" placeholder="owner/repository" value={repo} onChange={e => setRepo(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void addRepo() }} spellCheck={false} />
          <Button variant="secondary" icon="plus" onClick={() => void addRepo()} disabled={!repo.trim()}>Add repository</Button>
        </div>
        <div className="row gm-add-row">
          <input className="input gm-mono grow" aria-label="Organization to read" placeholder="organization" value={org} onChange={e => setOrg(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void addOrg() }} spellCheck={false} />
          <Button variant="secondary" icon="plus" onClick={() => void addOrg()} disabled={!org.trim()}>Add organization</Button>
        </div>
        <h3 className="gm-section-h">Remote machines over SSH</h3>
        <p className="gm-hint">Hosts from your SSH configuration (~/.ssh/config). An allowed host is inspected during scans and can receive installations; commands run through ssh with key-based authentication only, and GitManager never enables SSH, opens ports or changes firewall rules.</p>
        {ssh === null ? <p className="gm-section-empty muted">Reading SSH configuration</p> : ssh.length === 0 ? <p className="gm-section-empty muted">No host aliases in ~/.ssh/config.</p> : (
          <ul className="gm-roots">
            {ssh.map(h => (
              <li key={h.alias} className="gm-root-row">
                <fieldset className="gm-switch-row"><Switch checked={h.allowed} onChange={v => void api.runnersAllowSsh(h.alias, v)} label={`Allow ${h.alias}`} /><span className="gm-mono">{h.alias}</span></fieldset>
                <span className="faint truncate">{[h.user, h.hostName].filter(Boolean).join('@')}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
