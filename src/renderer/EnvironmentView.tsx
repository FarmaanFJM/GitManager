import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CopyButton, Details, Icon, IconButton, InlineAlert, SearchInput, SecretToggleAll, SecretValue, Tabs, useRevealAll } from '../../third_party/summa-ui/src/ui'
import type { ConfigFileEnv, EnvEntry, EnvSnapshot, ProcContext, ProcInfo } from '../shared/procs'
import { api } from './api'

/** What an environment panel shows. A service is resolved to its running process; a runner has its own read. */
export type EnvSource =
  | { kind: 'process'; key: string }
  | { kind: 'service'; profileId: string; serviceId: string; repoId: string }
  | { kind: 'runner'; key: string }

export type EnvToast = { success: (message: string) => unknown }

/* ---------------------------------------------------------------- pure helpers (unit tested) */

/** Service keys are `${profileId}:${serviceId}`; ids never contain a colon. */
export function parseServiceKey(key: string | undefined): { profileId: string; serviceId: string } | null {
  if (!key) return null
  const i = key.indexOf(':')
  if (i <= 0 || i === key.length - 1) return null
  return { profileId: key.slice(0, i), serviceId: key.slice(i + 1) }
}

/** The process a service launched: the one whose parent is not itself part of the service. */
export function pickServiceProcess(procs: ProcInfo[], serviceKey: string): ProcInfo | null {
  const mine = procs.filter(p => p.serviceKey === serviceKey)
  if (!mine.length) return null
  const pids = new Set(mine.map(p => p.pid))
  return mine.find(p => p.ppid === undefined || !pids.has(p.ppid)) ?? mine[0]
}

export function contextLabel(c: ProcContext, os?: 'windows' | 'mac' | 'linux'): string {
  if (c.kind === 'wsl') return `WSL ${c.distro}`
  return os === 'windows' ? 'Windows' : os === 'mac' ? 'macOS' : os === 'linux' ? 'Linux' : 'This computer'
}

export function sourceLabel(source: EnvSnapshot['source']): string {
  return source === 'runtime-launch' ? 'Captured at launch' : source === 'runtime-live' ? 'Read from the running process' : ''
}

export function formatTime(iso: string | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/** Compact metadata for the runtime view, in reading order. Empty parts are left out. */
export function runtimeMeta(s: EnvSnapshot, name: string | undefined, os?: 'windows' | 'mac' | 'linux'): string[] {
  return [name ? `${name} (PID ${s.pid})` : `PID ${s.pid}`, sourceLabel(s.source), formatTime(s.capturedAt), contextLabel(s.context, os)].filter(Boolean)
}

/** Case-insensitive search over names and, for non-sensitive entries, values. A sensitive value is never matched. */
export function filterEntries<T extends { name: string; value: string; sensitive: boolean }>(entries: T[], q: string): T[] {
  const n = q.trim().toLowerCase()
  if (!n) return entries
  return entries.filter(e => e.name.toLowerCase().includes(n) || (!e.sensitive && e.value.toLowerCase().includes(n)))
}

export function sortEntries<T extends { name: string }>(entries: T[]): T[] {
  return [...entries].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.name.localeCompare(b.name))
}

/** Each distinct note once, in order. */
export function uniqueNotes(files: { note: string }[]): string[] {
  return [...new Set(files.map(f => f.note).filter(Boolean))]
}

/* ---------------------------------------------------------------- data */

type Load<T> = { state: 'loading' } | { state: 'ready'; value: T } | { state: 'error'; message: string }
type RuntimeData = { snapshot: EnvSnapshot | null; reason: string | null; name?: string }
type FilesData = ConfigFileEnv[]

