#!/usr/bin/env node
// The installed Windows build, end to end: installs the NSIS installer silently for the current user, starts the
// installed GitManager.exe (not a development Electron), and checks the title bar, window behaviour, startup entry,
// tray and single instance with real Windows input (scripts/e2e/win-input.ps1), then uninstalls.
// Windows only; needs an interactive desktop session (GitHub's windows runners have one) and git.
// Usage: node scripts/e2e-windows.mjs <installer.exe>
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron } from 'playwright'
import { titlebarProblems, titlebarReport } from './e2e/window.mjs'

const installer = resolve(process.argv[2] ?? '')
if (process.platform !== 'win32' || !existsSync(installer)) { console.error('usage on Windows: node scripts/e2e-windows.mjs <installer.exe>'); process.exit(2) }
const OUT = join(process.cwd(), 'e2e-output-windows')
rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true })
const work = mkdtempSync(join(tmpdir(), 'gm-win-'))
const dataDir = join(work, 'data'), homeDir = join(work, 'home')
const RUN = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const APPROVED = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run'
const report = { startedAt: new Date().toISOString(), installer, steps: [] }
let step = 0
const log = (ok, name, detail = '') => { report.steps.push({ step: ++step, name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${String(step).padStart(2)} ${name}${detail ? `: ${detail}` : ''}`) }
const check = (cond, name, detail) => { log(!!cond, name, detail); if (!cond) throw new Error(`step failed: ${name}`) }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const waitFor = async (fn, ms, every = 200) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(every) } return false }
const ps = (...a) => execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(import.meta.dirname, 'e2e', 'win-input.ps1'), ...a], { encoding: 'utf8' })
const regValue = (key, name) => { const r = spawnSync('reg', ['query', key, '/v', name], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.split(/\r?\n/).find(l => l.includes(name))?.trim() ?? '' : null }
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim()

let app, page, exe
const env = () => ({ ...process.env, GITMANAGER_DATA_DIR: dataDir, GITMANAGER_HOME: homeDir, GITMANAGER_TEST_HOOKS: '1' })
async function launch(args = [], { visible = true } = {}) {
  app = await _electron.launch({ executablePath: exe, args, env: env(), timeout: 60000 })
  page = await app.firstWindow({ timeout: 60000 })
  page.on('pageerror', e => console.log('[pageerror]', e.message))
  await page.waitForSelector('.gm-side')
  if (visible) await waitFor(async () => (await win()).visible, 10000)
  await sleep(500)
}
async function quit() {
  const proc = app.process(); const gone = new Promise(r => proc.once('exit', r))
  void app.close().catch(() => {})
  await Promise.race([gone, sleep(20000)]); app = null
}
const win = () => app.evaluate(({ BrowserWindow, screen }) => {
  const w = BrowserWindow.getAllWindows()[0]
  return { visible: w.isVisible(), minimized: w.isMinimized(), maximized: w.isMaximized(), bounds: w.getBounds(), content: w.getContentBounds(), scale: screen.getDisplayMatching(w.getBounds()).scaleFactor, work: screen.getDisplayMatching(w.getBounds()).workArea }
})
const tray = () => app.evaluate(() => globalThis.__gitmanager.tray())
const setBounds = b => app.evaluate(({ BrowserWindow }, b) => { const w = BrowserWindow.getAllWindows()[0]; if (w.isMaximized()) w.unmaximize(); w.setBounds(b); w.focus() }, b)
/** Page (CSS) point to physical screen pixels. The content bounds, not the window bounds: a maximized window reaches past the screen edge. */
const screenPt = async (x, y) => { const w = await win(); return [Math.round((w.content.x + x) * w.scale), Math.round((w.content.y + y) * w.scale)] }
const mouse = async (action, x, y) => { const [sx, sy] = await screenPt(x, y); ps('-Action', action, '-X', String(sx), '-Y', String(sy)) }
const awayFromControls = () => mouse('move', 420, 420)
/** Screenshot of the window as Windows draws it (caption buttons included), and colours at window-relative points. */
async function capture(name, points = []) {
  const w = await win(), s = w.scale
  const pts = points.map(([x, y]) => `${Math.round(x * s)},${Math.round(y * s)}`).join(';')
  const out = ps('-Action', 'capture', '-X', String(Math.round(w.content.x * s)), '-Y', String(Math.round(w.content.y * s)), '-W', String(Math.round(w.content.width * s)), '-H', String(Math.round(w.content.height * s)), '-Path', join(OUT, `${name}.png`), '-Points', pts)
  return Object.fromEntries(out.trim().split(/\r?\n/).filter(Boolean).map(l => l.split('=')))
}
const near = (hex, want, tol = 4) => !!hex && [0, 2, 4].every(i => Math.abs(parseInt(hex.slice(i, i + 2), 16) - parseInt(want.slice(i, i + 2), 16)) <= tol)

/** Title bar colours: the page beside the sidebar brand, the header next to the caption buttons, and the caption buttons' own background. */
async function titlebarColours(name) {
  await awayFromControls(); await sleep(400)
  const r = await titlebarReport(page)
  if (!r.area) return { ok: false, colours: 'no window controls overlay', report: r }
  const right = r.area.x + r.area.width
  const c = await capture(name, [[40, 6], [right - 12, 6], [right + 6, 4], [right + r.captionWidth / 2, 4]])
  const w = await win(), sc = w.scale
  ps('-Action', 'capture', '-X', String(Math.round(w.content.x * sc)), '-Y', String(Math.round(w.content.y * sc)), '-W', String(Math.round(w.content.width * sc)), '-H', String(Math.round(64 * sc)), '-Path', join(OUT, `${name}-titlebar.png`))
  const v = Object.values(c)
  return { ok: near(v[0], '141515') && v.slice(1).every(h => near(h, '1b1c1c')), colours: v.join(' '), report: r }
}

async function main() {
  // A home folder with one repository, for automatic discovery on a real Windows file system
  mkdirSync(join(homeDir, 'Projects', 'demo'), { recursive: true })
  const repo = join(homeDir, 'Projects', 'demo')
  git(repo, 'init', '-q', '-b', 'main'); writeFileSync(join(repo, 'README.md'), '# demo\n')
  git(repo, 'add', '.'); git(repo, '-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'init')

  // 1. Install for the current user, silently, as a user would with the installer
  const inst = spawnSync(installer, ['/S'], { timeout: 300000 })
  const candidates = ['GitManager', 'gitmanager'].map(d => join(process.env.LOCALAPPDATA, 'Programs', d, 'GitManager.exe'))
  await waitFor(() => candidates.some(existsSync), 60000, 1000)
  exe = candidates.find(existsSync)
  check(inst.status === 0 && exe, 'Install: the installer put GitManager.exe in the user\'s Programs folder', exe ?? `exit ${inst.status}`)
  const lnk = p => execFileSync('powershell.exe', ['-NoProfile', '-Command', `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${p}'); "$($s.TargetPath)|$($s.IconLocation)"`], { encoding: 'utf8' }).trim()
  const desktop = join(execFileSync('powershell.exe', ['-NoProfile', '-Command', '[Environment]::GetFolderPath("Desktop")'], { encoding: 'utf8' }).trim(), 'GitManager.lnk')
  const startMenu = join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'GitManager.lnk')
  const shortcuts = [desktop, startMenu].map(p => existsSync(p) ? lnk(p) : 'missing')
  check(shortcuts.every(s => s.toLowerCase().startsWith(exe.toLowerCase())), 'Install: desktop and Start menu shortcuts start the installed GitManager.exe', shortcuts.join(' ; '))
  execFileSync(process.execPath, [join(import.meta.dirname, 'verify-branding.mjs'), '--exe', exe], { stdio: 'inherit' })
  log(true, 'Install: the installed executable carries the GitManager icon')

  // 2. Start the installed app: packaged, title bar overlay on the panel colour, discovery finds the repository
  await launch()
  const facts = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, execPath: process.execPath }))
  check(facts.packaged && facts.execPath.toLowerCase() === exe.toLowerCase(), 'Start: the installed, packaged GitManager.exe runs', facts.execPath)
  await page.locator('.gm-repo-list .nav-item', { hasText: 'demo' }).click({ timeout: 30000 })
  await page.getByRole('heading', { name: 'demo' }).waitFor()
  await setBounds({ x: 40, y: 30, width: 960, height: 660 })
  await sleep(600)
  const normal = await titlebarColours('w01-normal')
  const normalProblems = titlebarProblems(normal.report)
  check(!normalProblems.length, 'Title bar (normal): drag strip clear of controls and of the caption buttons', normalProblems.join('; ') || `caption buttons ${normal.report.captionWidth}px, strip ${normal.report.strip.width}x${normal.report.strip.height}`)
  check(normal.ok, 'Title bar (normal): page #141515 at the brand, #1B1C1C beside and behind the caption buttons, no native bar', normal.colours)

  // 3. Double-click the title bar (the sidebar's brand row) maximizes and restores
  await mouse('dblclick', 150, 26)
  check(await waitFor(async () => (await win()).maximized, 5000), 'Window: double-click on the title bar maximizes')
  await sleep(600)
  const max = await titlebarColours('w02-maximized')
  const maxProblems = titlebarProblems(max.report)
  check(!maxProblems.length && max.ok, 'Title bar (maximized): layout and colours hold', [...maxProblems, max.colours].join('; '))
  await mouse('dblclick', 150, 26)
  check(await waitFor(async () => !(await win()).maximized, 5000), 'Window: double-click again restores')

  // 4. The native caption buttons: maximize, restore, minimize
  const captionX = async i => { const r = await titlebarReport(page); return r.area.x + r.area.width + r.captionWidth * (2 * i + 1) / 6 }
  await mouse('click', await captionX(1), 18)
  check(await waitFor(async () => (await win()).maximized, 5000), 'Window: the maximize button maximizes')
  await mouse('click', await captionX(1), 18)
  check(await waitFor(async () => !(await win()).maximized, 5000), 'Window: the same button restores')
  await mouse('click', await captionX(0), 18)
  check(await waitFor(async () => (await win()).minimized, 5000), 'Window: the minimize button minimizes')
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.restore(); w.focus() })
  await waitFor(async () => !(await win()).minimized, 5000)

  // 5. Dragging by the title bar moves the window; dragging the corner resizes it; Win+Left snaps it
  await setBounds({ x: 40, y: 30, width: 960, height: 660 }); await sleep(400)
  const before = (await win()).bounds
  const [fx, fy] = await screenPt(150, 26)
  ps('-Action', 'drag', '-X', String(fx), '-Y', String(fy), '-X2', String(fx + 120), '-Y2', String(fy + 70))
  await sleep(500)
  const moved = (await win()).bounds
  // Windows starts the move only after its drag threshold, so a few pixels of the gesture are not applied
  check(Math.abs(moved.x - before.x - 120) <= 16 && Math.abs(moved.y - before.y - 70) <= 16 && moved.width === before.width, 'Window: dragging the title bar moves it', `${before.x},${before.y} -> ${moved.x},${moved.y}`)
  // The resize edge is just inside the visible frame or in Windows' invisible border just outside it; try both.
  // Minimum size near the top left first, so the corner and the drag stay on a 1024 x 768 runner screen.
  await setBounds({ x: 20, y: 20, width: 920, height: 600 }); await sleep(400)
  const sized = (await win()).bounds
  let resized = sized
  for (const d of [-3, 4]) {
    const [cx, cy] = await screenPt(sized.width + d, sized.height + d)
    ps('-Action', 'drag', '-X', String(cx), '-Y', String(cy), '-X2', String(cx + 60), '-Y2', String(cy + 40))
    await sleep(500)
    resized = (await win()).bounds
    if (resized.width !== sized.width) break
  }
  check(resized.width >= sized.width + 40 && resized.height >= sized.height + 25, 'Window: dragging the corner resizes it', `${sized.width}x${sized.height} -> ${resized.width}x${resized.height}`)
  await page.bringToFront(); await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus())
  await mouse('click', 150, 26) // focus through Windows, so the shortcut goes to this window
  ps('-Action', 'snapleft')
  // Left half at full height; never narrower than GitManager's minimum width (920), which a 1024 px screen's half is
  const snapped = await waitFor(async () => { const w = await win(); return w.bounds.x <= w.work.x + 8 && Math.abs(w.bounds.height - w.work.height) <= 16 && Math.abs(w.bounds.width - Math.max(w.work.width / 2, 920)) <= 16 }, 5000)
  const sw = await win()
  check(snapped, 'Window: Win+Left snaps it to the left half (Windows Snap)', `${JSON.stringify(sw.bounds)} in ${JSON.stringify(sw.work)}`)

  // 6. Display scaling is checked below with a 150 % scale factor; here, Settings > General on Windows
  await setBounds({ x: 40, y: 30, width: 960, height: 660 })
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('heading', { name: 'Settings' }).waitFor()
  const startupSwitch = page.getByRole('switch', { name: 'Launch at Windows startup' })
  check(await startupSwitch.getAttribute('aria-checked') === 'false' && regValue(RUN, 'GitManager') === null, 'Startup: off by default, no startup entry')
  await capture('w03-settings-general')
  await startupSwitch.click()
  await page.getByRole('switch', { name: 'Start minimized' }).click()
  await page.getByRole('button', { name: 'Save' }).click()
  await page.getByRole('button', { name: 'Save' }).and(page.locator(':disabled')).waitFor()
  const entry = regValue(RUN, 'GitManager')
  check(entry && entry.toLowerCase().includes(`"${exe.toLowerCase()}" --launched-at-login`) && !/electron\.exe/i.test(entry), 'Startup: the Run entry starts the installed GitManager.exe with --launched-at-login', entry)

  // 7. Task Manager turns the entry off: GitManager shows it, and switching it on again re-approves it
  execFileSync('reg', ['add', APPROVED, '/v', 'GitManager', '/t', 'REG_BINARY', '/d', '030000000000000000000000', '/f'])
  await page.reload(); await page.waitForSelector('.gm-side')
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByText('Turned off in Windows').waitFor({ timeout: 10000 })
  check(await page.getByRole('switch', { name: 'Launch at Windows startup' }).getAttribute('aria-checked') === 'false', 'Startup: an entry turned off in Task Manager shows as off, with the reason')
  await page.getByRole('switch', { name: 'Launch at Windows startup' }).click()
  await page.getByRole('switch', { name: 'Minimize to system tray' }).click()
  await page.getByRole('button', { name: 'Save' }).click()
  await page.getByRole('button', { name: 'Save' }).and(page.locator(':disabled')).waitFor()
  const approved = regValue(APPROVED, 'GitManager') ?? ''
  check(/REG_BINARY\s+02/i.test(approved) && regValue(RUN, 'GitManager'), 'Startup: switching it on again approves the entry', approved)

  // 8. Minimize to system tray, with the real minimize button; the tray icon brings the window back
  check((await tray())?.items.join('|') === 'Open GitManager|Quit GitManager', 'Tray: GitManager icon with Open GitManager and Quit GitManager')
  await mouse('click', await captionX(0), 18)
  check(await waitFor(async () => !(await win()).visible, 5000), 'Tray: the minimize button hides the window in the tray')
  await app.evaluate(() => globalThis.__gitmanager.clickTray())
  check(await waitFor(async () => { const w = await win(); return w.visible && !w.minimized }, 5000), 'Tray: clicking the icon restores the window')

  // 9. A second start of the installed app shows the running window and exits
  await mouse('click', await captionX(0), 18)
  await waitFor(async () => !(await win()).visible, 5000)
  const second = spawnSync(exe, [], { env: env(), timeout: 30000 })
  check(second.status === 0 && await waitFor(async () => (await win()).visible, 8000), 'Single instance: a second GitManager.exe exits and shows the running window', `exit ${second.status}`)
  await quit()

  // 10. Signed-in start (the Run entry's command): hidden in the tray, nothing started or changed, discovery still runs
  const head = git(repo, 'rev-parse', 'HEAD')
  await launch(['--launched-at-login'], { visible: false })
  await sleep(2000)
  const hidden = await win()
  check(!hidden.visible && !!(await tray()), 'Startup: launched with --launched-at-login and Start minimized, GitManager waits in the tray', JSON.stringify({ visible: hidden.visible }))
  const st = await page.evaluate(async () => { const s = await window.gitmanager.state(); return { running: s.services.filter(x => x.pid !== null).length, repos: s.repos.length } })
  check(st.running === 0 && st.repos >= 1 && git(repo, 'rev-parse', 'HEAD') === head && git(repo, 'status', '--porcelain') === '', 'Startup: no services, no pull or switch; repositories still registered', JSON.stringify(st))
  await app.evaluate(() => globalThis.__gitmanager.clickTray())
  check(await waitFor(async () => (await win()).visible, 5000), 'Startup: the tray icon opens the window')
  const proc = app.process(); const gone = new Promise(r => proc.once('exit', r))
  await app.evaluate(() => globalThis.__gitmanager.clickTrayItem('Quit GitManager')).catch(() => {})
  check(await Promise.race([gone.then(() => true), sleep(15000).then(() => false)]), 'Tray: Quit GitManager ends the application')
  app = null

  // 11. Display scaling: the layout at a 150 % scale factor
  await launch(['--force-device-scale-factor=1.5'])
  await setBounds({ x: 20, y: 20, width: 960, height: 640 }); await sleep(600)
  const scaled = await titlebarReport(page)
  const scaledProblems = titlebarProblems(scaled)
  check(!scaledProblems.length && scaled.devicePixelRatio === 1.5, 'Title bar at 150 %: same layout in device-independent pixels', scaledProblems.join('; ') || `caption buttons ${scaled.captionWidth}px at ${scaled.devicePixelRatio}x`)
  await capture('w04-scaled-150')

  // 12. The close button quits (no services running), then uninstalling removes the startup entry
  await mouse('click', await captionX(2), 18)
  const p2 = app.process()
  check(await Promise.race([new Promise(r => p2.once('exit', () => r(true))), sleep(15000).then(() => false)]), 'Window: the close button quits GitManager')
  app = null
  const uninstaller = join(exe, '..', 'Uninstall GitManager.exe')
  spawnSync(uninstaller, ['/S'], { timeout: 120000 })
  const removed = await waitFor(() => !existsSync(exe) && regValue(RUN, 'GitManager') === null && regValue(APPROVED, 'GitManager') === null, 60000, 1000)
  check(removed, 'Uninstall: GitManager and its startup entry are removed')
}

try {
  await main()
  report.result = report.steps.every(s => s.ok) ? 'passed' : 'failed'
} catch (e) {
  report.result = 'failed'; report.error = e.message; console.error(e)
  if (page) await page.screenshot({ path: join(OUT, 'failure-page.png') }).catch(() => {})
  if (app) await capture('failure-window').catch(() => {})
} finally {
  if (app) await app.close().catch(() => {})
  for (const k of [RUN, APPROVED]) spawnSync('reg', ['delete', k, '/v', 'GitManager', '/f'])
  report.finishedAt = new Date().toISOString()
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  rmSync(work, { recursive: true, force: true })
  console.log(`\n${report.result.toUpperCase()}: ${report.steps.filter(s => s.ok).length}/${report.steps.length} steps. Report and screenshots in e2e-output-windows/`)
  process.exit(report.result === 'passed' ? 0 : 1)
}
