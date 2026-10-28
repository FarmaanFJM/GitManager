import { Menu, nativeImage, Tray } from 'electron'

/** The notification area icon: click opens the window, the menu has Open and Quit. Created and destroyed by main.ts. */
export function createTray(iconPath: string, actions: { open: () => void; quit: () => void }): { tray: Tray; menu: Menu } {
  const tray = new Tray(nativeImage.createFromPath(iconPath))
  const menu = Menu.buildFromTemplate([
    { label: 'Open GitManager', click: actions.open },
    { type: 'separator' },
    { label: 'Quit GitManager', click: actions.quit },
  ])
  tray.setToolTip('GitManager')
  tray.setContextMenu(menu)
  tray.on('click', actions.open)
  tray.on('double-click', actions.open)
  return { tray, menu }
}
