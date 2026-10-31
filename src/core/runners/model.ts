// Pure logic of the Runners tool: identities, scope parsing, reconciliation of local installations with GitHub records,
// capabilities, summaries and the runs-on example. No I/O, so every rule here is tested directly.
import type {
  Capability, Environment, GitHubRunner, LocalRunner, Runner, RunnerArch, RunnerCapabilities, RunnerHost, RunnerOs, RunnerScope, RunnerStatus, RunnerSummary, RunsOnExample,
} from '../../shared/runners.js'
import { locationKey, normalizePath } from '../paths.js'

/* ------------------------------------------------------------ scopes */

const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/

export const validOwner = (s: unknown): s is string => typeof s === 'string' && NAME.test(s) && !/^\.+$/.test(s)
export const validRepoFull = (s: unknown): s is string => typeof s === 'string' && /^[^/]+\/[^/]+$/.test(s) && s.split('/').every(validOwner)

export function scopeKey(s: RunnerScope): string {
  return s.kind === 'repo' ? `repo:${s.owner.toLowerCase()}/${s.repo.toLowerCase()}` : `org:${s.org.toLowerCase()}`
}
export const sameScope = (a: RunnerScope | null, b: RunnerScope | null) => !!a && !!b && scopeKey(a) === scopeKey(b)
export const scopeLabel = (s: RunnerScope) => (s.kind === 'repo' ? `${s.owner}/${s.repo}` : s.org)
export const scopeUrl = (s: RunnerScope) => (s.kind === 'repo' ? `https://github.com/${s.owner}/${s.repo}` : `https://github.com/${s.org}`)
export const scopeApiBase = (s: RunnerScope) => (s.kind === 'repo' ? `/repos/${encodeURIComponent(s.owner)}/${encodeURIComponent(s.repo)}` : `/orgs/${encodeURIComponent(s.org)}`)
export function scopeSettingsUrl(s: RunnerScope, runnerId: number | null = null): string {
  const base = s.kind === 'repo' ? `https://github.com/${s.owner}/${s.repo}/settings/actions/runners` : `https://github.com/organizations/${s.org}/settings/actions/runners`
  return runnerId ? `${base}/${runnerId}` : base
}

/** The scope a runner's .runner file points at (gitHubUrl). Only github.com URLs are understood; anything else is null. */
export function scopeFromUrl(url: string | null | undefined): RunnerScope | null {
  if (!url) return null
  let u: URL
  try { u = new URL(url.trim()) } catch { return null }
  if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== 'github.com') return null
  const parts = u.pathname.split('/').filter(Boolean)
  if (parts.length === 1 && validOwner(parts[0])) return { kind: 'org', org: parts[0] }
  if (parts.length === 2 && validOwner(parts[0]) && validOwner(parts[1].replace(/\.git$/, ''))) return { kind: 'repo', owner: parts[0], repo: parts[1].replace(/\.git$/, '') }
  return null
}

