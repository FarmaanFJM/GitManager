// Finds GitHub Actions runner installations on a host. An installation is recognized by the runner's own metadata
// (.runner, written by config) or by the runner program itself (bin/Runner.Listener next to config.sh or config.cmd),
// never by a folder name alone. Credential files are only checked for existence. Everything here is read-only.
import { hostname } from 'node:os'
import path from 'node:path'
import type { HostProbe, HostResult, LocalRunner, LocalService, RunnerArch, RunnerOs, RunnerRoot, RunnerScope } from '../../shared/runners.js'
import { normalizePath } from '../paths.js'
import { type HostShell } from './hosts.js'
import { archFromMachine, archFromNode, hostLabel, installKey, sameHost, scopeFromUrl } from './model.js'

export type DiscoverOptions = {
  roots?: RunnerRoot[]
  /** Overall time budget for the host. */
  deadlineMs?: number
  signal?: { cancelled: boolean }
  now?: () => number
  /** Replaces the built-in search roots (tests, or a user who wants only the configured folders). */
  defaultRoots?: string[]
}

/** Default search roots per operating system, as "depth:path" (depth counted from the root to the .runner file). "~" is the user's home. */
export function defaultRoots(os: RunnerOs): string[] {
  switch (os) {
    case 'linux': return ['4:/opt', '4:/srv', '4:/var/lib', '3:/usr/local', '4:/home', '3:/root', '3:~', '1:/']
    case 'macos': return ['3:~', '4:/Users', '4:/opt', '3:/usr/local', '1:/']
    case 'windows': return [] // drive roots and the profile folder are computed at run time
    default: return ['3:~', '4:/opt']
  }
}

/* ------------------------------------------------------------ parsing the runner's own files */

export type RunnerFile = { agentId: number | null; agentName: string | null; poolName: string | null; gitHubUrl: string | null; workFolder: string | null; ephemeral: boolean | null; disableUpdate: boolean | null }

/** .runner is JSON written by the runner's configure step. Only the fields the inventory needs are read. */
export function parseRunnerFile(text: string | null): RunnerFile | null {
  if (!text) return null
  let j: Record<string, unknown>
  try { j = JSON.parse(text.replace(/^﻿/, '')) as Record<string, unknown> } catch { return null }
  if (!j || typeof j !== 'object') return null
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : typeof x === 'string' && /^\d+$/.test(x) ? Number(x) : null)
  const str = (x: unknown) => (typeof x === 'string' && x.trim() ? x.trim() : null)
  const bool = (x: unknown) => (typeof x === 'boolean' ? x : typeof x === 'string' && /^(true|false)$/i.test(x) ? x.toLowerCase() === 'true' : null)
  return { agentId: num(j.agentId), agentName: str(j.agentName), poolName: str(j.poolName), gitHubUrl: str(j.gitHubUrl), workFolder: str(j.workFolder), ephemeral: bool(j.ephemeral), disableUpdate: bool(j.disableUpdate) }
}

/** The .service file holds the systemd unit name, the Windows service name, or (macOS) the path of the launchd plist. */
export function parseServiceFile(text: string | null): { kind: 'systemd' | 'launchd' | 'windows-service'; name: string } | null {
  const s = (text ?? '').replace(/^﻿/, '').trim().split(/\r?\n/)[0]?.trim()
  if (!s) return null
  if (/\.plist$/i.test(s)) return { kind: 'launchd', name: path.posix.basename(s, '.plist') }
  if (/\.service$/i.test(s)) return { kind: 'systemd', name: s.includes('/') ? path.posix.basename(s) : s }
  if (/^actions\.runner\./i.test(s) || !s.includes('/')) return { kind: 'windows-service', name: s }
  return null
}

export const versionFromText = (s: string | null | undefined): string | null => { const m = /(\d+\.\d{3,}\.\d+)/.exec(s ?? ''); return m ? m[1] : null }

/* ------------------------------------------------------------ POSIX hosts (Linux, macOS, WSL, SSH) */

/**
 * One shell run per host: candidate directories from the search roots, systemd units and launch agents; for each
 * directory the metadata, service state and positively identified processes, as tagged lines. Arguments are "depth:path".
 */
