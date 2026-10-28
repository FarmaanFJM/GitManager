import { useEffect, useMemo, useState } from 'react'
import { Icon, Popover, useAnchored } from '../../third_party/summa-ui/src/ui'
import type { Branch } from '../shared/types'
import { api } from './api'

/**
 * The familiar branch picker: the current branch as a select trigger, a searchable list of local branches, then remote
 * branches without a local branch (choosing one creates the tracking branch). Built from Summa-UI's Popover and menu
 * classes, the same pieces as its Dropdown, because a value select cannot show two groups.
 */
export function BranchPicker({ repoId, current, detached, disabled, onSwitch, onTrack }: {
  repoId: string; current: string | null; detached: boolean; disabled?: boolean
  onSwitch: (name: string) => void; onTrack: (remoteRef: string) => void
}) {
  const a = useAnchored()
  const [branches, setBranches] = useState<Branch[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [q, setQ] = useState('')

  useEffect(() => {
    if (!a.open) return
    setQ(''); setError(null)
    void api.branches(repoId).then(r => { if (r.ok) setBranches(r.value); else setError(r.error.message) })
  }, [a.open, repoId])

  const needle = q.trim().toLowerCase()
  const { locals, remotes } = useMemo(() => {
    const list = (branches ?? []).filter(b => !needle || b.name.toLowerCase().includes(needle))
    const localNames = new Set((branches ?? []).filter(b => b.kind === 'local').map(b => b.name))
    return {
      locals: list.filter(b => b.kind === 'local').sort((x, y) => Number(y.current) - Number(x.current) || y.date - x.date),
      remotes: list.filter(b => b.kind === 'remote' && !b.tracked && !localNames.has(b.name.slice(b.name.indexOf('/') + 1))).sort((x, y) => y.date - x.date),
    }
  }, [branches, needle])

  const pick = (b: Branch) => { a.close(); if (b.kind === 'local') { if (!b.current) onSwitch(b.name) } else onTrack(b.name) }

  return (
    <>
      <button ref={a.ref} type="button" className="select gm-branch" aria-label={`Branch: ${current ?? 'detached HEAD'}. Switch branch`} aria-haspopup="listbox" aria-expanded={a.open}
        disabled={disabled} onClick={a.toggle}>
        <span className="truncate">{current ?? (detached ? 'Detached HEAD' : 'No branch')}</span>
        <Icon name="chevron-down" size={14} />
      </button>
      <Popover anchor={a.el} open={a.open} onClose={a.close} width={320} role="listbox" label="Switch branch" focusSelector="input">
        <div className="menu-search">
          <input className="input" placeholder="Search branches" aria-label="Search branches" value={q} onChange={e => setQ(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'ArrowDown') { e.preventDefault(); (e.currentTarget.closest('.popover')?.querySelector('[data-item]') as HTMLElement | null)?.focus() }
              if (e.key === 'Enter') { e.preventDefault(); const first = locals[0] ?? remotes[0]; if (first) pick(first) }
            }} />
        </div>
        <div className="menu-list gm-branch-list">
          {!branches && !error && <div className="menu-empty"><span className="sm-spinner" aria-hidden="true" /> Loading branches</div>}
          {error && <div className="menu-empty">{error}</div>}
          {branches && locals.map(b => (
            <button key={b.name} type="button" role="option" data-item aria-selected={b.current} className="menu-item" onClick={() => pick(b)}>
              <span className="truncate">{b.name}</span>
              {b.current && <Icon name="check" size={14} className="check" />}
            </button>
          ))}
          {branches && remotes.length > 0 && (
            <>
              <div className="menu-heading eyebrow">Remote</div>
              {remotes.map(b => (
                <button key={b.name} type="button" role="option" data-item aria-selected={false} className="menu-item" onClick={() => pick(b)} title={`Create a local branch tracking ${b.name}`}>
                  <span className="truncate">{b.name}</span>
                </button>
              ))}
            </>
          )}
          {branches && !locals.length && !remotes.length && <div className="menu-empty">No matches</div>}
        </div>
      </Popover>
    </>
  )
}
