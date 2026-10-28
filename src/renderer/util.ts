import type { Platform, Repo, RepoStatus, ServiceState } from '../shared/types'

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

export type RepoGroup = { key: string; label: string; repos: Repo[] }

/**
 * Repositories by the environment they live in: this computer first, then each WSL distribution by name. One group
 * when everything is in one environment, so the caller shows headings only when there is something to tell apart.
 * The order inside a group is the list's own order.
 */
export function groupByEnvironment(repos: Repo[], os: Platform['os']): RepoGroup[] {
  const native = os === 'windows' ? 'Windows' : os === 'mac' ? 'macOS' : 'Linux'
  const groups = new Map<string, RepoGroup>()
  for (const r of repos) {
    const key = r.location.kind === 'wsl' ? `wsl:${r.location.distro}` : 'native'
    const label = r.location.kind === 'wsl' ? `WSL (${r.location.distro})` : native
    if (!groups.has(key)) groups.set(key, { key, label, repos: [] })
    groups.get(key)!.repos.push(r)
  }
  return [...groups.values()].sort((a, b) => a.key === 'native' ? -1 : b.key === 'native' ? 1 : a.key.localeCompare(b.key, undefined, { sensitivity: 'base' }))
}
