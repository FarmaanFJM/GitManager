// Which labels the workflows of a repository ask for, and which known runners could take those jobs. A small purpose-built
// reader of the runs-on key (scalar, inline list, block list, group mapping, expressions); it never changes a workflow file.
import type { Runner, RunnerScope, WorkflowJobLabels, WorkflowLabelFile, WorkflowLabelReport } from '../../shared/runners.js'
import { sameScope } from './model.js'

const HOSTED = /^(ubuntu|windows|macos)-/i

const unquote = (v: string) => v.trim().replace(/^(['"])(.*)\1$/, '$2').trim()
const splitInline = (v: string) => v.replace(/^\[|\]$/g, '').split(',').map(unquote).filter(Boolean)

/** Jobs and their runs-on labels from one workflow file. Unparseable files report an error instead of a guess. */
export function parseRunsOn(text: string): WorkflowLabelFile['jobs'] {
  const lines = text.split(/\r?\n/)
  const indent = (l: string) => l.length - l.trimStart().length
  const jobs: WorkflowJobLabels[] = []
  const jobsAt = lines.findIndex(l => /^jobs:\s*(#.*)?$/.test(l))
  if (jobsAt < 0) return jobs
  let i = jobsAt + 1
  let jobIndent = -1
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim() || line.trim().startsWith('#')) { i++; continue }
    const ind = indent(line)
    if (ind === 0) break
    if (jobIndent < 0) jobIndent = ind
    if (ind !== jobIndent) { i++; continue }
    const m = /^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(#.*)?$/.exec(line)
    if (!m) { i++; continue }
    const job: WorkflowJobLabels = { job: m[1], runsOn: [], dynamic: false, group: null, matched: [], problem: null }
    let j = i + 1
    for (; j < lines.length; j++) {
      const l = lines[j]
      if (!l.trim() || l.trim().startsWith('#')) continue
      const li = indent(l)
      if (li <= jobIndent) break
      const ro = /^\s*runs-on\s*:\s*(.*?)\s*(#.*)?$/.exec(l)
      if (!ro || li !== jobIndent + indentStep(lines, j, jobIndent)) continue
      const value = ro[1]
      if (/\$\{\{/.test(value)) { job.dynamic = true; break }
      if (value.startsWith('[')) { job.runsOn = splitInline(value); break }
      if (value.startsWith('{')) { // inline mapping { group: g, labels: [..] }
        const g = /group\s*:\s*([^,}]+)/.exec(value); if (g) job.group = unquote(g[1])
        const lb = /labels\s*:\s*(\[[^\]]*\]|[^,}]+)/.exec(value); if (lb) job.runsOn = lb[1].startsWith('[') ? splitInline(lb[1]) : [unquote(lb[1])]
        break
      }
      if (value) { job.runsOn = [unquote(value)]; break }
      // block list or mapping below runs-on
      for (let k = j + 1; k < lines.length; k++) {
        const b = lines[k]
        if (!b.trim() || b.trim().startsWith('#')) continue
        if (indent(b) <= li) break
        const item = /^\s*-\s*(.+?)\s*(#.*)?$/.exec(b)
        if (item) { if (/\$\{\{/.test(item[1])) job.dynamic = true; else job.runsOn.push(unquote(item[1])); continue }
        const g = /^\s*group\s*:\s*(.+?)\s*(#.*)?$/.exec(b); if (g) { job.group = unquote(g[1]); continue }
        const lb = /^\s*labels\s*:\s*(.*?)\s*(#.*)?$/.exec(b)
        if (lb) {
          if (/\$\{\{/.test(lb[1])) job.dynamic = true
          else if (lb[1].startsWith('[')) job.runsOn.push(...splitInline(lb[1]))
          else if (lb[1]) job.runsOn.push(unquote(lb[1]))
          else for (let q = k + 1; q < lines.length; q++) { const it = /^\s*-\s*(.+?)\s*(#.*)?$/.exec(lines[q]); if (!it || indent(lines[q]) <= indent(b)) break; job.runsOn.push(unquote(it[1])) }
        }
      }
      break
    }
    jobs.push(job)
    i = j
  }
  return jobs
}

function indentStep(lines: string[], at: number, jobIndent: number): number {
  // the first child line of the job decides the step (2 or 4 spaces, tabs are not valid YAML indentation)
  for (let k = at; k < lines.length && k < at + 60; k++) { const l = lines[k]; const ind = l.length - l.trimStart().length; if (l.trim() && ind > jobIndent) return ind - jobIndent }
  return 2
}

export const isSelfHostedRequest = (labels: string[]) => labels.length > 0 && !(labels.length === 1 && HOSTED.test(labels[0])) && (labels.some(l => l.toLowerCase() === 'self-hosted') || !labels.every(l => HOSTED.test(l)))

/** Runners whose labels include every requested label (case-insensitive), inside the repository's own scope or its organization. */
export function matchRunners(labels: string[], runners: Runner[], repoScope: Extract<RunnerScope, { kind: 'repo' }>): Runner[] {
  const want = labels.map(l => l.toLowerCase())
  return runners.filter(r => {
    if (!r.scope) return false
    const inScope = sameScope(r.scope, repoScope) || (r.scope.kind === 'org' && r.scope.org.toLowerCase() === repoScope.owner.toLowerCase())
    if (!inScope) return false
    const have = new Set((r.github ? r.github.labels.map(l => l.name) : []).map(l => l.toLowerCase()))
    if (!r.github) return false // labels are only known from GitHub
    return want.every(w => have.has(w))
  })
}

export function buildReport(repo: string, source: 'local' | 'github', files: { path: string; text: string }[], runners: Runner[], errors: string[] = []): WorkflowLabelReport {
  const [owner, name] = repo.split('/')
  const scope: Extract<RunnerScope, { kind: 'repo' }> = { kind: 'repo', owner, repo: name }
  const out: WorkflowLabelFile[] = []
  const unmatched = new Set<string>()
  const used = new Set<string>()
  for (const f of files) {
    let jobs: WorkflowJobLabels[] = []
    let error: string | null = null
    try { jobs = parseRunsOn(f.text) } catch (e) { error = (e as Error).message }
    const nameMatch = /^name\s*:\s*(.+?)\s*(#.*)?$/m.exec(f.text)
    for (const j of jobs) {
      if (j.dynamic) { j.problem = 'Labels come from an expression and cannot be checked here.'; continue }
      if (!isSelfHostedRequest(j.runsOn)) { j.problem = j.runsOn.length ? 'GitHub-hosted runner.' : 'No runs-on found.'; continue }
      const m = matchRunners(j.runsOn, runners, scope)
      j.matched = m.map(r => r.key)
      for (const r of m) used.add(r.key)
      if (!m.length) { j.problem = 'No known runner carries all of these labels.'; for (const l of j.runsOn) unmatched.add(l) }
      else if (m.every(r => r.status === 'offline')) j.problem = 'Matching runners are offline.'
      else if (j.group && !m.some(r => r.github?.runnerGroupName === j.group)) j.problem = `No matching runner is in group ${j.group}.`
    }
    out.push({ path: f.path, name: nameMatch ? unquote(nameMatch[1]) : null, jobs, error })
  }
  const inScope = runners.filter(r => r.scope && (sameScope(r.scope, scope) || (r.scope.kind === 'org' && r.scope.org.toLowerCase() === owner.toLowerCase())))
  return {
    repo, source, files: out, unmatched: [...unmatched], idleRunners: inScope.filter(r => !used.has(r.key)).map(r => r.key), errors,
    note: 'Matching labels do not by themselves authorize a runner: repository runners serve only their repository, and organization runners serve the repositories their runner group allows.',
  }
}
