// Operations on an existing installation: service control, diagnostics, update check and update, unregister, uninstall.
// Only services recorded by the runner itself (.service) and processes identified by path are ever touched; a busy runner
// is never interrupted without the explicit allowBusy; destructive operations need the explicit confirm.
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import type { ActionOptions, ActionResult, ActionStep, DiagnosticLog, LocalRunner, PackageInfo, Runner, RunnerAction, RunnerDiagnostics, RunnerHost } from '../../shared/runners.js'
import { GhError } from '../storage/gh.js'
import { inspectOne, versionFromText } from './discovery.js'
import { RunnerGitHub, packageFor, trustedDownloadUrl } from './github.js'
import { downloadFile, type Downloader } from './install.js'
import { probeHost, type HostShell } from './hosts.js'
import { checkInstallDirectory, compareVersions, scopeLabel } from './model.js'
import { redact, redactArgs } from './redact.js'

export type LifecycleDeps = {
  shellFor: (host: RunnerHost) => HostShell
  github: RunnerGitHub | null
  tmpDir: string
  latest: () => Promise<{ version: string; checksums: Record<string, string> } | null>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  download?: Downloader
  /** Called with the re-inspected installation after an operation, so the inventory stays current. */
  onInspected?: (local: LocalRunner | null, key: string) => void
}

const BUSY_ACTIONS: RunnerAction[] = ['stop', 'restart', 'update', 'unregister', 'uninstall']
const CONFIRM_ACTIONS: RunnerAction[] = ['update', 'unregister', 'uninstall']

class Fail extends Error { constructor(message: string, readonly detail?: string) { super(message) } }

const outOf = (r: { stdout: string; stderr: string }, secrets: string[] = []) => redact([r.stdout, r.stderr].map(x => x.trim()).filter(Boolean).join('\n'), secrets)

/** Service control for the three mechanisms the runner supports. Returns the output, or throws with a message the user can act on. */
export async function controlService(shell: HostShell, local: LocalRunner, verb: 'start' | 'stop' | 'restart', log: (l: string) => void, sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))): Promise<void> {
  const svc = local.service
  if (svc.kind === 'windows-service' && svc.name) {
    const sh = shell.elevated() ?? shell
    const verbs = verb === 'restart' ? ['stop', 'start'] as const : [verb]
    for (const v of verbs) {
      log(`$ sc.exe ${v} ${svc.name}  (as administrator)`)
      const r = await sh.run('sc.exe', [v, svc.name], { timeoutMs: 120_000 })
      const text = r.stdout + r.stderr
      if (r.code !== 0 && !(v === 'stop' && /1062|has not been started/i.test(text)) && !(v === 'start' && /1056|already running/i.test(text))) throw new Fail(`Windows refused to ${v} the service ${svc.name}.`, /5|Access is denied/i.test(text) ? 'Access denied: the administrator prompt was declined or the account lacks rights.' : outOf(r))
      if (v === 'stop') await waitForWindowsState(sh, svc.name, 'STOPPED', 60_000, sleep)
    }
    return
  }
  if (svc.kind === 'systemd' && svc.name) {
    const sh = shell.elevated() ?? shell
    log(`$ systemctl ${verb} ${svc.name}  (as root)`)
    const r = await sh.run('systemctl', [verb, svc.name], { timeoutMs: 120_000 })
    if (r.code !== 0) throw new Fail(`systemctl ${verb} ${svc.name} failed.`, outOf(r) || `exit code ${r.code}`)
    return
  }
  if (svc.kind === 'launchd') {
    const verbs = verb === 'restart' ? ['stop', 'start'] as const : [verb]
    for (const v of verbs) {
      log(`$ ./svc.sh ${v}`)
      const r = await shell.run('./svc.sh', [v], { cwd: local.path, timeoutMs: 120_000 })
      if (r.code !== 0) throw new Fail(`./svc.sh ${v} failed.`, outOf(r) || `exit code ${r.code}`)
    }
    return
  }
  if (verb === 'stop' && local.process.pids.length) {
    // No service: only processes positively identified as this installation's listener are signalled, gracefully.
    for (const pid of local.process.pids) {
      if (local.os === 'windows') { log(`$ taskkill /PID ${pid}`); await shell.run('taskkill', ['/PID', String(pid)], { timeoutMs: 30_000 }) }
      else { log(`$ kill -TERM ${pid}`); await shell.run('kill', ['-TERM', String(pid)], { timeoutMs: 30_000 }) }
    }
    return
  }
  throw new Fail(verb === 'start' ? 'This installation has no service to start. Run run.sh (or run.cmd) in its directory, or install the service.' : `This installation has no service to ${verb}.`)
}

