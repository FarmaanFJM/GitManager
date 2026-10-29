import type { AuditEntry } from '../../shared/storage.js'

/**
 * Reading the optional request log (GITMANAGER_GH_REQUEST_LOG). Each line is `<iso> <METHOD> <path>`, or `<iso> MARK BEGIN|END <label>`
 * written by the Storage service around scans and cleanups, so a log can tell a read-only scan from an explicitly authorized
 * deletion. Nothing here sees a header, a body or a credential: the log never contains them.
 */
export type ReqLine = { at: string; method: string; path: string; phase: string | null }
export type Phase = { label: string; kind: 'scan' | 'dry-run' | 'delete' | 'other'; lines: ReqLine[] }

export const ARTIFACT_DELETE = /^\/repos\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/actions\/artifacts\/([1-9]\d{0,15})$/

export function parseRequestLog(text: string): { lines: ReqLine[]; phases: Phase[] } {
  const lines: ReqLine[] = []
  const phases: Phase[] = []
  let cur: Phase | null = null
  for (const raw of text.split('\n')) {
    const parts = raw.trim().split(' ')
    if (parts.length < 3) continue
    const [at, method, ...rest] = parts
    if (method === 'MARK') {
      if (rest[0] === 'BEGIN') {
        const label = rest.slice(1).join(' ')
        cur = { label, kind: /^cleanup dryRun=false/.test(label) ? 'delete' : /^cleanup dryRun=true/.test(label) ? 'dry-run' : /^scan/.test(label) ? 'scan' : 'other', lines: [] }
        phases.push(cur)
      } else cur = null
      continue
    }
    const l: ReqLine = { at, method, path: rest.join(' '), phase: cur?.label ?? null }
    lines.push(l)
    cur?.lines.push(l)
  }
  return { lines, phases }
}

export type RequestVerdict = { ok: boolean; problems: string[]; counts: Record<string, number>; deletes: number; deletesInAuthorizedPhases: number }

/**
 * A read-only scan or dry run must contain no mutating request. A DELETE is legitimate only inside an authorized cleanup phase
 * (a non-dry-run `cleanup`), must target exactly one Actions artifact, and, when the audit log is given, must match one
 * recorded attempt for that artifact: one DELETE per attempt, no more, no fewer, none repeated.
 */
export function verifyRequests(text: string, audit?: AuditEntry[]): RequestVerdict {
  const { lines, phases } = parseRequestLog(text)
  const problems: string[] = []
  const counts: Record<string, number> = {}
  for (const l of lines) counts[l.method] = (counts[l.method] ?? 0) + 1
  const muts = lines.filter(l => l.method !== 'GET')
  let inAuth = 0
  for (const m of muts) {
    const ph = phases.find(p => p.lines.includes(m))
    if (m.method !== 'DELETE') problems.push(`${m.method} ${m.path} is not a read or an artifact deletion`)
    else if (!ARTIFACT_DELETE.test(m.path)) problems.push(`DELETE ${m.path} is not a single Actions artifact`)
    else if (!ph || ph.kind !== 'delete') problems.push(`DELETE ${m.path} happened outside an authorized cleanup (${ph ? ph.label : 'no phase recorded'})`)
    else inAuth++
  }
  const seen = new Map<string, number>()
  for (const m of muts) { const k = m.path; seen.set(k, (seen.get(k) ?? 0) + 1) }
  for (const [k, n] of seen) if (n > 1) problems.push(`${k} was deleted ${n} times`)
  if (audit) {
    const attempts = new Set(audit.filter(e => e.type === 'attempt').map(e => `/repos/${e.repo}/actions/artifacts/${e.artifactId}`))
    const sent = new Set(muts.filter(m => m.method === 'DELETE').map(m => m.path))
    for (const m of sent) if (![...attempts].some(a => a.toLowerCase() === m.toLowerCase())) problems.push(`${m} has no matching audit attempt`)
    for (const a of attempts) if (![...sent].some(s => s.toLowerCase() === a.toLowerCase())) problems.push(`${a} has an audit attempt but no DELETE in this log (it may belong to an earlier log)`)
  }
  return { ok: problems.length === 0, problems, counts, deletes: muts.filter(m => m.method === 'DELETE').length, deletesInAuthorizedPhases: inAuth }
}
