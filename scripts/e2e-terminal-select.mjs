#!/usr/bin/env node
// Select to copy, in the real window with a real shell: a mouse selection is copied to the system clipboard when the button is
// released; the Terminal setting (Settings > Terminal > Select to copy) turns it off and on, is remembered across a restart and
// shared by every tab and repository; the manual Copy menu, typing, scrolling and Ctrl+C keep working. Linux (bash). Run: npm run build && xvfb-run -a node scripts/e2e-terminal-select.mjs
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import electronPath from 'electron'
import { _electron } from 'playwright'

const work = mkdtempSync(join(tmpdir(), 'gm-sel-'))
const OUT = join(process.cwd(), 'e2e-output', 'terminal-select'); rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true })
const ENVG = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x.io', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x.io', GIT_CONFIG_GLOBAL: '/dev/null' }
const git = (cwd, ...a) => execFileSync('git', a, { cwd, env: ENVG, encoding: 'utf8' }).trim()
const repos = ['alpha-repo', 'beta-repo'].map(n => join(work, 'repos', n))
for (const r of repos) { mkdirSync(r, { recursive: true }); git(r, 'init', '-q', '-b', 'main'); writeFileSync(join(r, 'a.txt'), 'a'); git(r, 'add', '-A'); git(r, 'commit', '-q', '-m', 'init') }
const env = { ...process.env, GITMANAGER_DATA_DIR: join(work, 'data'), GITMANAGER_HOME: join(work, 'repos') }
let n = 0, failed = 0
const check = (ok, name, detail = '') => { n++; if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${String(n).padStart(2)} ${name}${detail ? `: ${detail}` : ''}`) }
let app, page
const launch = async () => {
  app = await _electron.launch({ executablePath: electronPath, args: ['.', '--no-sandbox'], env })
  page = await app.firstWindow({ timeout: 30000 })
  page.on('pageerror', e => { failed++; console.log('[pageerror]', e.message) })
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(1320, 900) })
  await page.waitForSelector('.gm-side')
}
const clip = () => app.evaluate(({ clipboard }) => clipboard.readText())
const setClip = t => app.evaluate(({ clipboard }, t) => clipboard.writeText(t), t)
const toggle = () => page.getByRole('switch', { name: 'Select to copy' })
/** The preference lives in Settings > Terminal (the terminal header no longer carries a switch). */
const openSettings = async () => { await page.locator('.gm-side-foot .nav-item', { hasText: 'Settings' }).click(); await page.getByRole('heading', { name: 'Terminal' }).waitFor() }
const selectToCopyOn = async () => { await openSettings(); return (await toggle().getAttribute('aria-checked')) === 'true' }
const setSelectToCopy = async on => { if ((await selectToCopyOn()) !== on) { await toggle().click() } await page.getByRole('button', { name: 'Save' }).click(); await page.waitForTimeout(600); await page.locator('.gm-dock .xterm').last().click() }
const rowsText = () => page.evaluate(() => [...document.querySelectorAll('.gm-dock .xterm-rows > div')].map(d => d.textContent.replace(/ /g, ' ')))
/** Pixel position of a character cell: the terminal's DOM renderer, one row element per line. */
async function cell(rowIndex, col) {
  return page.evaluate(({ rowIndex, col }) => {
    const rows = document.querySelectorAll('.gm-dock .xterm-rows > div')
    const r = rows[rowIndex].getBoundingClientRect()
    const m = document.querySelector('.gm-dock .xterm-char-measure-element').getBoundingClientRect()
    const w = m.width / 32
    return { x: r.left + col * w, y: r.top + r.height / 2, w }
  }, { rowIndex, col })
}
async function lineOf(text) { const rows = await rowsText(); return rows.findIndex(t => t.trim() === text) }
/** Drag from the start of one cell to the start of another (the end cell is where the button is released). */
async function drag(r1, c1, r2, c2) {
  const a = await cell(r1, c1), b = await cell(r2, c2)
  await page.mouse.move(a.x + 1, a.y); await page.mouse.down(); await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 }); await page.mouse.move(b.x + 1, b.y, { steps: 4 }); await page.mouse.up()
  await page.waitForTimeout(250)
}
const typeLine = async s => { await page.keyboard.type(s + '\n'); await page.waitForTimeout(350) }
async function openTerminal(repoName) {
  await page.locator('.gm-side-foot .nav-item', { hasText: 'Repositories' }).click()
  const before = await page.locator('.gm-dock .xterm').count()
  await page.getByRole('button', { name: new RegExp(`^Terminal, ${repoName}`) }).click()
  // the new tab's pane exists, is the visible one (earlier panes are hidden) and its shell has printed a prompt
  await page.waitForFunction(n => {
    const panes = [...document.querySelectorAll('.gm-dock .xterm')]
    const shown = panes.filter(p => p.offsetParent !== null)
    return panes.length > n && shown.length === 1 && /[#$%>]\s*$/.test(shown[0].querySelector('.xterm-rows')?.textContent ?? '')
  }, before, { timeout: 30000 })
  await page.locator('.gm-dock .xterm').filter({ visible: true }).last().click()
}

try {
  await launch()
  for (const r of repos) { const x = await page.evaluate(p => window.gitmanager.addRepo(p), r); if (!x.ok) throw new Error(x.error.message) }
  await page.reload(); await page.waitForSelector('.gm-side-foot')
  await openTerminal('alpha-repo')

  check(await selectToCopyOn() === true, 'Select to copy is on by default'); await page.locator('.gm-dock .xterm').last().click()
  await typeLine('echo alpha-bravo charlie')
  await typeLine("printf 'one\\ntwo\\nthree\\n'")
  await page.screenshot({ path: join(OUT, '01-terminal.png') })
  const li = await lineOf('alpha-bravo charlie')
  check(li > 0, 'the output line is on screen', String(li))

  // 1. a word (double click)
  await setClip('SENTINEL')
  const w = await cell(li, 'alpha-bravo '.length + 2)
  await page.mouse.dblclick(w.x, w.y)
  await page.waitForTimeout(300)
  check((await clip()) === 'charlie', 'double-click on a word copies that word only', JSON.stringify(await clip()))
  // the selection stays highlighted
  check(await page.locator('.gm-dock .xterm-decoration, .gm-dock .xterm-selection div').count() > 0, 'the selection stays highlighted after copying')

  // 2. a substring inside a line ("bravo")
  await setClip('SENTINEL')
  await drag(li, 'alpha-'.length, li, 'alpha-bravo'.length)
  const sub = await clip()
  check(sub === 'bravo', 'dragging over part of a line copies exactly that text', JSON.stringify(sub))

  // 3. several lines keep their line breaks
  const l1 = await lineOf('one'), l3 = await lineOf('three')
  await setClip('SENTINEL')
  await drag(l1, 0, l3, 'three'.length)
  const multi = await clip()
  check(multi === 'one\ntwo\nthree', 'a multi-line selection keeps its line breaks', JSON.stringify(multi))

  // 4. an empty selection (a plain click) copies nothing
  await setClip('KEEP')
  const e = await cell(li, 2); await page.mouse.click(e.x, e.y); await page.waitForTimeout(250)
  check((await clip()) === 'KEEP', 'a click without a selection leaves the clipboard alone')

  // 5. off: the selection works but the clipboard is untouched; the manual Copy menu still copies
  await setSelectToCopy(false)
  check(await selectToCopyOn() === false, 'the setting turns off'); await page.locator('.gm-dock .xterm').last().click()
  await setClip('UNTOUCHED')
  await drag(li, 'alpha-'.length, li, 'alpha-bravo'.length)
  check((await clip()) === 'UNTOUCHED', 'off: selecting does not change the clipboard')
  check(await page.locator('.gm-dock .xterm-selection div').count() > 0, 'off: the text can still be selected')
  await page.getByRole('button', { name: 'Copy output' }).click()
  await page.getByRole('menuitem', { name: 'Last command and output' }).click()
  await page.waitForTimeout(300)
  check(/printf/.test(await clip()) && /^three$/m.test(await clip()), 'the manual Copy still works while auto-copy is off')

  // 6. on again
  await setSelectToCopy(true)
  await setClip('SENTINEL')
  await drag(li, 'alpha-'.length, li, 'alpha-bravo'.length)
  check((await clip()) === 'bravo', 'on again: automatic copying is back')

  // 7. same preference in another tab and another repository
  await setSelectToCopy(false) // off, then check it applies to new tabs and other repositories' terminals
  await page.getByRole('button', { name: 'New tab' }).click()
  await page.waitForFunction(() => [...document.querySelectorAll('.gm-dock .xterm')].filter(p => p.offsetParent !== null).some(p => /[#$%>]\s*$/.test(p.querySelector('.xterm-rows')?.textContent ?? '')), null, { timeout: 30000 })
  await page.locator('.gm-dock .xterm').filter({ visible: true }).last().click()
  await setClip('NEW-TAB-SENTINEL'); await page.keyboard.type('echo tabtext\n'); await page.waitForTimeout(400)
  const tl = await lineOf('tabtext'); await drag(tl, 0, tl, 4)
  check((await clip()) === 'NEW-TAB-SENTINEL', 'a new tab follows the same preference (off)')
  await openTerminal('beta-repo')
  await setClip('BETA-SENTINEL'); await page.keyboard.type('echo betatext\n'); await page.waitForTimeout(400)
  const bl = await lineOf('betatext'); await drag(bl, 0, bl, 4)
  check((await clip()) === 'BETA-SENTINEL', 'a terminal for another repository follows it too')
  await page.getByRole('tab').first().click()
  check(await selectToCopyOn() === false, 'switching back to the first tab keeps it')

  // 8. the preference survives a restart (off), and so does on
  await app.close(); await launch()
  await page.locator('.gm-side-foot .nav-item', { hasText: 'Repositories' }).click()
  await page.getByRole('button', { name: /^Terminal, alpha-repo/ }).click()
  await page.waitForSelector('.gm-dock .xterm', { timeout: 15000 })
  check(await selectToCopyOn() === false, 'off survives a restart')
  await setSelectToCopy(true)
  await app.close(); await launch()
  await page.locator('.gm-side-foot .nav-item', { hasText: 'Repositories' }).click()
  await page.getByRole('button', { name: /^Terminal, alpha-repo/ }).click()
  await page.waitForSelector('.gm-dock .xterm', { timeout: 15000 })
  check(await selectToCopyOn() === true, 'on survives a restart')

  // 9. terminal behaviour: typing, scrolling, Ctrl+C
  await page.locator('.gm-side-foot .nav-item', { hasText: 'Repositories' }).click()
  await page.waitForFunction(() => /[#$%>]\s*$/.test(document.querySelector('.gm-dock .xterm-rows')?.textContent ?? ''), null, { timeout: 15000 })
  await page.locator('.gm-dock .xterm').last().click()
  await typeLine('seq 1 120')
  await page.waitForTimeout(500)
  const first = async () => (await rowsText())[0]
  const before = await first()
  await page.mouse.move(600, 700); await page.mouse.wheel(0, -600); await page.waitForTimeout(400)
  const scrolled = await first()
  check(scrolled !== before, 'the terminal still scrolls', `${JSON.stringify(before)} -> ${JSON.stringify(scrolled)}`)
  await page.mouse.wheel(0, 3000); await page.waitForTimeout(200)
  await page.keyboard.type('sleep 30\n'); await page.waitForTimeout(500)
  // a selection exists while a process runs; Ctrl+C must still interrupt it
  const l = await lineOf('seq 1 120'); void l
  await drag(2, 0, 2, 4)
  await page.keyboard.press('Control+C')
  await page.waitForFunction(() => /\^C/.test(document.querySelector('.gm-dock .xterm-rows')?.textContent ?? ''), null, { timeout: 8000 }).catch(() => {})
  await typeLine('echo AFTER-INTERRUPT')
  const rows = (await rowsText()).join('\n')
  check(/\^C/.test(rows) && (rows.match(/AFTER-INTERRUPT/g) || []).length >= 2, 'Ctrl+C still interrupts a running command and typing continues')
  await page.screenshot({ path: join(OUT, '02-final.png') })
  console.log(failed ? `\n${failed} FAILED` : '\nall passed')
} catch (e) { failed++; console.log('ERROR', e.message); try { await page.screenshot({ path: join(OUT, 'error.png') }) } catch {} }
finally { try { await app?.close() } catch {} rmSync(work, { recursive: true, force: true }); process.exit(failed ? 1 : 0) }
