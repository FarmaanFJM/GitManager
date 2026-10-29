import type { Artifact, ArtifactCategory, ArtifactClass, PlatformTag, ReasonCode, RepoPolicy, RunInfo } from '../../shared/storage.js'

/** An artifact as GitHub reports it, before it is classified. */
export type RawArtifact = {
  id: number
  repo: string
  name: string
  sizeBytes: number
  createdAt: string | null
  expiresAt: string | null
  expired: boolean
  runId: number | null
  headBranch: string | null
  headSha: string | null
}

export type ActiveRelease = { tag: string; sha: string | null; draft: boolean; prerelease: boolean }
export type OpenPull = { number: number; headRef: string; headSha: string }

export type ClassifyContext = {
  now: number
  policy: RepoPolicy
  protectedRepo: boolean
  pinned: ReadonlySet<number>
  runs: ReadonlyMap<number, RunInfo>
  pulls: readonly OpenPull[]
  /** Releases that are current: the latest published one, drafts, the latest pre-release. */
  releases: readonly ActiveRelease[]
  /** The repository's default branch; the newest successful builds on it are always kept (they are what people install). */
  defaultBranch?: string | null
  /** Every release and tag name. A run on one of these (or a `release` event) is a release build, never plain CI output. */
  releaseTags?: ReadonlySet<string>
  /** Lower-cased text of the repository's documentation, or null when it could not be read. */
  docs: string | null
  /** Which lookups succeeded. A delete candidate is only trusted when everything it depends on was read. */
  context: { runs: boolean; pulls: boolean; releases: boolean; docs: boolean }
}

const DAY = 86_400_000

const PLATFORM_WORDS: Record<string, PlatformTag> = {
  win: 'windows', win32: 'windows', win64: 'windows', windows: 'windows', msi: 'windows', exe: 'windows', nsis: 'windows',
  linux: 'linux', ubuntu: 'linux', deb: 'linux', rpm: 'linux', appimage: 'linux',
  mac: 'macos', macos: 'macos', darwin: 'macos', osx: 'macos', dmg: 'macos',
  android: 'android', apk: 'android', aab: 'android', ios: 'ios', ipa: 'ios',
}
const LOG_WORDS = new Set(['log', 'logs', 'trace', 'traces', 'debug', 'dump', 'dumps', 'crash'])
const REPORT_WORDS = new Set(['coverage', 'report', 'reports', 'junit', 'results', 'result', 'test', 'tests', 'lint', 'playwright', 'cypress', 'e2e', 'screenshots', 'sarif', 'summary', 'benchmark', 'benchmarks'])
const INSTALLER_WORDS = new Set(['installer', 'setup', 'install', 'msi', 'exe', 'dmg', 'pkg', 'deb', 'rpm', 'appimage', 'apk', 'aab', 'ipa', 'nsis'])
const BUILD_WORDS = new Set(['build', 'builds', 'dist', 'bundle', 'binaries', 'binary', 'package', 'packages', 'release', 'portable', 'x64', 'x86', 'arm64', 'amd64'])

export const tokens = (name: string) => name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)

/** What kind of output an artifact name suggests, and for which platform. Names are a hint, never the whole decision. */
export function parseName(name: string): { category: ArtifactCategory; platform: PlatformTag; family: string } {
  const t = tokens(name)
  let platform: PlatformTag = 'unknown'
  for (const w of t) if (PLATFORM_WORDS[w]) { platform = PLATFORM_WORDS[w]; break }
  let category: ArtifactCategory = 'other'
  if (t.some(w => LOG_WORDS.has(w))) category = 'logs'
  else if (t.some(w => REPORT_WORDS.has(w))) category = 'report'
  else if (t.some(w => INSTALLER_WORDS.has(w))) category = 'installer'
  else if (platform !== 'unknown' || t.some(w => BUILD_WORDS.has(w))) category = 'build'
  // The family drops what changes from build to build (numbers, versions, commit ids) so "app-1.2.3-win" and "app-1.2.4-win" compare.
  const kept = t.filter(w => !/^\d+$/.test(w) && !/^v\d+$/.test(w) && !(/^[0-9a-f]{7,40}$/.test(w) && /\d/.test(w)))
  return { category, platform, family: kept.join('-') || name.toLowerCase() }
}

const has = (hay: string | null | undefined, patterns: string[]) => {
  const h = (hay ?? '').toLowerCase()
  return patterns.find(p => h.includes(p)) ?? null
}
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : 'unknown date')
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

type Verdict = { cls: ArtifactClass; code: ReasonCode; reason: string }
const V = (cls: ArtifactClass, code: ReasonCode, reason: string): Verdict => ({ cls, code, reason })

/**
 * Classifies every artifact of one repository. The rules, in order:
 *  1 expired: already purged by GitHub, nothing to reclaim
 *  2 Protected: protected repository, pinned, evidence (name or workflow), cited by documentation, current release
 *  3 Keep: open pull request, run still active, the newest N successful builds of a family, the last usable installer of a platform
 *  4 Review: metadata missing, category not enabled for cleanup, purpose unknown, failed run not yet superseded
 *  5 Delete candidate: superseded by N newer successful builds, older than the policy age, nothing above applies,
 *    and every lookup it depends on succeeded. Otherwise it is Review: uncertain artifacts are never offered for deletion.
 * Age alone never decides anything.
 */
