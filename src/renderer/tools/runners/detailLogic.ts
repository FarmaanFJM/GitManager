// Pure rules of the runner detail (header text, status mapping, dependency table order), kept free of React and unit-tested.
import type { DependencyReport, DependencyResult, DependencyStatus } from '../../../shared/deps'
import type { ActionResult, Runner, RunnerStatus } from '../../../shared/runners'
import { OS_TEXT, STATUS_LABEL, machineText } from '../text'

export type MarkState = 'neutral' | 'running' | 'ready' | 'stopped' | 'failed' | 'warn'

/** Runner status as a StatusIndicator state: only online and busy are emerald, unknown is neutral (never presented as offline). */
export function runnerMark(status: RunnerStatus): { state: MarkState; label: string } {
  return { state: status === 'online' ? 'ready' : status === 'busy' ? 'running' : status === 'offline' ? 'stopped' : 'neutral', label: STATUS_LABEL[status] }
}

/** The environment as one short word group: the distribution for WSL, the system for a native install, the machine for a remote one. */
export function environmentText(r: Runner): string {
  if (r.environment === 'wsl') return r.distro ?? 'WSL2'
  if (r.environment === 'native') return OS_TEXT[r.platform]
  if (r.environment === 'remote') return machineText(r) || 'Remote'
  return 'Not inspected'
}

/** Only a local service that is known to be stopped is worth a word in the header. */
export function serviceNote(r: Runner): string | null {
  const s = r.local?.service
  return s && s.kind !== 'none' && s.state === 'stopped' ? 'Service stopped' : null
}

export function headerParts(r: Runner): { env: string; mark: { state: MarkState; label: string }; service: string | null } {
  return { env: environmentText(r), mark: runnerMark(r.status), service: serviceNote(r) }
}

/** The plain-text form of the header line, for the accessible name and tests. */
export function headerText(r: Runner): string {
  const p = headerParts(r)
  return [p.env, p.mark.label, p.service].filter(Boolean).join(' · ')
}

/** Why the terminal button is unavailable, or null when it can open. */
export function terminalBlock(r: Runner): string | null {
  if (!r.local) return 'Not installed on this computer'
  if (r.local.host.kind === 'ssh') return 'Not available for SSH hosts'
  return null
}

/** The most important problems stay visible, the rest go behind Details. */
export function splitAttention(items: string[], visible = 2): { shown: string[]; rest: string[] } {
  return { shown: items.slice(0, visible), rest: items.slice(visible) }
}

export const DEP_MARK: Record<DependencyStatus, { state: MarkState; label: string }> = {
  found: { state: 'ready', label: 'Found' },
  missing: { state: 'stopped', label: 'Missing' },
  error: { state: 'failed', label: 'Error' },
  unknown: { state: 'neutral', label: 'Unknown' },
}
/** Problems first, so a missing tool is never below the fold; found last. */
const DEP_ORDER: Record<DependencyStatus, number> = { error: 0, missing: 1, unknown: 2, found: 3 }

export function sortDependencies(list: DependencyResult[]): DependencyResult[] {
  return list.map((d, i) => ({ d, i })).sort((a, b) => DEP_ORDER[a.d.status] - DEP_ORDER[b.d.status] || a.i - b.i).map(x => x.d)
}

/** Main toolchains in the table, optional tools (make, gcc, curl, unzip) behind a disclosure. */
export function groupDependencies(report: Pick<DependencyReport, 'results'>): { main: DependencyResult[]; optional: DependencyResult[] } {
  return { main: sortDependencies(report.results.filter(d => !d.optional)), optional: sortDependencies(report.results.filter(d => d.optional)) }
}

/** A tool is only "installed" when the lookup found it; unknown and error never count. */
export const isInstalled = (d: DependencyResult) => d.status === 'found'
/** Missing or errored rows offer the terminal. */
export const needsTerminal = (d: DependencyResult) => d.status === 'missing' || d.status === 'error'

export function checkedAs(report: Pick<DependencyReport, 'user' | 'hostLabel'>): string {
  return report.user ? `Checked as ${report.user} in ${report.hostLabel}` : `Checked in ${report.hostLabel}`
}

/** The concise outcome of a restart. Success is claimed only when the action itself says ok. */
export function restartOutcome(res: ActionResult): { ok: boolean; label: string } {
  return res.ok === true ? { ok: true, label: 'Restarted' } : { ok: false, label: 'Restart failed' }
}

/** The GitHub page of the runner's scope, when it can be built from what is known. */
export function githubUrl(r: Runner): string | null {
  const s = r.scope
  if (!s) return null
  return s.kind === 'repo' ? `https://github.com/${s.owner}/${s.repo}` : `https://github.com/${s.org}`
}

/** The service URL the installation registered with, when known. */
export const serviceUrl = (r: Runner): string | null => r.local?.gitHubUrl ?? null
