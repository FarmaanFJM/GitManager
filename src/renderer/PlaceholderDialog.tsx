import { useEffect, useMemo, useState } from 'react'
import { Button, Details, Dialog, IconButton, InlineAlert } from '../../third_party/summa-ui/src/ui'
import { reconstruct } from '../shared/placeholders'
import type { PasteChoice, PendingPaste } from './terminalController'

/**
 * "Complete command": one input per unresolved placeholder (a repeated one is asked for once), a reviewable preview, and three
 * ways out. Values live only in this component's state: they are not saved, logged or sent anywhere except into the terminal as
 * part of the command text, and they are dropped when the dialog closes. Secret-looking inputs are masked until revealed.
 */
export function PlaceholderDialog({ pending, onResolve }: { pending: PendingPaste | null; onResolve: (p: PendingPaste, choice: PasteChoice) => void }) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [shown, setShown] = useState<Record<string, boolean>>({})
  const [reveal, setReveal] = useState(false)
  useEffect(() => { setValues({}); setShown({}); setReveal(false) }, [pending])

  const masked = useMemo(() => new Set((pending?.placeholders ?? []).filter(p => p.sensitive && !shown[p.token] && !reveal).map(p => p.token)), [pending, shown, reveal])
  const preview = useMemo(() => pending ? reconstruct(pending.text, pending.placeholders, values, { syntax: pending.syntax, maskedTokens: masked }) : null, [pending, values, masked])
  const real = useMemo(() => pending ? reconstruct(pending.text, pending.placeholders, values, { syntax: pending.syntax }) : null, [pending, values])
  if (!pending) return null
  const filled = pending.placeholders.filter(p => (values[p.token] ?? '') !== '').length
  const problems = real && !real.ok ? real.problems : []
  const done = (choice: PasteChoice) => onResolve(pending, choice)
  const update = () => { if (real?.ok && filled) done({ kind: 'text', text: real.text }) }

  return (
    <Dialog open onClose={() => done({ kind: 'cancel' })} title="Complete command" width={560}
      footer={(
        <>
          <Button variant="secondary" onClick={() => done({ kind: 'cancel' })}>Cancel</Button>
          <Button variant="secondary" onClick={() => done({ kind: 'original' })}>Paste Original</Button>
          <Button variant="primary" disabled={!filled || !real?.ok} onClick={update} data-autofocus={filled ? true : undefined}>Update Command</Button>
        </>
      )}>
      <form className="gm-ph" onSubmit={e => { e.preventDefault(); update() }}>
        <div className="gm-ph-head" aria-hidden="true"><span>Placeholder</span><span>Value</span></div>
        {pending.placeholders.map((p, i) => {
          const hide = p.sensitive && !shown[p.token] && !reveal
          return (
            <div key={p.token} className="gm-ph-row">
              <code className="gm-ph-name" title={p.occurrences.length > 1 ? `${p.occurrences.length} places` : undefined}>{p.token}{p.occurrences.length > 1 && <span className="faint"> ×{p.occurrences.length}</span>}</code>
              <span className="gm-ph-input">
                <input className="input gm-mono" type={hide ? 'password' : 'text'} aria-label={`Value for ${p.token}`} autoComplete="off" spellCheck={false} data-autofocus={i === 0 ? true : undefined}
                  value={values[p.token] ?? ''} onChange={e => setValues(v => ({ ...v, [p.token]: e.target.value }))} />
                {p.sensitive && <IconButton icon={shown[p.token] ? 'eye-off' : 'eye'} size="sm" label={shown[p.token] ? `Hide ${p.token}` : `Show ${p.token}`} onClick={() => setShown(s => ({ ...s, [p.token]: !s[p.token] }))} />}
              </span>
            </div>
          )
        })}
        {problems.length > 0 && (
          <InlineAlert tone="error">{problems.map(x => `${x.token} ${x.reason}.`).join(' ')}</InlineAlert>
        )}
        <Details label="Review command">
          <pre className="gm-ph-preview" aria-label="Command preview">{preview?.ok ? preview.text : pending.text}</pre>
          {pending.placeholders.some(p => p.sensitive) && (
            <label className="gm-ack"><input type="checkbox" checked={reveal} onChange={e => setReveal(e.target.checked)} /><span>Show secret values</span></label>
          )}
        </Details>
        <p className="faint gm-ph-note">Inserted at the prompt; press Enter to run. The shell may keep it in its history.</p>
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}
