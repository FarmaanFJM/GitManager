import { useEffect, useMemo, useState } from 'react'
import { Button, Dropdown, Icon } from '../../../../third_party/summa-ui/src/ui'
import type { ToastApi } from '../../../../third_party/summa-ui/src/presets'
import type { RunnersState, WorkflowLabelReport } from '../../../shared/runners'
import { api } from '../../api'
import { copyText, scopeText } from '../common'

/** Which labels the workflows of a repository ask for, matched against the runners GitHub confirmed for that repository or its organization. */
export function WorkflowsTab({ st, toast, onOpenRunner }: { st: RunnersState; toast: ToastApi; onOpenRunner: (key: string) => void }) {
  const repos = useMemo(() => {
    const set = new Set<string>()
    for (const r of st.inventory.runners) if (r.scope?.kind === 'repo') set.add(scopeText(r.scope))
    for (const s of st.inventory.scopes) if (s.scope.kind === 'repo') set.add(scopeText(s.scope))
    for (const r of st.config.settings.repos) set.add(r)
    return [...set].sort()
  }, [st])
  const [repo, setRepo] = useState<string | null>(null)
  const [report, setReport] = useState<WorkflowLabelReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  useEffect(() => { if (!repo && repos[0]) setRepo(repos[0]) }, [repos, repo])
  const load = async (r: string) => {
    setLoading(true); setError(null)
    const x = await api.runnersWorkflows(r)
    setLoading(false)
    if (x.ok) setReport(x.value); else { setReport(null); setError(x.error.message) }
  }
  useEffect(() => { if (repo) void load(repo) }, [repo]) // eslint-disable-line react-hooks/exhaustive-deps
  const name = (key: string) => st.inventory.runners.find(r => r.key === key)?.name ?? key
  return (
    <div className="gm-storage-pane">
      <div className="gm-toolbar gm-wf-tools">
        <span className="gm-label">Repository</span>
        <Dropdown label="Repository" searchable width={340} value={repo} placeholder={repos.length ? 'Choose a repository' : 'No GitHub repositories known'} options={repos.map(r => ({ value: r, label: r }))} onChange={setRepo}
          onCreate={n => { if (/^[^/\s]+\/[^/\s]+$/.test(n)) { setRepo(n); return n } toast.error('Enter the repository as owner/name'); return undefined }} createNoun="repository" />
        <span className="grow" />
        {report && <span className="muted gm-scan-prog">Read from {report.source === 'local' ? 'the local clone' : 'GitHub'}</span>}
        {repo && <Button variant="ghost" icon="external" onClick={() => void api.runnersOpen({ kind: 'workflows', scope: { kind: 'repo', owner: repo.split('/')[0], repo: repo.split('/')[1] } })}>Actions on GitHub</Button>}
      </div>
      {loading && <div className="gm-loading-line"><span className="sm-spinner" aria-hidden="true" /> Reading workflows</div>}
      {error && <p className="gm-branch-problem" role="alert"><Icon name="circle-alert" size={15} />{error}</p>}
      {report && !loading && (
        <div className="gm-scroll scroll">
          <p className="gm-section-empty gm-hint">{report.note} Workflow files are read only; GitManager never changes them.</p>
          {report.files.length === 0 && <p className="gm-section-empty muted">No workflow files in .github/workflows.</p>}
          {report.files.map(f => (
            <section key={f.path} className="gm-section" aria-label={f.path}>
              <h3 className="gm-section-h">{f.name ?? f.path} <span className="muted gm-mono-sm">{f.path}</span></h3>
              {f.error && <p className="gm-section-empty gm-warn">{f.error}</p>}
              <ul className="gm-wf-jobs">
                {f.jobs.map(j => (
                  <li key={j.job} className="gm-wf-job">
                    <span className="gm-wf-name">{j.job}</span>
                    <span className="gm-wf-labels gm-mono-sm">{j.dynamic ? 'expression' : j.group ? `group ${j.group}: ` : ''}{j.runsOn.join(', ')}</span>
                    <span className={`gm-wf-match ${j.problem && !j.problem.startsWith('GitHub-hosted') ? 'gm-warn' : 'muted'}`}>
                      {j.matched.length ? j.matched.map((k, i) => <span key={k}>{i ? ', ' : ''}<button type="button" className="gm-linkbtn" onClick={() => onOpenRunner(k)}>{name(k)}</button></span>) : null}
                      {j.problem ? (j.matched.length ? ` (${j.problem})` : j.problem) : ''}
                    </span>
                    {!j.dynamic && j.runsOn.length > 0 && <Button variant="ghost" className="gm-banner-btn" onClick={() => void copyText(`runs-on: [${j.runsOn.join(', ')}]`).then(ok => ok && toast.success('runs-on copied'))}>Copy</Button>}
                  </li>
                ))}
                {f.jobs.length === 0 && !f.error && <li className="muted gm-wf-job">No jobs found.</li>}
              </ul>
            </section>
          ))}
          {report.unmatched.length > 0 && <section className="gm-section"><h3 className="gm-section-h">Labels no known runner offers</h3><p className="gm-section-empty gm-mono-sm">{report.unmatched.join(', ')}</p></section>}
          {report.idleRunners.length > 0 && <section className="gm-section"><h3 className="gm-section-h">Runners no workflow here asks for</h3><p className="gm-section-empty muted">{report.idleRunners.map((k, i) => <span key={k}>{i ? ', ' : ''}<button type="button" className="gm-linkbtn" onClick={() => onOpenRunner(k)}>{name(k)}</button></span>)}</p></section>}
          {report.errors.map((e, i) => <p key={i} className="gm-branch-problem"><Icon name="info" size={15} />{e}</p>)}
        </div>
      )}
    </div>
  )
}
