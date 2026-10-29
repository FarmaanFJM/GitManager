import { useEffect, useState } from 'react'
import { Button, Checkbox, Dialog, Dropdown, Switch } from '../../../third_party/summa-ui/src/ui'
import type { ArtifactCategory, Frequency, Mode, RepoPolicy, StorageSettings, StorageState } from '../../shared/storage'
import { formatBytes } from '../../shared/storageTotals'
import { api } from '../api'
import { plural } from '../util'
import { CATEGORY_LABEL, dateTimeText } from './common'

const MODE_LABEL: Record<Mode, string> = { manual: 'Manual', recommend: 'Automatic recommendations', 'auto-safe': 'Automatic safe cleanup' }
const MODE_HINT: Record<Mode, string> = {
  manual: 'Scan and clean only when you ask.',
  recommend: 'Scan periodically and prepare suggestions. Nothing is deleted without your approval.',
  'auto-safe': 'Periodically delete only high-confidence superseded builds and obsolete reports that satisfy this approved policy.',
}
const GB = 1024 ** 3

const policyOf = (st: StorageState, repo: string | null): RepoPolicy => (repo ? st.config.policies[repo.toLowerCase()] ?? st.config.defaultPolicy : st.config.defaultPolicy)

/** The mode that applies (computed in the main process): an automatic policy without a matching approval runs as recommendations. */
function modeOf(st: StorageState, repo: string | null): { mode: Mode; voided: boolean } {
  const p = policyOf(st, repo)
  const mode = st.effectiveModes[repo && st.config.policies[repo.toLowerCase()] ? repo.toLowerCase() : 'default'] ?? p.mode
  return { mode, voided: p.mode === 'auto-safe' && mode !== 'auto-safe' }
}