async function waitForWindowsState(shell: HostShell, name: string, want: string, ms: number, sleep: (ms: number) => Promise<void>) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const r = await shell.run('sc.exe', ['query', name], { timeoutMs: 30_000 })
    if (new RegExp(`STATE\\s*:\\s*\\d+\\s+${want}`).test(r.stdout)) return
    await sleep(1000)
  }
}

/* ------------------------------------------------------------ diagnostics */

export async function collectDiagnostics(runner: Runner, deps: LifecycleDeps): Promise<RunnerDiagnostics> {
  const now = new Date((deps.now ?? Date.now)()).toISOString()
  const local = runner.local
  if (!local) return { key: runner.key, logs: [], service: { kind: 'unknown', name: null, state: 'unknown', startup: 'unknown', detail: null }, process: { running: null, pids: [], detail: null }, error: 'No local installation to inspect.', collectedAt: now }
  const shell = deps.shellFor(local.host)
  const logs: DiagnosticLog[] = []
  let error: string | null = null
  try {
    if (local.os === 'windows') {
      const files = ((await shell.listDir(path.win32.join(local.path, '_diag'))) ?? []).filter(f => /\.log$/i.test(f)).sort().reverse().slice(0, 3)
      for (const f of files) {
        const text = (await shell.readFile(path.win32.join(local.path, '_diag', f), 2 * 1024 * 1024)) ?? ''
        logs.push({ file: f, modifiedAt: null, sizeBytes: Buffer.byteLength(text), tail: text.split(/\r?\n/).filter(Boolean).slice(-80).map(l => redact(l)) })
      }
    } else {
      const r = await shell.script('cd "$1/_diag" 2>/dev/null || exit 0; ls -t *.log 2>/dev/null | head -n 3 | while IFS= read -r f; do m=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null); printf "@@FILE %s\\t%s\\t%s\\n" "$f" "$m" "$(wc -c < "$f" | tr -d \' \')"; tail -n 80 "$f"; done', [local.path], { timeoutMs: 60_000 })
      let cur: DiagnosticLog | null = null
      for (const line of r.stdout.split('\n')) {
        if (line.startsWith('@@FILE ')) { const [f, m, sz] = line.slice(7).split('\t'); cur = { file: f, modifiedAt: m && /^\d+$/.test(m) ? new Date(Number(m) * 1000).toISOString() : null, sizeBytes: Number(sz) || 0, tail: [] }; logs.push(cur); continue }
        if (cur && line.trim()) cur.tail.push(redact(line.replace(/\r$/, '')))
      }
      if (r.code !== 0 && !logs.length) error = r.stderr.trim() || null
    }
  } catch (e) { error = (e as Error).message }
  const fresh = await inspectOne(shell, null, local.path).catch(() => null)
  if (fresh) deps.onInspected?.(fresh, local.key)
  return { key: runner.key, logs, service: fresh?.service ?? local.service, process: fresh?.process ?? local.process, error, collectedAt: now }
}

/* ------------------------------------------------------------ actions */

