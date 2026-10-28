import path from 'node:path'
import type { Location, Runtime } from '../shared/types.js'

// Windows and WSL paths are different namespaces. A Location carries its namespace explicitly, and every
// conversion between the two goes through this module, so no caller ever guesses.

const WSL_UNC = /^[\\/]{2}wsl(?:\$|\.localhost)[\\/]([^\\/]+)(?:[\\/](.*))?$/i
const DRIVE = /^([a-zA-Z]):(?:[\\/](.*))?$/
const UNC = /^[\\/]{2}[^\\/]+[\\/][^\\/]+/

export type PathFlavor = 'win32' | 'posix'

/** Which path syntax a native path uses: drive letters and UNC shares are Windows, everything else POSIX. */
export function flavorOf(p: string): PathFlavor {
  return DRIVE.test(p) || UNC.test(p) ? 'win32' : 'posix'
}

const lib = (f: PathFlavor) => (f === 'win32' ? path.win32 : path.posix)

/** Strips trailing separators (but keeps a drive or POSIX root) and normalizes separators for the flavor. */
export function normalizePath(p: string, flavor: PathFlavor = flavorOf(p)): string {
  let n = lib(flavor).normalize(p.trim())
  if (flavor === 'win32') n = n.replace(/\//g, '\\')
  const root = lib(flavor).parse(n).root
  while (n.length > root.length && /[\\/]$/.test(n)) n = n.slice(0, -1)
  return n
}

export type ParseResult = { ok: true; location: Location } | { ok: false; message: string }

/**
 * Turns what a user typed or picked into a Location.
 * - \\wsl.localhost\Ubuntu\home\me\app and \\wsl$\Ubuntu\... become WSL locations in that distribution.
 * - A POSIX path becomes a WSL location when a distribution is given (required on Windows).
 * - A drive path (C:\...) is a native Windows location.
 */
export function parseLocationInput(input: string, opts: { distro?: string; hostOs: 'windows' | 'mac' | 'linux' }): ParseResult {
  const raw = input.trim().replace(/^"(.*)"$/, '$1')
  if (!raw) return { ok: false, message: 'Enter a folder path.' }
  const unc = WSL_UNC.exec(raw)
  if (unc) {
    const linux = '/' + (unc[2] ?? '').replace(/\\/g, '/')
    return { ok: true, location: { kind: 'wsl', distro: unc[1], path: normalizePath(linux, 'posix') } }
  }
  if (raw.startsWith('/')) {
    if (opts.distro) return { ok: true, location: { kind: 'wsl', distro: opts.distro, path: normalizePath(raw, 'posix') } }
    if (opts.hostOs === 'windows') return { ok: false, message: 'Choose the WSL distribution that contains this Linux path.' }
    return { ok: true, location: { kind: 'native', path: normalizePath(raw, 'posix') } }
  }
  if (DRIVE.test(raw) || UNC.test(raw)) {
    if (opts.distro) return { ok: false, message: 'A Windows path cannot belong to a WSL distribution. Clear the distribution, or use the Linux path.' }
    return { ok: true, location: { kind: 'native', path: normalizePath(raw, 'win32') } }
  }
  return { ok: false, message: 'Use an absolute path, for example C:\\code\\app or /home/me/app.' }
}

/** C:\Users\me\app -> /mnt/c/Users/me/app. Returns null for paths WSL cannot address this way (network shares). */
export function windowsToWsl(p: string): string | null {
  const m = DRIVE.exec(normalizePath(p, 'win32'))
  if (!m) return null
  const rest = (m[2] ?? '').replace(/\\/g, '/')
  return normalizePath(`/mnt/${m[1].toLowerCase()}/${rest}`, 'posix')
}

/** /mnt/c/Users/me -> C:\Users\me. Returns null for paths inside the Linux filesystem. */
export function wslToWindowsDrive(p: string): string | null {
  const m = /^\/mnt\/([a-z])(?:\/(.*))?$/.exec(normalizePath(p, 'posix'))
  if (!m) return null
  return normalizePath(`${m[1].toUpperCase()}:\\${(m[2] ?? '').replace(/\//g, '\\')}`, 'win32')
}

/** The Windows UNC path that Explorer and editors use to reach a WSL path. */
export function wslUncPath(distro: string, linuxPath: string): string {
  return `\\\\wsl.localhost\\${distro}${normalizePath(linuxPath, 'posix').replace(/\//g, '\\')}`.replace(/\\$/, '')
}

export function displayLocation(loc: Location): string {
  return loc.kind === 'wsl' ? `${loc.distro}: ${loc.path}` : loc.path
}

export function sameLocation(a: Location, b: Location): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'wsl' && b.kind === 'wsl') return a.distro.toLowerCase() === b.distro.toLowerCase() && normalizePath(a.path, 'posix') === normalizePath(b.path, 'posix')
  const f = flavorOf(a.path)
  const na = normalizePath(a.path, f), nb = normalizePath(b.path, flavorOf(b.path))
  return f === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb
}

export function baseName(loc: Location): string {
  const f = loc.kind === 'wsl' ? 'posix' : flavorOf(loc.path)
  return lib(f).basename(normalizePath(loc.path, f)) || loc.path
}

export function locationRuntime(loc: Location): Runtime {
  return loc.kind === 'wsl' ? { kind: 'wsl', distro: loc.distro } : { kind: 'native' }
}

export function sameRuntime(a: Runtime, b: Runtime): boolean {
  return a.kind === b.kind && (a.kind === 'native' || (b.kind === 'wsl' && a.distro.toLowerCase() === b.distro.toLowerCase()))
}

export type DirResult = { ok: true; path: string } | { ok: false; message: string }

/**
 * Resolves the directory a service runs in, expressed in the runtime's own path syntax.
 * The base is the repository root; `parts` are relative segments (or absolute paths in the runtime's syntax).
 * Allowed: native repo + native runtime, WSL repo + same distribution, native Windows drive repo + WSL (via /mnt/x).
 * Refused: a WSL repository with a Windows runtime or another distribution (Windows tools cannot use a UNC working directory reliably).
 */
export function resolveRunDir(repo: Location, runtime: Runtime, ...parts: string[]): DirResult {
  let base: string
  let flavor: PathFlavor
  if (runtime.kind === 'wsl') {
    flavor = 'posix'
    if (repo.kind === 'wsl') {
      if (repo.distro.toLowerCase() !== runtime.distro.toLowerCase()) return { ok: false, message: `This repository lives in ${repo.distro}; its services must run in ${repo.distro}.` }
      base = repo.path
    } else {
      const converted = flavorOf(repo.path) === 'win32' ? windowsToWsl(repo.path) : null
      if (!converted) return { ok: false, message: 'WSL cannot reach this folder through /mnt. Run the services natively instead.' }
      base = converted
    }
  } else {
    if (repo.kind === 'wsl') return { ok: false, message: `This repository lives in WSL (${repo.distro}); choose that distribution as the runtime.` }
    base = repo.path
    flavor = flavorOf(repo.path)
  }
  let out = base
  for (const part of parts.map(p => p.trim()).filter(Boolean)) {
    if (flavor === 'posix' && part.startsWith('/')) out = part
    else if (flavor === 'win32' && (DRIVE.test(part) || UNC.test(part))) out = part
    else if (flavor === 'posix' && (DRIVE.test(part) || part.includes('\\'))) return { ok: false, message: `"${part}" is a Windows path; WSL services need Linux paths.` }
    else out = lib(flavor).join(out, part)
  }
  return { ok: true, path: normalizePath(out, flavor) }
}
