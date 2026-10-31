// Installing a runner: the plan (every check and the exact commands, before anything runs) and the executor (each step
// recorded, cancellable between steps, nothing deleted or overwritten on failure). Registration tokens live only in
// memory for the duration of the configure step and are redacted from every line of output.
import { createHash, randomBytes } from 'node:crypto'
import { createWriteStream, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, rm, stat } from 'node:fs/promises'
import { get as httpsGet } from 'node:https'
import path from 'node:path'
import type { CommandPreview, GitHubRunner, InstallJob, InstallOutcome, InstallPlan, InstallRequest, InstallStepId, LocalRunner, PackageInfo, RunnerHost, RunnerOs } from '../../shared/runners.js'
import { GhError } from '../storage/gh.js'
import { inspectOne } from './discovery.js'
import { RunnerGitHub, packageFor, trustedDownloadUrl } from './github.js'
import { probeHost, type HostShell } from './hosts.js'
import { checkInstallDirectory, installKey, predictedServiceName, sameHost, sameScope, scopeLabel, scopeUrl, validGroupName, validLabel, validRunnerName, validUserName, validWindowsAccount } from './model.js'
import { redact, redactArgs } from './redact.js'

export const STEP_LABELS: Record<InstallStepId, string> = {
  environment: 'Checking environment', github: 'Checking GitHub access', download: 'Downloading runner', verify: 'Verifying download', extract: 'Extracting files',
  configure: 'Configuring runner', register: 'Registering with GitHub', service: 'Installing service', start: 'Starting service', 'verify-registration': 'Verifying registration', 'verify-service': 'Verifying service',
}
export const STEP_ORDER: InstallStepId[] = ['environment', 'github', 'download', 'verify', 'extract', 'configure', 'register', 'service', 'start', 'verify-registration', 'verify-service']

export type InstallDeps = {
  shellFor: (host: RunnerHost) => HostShell
  github: RunnerGitHub
  tmpDir: string
  existing: () => LocalRunner[]
  githubRunners: () => GitHubRunner[]
  now?: () => number
  download?: Downloader
  /** Seconds to wait for the runner to appear online after registration. */
  onlineWaitMs?: number
  sleep?: (ms: number) => Promise<void>
}

export type Downloader = (url: string, dest: string, opts: { signal: { cancelled: boolean }; maxBytes: number }) => Promise<{ ok: true; sha256: string; bytes: number } | { ok: false; message: string }>

const WINDOWS_ACCOUNTS: Record<string, string> = { 'network-service': 'NT AUTHORITY\\NETWORK SERVICE', 'local-service': 'NT AUTHORITY\\LOCAL SERVICE', 'local-system': 'LocalSystem' }

/* ------------------------------------------------------------ request validation */

export function validateRequest(raw: unknown): { ok: true; request: InstallRequest } | { ok: false; message: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, message: 'Invalid request.' }
  const r = raw as Record<string, unknown>
  const host = r.host as RunnerHost
  if (!host || typeof host !== 'object' || !['native', 'wsl', 'ssh'].includes((host as { kind: string }).kind)) return { ok: false, message: 'Choose where the runner is installed.' }
  if (host.kind === 'wsl' && !/^[A-Za-z0-9._-]{1,64}$/.test(host.distro)) return { ok: false, message: 'Invalid WSL distribution.' }
  if (host.kind === 'ssh' && !/^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/.test(host.host)) return { ok: false, message: 'Invalid SSH host.' }
  const scope = r.scope as InstallRequest['scope']
  const scopeOk = scope && typeof scope === 'object' && ((scope.kind === 'repo' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(scope.owner) && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(scope.repo)) || (scope.kind === 'org' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(scope.org)))
  if (!scopeOk) return { ok: false, message: 'Choose a repository or an organization.' }
  if (!validRunnerName(r.name)) return { ok: false, message: 'The runner name may use letters, digits, dots, dashes and underscores (up to 64 characters).' }
  if (typeof r.directory !== 'string' || !r.directory.trim()) return { ok: false, message: 'Enter an installation directory.' }
  const labels = Array.isArray(r.labels) ? r.labels : []
  if (labels.length > 50 || !labels.every(validLabel)) return { ok: false, message: 'Labels may use letters, digits, dots, dashes, underscores, colons, slashes and plus signs; no spaces or commas.' }
  if (r.runnerGroup != null && r.runnerGroup !== '' && !validGroupName(r.runnerGroup)) return { ok: false, message: 'Invalid runner group name.' }
  if (r.serviceUser != null && r.serviceUser !== '' && !validUserName(r.serviceUser)) return { ok: false, message: 'Invalid service user name.' }
  const acct = r.windowsAccount == null ? null : r.windowsAccount
  if (acct !== null && !['network-service', 'local-service', 'local-system', 'custom'].includes(acct as string)) return { ok: false, message: 'Invalid Windows service account.' }
  if (acct === 'custom' && !validWindowsAccount(r.windowsAccountName)) return { ok: false, message: 'Enter the Windows account as DOMAIN\\user or user.' }
  const work = typeof r.workFolder === 'string' && r.workFolder.trim() ? r.workFolder.trim() : '_work'
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/.test(work)) return { ok: false, message: 'The work folder must be a simple folder name such as _work.' }
  const dedupe = [...new Set((labels as string[]).map(l => l.trim()).filter(Boolean))].filter(l => !['self-hosted', 'linux', 'windows', 'macos', 'x64', 'arm64', 'arm'].includes(l.toLowerCase()))
  return {
    ok: true,
    request: {
      host: host.kind === 'native' ? { kind: 'native' } : host.kind === 'wsl' ? { kind: 'wsl', distro: host.distro } : { kind: 'ssh', host: host.host },
      scope: scope.kind === 'repo' ? { kind: 'repo', owner: scope.owner, repo: scope.repo } : { kind: 'org', org: scope.org },
      name: r.name as string, directory: (r.directory as string).trim(), labels: dedupe, runnerGroup: r.runnerGroup ? String(r.runnerGroup) : null,
      installService: r.installService !== false, serviceUser: r.serviceUser ? String(r.serviceUser) : null,
      windowsAccount: acct as InstallRequest['windowsAccount'], windowsAccountName: acct === 'custom' ? String(r.windowsAccountName) : null,
      startAfter: r.startAfter !== false, replace: r.replace === true, ephemeral: r.ephemeral === true, disableUpdate: r.disableUpdate === true, workFolder: work,
    },
  }
}

