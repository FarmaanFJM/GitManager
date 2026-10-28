import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { launchedAtLogin, reconcile, startHidden, Startup, STARTUP_ARG, STARTUP_NAME, trayWanted, type LoginItems } from '../src/core/startup.js'
import { DEFAULT_SETTINGS, Store } from '../src/core/store.js'
import { Backend } from '../src/main/backend.js'
import { chromeOptions, iconFile, PAGE_BACKGROUND, TITLEBAR, useOverlay } from '../src/main/chrome.js'
import type { Settings } from '../src/shared/types.js'
import { tempDir } from './helpers.js'

const EXE = 'C:\\Users\\dev\\AppData\\Local\\Programs\\GitManager\\GitManager.exe'

/**
 * Behaves like Electron's login item API on Windows: HKCU\...\Run holds `"<exe>" <args>` under a value name, and
 * Task Manager's StartupApproved\Run marks a value enabled or disabled independently of it.
 */
function fakeWindows() {
  const run = new Map<string, string>()
  const approved = new Map<string, boolean>()
  const writes: unknown[] = []
  const items: LoginItems = {
    get: q => {
      const cmd = `"${q.path}" ${q.args.join(' ')}`.trim()
      const launchItems = [...run].filter(([, c]) => c.startsWith(`"${q.path}"`)).map(([name, c]) => ({
        name, path: q.path, args: c.slice(q.path.length + 3).split(' ').filter(Boolean), enabled: approved.get(name) ?? true,
      }))
      return { openAtLogin: [...run.values()].includes(cmd), executableWillLaunchAtLogin: launchItems.some(i => i.enabled), launchItems }
    },
    set: w => {
      writes.push(w)
      if (w.openAtLogin) { run.set(w.name, `"${w.path}" ${w.args.join(' ')}`.trim()); approved.set(w.name, w.enabled) } else { run.delete(w.name); approved.delete(w.name) }
    },
  }
  return { run, approved, writes, items }
}
const settings = (over: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...over })

describe('startup arguments and tray policy', () => {
  it('tells a launch by the startup entry from a manual launch', () => {
    expect(launchedAtLogin([EXE, STARTUP_ARG])).toBe(true)
    expect(launchedAtLogin([EXE])).toBe(false)
    expect(launchedAtLogin([EXE, '--launched-at-login-x'])).toBe(false)
  })

  it('starts hidden only when launched at sign-in with Start minimized on', () => {
    expect(startHidden([EXE, STARTUP_ARG], settings({ startMinimized: true }))).toBe(true)
    expect(startHidden([EXE], settings({ startMinimized: true }))).toBe(false) // a manual launch always opens the window
    expect(startHidden([EXE, STARTUP_ARG], settings({ startMinimized: false }))).toBe(false)
  })

  it('shows the tray icon when wanted, and always while the window is hidden', () => {
    expect(trayWanted(settings(), false)).toBe(false)
    expect(trayWanted(settings({ minimizeToTray: true }), false)).toBe(true)
    expect(trayWanted(settings(), true)).toBe(true)
  })

  it('is off by default', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ launchAtStartup: false, startMinimized: false, minimizeToTray: false })
  })
})

describe('Windows startup entry', () => {
  it('registers the installed executable with the startup argument, and removes it', () => {
    const w = fakeWindows()
    const s = new Startup(w.items, { platform: 'win32', packaged: true, execPath: EXE })
    expect(s.state()).toMatchObject({ supported: true, active: false, disabledByWindows: false })
    expect(s.set(true)).toMatchObject({ active: true, command: `"${EXE}" ${STARTUP_ARG}` })
    expect(w.run.get(STARTUP_NAME)).toBe(`"${EXE}" ${STARTUP_ARG}`)
    expect(w.writes[0]).toEqual({ path: EXE, args: [STARTUP_ARG], openAtLogin: true, enabled: true, name: STARTUP_NAME })
    expect(s.set(false).active).toBe(false)
    expect(w.run.size).toBe(0)
  })

  it('reports an entry turned off in Task Manager, and turning it on here approves it again', () => {
    const w = fakeWindows()
    const s = new Startup(w.items, { platform: 'win32', packaged: true, execPath: EXE })
    s.set(true)
    w.approved.set(STARTUP_NAME, false) // Task Manager > Startup apps > Disable
    expect(s.state()).toMatchObject({ active: false, disabledByWindows: true })
    expect(reconcile(settings({ launchAtStartup: true }), s.state()).launchAtStartup).toBe(false)
    expect(s.set(true)).toMatchObject({ active: true, disabledByWindows: false })
  })

  it('never writes an entry from a development build or off Windows', () => {
    const w = fakeWindows()
    const dev = new Startup(w.items, { platform: 'win32', packaged: false, execPath: 'C:\\repo\\node_modules\\electron\\dist\\electron.exe' })
    expect(dev.state()).toMatchObject({ supported: false, active: false })
    expect(dev.unsupportedReason()).toMatch(/installed app/)
    expect(() => dev.set(true)).toThrow()
    expect(new Startup(w.items, { platform: 'linux', packaged: true, execPath: '/opt/gitmanager' }).state().supported).toBe(false)
    expect(w.writes).toEqual([])
  })

  it('leaves the stored switch alone where startup is not supported', () => {
    const s = settings({ launchAtStartup: false })
    expect(reconcile(s, { supported: false, reason: 'x', active: false, disabledByWindows: false, command: null })).toBe(s)
  })
})

