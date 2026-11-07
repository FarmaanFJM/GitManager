// Stopping processes. Managed processes go through the owner of the service (ServiceManager, via a callback).
// External processes are only stopped with an explicit confirmation, after re-checking that the PID still belongs to
// the process that was shown to the person (PID reuse), with a graceful request first and a forced one after the grace
// period. Never elevates, never signals more than the one process, and only reports success once it is really gone.
import type { ProcContext, ProcInfo, StopResult } from '../../shared/procs.js'
import type { ProcAdapter, RawProcess } from './model.js'

export const PERMISSION_MESSAGE = 'Access denied. Run GitManager as the process owner or stop it from its own terminal.'

export type StopOptions = {
  /** Time to wait after the graceful request before forcing. Default 5000 ms. */
  graceMs?: number
  /** Must be exactly true to stop a process GitManager did not start. */
  confirmExternal?: boolean
  /** Finds the adapter of the process's context (the inspector's adapterFor). */
  adapterFor: (context: ProcContext) => ProcAdapter | undefined
  /** Stops a GitManager-managed process through its service (the lead wires ServiceManager.stop here). */
  stopManaged?: (info: ProcInfo) => Promise<{ ok: boolean; message?: string }>
  pollMs?: number
  forceWaitMs?: number
  sleep?: (ms: number) => Promise<void>
}

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** Is `cur` still the process that `info` describes? Name, start time and command line must agree where both are known. */
export function sameIdentity(info: ProcInfo, cur: RawProcess): boolean {
  if (cur.pid !== info.pid || !sameName(info.name, cur.name)) return false
  if (info.startedAt && cur.startedAt && Math.abs(Date.parse(info.startedAt) - Date.parse(cur.startedAt)) > 2000) return false
  if (info.command !== null && cur.command !== null && info.command !== cur.command) return false
  if (!info.startedAt && !cur.startedAt && info.ppid !== undefined && cur.ppid !== undefined && info.ppid !== cur.ppid) return false
  return true
}

type Status = 'same' | 'gone' | 'changed'

async function status(adapter: ProcAdapter, info: ProcInfo): Promise<Status> {
  const cur = await adapter.inspect(info.pid)
  if (!cur) return 'gone'
  if (!sameIdentity(info, cur)) return 'changed'
  if (cur.state === 'Z') return 'gone' // zombie: exited, waiting for its parent
  return 'same'
}

async function waitGone(adapter: ProcAdapter, info: ProcInfo, ms: number, pollMs: number, sleep: (ms: number) => Promise<void>): Promise<boolean> {
  const until = Date.now() + ms
  for (;;) {
    if ((await status(adapter, info)) !== 'same') return true // gone, or the PID now belongs to something else
    if (Date.now() >= until) return false
    await sleep(Math.min(pollMs, Math.max(10, until - Date.now())))
  }
}

export async function stopProcess(info: ProcInfo, opts: StopOptions): Promise<StopResult> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const pollMs = opts.pollMs ?? 150
  const graceMs = opts.graceMs ?? 5000
  const adapter = opts.adapterFor(info.context)

  if (!info.canStop) return { ok: false, code: 'DENIED', message: info.stopDeniedReason ?? 'This process cannot be stopped from GitManager.' }

  if (info.owner === 'gitmanager') {
    if (!opts.stopManaged) return { ok: false, code: 'UNSUPPORTED', message: 'Stopping managed services is not available here.' }
    let r: { ok: boolean; message?: string }
    try { r = await opts.stopManaged(info) } catch (e) { return { ok: false, code: 'FAILED', message: (e as Error).message } }
    if (!r.ok) return { ok: false, code: 'FAILED', message: r.message ?? 'The service could not be stopped.' }
    if (adapter) {
      try { if (!(await waitGone(adapter, info, opts.forceWaitMs ?? 3000, pollMs, sleep))) return { ok: false, code: 'STILL_RUNNING', message: 'The service was asked to stop but the process is still running.' } } catch { /* cannot verify; the service manager reported success */ }
    }
    return { ok: true, message: r.message ?? 'Stopped.' }
  }

  if (opts.confirmExternal !== true) return { ok: false, code: 'CONFIRM_REQUIRED', message: 'This process was not started by GitManager. Confirm to stop it.' }
  if (!adapter) return { ok: false, code: 'UNSUPPORTED', message: 'This environment is not available.' }

  try {
    const before = await status(adapter, info)
    if (before === 'gone') return { ok: true, message: 'The process had already exited.', alreadyGone: true }
    if (before === 'changed') return { ok: false, code: 'CHANGED', message: 'This process id now belongs to a different process. Refresh the list and check again.' }

    const soft = await adapter.signal(info.pid, 'graceful')
    if (soft.permission) return { ok: false, code: 'PERMISSION', message: PERMISSION_MESSAGE }
    if (await waitGone(adapter, info, graceMs, pollMs, sleep)) return { ok: true, message: 'Stopped.' }

    // Still the same process after the grace period: force it.
    const hard = await adapter.signal(info.pid, 'force')
    if (hard.permission) return { ok: false, code: 'PERMISSION', message: PERMISSION_MESSAGE }
    if (await waitGone(adapter, info, opts.forceWaitMs ?? 3000, pollMs, sleep)) return { ok: true, message: 'Stopped (forced).' }
    return hard.ok === false && hard.message
      ? { ok: false, code: 'FAILED', message: hard.message }
      : { ok: false, code: 'STILL_RUNNING', message: 'The process is still running after it was asked to stop.' }
  } catch (e) {
    return { ok: false, code: 'FAILED', message: (e as Error).message }
  }
}
