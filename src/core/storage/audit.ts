import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AuditEntry, AuditView } from '../../shared/storage.js'

type Fields = Omit<AuditEntry, 'seq' | 'at' | 'prev' | 'hash'>
const GENESIS = '0'.repeat(64)
const hashOf = (e: Omit<AuditEntry, 'hash'>) => createHash('sha256').update(JSON.stringify(e)).digest('hex')

/**
 * Append-only local record of every deletion attempt and its outcome, one JSON object per line. Each entry carries the
 * hash of the one before it, so an edited, removed or reordered line is detected. An attempt is written *before* the
 * request, so a crash leaves an attempt without a result, which `unresolved` reports. Nothing here is sent anywhere.
 */
export class AuditLog {
  private last = GENESIS
  private seq = 0
  constructor(readonly file: string, private readonly now: () => number = Date.now) {
    const { entries } = this.read()
    const tail = entries[entries.length - 1]
    if (tail) { this.last = tail.hash; this.seq = tail.seq }
  }

  append(f: Fields): AuditEntry {
    mkdirSync(dirname(this.file), { recursive: true })
    // a crash can leave a half-written last line; start a fresh line so the damage stays confined to it
    if (existsSync(this.file) && statSync(this.file).size > 0 && !readFileSync(this.file, 'utf8').endsWith('\n')) appendFileSync(this.file, '\n')
    const base = { ...f, seq: this.seq + 1, at: new Date(this.now()).toISOString(), prev: this.last }
    const entry: AuditEntry = { ...base, hash: hashOf(base) }
    appendFileSync(this.file, JSON.stringify(entry) + '\n', { mode: 0o600 })
    this.seq = entry.seq
    this.last = entry.hash
    return entry
  }

  read(): { entries: AuditEntry[]; intact: boolean; brokenAt: number | null } {
    if (!existsSync(this.file)) return { entries: [], intact: true, brokenAt: null }
    const entries: AuditEntry[] = []
    let intact = true, brokenAt: number | null = null, prev = GENESIS
    const lines = readFileSync(this.file, 'utf8').split('\n').filter(l => l.trim())
    lines.forEach((line, i) => {
      let e: AuditEntry
      try { e = JSON.parse(line) as AuditEntry } catch { if (intact) { intact = false; brokenAt = i + 1 } return }
      const { hash, ...rest } = e
      if (typeof hash !== 'string' || hashOf(rest) !== hash || e.prev !== prev) { if (intact) { intact = false; brokenAt = e.seq ?? i + 1 } }
      prev = hash
      entries.push(e)
    })
    return { entries, intact, brokenAt }
  }

  /** Attempts that never got a result: the application stopped between the request and its outcome. */
  unresolved(): AuditEntry[] {
    const { entries } = this.read()
    const done = new Set(entries.filter(e => e.type === 'result').map(e => `${e.opId}:${e.repo}:${e.artifactId}`))
    return entries.filter(e => e.type === 'attempt' && !done.has(`${e.opId}:${e.repo}:${e.artifactId}`))
  }

  view(limit = 500): AuditView {
    const r = this.read()
    return { entries: r.entries.slice(-limit).reverse(), total: r.entries.length, intact: r.intact, brokenAt: r.brokenAt, unresolved: this.unresolved().length }
  }
}
