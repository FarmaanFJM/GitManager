import { EventEmitter } from 'node:events'
import type { DiscoveryStatus, Repo } from '../shared/types.js'
import { commonTargets, discover, wslHome, type Found, type ScanOptions, type Target } from './discovery.js'
import { listWslDistros, type HostOs } from './exec.js'
import type { Location, Result } from '../shared/types.js'
import type { Store } from './store.js'

export type AutoDiscoveryDeps = {
  os: HostOs
  home: string
  scan?: (root: Location, depth: number, opts?: ScanOptions) => Promise<Result<Found[]>>
  distros?: () => Promise<{ name: string; version: number | null }[]>
  wslHome?: (distro: string) => Promise<string | null>
  drives?: string[]
}

const idle = (): DiscoveryStatus => ({ running: false, scope: null, locationsScanned: 0, locationsTotal: 0, found: 0, added: 0, startedAt: null, finishedAt: null, errors: [] })

/**
 * Automatic repository discovery. Scans common development folders, the user's own repository folders and the home
 * folders of WSL 2 distributions, in the background, and registers what it finds. It never registers a repository the
 * user removed, never registers the same folder twice, and never runs anything in a repository: no pull, no switch,
 * no commands. Emits 'status' while it runs and 'added' for each newly registered repository.
 */
export class AutoDiscovery extends EventEmitter {
  status: DiscoveryStatus = idle()

  constructor(private readonly store: Store, private readonly deps: AutoDiscoveryDeps) { super() }

  private emitStatus(patch: Partial<DiscoveryStatus>) {
    this.status = { ...this.status, ...patch }
    this.emit('status', this.status)
  }

  async targets(scope: 'common' | 'deep'): Promise<Target[]> {
    const depth = this.store.data.settings.discoveryDepth
    const out = await commonTargets(this.deps.os, this.deps.home, { deep: scope === 'deep', drives: this.deps.drives, depth })
    for (const r of this.store.data.roots) out.push({ location: r.location, depth: scope === 'deep' ? Math.max(r.depth, 5) : r.depth, label: r.location.path })
    if (this.deps.os === 'windows') {
      const distros = this.deps.distros ? await this.deps.distros() : (await listWslDistros('windows')).distros
      for (const d of distros.filter(x => x.version !== 1)) { // WSL 1 shares the Windows file system; its home is usually reachable but slow
        const home = await (this.deps.wslHome ?? wslHome)(d.name)
        if (home) out.push({ location: { kind: 'wsl', distro: d.name, path: home }, depth: scope === 'deep' ? 6 : Math.max(depth, 4), label: `${d.name}: ${home}` })
      }
    }
    return out
  }

  /** Runs one scan. A second request while one runs returns the running scan's final status. */
  async run(scope: 'common' | 'deep' = 'common'): Promise<DiscoveryStatus> {
    if (this.status.running) return new Promise(resolve => this.once('done', resolve))
    this.status = { ...idle(), running: true, scope, startedAt: new Date().toISOString() }
    this.emit('status', this.status)
    const scan = this.deps.scan ?? discover
    let targets: Target[] = []
    try { targets = await this.targets(scope) } catch (e) { this.status.errors.push((e as Error).message) }
    this.emitStatus({ locationsTotal: targets.length })
    let next = 0
    const worker = async () => {
      while (next < targets.length) {
        const t = targets[next++]
        const r = await scan(t.location, t.depth, { deadlineMs: scope === 'deep' ? 120_000 : 30_000 })
        if (!r.ok) this.status.errors.push(`${t.label}: ${r.error.message}`)
        else for (const f of r.value) {
          this.status.found++
          if (this.store.isIgnored(f.location) || this.store.findRepoByLocation(f.location)) continue
          const { repo, existed } = this.store.addRepo(f.location, { source: 'discovered', worktree: f.worktree })
          if (!existed) { this.status.added++; this.emit('added', repo satisfies Repo) }
        }
        this.emitStatus({ locationsScanned: this.status.locationsScanned + 1 })
      }
    }
    await Promise.all([worker(), worker(), worker()])
    this.store.data.discovery.lastRunAt = new Date().toISOString()
    this.store.save()
    this.emitStatus({ running: false, finishedAt: new Date().toISOString() })
    this.emit('done', this.status)
    return this.status
  }
}
