// Display text for runner facts (no React), shared by components and the table logic.
import type { Environment, Runner, RunnerHost, RunnerOs, RunnerScope, RunnerStatus } from '../../shared/runners'

export const STATUS_LABEL: Record<RunnerStatus, string> = { online: 'Online', offline: 'Offline', busy: 'Busy', unknown: 'Unknown' }
export const OS_TEXT: Record<RunnerOs, string> = { windows: 'Windows', linux: 'Linux', macos: 'macOS', unknown: 'Unknown' }
export const ENV_TEXT: Record<Environment, string> = { native: 'Native', wsl: 'WSL2', remote: 'Remote', unknown: 'Not inspected' }

export const scopeText = (s: RunnerScope | null) => (!s ? 'Unknown' : s.kind === 'repo' ? `${s.owner}/${s.repo}` : s.org)
export const scopeKind = (s: RunnerScope | null) => (!s ? '' : s.kind === 'repo' ? 'Repository' : 'Organization')
export const hostText = (h: RunnerHost) => (h.kind === 'native' ? 'This computer' : h.kind === 'wsl' ? `WSL: ${h.distro}` : `SSH: ${h.host}`)
export const machineText = (r: Runner) => r.machine ?? (r.environment === 'remote' && r.local?.host.kind === 'ssh' ? r.local.host.host : '')
