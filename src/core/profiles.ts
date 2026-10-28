import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { Profile, Readiness, Repo, Result, Runtime, ServiceDef } from '../shared/types.js'
import { programSpec, run } from './exec.js'
import { locationRuntime, resolveRunDir } from './paths.js'

/**
 * Fingerprint of everything that decides what a profile executes: where, in which runtime, which commands, with which
 * environment. The user trusts a fingerprint, not a profile; editing any of these parts requires trusting it again.
 * Names, readiness checks and the browser URL do not execute anything and are left out.
 */
export function fingerprint(p: Profile, repo: Repo): string {
  const material = {
    location: repo.location,
    runtime: p.runtime,
    workingDir: p.workingDir,
    services: p.services.map(s => ({ id: s.id, command: s.command, cwd: s.cwd, env: Object.entries(s.env).sort(), envFile: s.envFile })),
  }
  return createHash('sha256').update(JSON.stringify(material)).digest('hex')
}

export const isTrusted = (p: Profile, repo: Repo) => p.trustedFingerprint === fingerprint(p, repo)

/** Parses KEY=VALUE lines: comments, blank lines, `export KEY=`, single and double quotes (with \n in double quotes). */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    let val = m[2]
    if (val.startsWith('"') && val.lastIndexOf('"') > 0) val = val.slice(1, val.lastIndexOf('"')).replace(/\\n/g, '\n').replace(/\\"/g, '"')
    else if (val.startsWith("'") && val.lastIndexOf("'") > 0) val = val.slice(1, val.lastIndexOf("'"))
    else val = val.replace(/\s+#.*$/, '').trim()
    out[m[1]] = val
  }
  return out
}

export type Launch = {
  key: string
  repoId: string
  profileId: string
  serviceId: string
  name: string
  runtime: Runtime
  dir: string
  command: string
  env: Record<string, string>
  readiness: Readiness
  readyTimeout: number
}

export type FileReader = (runtime: Runtime, path: string) => Promise<string>

export const readRuntimeFile: FileReader = async (runtime, path) => {
  if (runtime.kind === 'native') return readFile(path, 'utf8')
  const r = await run(programSpec(runtime, 'cat', ['--', path]), { timeoutMs: 15_000 })
  if (r.code !== 0) throw new Error(r.stderr.trim() || r.spawnError || `cannot read ${path}`)
  return r.stdout
}

export const serviceKey = (profileId: string, serviceId: string) => `${profileId}:${serviceId}`

/** Resolves a service into an exact launch: directory in the runtime's path syntax and the final environment. */
export async function planLaunch(profile: Profile, repo: Repo, svc: ServiceDef, read: FileReader = readRuntimeFile): Promise<Result<Launch>> {
  const dir = resolveRunDir(repo.location, profile.runtime, profile.workingDir, svc.cwd)
  if (!dir.ok) return { ok: false, error: { code: 'BAD_DIR', message: dir.message } }
  let fileEnv: Record<string, string> = {}
  if (svc.envFile) {
    const f = resolveRunDir(repo.location, profile.runtime, profile.workingDir, svc.envFile)
    if (!f.ok) return { ok: false, error: { code: 'BAD_ENV_FILE', message: f.message } }
    try { fileEnv = parseEnvFile(await read(profile.runtime, f.path)) } catch (e) {
      return { ok: false, error: { code: 'BAD_ENV_FILE', message: `The env file for ${svc.name} could not be read: ${f.path}`, detail: (e as Error).message } }
    }
  }
  return {
    ok: true,
    value: {
      key: serviceKey(profile.id, svc.id), repoId: repo.id, profileId: profile.id, serviceId: svc.id, name: svc.name,
      runtime: profile.runtime, dir: dir.path, command: svc.command, env: { ...fileEnv, ...svc.env }, readiness: svc.readiness, readyTimeout: svc.readyTimeout,
    },
  }
}

/** A new profile for a repository: one empty service, running where the repository lives. */
export function draftProfile(repo: Repo, id: string, serviceId: string): Profile {
  return {
    id, repoId: repo.id, name: 'Development', runtime: locationRuntime(repo.location), workingDir: '',
    services: [{ id: serviceId, name: 'App', command: '', cwd: '', env: {}, envFile: '', readiness: { type: 'none' }, readyTimeout: 120 }],
    openUrl: '', browser: 'chrome', trustedFingerprint: null,
  }
}
