import type { PortBinding, ProcContext } from '../../shared/procs.js'

export const contextKey = (c: ProcContext) => (c.kind === 'native' ? 'native' : `wsl:${c.distro.toLowerCase()}`)
export const procKey = (c: ProcContext, pid: number) => `${contextKey(c)}:${pid}`
export const sameContext = (a: ProcContext, b: ProcContext) => contextKey(a) === contextKey(b)

/** A process as an adapter reports it, before ownership and repository association. */
export type RawProcess = {
  pid: number
  ppid?: number
  name: string
  command: string | null
  exe?: string
  cwd?: string
  user?: string
  startedAt?: string
  state?: string
  ports: PortBinding[]
}

export type EnvRead =
  | { ok: true; entries: { name: string; value: string }[]; note: string }
  | { ok: false; reason: string }

export type SignalResult = { ok: boolean; permission?: boolean; message?: string }

/**
 * Everything platform specific. The inspector, control and env modules only talk to this interface, so the UI gets
 * uniform data whatever the operating system.
 */
export interface ProcAdapter {
  readonly context: ProcContext
  readonly os: 'windows' | 'unix'
  /** All processes the adapter can see, with the listening sockets attached. */
  scan(): Promise<RawProcess[]>
  /** One process, or null when it does not exist (used to re-verify identity before stopping). */
  inspect(pid: number): Promise<RawProcess | null>
  /** The live environment of the process, when the OS allows it. */
  liveEnv(pid: number): Promise<EnvRead>
  /** Asks (graceful) or forces the process to end. Only that process; never elevates. */
  signal(pid: number, mode: 'graceful' | 'force'): Promise<SignalResult>
}

export const DEFAULT_SCAN_TIMEOUT_MS = 30_000

export function parseAddressPort(s: string): { address: string; port: number } | null {
  const i = s.lastIndexOf(':')
  if (i < 0) return null
  const port = Number(s.slice(i + 1))
  if (!Number.isInteger(port) || port < 0 || port > 65535) return null
  const address = s.slice(0, i).replace(/^\[|\]$/g, '')
  return { address: address || '*', port }
}