/** owner/repo from a Git remote URL (https or ssh forms) on github.com, or null. */
export function repoFromRemote(remote: string): string | null {
  const m = /github\.com[:/]([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/i.exec(remote.trim())
  return m && validOwner(m[1]) && validOwner(m[2]) ? `${m[1]}/${m[2]}` : null
}

export function parseScope(raw: unknown): RunnerScope | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (o.kind === 'repo' && validOwner(o.owner) && validOwner(o.repo)) return { kind: 'repo', owner: o.owner, repo: o.repo }
  if (o.kind === 'org' && validOwner(o.org)) return { kind: 'org', org: o.org }
  return null
}

/* ------------------------------------------------------------ hosts and keys */

export const hostKey = (h: RunnerHost) => (h.kind === 'native' ? 'native' : h.kind === 'wsl' ? `wsl:${h.distro.toLowerCase()}` : `ssh:${h.host.toLowerCase()}`)
export const sameHost = (a: RunnerHost, b: RunnerHost) => hostKey(a) === hostKey(b)

export function hostLabel(h: RunnerHost, hostOs: RunnerOs | 'windows' | 'mac' | 'linux' = 'unknown'): string {
  if (h.kind === 'wsl') return `WSL (${h.distro})`
  if (h.kind === 'ssh') return `SSH: ${h.host}`
  return hostOs === 'windows' ? 'This computer (Windows)' : hostOs === 'mac' || hostOs === 'macos' ? 'This computer (macOS)' : hostOs === 'linux' ? 'This computer (Linux)' : 'This computer'
}

export const environmentOf = (h: RunnerHost): Environment => (h.kind === 'native' ? 'native' : h.kind === 'wsl' ? 'wsl' : 'remote')

/**
 * One identity for an installation however its path was written: Windows paths case-insensitively, \\wsl.localhost\<distro>\x
 * as the WSL path /x in that distribution, and a remote path by host alias.
 */
export function installKey(host: RunnerHost, path: string): string {
  if (host.kind === 'ssh') return `ssh:${host.host.toLowerCase()}:${normalizePath(path, 'posix')}`
  if (host.kind === 'wsl') return locationKey({ kind: 'wsl', distro: host.distro, path })
  return locationKey({ kind: 'native', path })
}

export const githubKey = (g: Pick<GitHubRunner, 'id' | 'scope'>) => `gh:${scopeKey(g.scope)}#${g.id}`

/* ------------------------------------------------------------ platform words */

export function osFromGitHub(os: string | null | undefined): RunnerOs {
  const s = (os ?? '').toLowerCase()
  if (s.includes('windows')) return 'windows'
  if (s.includes('linux')) return 'linux'
  if (s.includes('mac') || s.includes('darwin')) return 'macos'
  return 'unknown'
}

export function osFromUname(s: string): RunnerOs {
  const t = s.toLowerCase()
  if (t.startsWith('linux')) return 'linux'
  if (t.startsWith('darwin')) return 'macos'
  if (/mingw|msys|cygwin|windows/.test(t)) return 'windows'
  return 'unknown'
}

export function archFromMachine(s: string): RunnerArch {
  const t = s.trim().toLowerCase()
  if (['x86_64', 'amd64', 'x64'].includes(t)) return 'x64'
  if (['aarch64', 'arm64', 'arm64e'].includes(t)) return 'arm64'
  if (/^armv[67]l?$|^arm$/.test(t)) return 'arm'
  return 'unknown'
}

export const archFromNode = (a: string): RunnerArch => (a === 'x64' ? 'x64' : a === 'arm64' ? 'arm64' : a === 'arm' ? 'arm' : 'unknown')

export const OS_LABEL: Record<RunnerOs, string> = { windows: 'Windows', linux: 'Linux', macos: 'macOS', unknown: 'Unknown' }
export const ARCH_LABEL: Record<RunnerArch, string> = { x64: 'x64', arm64: 'ARM64', arm: 'ARM', unknown: 'Unknown' }

/** GitHub's default (read-only) labels for a platform, in GitHub's spelling. */
export function defaultLabels(os: RunnerOs, arch: RunnerArch): string[] {
  const o = os === 'windows' ? 'Windows' : os === 'linux' ? 'Linux' : os === 'macos' ? 'macOS' : null
  const a = arch === 'x64' ? 'X64' : arch === 'arm64' ? 'ARM64' : arch === 'arm' ? 'ARM' : null
  return ['self-hosted', ...(o ? [o] : []), ...(a ? [a] : [])]
}

/* ------------------------------------------------------------ versions */

/** Compares runner versions such as 2.319.1; returns <0, 0, >0. Unknown or malformed versions compare as oldest. */
export function compareVersions(a: string | null, b: string | null): number {
  const p = (v: string | null) => (v ?? '').replace(/^v/, '').split('.').map(x => parseInt(x, 10)).map(n => (Number.isFinite(n) ? n : -1))
  const x = p(a), y = p(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d) return d }
  return 0
}

export const validVersion = (v: unknown): v is string => typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v)

/* ------------------------------------------------------------ validation of user input */

export const validRunnerName = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(s)
export const validLabel = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,99}$/.test(s)
export const validGroupName = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,99}$/.test(s) && !s.endsWith(' ')
export const validUserName = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z_][A-Za-z0-9._-]{0,63}$/.test(s)
export const validWindowsAccount = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9 ._$-]+(?:\\[A-Za-z0-9 ._$-]+)?$/.test(s) && s.length <= 128

