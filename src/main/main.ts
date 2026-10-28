import { app, BrowserWindow, dialog, Menu, nativeTheme, session, shell } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Store } from '../core/store.js'
import { Backend } from './backend.js'
import { forwardEvents, registerIpc } from './ipc.js'

const DEV_URL = process.env.GITMANAGER_DEV_URL // set by scripts/dev.mjs only
const rendererIndex = path.join(__dirname, '..', '..', 'renderer', 'index.html')
const appUrl = DEV_URL ?? pathToFileURL(rendererIndex).toString()
const isTrustedUrl = (url: string) => (DEV_URL ? url.startsWith(DEV_URL) : url.split('#')[0] === appUrl)

// GITMANAGER_DATA_DIR isolates automated tests from a real configuration.
if (process.env.GITMANAGER_DATA_DIR) app.setPath('userData', process.env.GITMANAGER_DATA_DIR)
if (!app.requestSingleInstanceLock()) app.quit()

let win: BrowserWindow | null = null
let backend: Backend

function createWindow() {
  win = new BrowserWindow({
    width: 1320, height: 860, minWidth: 920, minHeight: 600, show: false, title: 'GitManager',
    backgroundColor: '#141515', autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false,
      allowRunningInsecureContent: false, webviewTag: false, navigateOnDragDrop: false,
    },
  })
  win.once('ready-to-show', () => win?.show())
  win.on('close', e => { void confirmQuit(e) })
  win.on('closed', () => { win = null })
  void win.loadURL(appUrl)
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

app.whenReady().then(() => {
  nativeTheme.themeSource = 'dark'
  Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]) : null)
  harden()
  const store = new Store(path.join(app.getPath('userData'), 'gitmanager.json'))
  backend = new Backend(store, {
    version: app.getVersion(),
    pickFolder: async () => {
      const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'], title: 'Choose a Git repository' })
      return r.canceled ? null : r.filePaths[0] ?? null
    },
    openPath: p => shell.openPath(p),
    openExternal: u => shell.openExternal(u),
  })
  registerIpc(backend, isTrustedUrl)
  forwardEvents(backend, () => win?.webContents ?? null)
  createWindow()
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus() } })
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow() })
})

app.on('before-quit', e => { void confirmQuit(e) })
app.on('window-all-closed', () => { app.quit() })
process.on('exit', () => backend?.services.killAllNow())
