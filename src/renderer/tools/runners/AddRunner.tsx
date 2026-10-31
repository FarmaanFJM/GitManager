import { useEffect, useMemo, useState } from 'react'
import { Button, Checkbox, Dialog, Dropdown, Icon, Switch, Tag } from '../../../../third_party/summa-ui/src/ui'
import type { ToastApi } from '../../../../third_party/summa-ui/src/presets'
import type { GitHubOrgChoice, GitHubRepoChoice, HostProbe, InstallJob, InstallPlan, InstallRequest, RunnerGroupInfo, RunnerHost, RunnerOs, RunnersState } from '../../../shared/runners'
import { api } from '../../api'
import { OS_TEXT, copyText, hostText } from '../common'

type Step = 'platform' | 'environment' | 'scope' | 'config' | 'review' | 'install'
const STEPS: { id: Step; label: string }[] = [{ id: 'platform', label: 'Platform' }, { id: 'environment', label: 'Environment' }, { id: 'scope', label: 'GitHub scope' }, { id: 'config', label: 'Configuration' }, { id: 'review', label: 'Review' }, { id: 'install', label: 'Install' }]

type HostChoice = RunnersState['hosts'][number]

function defaultDirectory(os: RunnerOs, probe: HostProbe | null, name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, '-') || 'runner'
  if (os === 'windows') return `C:\\actions-runners\\${safe}`
  const user = probe?.user
  if (os === 'macos') return user ? `/Users/${user}/actions-runners/${safe}` : `/opt/actions-runners/${safe}`
  return user && user !== 'root' ? `/home/${user}/actions-runners/${safe}` : `/opt/actions-runners/${safe}`
}

function Option({ title, desc, selected, onSelect, disabled, note }: { title: string; desc?: string; selected: boolean; onSelect: () => void; disabled?: boolean; note?: string }) {
  return (
    <button type="button" className={`gm-opt ${selected ? 'selected' : ''}`} aria-pressed={selected} disabled={disabled} onClick={onSelect}>
      <span className="col grow"><span className="gm-opt-title">{title}</span>{desc && <span className="gm-opt-desc">{desc}</span>}{note && <span className="gm-opt-desc gm-warn">{note}</span>}</span>
      {selected && <Icon name="check" size={16} />}
    </button>
  )
}

