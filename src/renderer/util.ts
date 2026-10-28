import type { RepoStatus, ServiceState } from '../shared/types'

export const plural = (n: number, word: string, many = word + 's') => `${n} ${n === 1 ? word : many}`

export function ago(iso: string | number | null | undefined, now = Date.now()): string {
  if (!iso) return ''
  const t = typeof iso === 'number' ? iso : Date.parse(iso)
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  if (d < 30) return `${d} d ago`
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export function changesText(s: RepoStatus): string {
  const c = s.changes
  if (s.clean) return 'Clean'
  const parts: string[] = []
  if (c.conflicted) parts.push(plural(c.conflicted, 'conflict'))
  const changed = c.staged + c.unstaged
  if (changed) parts.push(`${changed} changed`)
  if (c.untracked) parts.push(`${c.untracked} untracked`)
  return parts.join(', ')
}

export function syncText(s: RepoStatus): string {
  switch (s.sync) {
    case 'up-to-date': return 'Up to date'
    case 'ahead': return `${plural(s.ahead, 'commit')} to push`
    case 'behind': return `${plural(s.behind, 'commit')} to pull`
    case 'diverged': return `Diverged: ${s.ahead} local, ${s.behind} remote`
    case 'no-upstream': return 'No upstream branch'
    case 'upstream-gone': return 'Upstream branch is gone'
    case 'detached': return 'Detached HEAD'
  }
}

export const STATE_LABEL: Record<ServiceState, string> = {
  stopped: 'Stopped', starting: 'Starting', running: 'Running', ready: 'Ready', stopping: 'Stopping', failed: 'Failed',
}

export const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null
  return !!el && (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable)
}
