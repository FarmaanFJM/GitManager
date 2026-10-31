import { useEffect, useRef, useState } from 'react'
import { Button, Dialog, DrawerToggle, Icon, MenuButton, Tabs, useMedia } from '../../../../third_party/summa-ui/src/ui'
import { useConfirm, useToast } from '../../../../third_party/summa-ui/src/presets'
import type { ActionOptions, ActionResult, Runner, RunnerAction, RunnersState } from '../../../shared/runners'
import type { OpError } from '../../../shared/types'
import { api } from '../../api'
import type { Actions, Model } from '../../App'
import { ErrorBanner } from '../../Workspace'
import { ago, plural } from '../../util'
import { useRunnersState } from '../common'
import { AddRunnerDialog } from './AddRunner'
import { DiscoveryTab } from './Discovery'
import { RunnerDetail } from './RunnerDetail'
import { RunnerTable } from './RunnerTable'
import { WorkflowsTab } from './Workflows'

type Tab = 'runners' | 'workflows' | 'discovery'

function Stat({ label, value, hint, accent }: { label: string; value: string | number; hint?: string; accent?: boolean }) {
  return <div className="gm-stat"><dt>{label}</dt><dd className={accent ? 'gm-stat-accent' : ''}>{value}</dd>{hint && <span className="gm-stat-hint">{hint}</span>}</div>
}

function AuthNotice({ st }: { st: RunnersState }) {
  const a = st.auth
  if (!a || a.state === 'ok') return null
  return (
    <div className="gm-notice" role="status">
      <Icon name="lock" size={16} />
      <div>
        <p>{a.state === 'no-gh' ? 'The GitHub CLI (gh) was not found, so GitHub cannot be read: only local installations are shown.' : a.state === 'unauthenticated' ? 'GitHub CLI is not signed in, so only local installations are shown.' : `GitHub could not be reached: ${a.message}`}</p>
        <p className="gm-hint">{a.state === 'no-gh' ? <>Install it from <span className="gm-mono">cli.github.com</span> and run <span className="gm-mono">gh auth login</span>.</> : a.state === 'unauthenticated' ? <>Run <span className="gm-mono">gh auth login</span> in a terminal. Registering runners needs repository administration or, for organizations, the admin:org scope. GitManager never asks for a token.</> : 'Check the connection and try again.'}</p>
      </div>
      <Button variant="secondary" onClick={() => void api.runnersAuth()}>Check again</Button>
    </div>
  )
}