export function PolicyDialog({ st, repo, onClose }: { st: StorageState; repo: string | null | undefined; onClose: () => void }) {
  const open = repo !== undefined
  const [p, setP] = useState<RepoPolicy>(policyOf(st, repo ?? null))
  const [approve, setApprove] = useState(false)
  const [patterns, setPatterns] = useState('')
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (repo === undefined) return
    const cur = policyOf(st, repo)
    setP(cur); setApprove(modeOf(st, repo).mode === 'auto-safe'); setError(null); setPatterns(cur.evidencePatterns.join(', '))
  }, [repo]) // eslint-disable-line react-hooks/exhaustive-deps
  // any edit withdraws an earlier approval: the user approves exactly the values they see
  const set = <K extends keyof RepoPolicy>(k: K, v: RepoPolicy[K]) => { setP(x => ({ ...x, [k]: v })); setApprove(false) }
  const toggleCat = (c: ArtifactCategory) => set('deleteCategories', p.deleteCategories.includes(c) ? p.deleteCategories.filter(x => x !== c) : [...p.deleteCategories, c])
  const inv = st.snapshot?.repos.find(r => r.repo === repo)
  const nowEligible = inv ? inv.artifacts.filter(a => a.class === 'delete-candidate' && (a.reasonCode === 'superseded-build' || a.reasonCode === 'obsolete-report')) : []

  const save = async () => {
    const policy = { ...p, evidencePatterns: patterns.split(',').map(s => s.trim()).filter(Boolean) }
    const r = await api.storageSavePolicy(repo ?? null, policy, approve)
    if (!r.ok) { setError(r.error.message); return }
    onClose()
  }
  const needsApproval = p.mode === 'auto-safe'
  return (
    <Dialog open={open} onClose={onClose} title={repo ? `Cleanup policy: ${repo}` : 'Default cleanup policy'} width={620}
      description={repo ? 'Applies only to this repository.' : 'Applies to repositories that have no policy of their own.'}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={needsApproval && !approve} onClick={() => void save()}>Save policy</Button></>}>
      <div className="gm-policy">
        <div className="row">
          <span className="gm-label">Start from</span>
          <Dropdown label="Preset" value={p.presetId} placeholder="Choose a preset to review" width={380}
            options={st.presets.map(x => ({ value: x.id, label: x.label }))}
            onChange={id => { const pr = st.presets.find(x => x.id === id); if (pr) { setP(x => ({ ...x, ...pr.policy, presetId: id, approvedHash: null, approvedAt: null })); setApprove(false); setPatterns((pr.policy.evidencePatterns ?? p.evidencePatterns).join(', ')) } }} />
        </div>
        {p.presetId && <p className="gm-hint">{st.presets.find(x => x.id === p.presetId)?.description} A preset is a starting point to review, not a guarantee.</p>}
        <div className="gm-field"><span className="gm-label">Mode</span>
          <Dropdown label="Mode" value={p.mode} onChange={v => set('mode', v)} options={(['manual', 'recommend', 'auto-safe'] as Mode[]).map(m => ({ value: m, label: MODE_LABEL[m] }))} />
          <p className="gm-hint">{MODE_HINT[p.mode]}</p>
        </div>
        <div className="gm-grid">
          <label className="gm-field"><span className="gm-label">Keep the newest successful builds</span>
            <input className="input" type="number" min={1} max={10} value={p.keepLatest} onChange={e => set('keepLatest', Number(e.target.value))} />
            <span className="gm-hint">Per artifact family and platform. At least 1: the last usable build is never offered.</span></label>
          <label className="gm-field"><span className="gm-label">Remove superseded builds older than (days)</span>
            <input className="input" type="number" min={1} max={365} value={p.tempDays} onChange={e => set('tempDays', Number(e.target.value))} /></label>
          <label className="gm-field"><span className="gm-label">Remove obsolete CI reports and logs older than (days)</span>
            <input className="input" type="number" min={1} max={365} value={p.reportDays} onChange={e => set('reportDays', Number(e.target.value))} /></label>
          <label className="gm-field"><span className="gm-label">Large deletion needs approval above (GB)</span>
            <input className="input" type="number" min={0} step={0.5} value={+(p.largeDeleteBytes / GB).toFixed(2)} onChange={e => set('largeDeleteBytes', Math.round(Number(e.target.value) * GB))} /></label>
        </div>
        <div className="gm-field"><span className="gm-label">Categories that may become delete candidates</span>
          <div className="row gm-cats">
            {(['installer', 'build', 'report', 'logs'] as ArtifactCategory[]).map(c => <span key={c} className="row"><Checkbox checked={p.deleteCategories.includes(c)} onChange={() => toggleCat(c)} label={CATEGORY_LABEL[c]} />{CATEGORY_LABEL[c]}</span>)}
          </div>
        </div>
        <label className="gm-field"><span className="gm-label">Always preserve (qualification and audit evidence)</span>
          <input className="input gm-mono" value={patterns} onChange={e => { setPatterns(e.target.value); setApprove(false) }} spellCheck={false} />
          <span className="gm-hint">Comma-separated words. An artifact whose name, or whose workflow's name or file, contains one is Protected.</span></label>
        <p className="gm-hint">Always preserved regardless of policy: protected repositories and pinned artifacts, artifacts cited in documentation, the current release, open pull requests, running workflows, and ambiguous or unverified artifacts.</p>
        {needsApproval && (
          <div className="gm-approve">
            <div className="row"><Checkbox checked={approve} onChange={setApprove} label="I approve automatic deletion under this policy" /><span>I approve automatic deletion under exactly these values.</span></div>
            <p className="gm-hint">{repo && inv ? `With the last scan, ${plural(nowEligible.length, 'artifact')} (${formatBytes(nowEligible.reduce((n, a) => n + a.sizeBytes, 0))}) would qualify.` : ''} Deletions are permanent. Changing any value above later withdraws this approval and the repository falls back to recommendations until you approve again.</p>
          </div>
        )}
        {error && <p className="gm-field-error" role="alert">{error}</p>}
      </div>
    </Dialog>
  )
}