export async function performAction(action: RunnerAction, runner: Runner, opts: ActionOptions, deps: LifecycleDeps): Promise<ActionResult> {
  const sleep = deps.sleep ?? (ms => new Promise(r => setTimeout(r, ms)))
  const steps: ActionStep[] = []
  const logLines: string[] = []
  const secrets: string[] = []
  const log = (l: string) => { logLines.push(redact(l, secrets)) }
  const step = (label: string) => { const s: ActionStep = { label, state: 'running', message: null }; steps.push(s); return s }
  const ok = (message: string, extra: Partial<ActionResult> = {}): ActionResult => ({ action, ok: true, message, steps, log: logLines, ...extra })
  const fail = (message: string, detail?: string): ActionResult => { for (const s of steps) if (s.state === 'running') { s.state = 'failed'; s.message = message } return { action, ok: false, message, detail: detail ? redact(detail, secrets) : undefined, steps, log: logLines } }
  const local = runner.local

  if (runner.github?.busy && BUSY_ACTIONS.includes(action) && !opts.allowBusy) return fail(`GitHub reports ${runner.name} is running a job. ${action === 'uninstall' ? 'Uninstalling' : action === 'unregister' ? 'Unregistering' : action === 'update' ? 'Updating' : action === 'stop' ? 'Stopping' : 'Restarting'} now would interrupt it; confirm to proceed anyway, or wait for the job to finish.`)
  if (CONFIRM_ACTIONS.includes(action) && !opts.confirm) return fail('This operation needs your explicit confirmation.')

  const refresh = async (shell: HostShell, l: LocalRunner) => { const fresh = await inspectOne(shell, null, l.path).catch(() => null); deps.onInspected?.(fresh, l.key); return fresh }

  try {
    switch (action) {
      case 'inspect': {
        if (!local) return fail(runner.capabilities.inspect.reason ?? 'No local installation.')
        const shell = deps.shellFor(local.host)
        const fresh = await refresh(shell, local)
        return fresh ? ok(`${fresh.service.kind === 'none' ? 'No service' : `Service ${fresh.service.state}`}${fresh.process.running ? ', runner process running' : ''}, version ${fresh.version ?? 'unknown'}.`) : fail('The installation directory no longer looks like a runner installation.')
      }
      case 'start': case 'stop': case 'restart': {
        if (!local) return fail(runner.capabilities[action].reason ?? 'No local installation.')
        if (!runner.capabilities[action].allowed) return fail(runner.capabilities[action].reason ?? 'Not possible for this runner.')
        const shell = deps.shellFor(local.host)
        const s = step(action === 'start' ? 'Starting' : action === 'stop' ? 'Stopping' : 'Restarting')
        await controlService(shell, local, action, log, sleep)
        s.state = 'done'
        const v = step('Checking state')
        let fresh: LocalRunner | null = null
        for (let i = 0; i < 10; i++) {
          fresh = await refresh(shell, local)
          const running = fresh?.service.state === 'running' || fresh?.process.running === true
          if ((action === 'stop') !== running) break
          await sleep(1500)
        }
        const running = fresh?.service.state === 'running' || fresh?.process.running === true
        v.state = (action === 'stop') === !running ? 'done' : 'failed'
        v.message = fresh ? `${fresh.service.kind === 'none' ? (running ? 'Runner process running' : 'No runner process') : `Service ${fresh.service.state}`}` : 'Could not re-read the installation.'
        if (v.state === 'failed') return fail(action === 'stop' ? 'The runner is still running after the stop request.' : 'The service did not report running after the start request.', v.message)
        return ok(action === 'stop' ? `${runner.name} stopped.` : `${runner.name} ${action === 'start' ? 'started' : 'restarted'}.${local.host.kind === 'wsl' ? ` It runs while ${local.host.distro} is running.` : ''}`)
      }
      case 'check-update': {
        const latest = await deps.latest()
        if (!latest) return fail('The latest runner release could not be read from GitHub.')
        const installed = local?.version ?? null
        if (!installed) return fail('The installed version is unknown, so it cannot be compared.', 'The runner program did not report a version and no diagnostic log named one.')
        const behind = compareVersions(installed, latest.version) < 0
        const note = local?.disableUpdate ? ' Automatic updates are turned off for this runner (--disableupdate), so only a manual update changes it.' : ' The runner normally updates itself within a day of a release; a manual update is only needed if it does not.'
        return ok(behind ? `Version ${installed} is installed; ${latest.version} is available.${note}` : `Version ${installed} is the latest release.`, { updateAvailable: behind ? { installed, latest: latest.version } : null })
      }
      case 'update': return await updateRunner(runner, deps, { steps, log, secrets, sleep, step, ok, fail })
      case 'unregister': return await unregisterRunner(runner, deps, { steps, log, secrets, sleep, step, ok, fail })
      case 'uninstall': return await uninstallRunner(runner, opts, deps, { steps, log, secrets, sleep, step, ok, fail })
    }
  } catch (e) {
    const err = e as Fail
    return fail(err.message, err.detail)
  }
}

type Ctx = { steps: ActionStep[]; log: (l: string) => void; secrets: string[]; sleep: (ms: number) => Promise<void>; step: (label: string) => ActionStep; ok: (m: string, extra?: Partial<ActionResult>) => ActionResult; fail: (m: string, d?: string) => ActionResult }