/** Characters that no installation path may contain: they would need quoting in some shell, and no real path needs them. */
const PATH_FORBIDDEN = /[\x00-\x1f"'`$&|<>^%!;*?]/ // eslint-disable-line no-control-regex

export type PathCheck = { ok: true; path: string } | { ok: false; message: string }

/** An absolute installation directory in the host's syntax, with no dot segments, forbidden characters or system roots. */
export function checkInstallDirectory(os: RunnerOs, raw: unknown): PathCheck {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, message: 'Enter an installation directory.' }
  const p = raw.trim()
  if (PATH_FORBIDDEN.test(p)) return { ok: false, message: 'The directory contains characters that are not allowed in an installation path.' }
  if (p.split(/[\\/]/).some(seg => seg === '..' || seg === '.')) return { ok: false, message: 'The directory must not contain . or .. segments.' }
  if (os === 'windows') {
    if (!/^[A-Za-z]:[\\/]/.test(p)) return { ok: false, message: 'Use an absolute Windows path, for example C:\\actions-runner.' }
    const n = normalizePath(p, 'win32')
    if (/^[A-Za-z]:\\?$/.test(n)) return { ok: false, message: 'A drive root cannot be the installation directory. Use a folder such as C:\\actions-runner.' }
    if (/^[A-Za-z]:\\(windows|program files|program files \(x86\)|programdata|users)(\\|$)/i.test(n) && !/^[A-Za-z]:\\users\\[^\\]+\\[^\\]+/i.test(n)) return { ok: false, message: 'System folders cannot hold a runner. Use a folder such as C:\\actions-runner.' }
    return { ok: true, path: n }
  }
  if (!p.startsWith('/')) return { ok: false, message: 'Use an absolute path, for example /home/you/actions-runner.' }
  const n = normalizePath(p, 'posix')
  if (n === '/' || /^\/(bin|boot|dev|etc|lib|lib64|proc|run|sbin|sys|usr|var|System|Library|Applications|private|tmp)(\/|$)/.test(n) && !/^\/(var\/lib|usr\/local)\/[^/]+/.test(n)) return { ok: false, message: 'System folders cannot hold a runner. Use a folder such as /opt/actions-runner or one in your home folder.' }
  if (n.startsWith('/mnt/') && /^\/mnt\/[a-z](\/|$)/.test(n)) return { ok: false, message: 'A Windows drive seen from WSL is not a good place for a Linux runner (file permissions and performance). Use a path on the Linux file system, such as /home/you/actions-runner.' }
  return { ok: true, path: n }
}

/** The service name the runner will create, as predicted from GitHub's naming (actions.runner.<scope>.<name>). */
export function predictedServiceName(scope: RunnerScope, name: string, os: RunnerOs): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '-')
  const scopePart = scope.kind === 'repo' ? `${clean(scope.owner)}-${clean(scope.repo)}` : clean(scope.org)
  let base = `actions.runner.${scopePart}.${clean(name)}`
  // The runner shortens very long names; the exact rule lives in the runner, so a long prediction is marked approximate.
  if (base.length > 80) base = base.slice(0, 80)
  return os === 'linux' ? `${base}.service` : base
}

/* ------------------------------------------------------------ reconciliation */

export const githubStatus = (g: GitHubRunner | null): RunnerStatus => (!g ? 'unknown' : g.busy ? 'busy' : g.status === 'online' ? 'online' : g.status === 'offline' ? 'offline' : 'unknown')

const no = (reason: string): Capability => ({ allowed: false, reason })
const yes: Capability = { allowed: true, reason: null }

export type CapabilityContext = { hostReachable: boolean }

