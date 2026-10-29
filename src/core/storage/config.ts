import { createHash } from 'node:crypto'
import type { ArtifactCategory, Frequency, Mode, Pin, RepoPolicy, StorageConfig, StorageSettings } from '../../shared/storage.js'

export const GIB = 1024 ** 3
export const MIB = 1024 ** 2

export const DEFAULT_EVIDENCE = ['qualification', 'audit', 'evidence', 'attestation', 'provenance', 'sbom']
const ALL_CATEGORIES: ArtifactCategory[] = ['installer', 'build', 'report', 'logs']

/** The conservative defaults used to *classify* (display). They never enable any cleanup: every repository starts in manual mode. */
export const DEFAULT_POLICY: RepoPolicy = {
  mode: 'manual', keepLatest: 2, tempDays: 7, reportDays: 14, deleteCategories: [...ALL_CATEGORIES],
  evidencePatterns: [...DEFAULT_EVIDENCE], largeDeleteBytes: 1 * GIB, presetId: null, approvedHash: null, approvedAt: null,
}

export const DEFAULT_SETTINGS: StorageSettings = {
  scheduleEnabled: false, frequency: 'weekly', scope: 'writable', includeArchived: false, notify: false,
  alerts: { highBytes: null, growth: true, repeatedBuilds: true, oldBuilds: true },
}

export const emptyConfig = (): StorageConfig => ({ settings: { ...DEFAULT_SETTINGS, alerts: { ...DEFAULT_SETTINGS.alerts } }, defaultPolicy: { ...DEFAULT_POLICY }, policies: {}, protectedRepos: [], pins: [] })

/** Proposed starting points. Applying one only fills the form; the user reviews and saves it. They are not safety guarantees. */
export const PRESETS: { id: string; label: string; description: string; policy: Partial<RepoPolicy> }[] = [
  {
    id: 'strict-evidence', label: 'Strict evidence preservation (Summa)',
    description: 'Only CI reports and logs may become delete candidates. Installers and builds are never offered. Security, audit, qualification and attestation artifacts are protected.',
    policy: { keepLatest: 2, tempDays: 14, reportDays: 30, deleteCategories: ['report', 'logs'], evidencePatterns: [...DEFAULT_EVIDENCE, 'security', 'compliance', 'gate', 'pentest'] },
  },
  {
    id: 'newest-two-builds', label: 'Newest two successful builds (Herc\'s Adventure)',
    description: 'Keeps the newest two successful builds of each build family and platform; older superseded builds, reports and logs may be offered. Adjust the evidence patterns if private builds use a specific name.',
    policy: { keepLatest: 2, tempDays: 7, reportDays: 14, deleteCategories: [...ALL_CATEGORIES] },
  },
  {
    id: 'newest-two-installers', label: 'Newest two installers per platform (Markdown Studio)',
    description: 'Keeps the newest two successful installers for each platform, and always the last usable installer of a platform.',
    policy: { keepLatest: 2, tempDays: 7, reportDays: 14, deleteCategories: [...ALL_CATEGORIES] },
  },
  {
    id: 'newest-two-windows', label: 'Newest two verified Windows releases (GitManager)',
    description: 'Keeps the newest two successful Windows builds and anything attached to the current release; older superseded output, reports and logs may be offered.',
    policy: { keepLatest: 2, tempDays: 7, reportDays: 14, deleteCategories: [...ALL_CATEGORIES] },
  },
]

/** Fields that decide what automatic safe cleanup may delete. Their hash is what the user approved. */
export function policyHash(p: RepoPolicy): string {
  const core = { k: p.keepLatest, t: p.tempDays, r: p.reportDays, c: [...p.deleteCategories].sort(), e: p.evidencePatterns.map(x => x.toLowerCase()).sort(), l: p.largeDeleteBytes }
  return createHash('sha256').update(JSON.stringify(core)).digest('hex').slice(0, 24)
}

/** The mode that actually applies: automatic safe cleanup needs an approval that still matches the policy. */
export function effectiveMode(p: RepoPolicy): Mode {
  if (p.mode === 'auto-safe') return p.approvedHash && p.approvedHash === policyHash(p) ? 'auto-safe' : 'recommend'
  return p.mode
}

export const repoKey = (full: string) => full.trim().toLowerCase()
export const validRepoName = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(s) && s.split('/').every(p => !/^\.+$/.test(p))

