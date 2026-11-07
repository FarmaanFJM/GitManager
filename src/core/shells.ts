// Which shells exist on this computer, and the exact process to start for a shell in a folder.
//
// Everything that starts a terminal goes through planShell, which returns an argument array (file, args, cwd, env). A path
// is never spliced into a command string: the only text that reaches a shell as code is a constant script, and the one
// place where a path must be handed to PowerShell (a UNC working directory) passes it in an environment variable.
import os from 'node:os'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { Location } from '../shared/types.js'
import type { ShellOption } from '../shared/terminal.js'
import { listWslDistros, type Distro } from './exec.js'
import { flavorOf, normalizePath, windowsToWsl } from './paths.js'
import { distro as validateDistro, ValidationError } from './validate.js'

export type ShellDeps = {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  fileExists: (p: string) => boolean | Promise<boolean>
  listDistros: () => Promise<{ available: boolean; distros: Distro[]; error?: string }>
  homeDir: () => string
}

export const defaultShellDeps = (): ShellDeps => ({
  platform: process.platform,
  env: process.env,
  fileExists: p => existsSync(p),
  listDistros: () => listWslDistros(),
  homeDir: () => os.homedir(),
})

/* ------------------------------------------------------------ detection */

const envGet = (env: NodeJS.ProcessEnv, name: string): string | undefined => {
  // Windows environment variable names are case-insensitive; process.env already is, a plain object is not.
  const key = Object.keys(env).find(k => k.toLowerCase() === name.toLowerCase())
  return key ? env[key] : undefined
}

export const wslShellId = (distro: string) => `wsl:${distro}`

/**
 * Available shells, in the order the picker should show them. On Windows: Windows PowerShell, PowerShell 7 (both are listed,
 * with `available: false` and a reason when missing so the UI can say so), then one entry per WSL distribution reported by
 * `wsl.exe --list` (never hardcoded; Docker Desktop internals are already skipped by parseWslList). Elsewhere: the login
 * shell from $SHELL, else /bin/bash, else /bin/sh.
 */
export async function detectShells(partial: Partial<ShellDeps> = {}): Promise<ShellOption[]> {
  const d = { ...defaultShellDeps(), ...partial }
  const out: ShellOption[] = []
  if (d.platform === 'win32') {
    const w = path.win32
    const sysRoot = envGet(d.env, 'SystemRoot') ?? envGet(d.env, 'windir') ?? 'C:\\Windows'
    const winPs = w.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    out.push((await d.fileExists(winPs))
      ? { id: 'powershell', kind: 'powershell', label: 'Windows PowerShell', available: true, executable: winPs }
      : { id: 'powershell', kind: 'powershell', label: 'Windows PowerShell', available: false, detail: 'powershell.exe was not found.' })

    const candidates: string[] = []
    for (const dir of (envGet(d.env, 'PATH') ?? '').split(';').map(s => s.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean)) candidates.push(w.join(dir, 'pwsh.exe'))
    for (const pf of [envGet(d.env, 'ProgramW6432'), envGet(d.env, 'ProgramFiles'), 'C:\\Program Files']) if (pf) candidates.push(w.join(pf, 'PowerShell', '7', 'pwsh.exe'))
    let pwsh: string | undefined
    for (const c of candidates) if (await d.fileExists(c)) { pwsh = c; break }
    out.push(pwsh
      ? { id: 'pwsh', kind: 'pwsh', label: 'PowerShell 7', available: true, executable: pwsh }
      : { id: 'pwsh', kind: 'pwsh', label: 'PowerShell 7', available: false, detail: 'pwsh.exe was not found on PATH or in Program Files.' })

    let wsl: Awaited<ReturnType<ShellDeps['listDistros']>> | null = null
    try { wsl = await d.listDistros() } catch { wsl = null }
    for (const dist of wsl?.distros ?? []) {
      // A name that fails the distribution validator is never passed to wsl.exe.
      if (!validDistroName(dist.name)) continue
      out.push({
        id: wslShellId(dist.name), kind: 'wsl', label: `WSL: ${dist.name}`, distro: dist.name, available: true,
        detail: `${dist.isDefault ? 'default, ' : ''}${dist.state.toLowerCase()}${dist.version ? `, WSL ${dist.version}` : ''}`,
      })
    }
    return out
  }
  // macOS and Linux
  const shell = d.env.SHELL
  const candidates = [shell && path.posix.isAbsolute(shell) ? shell : null, '/bin/bash', '/bin/sh'].filter((x): x is string => !!x)
  for (const c of candidates) {
    if (await d.fileExists(c)) { out.push({ id: 'posix', kind: 'posix', label: `${path.posix.basename(c)} (login shell)`, available: true, executable: c }); break }
  }
  if (!out.length) out.push({ id: 'posix', kind: 'posix', label: 'Shell', available: false, detail: 'No shell was found (checked $SHELL, /bin/bash and /bin/sh).' })
  return out
}