/* ------------------------------------------------------------ command construction */

const TOKEN_PLACEHOLDER = '<registration token>'

/** The configure arguments, exactly as the runner documents them. The token is passed as its own argument. */
export function configureArgs(req: InstallRequest, token: string): string[] {
  const args = ['--unattended', '--url', scopeUrl(req.scope), '--token', token, '--name', req.name, '--work', req.workFolder]
  if (req.labels.length) args.push('--labels', req.labels.join(','))
  if (req.runnerGroup) args.push('--runnergroup', req.runnerGroup)
  if (req.replace) args.push('--replace')
  if (req.ephemeral) args.push('--ephemeral')
  if (req.disableUpdate) args.push('--disableupdate')
  return args
}

export function windowsConfigureArgs(req: InstallRequest, token: string): string[] {
  const args = ['configure', ...configureArgs(req, token)]
  if (req.installService) {
    args.push('--runasservice')
    const acct = req.windowsAccount === 'custom' ? req.windowsAccountName : req.windowsAccount ? WINDOWS_ACCOUNTS[req.windowsAccount] : null
    if (acct && req.windowsAccount !== 'network-service') args.push('--windowslogonaccount', acct)
  }
  return args
}

/** The runner program for a platform: config.sh on POSIX; on Windows the listener is called directly, which is exactly what config.cmd does. */
export const configProgram = (os: RunnerOs, dir: string) => (os === 'windows' ? { file: path.win32.join(dir, 'bin', 'Runner.Listener.exe'), prefix: [] as string[] } : { file: './config.sh', prefix: [] as string[] })

export function commandPreviews(req: InstallRequest, os: RunnerOs, pkg: PackageInfo | null, serviceUser: string | null): CommandPreview[] {
  const where = req.host.kind === 'wsl' ? `${req.host.distro}:${req.directory}` : req.host.kind === 'ssh' ? `${req.host.host}:${req.directory}` : req.directory
  const out: CommandPreview[] = []
  if (pkg) out.push({ title: 'Download and verify', where, command: `${pkg.filename} from ${pkg.downloadUrl}\nsha256 ${pkg.sha256 ?? '(no checksum available: the installation is refused)'}`, elevated: false })
  if (os === 'windows') {
    out.push({ title: 'Extract', where, command: `tar.exe -xf ${pkg?.filename ?? 'actions-runner-win-x64-<version>.zip'} -C ${req.directory}`, elevated: false })
    out.push({ title: 'Configure and register', where, command: `bin\\Runner.Listener.exe ${windowsConfigureArgs(req, TOKEN_PLACEHOLDER).join(' ')}`, elevated: req.installService })
    if (req.installService && req.startAfter) out.push({ title: 'Start service', where, command: `sc.exe start ${predictedServiceName(req.scope, req.name, 'windows')}`, elevated: true })
  } else {
    out.push({ title: 'Extract', where, command: `tar -xzf ${pkg?.filename ?? 'actions-runner-<os>-<arch>-<version>.tar.gz'} -C ${req.directory}`, elevated: false })
    out.push({ title: 'Configure and register', where, command: `./config.sh ${configureArgs(req, TOKEN_PLACEHOLDER).join(' ')}`, elevated: false })
    if (req.installService) {
      out.push({ title: 'Install service', where, command: os === 'linux' ? `./svc.sh install ${serviceUser ?? '<user>'}` : './svc.sh install', elevated: os === 'linux' })
      if (req.startAfter) out.push({ title: 'Start service', where, command: './svc.sh start', elevated: os === 'linux' })
    }
  }
  return out
}

/* ------------------------------------------------------------ planning */

