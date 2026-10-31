import type { RunInfo } from '../../src/shared/storage.js'
import { DEFAULT_POLICY } from '../../src/core/storage/config.js'
import type { ClassifyContext, RawArtifact } from '../../src/core/storage/classify.js'

export const NOW = Date.parse('2026-10-29T12:00:00Z')
export const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString()

let seq = 1000
export function run(over: Partial<RunInfo> = {}): RunInfo {
  const id = over.id ?? ++seq
  return { id, name: 'CI', path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success', event: 'push', runNumber: id, headBranch: 'main', headSha: `sha${id}`, htmlUrl: `https://github.com/o/r/actions/runs/${id}`, pullNumbers: [], ...over }
}

export function art(name: string, ageDays: number, over: Partial<RawArtifact> = {}, r?: RunInfo | null): { a: RawArtifact; run: RunInfo | null } {
  const rr = r === undefined ? run() : r
  const id = over.id ?? ++seq
  return { a: { id, repo: 'o/r', name, sizeBytes: 10 * 1024 * 1024, createdAt: daysAgo(ageDays), expiresAt: daysAgo(ageDays - 90), expired: false, runId: rr?.id ?? null, headBranch: rr?.headBranch ?? null, headSha: rr?.headSha ?? null, ...over }, run: rr }
}

export function ctx(items: { run: RunInfo | null }[], over: Partial<ClassifyContext> = {}): ClassifyContext {
  const runs = new Map<number, RunInfo>()
  for (const i of items) if (i.run) runs.set(i.run.id, i.run)
  return {
    now: NOW, policy: { ...DEFAULT_POLICY }, protectedRepo: false, pinned: new Set(), runs, pulls: [], releases: [], docs: '',
    context: { runs: true, pulls: true, releases: true, docs: true }, ...over,
  }
}