export function validDistroName(name: string): boolean {
  if (name.startsWith('-')) return false // never readable as an option, whatever wsl.exe does with the value after -d
  try { validateDistro(name); return true } catch (e) { if (e instanceof ValidationError) return false; throw e }
}

/* ------------------------------------------------------------ locations */

export type LocationResult = { ok: true; location: Location } | { ok: false; message: string }

/** A folder inside a location. `subpath` is relative; absolute paths, drive letters and `..` are refused so it can never leave the repository. */
export function locationWithSubpath(loc: Location, subpath: string | undefined): LocationResult {
  const sub = (subpath ?? '').trim()
  if (!sub || sub === '.') return { ok: true, location: loc }
  if (/[\x00-\x1f]/.test(sub)) return { ok: false, message: 'The folder contains control characters.' } // eslint-disable-line no-control-regex
  if (sub.startsWith('/') || sub.startsWith('\\') || /^[A-Za-z]:/.test(sub)) return { ok: false, message: 'The folder must be relative to the repository.' }
  const segs = sub.split(/[\\/]/).filter(s => s && s !== '.')
  if (segs.some(s => s === '..')) return { ok: false, message: 'The folder must stay inside the repository.' }
  const lib = loc.kind === 'wsl' || flavorOf(loc.path) === 'posix' ? path.posix : path.win32
  const joined = normalizePath(lib.join(loc.path, ...segs), lib === path.posix ? 'posix' : 'win32')
  return { ok: true, location: loc.kind === 'wsl' ? { kind: 'wsl', distro: loc.distro, path: joined } : { kind: 'native', path: joined } }
}

const WSL_UNC = /^[\\/]{2}wsl(?:\$|\.localhost)[\\/]([^\\/]+)(?:[\\/](.*))?$/i
const DRIVE = /^[A-Za-z]:(?:[\\/]|$)/

/** The same folder as seen by a WSL distribution, or the reason it cannot be reached from there. */
function toWslPath(loc: Location, distro: string): { ok: true; path: string } | { ok: false; message: string } {
  if (loc.kind === 'wsl') {
    if (loc.distro.toLowerCase() !== distro.toLowerCase()) return { ok: false, message: `This folder lives in ${loc.distro}. Open it in a ${loc.distro} shell: another distribution cannot reach it by a path.` }
    return { ok: true, path: loc.path }
  }
  const unc = WSL_UNC.exec(loc.path)
  if (unc) {
    if (unc[1].toLowerCase() !== distro.toLowerCase()) return { ok: false, message: `This folder lives in ${unc[1]}. Open it in a ${unc[1]} shell.` }
    return { ok: true, path: normalizePath('/' + (unc[2] ?? '').replace(/\\/g, '/'), 'posix') }
  }
  if (DRIVE.test(loc.path)) {
    const p = windowsToWsl(loc.path)
    if (p) return { ok: true, path: p }
  }
  if (flavorOf(loc.path) === 'win32') return { ok: false, message: 'A network share cannot be opened in WSL. Use PowerShell, or map the share to a drive letter first.' }
  return { ok: false, message: 'This is not a Windows path, so a WSL shell cannot translate it.' }
}

