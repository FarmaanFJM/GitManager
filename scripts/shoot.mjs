// Ad-hoc visual check: launches the built app with an isolated data folder and saves a window screenshot.
// Usage: node scripts/shoot.mjs <dataDir> <out.png> [width height]
import { _electron } from 'playwright'
import electronPath from 'electron'
const [dataDir, out, w = '1320', h = '860'] = process.argv.slice(2)
const app = await _electron.launch({ executablePath: electronPath, args: ['.', '--no-sandbox'], env: { ...process.env, GITMANAGER_DATA_DIR: dataDir } })
const page = await app.firstWindow()
await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), [Number(w), Number(h)])
page.on('console', m => console.log('[console]', m.type(), m.text()))
page.on('pageerror', e => console.log('[pageerror]', e.message))
await page.waitForTimeout(2500)
await page.screenshot({ path: out })
await app.close()
console.log('saved', out)