describe('startup settings through the backend', () => {
  let cleanups: (() => void)[] = []
  afterEach(() => { for (const c of cleanups) c(); cleanups = [] })
  function setup(packaged = true) {
    const t = tempDir(); cleanups.push(t.cleanup)
    const file = join(t.dir, 'gitmanager.json')
    const w = fakeWindows()
    const changed: Settings[] = []
    const b = new Backend(new Store(file), { version: 't', pickFolder: async () => null, openPath: async () => '', openExternal: async () => {}, settingsChanged: s => changed.push(s) },
      { startup: new Startup(w.items, { platform: 'win32', packaged, execPath: EXE }) })
    return { b, w, file, changed }
  }

  it('persists the three settings and writes the entry only when the switch changes', async () => {
    const { b, w, file, changed } = setup()
    const r = await b.saveSettings({ ...b.store.data.settings, launchAtStartup: true, startMinimized: true, minimizeToTray: true })
    expect(r.ok && r.value).toMatchObject({ launchAtStartup: true, startMinimized: true, minimizeToTray: true })
    expect(new Store(file).data.settings).toMatchObject({ launchAtStartup: true, startMinimized: true, minimizeToTray: true })
    expect(w.run.has(STARTUP_NAME)).toBe(true)
    expect(changed).toHaveLength(1)
    await b.saveSettings({ ...b.store.data.settings, editor: 'cursor' })
    expect(w.writes).toHaveLength(1)
    await b.saveSettings({ ...b.store.data.settings, launchAtStartup: false })
    expect(w.run.has(STARTUP_NAME)).toBe(false)
  })

  it('corrects the stored switch when Windows turned the entry off', async () => {
    const { b, w, file } = setup()
    await b.saveSettings({ ...b.store.data.settings, launchAtStartup: true })
    w.approved.set(STARTUP_NAME, false)
    const st = await b.startupState()
    expect(st).toMatchObject({ active: false, disabledByWindows: true })
    expect(new Store(file).data.settings.launchAtStartup).toBe(false)
  })

  it('stores the switch off in a development build and writes nothing', async () => {
    const { b, w } = setup(false)
    const r = await b.saveSettings({ ...b.store.data.settings, launchAtStartup: true, minimizeToTray: true })
    expect(r.ok && r.value).toMatchObject({ launchAtStartup: false, minimizeToTray: true })
    expect(w.writes).toEqual([])
  })

  it('rejects settings of the wrong type', async () => {
    const { b } = setup()
    const r = await b.saveSettings({ ...b.store.data.settings, launchAtStartup: 'yes' })
    expect(r.ok && r.value.launchAtStartup).toBe(false)
  })
})

describe('window chrome', () => {
  const tokens = readFileSync(join(__dirname, '..', 'third_party', 'summa-ui', 'guidance', 'css', 'tokens.css'), 'utf8')
  const token = (name: string) => new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(tokens)![1].toLowerCase()

  it('uses the overlay on Windows only (unless asked for by the acceptance scenario)', () => {
    expect(useOverlay('win32', {})).toBe(true)
    expect(useOverlay('darwin', {})).toBe(false)
    expect(useOverlay('linux', {})).toBe(false)
    expect(useOverlay('linux', { GITMANAGER_TITLEBAR: 'overlay' })).toBe(true)
    expect(chromeOptions('win32', {})).toEqual({ titleBarStyle: 'hidden', titleBarOverlay: TITLEBAR })
    expect(chromeOptions('darwin', {})).toEqual({})
  })

  it('draws the caption buttons on the Summa-UI panel colour #1B1C1C with quiet symbols', () => {
    expect(TITLEBAR.color).toBe('#1b1c1c')
    expect(TITLEBAR.color).toBe(token('s1'))
    expect(TITLEBAR.symbolColor).toBe(token('text-2'))
    expect(PAGE_BACKGROUND).toBe(token('s0'))
  })

  it('matches the header row height in the stylesheet', () => {
    const css = readFileSync(join(__dirname, '..', 'src', 'renderer', 'app.css'), 'utf8')
    expect(css).toMatch(new RegExp(`\\.gm-top \\{[^}]*min-height: ${TITLEBAR.height}px`))
  })

  it('uses the supplied brand icons, multi-size ICO on Windows', () => {
    expect(iconFile('win32', 'tray')).toBe('GitManager-Summa.ico')
    expect(iconFile('win32', 'window')).toBe('GitManager-Summa.ico')
    expect(iconFile('linux', 'tray')).toBe('GitManager-Summa-32.png')
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'))
    for (const p of ['win32', 'linux'] as const) for (const u of ['tray', 'window'] as const) expect(pkg.build.files).toContain(`assets/brand/${iconFile(p, u)}`)
  })
})
