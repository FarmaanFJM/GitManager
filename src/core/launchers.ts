import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { Browser, Location } from '../shared/types.js'
import type { HostOs } from './exec.js'

// Opening things outside GitManager: a browser at a URL, an editor at a folder.

function onPath(names: string[]): string | null {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  for (const n of names) for (const d of dirs) { const p = path.join(d, n); if (existsSync(p)) return p }
  return null
}

/** Finds Chrome in its standard locations. Does not assume a user name or install scope. */
export function findChrome(os: HostOs, env: NodeJS.ProcessEnv = process.env): string | null {
  if (os === 'windows') {
    const roots = [env['PROGRAMFILES'], env['PROGRAMFILES(X86)'], env['LOCALAPPDATA']].filter(Boolean) as string[]
    for (const r of roots) { const p = path.win32.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'); if (existsSync(p)) return p }
    return null
  }
  if (os === 'mac') {
    const p = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    return existsSync(p) ? p : null
  }
  return onPath(['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'])
}

export function findEdge(os: HostOs, env: NodeJS.ProcessEnv = process.env): string | null {
  if (os === 'windows') {
    for (const r of [env['PROGRAMFILES(X86)'], env['PROGRAMFILES']].filter(Boolean) as string[]) {
      const p = path.win32.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'); if (existsSync(p)) return p
    }
    return null
  }
  if (os === 'mac') { const p = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'; return existsSync(p) ? p : null }
  return onPath(['microsoft-edge', 'microsoft-edge-stable'])
}

/** Only local development URLs (or any http/https URL the user typed into the profile) are opened; never file: or custom schemes. */
export function isOpenableUrl(u: string) {
  try { const x = new URL(u); return x.protocol === 'http:' || x.protocol === 'https:' } catch { return false }
}

export type OpenResult = { ok: true; via: string } | { ok: false; message: string }

/**
 * Opens a URL in the preferred browser. A WSL service is opened by the Windows browser at the same localhost URL,
 * which works when WSL forwards localhost (the default for WSL 2). Falls back to the system default browser.
 */
export async function openInBrowser(url: string, browser: Browser, opts: { os: HostOs; chromePath?: string; openDefault: (u: string) => Promise<void> }): Promise<OpenResult> {
  if (!isOpenableUrl(url)) return { ok: false, message: 'Only http and https addresses can be opened.' }
  if (browser !== 'default') {
    const exe = browser === 'chrome' ? (opts.chromePath || findChrome(opts.os)) : findEdge(opts.os)
    if (exe && existsSync(exe)) {
      const child = spawn(exe, [url], { detached: true, stdio: 'ignore', windowsHide: false })
      child.on('error', () => { /* reported through the fallback below only if spawn throws synchronously */ })
      child.unref()
      return { ok: true, via: browser === 'chrome' ? 'Chrome' : 'Edge' }
    }
  }
  await opts.openDefault(url)
  return { ok: true, via: browser === 'default' ? 'the default browser' : `the default browser (${browser === 'chrome' ? 'Chrome' : 'Edge'} was not found)` }
}

/** Opens a repository in the user's editor command (default `code`). WSL repositories open from inside the distribution. */
export function editorSpec(editor: string, loc: Location, os: HostOs): { file: string; args: string[]; cwd?: string; verbatim: boolean } {
  const cmd = editor.trim() || 'code'
  if (loc.kind === 'wsl') return { file: 'wsl.exe', args: ['-d', loc.distro, '--cd', loc.path, '--exec', 'bash', '-lc', `${cmd} .`], verbatim: false }
  if (os === 'windows') {
    // Editors on Windows are usually .cmd shims (code.cmd), which need cmd.exe. The path is quoted; the command is the user's own setting.
    return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${cmd} "${loc.path}""`], cwd: loc.path, verbatim: true }
  }
  const [file, ...rest] = cmd.split(/\s+/)
  return { file, args: [...rest, loc.path], cwd: loc.path, verbatim: false }
}
