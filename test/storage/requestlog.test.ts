import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AuditLog } from '../../src/core/storage/audit.js'
import { emptyConfig } from '../../src/core/storage/config.js'
import { GhCli } from '../../src/core/storage/gh.js'
import { parseRequestLog, verifyRequests } from '../../src/core/storage/requestlog.js'
import { StorageService } from '../../src/core/storage/service.js'
import type { AuditEntry } from '../../src/shared/storage.js'
import { tempDir } from '../helpers.js'
import { NOW } from './factory.js'
import { builds, FakeGitHub } from './fakeGithub.js'

let cleanups: (() => void)[] = []
afterEach(() => { for (const c of cleanups) c(); cleanups = [] })

const L = (s: string) => `2026-10-29T12:00:00Z ${s}`
const A = (repo: string, id: number): AuditEntry => ({ seq: id, at: '', opId: 'o', type: 'attempt', trigger: 'manual', repo, artifactId: id, name: 'n', runId: 1, sizeBytes: 1, prev: '', hash: '' })

describe('request log verification', () => {
  it('a scan-only log has only GET requests and no cleanup phase', () => {
    const v = verifyRequests([L('MARK BEGIN scan'), L('GET /user'), L('GET /user/repos?per_page=100'), L('MARK END scan')].join('\n'))
    expect(v).toMatchObject({ ok: true, deletes: 0 })
    expect(v.counts).toEqual({ GET: 2 })
  })

  it('23 DELETEs inside an authorized cleanup, one per audit attempt, are expected and valid', () => {
    const ids = Array.from({ length: 23 }, (_, i) => 100 + i)
    const text = [L('MARK BEGIN scan'), L('GET /user'), L('MARK END scan'), L('MARK BEGIN cleanup dryRun=false manual'),
      ...ids.flatMap(id => [L(`GET /repos/o/r/actions/artifacts/${id}`), L(`DELETE /repos/o/r/actions/artifacts/${id}`)]), L('GET /repos/o/r/actions/artifacts?per_page=100&page=1'), L('MARK END cleanup')].join('\n')
    const v = verifyRequests(text, ids.map(i => A('o/r', i)))
    expect(v).toMatchObject({ ok: true, deletes: 23, deletesInAuthorizedPhases: 23 })
  })

  it('a DELETE during a scan, a dry run, or with no phase is a violation', () => {
    for (const phase of ['scan', 'cleanup dryRun=true manual']) {
      const v = verifyRequests([L(`MARK BEGIN ${phase}`), L('DELETE /repos/o/r/actions/artifacts/5'), L('MARK END x')].join('\n'))
      expect(v.ok, phase).toBe(false)
      expect(v.problems[0]).toContain('outside an authorized cleanup')
    }
    expect(verifyRequests(L('DELETE /repos/o/r/actions/artifacts/5')).ok).toBe(false)
  })

  it('anything but a single artifact deletion is a violation even inside a cleanup', () => {
    const inside = (req: string) => verifyRequests([L('MARK BEGIN cleanup dryRun=false manual'), L(req), L('MARK END cleanup')].join('\n'))
    for (const bad of ['DELETE /repos/o/r/releases/1', 'DELETE /repos/o/r/actions/caches/3', 'POST /repos/o/r/actions/runs/1/rerun', 'DELETE /repos/o/r/git/refs/heads/x']) expect(inside(bad).ok, bad).toBe(false)
    expect(inside('DELETE /repos/o/r/actions/artifacts/9').ok).toBe(true)
  })

  it('a repeated DELETE, an unrecorded DELETE and an attempt without a DELETE are reported', () => {
    const base = [L('MARK BEGIN cleanup dryRun=false manual'), L('DELETE /repos/o/r/actions/artifacts/1'), L('DELETE /repos/o/r/actions/artifacts/1'), L('DELETE /repos/o/r/actions/artifacts/2'), L('MARK END cleanup')].join('\n')
    const v = verifyRequests(base, [A('o/r', 1), A('o/r', 3)])
    expect(v.ok).toBe(false)
    expect(v.problems.join(' ')).toMatch(/deleted 2 times/)
    expect(v.problems.join(' ')).toMatch(/artifacts\/2 has no matching audit attempt/)
    expect(v.problems.join(' ')).toMatch(/artifacts\/3 has an audit attempt but no DELETE/)
  })

  it('parses phases and keeps lines from older logs without markers', () => {
    const { phases, lines } = parseRequestLog([L('GET /user'), L('MARK BEGIN scan partial'), L('GET /x'), L('MARK END scan')].join('\n'))
    expect(lines.map(l => l.phase)).toEqual([null, 'scan partial', ])
    expect(phases.map(p => p.kind)).toEqual(['scan'])
  })
})

