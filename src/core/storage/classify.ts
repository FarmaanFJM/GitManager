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

const ARCH_WORDS: Record<string, string> = { x64: 'x64', amd64: 'x64', x86_64: 'x64', x86: 'x86', ia32: 'x86', win32: 'x86', arm64: 'arm64', aarch64: 'arm64', arm: 'arm', universal: 'universal' }

export const tokens = (name: string) => name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)

/** What kind of output an artifact name suggests, and for which platform. Names are a hint, never the whole decision. */
export function parseName(name: string): { category: ArtifactCategory; platform: PlatformTag; arch: string; family: string } {
  const t = tokens(name)
  const arch = t.map(w => ARCH_WORDS[w]).find(Boolean) ?? 'any'
  let platform: PlatformTag = 'unknown'
  for (const w of t) if (PLATFORM_WORDS[w]) { platform = PLATFORM_WORDS[w]; break }
  let category: ArtifactCategory = 'other'
  if (t.some(w => LOG_WORDS.has(w))) category = 'logs'
  else if (t.some(w => REPORT_WORDS.has(w))) category = 'report'
  else if (t.some(w => INSTALLER_WORDS.has(w))) category = 'installer'
  else if (platform !== 'unknown' || t.some(w => BUILD_WORDS.has(w))) category = 'build'
  // The family drops what changes from build to build (numbers, versions, commit ids) so "app-1.2.3-win" and "app-1.2.4-win" compare.
  const kept = t.filter(w => !/^\d+$/.test(w) && !/^v\d+$/.test(w) && !(/^[0-9a-f]{7,40}$/.test(w) && /\d/.test(w)))
  return { category, platform, arch, family: kept.join('-') || name.toLowerCase() }
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
 * Classifies every artifact of one repository. Verified supersession, not age, decides ordinary CI build output.
 *
 * A build is compared only with builds of the same *family and channel*: workflow, output purpose (installer, build, report, log),
 * platform, architecture and normalised name, within the same channel: the default branch, one other branch (each open pull
 * request has its own), or one release tag. So an experimental pull request build never supersedes the default branch's last
 * usable installer, and a Windows x64 installer never supersedes an arm64 one.
 *
 *  1 expired: already purged by GitHub, nothing to reclaim
 *  2 Protected: protected repository, pinned, evidence (name or workflow), cited by documentation, current release
 *  3 Keep: its run is still active, an open pull request's newest builds, the newest N successful builds of its family and channel,
 *    the last usable installer of a platform and architecture
 *  4 Review: metadata missing, build of a non-current release tag, purpose unknown, category not enabled, failed or cancelled output
 *    (unless the policy explicitly allows deleting superseded failed output), too few newer successful builds
 *  5 Delete candidate: N newer successful builds exist in the same family and channel, nothing above applies, every lookup it
 *    depends on succeeded, and the optional grace period (default none) has passed. Until then it is Keep, "grace period".
 * An artifact name such as "release" or "installer" protects nothing; only the run's tag, a current release's commit, or evidence does.
 */
export function classifyRepo(raws: readonly RawArtifact[], ctx: ClassifyContext): Artifact[] {
  const { policy } = ctx
  type Info = ReturnType<typeof parseName> & { run: RunInfo | null; ok: boolean; t: number; branch: string; workflow: string; channel: string; key: string }
  const info = new Map<number, Info>()
  const isTag = (run: RunInfo | null) => !!run && (run.event === 'release' || (!!run.headBranch && !!ctx.releaseTags?.has(run.headBranch)))
  for (const a of raws) {
    const run = a.runId !== null ? ctx.runs.get(a.runId) ?? null : null
    const p = parseName(a.name)
    const branch = run?.headBranch ?? a.headBranch ?? ''
    const workflow = run?.path ?? run?.name ?? ''
    const channel = isTag(run) ? `tag:${branch || 'release'}` : ctx.defaultBranch && branch === ctx.defaultBranch ? 'default' : `branch:${branch}`
    info.set(a.id, { ...p, run, ok: run?.conclusion === 'success', t: a.createdAt ? Date.parse(a.createdAt) : NaN, branch, workflow, channel, key: `${workflow}|${p.category}|${p.platform}|${p.arch}|${p.family}|${channel}` })
  }
  const complete = (a: RawArtifact) => { const i = info.get(a.id)!; return !!i.run && !Number.isNaN(i.t) && !!i.branch && !!i.workflow }
  const live = raws.filter(a => !a.expired && complete(a))
  const newerThan = (x: RawArtifact, y: RawArtifact) => info.get(x.id)!.t > info.get(y.id)!.t || (info.get(x.id)!.t === info.get(y.id)!.t && x.id > y.id)

  // Per family and channel: how many *successful* builds are newer than each artifact. Protected ones count (they are retained).
  const groups = new Map<string, RawArtifact[]>()
  for (const a of live) { const k = info.get(a.id)!.key; if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(a) }
  const newerOk = new Map<number, number>()
  for (const list of groups.values()) {
    const ok = list.filter(a => info.get(a.id)!.ok).sort((x, y) => (newerThan(x, y) ? -1 : 1))
    for (const a of list) newerOk.set(a.id, ok.filter(s => newerThan(s, a)).length)
  }

  // The last usable installer of each platform and architecture is never offered: the default channel's newest, else any.
  const lastInstaller = new Set<number>()
  const byTarget = new Map<string, RawArtifact[]>()
  for (const a of live) { const i = info.get(a.id)!; if (i.category !== 'installer') continue; const k = `${i.platform}|${i.arch}`; if (!byTarget.has(k)) byTarget.set(k, []); byTarget.get(k)!.push(a) }
  for (const list of byTarget.values()) {
    const sorted = list.sort((x, y) => (newerThan(x, y) ? -1 : 1))
    const pick = sorted.find(a => info.get(a.id)!.ok && info.get(a.id)!.channel === 'default') ?? sorted.find(a => info.get(a.id)!.ok) ?? sorted[0]
    if (pick) lastInstaller.add(pick.id)
  }

  // A name that many artifacts share (every CI run uploads "app-windows-x64") says nothing about one of them, so a documentation
  // mention of such a name protects no particular build; only a name unique in the repository, or a run URL, identifies one.
  const nameCount = new Map<string, number>()
  for (const a of raws) nameCount.set(a.name.toLowerCase(), (nameCount.get(a.name.toLowerCase()) ?? 0) + 1)

  const missing = Object.entries({ runs: 'workflow runs', pulls: 'open pull requests', releases: 'releases', docs: 'documentation' })
    .filter(([k]) => !ctx.context[k as keyof typeof ctx.context]).map(([, v]) => v)
  const channelText = (c: string) => (c === 'default' ? `the default branch (${ctx.defaultBranch})` : c.startsWith('tag:') ? `release tag ${c.slice(4)}` : `branch ${c.slice(7)}`)

  const decide = (a: RawArtifact): Verdict & { n?: number; graceUntil?: string | null } => {
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

    if (run && run.status !== 'completed') return V('keep', 'run-active', `Its workflow run is still ${run.status ?? 'running'}.`)
    if (!complete(a)) {
      const what = !run ? 'its workflow run could not be found' : Number.isNaN(i.t) ? 'its creation date is missing' : !i.branch ? 'its branch is unknown' : 'its workflow is unknown'
      return V('review', 'metadata-missing', `GitHub metadata is incomplete (${what}), so it cannot be compared safely.`)
    }

    const n = newerOk.get(a.id) ?? 0
    const N = policy.keepLatest
    const where = channelText(i.channel)
    const target = [i.platform === 'unknown' ? '' : i.platform, i.arch === 'any' ? '' : i.arch].filter(Boolean).join(' ') || 'any platform'
    const pr = ctx.pulls.find(p => run!.pullNumbers.includes(p.number) || run!.headBranch === p.headRef || run!.headSha === p.headSha)
    if (pr && n < N) return V('keep', 'open-pr', `Belongs to open pull request #${pr.number} and is among the newest ${N} builds of ${where}.`)
    if (i.ok && n < N) return V('keep', 'newest-successful', `One of the newest ${N} successful builds of ${i.family} (${target}) on ${where}.`)
    if (lastInstaller.has(a.id)) return V('keep', 'last-installer', `The last usable installer for ${target}.`)

    // A build made from a release tag may be the only copy of something that was shipped; it is never plain CI output.
    if (i.channel.startsWith('tag:')) return V('review', 'tag-build', `Built from release tag ${run!.headBranch ?? ''}: not the current release, but not offered for deletion automatically.`)
    if (i.category === 'other') return V('review', 'category-unreviewed', 'Its purpose is not recognised from the name, so GitManager will not suggest deleting it.')
    if (i.category === 'evidence' || !policy.deleteCategories.includes(i.category)) return V('review', 'category-disabled', `Cleanup of ${i.category} output is not enabled in this repository's policy.`)

    const ageDays = Math.floor((ctx.now - i.t) / DAY)
    const report = i.category === 'report' || i.category === 'logs'
    if (!i.ok) {
      const outcome = run!.conclusion ?? 'unfinished'
      const grace = policy.failedGraceDays
      if (policy.failedOutput === 'delete-superseded' && n >= N && ageDays >= grace) {
        return { ...V('delete-candidate', 'superseded-failed', `Output of a ${outcome} run; your failure-output policy allows deleting it once ${plural(N, 'newer successful build')} of ${i.family} exist on ${where} (${n} do) and ${grace} d have passed.`), n }
      }
      return V('review', 'failed-run', policy.failedOutput === 'delete-superseded'
        ? `Output of a ${outcome} run, kept until ${plural(N, 'newer successful build')} exist on ${where}${grace ? ` and ${grace} d have passed` : ''}.`
        : `Output of a ${outcome} run. It may be useful for debugging, so it is only deleted by you; allow it in the policy to offer superseded failed output.`)
    }
    if (n < N) return V('review', 'no-newer-build', `Only ${n} newer successful ${n === 1 ? 'build' : 'builds'} of ${i.family} on ${where}; ${N} are needed.`)
    const grace = report ? policy.reportGraceDays : policy.graceDays
    const what = report ? (i.category === 'logs' ? 'log' : 'CI report') : 'build'
    if (ageDays < grace) {
      const until = new Date(i.t + grace * DAY).toISOString()
      return { ...V('keep', 'grace-period', `Superseded by ${plural(n, 'newer successful build')} on ${where}; retained by the ${grace} d grace period until ${until.slice(0, 10)}.`), n, graceUntil: until }
    }
    return { ...V('delete-candidate', report ? 'obsolete-report' : 'superseded-build', `Superseded ${what}: ${plural(n, 'newer successful build')} of ${i.family} (${target}) exist on ${where}${grace ? `, and the ${grace} d grace period has passed` : '; no grace period is set'}.`), n }
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
      channel: i.channel, newerBuilds: complete(a) ? newerOk.get(a.id) ?? 0 : null, graceUntil: (v as { graceUntil?: string | null }).graceUntil ?? null,
    }
  })
}

export { day }