const StepField = ({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) => <div className="gm-field"><span className="gm-label">{label}</span>{children}{hint && <p className="gm-hint">{hint}</p>}</div>

/** The guided setup: platform, environment, scope, configuration, the reviewed plan, then the installation with its progress. */
export function AddRunnerDialog({ open, st, toast, onClose, onInstalled }: { open: boolean; st: RunnersState; toast: ToastApi; onClose: () => void; onInstalled: (key: string | null) => void }) {
  const [step, setStep] = useState<Step>('platform')
  const [os, setOs] = useState<RunnerOs | null>(null)
  const [host, setHost] = useState<HostChoice | null>(null)
  const [manual, setManual] = useState(false)
  const [probe, setProbe] = useState<HostProbe | null>(null)
  const [probing, setProbing] = useState(false)
  const [scopeKind, setScopeKind] = useState<'repo' | 'org'>('repo')
  const [repoQuery, setRepoQuery] = useState('')
  const [repos, setRepos] = useState<GitHubRepoChoice[] | null>(null)
  const [repo, setRepo] = useState<string | null>(null)
  const [orgs, setOrgs] = useState<GitHubOrgChoice[] | null>(null)
  const [org, setOrg] = useState<string | null>(null)
  const [groups, setGroups] = useState<RunnerGroupInfo[] | null>(null)
  const [name, setName] = useState('')
  const [dir, setDir] = useState('')
  const [dirTouched, setDirTouched] = useState(false)
  const [labels, setLabels] = useState('')
  const [group, setGroup] = useState<string | null>(null)
  const [service, setService] = useState(true)
  const [serviceUser, setServiceUser] = useState('')
  const [winAccount, setWinAccount] = useState<InstallRequest['windowsAccount']>('network-service')
  const [winAccountName, setWinAccountName] = useState('')
  const [startAfter, setStartAfter] = useState(true)
  const [replace, setReplace] = useState(false)
  const [ephemeral, setEphemeral] = useState(false)
  const [disableUpdate, setDisableUpdate] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const [plan, setPlan] = useState<InstallPlan | null>(null)
  const [planning, setPlanning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const job = st.job

  useEffect(() => {
    if (!open) return
    setStep('platform'); setOs(null); setHost(null); setManual(false); setProbe(null); setScopeKind('repo'); setRepo(null); setOrg(null); setGroups(null); setGroup(null)
    setName(''); setDir(''); setDirTouched(false); setLabels(''); setService(true); setServiceUser(''); setWinAccount('network-service'); setWinAccountName(''); setStartAfter(true); setReplace(false); setEphemeral(false); setDisableUpdate(false)
    setAdvanced(false); setPlan(null); setError(null); setAcknowledged(false)
    const machine = (() => { try { return '' } catch { return '' } })()
    void machine
  }, [open])

  const platforms = useMemo(() => {
    const out: { os: RunnerOs; hosts: HostChoice[]; remote: boolean }[] = []
    for (const o of ['windows', 'linux', 'macos'] as RunnerOs[]) {
      const hosts = st.hosts.filter(h => h.available && (h.os === o || (h.host.kind === 'ssh' && h.os === 'unknown')))
      if (hosts.length) out.push({ os: o, hosts, remote: hosts.some(h => h.host.kind === 'ssh') })
    }
    return out
  }, [st.hosts])

  useEffect(() => { if (step === 'scope' && scopeKind === 'repo' && repos === null) void api.runnersRepos('').then(setRepos) }, [step, scopeKind, repos])
  useEffect(() => { if (step === 'scope' && scopeKind === 'org' && orgs === null) void api.runnersOrgs().then(setOrgs) }, [step, scopeKind, orgs])
  useEffect(() => {
    if (step !== 'config' || scopeKind !== 'org' || !org) return
    void api.runnersGroups(org).then(r => setGroups(r.ok ? r.value : []))
  }, [step, scopeKind, org])
  useEffect(() => { if (!dirTouched && os) setDir(defaultDirectory(os, probe, name || (probe?.machine ?? 'runner'))) }, [name, os, probe, dirTouched])
  useEffect(() => { if (!name && probe?.machine) setName(probe.machine.toLowerCase().replace(/[^a-z0-9._-]/g, '-').slice(0, 40)) }, [probe]) // eslint-disable-line react-hooks/exhaustive-deps

  const searchRepos = async (q: string) => { setRepoQuery(q); if (q.includes('/')) setRepos(await api.runnersRepos(q)) }
  const chooseHost = async (h: HostChoice) => {
    setHost(h); setManual(false); setProbe(null); setError(null)
    setProbing(true)
    const r = await api.runnersProbe(h.host)
    setProbing(false)
    if (!r.ok) { setError(r.error.message); return }
    setProbe(r.value)
    if (!r.value.reachable) setError(r.value.message ?? 'The machine did not answer.')
    else if (os && r.value.os !== os) setError(`${h.label} runs ${OS_TEXT[r.value.os]}, not ${OS_TEXT[os]}.`)
    else if (r.value.os === 'windows' && h.host.kind === 'ssh') setManual(true)
  }

  const scope = scopeKind === 'repo' && repo ? { kind: 'repo' as const, owner: repo.split('/')[0], repo: repo.split('/')[1] } : scopeKind === 'org' && org ? { kind: 'org' as const, org } : null
  const request = (): InstallRequest | null => {
    if (!host || !scope || !os) return null
    return {
      host: host.host, scope, name: name.trim(), directory: dir.trim(), labels: labels.split(/[,\s]+/).map(s => s.trim()).filter(Boolean), runnerGroup: scopeKind === 'org' ? group : null,
      installService: service, serviceUser: serviceUser.trim() || null, windowsAccount: os === 'windows' ? winAccount : null, windowsAccountName: winAccount === 'custom' ? winAccountName.trim() : null,
      startAfter, replace, ephemeral, disableUpdate, workFolder: '_work',
    }
  }
  const makePlan = async () => {
    const req = request(); if (!req) return
    setPlanning(true); setError(null); setPlan(null)
    const r = await api.runnersPlan(req)
    setPlanning(false)
    if (!r.ok) { setError(r.error.message); return }
    setPlan(r.value); setAcknowledged(false); setStep('review')
  }
  const install = async () => {
    if (!plan) return
    setError(null)
    const r = await api.runnersInstall(plan.id, true)
    if (!r.ok) { setError(r.error.message); return }
    setStep('install')
  }
  const configOk = !!name.trim() && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name.trim()) && !!dir.trim() && (!service || os !== 'linux' || !!(serviceUser.trim() || (probe?.user && probe.user !== 'root'))) && (winAccount !== 'custom' || !!winAccountName.trim())
  const permissionNote = scopeKind === 'repo' ? repos?.find(r => r.fullName.toLowerCase() === repo?.toLowerCase()) : null

  const idx = STEPS.findIndex(s => s.id === step)
  const next = () => { if (step === 'platform') setStep('environment'); else if (step === 'environment') setStep('scope'); else if (step === 'scope') setStep('config'); else if (step === 'config') void makePlan() }
  const back = () => { setError(null); if (step === 'environment') setStep('platform'); else if (step === 'scope') setStep('environment'); else if (step === 'config') setStep('scope'); else if (step === 'review') setStep('config') }
  const canNext = step === 'platform' ? !!os : step === 'environment' ? !!host && !!probe?.reachable && !error : step === 'scope' ? !!scope : step === 'config' ? configOk : false
  const finished = job && job.state !== 'running'

  const footer = step === 'install'
    ? <>{job?.state === 'running' && <Button variant="secondary" onClick={() => void api.runnersCancelInstall()} disabled={job.cancelRequested}>{job.cancelRequested ? 'Stopping after this step' : 'Cancel'}</Button>}<span className="grow" />{finished && <Button variant="primary" onClick={() => { onInstalled(job?.runnerKey ?? null); onClose() }}>{job?.state === 'done' ? 'Show runner' : 'Close'}</Button>}</>
    : manual && step === 'environment'
      ? <><Button variant="secondary" onClick={back}>Back</Button><span className="grow" /><Button variant="primary" onClick={onClose}>Close</Button></>
      : <>
        {step !== 'platform' && <Button variant="secondary" onClick={back}>Back</Button>}
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <span className="grow" />
        {step === 'review'
          ? <Button variant="primary" disabled={!plan || plan.blockers.length > 0 || !acknowledged} onClick={() => void install()}>Install runner</Button>
          : <Button variant="primary" disabled={!canNext || planning} aria-busy={planning || undefined} onClick={next}>{planning && <span className="sm-spinner" aria-hidden="true" />}{step === 'config' ? 'Review plan' : 'Next'}</Button>}
      </>

  return (
    <Dialog open={open} onClose={step === 'install' && job?.state === 'running' ? () => toast.info('The installation keeps running in the background; open Add runner again to follow it.') : onClose} title="Add runner" width={720} footer={footer} dismissOnBackdrop={false}>
      <ol className="gm-steps" aria-label="Steps">
        {STEPS.map((s, i) => <li key={s.id} className={i === idx ? 'current' : i < idx ? 'done' : ''} aria-current={i === idx ? 'step' : undefined}>{s.label}</li>)}
      </ol>
      {error && <p className="gm-field-error" role="alert">{error}</p>}

      {step === 'platform' && (
        <div className="gm-opts">
          {platforms.length === 0 && <p className="dialog-desc">No place to install a runner: this computer's platform was not detected.</p>}
          {platforms.map(p => (
            <Option key={p.os} title={OS_TEXT[p.os]} selected={os === p.os} onSelect={() => { setOs(p.os); setHost(null); setProbe(null); setError(null) }}
              desc={p.hosts.filter(h => h.host.kind !== 'ssh').map(h => h.label).concat(p.remote ? ['remote machine over SSH'] : []).join(', ')} />
          ))}
          <p className="gm-hint">{st.security}</p>
        </div>
      )}

      {step === 'environment' && os && (
        <div className="gm-opts">
          {st.hosts.filter(h => h.available && (h.os === os || (h.host.kind === 'ssh' && (h.os === 'unknown' || h.os === os)))).map(h => (
            <Option key={hostText(h.host)} title={h.host.kind === 'wsl' ? `WSL2 on this Windows computer: ${h.host.distro}` : h.host.kind === 'ssh' ? `Remote machine: ${h.host.host}` : os === 'windows' ? 'This computer' : os === 'macos' ? 'This Mac' : 'Native Linux on this computer'}
              desc={h.host.kind === 'wsl' ? h.label : h.host.kind === 'ssh' ? 'Commands run over your SSH configuration with key-based authentication. You will be asked before anything runs there.' : undefined} note={h.note ?? undefined}
              selected={!!host && hostText(host.host) === hostText(h.host)} onSelect={() => void chooseHost(h)} />
          ))}
          {os === 'linux' && !st.hosts.some(h => h.host.kind === 'wsl') && st.hosts[0]?.os === 'windows' && <p className="gm-hint">No WSL 2 distribution was found on this computer.</p>}
          {!st.hosts.some(h => h.host.kind === 'ssh') && <p className="gm-hint">Remote machines appear here once you allow an SSH host in the Discovery tab. Without an SSH connection a remote runner can only be monitored through GitHub after a manual setup.</p>}
          {probing && <p className="gm-loading-line"><span className="sm-spinner" aria-hidden="true" /> Checking the machine</p>}
          {probe?.reachable && !error && (
            <dl className="gm-props gm-probe">
              <dt>Machine</dt><dd>{probe.machine ?? 'unknown'}</dd>
              <dt>System</dt><dd>{OS_TEXT[probe.os]} {probe.arch}</dd>
              <dt>User</dt><dd>{probe.user ?? 'unknown'}</dd>
              {probe.os === 'linux' && <><dt>systemd</dt><dd>{probe.systemd ? 'running' : 'not running (no service possible)'}</dd></>}
              {probe.sudo !== null && <><dt>sudo</dt><dd>{probe.sudo ? 'works without a password' : 'needs a password'}</dd></>}
            </dl>
          )}
          {manual && host && (
            <div className="gm-notice"><Icon name="info" size={16} /><div>
              <p>{host.label} runs Windows. GitManager cannot install a Windows runner over SSH. Set it up on that machine from GitHub's instructions, then scan here: the runner will be listed from GitHub and monitored.</p>
              <p className="gm-hint"><button type="button" className="gm-linkbtn" onClick={() => void api.runnersOpen({ kind: 'docs', page: 'add-runner' })}>Adding self-hosted runners (GitHub Docs)</button></p>
            </div></div>
          )}
        </div>
      )}

      {step === 'scope' && (
        <div className="gm-opts">
          <div className="gm-opts gm-opts-row">
            <Option title="A repository" desc="The runner serves only this repository. Needs administrator permission on it." selected={scopeKind === 'repo'} onSelect={() => setScopeKind('repo')} />
            <Option title="An organization" desc="The runner is shared through a runner group with the repositories the group allows. Needs organization administration (admin:org)." selected={scopeKind === 'org'} onSelect={() => setScopeKind('org')} />
          </div>
          {scopeKind === 'repo' ? (
            <StepField label="Repository" hint={permissionNote ? (permissionNote.canAdmin ? 'You administer this repository.' : permissionNote.source === 'github' ? 'Your sign-in cannot administer this repository, so registering will fail.' : 'Permission not checked yet; the plan checks it.') : 'Registered repositories are listed first; type owner/name to look up another repository you can reach.'}>
              <Dropdown label="Repository" searchable width={420} value={repo} placeholder={repos === null ? 'Loading' : 'Choose a repository'} options={(repos ?? []).map(r => ({ value: r.fullName, label: r.fullName, meta: r.canAdmin ? 'admin' : r.source === 'gitmanager' ? 'registered here' : r.source === 'local' ? 'local runner' : r.private ? 'private' : '' }))}
                onChange={setRepo} onCreate={n => { if (/^[^/\s]+\/[^/\s]+$/.test(n)) { void searchRepos(n); setRepo(n); return n } toast.error('Enter the repository as owner/name'); return undefined }} createNoun="repository" />
            </StepField>
          ) : (
            <StepField label="Organization">
              <Dropdown label="Organization" width={420} value={org} placeholder={orgs === null ? 'Loading' : orgs.length ? 'Choose an organization' : 'No organizations for this sign-in'} options={(orgs ?? []).map(o => ({ value: o.login, label: o.login, meta: o.canAdmin ? 'admin' : o.canAdmin === false ? 'member' : 'role unknown' }))} onChange={setOrg} />
              {org && orgs?.find(o => o.login === org)?.message && <p className="gm-hint gm-warn">{orgs.find(o => o.login === org)!.message}</p>}
            </StepField>
          )}
          {repoQuery && scopeKind === 'repo' && repos !== null && !repos.some(r => r.fullName.toLowerCase() === repoQuery.toLowerCase()) && <p className="gm-hint">{repoQuery} was not found among the repositories you can reach.</p>}
        </div>
      )}

      {step === 'config' && os && (
        <div className="gm-form gm-wizard-form">
          <div className="gm-grid">
            <StepField label="Runner name" hint="Letters, digits, dots, dashes and underscores. Must be unique in the scope.">
              <input className="input" aria-label="Runner name" value={name} onChange={e => setName(e.target.value)} spellCheck={false} />
            </StepField>
            <StepField label="Installation directory" hint="A new or empty folder of its own; existing installations are never overwritten.">
              <input className="input gm-mono" aria-label="Installation directory" value={dir} onChange={e => { setDir(e.target.value); setDirTouched(true) }} spellCheck={false} />
            </StepField>
            <StepField label="Custom labels" hint="Comma separated. The default labels (self-hosted, platform, architecture) are added by GitHub.">
              <input className="input" aria-label="Custom labels" value={labels} placeholder="gpu, docker" onChange={e => setLabels(e.target.value)} spellCheck={false} />
            </StepField>
            {scopeKind === 'org' && (
              <StepField label="Runner group" hint={groups === null ? 'Reading groups' : groups.length ? 'Decides which repositories may use the runner.' : 'No groups could be read; the Default group is used.'}>
                <Dropdown label="Runner group" value={group ?? ''} onChange={v => setGroup(v || null)} options={[{ value: '', label: 'Default' }, ...(groups ?? []).filter(g => !g.default).map(g => ({ value: g.name, label: g.name, meta: g.visibility === 'selected' ? `${g.selectedRepos?.length ?? '?'} repositories` : g.visibility }))]} />
              </StepField>
            )}
            <StepField label="Architecture"><span className="gm-static">{probe?.arch ?? 'unknown'} <span className="faint">detected on the machine</span></span></StepField>
            <StepField label="Environment"><span className="gm-static">{host ? hostText(host.host) : ''}{probe?.machine ? ` (${probe.machine})` : ''}</span></StepField>
          </div>
          <div className="gm-switch-field"><fieldset className="gm-switch-row"><Switch checked={service} onChange={setService} label="Install as a service" /><span>Install as a service that starts automatically</span></fieldset>
            <p className="gm-hint">{os === 'windows' ? 'A Windows service, installed with administrator approval.' : os === 'macos' ? 'A launchd agent for your user; it starts when you sign in.' : host?.host.kind === 'wsl' ? 'A systemd service inside the distribution (needs systemd enabled in WSL). It runs while the distribution runs; WSL does not start distributions with Windows.' : 'A systemd service, installed through sudo.'}</p></div>
          {service && os === 'linux' && <StepField label="Service user" hint={`The account the runner runs as. ${probe?.user && probe.user !== 'root' ? `Empty uses ${probe.user}.` : 'Required: the runner should not run as root.'}`}><input className="input gm-mono" aria-label="Service user" value={serviceUser} placeholder={probe?.user && probe.user !== 'root' ? probe.user : ''} onChange={e => setServiceUser(e.target.value)} spellCheck={false} /></StepField>}
          {service && os === 'windows' && (
            <div className="gm-grid">
              <StepField label="Service account" hint="Built-in accounts need no password. GitManager never asks for or stores a password; an account that needs one has to be configured by hand.">
                <Dropdown label="Service account" value={winAccount ?? 'network-service'} onChange={v => setWinAccount(v as InstallRequest['windowsAccount'])} options={[{ value: 'network-service', label: 'NETWORK SERVICE (GitHub default)' }, { value: 'local-service', label: 'LOCAL SERVICE' }, { value: 'local-system', label: 'LocalSystem' }, { value: 'custom', label: 'Another account' }]} />
              </StepField>
              {winAccount === 'custom' && <StepField label="Account"><input className="input gm-mono" aria-label="Windows account" value={winAccountName} placeholder="DOMAIN\\user" onChange={e => setWinAccountName(e.target.value)} spellCheck={false} /></StepField>}
            </div>
          )}
          <div className="gm-switch-field"><fieldset className="gm-switch-row" disabled={!service}><Switch checked={startAfter && service} onChange={setStartAfter} label="Start after registration" /><span>Start the runner after registration</span></fieldset></div>
          <button type="button" className="gm-disclose" aria-expanded={advanced} onClick={() => setAdvanced(a => !a)}><Icon name={advanced ? 'chevron-down' : 'chevron-right'} size={14} />Advanced</button>
          {advanced && (
            <div className="col" style={{ gap: 10 }}>
              <label className="row gm-check-row"><Checkbox checked={replace} onChange={setReplace} label="Replace an existing runner with the same name" /><span>Replace an existing runner with the same name (takes over its registration)</span></label>
              <label className="row gm-check-row"><Checkbox checked={ephemeral} onChange={setEphemeral} label="Ephemeral" /><span>Ephemeral: run one job, then unregister itself</span></label>
              <label className="row gm-check-row"><Checkbox checked={disableUpdate} onChange={setDisableUpdate} label="Turn off automatic updates" /><span>Turn off the runner's automatic self-update (GitHub requires runners to stay within 30 days of the latest version)</span></label>
            </div>
          )}
        </div>
      )}

      {step === 'review' && plan && (
        <div className="gm-plan">
          {plan.blockers.length > 0 && <ul className="gm-alerts" aria-label="Problems">{plan.blockers.map((b, i) => <li key={i} className="gm-alert warn"><Icon name="circle-alert" size={15} /><span>{b}</span></li>)}</ul>}
          <dl className="gm-props">
            <dt>Target</dt><dd>{hostText(plan.request.host)}{plan.target.machine ? ` (${plan.target.machine})` : ''}, {OS_TEXT[plan.target.os]} {plan.target.arch}{plan.target.user ? `, user ${plan.target.user}` : ''}</dd>
            <dt>Scope</dt><dd>{plan.request.scope.kind === 'repo' ? `${plan.request.scope.owner}/${plan.request.scope.repo}` : `${plan.request.scope.org} (organization)`}{plan.access.checked ? <span className="faint"> {plan.access.canRegister ? ', you can register runners' : plan.access.canRegister === false ? ', permission missing' : ', permission not confirmed'}</span> : null}</dd>
            <dt>Runner</dt><dd>{plan.request.name}{plan.request.labels.length ? <span className="gm-labels"> {plan.request.labels.map(l => <Tag key={l} icon="tag">{l}</Tag>)}</span> : <span className="faint"> default labels only</span>}{plan.request.runnerGroup ? `, group ${plan.request.runnerGroup}` : ''}</dd>
            <dt>Directory</dt><dd className="gm-mono-sm">{plan.request.directory}</dd>
            <dt>Package</dt><dd>{plan.pkg ? <>{plan.pkg.filename} <span className="faint">SHA-256 from GitHub's {plan.pkg.checksumSource === 'downloads-api' ? 'downloads API' : 'release notes'}</span></> : <span className="gm-warn">None</span>}</dd>
            <dt>Service</dt><dd>{plan.request.installService ? `${plan.serviceName ?? 'yes'}${plan.elevation.needed ? ' (needs administrator rights)' : ''}` : 'Not installed; start with run.sh or run.cmd'}</dd>
            {plan.elevation.how && <><dt>Elevation</dt><dd>{plan.elevation.how}</dd></>}
          </dl>
          <h3 className="gm-section-h">What will run</h3>
          <ul className="gm-trust-list">
            {plan.commands.map((c, i) => <li key={i}><div className="gm-trust-head"><strong>{c.title}</strong><span className="muted">{c.elevated ? 'as administrator' : ''}</span></div><code className="gm-code">{c.command}</code><div className="gm-trust-dir faint truncate">in {c.where}</div></li>)}
          </ul>
          {plan.warnings.length > 0 && <ul className="gm-notes">{plan.warnings.map((w, i) => <li key={i}><Icon name="info" size={13} /> {w}</li>)}</ul>}
          {plan.blockers.length > 0 && <p className="gm-branch-problem" role="status"><Icon name="circle-alert" size={15} />{plan.blockers.length === 1 ? 'One problem' : `${plan.blockers.length} problems`} listed at the top must be resolved before this runner can be installed. Go back to change the configuration.</p>}
          {plan.blockers.length === 0 && <label className="row gm-check-row gm-approve"><Checkbox checked={acknowledged} onChange={setAcknowledged} label="I reviewed the plan" /><span>I reviewed these commands and understand that this runner will execute code from {plan.request.scope.kind === 'repo' ? 'this repository' : 'the repositories its group allows'} on {plan.target.machine ?? 'the target machine'}.</span></label>}
        </div>
      )}

      {step === 'install' && job && (
        <div className="gm-plan">
          <ol className="gm-install-steps" aria-label="Installation progress">
            {job.steps.map(s => (
              <li key={s.id} className={`gm-istep ${s.state}`}>
                {s.state === 'running' ? <span className="sm-spinner" aria-hidden="true" /> : <Icon name={s.state === 'done' ? 'circle-check' : s.state === 'failed' ? 'circle-x' : s.state === 'skipped' ? 'circle-dashed' : 'circle'} size={15} />}
                <span className="grow"><span>{s.label}</span>{s.message && <span className="muted"> {s.message}</span>}</span>
              </li>
            ))}
          </ol>
          {job.state === 'failed' && job.error && (
            <div className="gm-notice warn" role="alert"><Icon name="circle-alert" size={16} /><div>
              <p>{job.error.message}</p>
              <ul className="gm-notes gm-recovery">{job.error.recovery.map((r, i) => <li key={i}>{r}</li>)}</ul>
            </div></div>
          )}
          {job.state === 'cancelled' && <p className="gm-branch-problem" role="status"><Icon name="info" size={15} />Cancelled. {job.log[job.log.length - 1]}</p>}
          {job.state === 'done' && <p className="gm-section-empty"><Icon name="circle-check" size={15} className="gm-stat-accent" /> Installed and verified: GitHub lists the runner{job.outcome.running ? ' and it is running' : ''}.</p>}
          <details className="gm-diag"><summary>Output <span className="faint">{job.log.length} lines, tokens redacted</span> <Button variant="ghost" className="gm-banner-btn" onClick={e => { e.preventDefault(); void copyText(job.log.join('\n')).then(ok => ok && toast.success('Output copied')) }}>Copy</Button></summary><pre className="gm-code gm-diag-text">{job.log.join('\n')}</pre></details>
        </div>
      )}
    </Dialog>
  )
}