function useEnvData(source: EnvSource, tick: number) {
  const [runtime, setRuntime] = useState<Load<RuntimeData>>({ state: 'loading' })
  const [files, setFiles] = useState<Load<FilesData>>({ state: 'loading' })
  const seq = useRef(0)

  useEffect(() => {
    const n = ++seq.current
    const live = () => n === seq.current
    void (async () => {
      try {
        if (source.kind === 'runner') {
          const r = await api.runnersEnvironment(source.key)
          if (!live()) return
          if (!r.ok) { setRuntime({ state: 'error', message: r.error.message }); setFiles({ state: 'error', message: r.error.message }); return }
          setRuntime({ state: 'ready', value: { snapshot: r.value.runtime, reason: r.value.runtimeReason } })
          setFiles({ state: 'ready', value: r.value.files })
          return
        }
        if (source.kind === 'service') {
          const key = `${source.profileId}:${source.serviceId}`
          const [scan, f] = await Promise.all([api.procsScan(), api.configFiles({ profileId: source.profileId, serviceId: source.serviceId })])
          if (!live()) return
          setFiles(f.ok ? { state: 'ready', value: f.value } : { state: 'error', message: f.error.message })
          if (!scan.ok) { setRuntime({ state: 'error', message: scan.error.message }); return }
          const proc = pickServiceProcess(scan.value.processes, key)
          if (!proc) { setRuntime({ state: 'ready', value: { snapshot: null, reason: 'Not running' } }); return }
          const e = await api.procsEnv(proc.key)
          if (!live()) return
          setRuntime(e.ok ? { state: 'ready', value: { snapshot: e.value, reason: e.value.reason ?? null, name: proc.name } } : { state: 'error', message: e.error.message })
          return
        }
        // A process: read its environment, and look it up for its name and the files of its service or repository.
        const [e, scan] = await Promise.all([api.procsEnv(source.key), api.procsScan()])
        if (!live()) return
        const proc = scan.ok ? scan.value.processes.find(p => p.key === source.key) : undefined
        setRuntime(e.ok ? { state: 'ready', value: { snapshot: e.value, reason: e.value.reason ?? null, name: proc?.name } } : { state: 'error', message: e.error.message })
        const sk = parseServiceKey(proc?.serviceKey)
        const input = sk ?? (proc?.repoId ? { repoId: proc.repoId } : null)
        if (!input) { setFiles({ state: 'ready', value: [] }); return }
        const f = await api.configFiles(input)
        if (!live()) return
        setFiles(f.ok ? { state: 'ready', value: f.value } : { state: 'error', message: f.error.message })
      } catch (err) {
        if (!live()) return
        const message = err instanceof Error ? err.message : 'Failed'
        setRuntime({ state: 'error', message }); setFiles({ state: 'error', message })
      }
    })()
    return () => { seq.current++ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId(source), tick])

  return { runtime, files }
}

const sourceId = (s: EnvSource) => (s.kind === 'service' ? `service:${s.profileId}:${s.serviceId}` : `${s.kind}:${s.key}`)

/* ---------------------------------------------------------------- view */

type Tab = 'runtime' | 'files'

/**
 * Read-only environment of a process, a service or a runner. Two views that cannot be mixed up:
 * Runtime is what the process received; Files is what config files on disk say now. Nothing here edits anything.
 */
export function EnvironmentPanel({ source, toast }: { source: EnvSource; toast?: EnvToast }) {
  return <PanelInner key={sourceId(source)} source={source} toast={toast} />
}

function PanelInner({ source, toast }: { source: EnvSource; toast?: EnvToast }) {
  const [tab, setTab] = useState<Tab>('runtime')
  const [q, setQ] = useState('')
  const [tick, setTick] = useState(0)
  const { runtime, files } = useEnvData(source, tick)
  const copied = useCallback((ok: boolean) => { if (ok) toast?.success('Copied') }, [toast])
  const [os, setOs] = useState<'windows' | 'mac' | 'linux' | undefined>()
  useEffect(() => { void api.platform().then(p => setOs(p.os)).catch(() => undefined) }, [])

  const runtimeEntries = useMemo(() => (runtime.state === 'ready' && runtime.value.snapshot ? sortEntries(filterEntries(runtime.value.snapshot.entries, q)) : []), [runtime, q])
  const fileEntries = useMemo(() => (files.state === 'ready'
    ? files.value.map(f => ({ file: f, entries: filterEntries(f.entries, q) })).filter(x => !q.trim() || x.entries.length) : []), [files, q])

  const secretIds = useMemo(() => {
    if (tab === 'runtime') return runtimeEntries.filter(e => e.sensitive).map(e => e.name)
    return fileEntries.flatMap(x => x.entries.filter(e => e.sensitive).map(e => fileId(x.file, e)))
  }, [tab, runtimeEntries, fileEntries])
  const reveal = useRevealAll(secretIds)

  return (
    <div className="gm-env">
      <div className="gm-envbar">
        <Tabs label="Environment source" flat value={tab} onChange={t => { setTab(t); setQ('') }} items={[{ value: 'runtime', label: 'Runtime' }, { value: 'files', label: 'Files' }]} />
        <span className="grow" />
        {secretIds.length > 0 && <SecretToggleAll controls={reveal} />}
        <IconButton icon="refresh" size="sm" label="Reload" onClick={() => setTick(t => t + 1)} />
      </div>
      <div className="gm-envsearch">
        <SearchInput placeholder={tab === 'runtime' ? 'Search variables' : 'Search files'} aria-label={tab === 'runtime' ? 'Search variables' : 'Search files'} value={q} onChange={e => setQ(e.target.value)} />
      </div>

      {tab === 'runtime' ? (
        <section className="gm-envsec" aria-label="Runtime environment">
          <h3 className="gm-section-h">Received by the process</h3>
          {runtime.state === 'loading' ? <Loading />
            : runtime.state === 'error' ? <InlineAlert tone="error">{runtime.message}</InlineAlert>
              : !runtime.value.snapshot ? <p className="gm-envempty muted">{runtime.value.reason ?? 'Not available'}</p>
                : (
                  <>
                    <p className="gm-envmeta muted">{runtimeMeta(runtime.value.snapshot, runtime.value.name, os).join(' · ')}</p>
                    {runtime.value.snapshot.source === 'unavailable' && <InlineAlert tone="warn">{runtime.value.reason ?? 'Environment unavailable'}</InlineAlert>}
                    {runtime.value.snapshot.source !== 'unavailable' && (
                      runtimeEntries.length === 0
                        ? <p className="gm-envempty muted">{q.trim() ? 'No variables match' : 'No variables'}</p>
                        : (
                          <table className="gm-envtable" aria-label="Runtime variables">
                            <thead><tr><th scope="col">Variable</th><th scope="col">Value</th></tr></thead>
                            <tbody>
                              {runtimeEntries.map(e => (
                                <tr key={e.name}>
                                  <th scope="row" className="gm-mono gm-envname">{e.name}</th>
                                  <td><EnvValue entry={e} id={e.name} reveal={reveal} onCopied={copied} /></td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )
                    )}
                  </>
                )}
        </section>
      ) : (
        <section className="gm-envsec" aria-label="Config files">
          <h3 className="gm-section-h">Config files on disk</h3>
          {files.state === 'loading' ? <Loading />
            : files.state === 'error' ? <InlineAlert tone="error">{files.message}</InlineAlert>
              : files.value.length === 0 ? <p className="gm-envempty muted">No config files</p>
                : (
                  <>
                    {uniqueNotes(files.value).map(n => <InlineAlert key={n} tone="info">{n}</InlineAlert>)}
                    {fileEntries.length === 0 && <p className="gm-envempty muted">No files match</p>}
                    {fileEntries.map(({ file, entries }) => (
                      <div key={file.path} className="gm-envfile">
                        <div className="gm-envpath">
                          <Icon name="file-text" size={14} />
                          <span className="gm-mono gm-envpathtext">{file.path}</span>
                          <CopyButton value={file.path} label="Copy path" onCopied={copied} />
                        </div>
                        {entries.length === 0 ? <p className="gm-envempty muted">No variables</p> : (
                          <table className="gm-envtable gm-envtable-file" aria-label={`Variables in ${file.path}`}>
                            <thead><tr><th scope="col">Variable</th><th scope="col">Value</th><th scope="col" className="gm-envline">Line</th></tr></thead>
                            <tbody>
                              {entries.map(e => (
                                <tr key={`${e.line}:${e.name}`} data-overridden={e.overridden || undefined}>
                                  <th scope="row" className="gm-mono gm-envname">{e.name}</th>
                                  <td><EnvValue entry={e} id={fileId(file, e)} reveal={reveal} onCopied={copied} /></td>
                                  <td className="gm-envline num faint">{e.line}{e.overridden ? <span className="sr-only">, replaced by a later line</span> : null}{e.overridden ? <span aria-hidden="true"> replaced</span> : null}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                        {file.parseErrors.length > 0 && (
                          <Details label={`${file.parseErrors.length} parse ${file.parseErrors.length === 1 ? 'error' : 'errors'}`}>
                            <ul className="gm-envperr">{file.parseErrors.map((e, i) => <li key={i}><span className="faint">Line {e.line}</span> {e.message}</li>)}</ul>
                          </Details>
                        )}
                      </div>
                    ))}
                  </>
                )}
        </section>
      )}
    </div>
  )
}

const fileId = (f: ConfigFileEnv, e: { line: number; name: string }) => `${f.path}\u0000${e.line}\u0000${e.name}`

function Loading() {
  return <div className="gm-loading-line" aria-busy="true"><span className="sm-spinner" aria-hidden="true" /> Loading</div>
}

function EnvValue({ entry, id, reveal, onCopied }: {
  entry: Pick<EnvEntry, 'name' | 'value' | 'sensitive'>; id: string; reveal: ReturnType<typeof useRevealAll>; onCopied: (ok: boolean) => void
}) {
  if (entry.sensitive) {
    return <SecretValue value={entry.value} label={entry.name} revealed={reveal.isRevealed(id)} onRevealedChange={v => reveal.set(id, v)} />
  }
  return (
    <span className="gm-envval">
      <code className="gm-envcode">{entry.value}</code>
      {entry.value !== '' && <CopyButton value={entry.value} label={`Copy ${entry.name}`} onCopied={onCopied} className="gm-envcopy" />}
    </span>
  )
}