export const POSIX_SCAN_SCRIPT = `
T=""; if command -v timeout >/dev/null 2>&1; then T="timeout 20"; fi
list=$(mktemp 2>/dev/null || echo /tmp/gm-runners-$$)
: > "$list"
for a in "$@"; do
  depth=\${a%%:*}; r=\${a#*:}
  case "$r" in "~"*) r="$HOME\${r#\\~}";; esac
  [ -d "$r" ] || { printf '@@ROOT %s missing\n' "$r"; continue; }
  printf '@@ROOT %s ok\n' "$r"
  if [ "$depth" = "0" ]; then printf '%s\n' "$r" >> "$list"
  elif [ "$depth" = "1" ]; then
    for d in "$r"/*runner* "$r"/actions-runner; do [ -d "$d" ] && { [ -f "$d/.runner" ] || [ -f "$d/config.sh" ]; } && printf '%s\n' "$d" >> "$list"; done
  else
    $T find "$r" -mindepth 1 -maxdepth "$depth" \\( -type d \\( -name '.*' -o -name node_modules -o -name _work -o -name _diag -o -name externals -o -name bin -o -name snap -o -name Library -o -name proc -o -name sys \\) -prune \\) -o -type f \\( -name .runner -o -name config.sh \\) -print 2>/dev/null | head -n 400 | while IFS= read -r f; do dirname "$f"; done >> "$list"
  fi
done
for u in /etc/systemd/system/actions.runner.*.service; do [ -f "$u" ] && sed -n 's/^WorkingDirectory=//p' "$u" | head -n1 >> "$list"; done
for p in "$HOME"/Library/LaunchAgents/actions.runner.*.plist; do [ -f "$p" ] && awk '/<key>WorkingDirectory<\/key>/{getline; gsub(/.*<string>|<\/string>.*/,""); print; exit}' "$p" >> "$list"; done
sort -u "$list" | head -n 200 | while IFS= read -r d; do
  [ -d "$d" ] || continue
  if [ ! -f "$d/.runner" ] && ! { [ -f "$d/config.sh" ] && [ -e "$d/bin/Runner.Listener" ]; }; then continue; fi
  printf '@@DIR %s\n' "$d"
  [ -f "$d/.runner" ] && printf '@@RUNNER %s\n' "$(base64 < "$d/.runner" 2>/dev/null | tr -d '\n')"
  [ -f "$d/.service" ] && printf '@@SERVICE %s\n' "$(head -c 300 "$d/.service" | tr -d '\\r\\n')"
  [ -e "$d/.credentials" ] && echo '@@CREDS yes'
  [ -e "$d/bin/Runner.Listener" ] && echo '@@LISTENER yes'
  [ -f "$d/config.sh" ] && echo '@@CONFIG yes'
  v=$(cd "$d" && $T ./bin/Runner.Listener --version 2>/dev/null | head -n1 | tr -d '\r')
  if [ -n "$v" ]; then printf '@@VERSION %s\n' "$v"; else
    v=$(ls -t "$d"/_diag/Runner_*.log 2>/dev/null | head -n1); [ -n "$v" ] && printf '@@DIAGVERSION %s\n' "$(grep -m1 -o 'Version: *[0-9][0-9.]*' "$v" 2>/dev/null | head -n1)"
  fi
  s=$(head -c 300 "$d/.service" 2>/dev/null | tr -d '\\r\\n')
  case "$s" in
    "") ;;
    *.plist) l=$(basename "$s" .plist); o=$(launchctl list "$l" 2>&1); printf '@@LAUNCHD %s %s\n' "$?" "$(printf '%s' "$o" | tr '\n' ' ' | head -c 400)";;
    *) case "$s" in /*) s=$(basename "$s");; esac
       if command -v systemctl >/dev/null 2>&1; then a=$(systemctl is-active "$s" 2>&1 | head -n1); e=$(systemctl is-enabled "$s" 2>&1 | head -n1); printf '@@SYSTEMD %s\t%s\n' "$a" "$e"; else printf '@@SYSTEMD nosystemctl\tnosystemctl\n'; fi;;
  esac
  if [ -d /proc/1 ]; then
    for p in /proc/[0-9]*; do c=$(cat "$p/comm" 2>/dev/null); [ "$c" = "Runner.Listener" ] || continue; w=$(readlink "$p/cwd" 2>/dev/null); [ "$w" = "$d" ] && printf '@@PID %s\n' "\${p#/proc/}"; done
  else
    ps -axo pid=,args= 2>/dev/null | grep -F "$d/bin/Runner.Listener" | grep -v grep | awk '{print "@@PID " $1}'
  fi
  echo '@@END'
done
rm -f "$list" 2>/dev/null
exit 0
`

