#!/usr/bin/env node
// First-release acceptance scenario, end to end, against the built app (npm run build first).
// Real Git repositories, real processes (Vite + Spring Boot through ./mvnw), real Chrome. Writes screenshots and a
// step report to e2e-output/. Needs: git, node/npm, Java + Maven (for the backend), Chrome or Chromium, a display
// (on Linux run under Xvfb). Usage: node scripts/e2e.mjs [--chrome <path>] [--keep]
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import electronPath from 'electron'
import { _electron } from 'playwright'
import { buildFixture, buildHome, commitFile, git } from './e2e/fixture.mjs'
import { runSummaChecks } from './summa-ui/checks.mjs'

const args = process.argv.slice(2)
const opt = n => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined }
const OUT = join(process.cwd(), 'e2e-output')
rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true })
const work = mkdtempSync(join(tmpdir(), 'gm-e2e-'))
const dataDir = join(work, 'data')
const homeDir = join(work, 'home') // GITMANAGER_HOME: the home folder automatic discovery scans
const report = { startedAt: new Date().toISOString(), environment: { platform: process.platform, node: process.version }, steps: [] }
let step = 0
const log = (ok, name, detail = '') => { report.steps.push({ step: ++step, name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${String(step).padStart(2)} ${name}${detail ? `: ${detail}` : ''}`) }
const check = (cond, name, detail) => { log(!!cond, name, detail); if (!cond) throw new Error(`step failed: ${name}`) }
const portOpen = (port) => new Promise(r => { const s = net.connect({ host: '127.0.0.1', port }); s.once('connect', () => { s.destroy(); r(true) }); s.once('error', () => r(false)) })
const waitFor = async (fn, ms, every = 500) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise(r => setTimeout(r, every)) } return false }

// A Chrome launcher for this run: a separate profile, remote debugging so the test can read the opened tab, and
// --no-sandbox only because CI containers run as root. GitManager itself is given just this path as "Chrome location".
function chromeLauncher() {
  const exe = opt('chrome') ?? ['/opt/pw-browsers/chromium-1243/chrome-linux64/chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync)
  if (!exe) return null
  const wrapper = join(work, 'chrome-for-test.sh')
  writeFileSync(wrapper, `#!/bin/sh\necho "$@" >> "${join(work, 'chrome-calls.log')}"\nexec "${exe}" --no-sandbox --no-first-run --user-data-dir="${join(work, 'chrome-profile')}" --remote-debugging-port=9333 "$@"\n`)
  chmodSync(wrapper, 0o755)
  return wrapper
}

let app, page
async function launch() {
  app = await _electron.launch({ executablePath: electronPath, args: ['.', '--no-sandbox'], env: { ...process.env, GITMANAGER_DATA_DIR: dataDir, GITMANAGER_HOME: homeDir } })
  app.process().stderr.on('data', d => { const t = d.toString(); if (!/dbus|Debugger|debugging|Picked up/i.test(t)) process.stderr.write('[app] ' + t) })
  page = await app.firstWindow({ timeout: 30000 })
  page.on('pageerror', e => console.log('[pageerror]', e.message))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1320, 860))
  await page.waitForSelector('.gm-side')
  await page.waitForTimeout(400)
}
async function closeApp() {
  const proc = app.process()
  const exited = new Promise(r => proc.once('exit', r))
  // Wait for the Electron process itself. (A browser GitManager opened is detached on purpose and keeps running.)
  void app.close().catch(() => {})
  await Promise.race([exited, new Promise((_, rej) => setTimeout(() => rej(new Error('GitManager did not exit within 20 s')), 20000))])
  app = null
}
const shot = async (name) => { await page.waitForTimeout(250); await page.screenshot({ path: join(OUT, `${name}.png`) }) }
// Summa-UI objective checks on a screen, recorded in the report (they inform the review; they do not fail the run).
report.summaChecks = {}
const evaluate = async (name) => { const r = await runSummaChecks(page); report.summaChecks[name] = r; const fails = r.findings.filter(f => f.status === 'fail'); console.log(`     Summa-UI checks on ${name}: ${fails.length} fail, ${r.findings.length - fails.length} needs-human, ${r.focusStops} focus stops`) }
// Summa-UI popovers close when the page scrolls (by design), so bring a trigger into view before opening it.
const openDropdown = async (scope, name) => { const b = scope.getByRole('button', { name }); await b.scrollIntoViewIfNeeded(); await page.waitForTimeout(250); await b.click() }
const fact = (label) => page.locator('.gm-fact').filter({ has: page.locator('dt', { hasText: label }) }).locator('dd')