/** Which operations GitManager can perform for a row, each with the reason when it cannot. Only positively identified services and processes are ever managed. */
export function capabilitiesFor(local: LocalRunner | null, github: GitHubRunner | null, ctx: CapabilityContext = { hostReachable: true }): RunnerCapabilities {
  if (!local) {
    const r = github ? 'Not found on a machine GitManager can reach. GitHub shows this runner, but its files and service are elsewhere.' : 'No local installation.'
    return {
      start: no(r), stop: no(r), restart: no(r), inspect: no(r), openFolder: no(r), logs: no(r), checkUpdate: no('The installed version is unknown without access to the machine.'), update: no(r),
      unregister: github ? yes : no(r), uninstall: no(r),
    }
  }
  if (!ctx.hostReachable) {
    const r = local.host.kind === 'ssh' ? `The SSH host ${local.host.host} did not answer.` : local.host.kind === 'wsl' ? `The WSL distribution ${local.host.distro} could not be reached.` : 'The installation could not be reached.'
    return { start: no(r), stop: no(r), restart: no(r), inspect: no(r), openFolder: no(r), logs: no(r), checkUpdate: no(r), update: no(r), unregister: github ? yes : no(r), uninstall: no(r) }
  }
  const svc = local.service
  const hasService = svc.kind === 'systemd' || svc.kind === 'launchd' || svc.kind === 'windows-service'
  const running = svc.state === 'running' || local.process.running === true
  const busy = github?.busy === true
  const start = !local.configured ? no('Not registered yet: configure the runner first.')
    : !hasService ? no('Not installed as a service. Start it with run.sh (or run.cmd) in a terminal, or install the service.')
      : svc.state === 'running' ? no('Already running.') : yes
  const stop = !running ? no('Not running.') : !hasService && !local.process.pids.length ? no('No service and no identified process to stop.') : yes
  const restart = !hasService ? no('Not installed as a service.') : yes
  const update = !local.configured ? no('Not registered yet.') : local.version === null ? no('The installed version could not be read.') : yes
  const uninstall = github && local.configured ? { allowed: true, reason: 'Still registered on GitHub: the registration must be removed first, or the runner stays listed as offline.' } : yes
  const busyNote = busy ? ' GitHub reports this runner is running a job.' : ''
  return {
    start, stop: stop.allowed && busy ? { allowed: true, reason: `Stopping interrupts the job.${busyNote}` } : stop,
    restart: restart.allowed && busy ? { allowed: true, reason: `Restarting interrupts the job.${busyNote}` } : restart,
    inspect: yes, openFolder: local.host.kind === 'ssh' ? no('The folder is on a remote machine.') : yes, logs: yes,
    checkUpdate: local.version === null ? no('The installed version could not be read.') : yes, update,
    unregister: local.configured || github ? yes : no('Not registered.'), uninstall: local.host.kind === 'ssh' && !local.configured ? uninstall : uninstall,
  }
}

const platformOf = (local: LocalRunner | null, github: GitHubRunner | null): RunnerOs => (local && local.os !== 'unknown' ? local.os : github ? osFromGitHub(github.os) : local?.os ?? 'unknown')

export type ReconcileOptions = { latestVersion?: string | null; githubFetched?: (scope: RunnerScope) => boolean; hostReachable?: (host: RunnerHost) => boolean }

/**
 * Pairs local installations with GitHub records by registration scope and GitHub's runner id (from .runner); an
 * installation without an id is paired only by name inside the same scope, never across scopes or by name alone.
 * Everything unpaired becomes its own row, so a runner on another machine stays visible and a leftover folder is reported.
 */
export function reconcile(locals: LocalRunner[], githubs: GitHubRunner[], opts: ReconcileOptions = {}): Runner[] {
  const unpaired = new Map(githubs.map(g => [githubKey(g), g]))
  const rows: Runner[] = []
  const reachable = opts.hostReachable ?? (() => true)
  const byScopeName = new Map<string, GitHubRunner[]>()
  for (const g of githubs) { const k = `${scopeKey(g.scope)}|${g.name.toLowerCase()}`; byScopeName.set(k, [...(byScopeName.get(k) ?? []), g]) }

  for (const l of locals) {
    let g: GitHubRunner | null = null
    const warnings = [...l.warnings]
    if (l.scope && l.agentId !== null) {
      const k = githubKey({ id: l.agentId, scope: l.scope })
      g = unpaired.get(k) ?? null
      if (g) unpaired.delete(k)
    } else if (l.scope && l.agentName) {
      const c = (byScopeName.get(`${scopeKey(l.scope)}|${l.agentName.toLowerCase()}`) ?? []).filter(x => unpaired.has(githubKey(x)))
      if (c.length === 1) { g = c[0]; unpaired.delete(githubKey(g)); warnings.push('Matched to the GitHub record by name within the same scope (the installation has no runner id).') }
    }
    rows.push(makeRow(l, g, warnings, opts, reachable(l.host)))
  }
  for (const g of unpaired.values()) rows.push(makeRow(null, g, [], opts, true))
  return rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) || a.key.localeCompare(b.key))
}