export function classifyRepo(raws: readonly RawArtifact[], ctx: ClassifyContext): Artifact[] {
  const { policy } = ctx
  const info = new Map<number, ReturnType<typeof parseName> & { run: RunInfo | null; ok: boolean; t: number }>()
  for (const a of raws) {
    const run = a.runId !== null ? ctx.runs.get(a.runId) ?? null : null
    info.set(a.id, { ...parseName(a.name), run, ok: run?.conclusion === 'success', t: a.createdAt ? Date.parse(a.createdAt) : NaN })
  }
  const live = raws.filter(a => !a.expired)
  const newer = (x: RawArtifact, y: RawArtifact) => (info.get(y.id)!.t - info.get(x.id)!.t) || (y.id - x.id)

  // Rank within a family among successful builds (0 = newest). Protected artifacts count: they are retained, and so occupy a slot.
  const families = new Map<string, RawArtifact[]>()
  for (const a of live) {
    const i = info.get(a.id)!
    if (!i.run || Number.isNaN(i.t)) continue
    const k = `${i.category}|${i.platform}|${i.family}`
    if (!families.has(k)) families.set(k, [])
    families.get(k)!.push(a)
  }
  const rank = new Map<number, number>()
  const successfulNewer = new Map<number, number>()
  for (const list of families.values()) {
    const ok = list.filter(a => info.get(a.id)!.ok).sort(newer)
    ok.forEach((a, i) => rank.set(a.id, i))
    for (const a of list) successfulNewer.set(a.id, ok.filter(s => info.get(s.id)!.t > info.get(a.id)!.t || (info.get(s.id)!.t === info.get(a.id)!.t && s.id > a.id)).length)
  }

  // Per branch, within a family: how many successful builds are newer. An open pull request protects only its newest builds.
  const branchOf = (a: RawArtifact) => info.get(a.id)!.run?.headBranch ?? a.headBranch ?? ''
  const newerThan = (s: RawArtifact, a: RawArtifact) => info.get(s.id)!.t > info.get(a.id)!.t || (info.get(s.id)!.t === info.get(a.id)!.t && s.id > a.id)
  const branchNewer = new Map<number, number>()
  const defaultRank = new Map<number, number>()
  for (const list of families.values()) {
    const ok = list.filter(a => info.get(a.id)!.ok).sort(newer)
    for (const a of list) branchNewer.set(a.id, ok.filter(x => branchOf(x) === branchOf(a) && newerThan(x, a)).length)
    if (ctx.defaultBranch) ok.filter(a => branchOf(a) === ctx.defaultBranch).forEach((a, i) => defaultRank.set(a.id, i))
  }

  // The last usable installer of each platform is never offered, whatever the policy says.
  const lastInstaller = new Set<number>()
  const byPlatform = new Map<string, RawArtifact[]>()
  for (const a of live) {
    const i = info.get(a.id)!
    if (i.category !== 'installer' || Number.isNaN(i.t)) continue
    if (!byPlatform.has(i.platform)) byPlatform.set(i.platform, [])
    byPlatform.get(i.platform)!.push(a)
  }
  for (const list of byPlatform.values()) {
    const usable = list.filter(a => info.get(a.id)!.ok).sort(newer)
    const pick = usable[0] ?? list.sort(newer)[0]
    if (pick) lastInstaller.add(pick.id)
  }

  // A name that many artifacts share (every CI run uploads "app-windows-x64") says nothing about one of them, so a documentation
  // mention of such a name protects no particular build; only a name unique in the repository, or a run URL, identifies one.
  const nameCount = new Map<string, number>()
  for (const a of raws) nameCount.set(a.name.toLowerCase(), (nameCount.get(a.name.toLowerCase()) ?? 0) + 1)

  const missing = Object.entries({ runs: 'workflow runs', pulls: 'open pull requests', releases: 'releases', docs: 'documentation' })
    .filter(([k]) => !ctx.context[k as keyof typeof ctx.context]).map(([, v]) => v)

  const decide = (a: RawArtifact): Verdict => {
    const i = info.get(a.id)!
    const run = i.run
    if (a.expired) return V('expired', 'expired', 'Expired: GitHub already removed the contents; nothing is stored.')
    if (ctx.protectedRepo) return V('protected', 'repo-protected', 'This repository is protected in GitManager.')
    if (ctx.pinned.has(a.id)) return V('protected', 'pinned', 'Pinned by you.')
    const ev = has(a.name, policy.evidencePatterns) ?? has(run?.name, policy.evidencePatterns) ?? has(run?.path, policy.evidencePatterns)
    if (ev) return V('protected', 'evidence', `Qualification or audit evidence (matches "${ev}").`)
    const nm = a.name.toLowerCase()
    if (ctx.docs !== null && ((nm.length >= 6 && nameCount.get(nm) === 1 && ctx.docs.includes(nm)) || (a.runId !== null && ctx.docs.includes(`/actions/runs/${a.runId}`)))) {
      return V('protected', 'doc-cited', 'Cited by the repository documentation.')
    }
    const rel = ctx.releases.find(r => (run?.headBranch && run.headBranch === r.tag) || (a.headBranch && a.headBranch === r.tag) || (r.sha && (run?.headSha === r.sha || a.headSha === r.sha)))
    if (rel) return V('protected', 'release', `Built for ${rel.draft ? 'the draft release' : 'the current release'} ${rel.tag}.`)

    const pr = ctx.pulls.find(p => run?.pullNumbers.includes(p.number) || (run?.headBranch ?? a.headBranch) === p.headRef || (run?.headSha ?? a.headSha) === p.headSha)
    if (pr && (branchNewer.get(a.id) ?? 0) < policy.keepLatest) return V('keep', 'open-pr', `Belongs to open pull request #${pr.number} (among the newest ${policy.keepLatest} builds of its branch).`)
    if (run && run.status !== 'completed') return V('keep', 'run-active', `Its workflow run is still ${run.status ?? 'running'}.`)

    if (!run || Number.isNaN(i.t)) return V('review', 'metadata-missing', run ? 'Creation date is missing.' : 'Its workflow run could not be found, so its origin is unknown.')

    const r = rank.get(a.id)
    if (i.ok && r !== undefined && r < policy.keepLatest) return V('keep', 'newest-successful', `One of the newest ${policy.keepLatest} successful builds of ${i.family} (${i.platform === 'unknown' ? 'any platform' : i.platform}).`)
    const dr = defaultRank.get(a.id)
    if (dr !== undefined && dr < policy.keepLatest) return V('keep', 'newest-default-branch', `One of the newest ${policy.keepLatest} successful builds of ${i.family} on ${ctx.defaultBranch}.`)
    if (lastInstaller.has(a.id)) return V('keep', 'last-installer', `The last usable installer for ${i.platform === 'unknown' ? 'its platform' : i.platform}.`)

    // A build made from a release tag may be the only copy of something that was shipped; it is never plain CI output.
    if (run.event === 'release' || (run.headBranch && ctx.releaseTags?.has(run.headBranch))) return V('review', 'tag-build', `Built from release tag ${run.headBranch}: not the current release, but not offered for deletion automatically.`)
    if (i.category === 'other') return V('review', 'category-unreviewed', 'Its purpose is not recognised from the name, so GitManager will not suggest deleting it.')
    if (i.category === 'evidence' || !policy.deleteCategories.includes(i.category)) return V('review', 'category-disabled', `Cleanup of ${i.category} output is not enabled in this repository's policy.`)

    const temp = i.category === 'report' || i.category === 'logs' ? policy.reportDays : policy.tempDays
    const ageDays = Math.floor((ctx.now - i.t) / DAY)
    const n = successfulNewer.get(a.id) ?? 0
    const enough = n >= policy.keepLatest
    if (i.ok) {
      if (!enough) return V('review', 'no-newer-build', 'Not superseded by enough newer successful builds.')
      if (ageDays < temp) return V('keep', 'recent', `Recent: ${ageDays} d old, kept for ${temp} d.`)
      const code: ReasonCode = i.category === 'report' || i.category === 'logs' ? 'obsolete-report' : 'superseded-build'
      return V('delete-candidate', code, i.category === 'report' || i.category === 'logs'
        ? `Obsolete ${i.category === 'logs' ? 'log' : 'CI report'}: ${plural(n, 'newer successful run')} produced the same output, and it is ${ageDays} d old.`
        : `Superseded temporary build: ${plural(n, 'newer successful build')} of ${i.family}, and it is ${ageDays} d old.`)
    }
    const outcome = run.conclusion ?? 'unfinished'
    if (enough && ageDays >= temp) return V('delete-candidate', 'superseded-failed', `Output of a ${outcome} run, superseded by ${plural(n, 'newer successful build')} and ${ageDays} d old.`)
    return V('review', 'failed-run', `Output of a ${outcome} run, kept for debugging until a newer successful build supersedes it.`)
  }

  return raws.map(a => {
    const i = info.get(a.id)!
    let v = decide(a)
    if (v.cls === 'delete-candidate' && missing.length) {
      v = V('review', 'context-incomplete', `Could not check ${missing.join(', ')}, so this artifact is not offered for deletion.`)
    }
    return {
      id: a.id, repo: a.repo, name: a.name, sizeBytes: a.sizeBytes, createdAt: a.createdAt, expiresAt: a.expiresAt, expired: a.expired,
      runId: a.runId, headBranch: i.run?.headBranch ?? a.headBranch, headSha: i.run?.headSha ?? a.headSha, run: i.run,
      category: i.category, platform: i.platform, class: v.cls, reasonCode: v.code, reason: v.reason, pinned: ctx.pinned.has(a.id),
    }
  })
}

export { day }
