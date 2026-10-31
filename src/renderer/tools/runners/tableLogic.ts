// Search and sort of the runner table, kept free of React so the rules are unit-tested directly.
import type { Runner } from '../../../shared/runners'
import { ENV_TEXT, OS_TEXT, machineText, scopeText } from '../text'

export type SortKey = 'name' | 'status' | 'platform' | 'environment' | 'machine' | 'scope' | 'version'
const STATUS_ORDER = { busy: 0, online: 1, offline: 2, unknown: 3 }

export function matchesSearch(r: Runner, needle: string): boolean {
  if (!needle) return true
  const n = needle.toLowerCase()
  return [r.name, scopeText(r.scope), r.machine, r.distro, r.path, OS_TEXT[r.platform], ENV_TEXT[r.environment], r.version, ...(r.github?.labels.map(l => l.name) ?? [])].some(v => v && v.toLowerCase().includes(n))
}

export function sortRunners(list: Runner[], key: SortKey, dir: 1 | -1): Runner[] {
  const cmp: Record<SortKey, (a: Runner, b: Runner) => number> = {
    name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
    status: (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status],
    platform: (a, b) => a.platform.localeCompare(b.platform),
    environment: (a, b) => a.environment.localeCompare(b.environment),
    machine: (a, b) => machineText(a).localeCompare(machineText(b), undefined, { sensitivity: 'base' }),
    scope: (a, b) => scopeText(a.scope).localeCompare(scopeText(b.scope), undefined, { sensitivity: 'base' }),
    version: (a, b) => (a.version ?? '').localeCompare(b.version ?? '', undefined, { numeric: true }),
  }
  return [...list].sort((a, b) => cmp[key](a, b) * dir || a.name.localeCompare(b.name))
}