export async function planInstall(req: InstallRequest, deps: InstallDeps): Promise<InstallPlan> {
  const now = deps.now ?? Date.now
  const blockers: string[] = [], warnings: string[] = []
  const shell = deps.shellFor(req.host)
  const probe = await probeHost(shell)
  const os: RunnerOs = probe.reachable && probe.os !== 'unknown' ? probe.os : shell.os
  const plan: InstallPlan = {
    id: randomBytes(8).toString('hex'), request: req, target: { os, arch: probe.arch, machine: probe.machine, user: probe.user, systemd: probe.systemd }, pkg: null, commands: [], blockers, warnings,
    elevation: { needed: false, how: null }, serviceName: null, access: { checked: false, canRegister: null, message: null }, createdAt: new Date(now()).toISOString(),
  }
  if (!probe.reachable) { blockers.push(probe.message ?? 'The target machine could not be reached.'); return plan }
  if (os === 'unknown') blockers.push('The operating system of the target could not be determined.')
  if (probe.arch === 'unknown') blockers.push(`The architecture of the target could not be determined (uname -m gave something GitHub has no runner package for).`)
  if (os === 'windows' && req.host.kind === 'ssh') blockers.push('Remote Windows machines cannot be installed over SSH from GitManager. Use the guided manual setup, and monitor the runner through GitHub.')

  // directory
  const dir = checkInstallDirectory(os, req.directory)
  if (!dir.ok) blockers.push(dir.message)
  else {
    req.directory = dir.path
    const key = installKey(req.host, dir.path)
    const clash = deps.existing().find(l => l.key === key)
    if (clash) blockers.push(`${dir.path} already holds a runner installation${clash.agentName ? ` (${clash.agentName})` : ''}. Each runner needs its own directory; an existing installation is never overwritten.`)
    else if (await shell.exists(dir.path)) {
      const entries = (await shell.listDir(dir.path)) ?? []
      if (entries.length) blockers.push(`${dir.path} exists and is not empty. Choose an empty or new directory; GitManager never writes into a folder that already has content.`)
    }
    if (dir.ok && dir.path.includes(' ') && os !== 'windows') warnings.push('The path contains a space. The runner handles it, but shell commands you run by hand will need quotes.')
  }

  // names and collisions
  const sameScopeLocal = deps.existing().filter(l => l.scope && sameScope(l.scope, req.scope) && l.agentName?.toLowerCase() === req.name.toLowerCase() && sameHost(l.host, req.host))
  if (sameScopeLocal.length) blockers.push(`A runner named ${req.name} for ${scopeLabel(req.scope)} is already installed here (${sameScopeLocal[0].path}).`)
  const onGitHub = deps.githubRunners().find(g => sameScope(g.scope, req.scope) && g.name.toLowerCase() === req.name.toLowerCase())
  if (onGitHub && !req.replace) blockers.push(`GitHub already lists a runner named ${req.name} for ${scopeLabel(req.scope)} (${onGitHub.status}). Choose another name, or tick Replace to take over that registration.`)
  if (onGitHub && req.replace) warnings.push(`Replace: the existing registration of ${req.name} (${onGitHub.status}) will be taken over. Its previous machine, if still running, loses its registration.`)
  const serviceName = req.installService ? predictedServiceName(req.scope, req.name, os) : null
  plan.serviceName = serviceName
  if (serviceName) {
    const svcClash = deps.existing().find(l => l.service.name && l.service.name.toLowerCase() === serviceName.toLowerCase() && sameHost(l.host, req.host))
    if (svcClash) blockers.push(`A service named ${serviceName} already exists here (${svcClash.path}).`)
  }

  // service prerequisites and elevation
  let serviceUser: string | null = req.serviceUser
  if (req.installService) {
    if (os === 'linux') {
      if (probe.systemd === false) blockers.push(req.host.kind === 'wsl' ? `systemd is not running in ${req.host.distro}. A service needs it: add [boot] systemd=true to /etc/wsl.conf, run "wsl --shutdown", then try again. Or install without a service and start the runner with ./run.sh.` : 'systemd is not running on this machine, so the runner cannot be installed as a service here. Install without a service and start it with ./run.sh.')
      if (!serviceUser) serviceUser = probe.user && probe.user !== 'root' ? probe.user : null
      if (!serviceUser) blockers.push('Choose the user the service runs as. The runner should not run as root.')
      plan.elevation = { needed: true, how: shell.elevationNote() }
      if (req.host.kind === 'native' && probe.sudo === false) blockers.push('Installing a systemd service needs administrator rights, and sudo asks for a password that GitManager cannot type. Allow passwordless sudo for your user, or install without a service.')
      if (req.host.kind === 'ssh' && probe.sudo === false) blockers.push(`Installing the service on ${req.host.host} needs sudo without a password for ${probe.user ?? 'the remote user'}, or install without a service.`)
    } else if (os === 'windows') plan.elevation = { needed: true, how: shell.elevationNote() }
    else plan.elevation = { needed: false, how: shell.elevationNote() }
  }
  if (os === 'linux' && probe.user === 'root' && req.host.kind !== 'wsl') warnings.push('You are root on the target. The runner refuses to configure as root unless RUNNER_ALLOW_RUNASROOT is set; GitManager does not set it.')
  if (req.host.kind === 'wsl') warnings.push(`WSL does not start distributions when Windows boots. The service in ${req.host.distro} runs only while the distribution is running (for example after you open a terminal in it or start it from Task Scheduler).`)
  if (req.scope.kind === 'repo') warnings.push('A self-hosted runner executes code from this repository. For a public repository that accepts outside contributions, GitHub advises against self-hosted runners: a fork could run arbitrary code on this machine.')
  else warnings.push('An organization runner can be used by the repositories its runner group allows. Check the group settings on GitHub if the organization has public repositories.')

  // GitHub access and the package
  try {
    if (req.scope.kind === 'repo') {
      const r = await deps.github.repo(`${req.scope.owner}/${req.scope.repo}`)
      plan.access = { checked: true, canRegister: r.canAdmin, message: r.canAdmin ? null : `Your GitHub CLI sign-in does not have administrator permission on ${scopeLabel(req.scope)}, which registering a runner needs.` }
    } else {
      const role = await deps.github.orgRole(req.scope.org)
      plan.access = { checked: true, canRegister: role === 'admin' ? true : role === 'member' ? false : null, message: role === 'admin' ? null : role === 'member' ? `You are a member, not an administrator, of ${req.scope.org}; registering an organization runner needs the admin:org scope and administrator rights.` : `Your role in ${req.scope.org} could not be read (the sign-in may lack the read:org scope).` }
    }
    if (plan.access.canRegister === false) blockers.push(plan.access.message!)
    let pkgs: PackageInfo[] = []
    try { pkgs = await deps.github.downloads(req.scope) } catch (e) { if (!(e instanceof GhError && (e.kind === 'permission' || e.kind === 'not-found'))) throw e }
    let pkg = pkgs.find(p => p.os === os && p.arch === probe.arch) ?? null
    if (!pkg) {
      const latest = await deps.github.latestRelease()
      pkg = packageFor(os, probe.arch, latest.version, latest.checksums)
      if (!pkg) blockers.push(`GitHub publishes no runner package for ${os} on ${probe.arch}.`)
    }
    if (pkg && !pkg.sha256) blockers.push(`No SHA-256 checksum is available for ${pkg.filename}, so the download could not be verified. GitManager does not install unverified packages.`)
    if (pkg && !trustedDownloadUrl(pkg.downloadUrl)) blockers.push(`The package URL ${pkg.downloadUrl} is not on GitHub's release hosts.`)
    plan.pkg = pkg
  } catch (e) {
    const err = e as GhError
    plan.access = { checked: true, canRegister: null, message: err.message }
    blockers.push(err.kind === 'no-gh' ? err.message : err.kind === 'auth' ? 'GitHub CLI is not signed in. Run "gh auth login" in a terminal, then plan again.' : `GitHub could not be read: ${err.message}`)
  }
  plan.commands = commandPreviews(req, os, plan.pkg, serviceUser)
  plan.request = { ...req, serviceUser }
  return plan
}