function makeRow(local: LocalRunner | null, github: GitHubRunner | null, warnings: string[], opts: ReconcileOptions, hostReachable: boolean): Runner {
  const caps = capabilitiesFor(local, github, { hostReachable })
  const attention = [...warnings]
  const platform = platformOf(local, github)
  const version = local?.version ?? null
  if (local) {
    if (local.partial) attention.push('Installation files without a registration: a setup that was not completed, or a download that was never configured.')
    if (github) {
      if (github.status === 'offline' && (local.service.state === 'running' || local.process.running)) attention.push('The local service is running but GitHub reports the runner offline. Check its connectivity and the diagnostic logs.')
      if (github.status === 'online' && local.service.state === 'stopped' && local.process.running === false) attention.push('GitHub reports the runner online, but no local service or runner process was found for this installation.')
      if (local.agentName && github.name !== local.agentName) attention.push(`Registered as ${local.agentName} locally, listed as ${github.name} on GitHub.`)
    } else if (local.configured && local.scope && opts.githubFetched?.(local.scope)) {
      attention.push(`Not found among the runners of ${scopeLabel(local.scope)} on GitHub: the registration may have been removed. The files and service are still here.`)
    }
    if (version && opts.latestVersion && compareVersions(version, opts.latestVersion) < 0) attention.push(`Version ${version} installed, ${opts.latestVersion} is the latest release.${local.disableUpdate ? ' Automatic updates are turned off for this runner.' : ' The runner updates itself unless automatic updates were turned off.'}`)
    if (local.service.kind === 'none' && local.configured) attention.push('Not installed as a service: it runs only while someone starts it.')
    if (local.host.kind === 'wsl' && local.service.kind === 'systemd') attention.push(`Runs inside WSL (${local.host.distro}). The service starts with the distribution, and WSL does not start distributions when Windows boots.`)
  }
  const manageable = (['start', 'stop', 'restart', 'update', 'uninstall'] as const).some(k => caps[k].allowed) && !!local && hostReachable
  return {
    key: github ? githubKey(github) : `local:${local!.key}`,
    name: github?.name ?? local?.agentName ?? baseNameOf(local!.path),
    status: githubStatus(github),
    platform,
    environment: local ? environmentOf(local.host) : 'unknown',
    machine: local?.machine ?? null,
    distro: local?.host.kind === 'wsl' ? local.host.distro : null,
    scope: github?.scope ?? local?.scope ?? null,
    path: local?.path ?? null,
    version,
    github, local,
    source: github && local ? 'both' : github ? 'github' : 'local',
    attention, capabilities: caps, manageable,
  }
}

export const baseNameOf = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p

export function summarize(runners: Runner[]): RunnerSummary {
  return {
    total: runners.length,
    online: runners.filter(r => r.status === 'online' || r.status === 'busy').length,
    offline: runners.filter(r => r.status === 'offline').length,
    busy: runners.filter(r => r.status === 'busy').length,
    manageable: runners.filter(r => r.manageable).length,
    monitoringOnly: runners.filter(r => !r.manageable && r.github).length,
    attention: runners.filter(r => r.attention.length > 0).length,
  }
}

/* ------------------------------------------------------------ workflow integration */

/** A correct runs-on example for a runner from the labels GitHub confirmed (or the defaults a local installation implies). */
export function runsOnExample(r: Runner, group: string | null = null): RunsOnExample {
  let defaults: string[], custom: string[], note: string
  if (r.github) {
    defaults = r.github.labels.filter(l => l.type === 'read-only').map(l => l.name)
    custom = r.github.labels.filter(l => l.type === 'custom').map(l => l.name)
    note = custom.length ? 'Default labels select the platform; the custom labels pin the job to runners that carry them.' : 'Only default labels: any self-hosted runner of this platform in the scope can take the job.'
  } else {
    defaults = defaultLabels(r.platform, r.local?.arch ?? 'unknown')
    custom = []
    note = 'Labels as GitHub would assign them for this platform. Custom labels are known only after reading the registration from GitHub.'
  }
  const labels = [...defaults, ...custom]
  const list = `[${labels.join(', ')}]`
  const g = group ?? (r.github?.runnerGroupName && r.github.scope.kind === 'org' && r.github.runnerGroupName !== 'Default' ? r.github.runnerGroupName : null)
  const yaml = g ? `runs-on:\n  group: ${g}\n  labels: ${list}` : `runs-on: ${list}`
  const scopeNote = r.scope?.kind === 'org' ? ' An organization runner takes jobs only from repositories its runner group allows; matching labels alone do not grant access.' : ''
  return { yaml, defaultLabels: defaults, customLabels: custom, group: g, note: note + scopeNote }
}