export type ScanRecord = { dir: string; runner: RunnerFile | null; runnerRaw: boolean; service: string | null; creds: boolean; listener: boolean; config: boolean; version: string | null; versionSource: 'listener' | 'diag' | null; systemd: [string, string] | null; launchd: { code: number; text: string } | null; pids: number[] }

export function parsePosixScan(out: string): { roots: { path: string; ok: boolean }[]; records: ScanRecord[] } {
  const roots: { path: string; ok: boolean }[] = []
  const records: ScanRecord[] = []
  let cur: ScanRecord | null = null
  for (const raw of out.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.startsWith('@@ROOT ')) { const m = /^@@ROOT (.*) (ok|missing)$/.exec(line); if (m) roots.push({ path: m[1], ok: m[2] === 'ok' }); continue }
    if (line.startsWith('@@DIR ')) { cur = { dir: line.slice(6), runner: null, runnerRaw: false, service: null, creds: false, listener: false, config: false, version: null, versionSource: null, systemd: null, launchd: null, pids: [] }; continue }
    if (!cur) continue
    if (line === '@@END') { records.push(cur); cur = null; continue }
    if (line.startsWith('@@RUNNER ')) { cur.runnerRaw = true; try { cur.runner = parseRunnerFile(Buffer.from(line.slice(9), 'base64').toString('utf8')) } catch { cur.runner = null } }
    else if (line.startsWith('@@SERVICE ')) cur.service = line.slice(10) || null
    else if (line === '@@CREDS yes') cur.creds = true
    else if (line === '@@LISTENER yes') cur.listener = true
    else if (line === '@@CONFIG yes') cur.config = true
    else if (line.startsWith('@@VERSION ')) { const v = versionFromText(line.slice(10)); if (v) { cur.version = v; cur.versionSource = 'listener' } }
    else if (line.startsWith('@@DIAGVERSION ')) { const v = versionFromText(line.slice(14)); if (v && !cur.version) { cur.version = v; cur.versionSource = 'diag' } }
    else if (line.startsWith('@@SYSTEMD ')) { const p = line.slice(10).split('\t'); cur.systemd = [p[0] ?? '', p[1] ?? ''] }
    else if (line.startsWith('@@LAUNCHD ')) { const m = /^@@LAUNCHD (\d+) ?(.*)$/.exec(line); if (m) cur.launchd = { code: Number(m[1]), text: m[2] } }
    else if (line.startsWith('@@PID ')) { const n = Number(line.slice(6)); if (Number.isInteger(n) && n > 0) cur.pids.push(n) }
  }
  return { roots, records }
}

export function systemdService(name: string, active: string, enabled: string): LocalService {
  if (active === 'nosystemctl') return { kind: 'systemd', name, state: 'unknown', startup: 'unknown', detail: 'systemctl is not available here (no systemd), so the service state cannot be read.' }
  if (/not been booted with systemd|Failed to connect to bus/i.test(active)) return { kind: 'systemd', name, state: 'unknown', startup: 'unknown', detail: 'This system was not booted with systemd. In WSL, enable systemd in /etc/wsl.conf ([boot] systemd=true) and restart the distribution.' }
  const state = active === 'active' || active === 'activating' || active === 'reloading' ? 'running' : active === 'inactive' || active === 'failed' || active === 'deactivating' ? 'stopped' : /not-found|could not be found/i.test(active + enabled) ? 'not-installed' : 'unknown'
  const startup = enabled === 'enabled' || enabled === 'enabled-runtime' || enabled === 'alias' ? 'automatic' : enabled === 'disabled' ? 'disabled' : enabled === 'static' || enabled === 'indirect' ? 'manual' : 'unknown'
  return { kind: 'systemd', name, state, startup, detail: `systemctl: ${active}, ${enabled}` }
}

export function launchdService(label: string, code: number, text: string): LocalService {
  if (code !== 0) return { kind: 'launchd', name: label, state: /Could not find service/i.test(text) ? 'stopped' : 'unknown', startup: 'automatic', detail: text.trim() || `launchctl list exited with ${code}` }
  const pid = /"PID"\s*=\s*(\d+)/.exec(text)
  return { kind: 'launchd', name: label, state: pid ? 'running' : 'stopped', startup: 'automatic', detail: pid ? `launchd: running (pid ${pid[1]})` : 'launchd: loaded, not running' }
}

