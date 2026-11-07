import { useCallback, useEffect, useState } from 'react'
import { Dropdown, IconButton, InlineAlert, LogViewer, Tabs } from '../../../../third_party/summa-ui/src/ui'
import type { Runner, RunnerDiagnostics } from '../../../shared/runners'
import { api } from '../../api'
import { dateTime } from '../common'

/** The newest diagnostic log files of a runner (service and listener output, redacted by the backend) in the shared log viewer. */
export function RunnerLogs({ runner: r }: { runner: Runner }) {
  const [diag, setDiag] = useState<RunnerDiagnostics | null | 'loading'>('loading')
  const [file, setFile] = useState<string | null>(null)
  const allowed = r.capabilities.logs.allowed
  const load = useCallback(async () => {
    if (!allowed) { setDiag(null); return }
    setDiag('loading')
    const d = await api.runnersDiagnostics(r.key)
    setDiag(d)
    setFile(f => (f && d.logs.some(l => l.file === f) ? f : d.logs[0]?.file ?? null))
  }, [r.key, allowed])
  useEffect(() => { void load() }, [load])

  if (!allowed) return <InlineAlert tone="info">{r.capabilities.logs.reason ?? 'Logs are not available for this runner'}</InlineAlert>
  const logs = diag && diag !== 'loading' ? diag.logs : []
  const current = logs.find(l => l.file === file) ?? logs[0]
  return (
    <div className="gm-rlogs">
      <div className="gm-rlogs-bar">
        {logs.length > 1 && logs.length <= 4
          ? <Tabs label="Log files" flat value={current?.file ?? ''} onChange={setFile} items={logs.map(l => ({ value: l.file, label: l.file }))} />
          : logs.length > 4
            ? <Dropdown label="Log file" quiet width={360} value={current?.file ?? null} options={logs.map(l => ({ value: l.file, label: l.file, meta: l.modifiedAt ? dateTime(l.modifiedAt) : undefined }))} onChange={setFile} />
            : <span className="gm-mono-sm muted truncate">{current?.file ?? ''}</span>}
        <span className="grow" />
        {diag === 'loading' && <span className="sm-spinner" aria-hidden="true" />}
        <IconButton icon="refresh" size="sm" label="Refresh logs" disabled={diag === 'loading'} onClick={() => void load()} />
      </div>
      {diag && diag !== 'loading' && diag.error && <InlineAlert tone="error">{diag.error}</InlineAlert>}
      {diag && diag !== 'loading' && !diag.error && logs.length === 0
        ? <InlineAlert tone="info">No log files yet</InlineAlert>
        : <LogViewer label={current?.file ?? 'Runner log'} lines={current?.tail ?? []} searchable height={320} emptyLabel={diag === 'loading' ? 'Reading' : 'Empty'} />}
    </div>
  )
}