/* ------------------------------------------------------------ download */

/** Downloads from GitHub's release hosts only (every redirect hop checked), streaming to disk with a running SHA-256. */
export const downloadFile: Downloader = (url, dest, opts) => new Promise(resolve => {
  // Acceptance scenarios: GITMANAGER_RUNNER_PACKAGE_DIR serves the package from a local folder instead of github.com (the URL is still checked).
  const localDir = process.env.GITMANAGER_RUNNER_PACKAGE_DIR
  if (localDir) {
    if (!trustedDownloadUrl(url)) return resolve({ ok: false, message: `Refused to download from ${url}: not a GitHub release host.` })
    try {
      const src = path.join(localDir, path.basename(new URL(url).pathname))
      const buf = readFileSync(src)
      writeFileSync(dest, buf)
      return resolve({ ok: true, sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length })
    } catch (e) { return resolve({ ok: false, message: (e as Error).message }) }
  }
  const hash = createHash('sha256')
  let bytes = 0, hops = 0, settled = false
  const finish = (r: Awaited<ReturnType<Downloader>>) => { if (!settled) { settled = true; resolve(r) } }
  const go = (u: string) => {
    if (!trustedDownloadUrl(u)) return finish({ ok: false, message: `Refused to download from ${u}: not a GitHub release host.` })
    if (hops++ > 5) return finish({ ok: false, message: 'Too many redirects.' })
    const req = httpsGet(u, { headers: { 'User-Agent': 'GitManager' }, timeout: 60_000 }, res => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return go(new URL(res.headers.location, u).toString()) }
      if (res.statusCode !== 200) { res.resume(); return finish({ ok: false, message: `GitHub answered ${res.statusCode} for the package.` }) }
      const out = createWriteStream(dest)
      const timer = setInterval(() => { if (opts.signal.cancelled) { req.destroy(); out.destroy(); clearInterval(timer); finish({ ok: false, message: 'Cancelled.' }) } }, 250)
      res.on('data', (b: Buffer) => { bytes += b.length; hash.update(b); if (bytes > opts.maxBytes) { req.destroy(); out.destroy(); finish({ ok: false, message: 'The package is larger than expected; download stopped.' }) } })
      res.pipe(out)
      out.on('finish', () => { clearInterval(timer); finish({ ok: true, sha256: hash.digest('hex'), bytes }) })
      out.on('error', e => { clearInterval(timer); finish({ ok: false, message: e.message }) })
      res.on('error', e => { clearInterval(timer); finish({ ok: false, message: e.message }) })
    })
    req.on('timeout', () => { req.destroy(new Error('timed out')) })
    req.on('error', e => finish({ ok: false, message: `Download failed: ${e.message}` }))
  }
  go(url)
})