export function recordToLocal(rec: ScanRecord, shell: HostShell, probe: HostProbe | null, now: string): LocalRunner {
  const os: RunnerOs = probe?.os && probe.os !== 'unknown' ? probe.os : shell.os
  const svcFile = parseServiceFile(rec.service)
  let service: LocalService = { kind: 'none', name: null, state: 'not-installed', startup: 'not-applicable', detail: null }
  if (svcFile?.kind === 'systemd' && rec.systemd) service = systemdService(svcFile.name, rec.systemd[0], rec.systemd[1])
  else if (svcFile?.kind === 'launchd' && rec.launchd) service = launchdService(svcFile.name, rec.launchd.code, rec.launchd.text)
  else if (svcFile) service = { kind: svcFile.kind, name: svcFile.name, state: 'unknown', startup: 'unknown', detail: 'The service is recorded but its state could not be read.' }
  const warnings: string[] = []
  if (rec.runnerRaw && !rec.runner) warnings.push('The .runner file could not be parsed.')
  if (rec.runner && !rec.creds) warnings.push('Registered, but the credentials file is missing: the runner cannot connect until it is configured again.')
  if (rec.runner?.gitHubUrl && !scopeFromUrl(rec.runner.gitHubUrl)) warnings.push(`Registered with ${rec.runner.gitHubUrl}, which is not github.com; GitManager cannot read that server.`)
  const configured = !!rec.runner
  return {
    key: installKey(shell.host, rec.dir), host: shell.host, path: normalizePath(rec.dir, 'posix'), os, arch: probe?.arch ?? 'unknown', machine: probe?.machine ?? null,
    agentId: rec.runner?.agentId ?? null, agentName: rec.runner?.agentName ?? null, scope: scopeFromUrl(rec.runner?.gitHubUrl) as RunnerScope | null, gitHubUrl: rec.runner?.gitHubUrl ?? null,
    poolName: rec.runner?.poolName ?? null, ephemeral: rec.runner?.ephemeral ?? null, disableUpdate: rec.runner?.disableUpdate ?? null, workFolder: rec.runner?.workFolder ?? null,
    version: rec.version, versionSource: rec.versionSource, service,
    process: { running: rec.pids.length > 0 || service.state === 'running' ? true : service.kind === 'launchd' || service.kind === 'systemd' ? false : rec.pids.length ? true : false, pids: rec.pids, detail: rec.pids.length ? `Runner.Listener running from this folder (pid ${rec.pids.join(', ')})` : null },
    configured, hasCredentials: rec.creds, partial: !configured && (rec.listener || rec.config), warnings, inspectedAt: now, source: 'scan',
  }
}

async function discoverPosix(shell: HostShell, probe: HostProbe | null, roots: string[], opts: DiscoverOptions): Promise<{ installs: LocalRunner[]; roots: string[]; message: string | null; ok: boolean }> {
  const r = await shell.script(POSIX_SCAN_SCRIPT, roots, { timeoutMs: opts.deadlineMs ?? 90_000 })
  if (r.spawnError) return { installs: [], roots: [], ok: false, message: shell.host.kind === 'wsl' ? 'WSL is not available (wsl.exe was not found).' : shell.host.kind === 'ssh' ? 'The ssh command was not found.' : `Could not start the scan: ${r.spawnError}` }
  if (r.timedOut && !r.stdout) return { installs: [], roots: [], ok: false, message: 'The scan did not finish in time.' }
  if (r.code !== 0 && !r.stdout.includes('@@ROOT')) return { installs: [], roots: [], ok: false, message: r.stderr.trim() || `The scan failed with exit code ${r.code}.` }
  const parsed = parsePosixScan(r.stdout)
  const now = new Date(opts.now?.() ?? Date.now()).toISOString()
  const installs = parsed.records.map(rec => recordToLocal(rec, shell, probe, now))
  return { installs: dedupe(installs), roots: [...new Set(parsed.roots.filter(x => x.ok).map(x => x.path))], ok: true, message: r.timedOut ? 'The scan ran out of time; results may be incomplete.' : null }
}

/* ------------------------------------------------------------ Windows (this computer) */

