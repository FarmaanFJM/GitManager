// The runners section of gitmanager.json: settings, search roots and the non-sensitive memory of known installations.
// Validated on load like every other section; anything invalid falls back to its default instead of failing the load.
import type { KnownInstallation, RetiredInstallation, RunnerHost, RunnerRoot, RunnersConfig, RunnersSettings } from '../../shared/runners.js'
import { newIdLike } from './ids.js'
import { installKey, parseScope, validOwner, validRepoFull } from './model.js'

export const DEFAULT_RUNNER_SETTINGS: RunnersSettings = { autoDiscover: true, githubAtStartup: false, roots: [], orgs: [], repos: [], sshHosts: [], refreshMinutes: 5 }

export const emptyRunnersConfig = (): RunnersConfig => ({ settings: { ...DEFAULT_RUNNER_SETTINGS, roots: [], orgs: [], repos: [], sshHosts: [] }, known: [], retired: [] })

const DISTRO = /^[A-Za-z0-9._-]{1,64}$/
const SSH = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/

export function parseHost(raw: unknown): RunnerHost | null {
  if (!raw || typeof raw !== 'object') return null
  const h = raw as Record<string, unknown>
  if (h.kind === 'native') return { kind: 'native' }
  if (h.kind === 'wsl' && typeof h.distro === 'string' && DISTRO.test(h.distro)) return { kind: 'wsl', distro: h.distro }
  if (h.kind === 'ssh' && typeof h.host === 'string' && SSH.test(h.host)) return { kind: 'ssh', host: h.host }
  return null
}

const PATH_OK = (p: unknown): p is string => typeof p === 'string' && p.trim().length > 0 && p.length <= 1024 && !/[\x00-\x1f]/.test(p) // eslint-disable-line no-control-regex

export function sanitizeRunnerSettings(raw: unknown): RunnersSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const roots: RunnerRoot[] = []
  const seen = new Set<string>()
  if (Array.isArray(r.roots)) {
    for (const x of r.roots.slice(0, 50) as Record<string, unknown>[]) {
      const host = parseHost(x?.host)
      if (!host || !PATH_OK(x.path)) continue
      const key = installKey(host, x.path.trim())
      if (seen.has(key)) continue
      seen.add(key)
      roots.push({ id: typeof x.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(x.id) ? x.id : newIdLike(), host, path: x.path.trim() })
    }
  }
  const strs = (v: unknown, ok: (s: unknown) => boolean, max: number) => (Array.isArray(v) ? [...new Set(v.filter(ok).map(s => String(s)))].slice(0, max) : [])
  return {
    autoDiscover: r.autoDiscover === undefined ? true : r.autoDiscover === true,
    githubAtStartup: r.githubAtStartup === true,
    roots,
    orgs: strs(r.orgs, validOwner, 50),
    repos: strs(r.repos, validRepoFull, 200),
    sshHosts: strs(r.sshHosts, s => typeof s === 'string' && SSH.test(s), 50),
    refreshMinutes: typeof r.refreshMinutes === 'number' && Number.isFinite(r.refreshMinutes) ? Math.min(60, Math.max(0, Math.round(r.refreshMinutes))) : 5,
  }
}

export function sanitizeRunnersConfig(raw: unknown): RunnersConfig {
  const c = emptyRunnersConfig()
  if (!raw || typeof raw !== 'object') return c
  const r = raw as Record<string, unknown>
  c.settings = sanitizeRunnerSettings(r.settings)
  if (Array.isArray(r.known)) {
    const seen = new Set<string>()
    for (const x of r.known.slice(0, 500) as Record<string, unknown>[]) {
      const host = parseHost(x?.host)
      if (!host || !PATH_OK(x.path)) continue
      const key = installKey(host, x.path.trim())
      if (seen.has(key)) continue
      seen.add(key)
      c.known.push({
        key, host, path: x.path.trim(), name: typeof x.name === 'string' ? x.name.slice(0, 100) : null, scope: parseScope(x.scope),
        agentId: typeof x.agentId === 'number' && Number.isSafeInteger(x.agentId) && x.agentId > 0 ? x.agentId : null, at: typeof x.at === 'string' ? x.at.slice(0, 40) : '',
      } satisfies KnownInstallation)
    }
  }
  if (Array.isArray(r.retired)) {
    const seen = new Set<string>()
    for (const x of r.retired.slice(0, 200) as Record<string, unknown>[]) {
      const host = parseHost(x?.host)
      if (!host || !PATH_OK(x.path)) continue
      const key = installKey(host, x.path.trim())
      if (seen.has(key)) continue
      seen.add(key)
      c.retired.push({
        key, host, path: x.path.trim(), name: typeof x.name === 'string' ? x.name.slice(0, 100) : null, scope: parseScope(x.scope),
        agentId: typeof x.agentId === 'number' && Number.isSafeInteger(x.agentId) && x.agentId > 0 ? x.agentId : null, retiredAt: typeof x.retiredAt === 'string' ? x.retiredAt.slice(0, 40) : '',
      } satisfies RetiredInstallation)
    }
  }
  return c
}
