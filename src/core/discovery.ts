import { readdir } from 'node:fs/promises'
import path from 'node:path'
import type { Location, Result } from '../shared/types.js'
import { programSpec, run } from './exec.js'
import { flavorOf, normalizePath } from './paths.js'

/** Folders that never contain the user's repositories but can be huge. */
export const SKIP = ['node_modules', 'vendor', 'target', 'build', 'dist', 'out', 'bin', 'obj', 'venv', '__pycache__', 'AppData', 'Library']
const MAX_DIRS = 20_000
const MAX_REPOS = 500

/**
 * Bounded search for Git repositories below a root: at most `depth` levels, hidden and dependency folders skipped,
 * symbolic links not followed, and hard caps on folders visited and repositories returned.
 */
export async function discover(root: Location, depth: number): Promise<Result<Location[]>> {
  return root.kind === 'wsl' ? discoverWsl(root, depth) : discoverNative(root.path, depth)
}

async function discoverNative(rootPath: string, depth: number): Promise<Result<Location[]>> {
  const lib = flavorOf(rootPath) === 'win32' ? path.win32 : path.posix
  const found: Location[] = []
  let visited = 0
  let queue: string[] = [rootPath]
  try { await readdir(rootPath) } catch (e) { return { ok: false, error: { code: 'NOT_FOUND', message: `The folder ${rootPath} cannot be read.`, detail: (e as Error).message } } }
  for (let level = 0; level <= depth && queue.length; level++) {
    const next: string[] = []
    for (const dir of queue) {
      if (++visited > MAX_DIRS || found.length >= MAX_REPOS) break
      let entries
      try { entries = await readdir(dir, { withFileTypes: true }) } catch { continue }
      if (entries.some(e => e.name === '.git' && (e.isDirectory() || e.isFile()))) found.push({ kind: 'native', path: normalizePath(dir) })
      if (level === depth) continue
      for (const e of entries) {
        if (!e.isDirectory() || e.isSymbolicLink() || e.name.startsWith('.') || e.name.startsWith('$') || SKIP.includes(e.name)) continue
        next.push(lib.join(dir, e.name))
      }
    }
    queue = next
  }
  return { ok: true, value: found }
}

async function discoverWsl(root: Extract<Location, { kind: 'wsl' }>, depth: number): Promise<Result<Location[]>> {
  const prune = ['(', '-name', '.*', '!', '-name', '.git', '-o', ...SKIP.flatMap((n, i) => (i ? ['-o', '-name', n] : ['-name', n])), ')']
  const args = [root.path, '-mindepth', '1', '-maxdepth', String(depth + 1), '-type', 'd', ...prune, '-prune', '-o', '-name', '.git', '-print', '-prune']
  const r = await run(programSpec({ kind: 'wsl', distro: root.distro }, 'find', args), { timeoutMs: 60_000 })
  if (r.spawnError) return { ok: false, error: { code: 'WSL_MISSING', message: 'WSL is not available on this computer.' } }
  const lines = r.stdout.split('\n').map(l => l.trim()).filter(l => l.endsWith('/.git'))
  if (r.code !== 0 && !lines.length) return { ok: false, error: { code: 'NOT_FOUND', message: `The folder ${root.path} cannot be read in ${root.distro}.`, detail: r.stderr.trim() } }
  return { ok: true, value: lines.slice(0, MAX_REPOS).map(l => ({ kind: 'wsl', distro: root.distro, path: normalizePath(l.slice(0, -5) || '/', 'posix') })) }
}