export function parseScQuery(out: string): { name: string; state: string }[] {
  const list: { name: string; state: string }[] = []
  let name: string | null = null
  for (const line of out.split(/\r?\n/)) {
    const n = /^\s*SERVICE_NAME:\s*(.+?)\s*$/.exec(line)
    if (n) { name = n[1]; continue }
    const s = /^\s*STATE\s*:\s*\d+\s+(\w+)/.exec(line)
    if (s && name) { list.push({ name, state: s[1] }); name = null }
  }
  return list
}

export function parseScQc(out: string): { startType: string | null; binaryPath: string | null } {
  const st = /START_TYPE\s*:\s*\d+\s+([A-Z_]+(?:\s+\(DELAYED\))?)/.exec(out)
  const bp = /BINARY_PATH_NAME\s*:\s*(.+?)\s*$/m.exec(out)
  return { startType: st ? st[1] : null, binaryPath: bp ? bp[1].trim() : null }
}

export function windowsService(name: string, state: string | null, startType: string | null): LocalService {
  const st = (state ?? '').toUpperCase()
  const run = st === 'RUNNING' || st === 'START_PENDING' || st === 'CONTINUE_PENDING' ? 'running' : st === 'STOPPED' || st === 'STOP_PENDING' || st === 'PAUSED' ? 'stopped' : state === null ? 'not-installed' : 'unknown'
  const t = (startType ?? '').toUpperCase()
  const startup = t.startsWith('AUTO_START') ? 'automatic' : t === 'DEMAND_START' ? 'manual' : t === 'DISABLED' ? 'disabled' : 'unknown'
  return { kind: 'windows-service', name, state: run, startup, detail: state ? `Windows service: ${state}${startType ? `, ${startType}` : ''}` : 'No Windows service with this name is registered.' }
}

/** Directory of a runner from the service binary path (<dir>\bin\RunnerService.exe), quotes removed. */
export function dirFromServiceBinary(binaryPath: string | null): string | null {
  if (!binaryPath) return null
  const p = binaryPath.trim().replace(/^"(.*?)"(\s.*)?$/, '$1')
  const m = /^(.*)[\\/]bin[\\/]RunnerService\.exe$/i.exec(p)
  return m ? normalizePath(m[1], 'win32') : null
}

const PS_PROCS = 'Get-CimInstance Win32_Process -Filter "Name=\'Runner.Listener.exe\'" | ForEach-Object { "$($_.ProcessId)`t$($_.ExecutablePath)" }'
export const encodedPowerShell = (script: string) => ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]

export function windowsDefaultRoots(env: NodeJS.ProcessEnv, drives: string[]): string[] {
  const out = drives.map(d => `2:${d}`)
  if (env.USERPROFILE) out.push(`2:${env.USERPROFILE}`)
  if (env.ProgramData) out.push(`2:${env.ProgramData}`)
  return out
}

