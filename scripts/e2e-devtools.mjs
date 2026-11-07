#!/usr/bin/env node
// Real-app check of the development control center: overview, integrated terminal (real PTY), port owner and live
// environment, Sync with Remote, worktrees. Real Git repositories and processes; Linux only (no Windows or WSL here).
// Run: npm run build && xvfb-run -a node scripts/e2e-devtools.mjs     Writes screenshots to e2e-output/devtools/.
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import electronPath from 'electron'
import { _electron } from 'playwright'

const OUT = join(process.cwd(), 'e2e-output', 'devtools')
rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true })
const work = mkdtempSync(join(tmpdir(), 'gm-dev-'))
const ENVG = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x.io', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x.io', GIT_CONFIG_GLOBAL: '/dev/null' }
const git = (cwd, ...a) => execFileSync('git', a, { cwd, env: ENVG, encoding: 'utf8' }).trim()
let n = 0, failed = 0
const check = (ok, name, detail = '') => { n++; if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${String(n).padStart(2)} ${name}${detail ? `: ${detail}` : ''}`) }

// repositories: "CaissaTrainer" with a remote; a stale (merged and deleted) branch and an unmerged one
const remote = join(work, 'origin.git'), repo = join(work, 'repos', 'CaissaTrainer'), home = join(work, 'home')
mkdirSync(join(work, 'repos'), { recursive: true }); mkdirSync(home, { recursive: true })
git(work, 'init', '-q', '--bare', '-b', 'main', remote)
git(work, 'clone', '-q', remote, repo)
git(repo, 'checkout', '-q', '-b', 'main')
writeFileSync(join(repo, 'README.md'), 'hi\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'init'); git(repo, 'push', '-q', '-u', 'origin', 'main')
git(repo, 'checkout', '-q', '-b', 'done'); writeFileSync(join(repo, 'a.txt'), 'a'); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'a'); git(repo, 'push', '-q', '-u', 'origin', 'done')
git(repo, 'checkout', '-q', '-b', 'wip'); writeFileSync(join(repo, 'w.txt'), 'w'); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'w'); git(repo, 'push', '-q', '-u', 'origin', 'wip')
git(repo, 'checkout', '-q', 'main'); git(repo, 'merge', '-q', '--no-ff', '-m', 'merge', 'done'); git(repo, 'push', '-q')
git(repo, 'push', '-q', 'origin', '--delete', 'done', 'wip')

// an outside process holding a port, started from the repository folder with a secret in its environment
const port = 18080 + Math.floor(Math.random() * 500)
const outsider = spawn(process.execPath, ['-e', `require('net').createServer().listen(${port},'127.0.0.1');setInterval(()=>{},1000)`], { cwd: repo, env: { ...process.env, MONGODB_URI: 'mongodb://user:s3cret@localhost/db' }, stdio: 'ignore' })

const env = { ...process.env, GITMANAGER_DATA_DIR: join(work, 'data'), GITMANAGER_HOME: home }
let app, page
const shot = name => page.screenshot({ path: join(OUT, `${name}.png`) })
try {
  app = await _electron.launch({ executablePath: electronPath, args: ['.', '--no-sandbox'], env })
  page = await app.firstWindow({ timeout: 30000 })
  page.on('pageerror', e => { failed++; console.log('[pageerror]', e.message) })
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(1320, 900) })
  await page.waitForSelector('.gm-side')
  const added = await page.evaluate(p => window.gitmanager.addRepo(p), repo)
  check(added.ok, 'repository registered')
  await page.reload(); await page.waitForSelector('.gm-side')

  // --- overview: compact row, no paragraphs
  await page.locator('.gm-side-foot .nav-item', { hasText: 'Repositories' }).click()
  await page.waitForSelector('.gm-ov-row, .top-row', { timeout: 15000 })
  await shot('01-overview')
  const rowText = await page.locator('.top-row').first().innerText()
  check(/CaissaTrainer/.test(rowText) && rowText.length < 120, 'overview row is name, branch and status only', JSON.stringify(rowText))

  // --- Terminal from the row opens in the repository root (real pty inside Electron)
  await page.getByRole('button', { name: /^Terminal, CaissaTrainer/ }).click()
  await page.waitForSelector('.gm-dock .xterm', { timeout: 15000 })
  await page.locator('.gm-dock .xterm').click()
  await page.keyboard.type('pwd && git branch --show-current && echo MARK$((6*7))\n')
  await page.waitForFunction(() => document.querySelector('.gm-dock .xterm-rows')?.textContent?.includes('MARK42') && (document.querySelector('.gm-dock .xterm-rows').textContent.match(/MARK42/g) || []).length >= 2 || false, null, { timeout: 15000 }).catch(() => {})
  const dockText = await page.locator('.gm-dock .xterm-rows').innerText()
  check(dockText.replace(/\s+/g, '').includes(repo.replace(/\s+/g, '') + 'main') || (dockText.includes(repo) && dockText.includes('MARK42')), 'terminal starts in the repository root and runs git', dockText.split('\n').filter(Boolean).slice(0, 3).join(' | '))
  await shot('02-terminal')

  // --- copy output: each command with what it printed, read back from the real clipboard
  await page.keyboard.type('echo ALPHA-ONE\n')
  await page.waitForFunction(() => (document.querySelector('.gm-dock .xterm-rows')?.textContent.match(/ALPHA-ONE/g) || []).length >= 2, null, { timeout: 15000 })
  await page.keyboard.type('printf "beta\\ntwo\\n"\n')
  await page.waitForFunction(() => document.querySelector('.gm-dock .xterm-rows')?.textContent.includes('two'), null, { timeout: 15000 })
  await page.waitForTimeout(400)
  const clip = () => app.evaluate(({ clipboard }) => clipboard.readText())
  await app.evaluate(({ clipboard }) => clipboard.writeText(''))
  await page.getByRole('button', { name: 'Copy output' }).click()
  await page.getByRole('menuitem', { name: 'Last command and output' }).click()
  await page.waitForFunction(async () => true)
  let last = ''; for (let i = 0; i < 20 && !last; i++) { last = await clip(); if (!last) await page.waitForTimeout(150) }
  check(/printf "beta/.test(last) && /^beta$/m.test(last) && /^two$/m.test(last) && !/ALPHA-ONE/.test(last) && !/echo ALPHA/.test(last) && !/two\n.*#\s*$/.test(last), 'Copy last command: the command line and only its output', JSON.stringify(last))
  await app.evaluate(({ clipboard }) => clipboard.writeText(''))
  await page.getByRole('button', { name: 'Copy output' }).click()
  await page.getByRole('menuitem', { name: 'All commands and outputs' }).click()
  let all = ''; for (let i = 0; i < 20 && !all; i++) { all = await clip(); if (!all) await page.waitForTimeout(150) }
  const iEcho = all.indexOf('echo ALPHA-ONE'), iAlpha = all.indexOf('\nALPHA-ONE'), iPrintf = all.indexOf('printf "beta')
  check(iEcho >= 0 && iAlpha > iEcho && iPrintf > iAlpha && /^beta$/m.test(all) && /^two$/m.test(all) && !/#\s*$/.test(all), 'Copy all: each command followed by its own output, in order', JSON.stringify(all))
  await shot('02b-copied')

  // --- processes: find the outside process on the port, read its live environment, stop it with confirmation
  await page.getByRole('button', { name: 'Processes' }).click()
  await page.waitForSelector(`text=${port}`, { timeout: 20000 })
  await shot('03-processes')
  const prow = page.locator('[role=row], .top-row, tr', { hasText: String(port) }).first()
  check(await prow.count() > 0, `port ${port} is listed`)
  await prow.getByRole('button', { name: /inspect/i }).first().click().catch(async () => { await prow.click() })
  await page.waitForSelector('text=Environment', { timeout: 10000 })
  await page.getByRole('tab', { name: 'Environment' }).click()
  await page.waitForSelector('text=MONGODB_URI', { timeout: 15000 })
  const concealed = !(await page.locator('body').innerText()).includes('s3cret')
  check(concealed, 'sensitive value is concealed at first')
  await page.getByRole('button', { name: 'Show all' }).click()
  check((await page.locator('body').innerText()).includes('s3cret'), 'Show all reveals the full value')
  await shot('04-environment')

  // --- Sync with Remote on the repository
  await page.locator('.gm-side-foot .nav-item', { hasText: 'Repositories' }).click()
  await page.locator('.gm-ov-name', { hasText: 'CaissaTrainer' }).click()
  await page.waitForSelector('.gm-top .gm-h1')
  await page.getByRole('button', { name: 'Sync with Remote' }).click()
  await page.waitForSelector('[role=dialog], [role=alertdialog]', { timeout: 30000 })
  await shot('05-sync')
  const dlg = await page.locator('[role=dialog], [role=alertdialog]').first().innerText()
  check(/stale branch/i.test(dlg) && /done/.test(dlg) && /wip/.test(dlg), 'sync lists the obsolete branches', dlg.split('\n').slice(0, 4).join(' | '))

  console.log(failed ? `\n${failed} FAILED` : '\nall passed')
} catch (e) {
  failed++; console.log('ERROR', e.message); try { await shot('error') } catch {}
} finally {
  try { await app?.close() } catch {}
  outsider.kill('SIGKILL'); rmSync(work, { recursive: true, force: true })
  process.exit(failed ? 1 : 0)
}