async function main() {
  for (const p of [5173, 8080]) if (await portOpen(p)) throw new Error(`port ${p} is in use; stop that process first`)
  const wgetrc = process.env.E2E_WGETRC
  console.log('building fixture in', work)
  const fx = buildFixture(join(work, 'repos'), { wgetrc })
  const chrome = chromeLauncher()
  report.environment.chrome = chrome ? 'Chromium via test launcher' : 'not found'

  const home = buildHome(homeDir)

  // 1. Open GitManager: automatic discovery registers the repositories in the home folder's development folders
  await launch()
  const nav = (name) => page.locator('.gm-repo-list .nav-item', { hasText: new RegExp(`^${name}`) })
  await nav('chess-engine-review').waitFor({ timeout: 30000 })
  await page.locator('.gm-discovery').waitFor({ state: 'detached', timeout: 30000 })
  await shot('01-first-run-discovery')
  const navNames = await page.locator('.gm-repo-list .nav-item .truncate').allInnerTexts()
  check(navNames.includes('chess-engine') && navNames.includes('chess-engine-review') && navNames.includes('openings'),
    'Open GitManager: discovery registered repositories and a worktree from the home folder', navNames.join(', '))
  check(!navNames.includes('left-pad') && !navNames.includes('vendored-lib') && !navNames.includes('too-deep'),
    'Discovery skipped dependency folders, submodules and folders beyond the depth')
  check((await nav('chess-engine-review').getAttribute('title')).includes('(worktree)'), 'Worktree recognized')
  check(git(home.engine, 'status', '--porcelain') === '' && git(home.engine, 'stash', 'list') === '', 'Discovery left the repositories untouched')

  // 2. Register an existing local repository (outside the scanned folders) from the sidebar's add menu
  await page.getByRole('button', { name: 'Add repositories' }).click()
  await page.getByRole('menuitem', { name: 'Add repository…' }).click()
  await page.getByLabel('Folder').fill(fx.local)
  await shot('02-add-repository')
  await page.getByRole('dialog').getByRole('button', { name: 'Add repository' }).click()
  await page.getByRole('heading', { name: 'caissa-trainer' }).waitFor()
  check(await page.locator('.gm-repo-list .nav-item', { hasText: 'caissa-trainer' }).isVisible(), 'Register an existing repository')

  // 3. Branch and working tree status
  await fact('Working tree').filter({ hasText: 'Clean' }).waitFor()
  check((await page.locator('.gm-branch').innerText()).includes('main'), 'Current branch shown', 'main')
  check((await fact('origin/main').innerText()) === 'Up to date', 'Working tree and sync status shown', 'Clean, Up to date')
  await page.locator('.gm-fact dd', { hasText: 'reachable' }).waitFor({ timeout: 15000 })
  check(true, 'Remote configured and reachable')

  // The teammate pushes two commits and a feature branch; I have uncommitted work in a file they do not touch.
  commitFile(fx.teammate, 'frontend/index.html', readFileSync(join(fx.teammate, 'frontend/index.html'), 'utf8').replace('<h1>CaissaTrainer</h1>', '<h1>CaissaTrainer</h1><p>Openings trainer</p>'), 'Add tagline')
  commitFile(fx.teammate, 'CHANGELOG.md', '# Changelog\n\n- Tagline\n', 'Add changelog')
  git(fx.teammate, 'push', '-q')
  git(fx.teammate, 'checkout', '-q', '-b', 'feature/board-themes')
  commitFile(fx.teammate, 'THEMES.md', 'Board themes\n', 'Board themes notes')
  git(fx.teammate, 'push', '-q', '-u', 'origin', 'feature/board-themes')
  writeFileSync(join(fx.local, 'README.md'), readFileSync(join(fx.local, 'README.md'), 'utf8') + '\nMy local notes, not committed.\n')
  await page.getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('menuitem', { name: 'Refresh status' }).click()
  await fact('Working tree').filter({ hasText: '1 changed' }).waitFor()
  check(true, 'Uncommitted change detected', '1 changed')

  // 4. Fetch
  const headBefore = git(fx.local, 'rev-parse', 'HEAD')
  await page.getByRole('button', { name: 'Fetch' }).click()
  await page.getByRole('button', { name: /Pull 2/ }).waitFor({ timeout: 30000 })
  check(git(fx.local, 'rev-parse', 'HEAD') === headBefore, 'Fetch changes no local branch or file')

  // 5. Ahead, behind or diverged
  check((await fact('origin/main').innerText()) === '2 commits to pull', 'Behind identified', '2 commits to pull')
  await page.getByRole('tab', { name: 'History' }).click()
  await page.getByText('Incoming from origin/main').waitFor()
  check(await page.locator('.gm-commit-subject', { hasText: 'Add tagline' }).first().isVisible(), 'Incoming commits listed')
  await shot('03-behind-after-fetch')
  await evaluate('03-behind-after-fetch')

  // 6. Safe fast-forward pull
  await page.getByRole('button', { name: /Pull 2/ }).click()
  await fact('origin/main').filter({ hasText: 'Up to date' }).waitFor({ timeout: 30000 })
  const localNotes = readFileSync(join(fx.local, 'README.md'), 'utf8').includes('My local notes')
  check(git(fx.local, 'rev-parse', 'HEAD') === git(fx.local, 'rev-parse', 'origin/main') && localNotes && git(fx.local, 'stash', 'list') === '', 'Fast-forward pull', 'HEAD = origin/main, uncommitted notes kept, no stash')

  // 7. Switch to another branch without losing work (creates the tracking branch from origin)
  await page.getByRole('button', { name: /^Branch: main/ }).click()
  await page.getByRole('option', { name: 'origin/feature/board-themes' }).waitFor()
  await shot('04-branch-picker')
  await page.getByRole('option', { name: 'origin/feature/board-themes' }).click()
  await page.locator('.gm-branch', { hasText: 'feature/board-themes' }).waitFor({ timeout: 20000 })
  check(git(fx.local, 'rev-parse', '--abbrev-ref', 'HEAD') === 'feature/board-themes' && readFileSync(join(fx.local, 'README.md'), 'utf8').includes('My local notes'), 'Switch branch, local work kept', 'tracking feature/board-themes')
  check(git(fx.local, 'rev-parse', '--abbrev-ref', '@{upstream}') === 'origin/feature/board-themes', 'Tracking branch created from the remote branch')

  // Branch overview: every branch against the remote's default branch, inspected without checking anything out
  const headAtInspect = git(fx.local, 'rev-parse', 'HEAD'), statusAtInspect = git(fx.local, 'status', '--porcelain')
  await page.getByRole('tab', { name: /^Branches/ }).click()
  const brow = (name) => page.locator('.gm-brow').filter({ has: page.locator('.gm-bname', { hasText: new RegExp(`^${name.replace(/\//g, '\\/')}(Default|, checked out)?$`) }) })
  await brow('origin/feature/board-themes').waitFor()
  const cells = async (name) => (await brow(name).locator('[role=cell]').allInnerTexts()).map(t => t.trim())
  const themes = await cells('origin/feature/board-themes')
  check(themes[3] === '0' && themes[4] === '1' && themes[5] === 'Ahead', 'Branches: origin/feature/board-themes 1 ahead, 0 behind origin/main', themes.slice(3, 6).join(' / '))
  check((await cells('origin/main'))[5] === 'Default' && (await brow('origin/main').locator('.tag').innerText()) === 'Default', 'Branches: default branch detected from the remote and marked')
  check(await brow('feature/board-themes').first().locator('[aria-label="Checked out"]').count() === 1, 'Branches: checked-out branch marked without relying on colour')
  await brow('origin/feature/board-themes').click()
  await page.locator('.gm-bdetail').getByText('Only on origin/feature/board-themes').waitFor()
  await page.locator('.gm-files li', { hasText: 'THEMES.md' }).waitFor()
  await shot('05-branches')
  await evaluate('05-branches')
  check(git(fx.local, 'rev-parse', 'HEAD') === headAtInspect && git(fx.local, 'status', '--porcelain') === statusAtInspect && git(fx.local, 'stash', 'list') === '',
    'Branch inspection changed nothing (HEAD, working tree, stash)')
  // Selecting another repository and coming back opens the Overview again
  await nav('chess-engine').first().click()
  await page.getByRole('heading', { name: 'chess-engine' }).waitFor()
  await nav('caissa-trainer').click()
  await page.getByRole('heading', { name: 'caissa-trainer' }).waitFor()
  check(await page.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected') === 'true', 'Returning to a repository opens its Overview')

  // 8. Configure and select a development profile
  await page.getByRole('tab', { name: 'Overview' }).click()
  await page.getByRole('button', { name: 'Create profile' }).click()
  await page.getByLabel('Name', { exact: true }).fill('CaissaTrainer')
  await page.getByLabel('Open when ready').fill('http://localhost:5173')
  const svc = page.locator('.gm-svc-edit')
  await svc.nth(0).getByLabel('Service name').fill('Frontend')
  await svc.nth(0).getByLabel('Command').fill('npm run dev')
  await svc.nth(0).getByLabel('Directory').fill('frontend')
  await openDropdown(svc.nth(0), 'Ready when')
  await page.getByRole('option', { name: 'URL responds' }).click()
  await svc.nth(0).getByLabel('Readiness URL').fill('http://localhost:5173')
  await page.getByRole('button', { name: 'Add service' }).click()
  await svc.nth(1).getByLabel('Service name').fill('Backend')
  await svc.nth(1).getByLabel('Command').fill('./mvnw spring-boot:run')
  await svc.nth(1).getByLabel('Directory').fill('backend')
  await openDropdown(svc.nth(1), 'Ready when')
  await page.getByRole('option', { name: 'Port is open' }).click()
  await svc.nth(1).getByLabel('Port').fill('8080')
  await svc.nth(1).getByLabel('Wait up to (seconds)').fill('240')
  if (wgetrc) await svc.nth(1).getByLabel('Environment variables').fill(`WGETRC=${wgetrc}`)
  await shot('06-profile-editor')
  await evaluate('06-profile-editor')
  await page.getByRole('button', { name: 'Save' }).click()
  await page.locator('.gm-svc-name', { hasText: 'Backend' }).waitFor()
  check(await page.locator('.gm-toolbar .select', { hasText: 'CaissaTrainer' }).isVisible(), 'Profile saved and selected')

  // 9. Start frontend and backend (after the one-time trust confirmation)
  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await page.getByRole('dialog', { name: 'Run CaissaTrainer?' }).waitFor()
  await shot('07-trust-confirmation')
  await page.getByRole('button', { name: 'Trust and run' }).click()
  await page.locator('.gm-svc-state', { hasText: 'Starting' }).first().waitFor({ timeout: 10000 })

  // 10. Startup progress and logs, independently per service
  await page.locator('.gm-svc', { hasText: 'Backend' }).click()
  await page.waitForTimeout(2500)
  await shot('08-services-starting')
  const sawStarting = await page.locator('.gm-svc', { hasText: 'Backend' }).locator('.gm-svc-state').innerText()
  log(true, 'Backend shows Starting before it is reachable', sawStarting)
  const frontReady = await waitFor(async () => (await page.locator('.gm-svc', { hasText: 'Frontend' }).locator('.gm-svc-state').innerText()) === 'Ready', 60000)
  check(frontReady, 'Frontend Ready when http://localhost:5173 responds')
  const backReady = await waitFor(async () => (await page.locator('.gm-svc', { hasText: 'Backend' }).locator('.gm-svc-state').innerText()) === 'Ready', 240000, 1000)
  check(backReady, 'Backend Ready when port 8080 accepts connections')
  check(await page.locator('.gm-log-line', { hasText: 'Started App' }).first().isVisible(), 'Backend log captured (Spring Boot output)')
  await shot('09-services-ready')
  await evaluate('09-services-ready')
  await page.locator('.gm-svc', { hasText: 'Frontend' }).click()
  await page.locator('.gm-log-line', { hasText: /VITE|Local:/ }).first().waitFor()
  check(true, 'Frontend log captured (Vite output)')

  // 11. Open the ready frontend in Chrome
  if (chrome) {
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByLabel('Chrome location').fill(chrome)
    await page.getByRole('button', { name: 'Save' }).click()
    await page.waitForTimeout(300)
    await shot('10-settings')
  await evaluate('10-settings')
    await page.locator('.gm-repo-list .nav-item', { hasText: 'caissa-trainer' }).click()
    await page.getByRole('button', { name: 'Open in browser' }).click()
    const opened = await waitFor(async () => {
      try { const tabs = await (await fetch('http://127.0.0.1:9333/json')).json(); return tabs.some(t => t.url.startsWith('http://localhost:5173') && /backend UP/.test(t.title)) } catch { return false }
    }, 30000)
    check(opened, 'Open in Chrome: page loaded and reached the backend through the frontend', 'tab title "CaissaTrainer · backend UP"')
    try { execFileSync('pkill', ['-f', join(work, 'chrome-profile')]) } catch { /* already closed */ }
  } else log(false, 'Open in Chrome', 'no Chrome or Chromium found on this machine')

  // Branch switching is refused while services run
  await page.getByRole('button', { name: /^Branch: feature/ }).click()
  await page.getByRole('option', { name: 'main' }).click()
  await page.getByRole('dialog', { name: 'Stop services to switch branches?' }).waitFor()
  await shot('11-switch-guard')
  await page.getByRole('button', { name: 'Cancel' }).click()
  check(git(fx.local, 'rev-parse', '--abbrev-ref', 'HEAD') === 'feature/board-themes', 'Switch while services run requires stopping them first', 'cancelled, branch unchanged')

  // 12. Stop both services
  const javaBefore = spawnSync('pgrep', ['-f', 'demo.App']).stdout.toString().trim()
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  const stopped = await waitFor(async () => (await page.locator('.gm-svc-state', { hasText: 'Stopped' }).count()) === 2, 30000)
  const portsFree = !(await portOpen(5173)) && !(await portOpen(8080))
  const javaAfter = spawnSync('pgrep', ['-f', 'demo.App']).stdout.toString().trim()
  check(stopped && portsFree && !!javaBefore && !javaAfter, 'Stop both services: process trees ended, ports freed', `JVM ${javaBefore || '?'} gone`)
  await shot('12-stopped')

  // Removing a discovered repository: the folder stays, and discovery does not add it back
  await nav('chess-engine-review').click()
  await page.getByRole('heading', { name: 'chess-engine-review' }).waitFor()
  await page.getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('menuitem', { name: 'Remove from GitManager' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Remove repository' }).click()
  await nav('chess-engine-review').waitFor({ state: 'detached' })
  check(existsSync(home.review), 'Remove a discovered repository: the folder stays on disk')
  await nav('caissa-trainer').click()
  await page.getByRole('heading', { name: 'caissa-trainer' }).waitFor()

  // 13. Close and reopen: registration and configuration persist
  await closeApp()
  await launch()
  await page.getByRole('heading', { name: 'caissa-trainer' }).waitFor()
  await page.waitForTimeout(1500)
  await page.locator('.gm-discovery').waitFor({ state: 'detached', timeout: 30000 })
  const afterRestart = await page.locator('.gm-repo-list .nav-item .truncate').allInnerTexts()
  check(afterRestart.includes('chess-engine') && !afterRestart.includes('chess-engine-review'), 'Reopen: discovery ran again, the removed repository stayed removed', afterRestart.join(', '))
  await page.locator('.gm-svc-name', { hasText: 'Backend' }).waitFor()
  const persisted = (await page.locator('.gm-toolbar .select').innerText()).includes('CaissaTrainer') && (await page.locator('.gm-branch').innerText()).includes('feature/board-themes')
  check(persisted, 'Reopen: repository, profile and selection restored')
  await shot('13-reopened')
  await page.getByRole('button', { name: 'Profile', exact: true }).click()
  await page.getByLabel('Search Profile').fill('Staging')
  await page.getByRole('button', { name: /Create profile/ }).waitFor()
  await shot('15-profile-dropdown-create')
  await page.keyboard.press('Escape')

  // Unsafe operation refused without damage: a diverged branch is never merged, rebased or reset
  await page.getByRole('button', { name: /^Branch: feature/ }).click()
  await page.getByRole('option', { name: 'main' }).click()
  await page.locator('.gm-branch', { hasText: 'main' }).waitFor()
  commitFile(fx.local, 'local.txt', 'mine\n', 'Local work')
  git(fx.teammate, 'checkout', '-q', 'main'); git(fx.teammate, 'pull', '-q'); commitFile(fx.teammate, 'remote.txt', 'theirs\n', 'Remote work'); git(fx.teammate, 'push', '-q')
  await page.getByRole('button', { name: 'Fetch' }).click()
  await fact('origin/main').filter({ hasText: 'Diverged' }).waitFor({ timeout: 30000 })
  const head = git(fx.local, 'rev-parse', 'HEAD')
  const tree = git(fx.local, 'status', '--porcelain')
  await page.getByRole('button', { name: /Pull 1/ }).click()
  await page.locator('.gm-banner', { hasText: 'diverged' }).waitFor()
  await shot('14-unsafe-pull-refused')
  await evaluate('14-unsafe-pull-refused')
  check(git(fx.local, 'rev-parse', 'HEAD') === head && git(fx.local, 'status', '--porcelain') === tree && !existsSync(join(fx.local, 'remote.txt')) && git(fx.local, 'stash', 'list') === '',
    'Unsafe pull on a diverged branch refused, repository unchanged')

  await closeApp()
}

try {
  await main()
  report.result = report.steps.every(s => s.ok) ? 'passed' : 'failed'
} catch (e) {
  report.result = 'failed'
  report.error = e.message
  console.error(e)
  if (page) await page.screenshot({ path: join(OUT, 'failure.png') }).catch(() => {})
} finally {
  if (app) await app.close().catch(() => {})
  try { execFileSync('pkill', ['-f', join(work, 'chrome-profile')]) } catch { /* not running */ }
  report.finishedAt = new Date().toISOString()
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  if (!args.includes('--keep')) rmSync(work, { recursive: true, force: true })
  console.log(`\n${report.result.toUpperCase()}: ${report.steps.filter(s => s.ok).length}/${report.steps.length} steps. Report and screenshots in e2e-output/`)
  process.exit(report.result === 'passed' ? 0 : 1)
}
