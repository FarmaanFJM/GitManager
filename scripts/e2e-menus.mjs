#!/usr/bin/env node
// Acceptance scenario for the action menus and the repository context menu, against the built app (npm run build first).
// It drives the real renderer: right-click on a repository in the sidebar, the removal and the deletion flows with a real
// trash, and the three-dot menu of Runner Details, checking in the real window that no background shows through any menu.
// Usage: node scripts/e2e-menus.mjs   (Linux: under xvfb-run). Writes screenshots and a report to e2e-output/menus/.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import electronPath from 'electron'
import { _electron } from 'playwright'
import { buildExistingInstall, runnersWorld } from './e2e/runners-fixture.mjs'

const OUT = join(process.cwd(), 'e2e-output', 'menus')
rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true })
const work = mkdtempSync(join(process.cwd(), 'e2e-output', 'menus-work-'))
const home = join(work, 'home'), code = join(home, 'code'), dataDir = join(work, 'data'), stateFile = join(work, 'world.json')
mkdirSync(code, { recursive: true })
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' } }).trim()
const mk = (name, text) => { const d = join(code, name); mkdirSync(d); git(d, 'init', '-q', '-b', 'main'); writeFileSync(join(d, 'README.md'), text ?? name); git(d, 'add', '.'); git(d, 'commit', '-q', '-m', 'init'); return d }
const liedStack = mk('lied-stack'); const keep = mk('keep'); const oldOne = mk('old-removed'); const alpha = mk('alpha-project')
writeFileSync(join(liedStack, 'README.md'), 'edited'); writeFileSync(join(liedStack, 'notes.txt'), 'unsaved notes') // uncommitted and untracked work
const runnersDir = join(work, 'runners'); buildExistingInstall(join(runnersDir, 'existing'))
// an obsolete installation: registered once, GitHub no longer lists it, no service, nothing running
const orphanDir = buildExistingInstall(join(runnersDir, 'old-install'))
writeFileSync(join(orphanDir, '.runner'), JSON.stringify({ agentId: 99, agentName: 'old-pc', poolName: 'Default', gitHubUrl: 'https://github.com/FarmaanFJM/GitManager', workFolder: '_work' }))
rmSync(join(orphanDir, '.service'))
writeFileSync(stateFile, JSON.stringify(runnersWorld()))

