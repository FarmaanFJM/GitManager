import { useCallback, useEffect, useState } from 'react'
import { Button, Details, IconButton, InlineAlert, StatusIndicator } from '../../../../third_party/summa-ui/src/ui'
import type { DependencyReport, DependencyResult } from '../../../shared/deps'
import type { Runner } from '../../../shared/runners'
import { api } from '../../api'
import { DEP_MARK, checkedAs, groupDependencies, needsTerminal } from './detailLogic'

function Row({ d, onTerminal }: { d: DependencyResult; onTerminal?: () => void }) {
  const m = DEP_MARK[d.status]
  return (
    <div role="row" className="gm-dep-row">
      <span role="cell" className="gm-dep-tool">
        <span className="truncate">{d.label}</span>
        <StatusIndicator state={m.state} label={m.label} />
      </span>
      <span role="cell" className="gm-mono-sm">{d.version ?? ''}</span>
      <span role="cell" className="gm-mono-sm truncate" title={d.path ?? undefined}>{d.path ?? ''}</span>
      <span role="cell" className="muted truncate">{d.verifiedIn.label}</span>
      <span role="cell" className="gm-dep-act">{needsTerminal(d) && onTerminal && <Button variant="ghost" onClick={onTerminal}>Terminal</Button>}</span>
      {d.detail && d.status !== 'found' && <span className="gm-dep-detail faint">{d.detail}</span>}
    </div>
  )
}

function Table({ rows, onTerminal, label }: { rows: DependencyResult[]; onTerminal?: () => void; label: string }) {
  return (
    <div role="table" aria-label={label} className="gm-deps">
      <div role="row" className="gm-dep-row gm-dep-head">
        <span role="columnheader">Tool</span><span role="columnheader">Version</span><span role="columnheader">Path</span><span role="columnheader">Verified in</span><span role="columnheader" className="sr-only">Actions</span>
      </div>
      {rows.map(d => <Row key={d.id} d={d} onTerminal={onTerminal} />)}
    </div>
  )
}

/** What the runner's own environment has: read-only checks inside that environment. GitManager never installs anything; a missing tool offers the terminal. */
export function RunnerDependencies({ runner: r, onOpenTerminal }: { runner: Runner; onOpenTerminal?: () => void }) {
  const [report, setReport] = useState<DependencyReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const load = useCallback(async (refresh: boolean) => {
    setLoading(true)
    const res = await api.runnersDependencies(r.key, refresh)
    if (res.ok) { setReport(res.value); setError(null) } else setError(res.error.message)
    setLoading(false)
  }, [r.key])
  useEffect(() => { setReport(null); void load(false) }, [load])
  const groups = report ? groupDependencies(report) : null
  return (
    <div className="gm-rdeps">
      <div className="gm-rlogs-bar">
        {loading && <span className="muted row"><span className="sm-spinner" aria-hidden="true" />Checking</span>}
        <span className="grow" />
        <IconButton icon="refresh" size="sm" label="Refresh dependencies" disabled={loading} onClick={() => void load(true)} />
      </div>
      {error && <InlineAlert tone="error">{error}</InlineAlert>}
      {groups && <Table rows={groups.main} onTerminal={onOpenTerminal} label="Dependencies" />}
      {groups && groups.optional.length > 0 && <Details label={`Optional tools (${groups.optional.length})`}><Table rows={groups.optional} onTerminal={onOpenTerminal} label="Optional tools" /></Details>}
      {report && (report.runnerEnvNote || report.user || report.hostLabel) && (
        <Details label="Details">
          <p className="muted">{checkedAs(report)}</p>
          {report.runnerEnvNote && <p className="muted">{report.runnerEnvNote}</p>}
        </Details>
      )}
    </div>
  )
}
