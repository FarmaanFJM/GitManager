import { useEffect, useState } from 'react'
import { Button, Icon, IconButton, MenuButton, Tag } from '../../../../third_party/summa-ui/src/ui'
import type { ToastApi } from '../../../../third_party/summa-ui/src/presets'
import type { Runner, RunnerAction, RunnerDiagnostics, RunsOnExample } from '../../../shared/runners'
import { api } from '../../api'
import { ENV_TEXT, OS_TEXT, StatusMark, copyText, dateTime, hostText, scopeKind, scopeText } from '../common'

const STARTUP_TEXT = { automatic: 'Starts automatically', manual: 'Manual start', disabled: 'Disabled', unknown: 'Startup unknown', 'not-applicable': '' }
const SERVICE_KIND = { systemd: 'systemd service', launchd: 'launchd agent', 'windows-service': 'Windows service', none: 'No service', unknown: 'Service state unknown' }

function Row({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }) {
  if (children === null || children === undefined || children === '') return null
  return <><dt>{label}</dt><dd className={mono ? 'gm-mono-sm' : ''}>{children}</dd></>
}

/** Everything known about one runner, GitHub facts and local observations kept apart, with the operations this GitManager can perform. */
export function RunnerDetail({ runner: r, busy, toast, onClose, onAction, stacked }: { runner: Runner; busy: RunnerAction | undefined; toast: ToastApi; onClose: () => void; onAction: (action: RunnerAction) => void; stacked: boolean }) {
  const [runsOn, setRunsOn] = useState<RunsOnExample | null>(null)
  const [diag, setDiag] = useState<RunnerDiagnostics | null | 'loading'>(null)
  useEffect(() => { setDiag(null); void api.runnersRunsOn(r.key).then(x => setRunsOn(x.ok ? x.value : null)) }, [r.key, r.github?.labels.length])
  const c = r.capabilities
  const g = r.github, l = r.local
  const copy = async (text: string, what: string) => { (await copyText(text)) ? toast.success(`${what} copied`) : toast.error(`Could not copy the ${what.toLowerCase()}`) }
  const loadDiag = async () => { setDiag('loading'); setDiag(await api.runnersDiagnostics(r.key)) }
  const openGitHub = () => { if (r.scope) void api.runnersOpen({ kind: 'runner-settings', scope: r.scope, runnerId: g?.id ?? null }) }
  const running = l && (l.service.state === 'running' || l.process.running === true)
  const act = (a: RunnerAction) => () => onAction(a)
  const title = (cap: { allowed: boolean; reason: string | null }) => cap.reason ?? undefined

  return (
    <aside className={`gm-bdetail gm-rdetail ${stacked ? 'stacked' : ''}`} aria-label={`Runner ${r.name}`}>
      <div className="gm-bdetail-head">
        {stacked && <Button variant="ghost" icon="arrow-left" onClick={onClose}>Runners</Button>}
        <h2 className="gm-h1 truncate">{r.name}</h2>
        <StatusMark status={r.status} />
        <span className="grow" />
        {busy && <span className="muted row"><span className="sm-spinner" aria-hidden="true" />{busy}</span>}
        {!busy && (running ? <Button variant="secondary" icon="stop" disabled={!c.stop.allowed} title={title(c.stop)} onClick={act('stop')}>Stop</Button>
          : <Button variant="secondary" icon="play" disabled={!c.start.allowed} title={title(c.start)} onClick={act('start')}>Start</Button>)}
        <MenuButton label="More runner actions" items={[
          { label: 'Restart', icon: 'refresh', disabled: !c.restart.allowed || !!busy, onSelect: act('restart') },
          { label: 'Inspect service state', icon: 'activity', disabled: !c.inspect.allowed || !!busy, onSelect: act('inspect') },
          { label: 'Check for updates', icon: 'download', disabled: !c.checkUpdate.allowed || !!busy, onSelect: act('check-update') },
          { label: 'Update runner', icon: 'upload', disabled: !c.update.allowed || !!busy, onSelect: act('update') },
          { type: 'sep' },
          { label: 'Open installation folder', icon: 'folder-open', disabled: !c.openFolder.allowed, onSelect: () => void api.runnersOpen({ kind: 'folder', key: r.key }).then(x => { if (!x.ok) toast.error(x.error.message) }) },
          { label: 'Copy installation path', icon: 'copy', disabled: !r.path, onSelect: () => void copy(r.path ?? '', 'Path') },
          { label: 'Runner settings on GitHub', icon: 'external', disabled: !r.scope, onSelect: openGitHub },
          { type: 'sep' },
          { label: g && !l ? 'Remove from GitHub' : 'Remove registration', icon: 'unlock', danger: true, disabled: !c.unregister.allowed || !!busy, onSelect: act('unregister') },
          { label: 'Uninstall', icon: 'trash', danger: true, disabled: !c.uninstall.allowed || !!busy, onSelect: act('uninstall') },
        ]} />
        {!stacked && <IconButton icon="x" size="sm" label="Close details" onClick={onClose} />}
      </div>
      <div className="gm-bdetail-body scroll">
        {r.attention.length > 0 && (
          <ul className="gm-alerts gm-rattention" aria-label="Needs attention">
            {r.attention.map((a, i) => <li key={i} className="gm-alert warn"><Icon name="triangle-alert" size={15} /><span>{a}</span></li>)}
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
            <p className="gm-section-empty gm-hint">{runsOn.note}</p>
            {r.scope?.kind === 'repo' && <p className="gm-section-empty"><button type="button" className="gm-linkbtn" onClick={() => void api.runnersOpen({ kind: 'workflows', scope: r.scope as never })}>Actions of {scopeText(r.scope)} on GitHub</button></p>}
          </section>
        )}
        {l && (
          <section className="gm-section" aria-label="Diagnostics">
            <h3 className="gm-section-h">Diagnostic logs {diag === null && <Button variant="ghost" className="gm-banner-btn" disabled={!c.logs.allowed} onClick={() => void loadDiag()}>Read</Button>}{diag && diag !== 'loading' && <Button variant="ghost" className="gm-banner-btn" onClick={() => void loadDiag()}>Read again</Button>}</h3>
            {diag === 'loading' && <p className="gm-section-empty muted row"><span className="sm-spinner" aria-hidden="true" /> Reading _diag</p>}
            {diag && diag !== 'loading' && (diag.error ? <p className="gm-section-empty gm-warn">{diag.error}</p> : diag.logs.length === 0 ? <p className="gm-section-empty muted">No log files in _diag yet.</p>
              : diag.logs.map(lg => (
                <details key={lg.file} className="gm-diag">
                  <summary><span className="gm-mono-sm">{lg.file}</span> <span className="faint">{lg.modifiedAt ? dateTime(lg.modifiedAt) : ''} {(lg.sizeBytes / 1024).toFixed(0)} KB</span></summary>
                  <pre className="gm-code gm-diag-text">{lg.tail.join('\n')}</pre>
                </details>
              )))}
          </section>
        )}
      </div>
    </aside>
  )
}
