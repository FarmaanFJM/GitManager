import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '../../../third_party/summa-ui/src/ui'
import type { RunnerStatus, RunnersState } from '../../shared/runners'
import { STATUS_LABEL } from './text'
import { api } from '../api'

/** The Runners tool's state, kept current by the main process's events; GitHub is re-read on focus and on a timer, rate-limited there. */
export function useRunnersState() {
  const [state, setState] = useState<RunnersState | null>(null)
  const reload = useCallback(async () => { setState(await api.runnersState()) }, [])
  const minutes = state?.config.settings.refreshMinutes ?? 0
  const ready = !!state
  useEffect(() => {
    void reload().then(() => api.runnersAuth()).then(() => reload())
    const offChanged = api.on('runners-changed', () => { void reload() })
    const offStatus = api.on('runners-status', p => setState(s => (s ? { ...s, ...p } : s)))
    return () => { offChanged(); offStatus() }
  }, [reload])
  useEffect(() => {
    if (!ready) return
    const onFocus = () => { void api.runnersRefresh(false) }
    window.addEventListener('focus', onFocus)
    const timer = minutes > 0 ? window.setInterval(() => { void api.runnersRefresh(false) }, minutes * 60_000) : 0
    return () => { window.removeEventListener('focus', onFocus); if (timer) window.clearInterval(timer) }
  }, [ready, minutes])
  return { state, reload }
}

export { STATUS_LABEL, OS_TEXT, ENV_TEXT, scopeText, scopeKind, hostText, machineText } from './text'

/** State mark and word, so state never depends on colour alone. Emerald only for a runner that is online (meaningful state). */
export function StatusMark({ status, busyWord = true }: { status: RunnerStatus; busyWord?: boolean }) {
  const cls = status === 'online' || status === 'busy' ? 'gm-dot-ready' : status === 'offline' ? 'gm-dot-stopped' : 'gm-dot-unknown'
  return (
    <span className="gm-status">
      {status === 'busy' ? <Icon name="activity" size={13} className="gm-busy-icon" aria-hidden="true" /> : <span className={`gm-dot ${cls}`} aria-hidden="true" />}
      <span>{busyWord || status !== 'busy' ? STATUS_LABEL[status] : 'Online'}</span>
    </span>
  )
}

/** Copies text, reporting through the given callback (the toast or an inline note). */
export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true } catch { return false }
}

export const dateTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '')

/** Keeps the latest value of a prop in a ref, for callbacks registered once. */
export function useLatest<T>(v: T) { const r = useRef(v); r.current = v; return r }
