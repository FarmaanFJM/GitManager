#!/usr/bin/env node
// Acceptance scenario for the Storage module, against the built app (npm run build first).
// GitHub is replaced by scripts/e2e/fake-gh.mjs, a stand-in for the GitHub CLI that serves a demonstration world and applies
// DELETE to it, so every destructive step runs for real in GitManager without touching a real repository.
// Usage: node scripts/e2e-storage.mjs   (Linux: under xvfb-run). Writes screenshots and a report to e2e-output/storage/.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import electronPath from 'electron'
import { _electron } from 'playwright'
import { storageWorld } from './e2e/storage-fixture.mjs'
import { runSummaChecks } from './summa-ui/checks.mjs'

const OUT = join(process.cwd(), 'e2e-output', 'storage')
rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true })
const work = mkdtempSync(join(tmpdir(), 'gm-e2e-storage-'))
const dataDir = join(work, 'data'), stateFile = join(work, 'world.json'), logFile = join(work, 'gh.log')
const world = storageWorld()
const save = () => writeFileSync(stateFile, JSON.stringify(world))
const load = () => JSON.parse(readFileSync(stateFile, 'utf8'))
save(); writeFileSync(logFile, '')
const report = { startedAt: new Date().toISOString(), steps: [], summaChecks: {} }
let n = 0
const log = (ok, name, detail = '') => { report.steps.push({ step: ++n, name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${String(n).padStart(2)} ${name}${detail ? `: ${detail}` : ''}`) }
const check = (cond, name, detail) => { log(!!cond, name, detail); if (!cond) throw new Error(`step failed: ${name}`) }
const fmt = b => { if (b < 1024) return `${b} B`; const u = ['KB', 'MB', 'GB', 'TB']; let v = b / 1024, i = 0; while (v >= 1024 && i < 3) { v /= 1024; i++ } return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}` }

let app, page
const env = { ...process.env, GITMANAGER_DATA_DIR: dataDir, GITMANAGER_HOME: join(work, 'home'), GITMANAGER_GH: join(process.cwd(), 'scripts', 'e2e', 'fake-gh.mjs'), FAKE_GH_STATE: stateFile, FAKE_GH_LOG: logFile, GITMANAGER_TEST_HOOKS: '1' }
async function launch() {
  app = await _electron.launch({ executablePath: electronPath, args: ['.', '--no-sandbox'], env })
  app.process().stderr.on('data', d => { const t = d.toString(); if (!/dbus|Debugger|debugging|Picked up|StatusNotifier|libappindicator/i.test(t)) process.stderr.write('[app] ' + t) })
  page = await app.firstWindow({ timeout: 30000 })
  page.on('pageerror', e => { console.log('[pageerror]', e.message); report.pageErrors = [...(report.pageErrors ?? []), e.message] })
  await app.evaluate(({ BrowserWindow, shell }) => { BrowserWindow.getAllWindows()[0].setSize(1320, 900); globalThis.__opened = []; shell.openExternal = async u => { globalThis.__opened.push(u) } })
  await page.waitForSelector('.gm-side')
}
const shot = async name => { await page.screenshot({ path: join(OUT, `${name}.png`) }) }
const summa = async name => { const r = await runSummaChecks(page); report.summaChecks[name] = r; const fails = r.findings.filter(f => f.status === 'fail'); console.log(`     Summa-UI checks on ${name}: ${fails.length} fail, ${r.findings.length - fails.length} needs-human`); return fails }
const ghLog = () => readFileSync(logFile, 'utf8').split('\n').filter(Boolean)
const deletes = () => ghLog().filter(l => l.startsWith('DELETE'))
const tab = name => page.getByRole('tab', { name: new RegExp(`^${name}`) }).click()
const text = sel => page.locator(sel).first().innerText()
/** Adds old successful builds to a repository of the demonstration world (while the app is running, as new uploads would). */
const addBuilds = (repo, name, days, mb) => {
  const w = load(); const r = w.repos.find(x => x.full === repo)
  days.forEach((d, i) => { const run = 7_000_000 + r.runs.length + i + Math.floor(Math.random() * 1e5); r.runs.push({ id: run, number: run % 1000, conclusion: 'success' }); r.artifacts.push({ id: run * 3, name, size: mb * 1024 * 1024, created: new Date(Date.now() - d * 86_400_000).toISOString(), run }) })
  writeFileSync(stateFile, JSON.stringify(w))
}
const ids = repo => load().repos.find(r => r.full === repo).artifacts.map(a => a.id)

try {
  await launch()
  await page.getByRole('button', { name: 'Storage' }).click()
  await page.waitForSelector('text=No scan yet')
  check(true, 'Storage is in the sidebar and starts without data: nothing is scanned until asked')
  check((await page.locator('.gm-top .btn-primary').first().innerText()).includes('Scan'), 'Scan is the primary action before the first scan')
  check(ghLog().length <= 1, 'opening Storage made no GitHub requests beyond the sign-in check', ghLog().join(', '))
  await shot('00-before-scan')

  // ---- scan and overview
  await page.getByRole('button', { name: 'Scan', exact: true }).click()
  await page.waitForSelector('.gm-stats', { timeout: 60000 })
  const writable = world.repos.filter(r => r.push !== false)
  const expectedRetained = writable.flatMap(r => r.artifacts).filter(a => !a.expired).reduce((s, a) => s + a.size, 0)
  const stat = async label => (await page.locator('.gm-stat', { hasText: label }).locator('dd').innerText()).trim()
  check(await stat('Retained artifacts') === fmt(expectedRetained), 'retained artifact storage equals the sum of non-expired artifact bytes', `${await stat('Retained artifacts')} vs ${fmt(expectedRetained)}`)
  check(await stat('Repositories') === '4', 'four writable repositories scanned; the read-only one is left out and said so')
  check((await page.locator('.gm-notes, .gm-section-empty').allInnerTexts()).join(' ').length > 0, 'limitations are visible')
  await page.getByRole('button', { name: 'Show' }).click()
  const lim = await page.locator('.gm-notes').first().innerText()
  check(/not scanned/.test(lim) && /without sizes/.test(lim), 'limitations explain skipped repositories and package sizes', lim.slice(0, 120))
  check(await page.locator('text=Billing this month').count() === 1 && await page.locator('text=GB-hours accrued').count() === 1, 'billing shows accrued GB-hours separately from stored bytes')
  check(await page.locator('text=not part of the artifact total').count() === 1, 'Actions caches are explained as a separate allowance')
  check(await page.locator('text=same pooled storage allowance').count() === 1, 'packages are listed without invented sizes')
  check(await page.locator('text=recalculate storage').count() >= 1, 'recalculation delay is explained')
  await shot('01-overview')
  const f1 = await summa('overview'); check(f1.length === 0, 'Summa-UI checks: overview has no failing finding', f1.map(f => `${f.checkId} ${f.target}`).join('; '))

  // ---- repositories
  await tab('Repositories')
  check(await page.getByRole('row').filter({ hasText: 'FarmaanFJM/' }).count() === 4, 'four repositories listed')
  await page.getByRole('button', { name: /^Repository/ }).click()
  check(/GitManager/.test(await page.getByRole('row').nth(1).innerText()), 'repository list sorts by name')
  await shot('02-repositories')
  await page.getByRole('row', { name: /Summa/ }).click()
  await page.waitForSelector('.gm-atable')
  const cls = async () => (await page.locator('.gm-arow').evaluateAll(rows => rows.map(r => r.querySelectorAll('[role=cell]')[6]?.textContent?.trim())))
  await page.getByRole('tab', { name: /^Delete candidate/ }).click()
  let c = await cls()
  check(c.length > 0 && c.every(x => x === 'Delete candidate'), 'the Delete candidate filter shows only candidates', `${c.length} rows`)
  await page.getByRole('tab', { name: /^Protected/ }).click()
  const prot = await page.locator('.gm-arow').allInnerTexts()
  check(prot.some(t => /security-audit-report/.test(t)) && prot.some(t => /release-qualification-evidence/.test(t)) && prot.some(t => /qualification-run-2026-09/.test(t)), 'audit and qualification evidence are Protected')
  await page.getByRole('tab', { name: /^Review/ }).click()
  check((await page.locator('.gm-arow').allInnerTexts()).some(t => /failed|failure/i.test(t)), 'a failed-run artifact is in Review, not offered for deletion')
  await page.getByRole('tab', { name: /^All/ }).click()
  await page.getByLabel('Search artifacts').fill('test-results')
  check(await page.locator('.gm-arow').count() === 5, 'search narrows the table', `${await page.locator('.gm-arow').count()} rows`)
  await page.getByLabel('Search artifacts').fill('')
  await page.getByRole('button', { name: /^Size/ }).click()
  const sizes = await page.locator('.gm-arow').evaluateAll(rows => rows.slice(0, 3).map(r => parseFloat(r.querySelectorAll('[role=cell]')[2].textContent)))
  check(sizes[0] >= sizes[1] && sizes[1] >= sizes[2], 'sorting by size works', sizes.join(' >= '))
  await page.locator('.gm-linkbtn').first().click()
  const opened = await app.evaluate(() => globalThis.__opened)
  check(opened.some(u => /^https:\/\/github\.com\/FarmaanFJM\/Summa\/actions\/runs\/\d+$/.test(u)), 'a workflow run opens on GitHub', opened.join(', '))
  await shot('03-repository-artifacts')
  const f2 = await summa('artifacts'); check(f2.length === 0, 'Summa-UI checks: artifact table has no failing finding', f2.map(f => `${f.checkId} ${f.target}`).join('; '))

  // pin one candidate
  await page.getByRole('tab', { name: /^Delete candidate/ }).click()
  const pinned = await page.locator('.gm-arow').first().locator('.gm-bname .truncate').innerText()
  await page.locator('.gm-arow').first().getByRole('button').last().click()
  await page.getByRole('menuitem', { name: /Pin/ }).click()
  await page.waitForTimeout(800)
  check(JSON.parse(readFileSync(join(dataDir, 'gitmanager.json'), 'utf8')).storage.pins.length === 1, 'pinning is stored locally')
  await page.getByRole('tab', { name: /^Protected/ }).click()
  check((await page.locator('.gm-arow').allInnerTexts()).some(t => /Pinned by you/.test(t)), 'a pinned artifact becomes Protected immediately', pinned)

  // ---- cleanup preview, dry run, deletion
  const before = Object.fromEntries(world.repos.map(r => [r.full, ids(r.full)]))
  await page.locator('.gm-top').getByRole('button', { name: 'Review cleanup' }).click()
  await page.waitForSelector('.gm-cleanup')
  const sum = await text('.gm-cleanup-sum')
  const count = Number(/(\d+) artifacts/.exec(sum)[1])
  check(count > 10 && /recovers/.test(sum), 'the preview states how many artifacts and how much space', sum)
  check(await page.locator('.gm-cgroup').count() === 4, 'candidates are grouped by repository (four repositories affected)')
  check(await page.getByRole('button', { name: /^Delete \d+ artifacts permanently/ }).count() === 1 && /permanent/.test((await page.locator('.gm-cleanup .gm-hint').allInnerTexts()).join(' ')), 'permanence is stated once, on the button and above the list')
  check(await page.locator('text=Review:').count() === 1, 'ambiguous artifacts are listed apart and not selected')
  check(await page.getByRole('button', { name: /Failed or cancelled output, superseded: \d+ artifacts?.*none selected/ }).count() === 1, 'superseded failed output has its own group, with nothing selected')
  await page.getByRole('button', { name: /Failed or cancelled output, superseded/ }).click()
  const selBefore = Number(/(\d+) artifacts/.exec(await text('.gm-cleanup-sum'))[1])
  await page.getByRole('checkbox', { name: 'Select all superseded failed output' }).click()
  const withFailed = Number(/(\d+) artifacts/.exec(await text('.gm-cleanup-sum'))[1])
  check(withFailed > selBefore, 'a deliberate bulk choice adds the superseded failed output to the selection', `${selBefore} -> ${withFailed}`)
  await page.getByRole('checkbox', { name: 'Select all superseded failed output' }).click()
  check(Number(/(\d+) artifacts/.exec(await text('.gm-cleanup-sum'))[1]) === selBefore, 'and can be withdrawn again')
  await page.getByRole('button', { name: /^Excluded/ }).click()
  check((await page.locator('.gm-cleanup-extra .gm-notes').last().innerText()).includes('Protected') === false && /\(/.test(await page.locator('.gm-cleanup-extra .gm-notes').last().innerText()), 'excluded artifacts are listed with their reasons')
  await shot('04-cleanup-preview')
  const f3 = await summa('cleanup-dialog'); check(f3.length === 0, 'Summa-UI checks: cleanup preview has no failing finding', f3.map(f => `${f.checkId} ${f.target}`).join('; '))
  // the Summa-UI focus walk ends with Escape, which closes the dialog; open it again
  await page.locator('.gm-top').getByRole('button', { name: 'Review cleanup' }).click()
  await page.waitForSelector('.gm-cleanup')
  // individual selection: drop the first artifact
  await page.getByRole('checkbox', { name: /^Delete / }).first().click()
  const after1 = Number(/(\d+) artifacts/.exec(await text('.gm-cleanup-sum'))[1])
  check(after1 === count - 1, 'individual selection changes the total', `${count} -> ${after1}`)
  await page.getByRole('button', { name: 'Check without deleting' }).click()
  await page.waitForSelector('text=Nothing was changed')
  check(deletes().length === 0, 'a dry run revalidates but sends no DELETE')
  await shot('05-dry-run')
  await page.getByRole('button', { name: 'Close' }).click()

  await page.locator('.gm-top').getByRole('button', { name: 'Review cleanup' }).click()
  await page.waitForSelector('.gm-cleanup')
  await page.getByRole('checkbox', { name: /^Delete / }).first().click() // keep the same one out
  const finalCount = Number(/(\d+) artifacts/.exec(await text('.gm-cleanup-sum'))[1])
  await page.getByRole('button', { name: /^Delete \d+ artifacts permanently/ }).click()
  await page.waitForSelector('text=GitHub confirmed', { timeout: 120000 })
  const done = await text('.gm-cleanup-sum')
  const confirmed = Number(/confirmed (\d+) artifacts/.exec(done)[1])
  check(confirmed === finalCount, 'GitHub-confirmed deletions equal the selection', done)
  const gone = Object.fromEntries(world.repos.map(r => [r.full, before[r.full].filter(i => !ids(r.full).includes(i))]))
  check(Object.values(gone).flat().length === confirmed, 'exactly the confirmed artifacts are gone from GitHub', `${Object.values(gone).flat().length}`)
  const now = load()
  const names = repo => now.repos.find(r => r.full === repo).artifacts.map(a => a.name)
  check(names('FarmaanFJM/Summa').filter(x => x === 'security-audit-report').length === 4 && names('FarmaanFJM/Summa').includes('qualification-run-2026-09'), 'protected evidence was not touched')
  check(now.repos[0].artifacts.some(a => a.run && now.repos[0].runs.find(r => r.id === a.run)?.branch === 'v0.1.0'), 'the current release build was not touched')
  check(names('FarmaanFJM/Markdown-Studio').filter(x => x === 'markdown-studio-setup-win').length >= 2 && names('FarmaanFJM/Markdown-Studio').filter(x => x === 'markdown-studio-macos-dmg').length >= 2, 'the newest two installers per platform remain')
  check(await page.locator('text=recalculate storage').count() >= 1, 'the result explains GitHub recalculation delay')
  await shot('06-cleanup-result')
  await page.getByRole('button', { name: 'Close' }).click()
  await page.waitForTimeout(1500)
  await tab('Activity')
  const audit = readFileSync(join(dataDir, 'storage-audit.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  check(audit.filter(e => e.type === 'attempt').length >= confirmed && audit.filter(e => e.outcome === 'deleted').length === confirmed, 'the audit log holds an attempt and a confirmed result for every deletion', `${audit.length} entries`)
  check(audit.every(e => e.artifactId && e.name && e.repo && e.hash), 'audit entries carry artifact id, name, repository and hash')
  check(!/(token|authorization|bearer)/i.test(JSON.stringify(audit)), 'no credential appears in the audit log')
  await shot('07-activity')
  await tab('Overview')
  check(await stat('Retained artifacts') !== fmt(expectedRetained), 'the overview was refreshed from GitHub after the cleanup', await stat('Retained artifacts'))
  const f4 = await summa('activity'); check(f4.length === 0, 'Summa-UI checks: activity tab has no failing finding', f4.map(f => `${f.checkId} ${f.target}`).join('; '))

  // ---- auto cleanup
  await tab('Auto Cleanup')
  check(await page.getByRole('switch', { name: 'Scan on a schedule' }).getAttribute('aria-checked') === 'false', 'Auto Cleanup is off by default')
  check(await page.locator('text=only while GitManager is running').count() === 1 && await page.locator('text=Not scheduled').count() === 1, 'the schedule states it runs only while the app runs, and shows nothing is scheduled')
  await shot('08-auto-cleanup')
  const f5 = await summa('auto'); check(f5.length === 0, 'Summa-UI checks: Auto Cleanup has no failing finding', f5.map(f => `${f.checkId} ${f.target}`).join('; '))
  const hercBefore = ids('FarmaanFJM/Herc-s-Adventure').length
  const before2 = Object.fromEntries(load().repos.map(r => [r.full, r.artifacts.length]))
  await page.locator('.gm-root-row', { hasText: 'Herc-s-Adventure' }).getByRole('button', { name: 'Edit' }).click()
  await page.getByRole('button', { name: 'Preset' }).click()
  await page.getByRole('option', { name: /Herc/ }).click()
  await page.getByRole('button', { name: 'Mode' }).click()
  await page.getByRole('option', { name: 'Automatic safe cleanup' }).click()
  check(await page.getByRole('button', { name: 'Save policy' }).isDisabled(), 'automatic safe cleanup cannot be saved without an explicit approval')
  await shot('09-policy')
  await page.getByRole('checkbox', { name: /I approve automatic deletion/ }).click()
  await page.getByRole('button', { name: 'Save policy' }).click()
  await page.waitForTimeout(1200)
  check(await page.locator('.gm-root-row', { hasText: 'Herc-s-Adventure' }).locator('text=Automatic safe cleanup').count() === 1, 'the approved policy is active for that repository only')
  check(await page.locator('.gm-root-row', { hasText: 'Summa' }).locator('text=Manual').count() === 1, 'other repositories stay Manual')
  addBuilds('FarmaanFJM/Herc-s-Adventure', 'herc-windows-private-build', [100, 110, 120, 130], 60)
  const deletesBefore = deletes().length
  await page.getByRole('button', { name: 'Run now' }).click()
  await page.waitForSelector('text=suggestions waiting', { timeout: 120000 })
  await page.waitForTimeout(1500)
  const newDeletes = deletes().slice(deletesBefore)
  check(newDeletes.length >= 4 && newDeletes.every(d => /Herc-s-Adventure/.test(d)), 'a scheduled-style run deletes the superseded builds only in the approved repository', `${newDeletes.length} deletions`)
  check(load().repos.filter(r => r.full !== 'FarmaanFJM/Herc-s-Adventure').every(r => r.artifacts.length === before2[r.full]), 'repositories in Manual or recommendation mode were not touched', 'unchanged counts')
  check(ids('FarmaanFJM/Herc-s-Adventure').length < hercBefore && load().repos.find(r => r.full === 'FarmaanFJM/Herc-s-Adventure').artifacts.filter(a => a.name === 'herc-windows-private-build').length >= 2, 'the newest two Herc builds are preserved')
  check(await page.locator('text=Last completed cleanup').count() === 1 && !/None yet/.test(await page.locator('.gm-kv-tight').innerText()), 'the last completed cleanup is shown')
  await shot('10-auto-after-run')

  // ---- settings persist across a restart
  await app.close()
  await launch()
  await page.getByRole('button', { name: 'Storage' }).click()
  await page.waitForSelector('.gm-stats')
  check(await page.locator('.gm-stats').count() === 1, 'the last scan is shown after a restart without a new request')
  await tab('Auto Cleanup')
  check(await page.locator('.gm-root-row', { hasText: 'Herc-s-Adventure' }).locator('text=Automatic safe cleanup').count() === 1, 'the policy persisted across a restart')
  check(await page.getByRole('switch', { name: 'Scan on a schedule' }).getAttribute('aria-checked') === 'false', 'the schedule is still off after a restart')

  // ---- authentication problems are explained
  Object.assign(world, load()); world.auth = 'none'; save()
  await page.getByRole('button', { name: 'Scan again' }).click()
  await page.waitForSelector('text=GitHub CLI is not signed in')
  check(await page.locator('text=never asks for a token').count() === 1, 'missing sign-in is explained without asking for a token')
  await shot('11-not-signed-in')
  addBuilds('FarmaanFJM/GitManager', 'GitManager-windows-x64', [70, 80, 90], 90)
  Object.assign(world, load()); world.auth = undefined; world.scopes = 'read:org'; save()
  await page.getByRole('button', { name: 'Check again' }).click()
  await page.waitForSelector('text=Read-only')
  check(true, 'insufficient scope is reported as read-only with the command to fix it')
  const readOnlyDeletes = deletes().length
  await page.getByRole('button', { name: 'Scan again' }).click()
  await tab('Overview')
  await page.waitForSelector('.gm-stats')
  await page.waitForFunction(() => !document.querySelector('.gm-top [aria-busy="true"]'))
  await page.locator('.gm-top').getByRole('button', { name: 'Review cleanup' }).click()
  const dlg = page.getByRole('dialog')
  await dlg.waitFor()
  check(await dlg.locator('text=cannot delete artifacts').count() >= 1, 'the preview warns when the sign-in cannot delete')
  await dlg.getByRole('button', { name: /^Delete \d+ artifacts permanently/ }).click()
  await page.waitForSelector('text=cannot delete artifacts')
  check(deletes().length === readOnlyDeletes, 'without delete permission nothing is deleted')
  await shot('12-read-only')

  report.ok = true
} catch (e) {
  report.ok = false; report.error = String(e)
  console.error(e)
  await page?.screenshot({ path: join(OUT, 'failure.png') }).catch(() => {})
} finally {
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2))
  try { await Promise.race([app?.close(), new Promise(r => setTimeout(r, 15000))]) } catch { /* ignore */ }
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true })
  console.log(`\n${report.steps.filter(s => s.ok).length}/${report.steps.length} steps passed; report in ${OUT}`)
  process.exit(report.ok ? 0 : 1)
}