/** Why `shell` cannot open `loc`, or null when it can. The same rules planShell enforces; used to filter and choose defaults. */
export function shellCannotOpen(shell: ShellOption, loc: Location, platform: NodeJS.Platform = process.platform): string | null {
  if (!shell.available) return shell.detail ?? 'This shell is not available.'
  if (shell.kind === 'wsl') {
    if (platform !== 'win32') return 'WSL is available on Windows only.'
    if (!shell.distro || !validDistroName(shell.distro)) return 'The WSL distribution name is invalid.'
    const r = toWslPath(loc, shell.distro)
    return r.ok ? null : r.message
  }
  if (shell.kind === 'posix') {
    if (platform === 'win32') return 'A POSIX shell is not available on Windows.'
    if (loc.kind === 'wsl' || flavorOf(loc.path) !== 'posix') return 'This folder is not on this computer\'s file system.'
    return null
  }
  // PowerShell (Windows PowerShell or 7)
  if (loc.kind === 'native') return flavorOf(loc.path) === 'win32' ? null : 'This is a Linux path; PowerShell on Windows cannot open it.'
  return null // a WSL folder opens through its UNC path, see planShell
}

/* ------------------------------------------------------------ environment */

/** Variables that describe GitManager itself (Electron, npm scripts that started it, the dev server), not the user's session. */
const APP_ENV = /^(ELECTRON_|npm_|NODE_OPTIONS$|NODE_ENV$|VITE_|CHROME_|GITMANAGER_|ORIGINAL_XDG_CURRENT_DESKTOP$)/i
/** Names that look like credentials; not forwarded to a WSL launch even though wsl.exe itself only forwards WSLENV entries. */
const SECRET_ENV = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_?KEY|^WSLENV$)/i

export function terminalEnvironment(base: NodeJS.ProcessEnv, kind: ShellOption['kind'], extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || APP_ENV.test(k)) continue
    if (kind === 'wsl' && SECRET_ENV.test(k)) continue
    env[k] = v
  }
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  return { ...env, ...extra }
}

/* ------------------------------------------------------------ planning */

/** Exactly what to spawn. `display` is the starting folder for the UI (never used to build a command). */
export type ShellPlan = {
  file: string
  args: string[]
  /** Working directory of the spawned process (a local directory that exists; never a UNC path). */
  cwd: string
  env: Record<string, string>
  display: string
  shell: ShellOption
  notes: string[]
}

export type PlanOptions = {
  shell: ShellOption
  location: Location
  /** WSL only: run as this user (`wsl.exe -u`). Must be a plain account name; 'root' is refused (no elevation from here). */
  wslUser?: string | null
  deps?: Partial<Pick<ShellDeps, 'platform' | 'env' | 'homeDir' | 'fileExists'>>
}

export type PlanResult = { ok: true; plan: ShellPlan } | { ok: false; message: string }

const USER_NAME = /^[A-Za-z_][A-Za-z0-9._-]{0,63}$/

/** Constant PowerShell script that moves into the folder named by an environment variable, then removes the variable. */
const PS_ENTER_FOLDER = 'Set-Location -LiteralPath $env:GITMANAGER_START_DIR; Remove-Item Env:GITMANAGER_START_DIR'

