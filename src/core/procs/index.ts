import { hostOs, type HostOs } from '../exec.js'
import { NativeShell, WslShell, type Runner } from '../runners/hosts.js'
import type { ProcAdapter } from './model.js'
import { UnixAdapter } from './adapters/unix.js'
import { WindowsAdapter } from './adapters/windows.js'

export * from './model.js'
export * from './inspector.js'
export * from './control.js'
export * from './env.js'
export { UnixAdapter, parseTagged, parseSs, parseLsofListen, parseEnviron, SCAN_SCRIPT } from './adapters/unix.js'
export { WindowsAdapter, parseWindowsProcesses, POWERSHELL_COMMAND } from './adapters/windows.js'

/** The adapters for this computer: Windows (+ one per WSL distribution), Linux, or macOS. */
export function createProcAdapters(opts: { os?: HostOs; wslDistros?: string[]; runner?: Runner } = {}): ProcAdapter[] {
  const os = opts.os ?? hostOs()
  if (os === 'windows') return [new WindowsAdapter(opts.runner), ...(opts.wslDistros ?? []).map(d => new UnixAdapter({ kind: 'wsl', distro: d }, new WslShell(d, { runner: opts.runner })))]
  return [new UnixAdapter({ kind: 'native' }, new NativeShell({ os, runner: opts.runner }), os === 'mac' ? 'mac' : 'linux')]
}