describe('what the service writes', () => {
  function setup() {
    const f = new FakeGitHub()
    f.repos.push({ ...builds('me/app', 'app-windows-x64', [1, 2, 20, 30, 40], NOW, 100), docs: {} })
    const t = tempDir('gm-rl-'); cleanups.push(t.cleanup)
    const cfg = emptyConfig()
    const svc = new StorageService({ dir: t.dir, gh: f, config: () => cfg, saveConfig: () => {}, openExternal: async () => {}, now: () => NOW, sleep: async () => {}, paceMs: 0 })
    return { f, svc, dir: t.dir }
  }

  it('marks scans and cleanups so a read-only scan and a dry run can be told from an authorized deletion', async () => {
    const { f, svc, dir } = setup()
    await svc.scanAndWait()
    const scanOnly = f.logText()
    expect(verifyRequests(scanOnly)).toMatchObject({ ok: true, deletes: 0 })
    expect(parseRequestLog(scanOnly).phases.map(p => p.kind)).toEqual(['scan'])

    const dry = await svc.execute(svc.candidates(), { dryRun: true })
    expect(dry.ok).toBe(true)
    await svc.whenIdle()
    expect(verifyRequests(f.logText())).toMatchObject({ ok: true, deletes: 0 }) // a dry run adds a phase but no mutation
    expect(parseRequestLog(f.logText()).phases.some(p => p.kind === 'dry-run')).toBe(true)

    const real = await svc.execute(svc.candidates(), { dryRun: false })
    expect(real.ok && real.value.confirmedDeleted).toBe(3)
    await svc.whenIdle()
    const audit = new AuditLog(join(dir, 'storage-audit.jsonl')).read().entries
    const v = verifyRequests(f.logText(), audit)
    expect(v).toMatchObject({ ok: true, deletes: 3, deletesInAuthorizedPhases: 3 })
    expect(parseRequestLog(f.logText()).phases.filter(p => p.kind === 'delete')).toHaveLength(1)
  })

  it('GhCli writes markers and requests, and nothing else, to the request log', async () => {
    const { mkdtempSync, readFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const dir = mkdtempSync(join(tmpdir(), 'gm-mark-')); const file = join(dir, 'r.log')
    process.env.GITMANAGER_GH_REQUEST_LOG = file; process.env.GH_TOKEN = 'ghp_SECRET'
    try {
      const gh = new GhCli({ runner: (async () => ({ code: 0, stdout: 'HTTP/2.0 200 OK\r\ncontent-type: application/json\r\n\r\n{}', stderr: '', timedOut: false })) as never, candidates: ['gh'] })
      gh.mark('BEGIN scan\nINJECTED'); await gh.request('GET', '/user'); gh.mark('END scan')
      const text = readFileSync(file, 'utf8')
      expect(text.trim().split('\n')).toHaveLength(3)
      expect(text).toMatch(/ MARK BEGIN scan INJECTED\n/)
      expect(text).not.toMatch(/ghp_|token|authorization/i)
    } finally { delete process.env.GITMANAGER_GH_REQUEST_LOG; delete process.env.GH_TOKEN; rmSync(dir, { recursive: true, force: true }) }
  })
})