const num = (x: unknown, lo: number, hi: number, d: number) => (typeof x === 'number' && Number.isFinite(x) ? Math.min(hi, Math.max(lo, Math.round(x))) : d)
const oneOf = <T extends string>(x: unknown, list: readonly T[], d: T): T => ((list as readonly string[]).includes(x as string) ? (x as T) : d)

export function sanitizePolicy(raw: unknown, base: RepoPolicy = DEFAULT_POLICY): RepoPolicy {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const cats = Array.isArray(r.deleteCategories) ? ALL_CATEGORIES.filter(c => (r.deleteCategories as unknown[]).includes(c)) : base.deleteCategories
  const patterns = Array.isArray(r.evidencePatterns)
    ? [...new Set((r.evidencePatterns as unknown[]).filter((s): s is string => typeof s === 'string').map(s => s.trim().toLowerCase()).filter(s => s.length >= 2 && s.length <= 60))].slice(0, 40)
    : base.evidencePatterns
  const p: RepoPolicy = {
    mode: oneOf(r.mode, ['manual', 'recommend', 'auto-safe'] as const, 'manual'),
    keepLatest: num(r.keepLatest, 1, 10, base.keepLatest), // never fewer than one: the last usable build is always kept
    tempDays: num(r.tempDays, 1, 365, base.tempDays),
    reportDays: num(r.reportDays, 1, 365, base.reportDays),
    deleteCategories: cats,
    evidencePatterns: patterns,
    largeDeleteBytes: num(r.largeDeleteBytes, 0, 1024 * GIB, base.largeDeleteBytes),
    presetId: typeof r.presetId === 'string' && PRESETS.some(x => x.id === r.presetId) ? r.presetId : null,
    approvedHash: typeof r.approvedHash === 'string' && /^[0-9a-f]{24}$/.test(r.approvedHash) ? r.approvedHash : null,
    approvedAt: typeof r.approvedAt === 'string' ? r.approvedAt.slice(0, 40) : null,
  }
  return p
}

export function sanitizeSettings(raw: unknown): StorageSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const a = (r.alerts && typeof r.alerts === 'object' ? r.alerts : {}) as Record<string, unknown>
  const d = DEFAULT_SETTINGS
  return {
    scheduleEnabled: r.scheduleEnabled === true,
    frequency: oneOf<Frequency>(r.frequency, ['daily', 'weekly', 'monthly'], d.frequency),
    scope: oneOf(r.scope, ['writable', 'owned'] as const, d.scope),
    includeArchived: r.includeArchived === true,
    notify: r.notify === true,
    alerts: {
      highBytes: typeof a.highBytes === 'number' && a.highBytes > 0 && Number.isFinite(a.highBytes) ? Math.round(a.highBytes) : null,
      growth: a.growth !== false, repeatedBuilds: a.repeatedBuilds !== false, oldBuilds: a.oldBuilds !== false,
    },
  }
}

/** Defensive read of the stored configuration; anything invalid falls back to its default. */
export function sanitizeConfig(raw: unknown): StorageConfig {
  const c = emptyConfig()
  if (!raw || typeof raw !== 'object') return c
  const r = raw as Record<string, unknown>
  c.settings = sanitizeSettings(r.settings)
  c.defaultPolicy = sanitizePolicy(r.defaultPolicy)
  if (r.policies && typeof r.policies === 'object') {
    for (const [k, v] of Object.entries(r.policies as Record<string, unknown>)) if (validRepoName(k)) c.policies[repoKey(k)] = sanitizePolicy(v, c.defaultPolicy)
  }
  if (Array.isArray(r.protectedRepos)) c.protectedRepos = [...new Set(r.protectedRepos.filter(validRepoName).map(repoKey))]
  if (Array.isArray(r.pins)) {
    const seen = new Set<string>()
    for (const p of r.pins as Record<string, unknown>[]) {
      if (!p || !validRepoName(p.repo) || !Number.isSafeInteger(p.artifactId) || (p.artifactId as number) <= 0) continue
      const key = `${repoKey(p.repo)}#${p.artifactId}`
      if (seen.has(key)) continue
      seen.add(key)
      c.pins.push({ repo: repoKey(p.repo), artifactId: p.artifactId as number, name: typeof p.name === 'string' ? p.name.slice(0, 200) : '', at: typeof p.at === 'string' ? p.at.slice(0, 40) : '' } satisfies Pin)
    }
  }
  return c
}

export const policyFor = (c: StorageConfig, repo: string): RepoPolicy => c.policies[repoKey(repo)] ?? c.defaultPolicy
