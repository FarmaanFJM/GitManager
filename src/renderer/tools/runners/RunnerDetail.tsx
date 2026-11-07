import { useEffect, useState } from 'react'
import { Button, Details, Icon, IconButton, InlineAlert, MenuButton, StatusIndicator, Tag, Tooltip, type MenuEntry } from '../../../../third_party/summa-ui/src/ui'
import type { ToastApi } from '../../../../third_party/summa-ui/src/presets'
import type { ActionResult, Runner, RunnerAction, RunsOnExample } from '../../../shared/runners'
import { api } from '../../api'
import { EnvironmentPanel } from '../../EnvironmentView'
import { ENV_TEXT, OS_TEXT, copyText, dateTime, hostText, scopeKind, scopeText } from '../common'
import { githubUrl, headerParts, restartOutcome, splitAttention, terminalBlock } from './detailLogic'
import { RunnerDependencies } from './RunnerDependencies'
import { RunnerLogs } from './RunnerLogs'

const STARTUP_TEXT = { automatic: 'Starts automatically', manual: 'Manual start', disabled: 'Disabled', unknown: 'Startup unknown', 'not-applicable': '' }
const SERVICE_KIND = { systemd: 'systemd service', launchd: 'launchd agent', 'windows-service': 'Windows service', none: 'No service', unknown: 'Service state unknown' }

function Row({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }) {
  if (children === null || children === undefined || children === '') return null
  return <><dt>{label}</dt><dd className={mono ? 'gm-mono-sm' : ''}>{children}</dd></>
}


type View = 'logs' | 'environment' | 'dependencies'