/** Replaces bin and externals with the latest package, as the runner's own self-update does, keeping .runner, .credentials and _work. */
async function updateRunner(runner: Runner, deps: LifecycleDeps, c: Ctx): Promise<ActionResult> {
  const local = runner.local
  if (!local) return c.fail('No local installation to update.')
  if (!runner.capabilities.update.allowed) return c.fail(runner.capabilities.update.reason ?? 'Not possible.')
  const shell = deps.shellFor(local.host)
  const probe = await probeHost(shell)
  if (!probe.reachable) return c.fail(probe.message ?? 'The machine could not be reached.')
  const s1 = c.step('Checking the latest release')
  let pkg: PackageInfo | null = null
  try { if (deps.github && runner.scope) pkg = (await deps.github.downloads(runner.scope)).find(p => p.os === local.os && p.arch === probe.arch) ?? null } catch { /* fall back to the release notes */ }
  if (!pkg) { const latest = await deps.latest(); if (latest) pkg = packageFor(local.os, probe.arch, latest.version, latest.checksums) }
  if (!pkg) return c.fail('No package is available for this platform.')
  if (compareVersions(local.version, pkg.version) >= 0) { s1.state = 'done'; s1.message = `${local.version} is current`; return c.ok(`Version ${local.version} is already the latest release.`) }
  if (!pkg.sha256) return c.fail(`No SHA-256 checksum is published for ${pkg.filename}; GitManager does not install unverified packages.`)
  if (!trustedDownloadUrl(pkg.downloadUrl)) return c.fail('The package URL is not on a GitHub release host.')
  s1.state = 'done'; s1.message = `${local.version} to ${pkg.version}`

  const wasRunning = local.service.state === 'running' || local.process.running === true
  if (wasRunning) {
    const s = c.step('Stopping the runner')
    await controlService(shell, local, 'stop', c.log, c.sleep)
    s.state = 'done'
  }
  const win = local.os === 'windows'
  const join = win ? path.win32.join : path.posix.join
  const stage = path.join(deps.tmpDir, `gitmanager-runner-update-${Date.now()}`)
  const stamp = String((deps.now ?? Date.now)())
  const backups: [string, string][] = []
  try {
    const s2 = c.step('Downloading and verifying')
    await mkdir(stage, { recursive: true })
    const file = path.join(stage, pkg.filename)
    const dl = await (deps.download ?? downloadFile)(pkg.downloadUrl, file, { signal: { cancelled: false }, maxBytes: 600 * 1024 * 1024 })
    if (!dl.ok) throw new Fail(dl.message)
    if (dl.sha256.toLowerCase() !== pkg.sha256.toLowerCase()) throw new Fail('The download does not match the published SHA-256; it was not used.')
    s2.state = 'done'; s2.message = pkg.filename
    const s3 = c.step('Replacing program files')
    const hostArchive = local.host.kind === 'native' ? file : join(local.path, pkg.filename)
    if (local.host.kind !== 'native') { const put = await shell.putFile(file, hostArchive); if (!put.ok) throw new Fail(`Could not copy the package: ${put.message}`) }
    for (const d of ['bin', 'externals']) {
      const from = join(local.path, d), to = join(local.path, `${d}.gm-old-${stamp}`)
      if (await shell.exists(from)) { const mv = await shell.move(from, to); if (!mv.ok) throw new Fail(`Could not set aside ${d}: ${mv.message}`); backups.push([to, from]) }
    }
    const tar = win ? await shell.run('tar.exe', ['-xf', hostArchive, '-C', local.path], { timeoutMs: 600_000 }) : await shell.run('tar', ['-xzf', hostArchive, '-C', local.path, '--exclude=.runner', '--exclude=.credentials'], { timeoutMs: 600_000 })
    if (tar.code !== 0) throw new Fail('Extracting the new package failed.', outOf(tar))
    if (local.host.kind !== 'native') await shell.run('rm', ['-f', '--', hostArchive], { timeoutMs: 20_000 })
    const ver = await shell.run(win ? join(local.path, 'bin', 'Runner.Listener.exe') : './bin/Runner.Listener', ['--version'], { cwd: local.path, timeoutMs: 60_000 })
    const got = versionFromText(ver.stdout)
    if (got !== pkg.version) throw new Fail(`The updated runner reports ${got ?? 'no version'} instead of ${pkg.version}.`, outOf(ver))
    for (const [b] of backups) await shell.remove(b)
    backups.length = 0
    s3.state = 'done'; s3.message = `Runner ${got}`
  } catch (e) {
    // restore what was set aside, then report
    for (const d of ['bin', 'externals']) { const p = join(local.path, d); if (backups.some(([, to]) => to === p)) await shell.remove(p) }
    for (const [from, to] of backups) await shell.move(from, to)
    if (wasRunning) { try { await controlService(shell, local, 'start', c.log, c.sleep) } catch { /* reported below */ } }
    await rm(stage, { recursive: true, force: true }).catch(() => {})
    const err = e as Fail
    return c.fail(`Update failed: ${err.message} The previous program files were restored.`, err.detail)
  }
  await rm(stage, { recursive: true, force: true }).catch(() => {})
  if (wasRunning) {
    const s = c.step('Starting the runner')
    await controlService(shell, local, 'start', c.log, c.sleep)
    s.state = 'done'
  }
  const s5 = c.step('Verifying')
  const fresh = await inspectOne(shell, probe, local.path)
  deps.onInspected?.(fresh, local.key)
  s5.state = fresh?.version === pkg.version ? 'done' : 'failed'
  s5.message = fresh ? `Version ${fresh.version ?? 'unknown'}, ${fresh.service.kind === 'none' ? 'no service' : `service ${fresh.service.state}`}` : 'Could not re-read the installation.'
  if (s5.state === 'failed') return c.fail('The installation does not report the new version after the update.', s5.message)
  return c.ok(`${runner.name} updated to ${pkg.version}.${wasRunning ? '' : ' The runner was not running and was left stopped.'}`)
}

