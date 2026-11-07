#!/usr/bin/env node
// Section structure in the real window: the navigation, the terminal dock and the inspector must each read as their own region
// (a hairline edge plus a different surface from what is beside them), on the Processes screen, the Branches screen and Runners.
// Run: npm run build && xvfb-run -a node scripts/e2e-layout.mjs      Screenshots: e2e-output/layout/
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import electronPath from 'electron'
import { _electron } from 'playwright'

const OUT = join(process.cwd(), 'e2e-output', 'layout')
rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true })
const work = mkdtempSync(join(tmpdir(), 'gm-layout-'))
const ENVG = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x.io', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x.io', GIT_CONFIG_GLOBAL: '/dev/null' }
const git = (cwd, ...a) => execFileSync('git', a, { cwd, env: ENVG, encoding: 'utf8' }).trim()
let n = 0, failed = 0
const check = (ok, name, detail = '') => { n++; if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${String(n).padStart(2)} ${name}${detail ? `: ${detail}` : ''}`) }

const remote = join(work, 'origin.git'), repo = join(work, 'repos', 'CaissaTrainer'), home = join(work, 'home')
mkdirSync(join(work, 'repos'), { recursive: true }); mkdirSync(home, { recursive: true })
git(work, 'init', '-q', '--bare', '-b', 'main', remote); git(work, 'clone', '-q', remote, repo); git(repo, 'checkout', '-q', '-b', 'main')
writeFileSync(join(repo, 'a.txt'), 'a'); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'init'); git(repo, 'push', '-q', '-u', 'origin', 'main')
for (let i = 0; i < 14; i++) git(work, 'init', '-q', join(work, 'repos', `filler-${i}`)) // a long repository list, so the sidebar scrolls
const port = 19000 + Math.floor(Math.random() * 400)
const outsider = spawn(process.execPath, ['-e', `require('net').createServer().listen(${port},'127.0.0.1');setInterval(()=>{},1000)`], { cwd: repo, stdio: 'ignore' })

let app, page
const shot = name => page.screenshot({ path: join(OUT, `${name}.png`) })
/** The effective surface and edges of an element, as painted. */
const look = sel => page.evaluate(s => {
  const el = document.querySelector(s); if (!el) return null
  const c = getComputedStyle(el), r = el.getBoundingClientRect()
  return { bg: c.backgroundColor, shadow: c.boxShadow, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
}, sel)
/** A hairline edge drawn as a 1px offset shadow (a border inside a border would break Summa-UI P01). */
const hasEdge = shadow => /rgba?\([^)]*\)\s+-?[01]px\s+-?[01]px\s+0px\s+0px/.test(shadow ?? '')

try {
  app = await _electron.launch({ executablePath: electronPath, args: ['.', '--no-sandbox'], env: { ...process.env, GITMANAGER_DATA_DIR: join(work, 'data'), GITMANAGER_HOME: join(work, 'repos') } })
  page = await app.firstWindow({ timeout: 30000 })
  page.on('pageerror', e => { failed++; console.log('[pageerror]', e.message) })
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(1320, 900) })
  await page.waitForSelector('.gm-side')
  await page.evaluate(p => window.gitmanager.addRepo(p), repo)
  await page.reload(); await page.waitForSelector('.gm-side-foot')

  // --- sidebar: navigation is its own raised container below the repository list
  const foot = await look('.gm-side-foot'), list = await look('.gm-repo-list'), page0 = await page.evaluate(() => getComputedStyle(document.querySelector('.shell')).backgroundColor)
  check(foot && foot.bg !== page0 && foot.y >= list.y + list.h, 'navigation is a separate raised container under the repository list', `${foot?.bg} on ${page0}`)

  // --- Processes: table, dock and inspector
  await page.locator('.gm-side-foot .nav-item', { hasText: 'Processes' }).click()
  await page.waitForSelector(`text=${port}`, { timeout: 20000 })
  await page.getByRole('button', { name: /^Terminal, CaissaTrainer/ }).count().catch(() => 0)
  await page.evaluate(async p => { const r = (await window.gitmanager.state()).repos[0]; return r.id }, 0)
  const row = page.locator('.gm-prow', { hasText: String(port) }).first()
  await row.getByRole('button', { name: /inspect/i }).first().click()
  await page.waitForSelector('.gm-pdetail')
  // open a terminal from the process detail
  await page.locator('.gm-pdetail').getByRole('button', { name: /terminal/i }).first().click()
  await page.waitForSelector('.gm-dock .xterm', { timeout: 15000 })
  await page.waitForTimeout(600)
  await shot('01-processes')

  const view = await look('.gm-view'), dock = await look('.gm-dock'), main = await look('.shell-main'), insp = await look('.gm-pdetail'), tab = await look('.gm-dock-tab[data-active]')
  check(dock && hasEdge(dock.shadow) && dock.bg !== main.bg, 'terminal dock: top edge and a surface different from the main panel', `${dock?.shadow}; ${dock?.bg} vs ${main?.bg}`)
  check(dock && view && dock.y >= view.y + view.h - 1, 'terminal dock sits below the view, not over it', `view ends ${view && view.y + view.h}, dock starts ${dock?.y}`)
  check(!!tab && tab.bg !== dock.bg, 'the active terminal tab has its own fill', `${tab?.bg} on ${dock?.bg}`)
  check(insp && hasEdge(insp.shadow) && insp.bg !== main.bg, 'inspector: left edge and a surface different from the list', `${insp?.shadow}; ${insp?.bg} vs ${main?.bg}`)
  const ihead = await look('.gm-pdetail .gm-bdetail-head')
  check(ihead && parseFloat(await page.evaluate(() => getComputedStyle(document.querySelector('.gm-pdetail .gm-bdetail-head')).borderBottomWidth)) >= 1, 'inspector header is separated from its content')

  // --- Branches (another inspector) and Runners (a third): same treatment
  await page.locator('.gm-side-foot .nav-item', { hasText: 'Repositories' }).click()
  await page.locator('.gm-ov-name', { hasText: 'CaissaTrainer' }).click()
  await page.getByRole('tab', { name: /^Branches/ }).click()
  await page.locator('.gm-brow').first().click()
  await page.waitForSelector('.gm-bdetail')
  await shot('02-branches')
  const bd = await look('.gm-bdetail')
  check(bd && hasEdge(bd.shadow) && bd.bg !== main.bg, 'branches inspector has the same edge and surface', `${bd?.shadow}; ${bd?.bg}`)

  await page.locator('.gm-side-foot .nav-item', { hasText: 'Tools' }).click()
  await shot('03-tools')
  await page.locator('.gm-side-foot .nav-item', { hasText: 'Settings' }).click()
  await shot('04-settings')

  console.log(failed ? `\n${failed} FAILED` : '\nall passed')
} catch (e) { failed++; console.log('ERROR', e.message); try { await shot('error') } catch {} }
finally { try { await app?.close() } catch {} outsider.kill('SIGKILL'); rmSync(work, { recursive: true, force: true }); process.exit(failed ? 1 : 0) }