async function discoverWindows(shell: HostShell, roots: string[], opts: DiscoverOptions): Promise<{ installs: LocalRunner[]; roots: string[]; message: string | null; ok: boolean }> {
  const deadline = (opts.now?.() ?? Date.now()) + (opts.deadlineMs ?? 90_000)
  const candidates = new Map<string, string>()
  const add = (p: string) => { const n = normalizePath(p, 'win32'); candidates.set(n.toLowerCase(), n) }
  const scanned: string[] = []
  // 1. Registered services: the authoritative list of service-managed runners, with their folders.
  const services = new Map<string, { state: string; startType: string | null; dir: string | null }>()
  const q = await shell.run('sc.exe', ['query', 'type=', 'service', 'state=', 'all'], { timeoutMs: 30_000, maxBytes: 8 * 1024 * 1024 })
  if (!q.spawnError && q.code === 0) {
    for (const s of parseScQuery(q.stdout).filter(x => /^actions\.runner\./i.test(x.name))) {
      const qc = await shell.run('sc.exe', ['qc', s.name], { timeoutMs: 15_000 })
      const info = parseScQc(qc.stdout)
      const dir = dirFromServiceBinary(info.binaryPath)
      services.set(s.name.toLowerCase(), { state: s.state, startType: info.startType, dir })
      if (dir) add(dir)
    }
  }
  // 2. Folders: a .runner file or the runner program next to config.cmd, at most two levels below each root.
  const looksLike = async (dir: string) => (await shell.exists(path.win32.join(dir, '.runner'))) || ((await shell.exists(path.win32.join(dir, 'config.cmd'))) && (await shell.exists(path.win32.join(dir, 'bin', 'Runner.Listener.exe'))))
  for (const spec of roots) {
    if (opts.signal?.cancelled || (opts.now?.() ?? Date.now()) > deadline) break
    const depth = spec.startsWith('0:') ? 0 : Number(spec.split(':')[0]) || 2
    const root = normalizePath(spec.slice(spec.indexOf(':') + 1), 'win32')
    if (!(await shell.isDir(root))) continue
    scanned.push(root)
    if (await looksLike(root)) add(root)
    if (depth === 0) continue
    const level1 = (await shell.listDir(root)) ?? []
    for (const name of level1.filter(n => !/^(\$|\.|Windows$|Program Files|ProgramData$|System Volume|Recovery$|PerfLogs$|AppData$|node_modules$)/i.test(n)).slice(0, 400)) {
      const d1 = path.win32.join(root, name)
      if (!(await shell.isDir(d1))) continue
      if (await looksLike(d1)) { add(d1); continue }
      if (depth < 2 || !/runner|actions|github|ci|agent|build/i.test(name)) continue
      for (const n2 of ((await shell.listDir(d1)) ?? []).filter(n => !n.startsWith('.')).slice(0, 200)) {
        const d2 = path.win32.join(d1, n2)
        if ((await shell.isDir(d2)) && (await looksLike(d2))) add(d2)
      }
    }
  }
  // 3. Running listeners, identified by executable path.
  const procs: { pid: number; exe: string }[] = []
  const ps = await shell.run('powershell.exe', encodedPowerShell(PS_PROCS), { timeoutMs: 30_000 })
  if (!ps.spawnError && ps.code === 0) for (const line of ps.stdout.split(/\r?\n/)) { const m = /^(\d+)\t(.+)$/.exec(line.trim()); if (m) procs.push({ pid: Number(m[1]), exe: normalizePath(m[2], 'win32') }) }
  const now = new Date(opts.now?.() ?? Date.now()).toISOString()
  const installs: LocalRunner[] = []
  for (const dir of candidates.values()) {
    const runner = parseRunnerFile(await shell.readFile(path.win32.join(dir, '.runner')))
    const runnerRaw = await shell.exists(path.win32.join(dir, '.runner'))
    const svcFile = parseServiceFile(await shell.readFile(path.win32.join(dir, '.service')))
    const listener = await shell.exists(path.win32.join(dir, 'bin', 'Runner.Listener.exe'))
    const creds = await shell.exists(path.win32.join(dir, '.credentials'))
    let version: string | null = null, versionSource: LocalRunner['versionSource'] = null
    if (listener) {
      const v = await shell.run(path.win32.join(dir, 'bin', 'Runner.Listener.exe'), ['--version'], { cwd: dir, timeoutMs: 20_000 })
      version = versionFromText(v.stdout); if (version) versionSource = 'listener'
    }
    if (!version) {
      const logs = ((await shell.listDir(path.win32.join(dir, '_diag'))) ?? []).filter(f => /^Runner_.*\.log$/i.test(f)).sort().reverse()
      if (logs[0]) { version = versionFromText(/Version: *([0-9.]+)/.exec((await shell.readFile(path.win32.join(dir, '_diag', logs[0]), 64 * 1024)) ?? '')?.[1]); if (version) versionSource = 'diag' }
    }
    let service: LocalService = { kind: 'none', name: null, state: 'not-installed', startup: 'not-applicable', detail: null }
    let svcName = svcFile?.name ?? null
    if (!svcName) { const byDir = [...services.entries()].find(([, s]) => s.dir && s.dir.toLowerCase() === dir.toLowerCase()); if (byDir) svcName = byDir[0] }
    if (svcName) {
      const s = services.get(svcName.toLowerCase())
      if (s) service = windowsService(svcName, s.state, s.startType)
      else {
        const one = await shell.run('sc.exe', ['query', svcName], { timeoutMs: 15_000 })
        const st = parseScQuery(one.stdout)[0]
        const qc = st ? parseScQc((await shell.run('sc.exe', ['qc', svcName], { timeoutMs: 15_000 })).stdout) : { startType: null }
        service = windowsService(svcName, st?.state ?? null, qc.startType)
      }
    }
    const pids = procs.filter(p => p.exe.toLowerCase().startsWith(dir.toLowerCase() + '\\')).map(p => p.pid)
    const warnings: string[] = []
    if (runnerRaw && !runner) warnings.push('The .runner file could not be parsed.')
    if (runner && !creds) warnings.push('Registered, but the credentials file is missing: the runner cannot connect until it is configured again.')
    if (runner?.gitHubUrl && !scopeFromUrl(runner.gitHubUrl)) warnings.push(`Registered with ${runner.gitHubUrl}, which is not github.com; GitManager cannot read that server.`)
    installs.push({
      key: installKey(shell.host, dir), host: shell.host, path: dir, os: 'windows', arch: archFromNode(process.arch), machine: hostname(),
      agentId: runner?.agentId ?? null, agentName: runner?.agentName ?? null, scope: scopeFromUrl(runner?.gitHubUrl), gitHubUrl: runner?.gitHubUrl ?? null, poolName: runner?.poolName ?? null,
      ephemeral: runner?.ephemeral ?? null, disableUpdate: runner?.disableUpdate ?? null, workFolder: runner?.workFolder ?? null, version, versionSource, service,
      process: { running: pids.length > 0 || service.state === 'running', pids, detail: pids.length ? `Runner.Listener.exe running from this folder (pid ${pids.join(', ')})` : null },
      configured: !!runner, hasCredentials: creds, partial: !runner && listener, warnings, inspectedAt: now, source: 'scan',
    })
  }
  return { installs: dedupe(installs), roots: scanned, ok: true, message: null }
}