export function planShell(opts: PlanOptions): PlanResult {
  const { shell, location } = opts
  const d = { ...defaultShellDeps(), ...opts.deps }
  const refuse = shellCannotOpen(shell, location, d.platform)
  if (refuse) return { ok: false, message: refuse }
  const home = d.homeDir()

  if (shell.kind === 'wsl') {
    const distro = shell.distro as string
    const target = toWslPath(location, distro)
    if (!target.ok) return { ok: false, message: target.message }
    if (!target.path.startsWith('/') || /[\x00-\x1f]/.test(target.path)) return { ok: false, message: 'The folder path is invalid.' } // eslint-disable-line no-control-regex
    const user = opts.wslUser ?? null
    if (user !== null) {
      if (!USER_NAME.test(user)) return { ok: false, message: 'The WSL user name is invalid.' }
      if (user === 'root') return { ok: false, message: 'A terminal does not open as root. Open it as your own user and elevate there yourself.' }
    }
    // No command is given, so wsl.exe starts the user's interactive login shell. --cd takes the Linux path as one argument.
    // The spawn cwd is the Windows home folder: wsl.exe needs a local directory, and --cd does the real work.
    const notes = location.kind === 'native' ? [`Windows folder opened as ${target.path} (through /mnt).`] : []
    return {
      ok: true,
      plan: {
        file: shell.executable ?? 'wsl.exe', args: ['-d', distro, '--cd', target.path, ...(user ? ['-u', user] : [])], cwd: home,
        env: terminalEnvironment(d.env, 'wsl'), display: `${distro}:${target.path}`, shell, notes,
      },
    }
  }

  if (shell.kind === 'posix') {
    const p = (location as { path: string }).path
    return { ok: true, plan: { file: shell.executable ?? '/bin/sh', args: d.platform === 'darwin' ? ['-l'] : [], cwd: p, env: terminalEnvironment(d.env, 'posix'), display: p, shell, notes: [] } }
  }

  // PowerShell. A drive-letter folder is the process working directory.
  const file = shell.executable ?? (shell.kind === 'pwsh' ? 'pwsh.exe' : 'powershell.exe')
  if (location.kind === 'native') {
    return { ok: true, plan: { file, args: ['-NoLogo'], cwd: location.path, env: terminalEnvironment(d.env, shell.kind), display: location.path, shell, notes: [] } }
  }
  // A WSL folder: Windows cannot use \\wsl.localhost\... as a process working directory (CreateProcess falls back to the
  // Windows directory and cmd.exe refuses UNC), but PowerShell's own Set-Location accepts it. So the process starts in the
  // home folder and a constant script changes into the folder named by GITMANAGER_START_DIR; the path is never part of the
  // script text. Git for Windows against a WSL repository is slow and can misread permissions, hence the note.
  const unc = `\\\\wsl.localhost\\${location.distro}${location.path.replace(/\//g, '\\')}`.replace(/\\$/, '')
  return {
    ok: true,
    plan: {
      file, args: ['-NoLogo', '-NoExit', '-Command', PS_ENTER_FOLDER], cwd: home,
      env: terminalEnvironment(d.env, shell.kind, { GITMANAGER_START_DIR: unc }), display: unc, shell,
      notes: [`This folder is in WSL (${location.distro}). Windows tools see it through a network path; prefer the WSL: ${location.distro} shell for Git and build commands.`],
    },
  }
}

/* ------------------------------------------------------------ choosing */

/**
 * The shell to open for a folder. A saved per-repository preference wins when that shell is still available and can open the
 * folder. Otherwise: a WSL folder uses its own distribution; a native Windows folder uses PowerShell 7, then Windows
 * PowerShell; a native POSIX folder uses the login shell. When the preferred default cannot be used, the first shell that
 * can open the folder is chosen. Null when none can.
 */
export function preferredShellFor(location: Location, savedPreference: string | null | undefined, available: ShellOption[], platform: NodeJS.Platform = process.platform): ShellOption | null {
  const usable = available.filter(s => s.available && shellCannotOpen(s, location, platform) === null)
  if (savedPreference) {
    const saved = usable.find(s => s.id.toLowerCase() === savedPreference.toLowerCase())
    if (saved) return saved
  }
  if (location.kind === 'wsl') {
    const own = usable.find(s => s.kind === 'wsl' && s.distro?.toLowerCase() === location.distro.toLowerCase())
    if (own) return own
  }
  for (const kind of ['pwsh', 'powershell', 'posix', 'wsl'] as const) {
    const s = usable.find(x => x.kind === kind)
    if (s) return s
  }
  return null
}
