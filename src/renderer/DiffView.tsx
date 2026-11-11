import { useMemo } from 'react'
import { Button } from '../../third_party/summa-ui/src/ui'
import type { DiffHunk, FileDiff, HunkAction } from '../shared/changes'
import { languageOf, tokenize } from './highlight'
import { plural } from './util'

/**
 * A readable unified diff: line numbers on both sides, additions and deletions in colour, syntax colouring where the file type is
 * known, and for a file that allows it one set of actions per hunk. Every action calls back into the working-tree service; the
 * buttons exist only when the diff can really be applied piecemeal (the service decides, `hunkable`).
 */
export function DiffView({ diff, onHunk, busy }: { diff: FileDiff; onHunk?: (h: DiffHunk, action: HunkAction) => void; busy?: boolean }) {
  const lang = useMemo(() => languageOf(diff.path), [diff.path])
  const tokens = useMemo(() => diff.hunks.map(h => h.lines.map(l => (l.type === 'meta' ? [{ text: l.text }] : tokenize(l.text, lang)))), [diff, lang])
  const stat = `${diff.added ? `+${diff.added}` : ''} ${diff.removed ? `−${diff.removed}` : ''}`.trim()
  if (diff.binary || diff.hunks.length === 0) return <p className="gm-diff-note muted">{diff.notice ?? 'No textual changes.'}</p>
  return (
    <div className="gm-diff" role="region" aria-label={`Diff of ${diff.path}`}>
      <p className="gm-diff-sum faint"><span className="num">{plural(diff.hunks.length, 'hunk')}</span><span className="gm-add">{stat}</span>{diff.notice && <span>{diff.notice}</span>}</p>
      {diff.hunks.map((h, hi) => (
        <section key={h.id} className="gm-hunk">
          <header className="gm-hunk-head">
            <code className="truncate" title={h.header}>{h.header}</code>
            <span className="grow" />
            {diff.hunkable && onHunk && (
              <span className="gm-hunk-actions">
                {diff.area === 'unstaged' && <Button variant="ghost" disabled={busy} onClick={() => onHunk(h, 'stage')}>Stage hunk</Button>}
                {diff.area === 'staged' && <Button variant="ghost" disabled={busy} onClick={() => onHunk(h, 'unstage')}>Unstage hunk</Button>}
                {diff.area === 'unstaged' && <Button variant="ghost" disabled={busy} onClick={() => onHunk(h, 'discard')}>Discard hunk</Button>}
              </span>
            )}
          </header>
          <div className="gm-hunk-body" role="table" aria-label={`Hunk ${hi + 1}`}>
            {h.lines.map((l, i) => (
              <div key={i} role="row" className={`gm-dl gm-dl-${l.type}`}>
                <span role="cell" className="gm-dn" aria-hidden="true">{l.oldNo ?? ''}</span>
                <span role="cell" className="gm-dn" aria-hidden="true">{l.newNo ?? ''}</span>
                <span role="cell" className="gm-dsign" aria-label={l.type === 'add' ? 'added' : l.type === 'del' ? 'removed' : undefined}>{l.type === 'add' ? '+' : l.type === 'del' ? '−' : l.type === 'meta' ? '\\' : ''}</span>
                <code role="cell" className="gm-dtext">{tokens[hi][i].map((t, k) => (t.cls ? <span key={k} className={`gm-tok-${t.cls}`}>{t.text}</span> : t.text))}{l.text === '' && '​'}</code>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