/* ------------------------------------------------------------ execution */

export type JobUpdate = (job: InstallJob) => void

export function newJob(plan: InstallPlan, now = Date.now): InstallJob {
  return {
    id: randomBytes(8).toString('hex'), planId: plan.id, request: plan.request, pkg: plan.pkg, state: 'running', error: null, log: [], startedAt: new Date(now()).toISOString(), finishedAt: null, runnerKey: null, cancelRequested: false,
    steps: STEP_ORDER.map(id => ({ id, label: STEP_LABELS[id], state: 'pending', message: null, startedAt: null, finishedAt: null })),
    outcome: { downloaded: false, extracted: false, registered: false, serviceInstalled: false, running: false, verified: false },
  }
}

class StepFailure extends Error { constructor(readonly step: InstallStepId, message: string, readonly recovery: string[]) { super(message) } }
class Cancelled extends Error {}

const sha256Cmd = (os: RunnerOs) => (os === 'macos' ? ['shasum', ['-a', '256']] as const : ['sha256sum', []] as const)

/**
 * Runs the plan. Each step updates the job (the interface shows progress), output is redacted before it is kept, and a
 * failure stops at that step with what was done so far: files downloaded, registered on GitHub, service installed,
 * running. Nothing already created is removed; the user decides what to do with a partial installation.
 */