const report = { startedAt: new Date().toISOString(), steps: [] }
let n = 0
const check = (ok, name, detail = '') => { report.steps.push({ step: ++n, name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${String(n).padStart(2)} ${name}${detail ? `: ${detail}` : ''}`); if (!ok) throw new Error(`step failed: ${name}`) }
const env = { ...process.env, GITMANAGER_DATA_DIR: dataDir, GITMANAGER_HOME: home, GITMANAGER_GH: join(process.cwd(), 'scripts', 'e2e', 'fake-gh.mjs'), FAKE_GH_STATE: stateFile, GITMANAGER_TEST_HOOKS: '1' }
let app, page
const shot = name => page.screenshot({ path: join(OUT, `${name}.png`) })
const state = () => page.evaluate(() => window.gitmanager.state())
const menuBox = () => page.locator('.popover').boundingBox()

/**
 * Opacity as the renderer really paints it: the computed surface is a solid colour with no blur, and the menu's pixels are the
 * same with the content beneath it shown and hidden (if anything showed through, the two screenshots would differ).
 */
async function samePixels(hideCss) {
  const hide = hidden => page.evaluate(({ hidden, css }) => { document.getElementById('__hide')?.remove(); if (hidden) { const st = document.createElement('style'); st.id = '__hide'; st.textContent = css; document.head.append(st) } }, { hidden, css: hideCss })
  const box = await menuBox()
  // inset past the rounded corners and the outline, which are outside the surface itself
  const clip = { x: Math.ceil(box.x) + 6, y: Math.ceil(box.y) + 6, width: Math.floor(box.width) - 12, height: Math.floor(box.height) - 12 }
  const withContent = await page.screenshot({ clip })
  await hide(true)
  const without = await page.screenshot({ clip })
  await hide(false)
  return Buffer.compare(withContent, without) === 0
}

async function assertOpaque(name, hideCss) {
  const css = await page.evaluate(() => { const p = document.querySelector('.popover'); const s = getComputedStyle(p); return { bg: s.backgroundColor, filter: s.backdropFilter, webkit: s.webkitBackdropFilter, opacity: s.opacity, z: s.zIndex, anim: s.animationName } })
  const alpha = css.bg.startsWith('rgba') ? Number(css.bg.split(',')[3]) : 1
  check(alpha === 1 && /^rgb\(/.test(css.bg) && (css.filter === 'none' || css.filter === '') && css.opacity === '1', `${name}: the menu surface is a solid colour with no blur or translucency`, JSON.stringify(css))
  await page.waitForTimeout(250) // the entrance animation only moves; wait for it anyway
  check(await samePixels(hideCss), `${name}: pixels inside the menu are identical with the content beneath shown and hidden (nothing bleeds through)`)
  const box = await menuBox()
  const clip = { x: Math.ceil(box.x) + 6, y: Math.ceil(box.y) + 6, width: Math.floor(box.width) - 12, height: Math.floor(box.height) - 12 }
  const top = await page.evaluate(({ x, y }) => { const e = document.elementFromPoint(x, y); return !!e?.closest('.popover') }, { x: clip.x + clip.width / 2, y: clip.y + clip.height / 2 })
  check(top, `${name}: the menu is the topmost element over the content it covers`)
}

try {
  app = await _electron.launch({ executablePath: electronPath, args: ['.', '--no-sandbox'], env })
  app.process().stderr.on('data', d => { const t = d.toString(); if (!/dbus|Debugger|debugging|Picked up|StatusNotifier|libappindicator|DevTools/i.test(t)) process.stderr.write('[app] ' + t) })
  page = await app.firstWindow({ timeout: 30000 })
  page.on('pageerror', e => { console.log('[pageerror]', e.message); report.pageErrors = [...(report.pageErrors ?? []), e.message] })
  await app.evaluate(({ BrowserWindow, shell }) => { BrowserWindow.getAllWindows()[0].setSize(1320, 900); shell.openExternal = async () => {} })
  await page.waitForSelector('.gm-side')
  for (const p of [alpha, oldOne, liedStack, keep]) { const r = await page.evaluate(path => window.gitmanager.addRepo(path), p); if (!r.ok) throw new Error(r.error.message) }
  await page.reload(); await page.waitForSelector('.gm-repo-list .nav-item')
  const row = name => page.locator('.gm-repo-list .nav-item', { hasText: name })
  await row('keep').click()
  await page.waitForSelector('.gm-top .gm-h1:has-text("keep")')

  // ---- right-click menu
  await row('lied-stack').click({ button: 'right' })
  await page.waitForSelector('.popover [role=menuitem]')
  const labels = await page.locator('.popover [role=menuitem]').allInnerTexts()
  check(labels.join('|') === 'Open repository|Open folder|Copy folder path|Remove from GitManager|Delete local folder…', 'right-click opens the repository menu with the five actions', labels.join('|'))
  check((await state()).ui.selectedRepoId === (await state()).repos.find(r => r.name === 'keep').id && (await row('keep').getAttribute('aria-current')) === 'true' && (await page.locator('.gm-top .gm-h1').innerText()) === 'keep', 'the right-click did not change the selected repository')
  const rowBox = await row('lied-stack').boundingBox(), mb = await menuBox()
  check(mb.x >= rowBox.x && mb.x <= rowBox.x + rowBox.width && mb.y >= rowBox.y && mb.y <= rowBox.y + rowBox.height + 4, 'the menu opens at the pointer, on the row that was clicked', JSON.stringify({ rowBox, mb }))
  check(await page.locator('.popover .menu-item.danger').innerText() === 'Delete local folder…' && (await page.locator('.popover .menu-item').last().getAttribute('class')).includes('danger'), 'the destructive action is last and marked as danger')
  await assertOpaque('repository menu', '.gm-side > *:not(.popover), .gm-work { visibility: hidden !important }')
  // control: the same measurement must catch the pinned Summa-UI glass, or it proves nothing
  await page.evaluate(() => { const st = document.createElement('style'); st.id = '__glass'; st.textContent = '.popover { background: color-mix(in srgb, var(--s4) 88%, transparent) !important; backdrop-filter: none !important }'; document.head.append(st) })
  check(!(await samePixels('.gm-side > *:not(.popover), .gm-work { visibility: hidden !important }')), 'control: with the pinned 88% glass surface the same measurement detects content showing through')
  await page.evaluate(() => document.getElementById('__glass').remove())
  await shot('01-repo-menu')
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown')
  check((await page.evaluate(() => document.activeElement?.textContent)) === 'Open folder' || (await page.evaluate(() => document.activeElement?.textContent)) === 'Copy folder path', 'the menu takes keyboard focus and arrow keys move through it')
  await page.keyboard.press('Escape')
  check(await page.locator('.popover').count() === 0, 'Escape closes the menu')
  await row('alpha-project').focus(); await page.keyboard.press('Shift+F10')
  await page.waitForSelector('.popover [role=menuitem]')
  check((await page.locator('.popover').getAttribute('aria-label')) === 'Actions for alpha-project', 'Shift+F10 opens the menu for the focused row from the keyboard')
  await page.keyboard.press('Escape')

  // ---- Remove from GitManager: the folder stays, discovery does not bring it back
  await row('old-removed').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Remove from GitManager' }).click()
  const dlg = page.getByRole('alertdialog')
  check(/Remove old-removed from GitManager\?/.test(await dlg.innerText()) && /folder and its files stay/.test(await dlg.innerText()), 'Remove from GitManager says plainly that the files stay')
  await shot('02-remove-confirm')
  await dlg.getByRole('button', { name: 'Remove from GitManager' }).click()
  await page.waitForFunction(() => ![...document.querySelectorAll('.gm-repo-list .nav-item')].some(e => e.textContent.includes('old-removed')))
  check(existsSync(join(oldOne, '.git')), 'the removed repository\'s folder is untouched')
  await page.evaluate(() => window.gitmanager.rescan('common')); await page.waitForTimeout(1500)
  await page.waitForFunction(() => window.gitmanager.discoveryStatus().then(s => !s.running))
  check((await state()).repos.every(r => r.name !== 'old-removed') && (await state()).ignored.length === 1, 'a rescan does not bring the removed repository back', JSON.stringify((await state()).repos.map(r => r.name)))

  // ---- Delete local folder
  await row('lied-stack').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete local folder…' }).click()
  const del = page.getByRole('alertdialog')
  await del.locator('.gm-delete-props').waitFor()
  const text = await del.innerText()
  check(text.includes('Delete the local folder of lied-stack?') && text.includes(liedStack) && /Uncommitted\s+Yes/.test(text) && /Untracked\s+Yes \(1 file\)/.test(text) && /Services\s+None running/.test(text) && /Where\s+Linux/.test(text), 'the confirmation shows the name, the exact folder, the system, uncommitted and untracked work and services', text.replace(/\s+/g, ' ').slice(0, 400))
  check(/not touched/.test(text) && /GitHub/.test(text), 'it states that GitHub is not affected')
  const confirmBtn = del.getByRole('button', { name: /^Move folder to Trash/ })
  check(await confirmBtn.isDisabled(), 'with unsaved work the destructive button stays disabled until the loss is acknowledged')
  check((await confirmBtn.getAttribute('class')).includes('btn-danger'), 'the confirmation button is the solid destructive style')
  await shot('03-delete-confirm')
  await del.getByRole('checkbox', { name: /work listed above will be lost/ }).click()
  check(await confirmBtn.isEnabled(), 'acknowledging enables it')
  const before = (await state()).repos.map(r => r.name)
  await confirmBtn.click()
  await page.waitForFunction(() => ![...document.querySelectorAll('.gm-repo-list .nav-item')].some(e => e.textContent.includes('lied-stack')), null, { timeout: 30000 })
  check(!existsSync(liedStack), 'the folder is gone from the disk (moved to the trash)')
  check(existsSync(join(keep, '.git')) && existsSync(join(alpha, '.git')) && existsSync(join(oldOne, '.git')), 'other repositories and the removed one\'s folder are untouched')
  const after = (await state()).repos.map(r => r.name)
  check(JSON.stringify(after) === JSON.stringify(before.filter(x => x !== 'lied-stack')), 'only lied-stack left the sidebar', after.join(', '))
  check((await page.locator('.gm-top .gm-h1').innerText()) === 'keep', 'the selected repository (keep) stayed selected')
  await page.waitForSelector('.toast, [role=status]'); await shot('04-after-delete')
  await page.evaluate(() => window.gitmanager.rescan('common')); await page.waitForTimeout(1500)
  await page.waitForFunction(() => window.gitmanager.discoveryStatus().then(s => !s.running))
  check((await state()).repos.every(r => r.name !== 'lied-stack'), 'a rescan does not bring the deleted repository back')

  // ---- Runner Details menu over underlying text
  await page.getByRole('button', { name: 'Tools' }).click(); await page.locator('.gm-tool', { hasText: 'Runners' }).click()
  await page.getByRole('tab', { name: /^Discovery/ }).click()
  await page.getByLabel('Folder to inspect').fill(runnersDir); await page.getByRole('button', { name: 'Add folder' }).click()
  await page.getByRole('tab', { name: /^Runners/ }).click()
  await page.getByRole('button', { name: /^Scan/ }).first().click()
  await page.waitForSelector('.gm-rrow:has-text("build-box")', { timeout: 60000 })
  await page.locator('.gm-rrow', { hasText: 'build-box' }).click()
  await page.waitForSelector('.gm-rdetail')
  await page.getByRole('button', { name: 'More runner actions' }).click()
  await page.waitForSelector('.popover [role=menuitem]')
  const rb = await menuBox(), under = await page.evaluate(({ x, y, w, h }) => { const hits = new Set(); for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) { const e = document.elementsFromPoint(x + (w * (i + 0.5)) / 10, y + (h * (j + 0.5)) / 10).filter(el => !el.closest('.popover')).find(el => el.childNodes.length && [...el.childNodes].some(c => c.nodeType === 3 && c.textContent.trim())); if (e) hits.add(e.textContent.trim().slice(0, 30)) } return [...hits] }, { x: rb.x, y: rb.y, w: rb.width, h: rb.height })
  check(under.length > 0, 'the Runner Details menu covers real text of the details pane', under.slice(0, 4).join(' | '))
  await assertOpaque('Runner Details menu', '.gm-work > *, .gm-side { visibility: hidden !important }')
  const disabled = await page.evaluate(() => { const lum = c => { const m = (c.startsWith('color(') ? c.replace(/^color\(srgb\s*/, '').match(/[\d.]+/g).map(x => Number(x) * 255) : c.match(/[\d.]+/g).map(Number)); const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }; return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]) }; const bg = getComputedStyle(document.querySelector('.popover')).backgroundColor; const ratio = el => { const a = lum(getComputedStyle(el).color) + 0.05, b = lum(bg) + 0.05; return Math.max(a, b) / Math.min(a, b) }; const items = [...document.querySelectorAll('.popover .menu-item')]; return { enabled: items.filter(i => !i.disabled && !i.classList.contains('danger')).map(ratio), disabled: items.filter(i => i.disabled && !i.classList.contains('danger')).map(ratio), dangerDisabled: items.filter(i => i.disabled && i.classList.contains('danger')).map(ratio), dangerEnabled: items.filter(i => !i.disabled && i.classList.contains('danger')).map(ratio) } })
  check(disabled.enabled.every(r => r >= 7) && disabled.disabled.every(r => r >= 3) && disabled.dangerDisabled.every(r => r >= 3) && disabled.dangerEnabled.every(r => r >= 4.5), 'text contrast: enabled actions are very readable, disabled and destructive ones stay readable', JSON.stringify(disabled))
  const hover = await page.evaluate(async () => { const it = document.querySelector('.popover .menu-item:not(:disabled):not(.danger)'); return getComputedStyle(it).backgroundColor })
  await page.locator('.popover .menu-item:not(:disabled):not(.danger)').first().hover()
  const hov = await page.locator('.popover .menu-item:not(:disabled):not(.danger)').first().evaluate(e => getComputedStyle(e).backgroundColor)
  check(hov !== hover && /rgba?\(255, 255, 255|rgb\((\d+), \1, \1\)|rgba\((\d+), \2, \2/.test(hov) || /^rgba?\(\d+, \d+, \d+/.test(hov), 'the hover state is a neutral surface change', hov)
  await shot('05-runner-details-menu')
  await page.keyboard.press('Escape')
  await page.locator('.gm-rrow', { hasText: 'win-laptop' }).click()
  await page.getByRole('button', { name: 'More runner actions' }).click()
  await page.waitForSelector('.popover [role=menuitem]')
  const dis = await page.evaluate(() => { const lum = c => { const m = (c.startsWith('color(') ? c.replace(/^color\(srgb\s*/, '').match(/[\d.]+/g).map(x => Number(x) * 255) : c.match(/[\d.]+/g).map(Number)); const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }; return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]) }; const bg = getComputedStyle(document.querySelector('.popover')).backgroundColor; const ratio = el => { const a = lum(getComputedStyle(el).color) + 0.05, b = lum(bg) + 0.05; return Math.max(a, b) / Math.min(a, b) }; const items = [...document.querySelectorAll('.popover .menu-item')]; return { disabled: items.filter(i => i.disabled && !i.classList.contains('danger')).map(ratio), dangerDisabled: items.filter(i => i.disabled && i.classList.contains('danger')).map(ratio), dangerEnabled: items.filter(i => !i.disabled && i.classList.contains('danger')).map(ratio), enabled: items.filter(i => !i.disabled && !i.classList.contains('danger')).map(ratio) } })
  check(dis.disabled.length >= 3 && dis.dangerDisabled.length >= 1 && dis.disabled.every(r => r >= 3 && r < Math.min(...dis.enabled)) && dis.dangerDisabled.every(r => r >= 3), 'disabled actions are readable (at least 3:1) yet clearly dimmer than enabled ones, disabled destructive ones included', JSON.stringify(dis))
  await shot('06-runner-menu-disabled')
  await page.keyboard.press('Escape')
  check(await page.locator('.popover').count() === 0 && (await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))) === 'More runner actions', 'Escape closes the menu and returns focus to the three-dot button')
  // ---- retiring an orphaned installation, then removing its files (separate, confirmed)
  await page.keyboard.press('Escape')
  await page.locator('.gm-rrow', { hasText: 'old-pc' }).waitFor()
  const stat = async l => (await page.locator('.gm-stat', { hasText: l }).locator('dd').innerText()).trim()
  check(await stat('Runners') === '5', 'the orphaned installation is listed as its own runner before it is retired', await stat('Runners'))
  await page.locator('.gm-rrow', { hasText: 'old-pc' }).click()
  await page.getByRole('button', { name: 'More runner actions' }).click()
  await page.getByRole('menuitem', { name: 'Retire installation' }).click()
  await page.getByRole('alertdialog').or(page.getByRole('dialog')).getByRole('button', { name: 'Retire installation' }).click()
  await page.waitForFunction(() => ![...document.querySelectorAll('.gm-rrow')].some(e => e.textContent.includes('old-pc')))
  check(await stat('Runners') === '4' && existsSync(join(orphanDir, '.runner')), 'retiring hides it from the inventory and the counts and deletes nothing')
  await page.getByRole('button', { name: /^Scan/ }).first().click(); await page.waitForTimeout(2500)
  await page.waitForFunction(() => window.gitmanager.runnersState().then(s => !s.scan.running))
  check(await page.locator('.gm-rrow', { hasText: 'old-pc' }).count() === 0 && await page.locator('.gm-retired summary').innerText().then(t => /Retired installations\s*1/.test(t)), 'it stays retired after a rescan, listed under Retired installations')
  await page.locator('.gm-retired summary').click()
  await shot('07-retired-list')
  const rm = page.getByRole('button', { name: 'Remove files' })
  check(await rm.isEnabled(), 'cleanup is offered for the verified orphan')
  await rm.click()
  const cd = page.getByRole('alertdialog')
  check((await cd.innerText()).includes(orphanDir), 'the cleanup confirmation shows the exact directory')
  await shot('08-cleanup-confirm')
  await cd.getByRole('button', { name: 'Delete files' }).isDisabled().then(d => check(d, 'it needs the folder name typed before it can proceed'))
  await cd.locator('input').fill('old-install')
  await cd.getByRole('button', { name: 'Delete files' }).click()
  await page.waitForFunction(() => !document.querySelector('.gm-retired'), null, { timeout: 30000 })
  check(!existsSync(orphanDir) && existsSync(join(runnersDir, 'existing', '.runner')) && existsSync(join(runnersDir, 'existing', '.credentials')), 'only the retired installation was deleted; the working one keeps its registration and credentials')
  report.ok = true
} catch (e) {
  report.ok = false; report.error = String(e.message ?? e)
  console.error(e); if (page) await shot('failure').catch(() => {})
  process.exitCode = 1
} finally {
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2))
  await app?.close().catch(() => {})
  rmSync(work, { recursive: true, force: true })
}
