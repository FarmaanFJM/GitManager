import { useState } from 'react'
import { Button, Icon } from '../../../third_party/summa-ui/src/ui'
import type { StorageState } from '../../shared/storage'
import { CATEGORIES, CLASSES, formatBytes, repoTotals, snapshotTotals } from '../../shared/storageTotals'
import { api } from '../api'
import { plural } from '../util'
import { CATEGORY_LABEL, CLASS_COLOR, CLASS_LABEL, dateTimeText } from './common'

const SEGMENTS = ['protected', 'keep', 'review', 'delete-candidate'] as const

/** One horizontal stacked bar: the share of each class, widths relative to the largest repository so sizes compare. */
function ClassBar({ parts, max }: { parts: { cls: typeof SEGMENTS[number]; bytes: number }[]; max: number }) {
  const total = parts.reduce((n, p) => n + p.bytes, 0)
  return (
    <span className="gm-bar" style={{ width: `${max ? Math.max(2, (100 * total) / max) : 0}%` }} role="img"
      aria-label={parts.filter(p => p.bytes).map(p => `${CLASS_LABEL[p.cls]} ${formatBytes(p.bytes)}`).join(', ') || 'Empty'}>
      {parts.filter(p => p.bytes > 0).map(p => <span key={p.cls} style={{ width: `${(100 * p.bytes) / total}%`, background: CLASS_COLOR[p.cls] }} />)}
    </span>
  )
}

function Stat({ label, value, hint, accent }: { label: string; value: string; hint?: string; accent?: boolean }) {
  return (
    <div className="gm-stat">
      <dt>{label}</dt>
      <dd className={accent ? 'gm-stat-accent' : ''}>{value}</dd>
      {hint && <span className="gm-stat-hint">{hint}</span>}
    </div>
  )
}

