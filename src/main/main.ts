import { app, BrowserWindow, dialog, Menu, nativeTheme, Notification, session, shell, type Tray } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { startHidden, Startup, trayWanted } from '../core/startup.js'
import { Store } from '../core/store.js'
import { Backend } from './backend.js'
import { chromeOptions, iconFile, PAGE_BACKGROUND } from './chrome.js'
import { forwardEvents, registerIpc } from './ipc.js'
import { createTray } from './tray.js'

const DEV_URL = process.env.GITMANAGER_DEV_URL // set by scripts/dev.mjs only
const rendererIndex = path.join(__dirname, '..', '..', 'renderer', 'index.html')
const appUrl = DEV_URL ?? pathToFileURL(rendererIndex).toString()
const isTrustedUrl = (url: string) => (DEV_URL ? url.startsWith(DEV_URL) : url.split('#')[0] === appUrl)
const brandIcon = (use: 'window' | 'tray') => path.join(app.getAppPath(), 'assets', 'brand', iconFile(process.platform, use))

// GITMANAGER_DATA_DIR isolates automated tests from a real configuration.
if (process.env.GITMANAGER_DATA_DIR) app.setPath('userData', process.env.GITMANAGER_DATA_DIR)
// The same id as the installer's shortcuts (package.json build.appId), so the taskbar groups the window with its pinned icon.
if (process.platform === 'win32') app.setAppUserModelId('io.github.farmaanfjm.gitmanager')

let win: BrowserWindow | null = null
let tray: { tray: Tray; menu: Menu } | null = null
let backend: Backend
let store: Store

function createWindow(hidden = false) {
  win = new BrowserWindow({
    width: 1320, height: 860, minWidth: 920, minHeight: 600, show: false, title: 'GitManager',
    backgroundColor: PAGE_BACKGROUND, autoHideMenuBar: true,
    ...chromeOptions(process.platform),
    // Taskbar and title bar icon. The packaged .exe carries the same icon from build/icon.ico (electron-builder).
    icon: brandIcon('window'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false,
      allowRunningInsecureContent: false, webviewTag: false, navigateOnDragDrop: false,
    },
  })
  win.once('ready-to-show', () => { if (!hidden) win?.show() })
  win.on('close', e => { void confirmQuit(e) })
  win.on('closed', () => { win = null; syncTray() })
  // Minimize to tray: the window leaves the taskbar and waits behind the tray icon.
  win.on('minimize', () => { if (store.data.settings.minimizeToTray) win?.hide() })
  win.on('show', syncTray)
  win.on('hide', syncTray)
  void win.loadURL(appUrl)
}

/** Brings the existing window back: from the tray, a second launch, or a shortcut. */
function showWindow() {
  if (!win) { createWindow(); return }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function syncTray() {
  const want = !!store && trayWanted(store.data.settings, !!win && !win.isVisible())
  if (want && !tray) {
    try {
      tray = createTray(brandIcon('tray'), { open: showWindow, quit: () => app.quit() })
    } catch (e) {
      console.error('[gitmanager] tray icon unavailable', e)
      if (win && !win.isVisible()) showWindow() // a hidden window must stay reachable
    }
  } else if (!want && tray) {
    tray.tray.destroy()
    tray = null
  }
}

function harden() {
  // The page can never open windows, navigate away, or ask for device permissions.
  app.on('web-contents-created', (_e, wc) => {
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    wc.on('will-navigate', (e, url) => { if (!isTrustedUrl(url)) e.preventDefault() })
    wc.on('will-attach-webview', e => e.preventDefault())
  })
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
}

let quitting = false
async function confirmQuit(e: Electron.Event) {
  if (quitting) return
  const running = backend.services.list().filter(s => backend.services.isAlive(s.key))
  if (!running.length) return
  e.preventDefault()
  if (win && !win.isVisible()) showWindow() // Quit from the tray: the question needs a visible window
  const choice = win
    ? await dialog.showMessageBox(win, {
        type: 'question', buttons: ['Stop services and quit', 'Cancel'], defaultId: 0, cancelId: 1, noLink: true,
        message: `${running.length === 1 ? '1 service is' : `${running.length} services are`} running.`,
        detail: 'GitManager stops the services it started before quitting.',
      })
    : { response: 0 }
  if (choice.response !== 0) return
  quitting = true
  await backend.services.stopAll()
  app.quit()
}

function start() {
  app.whenReady().then(() => {
    nativeTheme.themeSource = 'dark'
    Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]) : null)
    harden()
    store = new Store(path.join(app.getPath('userData'), 'gitmanager.json'))
    const startup = new Startup(
      { get: q => app.getLoginItemSettings(q), set: w => app.setLoginItemSettings(w) },
      { platform: process.platform, packaged: app.isPackaged, execPath: process.execPath },
    )
    backend = new Backend(store, {
      version: app.getVersion(),
      pickFolder: async () => {
        const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'], title: 'Choose a Git repository' })
        return r.canceled ? null : r.filePaths[0] ?? null
      },
      openPath: p => shell.openPath(p),
      openExternal: u => shell.openExternal(u),
      settingsChanged: () => syncTray(),
      notify: (title, body) => { if (Notification.isSupported()) new Notification({ title, body, silent: true }).show() },
    }, { startup })
    registerIpc(backend, isTrustedUrl)
    forwardEvents(backend, () => win?.webContents ?? null)
    void backend.startupState() // picks up a startup entry turned off in Task Manager since the last run
    // A launch by the Windows startup entry may wait in the tray. Nothing else differs: no service starts, nothing is
    // pulled or switched; discovery below runs as at any launch.
    createWindow(startHidden(process.argv, store.data.settings))
    syncTray()
    // Automatic discovery runs in the background once the window is up, at every launch, unless the user turned it off.
    win?.webContents.once('did-finish-load', () => { if (store.data.settings.autoDiscover) void backend.discovery.run('common') })
    // The optional storage schedule only ticks while GitManager runs; it is off unless the user turned it on in Storage.
    backend.storage.start()
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow() })
  })
  app.on('second-instance', () => showWindow())
  app.on('before-quit', e => { void confirmQuit(e) })
  app.on('window-all-closed', () => { app.quit() })
  process.on('exit', () => { backend?.storage.stop(); backend?.services.killAllNow() })

  // Read-only view of the tray for the acceptance scenarios (main process only; the page cannot reach it).
  if (process.env.GITMANAGER_TEST_HOOKS === '1') {
    Object.assign(globalThis, {
      __gitmanager: {
        tray: () => tray && !tray.tray.isDestroyed() ? { tooltip: 'GitManager', items: tray.menu.items.filter(i => i.type !== 'separator').map(i => i.label) } : null,
        clickTray: () => tray?.tray.emit('click'),
        clickTrayItem: (label: string) => tray?.menu.items.find(i => i.label === label)?.click(),
      },
    })
  }
}

// One GitManager per user: a second launch (shortcut, startup entry) brings the running window forward and exits.
if (app.requestSingleInstanceLock()) start()
else app.quit()