export async function runInstall(plan: InstallPlan, deps: InstallDeps, update: JobUpdate, job = newJob(plan, deps.now)): Promise<InstallJob> {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? (ms => new Promise(r => setTimeout(r, ms)))
  const req = plan.request
  const secrets: string[] = []
  const log = (line: string) => { job.log.push(redact(line, secrets).slice(0, 2000)); if (job.log.length > 2000) job.log.splice(0, job.log.length - 2000); update(job) }
  const step = (id: InstallStepId) => job.steps.find(s => s.id === id)!
  const begin = (id: InstallStepId) => { if (job.cancelRequested) throw new Cancelled(); const s = step(id); s.state = 'running'; s.startedAt = new Date(now()).toISOString(); update(job) }
  const done = (id: InstallStepId, message: string | null = null) => { const s = step(id); s.state = 'done'; s.message = message ? redact(message, secrets) : null; s.finishedAt = new Date(now()).toISOString(); update(job) }
  const skip = (id: InstallStepId, message: string) => { const s = step(id); s.state = 'skipped'; s.message = message; s.finishedAt = new Date(now()).toISOString(); update(job) }
  const fail: (id: InstallStepId, message: string, recovery: string[]) => never = (id, message, recovery) => { throw new StepFailure(id, message, recovery) }
  const outOf = (r: { stdout: string; stderr: string; code: number | null; timedOut: boolean; spawnError?: string }) => redact([r.stdout, r.stderr].map(x => x.trim()).filter(Boolean).join('\n'), secrets)
  const shell = deps.shellFor(req.host)
  const os = plan.target.os
  const win = os === 'windows'
  const join = win ? path.win32.join : path.posix.join
  const stage = path.join(deps.tmpDir, `gitmanager-runner-${job.id}`)
  let hostArchive: string | null = null
  update(job)

  try {
    if (plan.blockers.length) fail('environment', plan.blockers[0], ['Resolve the problems listed in the plan, then plan the installation again.'])
    if (!plan.pkg) fail('environment', 'The plan has no package to install.', ['Plan the installation again.'])
    const pkg = plan.pkg

    // 1. environment
    begin('environment')
    const probe = await probeHost(shell)
    if (!probe.reachable) fail('environment', probe.message ?? 'The target could not be reached.', ['Check the connection and try again.'])
    if (probe.os !== os || probe.arch !== plan.target.arch) fail('environment', `The target reports ${probe.os} ${probe.arch}, but the plan was made for ${os} ${plan.target.arch}.`, ['Plan the installation again.'])
    const tarCheck = win ? await shell.run('tar.exe', ['--version'], { timeoutMs: 20_000 }) : await shell.run('tar', ['--version'], { timeoutMs: 20_000 })
    if (tarCheck.spawnError || (tarCheck.code !== 0 && !/bsdtar|GNU tar|libarchive/i.test(tarCheck.stdout + tarCheck.stderr))) fail('environment', win ? 'tar.exe was not found. Windows 10 1803 and later include it.' : 'tar was not found on the target.', ['Install tar, then try again.'])
    if (await shell.exists(req.directory)) {
      const entries = (await shell.listDir(req.directory)) ?? []
      if (entries.length) fail('environment', `${req.directory} is not empty. GitManager never writes into a folder that already has content.`, ['Choose an empty or new directory.'])
    } else {
      const mk = await shell.mkdirp(req.directory)
      if (!mk.ok) fail('environment', `Could not create ${req.directory}: ${mk.message ?? 'unknown error'}`, ['Choose a directory you can write to, or create it first.'])
    }
    job.runnerKey = installKey(req.host, req.directory)
    log(`Target: ${probe.machine ?? 'unknown machine'}, ${os} ${probe.arch}, user ${probe.user ?? 'unknown'}.`)
    done('environment', `${probe.machine ?? ''} ${os} ${probe.arch}`.trim())

    // 2. GitHub access: the registration token, kept only in memory
    begin('github')
    let token: string
    try {
      const t = await deps.github.registrationToken(req.scope)
      token = t.token; secrets.push(token)
      log(`Registration token received for ${scopeLabel(req.scope)}${t.expiresAt ? `, valid until ${t.expiresAt}` : ''}.`)
      if (t.expiresAt && Date.parse(t.expiresAt) < now()) fail('github', 'GitHub returned a registration token that has already expired.', ['Check the clock of this computer, then try again.'])
    } catch (e) {
      if (e instanceof StepFailure) throw e
      const err = e as GhError
      fail('github', err.kind === 'permission' ? `GitHub refused to issue a registration token for ${scopeLabel(req.scope)}: ${err.message}` : err.kind === 'auth' ? 'GitHub CLI is not signed in.' : `Could not get a registration token: ${err.message}`,
        err.kind === 'permission' ? ['Registering needs repository administration (repository runner) or the admin:org scope and organization administration (organization runner).', 'For a classic token: gh auth refresh -s repo (repository) or -s admin:org (organization).'] : ['Run "gh auth login" in a terminal, then try again.'])
    }
    done('github', `Token for ${scopeLabel(req.scope)}`)

    // 3. download
    begin('download')
    await mkdir(stage, { recursive: true })
    const local = path.join(stage, pkg.filename)
    const dl = await (deps.download ?? downloadFile)(pkg.downloadUrl, local, { signal: { get cancelled() { return job.cancelRequested } }, maxBytes: 600 * 1024 * 1024 })
    if (!dl.ok) { if (job.cancelRequested) throw new Cancelled(); fail('download', dl.message, ['Check the connection to github.com and try again.']) }
    job.outcome.downloaded = true
    log(`Downloaded ${pkg.filename} (${(dl.bytes / 1024 / 1024).toFixed(1)} MB).`)
    done('download', pkg.filename)

    // 4. verify
    begin('verify')
    if (!pkg.sha256) fail('verify', 'No checksum is available for this package.', ['GitManager only installs packages whose SHA-256 GitHub publishes.'])
    if (dl.sha256.toLowerCase() !== pkg.sha256.toLowerCase()) fail('verify', `The download does not match GitHub's SHA-256 (${pkg.checksumSource}). Expected ${pkg.sha256}, got ${dl.sha256}.`, ['The file was not used. Try the download again; if it fails again, check the network path to GitHub.'])
    log(`SHA-256 verified against GitHub's ${pkg.checksumSource === 'downloads-api' ? 'runner downloads API' : 'release notes'}.`)
    done('verify', 'SHA-256 matches')

    // 5. extract
    begin('extract')
    hostArchive = req.host.kind === 'native' ? local : join(req.directory, pkg.filename)
    if (req.host.kind !== 'native') {
      const put = await shell.putFile(local, hostArchive)
      if (!put.ok) fail('extract', `Could not copy the package to the target: ${put.message ?? 'unknown error'}`, ['Check that the directory is writable on the target.'])
      const [cmd, extra] = sha256Cmd(os)
      const chk = await shell.run(cmd, [...extra, hostArchive], { timeoutMs: 120_000 })
      const got = /^([0-9a-f]{64})/i.exec(chk.stdout.trim())?.[1]
      if (chk.code !== 0 || !got) log(`Could not re-check the checksum on the target (${cmd} unavailable); the file was verified before the copy.`)
      else if (got.toLowerCase() !== pkg.sha256.toLowerCase()) fail('extract', 'The copy on the target does not match the verified download.', ['Try again; the copied file was not extracted.'])
      else log('Checksum re-verified on the target.')
    }
    const tar = win ? await shell.run('tar.exe', ['-xf', hostArchive, '-C', req.directory], { timeoutMs: 600_000 }) : await shell.run('tar', ['-xzf', hostArchive, '-C', req.directory], { timeoutMs: 600_000 })
    if (tar.code !== 0) fail('extract', `Extracting failed: ${outOf(tar) || `exit code ${tar.code}`}`, ['Check free disk space and permissions in the directory.'])
    const listener = join(req.directory, 'bin', win ? 'Runner.Listener.exe' : 'Runner.Listener')
    if (!(await shell.exists(listener))) fail('extract', 'The package did not contain the runner program (bin/Runner.Listener).', ['The download may be corrupt; try again.'])
    const ver = await shell.run(win ? listener : './bin/Runner.Listener', ['--version'], { cwd: req.directory, timeoutMs: 60_000 })
    const got = /(\d+\.\d+\.\d+)/.exec(ver.stdout)?.[1]
    if (got && got !== pkg.version) fail('extract', `The extracted runner reports version ${got}, the package was ${pkg.version}.`, ['Try again with a fresh download.'])
    if (!got && !win && /not found|No such file/i.test(ver.stderr)) log(`The runner could not report its version yet: ${ver.stderr.trim()}. On Linux, missing libraries are installed with bin/installdependencies.sh.`)
    job.outcome.extracted = true
    if (req.host.kind !== 'native' && hostArchive) { await shell.run('rm', ['-f', '--', hostArchive], { timeoutMs: 20_000 }); hostArchive = null }
    log(`Extracted to ${req.directory} (runner ${got ?? pkg.version}).`)
    done('extract', `Runner ${got ?? pkg.version}`)

    // 6. configure (registers the runner with GitHub as part of the same command)
    begin('configure')
    let cfg
    if (win) {
      const args = windowsConfigureArgs(req, token)
      const sh = req.installService ? shell.elevated() ?? shell : shell
      log(`$ bin\\Runner.Listener.exe ${redactArgs(args, secrets).join(' ')}${req.installService ? '  (as administrator)' : ''}`)
      cfg = await sh.run(join(req.directory, 'bin', 'Runner.Listener.exe'), args, { cwd: req.directory, timeoutMs: 300_000 })
    } else {
      const args = configureArgs(req, token)
      log(`$ ./config.sh ${redactArgs(args, secrets).join(' ')}`)
      cfg = await shell.run('./config.sh', args, { cwd: req.directory, timeoutMs: 300_000 })
    }
    const cfgOut = outOf(cfg)
    if (cfgOut) for (const l of cfgOut.split('\n').slice(-40)) log(l)
    if (cfg.code !== 0) {
      const text = cfg.stdout + cfg.stderr
      const why = /already exists/i.test(text) ? 'A runner with this name already exists in the scope. Tick Replace, or choose another name.'
        : /Not configured|Http response code: Forbidden|Response status code does not indicate success: 403/i.test(text) ? 'GitHub refused the registration (403). The token may have expired, or the sign-in lacks permission.'
          : /Must not run with sudo|run as root/i.test(text) ? 'The runner refuses to configure as root.'
            : /libicu|Dependencies is missing|libssl|libkrb5/i.test(text) ? 'The runner needs system libraries that are missing on the target.'
              : /windowslogonpassword|password/i.test(text) && win ? 'The chosen Windows account needs a password, which GitManager never collects. Use NETWORK SERVICE, LOCAL SERVICE or LocalSystem, or configure that account by hand.'
                : `The runner's configure command failed (exit code ${cfg.code}).`
      fail('configure', why, [
        /libicu|Dependencies is missing|libssl/i.test(text) ? `Run bin/installdependencies.sh in ${req.directory} as root, then run the configure command again from the plan.` : 'The files stay in the directory. Fix the cause and run the configure command shown in the plan, or delete the directory to start over.',
        'Nothing was registered on GitHub unless the output above says so.',
      ])
    }
    done('configure')

    // 7. registration evidence
    begin('register')
    const installed = await inspectOne(shell, probe, req.directory)
    if (!installed?.configured || installed.agentId === null) fail('register', 'The configure command finished, but no registration (.runner) was found in the directory.', ['Check the output above; run the configure command from the plan by hand if needed.'])
    job.outcome.registered = true
    log(`Registered as ${installed.agentName ?? req.name} (GitHub runner id ${installed.agentId}).`)
    done('register', `Runner id ${installed.agentId}`)

    // 8. service
    let serviceName: string | null = null
    if (!req.installService) skip('service', 'Not requested. Start the runner with run.sh (or run.cmd) when needed.')
    else {
      begin('service')
      if (win) {
        serviceName = installed.service.name ?? plan.serviceName
        job.outcome.serviceInstalled = installed.service.kind === 'windows-service'
        if (!job.outcome.serviceInstalled) fail('service', 'The configure step should have installed the Windows service (--runasservice), but no service was recorded.', ['Check the configure output above.'])
        done('service', `Windows service ${serviceName} (installed by configure)`)
      } else {
        const sh = os === 'linux' ? shell.elevated() : shell
        if (!sh) fail('service', 'No way to run the service installation as administrator.', ['Run "sudo ./svc.sh install <user>" in the directory.'])
        const args = os === 'linux' && req.serviceUser ? ['install', req.serviceUser] : ['install']
        log(`$ ./svc.sh ${args.join(' ')}${os === 'linux' ? '  (as root)' : ''}`)
        const svc = await sh.run('./svc.sh', args, { cwd: req.directory, timeoutMs: 180_000 })
        const o = outOf(svc); if (o) for (const l of o.split('\n').slice(-20)) log(l)
        if (svc.code !== 0) fail('service', `Installing the service failed: ${o.split('\n').pop() || `exit code ${svc.code}`}`, [`The runner is registered. Install the service by hand: ${os === 'linux' ? `sudo ./svc.sh install ${req.serviceUser ?? ''}` : './svc.sh install'} in ${req.directory}, or start it with ./run.sh.`])
        const after = await inspectOne(shell, probe, req.directory)
        serviceName = after?.service.name ?? plan.serviceName
        job.outcome.serviceInstalled = !!after?.service.name
        done('service', serviceName ?? undefined)
      }
    }

    // 9. start
    if (!req.startAfter) skip('start', 'Not requested.')
    else if (!req.installService) skip('start', 'No service was installed; start the runner with run.sh (or run.cmd).')
    else {
      begin('start')
      const before = await inspectOne(shell, probe, req.directory)
      if (before?.service.state === 'running') log('The service is already running.')
      else if (win) {
        const sh = shell.elevated() ?? shell
        const st = await sh.run('sc.exe', ['start', serviceName ?? plan.serviceName ?? ''], { timeoutMs: 120_000 })
        if (st.code !== 0 && !/already running|1056/i.test(st.stdout + st.stderr)) fail('start', `Starting the service failed: ${outOf(st) || `exit code ${st.code}`}`, [`Start it by hand: sc.exe start ${serviceName} (as administrator).`])
      } else {
        const sh = os === 'linux' ? shell.elevated() ?? shell : shell
        const st = await sh.run('./svc.sh', ['start'], { cwd: req.directory, timeoutMs: 120_000 })
        const o = outOf(st); if (o) for (const l of o.split('\n').slice(-10)) log(l)
        if (st.code !== 0) fail('start', `Starting the service failed: ${o.split('\n').pop() || `exit code ${st.code}`}`, [`Start it by hand: ${os === 'linux' ? 'sudo ' : ''}./svc.sh start in ${req.directory}.`])
      }
      done('start')
    }

    // 10. verify on GitHub
    begin('verify-registration')
    let gh: GitHubRunner | null = null
    const deadline = now() + (deps.onlineWaitMs ?? 45_000)
    for (;;) {
      gh = await deps.github.getRunner(req.scope, installed.agentId)
      if (!gh) fail('verify-registration', `GitHub does not list runner id ${installed.agentId} for ${scopeLabel(req.scope)}.`, ['The local files say the runner registered; GitHub disagrees. Check the runner settings page on GitHub.'])
      if (gh.status === 'online' || !req.startAfter || !req.installService || now() >= deadline) break
      await sleep(3000)
    }
    job.outcome.verified = true
    const online = gh!.status === 'online'
    if (req.startAfter && req.installService && !online) log(`GitHub lists the runner but still reports it offline after ${Math.round((deps.onlineWaitMs ?? 45_000) / 1000)} s. It may need a moment, or the service may not have started.`)
    done('verify-registration', `GitHub: ${gh!.status}${gh!.labels.length ? `, labels ${gh!.labels.map(l => l.name).join(', ')}` : ''}`)

    // 11. verify locally
    begin('verify-service')
    const final = await inspectOne(shell, probe, req.directory)
    job.outcome.running = !!final && (final.service.state === 'running' || final.process.running === true)
    if (req.startAfter && req.installService && !job.outcome.running) fail('verify-service', `The service ${final?.service.name ?? ''} is ${final?.service.state ?? 'unknown'} after the start.`, ['Look at the diagnostic logs (_diag) in the installation directory.'])
    done('verify-service', final ? `${final.service.kind === 'none' ? 'No service' : `Service ${final.service.state}`}${final.process.running ? ', runner process running' : ''}` : null)

    job.state = 'done'
  } catch (e) {
    if (e instanceof Cancelled || (job.cancelRequested && !(e instanceof StepFailure))) {
      job.state = 'cancelled'
      for (const s of job.steps) if (s.state === 'running') { s.state = 'failed'; s.message = 'Cancelled'; s.finishedAt = new Date(now()).toISOString() }
      log('Cancelled. ' + partialNote(job.outcome, req.directory))
    } else {
      const f = e instanceof StepFailure ? e : new StepFailure(job.steps.find(s => s.state === 'running')?.id ?? 'environment', (e as Error).message, ['Try again.'])
      const s = step(f.step); s.state = 'failed'; s.message = redact(f.message, secrets); s.finishedAt = new Date(now()).toISOString()
      job.state = 'failed'
      job.error = { step: f.step, message: redact(f.message, secrets), recovery: [...f.recovery.map(r => redact(r, secrets)), partialNote(job.outcome, req.directory)] }
      log(`Failed at "${STEP_LABELS[f.step]}": ${redact(f.message, secrets)}`)
    }
  } finally {
    job.finishedAt = new Date(now()).toISOString()
    try { if (hostArchive && req.host.kind !== 'native') await shell.run('rm', ['-f', '--', hostArchive], { timeoutMs: 20_000 }) } catch { /* best effort */ }
    try { await rm(stage, { recursive: true, force: true }) } catch { /* temp only */ }
    update(job)
  }
  return job
}

export function partialNote(o: InstallOutcome, dir: string): string {
  const parts: string[] = []
  parts.push(o.extracted ? `Files are in ${dir}.` : o.downloaded ? 'The package was downloaded but not extracted (the download has been removed).' : `No files were written to ${dir} beyond the empty folder.`)
  parts.push(o.registered ? 'The runner is registered on GitHub.' : 'Nothing was registered on GitHub.')
  if (o.serviceInstalled) parts.push('A service was installed.')
  if (o.running) parts.push('The runner is running.')
  return parts.join(' ')
}

export async function fileExists(p: string) { try { await stat(p); return true } catch { return false } }