async function unregisterRunner(runner: Runner, deps: LifecycleDeps, c: Ctx): Promise<ActionResult> {
  const local = runner.local
  const scope = runner.scope
  if (!scope) return c.fail('The registration scope is unknown, so no removal token can be requested.')
  if (!deps.github) return c.fail('GitHub access is not available (GitHub CLI missing or signed out).')
  const id = runner.github?.id ?? local?.agentId ?? null
  if (local && local.configured) {
    const shell = deps.shellFor(local.host)
    const probe = await probeHost(shell)
    if (!probe.reachable) return c.fail(probe.message ?? 'The machine could not be reached.')
    if (local.service.kind !== 'none' && local.service.state !== 'not-installed') {
      const s = c.step('Removing the service')
      if (local.service.kind === 'windows-service' && local.service.name) {
        const sh = shell.elevated() ?? shell
        await sh.run('sc.exe', ['stop', local.service.name], { timeoutMs: 60_000 })
        c.log(`$ sc.exe stop ${local.service.name}  (as administrator); the service itself is removed by the runner's remove command`)
      } else {
        const sh = local.os === 'linux' ? shell.elevated() ?? shell : shell
        for (const v of ['stop', 'uninstall']) {
          c.log(`$ ./svc.sh ${v}${local.os === 'linux' ? '  (as root)' : ''}`)
          const r = await sh.run('./svc.sh', [v], { cwd: local.path, timeoutMs: 120_000 })
          if (r.code !== 0 && v === 'uninstall') throw new Fail(`./svc.sh uninstall failed; the registration was left in place.`, outOf(r))
        }
      }
      s.state = 'done'
    }
    const s2 = c.step('Requesting a removal token')
    let token: string
    try { token = (await deps.github.removeToken(scope)).token; c.secrets.push(token) } catch (e) {
      const err = e as GhError
      return c.fail(err.kind === 'permission' ? `GitHub refused to issue a removal token for ${scopeLabel(scope)} (administration permission is needed).` : `Could not get a removal token: ${err.message}`)
    }
    s2.state = 'done'
    const s3 = c.step('Removing the registration')
    const args = ['remove', '--token', token]
    let r
    if (local.os === 'windows') {
      const sh = local.service.kind === 'windows-service' ? shell.elevated() ?? shell : shell
      c.log(`$ bin\\Runner.Listener.exe ${redactArgs(args).join(' ')}`)
      r = await sh.run(path.win32.join(local.path, 'bin', 'Runner.Listener.exe'), args, { cwd: local.path, timeoutMs: 180_000 })
    } else {
      c.log(`$ ./config.sh ${redactArgs(args).join(' ')}`)
      r = await shell.run('./config.sh', args, { cwd: local.path, timeoutMs: 180_000 })
    }
    const out = outOf(r, c.secrets); if (out) for (const l of out.split('\n').slice(-20)) c.log(l)
    s3.state = r.code === 0 ? 'done' : 'failed'
    const s4 = c.step('Verifying on GitHub')
    let still = id !== null ? await deps.github.getRunner(scope, id) : null
    if (still && r.code !== 0) {
      c.log('The local remove failed; removing the registration on GitHub directly.')
      try { await deps.github.deleteRunner(scope, still.id); still = await deps.github.getRunner(scope, still.id) } catch (e) { return c.fail(`The runner could not remove itself, and GitHub refused the removal: ${(e as Error).message}`, out) }
    } else if (r.code !== 0) return c.fail('The runner\'s remove command failed.', out)
    s4.state = still ? 'failed' : 'done'
    const fresh = await inspectOne(shell, probe, local.path).catch(() => null)
    deps.onInspected?.(fresh, local.key)
    if (still) return c.fail(`GitHub still lists ${runner.name} after the removal.`)
    return c.ok(`${runner.name} is no longer registered with ${scopeLabel(scope)}. Its files remain in ${local.path}; uninstall removes them.`)
  }
  if (id === null) return c.fail('Nothing to remove: no registration id is known.')
  const s = c.step('Removing the registration on GitHub')
  try { await deps.github.deleteRunner(scope, id) } catch (e) {
    const err = e as GhError
    return c.fail(err.kind === 'permission' ? `GitHub refused to remove the runner (administration permission is needed).` : /422|busy/i.test(err.message) ? 'GitHub refused: the runner is busy or online. Stop it on its machine first, or wait for the job to finish.' : `GitHub refused the removal: ${err.message}`)
  }
  s.state = 'done'
  return c.ok(`${runner.name} was removed from ${scopeLabel(scope)} on GitHub. The files on its machine were not touched; the runner there will fail to connect until it is removed or configured again.`)
}

