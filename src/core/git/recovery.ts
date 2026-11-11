import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { RecoveryRecord } from '../../shared/changes.js'

/**
 * What GitManager remembers about the local branches it deleted: the name, the commit the branch pointed at and the exact command
 * that recreates it. Only branch names and commit ids are stored, never file content. Newest first, capped.
 */
export class RecoveryLog {
  private records: RecoveryRecord[] = []
  constructor(private readonly file: string | null, private readonly cap = 500) {
    if (file && existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as { records?: unknown }
        if (Array.isArray(raw.records)) this.records = raw.records.filter(isRecord).slice(0, cap)
      } catch { /* an unreadable log starts empty; the next write replaces it */ }
    }
  }

  add(r: Omit<RecoveryRecord, 'id' | 'at'>): RecoveryRecord {
    const rec: RecoveryRecord = { ...r, id: randomUUID().replace(/-/g, '').slice(0, 16), at: new Date().toISOString() }
    this.records.unshift(rec)
    this.records = this.records.slice(0, this.cap)
    this.save()
    return rec
  }
  remove(id: string) { const n = this.records.length; this.records = this.records.filter(r => r.id !== id); if (this.records.length !== n) this.save() }
  list(repoId: string): RecoveryRecord[] { return this.records.filter(r => r.repoId === repoId) }
  get(id: string): RecoveryRecord | undefined { return this.records.find(r => r.id === id) }

  private save() {
    if (!this.file) return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify({ records: this.records }, null, 2) + '\n', { mode: 0o600 })
      renameSync(tmp, this.file)
    } catch { /* the deletion already happened; failing to note it must not hide that */ }
  }
}

function isRecord(x: unknown): x is RecoveryRecord {
  const r = x as Record<string, unknown>
  return typeof x === 'object' && x !== null && typeof r.id === 'string' && typeof r.repoId === 'string' && typeof r.name === 'string' && typeof r.sha === 'string'
    && /^[0-9a-f]{40,64}$/.test(r.sha) && typeof r.at === 'string' && typeof r.recoverWith === 'string' && typeof r.forced === 'boolean'
}
