/**
 * Window chrome. On Windows GitManager has no separate title bar: Windows keeps drawing the real caption buttons
 * (minimize, maximize with Snap layouts, close) through Electron's window controls overlay, on the main panel's surface,
 * and the page lays its header out beside them (src/renderer/app.css, "title bar"). Dragging, double-click to maximize,
 * resizing and Snap stay Windows' own behaviour. No Electron import, so the values are tested against the Summa-UI tokens.
 */

/** Summa-UI --s1 (the main panel the buttons sit on), --text-2 (quiet symbols), --s0 (the page), and the 52px header row. */
export const TITLEBAR = { color: '#1b1c1c', symbolColor: '#a3a6a4', height: 52 } as const
export const PAGE_BACKGROUND = '#141515'

/** Overlay on Windows. GITMANAGER_TITLEBAR=overlay turns it on elsewhere for the acceptance scenario; macOS and Linux otherwise keep their frame. */
export function useOverlay(platform: NodeJS.Platform, env: NodeJS.ProcessEnv = process.env): boolean {
  return platform === 'win32' || env.GITMANAGER_TITLEBAR === 'overlay'
}

export function chromeOptions(platform: NodeJS.Platform, env: NodeJS.ProcessEnv = process.env) {
  return useOverlay(platform, env)
    ? { titleBarStyle: 'hidden' as const, titleBarOverlay: { ...TITLEBAR } }
    : {}
}

/** Tray and window icons: the multi-size ICO on Windows (Windows picks the frame for the display scale), PNG elsewhere. */
export function iconFile(platform: NodeJS.Platform, use: 'window' | 'tray'): string {
  if (platform === 'win32') return 'GitManager-Summa.ico'
  return use === 'tray' ? 'GitManager-Summa-32.png' : 'GitManager-Summa-256.png'
}