async function uninstallRunner(runner: Runner, opts: ActionOptions, deps: LifecycleDeps, c: Ctx): Promise<ActionResult> {
  const local = runner.local
  if (!local) return c.fail('No local installation to uninstall.')
  const shell = deps.shellFor(local.host)
  const probe = await probeHost(shell)
  if (!probe.reachable) return c.fail(probe.message ?? 'The machine could not be reached.')
  const dirCheck = checkInstallDirectory(local.os, local.path)
  if (!dirCheck.ok) return c.fail(`Refused: ${local.path} is not a directory GitManager will delete (${dirCheck.message}).`)
  const win = local.os === 'windows'
  const join = win ? path.win32.join : path.posix.join
  const marks = await Promise.all([join(local.path, '.runner'), join(local.path, 'bin', win ? 'Runner.Listener.exe' : 'Runner.Listener'), join(local.path, win ? 'config.cmd' : 'config.sh')].map(p => shell.exists(p)))
  if (!marks.some(Boolean)) return c.fail(`Refused: ${local.path} does not look like a runner installation any more.`)
  if (runner.github && local.configured) {
    if (!opts.unregisterFirst) return c.fail(`${runner.name} is still registered with ${runner.scope ? scopeLabel(runner.scope) : 'GitHub'}. Remove the registration first (or choose to remove it as part of the uninstall), so GitHub does not keep an offline runner.`)
    const r = await unregisterRunner(runner, deps, c)
    if (!r.ok) return r
  } else if (local.service.kind !== 'none' && local.service.state !== 'not-installed' && local.service.name) {
    const s = c.step('Removing the service')
    if (local.service.kind === 'windows-service') {
      const sh = shell.elevated() ?? shell
      await sh.run('sc.exe', ['stop', local.service.name], { timeoutMs: 60_000 })
      const d = await sh.run('sc.exe', ['delete', local.service.name], { timeoutMs: 60_000 })
      if (d.code !== 0 && !/1060|does not exist/i.test(d.stdout + d.stderr)) throw new Fail(`Could not delete the Windows service ${local.service.name}.`, outOf(d))
    } else {
      const sh = local.os === 'linux' ? shell.elevated() ?? shell : shell
      await sh.run('./svc.sh', ['stop'], { cwd: local.path, timeoutMs: 120_000 })
      const u = await sh.run('./svc.sh', ['uninstall'], { cwd: local.path, timeoutMs: 120_000 })
      if (u.code !== 0) throw new Fail('./svc.sh uninstall failed; nothing was deleted.', outOf(u))
    }
    s.state = 'done'
  } else if (local.process.pids.length) {
    const s = c.step('Stopping the runner process')
    await controlService(shell, local, 'stop', c.log, c.sleep)
    s.state = 'done'
  }
  const s = c.step(`Deleting ${local.path}`)
  const rm = await shell.remove(local.path)
  if (!rm.ok) return c.fail(`Could not delete ${local.path}: ${rm.message ?? 'unknown error'}`)
  const gone = !(await shell.exists(local.path))
  s.state = gone ? 'done' : 'failed'
  deps.onInspected?.(null, local.key)
  return gone ? c.ok(`${runner.name} was uninstalled: ${local.path} was deleted${runner.github ? ' and the registration removed' : ''}.`) : c.fail(`${local.path} still exists after the deletion.`)
}
