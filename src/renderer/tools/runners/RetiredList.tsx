import { Button, Icon } from '../../../../third_party/summa-ui/src/ui'
import type { RetiredRunner } from '../../../shared/runners'
import { ago } from '../../util'
import { hostText } from '../common'

/**
 * Installations the user retired from the active inventory. Collapsed by default, so the table shows only what is in use.
 * Restoring is one click; removing files is a separate, confirmed action that is offered only when verification passes.
 */
export function RetiredList({ items, busy, onRestore, onCleanup }: { items: RetiredRunner[]; busy: Record<string, unknown>; onRestore: (r: RetiredRunner) => void; onCleanup: (r: RetiredRunner) => void }) {
  if (items.length === 0) return null
  return (
    <details className="gm-retired">
      <summary><Icon name="archive" size={14} />Retired installations <span className="faint">{items.length}</span></summary>
      <ul className="gm-retired-list" aria-label="Retired installations">
        {items.map(it => {
          const l = it.runner.local!
          const working = !!busy[l.key]
          return (
            <li key={l.key} className="gm-retired-item">
              <div className="gm-retired-main">
                <span className="gm-retired-name truncate">{it.runner.name}{l.agentId !== null ? <span className="faint"> (old id {l.agentId})</span> : null}</span>
                <span className="gm-mono-sm muted truncate" title={l.path}>{l.path}</span>
                <span className="faint gm-retired-meta">{hostText(l.host)}{l.version ? `, ${l.version}` : ''}{it.retiredAt ? `, retired ${ago(it.retiredAt)}` : ''}</span>
                {!it.cleanup.allowed && <span className="faint gm-retired-why">Files stay: {it.cleanup.reasons[0]}{it.cleanup.reasons.length > 1 ? ` (and ${it.cleanup.reasons.length - 1} more)` : ''}</span>}
              </div>
              <Button variant="ghost" disabled={working} onClick={() => onRestore(it)}>Restore</Button>
              <Button variant="ghost" icon="trash" disabled={working || !it.cleanup.allowed} title={it.cleanup.allowed ? `Delete ${l.path}` : it.cleanup.reasons.join(' ')} onClick={() => onCleanup(it)}>Remove files</Button>
            </li>
          )
        })}
      </ul>
    </details>
  )
}
