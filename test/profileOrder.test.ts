import { describe, expect, it } from 'vitest'
import { profile as validateProfile, startOrder } from '../src/core/validate.js'
import { fingerprint } from '../src/core/profiles.js'
import type { Repo } from '../src/shared/types.js'

const svc = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id.toUpperCase(), command: 'x', cwd: '', env: {}, envFile: '', readiness: { type: 'none' }, readyTimeout: 30, ...extra })
const base = (services: unknown[], extra: Record<string, unknown> = {}) => ({ id: 'p1', repoId: 'r1', name: 'Dev', runtime: { kind: 'native' }, workingDir: '', services, openUrl: '', browser: 'chrome', trustedFingerprint: null, ...extra })

describe('startup order and profile fields', () => {
  it('puts dependencies first and keeps the listed order otherwise', () => {
    const order = startOrder([{ id: 'web', dependsOn: ['api'] }, { id: 'api', dependsOn: ['db'] }, { id: 'db' }, { id: 'docs' }])!
    expect(order.map(s => s.id)).toEqual(['db', 'api', 'web', 'docs'])
  })
  it('detects circles, unknown dependencies and self dependencies', () => {
    expect(startOrder([{ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] }])).toBeNull()
    expect(() => validateProfile(base([svc('a', { dependsOn: ['b'] }), svc('b', { dependsOn: ['a'] })]))).toThrow(/circle/)
    expect(() => validateProfile(base([svc('a', { dependsOn: ['zzz'] })]))).toThrow(/does not exist/)
    expect(() => validateProfile(base([svc('a', { dependsOn: ['a'] })]))).toThrow(/itself/)
  })
  it('accepts url, ports and a worktree path, and drops empty ones', () => {
    const p = validateProfile(base([svc('a', { url: 'http://localhost:5173', ports: [5173, 5173, 8080] }), svc('b', { url: '', ports: [] })], { worktreePath: '/home/u/app.worktrees/feat' }))
    expect(p.services[0].url).toBe('http://localhost:5173')
    expect(p.services[0].ports).toEqual([5173, 8080])
    expect(p.services[1].url).toBeUndefined()
    expect(p.worktreePath).toBe('/home/u/app.worktrees/feat')
    expect(() => validateProfile(base([svc('a', { ports: [70000] })]))).toThrow()
  })
  it('a worktree changes what gets executed, so it changes the trust fingerprint', () => {
    const repo = { id: 'r1', name: 'r', location: { kind: 'native', path: '/r' }, addedAt: '' } as Repo
    const a = validateProfile(base([svc('a')]))
    const b = validateProfile(base([svc('a')], { worktreePath: '/r.worktrees/x' }))
    expect(fingerprint(a, repo)).not.toBe(fingerprint(b, repo))
  })
})