/* ------------------------------------------------------------ entry point */

export function dedupe(list: LocalRunner[]): LocalRunner[] {
  const seen = new Map<string, LocalRunner>()
  for (const l of list) if (!seen.has(l.key)) seen.set(l.key, l)
  return [...seen.values()]
}

export type HostDiscovery = { installs: LocalRunner[]; result: HostResult; probe: HostProbe | null }

/** Discovers installations on one host. Never throws; an unreachable host is reported as such with the reason. */
export async function discoverOnHost(shell: HostShell, probe: HostProbe | null, opts: DiscoverOptions = {}, env: NodeJS.ProcessEnv = process.env, drives: string[] = []): Promise<HostDiscovery> {
  const t0 = opts.now?.() ?? Date.now()
  const label = hostLabel(shell.host, probe?.os ?? shell.os)
  const done = (status: HostResult['status'], message: string | null, installs: LocalRunner[] = [], roots: string[] = []): HostDiscovery => ({ installs, probe, result: { host: shell.host, label, status, message, found: installs.length, roots, durationMs: (opts.now?.() ?? Date.now()) - t0 } })
  if (opts.signal?.cancelled) return done('cancelled', 'Cancelled before this host was inspected.')
  if (probe && !probe.reachable) return done('inaccessible', probe.message ?? 'The host could not be reached.')
  const os = probe?.os && probe.os !== 'unknown' ? probe.os : shell.os
  const userRoots = (opts.roots ?? []).filter(r => sameHost(r.host, shell.host)).map(r => `4:${r.path}`)
  try {
    if (os === 'windows' && shell.host.kind === 'native') {
      const r = await discoverWindows(shell, [...(opts.defaultRoots ?? windowsDefaultRoots(env, drives)), ...userRoots], opts)
      return done(r.ok ? 'ok' : 'error', r.message, r.installs, r.roots)
    }
    const r = await discoverPosix(shell, probe, [...(opts.defaultRoots ?? defaultRoots(os)), ...userRoots], opts)
    return done(r.ok ? 'ok' : shell.host.kind === 'native' ? 'error' : 'inaccessible', r.message, r.installs, r.roots)
  } catch (e) {
    return done('error', (e as Error).message)
  }
}

/** Re-reads one installation directory (metadata, service state, processes). Null when it is no longer an installation. */
export async function inspectOne(shell: HostShell, probe: HostProbe | null, dir: string, opts: DiscoverOptions = {}, env: NodeJS.ProcessEnv = process.env): Promise<LocalRunner | null> {
  const os = probe?.os && probe.os !== 'unknown' ? probe.os : shell.os
  const r = os === 'windows' && shell.host.kind === 'native' ? await discoverWindows(shell, [`0:${dir}`], { ...opts, deadlineMs: opts.deadlineMs ?? 60_000 }) : await discoverPosix(shell, probe, [`0:${dir}`], { ...opts, deadlineMs: opts.deadlineMs ?? 60_000 })
  void env
  return r.installs[0] ?? null
}

export const archOfProbe = (p: HostProbe | null): RunnerArch => p?.arch ?? 'unknown'
export { archFromMachine }
