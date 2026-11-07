// The real PtyFactory, backed by node-pty (N-API prebuilds on Windows and macOS, compiled on Linux). node-pty is loaded on
// first use, so importing this module (or running tests) never fails when the native binary is missing.
import { createRequire } from 'node:module'
import path from 'node:path'
import type * as NodePty from 'node-pty'
import type { PtyFactory, PtyProcess, PtySpawnOptions } from './terminals.js'

type PtyModule = typeof NodePty

export type PtyLoad = { ok: true; module: PtyModule } | { ok: false; message: string }

let cached: PtyLoad | null = null

export function loadNodePty(loader?: () => PtyModule): PtyLoad {
  if (!loader && cached) return cached
  let result: PtyLoad
  try {
    const mod = loader ? loader() : (createRequire(typeof __filename === 'string' ? __filename : path.join(process.cwd(), 'noop.js'))('node-pty') as PtyModule)
    result = { ok: true, module: mod }
  } catch (e) {
    result = { ok: false, message: `The terminal component (node-pty) could not be loaded: ${(e as Error).message}` }
  }
  if (!loader) cached = result
  return result
}

export const nodePtyAvailable = (): PtyLoad => loadNodePty()

export function createNodePtyFactory(opts: { load?: () => PtyLoad; platform?: NodeJS.Platform } = {}): PtyFactory {
  const platform = opts.platform ?? process.platform
  return {
    spawn(file: string, args: string[], o: PtySpawnOptions): PtyProcess {
      const loaded = (opts.load ?? loadNodePty)()
      if (!loaded.ok) throw new Error(loaded.message)
      const base = { name: o.name, cols: o.cols, rows: o.rows, cwd: o.cwd, env: o.env, encoding: 'utf8' as const }
      // ConPTY is the supported pseudo console on Windows 10 1809+; winpty is only the fallback node-pty chooses on its own.
      const p = loaded.module.spawn(file, args, platform === 'win32' ? { ...base, useConpty: true } : base)
      return {
        get pid() { return p.pid },
        onData: cb => { p.onData(cb) },
        onExit: cb => { p.onExit(e => cb({ exitCode: e.exitCode, signal: e.signal })) },
        write: d => p.write(d),
        resize: (c, r) => p.resize(c, r),
        kill: s => p.kill(s),
      }
    },
  }
}