export function Overview({ st, onOpenRepo }: { st: StorageState; onOpenRepo: (repo: string) => void }) {
  const snap = st.snapshot
  const [notes, setNotes] = useState(false)
  if (!snap) {
    return (
      <div className="sm-empty sm-empty--center gm-storage-empty">
        <p className="sm-empty__text">No scan yet. A scan reads your repositories' Actions artifacts through the GitHub CLI and changes nothing.</p>
      </div>
    )
  }
  const t = snapshotTotals(snap)
  const repos = [...snap.repos].filter(r => !r.error).sort((a, b) => repoTotals(b).retainedBytes - repoTotals(a).retainedBytes)
  const maxRepo = Math.max(1, ...repos.map(r => repoTotals(r).retainedBytes))
  const maxCat = Math.max(1, ...CATEGORIES.map(c => t.byCategory[c].bytes))
  const candidateRepos = new Set(snap.repos.filter(r => repoTotals(r).byClass['delete-candidate'].count && r.canDelete).map(r => r.repo)).size
  const protectedBytes = t.byClass.protected.bytes
  const caches = snap.repos.filter(r => (r.cacheBytes ?? 0) > 0).sort((a, b) => (b.cacheBytes ?? 0) - (a.cacheBytes ?? 0))
  const b = snap.billing

  return (
    <div className="gm-scroll scroll">
      <section className="gm-answer" aria-label="Summary">
        <p>
          {snap.login ? <>Your scanned repositories hold </> : null}
          <strong>{formatBytes(t.retainedBytes)}</strong> of Actions artifacts right now.{' '}
          {t.reclaimableBytes > 0
            ? <><strong className="gm-stat-accent">{formatBytes(t.reclaimableBytes)}</strong> in {plural(candidateRepos, 'repository', 'repositories')} is superseded build output you can delete safely. Protected and recent builds stay.</>
            : <>Nothing is currently a verified delete candidate.</>}
        </p>
      </section>

      <dl className="gm-stats">
        <Stat label="Retained artifacts" value={formatBytes(t.retainedBytes)} hint="stored now, expired excluded" />
        <Stat label="Reclaimable" value={formatBytes(t.reclaimableBytes)} hint="verified delete candidates" accent={t.reclaimableBytes > 0} />
        <Stat label="Protected" value={formatBytes(protectedBytes)} hint={plural(t.byClass.protected.count, 'artifact')} />
        <Stat label="Repositories" value={String(t.repos)} hint={t.failedRepos ? `${t.failedRepos} not readable` : 'scanned'} />
        <Stat label="Artifacts" value={String(t.artifacts)} hint={t.expired ? `${t.expired} expired` : 'not expired'} />
        <Stat label="Last successful scan" value={snap.lastSuccessfulScanAt ? dateTimeText(snap.lastSuccessfulScanAt) : 'None yet'} hint={snap.scannedAt && snap.scannedAt !== snap.lastSuccessfulScanAt ? `latest attempt ${dateTimeText(snap.scannedAt)}` : undefined} />
      </dl>

      {st.snapshot && st.snapshot.alerts.length > 0 && (
        <ul className="gm-alerts" aria-label="Alerts">
          {st.snapshot.alerts.map(a => (
            <li key={a.id} className={`gm-alert ${a.severity}`}>
              <Icon name={a.severity === 'warn' ? 'triangle-alert' : 'info'} size={15} />
              <span>{a.message}</span>
              {a.repo && <button type="button" className="btn btn-ghost gm-banner-btn" onClick={() => onOpenRepo(a.repo!)}>Open</button>}
            </li>
          ))}
        </ul>
      )}

      <section className="gm-section" aria-label="Limitations">
        <h2 className="gm-section-h">
          Limitations <span className="faint num">{snap.limitations.length}</span>
          <button type="button" className="btn btn-ghost gm-banner-btn" aria-expanded={notes} onClick={() => setNotes(n => !n)}>{notes ? 'Hide' : 'Show'}</button>
        </h2>
        {notes
          ? <ul className="gm-notes">{snap.limitations.map((l, i) => <li key={i}>{l}</li>)}</ul>
          : <p className="gm-section-empty muted">{snap.limitations[0]}{snap.limitations.length > 1 ? ` (and ${snap.limitations.length - 1} more)` : ''}</p>}
      </section>

      <div className="gm-legend" aria-hidden="true">
        {CLASSES.filter(c => c !== 'expired').map(c => <span key={c}><i style={{ background: CLASS_COLOR[c] }} />{CLASS_LABEL[c]}</span>)}
      </div>

      <section className="gm-section" aria-label="By repository">
        <h2 className="gm-section-h">What is using the space, by repository</h2>
        <ul className="gm-bars">
          {repos.filter(r => repoTotals(r).retainedBytes > 0).slice(0, 12).map(r => {
            const rt = repoTotals(r)
            return (
              <li key={r.repo}>
                <button type="button" className="gm-barrow" onClick={() => onOpenRepo(r.repo)}>
                  <span className="truncate gm-bar-name">{r.repo}{r.protectedRepo ? <Icon name="shield" size={13} aria-label="Protected repository" /> : null}</span>
                  <ClassBar max={maxRepo} parts={SEGMENTS.map(cls => ({ cls, bytes: rt.byClass[cls].bytes }))} />
                  <span className="num gm-bar-size">{formatBytes(rt.retainedBytes)}</span>
                  <span className="num gm-bar-rec">{rt.reclaimableBytes ? `${formatBytes(rt.reclaimableBytes)} reclaimable` : ''}</span>
                </button>
              </li>
            )
          })}
          {repos.every(r => repoTotals(r).retainedBytes === 0) && <li className="muted gm-section-empty">No retained artifacts.</li>}
        </ul>
      </section>

      <section className="gm-section" aria-label="By artifact category">
        <h2 className="gm-section-h">By artifact category</h2>
        <ul className="gm-bars">
          {CATEGORIES.filter(c => t.byCategory[c].count > 0).map(c => (
            <li key={c} className="gm-barrow static">
              <span className="gm-bar-name">{CATEGORY_LABEL[c]}</span>
              <span className="gm-bar" style={{ width: `${Math.max(2, (100 * t.byCategory[c].bytes) / maxCat)}%` }}><span style={{ width: '100%', background: 'var(--text-3)' }} /></span>
              <span className="num gm-bar-size">{formatBytes(t.byCategory[c].bytes)}</span>
              <span className="num gm-bar-rec faint">{plural(t.byCategory[c].count, 'artifact')}</span>
            </li>
          ))}
        </ul>
        <p className="gm-hint gm-pad">Categories are inferred from artifact names and workflow metadata, not from file contents.</p>
      </section>

      <section className="gm-section" aria-label="Quota and billing">
        <h2 className="gm-section-h">Other GitHub storage and billing</h2>
        <p className="gm-hint gm-pad">These are different things and are never added together. The totals above are artifact bytes stored today.</p>
        <dl className="gm-kv">
          <dt>Actions caches</dt>
          <dd>
            {t.cacheKnown ? <><strong>{formatBytes(t.cacheBytes)}</strong> in {plural(caches.length, 'repository', 'repositories')}. </> : 'Not read. '}
            Caches have their own limit per repository and are evicted automatically; they are separate from the artifact total and from the packages allowance.
            {caches.slice(0, 3).map(r => <span key={r.repo} className="faint"> {r.repo} {formatBytes(r.cacheBytes ?? 0)}.</span>)}
          </dd>
          <dt>Packages</dt>
          <dd>
            {snap.packages.available
              ? <>{plural(snap.packages.packages.length, 'package')}{snap.packages.packages.length ? <> ({snap.packages.packages.slice(0, 4).map(p => `${p.name} · ${p.type}`).join(', ')}{snap.packages.packages.length > 4 ? ', …' : ''})</> : null}. Sizes are not exposed by the GitHub API.</>
              : <>Unavailable. {snap.packages.message}</>}
          </dd>
          <dt>Billing this month</dt>
          <dd>
            {b.available ? (
              b.items.length ? (
                <ul className="gm-billing">
                  {b.items.map(i => (
                    <li key={i.sku}>
                      <span>{i.sku.replace(/^actions_/, 'Actions ').replace(/_/g, ' ')}</span>
                      <span className="num">{i.quantity.toLocaleString(undefined, { maximumFractionDigits: 2 })} {i.unit === 'GigabyteHours' ? 'GB-hours accrued' : i.unit === 'Minutes' ? 'runner minutes' : i.unit}</span>
                    </li>
                  ))}
                </ul>
              ) : <>No Actions or Packages usage reported for {b.period}.</>
            ) : <><strong>Billing data unavailable.</strong> {b.message}</>}
            <p className="gm-hint">GB-hours are storage accrued over time, not bytes stored now, and runner minutes are compute. GitHub's API does not report your included allowance, so GitManager shows none and does not estimate one.</p>
            <Button variant="ghost" icon="external" onClick={() => void api.storageOpen({ kind: 'billing' })}>Open GitHub billing</Button>
          </dd>
        </dl>
        <p className="gm-hint gm-pad">After deleting artifacts, GitHub can take time to recalculate storage usage and billing, so allowance figures on github.com may lag behind.</p>
      </section>
    </div>
  )
}