/** The Runner Manager: inventory, details and operations for GitHub Actions self-hosted runners. */
export function RunnersView({ onBack }: { model: Model; actions: Actions; onBack: () => void }) {
  const { state: st } = useRunnersState()
  const [tab, setTab] = useState<Tab>('runners')
  const [selected, setSelected] = useState<string | null>(null)
  // The installation just made: selected as soon as the inventory lists it (the manager re-inspects the folder after the job reports done).
  const [pendingKey, setPendingKey] = useState<string | null>(null)
  const [add, setAdd] = useState(false)
  const [banner, setBanner] = useState<OpError | null>(null)
  const [result, setResult] = useState<ActionResult | null>(null)
  const confirm = useConfirm()
  const toast = useToast()
  const wide = useMedia('(min-width: 1180px)')
  const paneRef = useRef<HTMLDivElement>(null)
  const [stacked, setStacked] = useState(false)
  // The pane is remounted when the tab changes; observe the current element only and ignore the zero width of a removed one.
  useEffect(() => {
    const el = paneRef.current
    if (!el) return
    const measure = () => { if (el.clientWidth > 0) setStacked(el.clientWidth < 960) }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [st === null, tab])
  useEffect(() => { if (selected && st && !st.inventory.runners.some(r => r.key === selected)) setSelected(null) }, [st, selected])
  useEffect(() => {
    if (!pendingKey || !st) return
    const r = st.inventory.runners.find(x => x.local?.key === pendingKey)
    if (r) { setSelected(r.key); setPendingKey(null) }
  }, [st, pendingKey])

  if (!st) return <div className="gm-work"><header className="gm-top"><DrawerToggle /><h1 className="gm-h1">Runners</h1></header><div className="gm-loading-line"><span className="sm-spinner" aria-hidden="true" /> Loading</div></div>

  const inv = st.inventory
  const scanning = st.scan.running
  const scan = async (localOnly = false) => {
    const r = await api.runnersScan({ localOnly })
    if (!r.ok) setBanner({ code: r.error.code, message: r.error.message }); else setBanner(null)
  }
  const runner = inv.runners.find(r => r.key === selected) ?? null

  const act = async (r: Runner, action: RunnerAction) => {
    const opts: ActionOptions = {}
    const dir = r.path ?? ''
    if (r.github?.busy && ['stop', 'restart', 'update', 'unregister', 'uninstall'].includes(action)) {
      const yes = await confirm({ title: `${r.name} is running a job`, description: `GitHub reports this runner busy. ${action === 'stop' ? 'Stopping' : action === 'restart' ? 'Restarting' : action === 'update' ? 'Updating' : 'Removing'} it now interrupts and fails that job.`, confirmLabel: `${action[0].toUpperCase()}${action.slice(1)} anyway`, destructive: true })
      if (!yes) return
      opts.allowBusy = true
    }
    if (action === 'unregister') {
      const yes = await confirm({ title: r.local ? `Remove the registration of ${r.name}?` : `Remove ${r.name} from GitHub?`, description: r.local ? `The runner stops being listed for ${r.scope ? (r.scope.kind === 'repo' ? `${r.scope.owner}/${r.scope.repo}` : r.scope.org) : 'its scope'}; its service is removed and its files stay in ${dir}. Uninstall deletes them.` : `GitHub forgets this registration. The machine that runs it is not touched and its runner will fail to connect until it is removed or configured again there.`, confirmLabel: 'Remove registration', destructive: true })
      if (!yes) return
      opts.confirm = true
    }
    if (action === 'uninstall') {
      if (r.github && r.local?.configured) {
        const yes = await confirm({ title: `Uninstall ${r.name}?`, description: `Removes the registration from GitHub, the service, and then deletes exactly this directory and everything in it: ${dir}`, confirmLabel: 'Remove registration and delete files', destructive: true })
        if (!yes) return
        opts.unregisterFirst = true
      } else {
        const yes = await confirm({ title: `Delete ${r.name}'s files?`, description: `Deletes exactly this directory and everything in it: ${dir}${r.local?.service.kind !== 'none' ? ' The service is removed first.' : ''}`, confirmLabel: 'Delete files', destructive: true })
        if (!yes) return
      }
      opts.confirm = true
    }
    if (action === 'update') {
      const yes = await confirm({ title: `Update ${r.name}?`, description: `Replaces the runner program in ${dir} with the latest release (verified download), keeping its registration and work folder. The runner is stopped during the update${r.local?.disableUpdate ? '' : '. Normally the runner updates itself; use this only if it did not'}.`, confirmLabel: 'Update runner' })
      if (!yes) return
      opts.confirm = true
    }
    const res = await api.runnersAction(r.key, action, opts)
    if (!res.ok) { setBanner({ code: res.error.code, message: res.error.message, detail: res.error.detail }); return }
    setBanner(null)
    if (res.value.ok && ['start', 'stop', 'restart', 'inspect', 'check-update'].includes(action) && !res.value.updateAvailable) toast.success(res.value.message)
    else setResult(res.value)
  }

  return (
    <div className="gm-work">
      <header className="gm-top">
        <DrawerToggle />
        <Button variant="ghost" icon="arrow-left" onClick={onBack} className="gm-tools-back">Tools</Button>
        <div className="gm-title">
          <h1 className="gm-h1">Runners</h1>
          <span className="gm-path truncate">GitHub Actions self-hosted runners{st.auth?.state === 'ok' ? ` · ${st.auth.login}` : ''}</span>
        </div>
        <span className="grow" />
        {scanning && <span className="muted gm-scan-prog" role="status">{st.scan.phase === 'local' ? 'Looking' : st.scan.phase === 'github' ? 'Reading GitHub' : 'Scanning'}{st.scan.current ? ` · ${st.scan.current}` : ''}</span>}
        {scanning && <Button variant="ghost" onClick={() => void api.runnersCancel()}>Stop</Button>}
        <Button variant="secondary" onClick={() => void scan()} disabled={scanning} aria-busy={scanning || undefined}>
          {scanning ? <span className="sm-spinner" aria-hidden="true" /> : <Icon name="refresh" size={15} />}{inv.scannedAt ? 'Scan again' : 'Scan for runners'}
        </Button>
        <Button variant="primary" icon="plus" onClick={() => setAdd(true)} disabled={!!st.job && st.job.state === 'running' && !add}>Add runner</Button>
        <MenuButton label="More" items={[
          { label: 'Scan this computer only (no GitHub)', icon: 'search', disabled: scanning, onSelect: () => void scan(true) },
          { label: 'Refresh GitHub status', icon: 'refresh', disabled: scanning, onSelect: () => void api.runnersRefresh(true) },
          { type: 'sep' },
          { label: 'Adding self-hosted runners (GitHub Docs)', icon: 'external', onSelect: () => void api.runnersOpen({ kind: 'docs', page: 'add-runner' }) },
          { label: 'Security hardening for self-hosted runners', icon: 'shield', onSelect: () => void api.runnersOpen({ kind: 'docs', page: 'security' }) },
          { label: inv.latest ? `Runner releases (latest ${inv.latest.version})` : 'Runner releases', icon: 'external', onSelect: () => void api.runnersOpen({ kind: 'release', version: inv.latest?.version ?? null }) },
        ]} />
      </header>

      <AuthNotice st={st} />
      {banner && <ErrorBanner error={banner} onDismiss={() => setBanner(null)} />}
      {st.job?.state === 'running' && !add && <p className="gm-branch-problem gm-job-line" role="status"><span className="sm-spinner" aria-hidden="true" />Installing {st.job.request.name}: {st.job.steps.find(s => s.state === 'running')?.label ?? 'working'}<Button variant="ghost" className="gm-banner-btn" onClick={() => setAdd(true)}>Show</Button></p>}
      {st.scan.cancelled && !scanning && <p className="gm-branch-problem" role="status"><Icon name="info" size={15} />The last scan was stopped; results so far are shown.</p>}
      {inv.scannedAt && <p className="gm-branch-meta faint gm-scan-meta">Local installations read {ago(inv.localScannedAt)}{inv.githubScannedAt ? `, GitHub read ${ago(inv.githubScannedAt)}` : ', GitHub not read yet'}.</p>}

      <dl className="gm-stats gm-rstats">
        <Stat label="Runners" value={inv.summary.total} hint={inv.runners.filter(r => r.source === 'both').length ? `${inv.runners.filter(r => r.source === 'both').length} seen here and on GitHub` : inv.summary.total ? 'discovered' : undefined} />
        <Stat label="Online" value={inv.summary.online} accent={inv.summary.online > 0} hint={inv.githubScannedAt ? undefined : 'from GitHub, not read yet'} />
        <Stat label="Offline" value={inv.summary.offline} />
        <Stat label="Busy" value={inv.summary.busy} hint="running a job" />
        <Stat label="Manageable here" value={inv.summary.manageable} hint="start, stop, update" />
        <Stat label="Monitoring only" value={inv.summary.monitoringOnly} hint="listed by GitHub, elsewhere" />
      </dl>
      {inv.limitations.length > 0 && <p className="gm-branch-meta faint gm-scan-meta gm-limits" title={inv.limitations.join('\n')}>{inv.limitations[0]}{inv.limitations.length > 1 ? ` (and ${plural(inv.limitations.length - 1, 'more note')}; see Discovery)` : ''}</p>}

      <div className="gm-tabs-row">
        <Tabs label="Runners" value={tab} onChange={setTab} items={[{ value: 'runners', label: 'Runners' }, { value: 'workflows', label: 'Workflows' }, { value: 'discovery', label: 'Discovery' }]} />
      </div>

      {tab === 'runners' && (
        <div className="gm-branches gm-runners-pane" ref={paneRef}>
          {inv.runners.length === 0 && !scanning ? (
            <div className="sm-empty sm-empty--center gm-storage-empty grow">
              <p className="sm-empty__text">{inv.scannedAt ? 'No runners were found on this computer or in the GitHub scopes that could be read.' : 'Scan to find runner installations here and the runners GitHub lists for your repositories.'}</p>
              <div className="row">{!inv.scannedAt && <Button variant="primary" icon="search" onClick={() => void scan()}>Scan for runners</Button>}<Button variant={inv.scannedAt ? 'primary' : 'secondary'} icon="plus" onClick={() => setAdd(true)}>Add runner</Button></div>
            </div>
          ) : (
            <>
              {!(stacked && runner) && <RunnerTable inv={inv} selected={selected} busy={st.busy} onSelect={k => setSelected(k === selected && !stacked ? null : k)} onAction={(r, a) => void act(r, a)} />}
              {runner && <RunnerDetail runner={runner} busy={st.busy[runner.local?.key ?? runner.key]} toast={toast} onClose={() => setSelected(null)} onAction={a => void act(runner, a)} stacked={stacked || !wide} />}
            </>
          )}
          {inv.runners.length === 0 && scanning && <div className="gm-loading-line"><span className="sm-spinner" aria-hidden="true" /> Scanning</div>}
        </div>
      )}
      {tab === 'workflows' && <WorkflowsTab st={st} toast={toast} onOpenRunner={k => { setSelected(k); setTab('runners') }} />}
      {tab === 'discovery' && <DiscoveryTab st={st} toast={toast} />}

      <AddRunnerDialog open={add} st={st} toast={toast} onClose={() => setAdd(false)} onInstalled={k => setPendingKey(k)} />
      <Dialog open={!!result} onClose={() => setResult(null)} title={result?.ok ? 'Done' : 'Not completed'} width={560} footer={<Button variant="primary" data-autofocus onClick={() => setResult(null)}>Close</Button>}>
        {result && (
          <div className="gm-plan">
            <p>{result.message}</p>
            {result.detail && <pre className="gm-banner-detail">{result.detail}</pre>}
            {result.steps && result.steps.length > 0 && <ol className="gm-install-steps">{result.steps.map((s, i) => <li key={i} className={`gm-istep ${s.state}`}><Icon name={s.state === 'done' ? 'circle-check' : s.state === 'failed' ? 'circle-x' : 'circle'} size={15} /><span className="grow">{s.label}{s.message ? <span className="muted"> {s.message}</span> : null}</span></li>)}</ol>}
            {result.log && result.log.length > 0 && <details className="gm-diag"><summary>Output <span className="faint">{result.log.length} lines</span></summary><pre className="gm-code gm-diag-text">{result.log.join('\n')}</pre></details>}
          </div>
        )}
      </Dialog>
    </div>
  )
}