export function AutoCleanup({ st, onReview, onEditPolicy }: { st: StorageState; onReview: (repos: string[] | null) => void; onEditPolicy: (repo: string | null) => void }) {
  const s = st.config.settings
  const sch = st.scheduler
  const [draft, setDraft] = useState<StorageSettings>(s)
  const [thresholdGb, setThresholdGb] = useState(s.alerts.highBytes ? String(+(s.alerts.highBytes / GB).toFixed(2)) : '')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  useEffect(() => { setDraft(st.config.settings) }, [st.config.settings])
  const dirty = JSON.stringify(draft) !== JSON.stringify(s) || thresholdGb !== (s.alerts.highBytes ? String(+(s.alerts.highBytes / GB).toFixed(2)) : '')
  const save = async () => {
    const hb = thresholdGb.trim() ? Math.round(Number(thresholdGb) * GB) : null
    await api.storageSaveSettings({ ...draft, alerts: { ...draft.alerts, highBytes: hb && hb > 0 ? hb : null } })
  }
  const runNow = async () => {
    setBusy(true); setMsg(null)
    const r = await api.storageRunAutomation()
    setBusy(false)
    setMsg(r.ok ? `Scanned ${plural(r.value.scanned.length, 'repository', 'repositories')}; deleted ${r.value.deleted}; ${r.value.recommended} suggestions waiting.` : r.error.message)
  }
  const repos = st.snapshot?.repos ?? []
  const rec = st.recommendation
  const modeRows = repos.map(r => ({ r, p: policyOf(st, r.repo), custom: !!st.config.policies[r.repo.toLowerCase()] }))
  return (
    <div className="gm-scroll scroll">
      <form className="gm-form" onSubmit={e => { e.preventDefault(); void save() }}>
        <div className="gm-form-head gm-form-head-first"><h2 className="gm-section-h">Auto Cleanup</h2></div>
        <p className="gm-hint">Off by default. Turning it on only schedules scans of repositories whose mode is not Manual; nothing is deleted unless a repository is in <em>Automatic safe cleanup</em> with a policy you approved. {sch.note}</p>

        <div className="gm-switch-field">
          <fieldset className="gm-switch-row"><Switch checked={draft.scheduleEnabled} onChange={v => setDraft(d => ({ ...d, scheduleEnabled: v }))} label="Scan on a schedule" /><span>Scan on a schedule</span></fieldset>
        </div>
        <div className="row">
          <span className="gm-label">How often</span>
          <Dropdown<Frequency> label="Frequency" value={draft.frequency} onChange={v => setDraft(d => ({ ...d, frequency: v }))} options={[{ value: 'daily', label: 'Daily' }, { value: 'weekly', label: 'Weekly' }, { value: 'monthly', label: 'Monthly' }]} />
          <span className="grow" />
          <Button onClick={() => void runNow()} disabled={busy || st.scan.running || st.operation.running} aria-busy={busy || undefined}>{busy && <span className="sm-spinner" aria-hidden="true" />}Run now</Button>
        </div>
        <dl className="gm-kv gm-kv-tight">
          <dt>Next scheduled scan</dt><dd>{sch.enabled ? dateTimeText(sch.nextRunAt) : 'Not scheduled'}</dd>
          <dt>Last scheduled run</dt><dd>{dateTimeText(sch.lastRunAt)}</dd>
          <dt>Last completed cleanup</dt><dd>{sch.lastCleanupAt ? `${dateTimeText(sch.lastCleanupAt)}: ${sch.lastCleanupSummary}` : 'None yet'}</dd>
          {sch.lastError && <><dt>Last problem</dt><dd className="gm-warn">{sch.lastError}</dd></>}
        </dl>
        {msg && <p className="gm-hint" role="status">{msg}</p>}

        {rec && rec.refs.length > 0 && (
          <div className="gm-answer gm-rec">
            <p><strong>{plural(rec.refs.length, 'artifact')}</strong> ({formatBytes(rec.bytes)}) are ready for your review from the {dateTimeText(rec.at)} run.</p>
            <Button variant="primary" onClick={() => onReview([...new Set(rec.refs.map(x => x.repo))])}>Review</Button>
            <Button variant="ghost" onClick={() => void api.storageDismissRecommendation()}>Dismiss</Button>
          </div>
        )}

        <div className="gm-form-head"><h2 className="gm-section-h">Policies</h2><span className="grow" /><Button variant="ghost" icon="sliders" onClick={() => onEditPolicy(null)}>Default policy</Button></div>
        <p className="gm-hint">Each repository can have its own policy. Repositories without one use the default, which starts in Manual mode.</p>
        {modeRows.length === 0 ? <p className="muted gm-section-empty">Scan to list repositories.</p> : (
          <ul className="gm-roots">
            {modeRows.map(({ r, p, custom }) => {
              const eff = modeOf(st, r.repo)
              return (
                <li key={r.repo} className="gm-root-row">
                  <span className="truncate">{r.repo}</span>
                  <span className="grow" />
                  <span className={eff.voided ? 'gm-warn' : 'muted'}>{MODE_LABEL[eff.mode]}{eff.voided ? ' (awaiting your approval)' : ''}{custom ? '' : ' · default'}</span>
                  <Button variant="ghost" onClick={() => onEditPolicy(r.repo)}>Edit</Button>
                </li>
              )
            })}
          </ul>
        )}

        <div className="gm-form-head"><h2 className="gm-section-h">Scan scope</h2></div>
        <div className="row">
          <span className="gm-label">Repositories</span>
          <Dropdown label="Scope" value={draft.scope} onChange={v => setDraft(d => ({ ...d, scope: v }))} width={320} options={[{ value: 'writable', label: 'All I can write to' }, { value: 'owned', label: 'Only repositories I own' }]} />
        </div>
        <div className="gm-switch-field"><fieldset className="gm-switch-row"><Switch checked={draft.includeArchived} onChange={v => setDraft(d => ({ ...d, includeArchived: v }))} label="Include archived repositories" /><span>Include archived repositories (read-only)</span></fieldset></div>

        <div className="gm-form-head"><h2 className="gm-section-h">Alerts</h2></div>
        <p className="gm-hint">Alerts appear in Storage. They are informative and never block anything.</p>
        {([['growth', 'Retained storage grew sharply since the previous scan'], ['repeatedBuilds', 'A repository keeps many large copies of the same build'], ['oldBuilds', 'Old builds are a large share of retained storage']] as const).map(([k, label]) => (
          <div key={k} className="gm-switch-field"><fieldset className="gm-switch-row"><Switch checked={draft.alerts[k]} onChange={v => setDraft(d => ({ ...d, alerts: { ...d.alerts, [k]: v } }))} label={label} /><span>{label}</span></fieldset></div>
        ))}
        <label className="gm-field"><span className="gm-label">Warn when retained artifacts exceed (GB)</span>
          <input className="input" type="number" min={0} step={0.1} placeholder="Off" value={thresholdGb} onChange={e => setThresholdGb(e.target.value)} />
          <span className="gm-hint">Your own level. GitManager cannot read your plan's allowance, so it never guesses one.</span></label>
        <div className="gm-switch-field"><fieldset className="gm-switch-row"><Switch checked={draft.notify} onChange={v => setDraft(d => ({ ...d, notify: v }))} label="System notifications for scheduled results" /><span>System notifications for scheduled results</span></fieldset>
          <p className="gm-hint">One quiet notification when a scheduled run cleans up, has suggestions, or fails.</p></div>
        <div className="row"><Button variant="primary" type="submit" disabled={!dirty}>Save</Button>{dirty && <Button variant="ghost" onClick={() => { setDraft(s); setThresholdGb(s.alerts.highBytes ? String(+(s.alerts.highBytes / GB).toFixed(2)) : '') }}>Discard</Button>}</div>
      </form>
    </div>
  )
}
