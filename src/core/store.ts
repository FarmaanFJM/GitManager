import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Location, Profile, Repo, Root, Settings } from '../shared/types.js'
import { baseName, sameLocation } from './paths.js'
import * as v from './validate.js'

export type Data = {
  schemaVersion: 1
  repos: Repo[]
  roots: Root[]
  profiles: Profile[]
  settings: Settings
  ui: { selectedRepoId: string | null; selectedProfile: Record<string, string> }
}

export const DEFAULT_SETTINGS: Settings = { editor: 'code', chromePath: '', discoveryDepth: 3 }
const empty = (): Data => ({ schemaVersion: 1, repos: [], roots: [], profiles: [], settings: { ...DEFAULT_SETTINGS }, ui: { selectedRepoId: null, selectedProfile: {} } })

export const newId = () => randomUUID().replace(/-/g, '').slice(0, 16)

/** Reads a stored file defensively: every record is validated, and records that fail are dropped rather than crashing the app. */
export function sanitize(raw: unknown): { data: Data; dropped: number } {
  const d = empty()
  let dropped = 0
  if (typeof raw !== 'object' || raw === null) return { data: d, dropped }
  const r = raw as Record<string, unknown>
  const each = <T>(list: unknown, fn: (x: unknown) => T): T[] => (Array.isArray(list) ? list : []).flatMap(x => { try { return [fn(x)] } catch { dropped++; return [] } })
  d.repos = each(r.repos, x => {
    const o = x as Record<string, unknown>
    return { id: v.id(o.id), name: v.str(o.name, 'Name', { max: 200, allowEmpty: false }), location: v.location(o.location), addedAt: v.str(o.addedAt ?? '', 'Date', { max: 64 }) }
  })
  d.roots = each(r.roots, x => { const o = x as Record<string, unknown>; return { id: v.id(o.id), location: v.location(o.location), depth: v.int(o.depth ?? 3, 'Depth', 1, 6) } })
  const repoIds = new Set(d.repos.map(x => x.id))
  d.profiles = each(r.profiles, v.profile).filter(p => repoIds.has(p.repoId))
  try { d.settings = v.settings(r.settings ?? {}) } catch { dropped++ }
  const ui = (r.ui ?? {}) as Record<string, unknown>
  d.ui.selectedRepoId = typeof ui.selectedRepoId === 'string' && repoIds.has(ui.selectedRepoId) ? ui.selectedRepoId : null
  if (ui.selectedProfile && typeof ui.selectedProfile === 'object') {
    for (const [k, val] of Object.entries(ui.selectedProfile as Record<string, unknown>)) if (typeof val === 'string' && repoIds.has(k)) d.ui.selectedProfile[k] = val
  }
  return { data: d, dropped }
}

/**
 * Local configuration in a single JSON file in the user's application data folder (never in a repository).
 * Writes are atomic (temporary file, then rename). A file that cannot be parsed is kept as *.corrupt-<time> and replaced.
 */
export class Store {
  data: Data
  loadWarning: string | null = null

  constructor(readonly file: string) {
    this.data = this.load()
  }

  private load(): Data {
    if (!existsSync(this.file)) return empty()
    let raw: unknown
    try { raw = JSON.parse(readFileSync(this.file, 'utf8')) } catch {
      const backup = `${this.file}.corrupt-${Date.now()}`
      try { renameSync(this.file, backup) } catch { /* keep going with an empty configuration */ }
      this.loadWarning = `The configuration file could not be read and was set aside as ${backup}.`
      return empty()
    }
    const { data, dropped } = sanitize(raw)
    if (dropped) this.loadWarning = `${dropped} invalid ${dropped === 1 ? 'entry was' : 'entries were'} ignored in the configuration file.`
    return data
  }

  save() {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, this.file)
  }

  findRepoByLocation(loc: Location) { return this.data.repos.find(r => sameLocation(r.location, loc)) }
  repo(id: string) { return this.data.repos.find(r => r.id === id) }
  profile(id: string) { return this.data.profiles.find(p => p.id === id) }
  profilesFor(repoId: string) { return this.data.profiles.filter(p => p.repoId === repoId) }

  addRepo(loc: Location): { repo: Repo; existed: boolean } {
    const found = this.findRepoByLocation(loc)
    if (found) return { repo: found, existed: true }
    const repo: Repo = { id: newId(), name: baseName(loc), location: loc, addedAt: new Date().toISOString() }
    this.data.repos.push(repo)
    this.data.repos.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    this.save()
    return { repo, existed: false }
  }

  /** Forgets a repository and its profiles. The folder on disk is never touched. */
  removeRepo(id: string) {
    this.data.repos = this.data.repos.filter(r => r.id !== id)
    this.data.profiles = this.data.profiles.filter(p => p.repoId !== id)
    delete this.data.ui.selectedProfile[id]
    if (this.data.ui.selectedRepoId === id) this.data.ui.selectedRepoId = null
    this.save()
  }

  upsertProfile(p: Profile) {
    const i = this.data.profiles.findIndex(x => x.id === p.id)
    if (i >= 0) this.data.profiles[i] = p
    else this.data.profiles.push(p)
    this.save()
  }

  removeProfile(id: string) {
    this.data.profiles = this.data.profiles.filter(p => p.id !== id)
    this.save()
  }

  addRoot(loc: Location, depth: number): Root {
    const found = this.data.roots.find(r => sameLocation(r.location, loc))
    if (found) return found
    const root: Root = { id: newId(), location: loc, depth }
    this.data.roots.push(root)
    this.save()
    return root
  }

  removeRoot(id: string) {
    this.data.roots = this.data.roots.filter(r => r.id !== id)
    this.save()
  }
}
