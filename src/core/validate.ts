import type { Browser, Location, Profile, Readiness, Runtime, ServiceDef, Settings } from '../shared/types.js'

// Validation for everything that crosses a trust boundary: IPC arguments from the renderer and the config file on disk.
// Each function returns a cleaned copy or throws ValidationError with a message fit for the user.

export class ValidationError extends Error {}

const fail = (m: string): never => { throw new ValidationError(m) }
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function str(v: unknown, name: string, { max = 4096, allowEmpty = true } = {}): string {
  if (typeof v !== 'string') fail(`${name} must be text.`)
  const s = v as string
  if (!allowEmpty && !s.trim()) fail(`${name} is required.`)
  if (s.length > max) fail(`${name} is too long.`)
  // eslint-disable-next-line no-control-regex
  if (/[\x00]/.test(s)) fail(`${name} contains invalid characters.`)
  return s
}

export function id(v: unknown, name = 'id'): string {
  const s = str(v, name, { max: 64, allowEmpty: false })
  if (!/^[A-Za-z0-9_-]+$/.test(s)) fail(`${name} is invalid.`)
  return s
}

export function int(v: unknown, name: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) fail(`${name} must be a whole number from ${min} to ${max}.`)
  return v as number
}

const DISTRO = /^[A-Za-z0-9._-]{1,64}$/

export function distro(v: unknown): string {
  const s = str(v, 'Distribution', { max: 64, allowEmpty: false })
  if (!DISTRO.test(s)) fail('The WSL distribution name is invalid.')
  return s
}

export function location(v: unknown): Location {
  if (!isObj(v)) return fail('Location is invalid.')
  const path = str(v.path, 'Path', { allowEmpty: false })
  if (v.kind === 'native') return { kind: 'native', path }
  if (v.kind === 'wsl') {
    if (!path.startsWith('/')) fail('A WSL path must be a Linux path.')
    return { kind: 'wsl', distro: distro(v.distro), path }
  }
  return fail('Location is invalid.')
}

export function runtime(v: unknown): Runtime {
  if (!isObj(v)) return fail('Runtime is invalid.')
  if (v.kind === 'native') return { kind: 'native' }
  if (v.kind === 'wsl') return { kind: 'wsl', distro: distro(v.distro) }
  return fail('Runtime is invalid.')
}

export function httpUrl(v: unknown, name: string, { allowEmpty = true } = {}): string {
  const s = str(v, name, { max: 2048 }).trim()
  if (!s) { if (!allowEmpty) fail(`${name} is required.`); return '' }
  let u: URL
  try { u = new URL(s) } catch { return fail(`${name} must be a full URL, for example http://localhost:5173.`) }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') fail(`${name} must start with http:// or https://.`)
  return s
}

export function readiness(v: unknown): Readiness {
  if (!isObj(v)) return fail('Readiness check is invalid.')
  if (v.type === 'none') return { type: 'none' }
  if (v.type === 'http') return { type: 'http', url: httpUrl(v.url, 'Readiness URL', { allowEmpty: false }) }
  if (v.type === 'port') {
    const host = v.host === undefined || v.host === '' ? undefined : str(v.host, 'Host', { max: 255 })
    if (host !== undefined && !/^[A-Za-z0-9.:-]+$/.test(host)) fail('Host is invalid.')
    return { type: 'port', port: int(v.port, 'Port', 1, 65535), ...(host ? { host } : {}) }
  }
  return fail('Readiness check is invalid.')
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

export function envMap(v: unknown): Record<string, string> {
  if (!isObj(v)) return fail('Environment variables are invalid.')
  const out: Record<string, string> = {}
  const keys = Object.keys(v)
  if (keys.length > 200) fail('Too many environment variables.')
  for (const k of keys) {
    if (!ENV_KEY.test(k)) fail(`"${k}" is not a valid environment variable name.`)
    out[k] = str(v[k], `Value of ${k}`, { max: 32_768 })
  }
  return out
}

export function service(v: unknown, i: number): ServiceDef {
  if (!isObj(v)) return fail('Service is invalid.')
  const label = `Service ${i + 1}`
  return {
    id: id(v.id, `${label} id`),
    name: str(v.name, `${label} name`, { max: 80, allowEmpty: false }).trim(),
    command: str(v.command, `${label} command`, { max: 8192, allowEmpty: false }).trim(),
    cwd: str(v.cwd, `${label} directory`, { max: 1024 }).trim(),
    env: envMap(v.env ?? {}),
    envFile: str(v.envFile ?? '', `${label} env file`, { max: 1024 }).trim(),
    readiness: readiness(v.readiness ?? { type: 'none' }),
    readyTimeout: int(v.readyTimeout ?? 120, `${label} readiness timeout`, 5, 3600),
  }
}

const BROWSERS: Browser[] = ['default', 'chrome', 'edge']

export function profile(v: unknown): Profile {
  if (!isObj(v)) return fail('Profile is invalid.')
  if (!Array.isArray(v.services)) fail('Services are invalid.')
  const services = (v.services as unknown[]).map(service)
  if (services.length > 20) fail('A profile can have at most 20 services.')
  const names = new Set<string>()
  for (const s of services) { const k = s.name.toLowerCase(); if (names.has(k)) fail(`Two services are named "${s.name}".`); names.add(k) }
  if (new Set(services.map(s => s.id)).size !== services.length) fail('Service ids must be unique.')
  const browser = BROWSERS.includes(v.browser as Browser) ? (v.browser as Browser) : fail('Browser is invalid.')
  return {
    id: id(v.id, 'Profile id'),
    repoId: id(v.repoId, 'Repository id'),
    name: str(v.name, 'Profile name', { max: 80, allowEmpty: false }).trim(),
    runtime: runtime(v.runtime),
    workingDir: str(v.workingDir ?? '', 'Working directory', { max: 1024 }).trim(),
    services,
    openUrl: httpUrl(v.openUrl ?? '', 'Open URL'),
    browser,
    trustedFingerprint: v.trustedFingerprint == null ? null : str(v.trustedFingerprint, 'Fingerprint', { max: 128 }),
  }
}

export function settings(v: unknown): Settings {
  if (!isObj(v)) return fail('Settings are invalid.')
  return {
    editor: str(v.editor ?? 'code', 'Editor command', { max: 512 }).trim(),
    chromePath: str(v.chromePath ?? '', 'Chrome path', { max: 1024 }).trim(),
    discoveryDepth: int(v.discoveryDepth ?? 3, 'Search depth', 1, 6),
  }
}
