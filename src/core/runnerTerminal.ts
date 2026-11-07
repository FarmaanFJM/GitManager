// A terminal opened from a runner row: in the runner's installation directory, on the runner's own host.
//
// The terminal never elevates and never impersonates: no sudo, no runas, no `wsl -u root`. For a WSL runner the shell is
// started `-u <account>` only for the ordinary account the runner service runs as (or, failing that, that owns the
// installation directory) because that is the account whose files and environment the runner uses; if that account is root or
// cannot be determined the terminal opens as the distribution's default user and says so.
//
// GitManager's runner inventory (LocalRunner) records the service kind and name but not the account it runs as. The caller
// supplies what it learned separately: the `User=` line of the systemd unit (parseSystemdUser), the owner of the directory
// (`stat -c %U`), or the Windows service's StartName.
import type { Location } from '../shared/types.js'
import type { LocalRunner, RunnerHost } from '../shared/runners.js'
import type { ShellOption, TerminalNote } from '../shared/terminal.js'
import { planShell, preferredShellFor, validDistroName, type PlanResult, type ShellPlan } from './shells.js'

export type RunnerTerminalInput = {
  host: RunnerHost
  /** In the host's own path syntax. */
  path: string
  service?: Pick<LocalRunner['service'], 'kind' | 'name'> | null
  /** Account the service runs as: systemd `User=` or the Windows service StartName. Null/undefined when not known. */
  serviceAccount?: string | null
  /** Owner of the installation directory on a Linux host, when known. */
  ownerAccount?: string | null
}

export type RunnerTerminalContext = {
  shells: ShellOption[]
  platform?: NodeJS.Platform
  /** The account the terminal will run as when no -u is passed: the Windows user, or the distribution's default user. */
  interactiveAccount?: string | null
  planDeps?: Parameters<typeof planShell>[0]['deps']
}

export type RunnerTerminalPlan =
  | { ok: true; shellPlan: ShellPlan; notes: TerminalNote[] }
  | { ok: false; reason: string; notes: TerminalNote[] }

/** `User=` from the [Service] section of a systemd unit. Null when absent or when it uses specifiers/variables that need systemd to resolve. */
export function parseSystemdUser(unit: string | null | undefined): string | null {
  if (!unit) return null
  let inService = false
  let user: string | null = null
  for (const raw of unit.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const sec = /^\[(.+)\]$/.exec(line)
    if (sec) { inService = sec[1] === 'Service'; continue }
    const m = inService ? /^User\s*=\s*(.*)$/.exec(line) : null
    if (m) user = m[1].trim() // the last assignment wins, as in systemd
  }
  if (!user || /[%$\s]/.test(user)) return null
  return user
}

const USER = /^[A-Za-z_][A-Za-z0-9._-]{0,63}$/
const isRoot = (u: string) => u === 'root'
/** The account name without a domain or machine prefix, lower-cased: DOMAIN\bob, .\bob and bob compare equal. */
const accountName = (a: string) => a.replace(/^.*\\/, '').toLowerCase()
/** Built-in Windows service identities that are not a person's account. */
const WINDOWS_BUILTIN = /^(nt authority\\|nt service\\)?(system|localsystem|local service|localservice|network service|networkservice)$/i

export function planRunnerTerminal(input: RunnerTerminalInput, ctx: RunnerTerminalContext): RunnerTerminalPlan {
  const platform = ctx.platform ?? process.platform
  const notes: TerminalNote[] = []
  const host = input.host

  if (host.kind === 'ssh') return { ok: false, reason: `A terminal on the SSH host ${host.host} is not supported yet. Use your SSH client for now.`, notes }

  if (host.kind === 'wsl') {
    if (platform !== 'win32') return { ok: false, reason: 'WSL runners can be opened from Windows only.', notes }
    if (!validDistroName(host.distro)) return { ok: false, reason: 'The WSL distribution name is invalid.', notes }
    if (!input.path.startsWith('/')) return { ok: false, reason: 'The runner path is not a Linux path.', notes }
    const shell = ctx.shells.find(s => s.kind === 'wsl' && s.available && s.distro?.toLowerCase() === host.distro.toLowerCase())
    if (!shell) return { ok: false, reason: `The WSL distribution ${host.distro} is not available.`, notes }

    const service = input.serviceAccount?.trim() || null
    const owner = input.ownerAccount?.trim() || null
    const usable = (u: string | null) => (u && USER.test(u) && !isRoot(u) ? u : null)
    const chosen = usable(service) ?? usable(owner)
    if (service && !USER.test(service)) notes.push({ code: 'ACCOUNT_UNKNOWN', message: `The service account "${service}" is not a plain user name, so GitManager cannot open the terminal as it.` })
    if (service && isRoot(service)) notes.push({ code: 'ACCOUNT_DIFFERS', message: 'The runner service runs as root. The terminal does not open as root and does not elevate; it opens as the distribution\'s own user. Use sudo yourself if you need to.' })
    if (usable(service) && usable(owner) && service !== owner) notes.push({ code: 'ACCOUNT_DIFFERS', message: `The service runs as ${service} but the installation directory is owned by ${owner}. The terminal opens as ${service}.` })
    if (!service && !owner) notes.push({ code: 'ACCOUNT_UNKNOWN', message: 'GitManager could not determine which account the runner uses. The terminal opens as the distribution\'s default user, which may differ from the service account.' })
    else if (!chosen && !notes.some(n => n.code === 'ACCOUNT_DIFFERS')) notes.push({ code: 'ACCOUNT_UNKNOWN', message: 'The runner account could not be used for the terminal. It opens as the distribution\'s default user.' })

    const plan = planShell({ shell, location: { kind: 'wsl', distro: host.distro, path: input.path }, wslUser: chosen, deps: ctx.planDeps })
    return fromPlan(plan, notes)
  }

  // Native host (this computer)
  const location: Location = { kind: 'native', path: input.path }
  const shell = preferredShellFor(location, null, ctx.shells, platform)
  if (!shell) return { ok: false, reason: 'No shell that can open the runner folder is available.', notes }
  const service = input.serviceAccount?.trim() || null
  const me = ctx.interactiveAccount?.trim() || null
  if (!service) {
    notes.push({ code: 'ACCOUNT_UNKNOWN', message: input.service && input.service.kind !== 'none' && input.service.kind !== 'unknown' ? 'GitManager could not read which account the runner service uses. The terminal runs as you.' : 'The runner is not installed as a service (or its account is unknown); it runs as whoever starts it. The terminal runs as you.' })
  } else if (!me) {
    notes.push({ code: 'ACCOUNT_UNKNOWN', message: `The runner service runs as ${service}; GitManager could not tell whether that is your account. The terminal runs as you and does not switch accounts.` })
  } else if (WINDOWS_BUILTIN.test(service) || accountName(service) !== accountName(me)) {
    notes.push({ code: 'ACCOUNT_DIFFERS', message: `The runner service runs as ${service}, the terminal as ${me}. Files, environment variables, credentials and tools can differ from what the runner sees. The terminal does not switch accounts.` })
  }
  return fromPlan(planShell({ shell, location, deps: ctx.planDeps }), notes)
}

function fromPlan(r: PlanResult, notes: TerminalNote[]): RunnerTerminalPlan {
  if (!r.ok) return { ok: false, reason: r.message, notes }
  return { ok: true, shellPlan: r.plan, notes }
}
