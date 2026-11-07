import type { ProcContext } from '../../src/shared/procs.js'
import type { EnvRead, ProcAdapter, RawProcess, SignalResult } from '../../src/core/procs/model.js'

export const raw = (p: Partial<RawProcess> & { pid: number; name: string }): RawProcess => ({ command: p.name, ports: [], ...p })
export const listen = (port: number, address = '0.0.0.0') => ({ port, protocol: 'tcp' as const, address, state: 'LISTEN' as const })

export class FakeAdapter implements ProcAdapter {
  scans = 0
  procs: RawProcess[]
  failWith: string | null = null
  delayMs = 0
  env: EnvRead = { ok: false, reason: 'n/a' }
  signals: { pid: number; mode: string }[] = []
  /** What happens to the process when a signal arrives. */
  onSignal: (pid: number, mode: 'graceful' | 'force', self: FakeAdapter) => SignalResult = () => ({ ok: true })
  constructor(readonly context: ProcContext, procs: RawProcess[] = [], readonly os: 'windows' | 'unix' = 'unix') { this.procs = procs }
  async scan() {
    this.scans++
    if (this.delayMs) await new Promise(r => setTimeout(r, this.delayMs))
    if (this.failWith) throw new Error(this.failWith)
    return this.procs.map(p => ({ ...p }))
  }
  async inspect(pid: number) { const p = this.procs.find(x => x.pid === pid); return p ? { ...p } : null }
  async liveEnv() { return this.env }
  async signal(pid: number, mode: 'graceful' | 'force') { this.signals.push({ pid, mode }); return this.onSignal(pid, mode, this) }
  remove(pid: number) { this.procs = this.procs.filter(p => p.pid !== pid) }
}
