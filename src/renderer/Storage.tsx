import { useEffect, useState } from 'react'
import { Button, DrawerToggle, Icon, Tabs } from '../../third_party/summa-ui/src/ui'
import { formatBytes, snapshotTotals } from '../shared/storageTotals'
import type { StorageState } from '../shared/storage'
import { api } from './api'
import { ErrorBanner } from './Workspace'
import type { OpError } from '../shared/types'
import { Activity } from './storage/Activity'
import { AutoCleanup, PolicyDialog } from './storage/Auto'
import { CleanupDialog } from './storage/Cleanup'
import { useStorageState } from './storage/common'
import { Overview } from './storage/Overview'
import { RepoDetail, RepoList } from './storage/Repositories'
import { ago } from './util'

type Tab = 'overview' | 'repos' | 'auto' | 'activity'

/** Why scanning is not possible, and exactly how to fix it. Missing sign-in and missing permission are different problems. */
function AuthNotice({ st }: { st: StorageState }) {
  const a = st.auth
  if (!a || a.state === 'ok') {
    if (a && a.state === 'ok' && a.canWrite === false) {
      return <div className="gm-notice" role="status"><Icon name="lock" size={16} /><div><p>Read-only: this GitHub CLI sign-in has no <span className="gm-mono">repo</span> scope, so GitManager can scan but not delete.</p><p className="gm-hint">To allow deletion run <span className="gm-mono">gh auth refresh -s repo</span> in a terminal. Nothing else is requested.</p></div></div>
    }
    return null
  }
  return (
    <div className="gm-notice warn" role="alert">
      <Icon name="circle-alert" size={16} />
      <div>
        <p>{a.state === 'no-gh' ? 'The GitHub CLI (gh) was not found.' : a.state === 'unauthenticated' ? 'GitHub CLI is not signed in.' : 'GitHub could not be reached.'} {a.state === 'error' ? a.message : ''}</p>
        <p className="gm-hint">{a.state === 'no-gh' ? <>Install it from <span className="gm-mono">cli.github.com</span>, then run <span className="gm-mono">gh auth login</span> in a terminal.</>
          : a.state === 'unauthenticated' ? <>Run <span className="gm-mono">gh auth login</span> in a terminal and choose GitHub.com. GitManager uses that session and never asks for a token.</> : 'Check your connection and try again.'}</p>
      </div>
      <Button variant="secondary" onClick={() => void api.storageAuth()}>Check again</Button>
    </div>
  )
}

export function StorageView() {
  const { state: st } = useStorageState()
  const [tab, setTab] = useState<Tab>('overview')
  const [repoName, setRepoName] = useState<string | null>(null)
  const [cleanup, setCleanup] = useState<{ repos: string[] | null } | null>(null)
  const [policy, setPolicy] = useState<string | null | undefined>(undefined)
  const [banner, setBanner] = useState<OpError | null>(null)
  useEffect(() => { document.title = 'Storage · GitManager' }, [])

  if (!st) return <div className="gm-work"><header className="gm-top"><DrawerToggle /><h1 className="gm-h1">Storage</h1></header><div className="gm-loading-line"><span className="sm-spinner" aria-hidden="true" /> Loading</div></div>

  const scanning = st.scan.running
  const t = st.snapshot ? snapshotTotals(st.snapshot) : null
  const scan = async () => {
    const r = await api.storageScan()
    // sign-in problems already have their own notice with the fix; everything else is shown as a banner
    if (!r.ok && !['NO_GH', 'NOT_SIGNED_IN', 'AUTH_ERROR'].includes(r.error.code)) setBanner({ code: r.error.code, message: r.error.message })
    else setBanner(null)
  }
  const openRepo = (name: string) => { setRepoName(name); setTab('repos') }
  const repo = st.snapshot?.repos.find(r => r.repo === repoName) ?? null

  return (
    <div className="gm-work">
      <header className="gm-top">
        <DrawerToggle />
        <div className="gm-title">
          <h1 className="gm-h1">Storage</h1>
          <span className="gm-path truncate">{st.snapshot?.login ? `GitHub Actions artifacts · ${st.snapshot.login}` : 'GitHub Actions artifacts'}</span>
        </div>
        <span className="grow" />
        {scanning && <span className="muted gm-scan-prog" role="status">{st.scan.phase === 'inventory' ? `Scanning ${Math.min(st.scan.done + 1, st.scan.total)} of ${st.scan.total}` : 'Scanning'}{st.scan.current ? ` · ${st.scan.current}` : ''}</span>}
        {scanning && <Button variant="ghost" onClick={() => void api.storageCancel()}>Stop</Button>}
        <Button variant={st.snapshot ? 'secondary' : 'primary'} onClick={() => void scan()} disabled={scanning || st.operation.running} aria-busy={scanning || undefined}>
          {scanning ? <span className="sm-spinner" aria-hidden="true" /> : <Icon name="refresh" size={15} />}{st.snapshot ? 'Scan again' : 'Scan'}
        </Button>
        <Button variant="primary" icon="trash" onClick={() => setCleanup({ repos: null })} disabled={!t || scanning || st.operation.running || (t.reclaimableBytes === 0 && t.byClass.review.count === 0)}
          title={t && t.reclaimableBytes ? `Preview what would be deleted (${formatBytes(t.reclaimableBytes)})` : 'Nothing to clean up'}>Review cleanup</Button>
      </header>

      <AuthNotice st={st} />
      {banner && <ErrorBanner error={banner} onDismiss={() => setBanner(null)} />}
      {st.scan.cancelled && !scanning && <p className="gm-branch-problem" role="status"><Icon name="info" size={15} />The last scan was stopped; the previous results are shown.</p>}
      {st.snapshot && st.snapshot.scannedAt && <p className="gm-branch-meta faint gm-scan-meta">Read from GitHub {ago(st.snapshot.scannedAt)}. Figures do not update until you scan again.</p>}

      <div className="gm-tabs-row">
        <Tabs label="Storage" value={tab} onChange={v => { setTab(v); if (v !== 'repos') setRepoName(null) }} items={[
          { value: 'overview', label: 'Overview' },
          { value: 'repos', label: st.snapshot ? `Repositories ${st.snapshot.repos.length}` : 'Repositories' },
          { value: 'auto', label: 'Auto Cleanup' },
          { value: 'activity', label: 'Activity' },
        ]} />
      </div>

      {tab === 'overview' && <Overview st={st} onOpenRepo={openRepo} />}
      {tab === 'repos' && (repo
        ? <RepoDetail st={st} repo={repo} onBack={() => setRepoName(null)} onEditPolicy={setPolicy} onReview={repos => setCleanup({ repos })} />
        : <RepoList st={st} onOpen={setRepoName} />)}
      {tab === 'auto' && <AutoCleanup st={st} onReview={repos => setCleanup({ repos })} onEditPolicy={setPolicy} />}
      {tab === 'activity' && <Activity st={st} />}

      <CleanupDialog st={st} open={cleanup !== null} repos={cleanup?.repos ?? null} onClose={() => setCleanup(null)} />
      <PolicyDialog st={st} repo={policy} onClose={() => setPolicy(undefined)} />
    </div>
  )
}