/** One runner: name, a muted status line, the primary actions, and everything else behind Details or the More menu. */
export function RunnerDetail({ runner: r, busy, toast, onClose, onAction, stacked, onOpenTerminal, restartResult, onDismissResult }: {
  runner: Runner; busy: RunnerAction | undefined; toast: ToastApi; onClose: () => void; onAction: (action: RunnerAction | 'retire') => void; stacked: boolean
  /** Opens the runner's terminal. Omitted: the Terminal button is hidden. */
  onOpenTerminal?: () => void
  /** The outcome of the last Restart of this runner, shown concisely under the actions. */
  restartResult?: ActionResult | null
  onDismissResult?: () => void
}) {
  const [view, setView] = useState<View | null>(null)
  const [runsOn, setRunsOn] = useState<RunsOnExample | null>(null)
  useEffect(() => { setView(null) }, [r.key])
  useEffect(() => { void api.runnersRunsOn(r.key).then(x => setRunsOn(x.ok ? x.value : null)) }, [r.key, r.github?.labels.length])
  const c = r.capabilities
  const g = r.github, l = r.local
  const copy = async (text: string, what: string) => { (await copyText(text)) ? toast.success(`${what} copied`) : toast.error(`Could not copy the ${what.toLowerCase()}`) }
  const openGitHub = () => { if (r.scope) void api.runnersOpen({ kind: 'runner-settings', scope: r.scope, runnerId: g?.id ?? null }) }
  const running = !!l && (l.service.state === 'running' || l.process.running === true)
  const act = (a: RunnerAction | 'retire') => () => onAction(a)
  const head = headerParts(r)
  const termBlock = terminalBlock(r)
  const attention = splitAttention(r.attention)
  const extra = [...attention.rest, ...r.notices]
  const gh = githubUrl(r), svc = r.local?.gitHubUrl ?? null
  const toggle = (v: View) => () => setView(cur => (cur === v ? null : v))
  const restartDisabled = !c.restart.allowed || !!busy
  const outcome = restartResult ? restartOutcome(restartResult) : null
  const viewButton = (v: View, label: string) => <Button variant={view === v ? 'primary' : 'secondary'} aria-pressed={view === v} onClick={toggle(v)}>{label}</Button>
  const menu: MenuEntry[] = [
    running ? { label: 'Stop', icon: 'stop', disabled: !c.stop.allowed || !!busy, onSelect: act('stop') } : { label: 'Start', icon: 'play', disabled: !c.start.allowed || !!busy, onSelect: act('start') },
    { label: 'Inspect service state', icon: 'activity', disabled: !c.inspect.allowed || !!busy, onSelect: act('inspect') },
    { label: 'Check for updates', icon: 'download', disabled: !c.checkUpdate.allowed || !!busy, onSelect: act('check-update') },
    { label: 'Update runner', icon: 'upload', disabled: !c.update.allowed || !!busy, onSelect: act('update') },
    { type: 'sep' },
    { label: 'Open installation folder', icon: 'folder-open', disabled: !c.openFolder.allowed, onSelect: () => void api.runnersOpen({ kind: 'folder', key: r.key }).then(x => { if (!x.ok) toast.error(x.error.message) }) },
    { label: 'Copy installation path', icon: 'copy', disabled: !r.path, onSelect: () => void copy(r.path ?? '', 'Path') },
    { label: 'Copy runner name', icon: 'copy', onSelect: () => void copy(r.name, 'Name') },
    ...(svc ? [{ label: 'Copy service URL', icon: 'copy' as const, onSelect: () => void copy(svc, 'URL') }] : []),
    ...(gh ? [{ label: 'Copy GitHub URL', icon: 'copy' as const, onSelect: () => void copy(gh, 'URL') }] : []),
    { label: 'Runner settings on GitHub', icon: 'external', disabled: !r.scope, onSelect: openGitHub },
    { type: 'sep' },
    ...(l && !g ? [{ label: 'Retire installation', icon: 'archive' as const, disabled: !c.retire.allowed || !!busy, onSelect: act('retire') }] : []),
    { label: g && !l ? 'Remove from GitHub' : 'Remove registration', icon: 'unlock', danger: true, disabled: !c.unregister.allowed || !!busy, onSelect: act('unregister') },
    { label: 'Uninstall', icon: 'trash', danger: true, disabled: !c.uninstall.allowed || !!busy, onSelect: act('uninstall') },
  ]

  return (
    <aside className={`gm-bdetail gm-rdetail ${stacked ? 'stacked' : ''}`} aria-label={`Runner ${r.name}`}>
      <div className="gm-bdetail-head">
        {stacked && <Button variant="ghost" icon="arrow-left" onClick={onClose}>Runners</Button>}
        <div className="gm-rtitle">
          <h2 className="gm-h1 truncate">{r.name}</h2>
          <p className="gm-rsub muted">
            <span>{head.env}</span><span aria-hidden="true">·</span><StatusIndicator state={head.mark.state} label={head.mark.label} />
            {head.service && <><span aria-hidden="true">·</span><span>{head.service}</span></>}
          </p>
        </div>
        <span className="grow" />
        {busy && <span className="muted row"><span className="sm-spinner" aria-hidden="true" />{busy}</span>}
        <MenuButton label="More runner actions" items={menu} />
        {!stacked && <IconButton icon="x" size="sm" label="Close details" onClick={onClose} />}
      </div>
      <div className="gm-bdetail-body scroll">
        {attention.shown.map((a, i) => <InlineAlert key={i} tone="warn">{a}</InlineAlert>)}
        <div className="gm-ractions" role="toolbar" aria-label="Runner actions">
          {onOpenTerminal && (
            <Tooltip content={termBlock ?? ''} disabled={!termBlock}>
              <span className="gm-ractions-tip" tabIndex={termBlock ? 0 : undefined}><Button variant="secondary" icon="terminal" disabled={!!termBlock} onClick={onOpenTerminal}>Terminal</Button></span>
            </Tooltip>
          )}
          {viewButton('logs', 'Logs')}
          {viewButton('environment', 'Environment')}
          {viewButton('dependencies', 'Dependencies')}
          <Tooltip content={c.restart.reason ?? ''} disabled={!c.restart.reason || !restartDisabled}>
            <span className="gm-ractions-tip" tabIndex={restartDisabled ? 0 : undefined}><Button variant="secondary" icon="refresh" disabled={restartDisabled} onClick={act('restart')}>Restart</Button></span>
          </Tooltip>
        </div>
        {outcome && restartResult && (
          <div className="gm-rresult">
            <div className="row">
              {outcome.ok ? <StatusIndicator state="ready" label={outcome.label} /> : <InlineAlert tone="error">{outcome.label}</InlineAlert>}
              <span className="grow" />
              <IconButton icon="x" size="sm" label="Dismiss" onClick={() => onDismissResult?.()} />
            </div>
            {(restartResult.message || restartResult.detail || (restartResult.steps?.length ?? 0) > 0) && (
              <Details label="Details">
                {restartResult.message && <p>{restartResult.message}</p>}
                {restartResult.detail && <pre className="gm-banner-detail">{restartResult.detail}</pre>}
                {restartResult.steps && restartResult.steps.length > 0 && <ol className="gm-install-steps">{restartResult.steps.map((s, i) => <li key={i} className={`gm-istep ${s.state}`}><Icon name={s.state === 'done' ? 'circle-check' : s.state === 'failed' ? 'circle-x' : 'circle'} size={15} /><span className="grow">{s.label}{s.message ? <span className="muted"> {s.message}</span> : null}</span></li>)}</ol>}
              </Details>
            )}
          </div>
        )}
        {view === 'logs' && <RunnerLogs runner={r} />}
        {view === 'environment' && <EnvironmentPanel source={{ kind: 'runner', key: r.key }} toast={toast} />}
        {view === 'dependencies' && <RunnerDependencies runner={r} onOpenTerminal={termBlock ? undefined : onOpenTerminal} />}
        {view === null && (
          <Details label="Details" className="gm-rmore">
            {extra.length > 0 && (
              <ul className="gm-alerts gm-rnotices" aria-label="Notes">
                {extra.map((a, i) => <li key={i} className="gm-alert"><Icon name="info" size={15} /><span>{a}</span></li>)}
              </ul>
            )}
        <section className="gm-section" aria-label="Registration">
          <h3 className="gm-section-h">Registration <span className="muted">{g ? 'from GitHub' : l?.configured ? 'from the installation' : ''}</span></h3>
          <dl className="gm-props">
            <Row label="GitHub id">{g?.id ?? l?.agentId ?? <span className="faint">Unknown</span>}</Row>
            <Row label={scopeKind(r.scope) || 'Scope'}>{r.scope ? <button type="button" className="gm-linkbtn" onClick={() => void api.runnersOpen({ kind: 'scope', scope: r.scope! })}>{scopeText(r.scope)}</button> : <span className="faint">Unknown</span>}</Row>
            <Row label="GitHub status">{g ? <>{g.status}{g.busy ? ', running a job' : ''}<span className="faint"> (read {dateTime(g.fetchedAt)})</span></> : <span className="faint">Not read from GitHub</span>}</Row>
            <Row label="Runner group">{g?.scope.kind === 'org' ? g.runnerGroupName ?? (g.runnerGroupId ? `Group ${g.runnerGroupId}` : null) : l?.poolName && l.scope?.kind === 'org' ? l.poolName : null}</Row>
            <Row label="Ephemeral">{g?.ephemeral ?? l?.ephemeral ? 'Yes (one job, then removed)' : null}</Row>
            <Row label="Labels">{g
              ? <span className="gm-labels">{g.labels.map(x => <Tag key={x.name} className={x.type === 'custom' ? 'gm-label-custom' : ''} icon={x.type === 'custom' ? 'tag' : undefined}>{x.name}</Tag>)}{g.labels.some(x => x.type === 'custom') ? null : <span className="faint">default labels only</span>}</span>
              : <span className="faint">Known only from GitHub</span>}</Row>
            <Row label="Registration URL" mono>{r.scope ? `https://github.com/${scopeText(r.scope)}` : null}</Row>
          </dl>
        </section>
        <section className="gm-section" aria-label="Installation">
          <h3 className="gm-section-h">Installation <span className="muted">{l ? `observed ${dateTime(l.inspectedAt)}` : ''}</span></h3>
          {l ? (
            <dl className="gm-props">
              <Row label="Where">{hostText(l.host)}{l.machine ? ` (${l.machine})` : ''}</Row>
              <Row label="Environment">{ENV_TEXT[r.environment]}{l.host.kind === 'wsl' ? `, ${l.host.distro}` : ''}</Row>
              <Row label="System">{OS_TEXT[l.os]}{l.arch !== 'unknown' ? ` ${l.arch}` : ''}</Row>
              <Row label="Directory" mono><span className="row gm-path-row"><span className="truncate" title={l.path}>{l.path}</span><IconButton icon="copy" size="sm" label="Copy path" onClick={() => void copy(l.path, 'Path')} /></span></Row>
              <Row label="Version">{l.version ? <>{l.version}<span className="faint"> ({l.versionSource === 'listener' ? 'reported by the runner' : 'from a diagnostic log'})</span></> : <span className="faint">Unknown</span>}</Row>
              <Row label="Service">{SERVICE_KIND[l.service.kind]}{l.service.name ? <span className="gm-mono-sm"> {l.service.name}</span> : ''}</Row>
              <Row label="Service state">{l.service.kind === 'none' ? (l.process.running ? 'Runner process running (started by hand)' : 'No service, no runner process') : <>{l.service.state}{l.service.startup !== 'not-applicable' && l.service.startup !== 'unknown' ? `, ${STARTUP_TEXT[l.service.startup].toLowerCase()}` : ''}{l.service.detail ? <span className="faint"> ({l.service.detail})</span> : null}</>}</Row>
              <Row label="Process">{l.process.detail ?? (l.process.running === false ? 'No Runner.Listener from this folder' : null)}</Row>
              <Row label="Work folder" mono>{l.workFolder}</Row>
              <Row label="Self-update">{l.disableUpdate === null ? null : l.disableUpdate ? 'Turned off (--disableupdate)' : 'On (the runner updates itself)'}</Row>
              <Row label="Credentials">{l.configured ? (l.hasCredentials ? 'Present (never read by GitManager)' : <span className="gm-warn">Missing</span>) : null}</Row>
              {l.warnings.map((w, i) => <Row key={i} label="Note"><span className="gm-warn">{w}</span></Row>)}
            </dl>
          ) : (
            <p className="gm-section-empty muted">Not found on this computer, its WSL distributions or an allowed SSH host. GitHub lists it, so it runs elsewhere: only its GitHub state is shown, and nothing here can start or stop it.</p>
          )}
          {l?.host.kind === 'wsl' && l.service.kind === 'systemd' && <p className="gm-section-empty gm-hint">The service starts with the distribution, not with Windows. To have it run at boot, start the distribution at sign-in (for example a Task Scheduler entry that runs wsl.exe -d {l.host.distro}).</p>}
        </section>
        {runsOn && (
          <section className="gm-section" aria-label="Workflow usage">
            <h3 className="gm-section-h">Use in a workflow <IconButton icon="copy" size="sm" label="Copy runs-on" onClick={() => void copy(runsOn.yaml, 'runs-on')} /></h3>
            <pre className="gm-code gm-runs-on">{runsOn.yaml}</pre>
            <p className="gm-section-empty muted">{runsOn.note}</p>
            {r.scope?.kind === 'repo' && <p className="gm-section-empty"><button type="button" className="gm-linkbtn" onClick={() => void api.runnersOpen({ kind: 'workflows', scope: r.scope as never })}>Actions of {scopeText(r.scope)} on GitHub</button></p>}
          </section>
        )}
          </Details>
        )}
      </div>
    </aside>
  )
}
