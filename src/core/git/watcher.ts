import { EventEmitter } from 'node:events'
import { watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'

/**
 * Notices when a repository's state changes behind GitManager's back (a Git command in a terminal or another tool) by watching the
 * few places Git writes to: the Git directory itself (index, HEAD, merge and rebase state) and refs (branches, tags, stash).
 * It runs no Git command; the page asks for a fresh status only when this fires, after a short quiet period. It watches one
 * repository at a time and ignores lock files, which Git creates and removes around every write.
 */
export class RepoWatcher extends EventEmitter {
  private watchers: FSWatcher[] = []
  private timer: NodeJS.Timeout | null = null
  private current: string | null = null

  constructor(private readonly quietMs = 300) { super() }

  /** Watches `gitDir` for `repoId`, replacing any earlier watch. Returns false when the folder cannot be watched. */
  watch(repoId: string, gitDir: string): boolean {
    this.stop()
    this.current = repoId
    const onEvent = (_event: string, name: string | Buffer | null) => {
      const f = name ? String(name) : ''
      if (f.endsWith('.lock') || f === 'gc.log' || f.startsWith('objects')) return
      if (this.timer) clearTimeout(this.timer)
      this.timer = setTimeout(() => { this.timer = null; if (this.current === repoId) this.emit('changed', { repoId }) }, this.quietMs)
    }
    try {
      this.watchers.push(watch(gitDir, { persistent: false }, onEvent))
      try { this.watchers.push(watch(join(gitDir, 'refs'), { persistent: false, recursive: true }, onEvent)) } catch { /* recursive watching is not available everywhere: HEAD and the index still are */ }
      for (const w of this.watchers) w.on('error', () => { /* the folder went away; the next watch() replaces this */ })
      return true
    } catch {
      this.stop()
      return false
    }
  }

  stop() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    for (const w of this.watchers) { try { w.close() } catch { /* already closed */ } }
    this.watchers = []
    this.current = null
  }
}
