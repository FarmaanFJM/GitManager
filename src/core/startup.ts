import type { Settings, StartupState } from '../shared/types.js'

/**
 * Starting with Windows, and the tray. No Electron import: main.ts passes Electron's app.getLoginItemSettings and
 * app.setLoginItemSettings in as LoginItems, and tests pass a fake that behaves like the Run registry key.
 */

/** Added to the startup entry, so a launch at sign-in can be told apart from a manual one (Windows has no other signal). */
export const STARTUP_ARG = '--launched-at-login'
/** Value name under HKCU\Software\Microsoft\Windows\CurrentVersion\Run. The uninstaller removes it (build/installer.nsh). */
export const STARTUP_NAME = 'GitManager'

export type LoginItemQuery = { path: string; args: string[] }
export type LoginItemWrite = LoginItemQuery & { openAtLogin: boolean; enabled: boolean; name: string }
export type LoginItemRead = {
  openAtLogin: boolean
  executableWillLaunchAtLogin?: boolean
  launchItems?: { name: string; path: string; args: string[]; enabled: boolean }[]
}
export type LoginItems = { get(q: LoginItemQuery): LoginItemRead; set(w: LoginItemWrite): void }

export type StartupEnv = { platform: NodeJS.Platform; packaged: boolean; execPath: string }

export const launchedAtLogin = (argv: readonly string[]) => argv.includes(STARTUP_ARG)

/** Start minimized applies only to a launch by the startup entry, never to a launch by the user. */
export const startHidden = (argv: readonly string[], s: Settings) => launchedAtLogin(argv) && s.startMinimized

/** The tray icon is there while the user wants it, and always while the window is hidden (otherwise it could not be reached). */
export const trayWanted = (s: Settings, windowHidden: boolean) => s.minimizeToTray || windowHidden

export class Startup {
  constructor(private readonly items: LoginItems | null, private readonly env: StartupEnv) {}

  /** Why the startup entry cannot be managed here, or null. A development build would register electron.exe, so it never writes one. */
  unsupportedReason(): string | null {
    if (this.env.platform !== 'win32') return 'Starting with the system is available on Windows.'
    if (!this.env.packaged || !this.items) return 'Available in the installed app. This copy runs from a development build.'
    return null
  }

  private query(): LoginItemQuery { return { path: this.env.execPath, args: [STARTUP_ARG] } }

  /** What Windows will do at the next sign-in, read from the Run key and Task Manager's StartupApproved state. */
  state(): StartupState {
    const reason = this.unsupportedReason()
    if (reason || !this.items) return { supported: false, reason, active: false, disabledByWindows: false, command: null }
    const r = this.items.get(this.query())
    const item = r.launchItems?.find(i => i.name === STARTUP_NAME)
    const registered = r.openAtLogin || !!item
    const enabled = item ? item.enabled : r.executableWillLaunchAtLogin ?? r.openAtLogin
    return {
      supported: true, reason: null,
      active: registered && enabled,
      disabledByWindows: registered && !enabled,
      command: `"${this.env.execPath}" ${STARTUP_ARG}`,
    }
  }

  /** Writes or removes the entry. Turning it on also re-approves an entry Task Manager turned off: the user asked for it here. */
  set(on: boolean): StartupState {
    const reason = this.unsupportedReason()
    if (reason || !this.items) throw new Error(reason ?? 'Unsupported')
    this.items.set({ ...this.query(), openAtLogin: on, enabled: on, name: STARTUP_NAME })
    return this.state()
  }
}

/** The stored switch follows what Windows will actually do, so turning the entry off in Task Manager shows up here. */
export function reconcile(s: Settings, st: StartupState): Settings {
  return st.supported && s.launchAtStartup !== st.active ? { ...s, launchAtStartup: st.active } : s
}
