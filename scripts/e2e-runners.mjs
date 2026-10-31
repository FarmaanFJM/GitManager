#!/usr/bin/env node
// Acceptance scenario for the Runners tool, against the built app (npm run build first). GitHub is scripts/e2e/fake-gh.mjs
// (a stand-in for the GitHub CLI), the runner package is a stand-in whose config.sh registers with that world, so the whole
// path (discovery, reconciliation, wizard, install, verification, unregister, uninstall) runs for real inside GitManager
// without github.com, a real runner or a real repository. Linux only (the service steps need systemd and are unit-tested).
// Usage: node scripts/e2e-runners.mjs   (Linux: under xvfb-run). Writes screenshots and a report to e2e-output/runners/.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import electronPath from 'electron'
import { _electron } from 'playwright'
import { buildExistingInstall, buildPackage, runnersWorld, INSTALLED_VERSION, PACKAGE_VERSION } from './e2e/runners-fixture.mjs'
import { runSummaChecks } from './summa-ui/checks.mjs'

const OUT = join(process.cwd(), 'e2e-output', 'runners')
rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true })
// The work folder lives beside the output, not in /tmp: GitManager refuses /tmp as an installation directory (as it should).
mkdirSync(join(process.cwd(), 'e2e-output'), { recursive: true })
const work = mkdtempSync(join(process.cwd(), 'e2e-output', 'runners-work-'))
const dataDir = join(work, 'data'), stateFile = join(work, 'world.json'), logFile = join(work, 'gh.log')
const runnersDir = join(work, 'runners')
const existing = buildExistingInstall(join(runnersDir, 'existing'))
const pkg = buildPackage(work)
const world = runnersWorld()
world.runnerPackage.sha256['linux-x64'] = pkg.sha256
const save = () => writeFileSync(stateFile, JSON.stringify(world))
const load = () => JSON.parse(readFileSync(stateFile, 'utf8'))
save(); writeFileSync(logFile, '')
const report = { startedAt: new Date().toISOString(), steps: [], summaChecks: {}, notTested: ['Windows service control (sc.exe), launchd, systemd service installation and WSL distributions: no such host in this environment; covered by unit tests with fakes.'] }
let n = 0
const log = (ok, name, detail = '') => { report.steps.push({ step: ++n, name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${String(n).padStart(2)} ${name}${detail ? `: ${detail}` : ''}`) }
const check = (cond, name, detail) => { log(!!cond, name, detail); if (!cond) throw new Error(`step failed: ${name}`) }

let app, page
const env = { ...process.env, GITMANAGER_DATA_DIR: dataDir, GITMANAGER_HOME: join(work, 'home'), GITMANAGER_GH: join(process.cwd(), 'scripts', 'e2e', 'fake-gh.mjs'), FAKE_GH_STATE: stateFile, FAKE_GH_LOG: logFile, GITMANAGER_RUNNER_PACKAGE_DIR: pkg.dir, GITMANAGER_TEST_HOOKS: '1' }
async function launch() {
  app = await _electron.launch({ executablePath: electronPath, args: ['.', '--no-sandbox'], env })
  app.process().stderr.on('data', d => { const t = d.toString(); if (!/dbus|Debugger|debugging|Picked up|StatusNotifier|libappindicator|DevTools/i.test(t)) process.stderr.write('[app] ' + t) })
  page = await app.firstWindow({ timeout: 30000 })
  page.on('pageerror', e => { console.log('[pageerror]', e.message); report.pageErrors = [...(report.pageErrors ?? []), e.message] })
  await app.evaluate(({ BrowserWindow, shell }) => { BrowserWindow.getAllWindows()[0].setSize(1320, 900); globalThis.__opened = []; shell.openExternal = async u => { globalThis.__opened.push(u) } })
  await page.waitForSelector('.gm-side')
}
const shot = async name => { await page.screenshot({ path: join(OUT, `${name}.png`) }) }
const summa = async name => { const r = await runSummaChecks(page); report.summaChecks[name] = r; const fails = r.findings.filter(f => f.status === 'fail'); console.log(`     Summa-UI checks on ${name}: ${fails.length} fail, ${r.findings.length - fails.length} needs-human`); return fails }
const ghLog = () => readFileSync(logFile, 'utf8').split('\n').filter(Boolean)
/** The manager's state as the page sees it (window.gitmanager is the preload bridge). */
const runnersState = () => page.evaluate(() => window.gitmanager.runnersState())
/** Polls the manager's state from here: an async predicate handed to waitForFunction would be read as a truthy promise. */
async function waitState(pred, what, ms = 120000) {
  const end = Date.now() + ms
  while (Date.now() < end) { const st = await runnersState(); if (pred(st)) return st; await page.waitForTimeout(250) }
  throw new Error(`timed out waiting for ${what}`)
}
/** Clicks Scan and waits for that scan to finish, judged by the manager's own state rather than by the button, which could be read before the scan had started. */
async function scanAll() {
  const before = (await runnersState()).inventory.githubScannedAt
  await page.getByRole('button', { name: /^Scan/ }).first().click()
  await waitState(s => !s.scan.running && s.inventory.githubScannedAt !== null && s.inventory.githubScannedAt !== before, 'the scan to read GitHub')
}
const stat = async label => (await page.locator('.gm-stat', { hasText: label }).locator('dd').innerText()).trim()
const rowNames = () => page.locator('.gm-rrow .gm-rname .truncate').allInnerTexts()
const tab = name => page.getByRole('tab', { name: new RegExp(`^${name}`) }).click()
const menuOf = name => page.getByRole('button', { name: `Actions for ${name}` })

try {
  await launch()
  // ---- navigation
  await page.getByRole('button', { name: 'Tools' }).click()
  await page.waitForSelector('.gm-tools')
  check(await page.locator('.gm-tool', { hasText: 'Runners' }).count() === 1, 'Tools is a top-level entry with a minimal landing page listing Runners')
  await shot('00-tools')
  await page.locator('.gm-tool', { hasText: 'Runners' }).click()
  await page.waitForSelector('.gm-rstats')
  await waitState(s => !s.scan.running && s.inventory.localScannedAt !== null, 'the startup scan')
  check(!(await rowNames()).includes('build-box') && !(await page.locator('.gm-rrow').count() || (await page.locator('.sm-empty__text').innerText()).includes('Scan')), 'the startup scan read only the common folders, so the fixture installation is not listed yet', (await rowNames()).join(', '))
  check(await page.locator('text=GitHub has not been read yet').count() === 1, 'it says GitHub was not read yet instead of showing zero online runners as a fact')
  check(ghLog().filter(l => !l.startsWith('GET /user')).length === 0, 'opening the tool made no GitHub request beyond the sign-in check', ghLog().join(', '))
  await shot('01-empty')

  // ---- discovery configuration: an extra folder
  await tab('Discovery')
  await page.getByLabel('Folder to inspect').fill(runnersDir)
  await page.getByRole('button', { name: 'Add folder' }).click()
  await page.waitForSelector(`.gm-root-row:has-text("${runnersDir}")`)
  check(JSON.parse(readFileSync(join(dataDir, 'gitmanager.json'), 'utf8')).runners.settings.roots.length === 1, 'a discovery folder is stored in the configuration file')
  check(await page.locator('text=No host aliases').count() === 1 || await page.locator('.gm-root-row .switch').count() >= 0, 'SSH hosts come from the SSH configuration and are off until allowed')
  await shot('02-discovery-settings')

  // ---- full scan
  await scanAll()
  await tab('Runners')
  await page.waitForSelector('.gm-rrow')
  const names = await rowNames()
  check(names.sort().join() === ['build-box', 'busy-box', 'org-gpu-1', 'win-laptop'].join(), 'the inventory lists local, GitHub-only and organization runners once each', names.join(', '))
  check(await stat('Runners') === '4' && await stat('Online') === '3' && await stat('Offline') === '1' && await stat('Busy') === '1', 'summary statistics follow GitHub state', `${await stat('Runners')} ${await stat('Online')} ${await stat('Offline')} ${await stat('Busy')}`)
  check(await stat('Manageable here') === '1' && await stat('Monitoring only') === '3', 'manageable and monitoring-only counts tell local from remote', `${await stat('Manageable here')} ${await stat('Monitoring only')}`)
  const row = page.locator('.gm-rrow', { hasText: 'build-box' })
  check(/Online/.test(await row.innerText()) && /Linux/.test(await row.innerText()) && /Native/.test(await row.innerText()) && (await row.innerText()).includes(existing), 'the local runner row shows status, platform, environment and the real installation path')
  check(/Not inspected/.test(await page.locator('.gm-rrow', { hasText: 'win-laptop' }).innerText()), 'a runner only GitHub knows is marked as not inspected, without an invented path or machine')
  check((await page.locator('.gm-limits').innerText()).includes('Summa'), 'the scope that could not be read is reported as a limitation', await page.locator('.gm-limits').innerText())
  await shot('03-inventory')
  const f1 = await summa('inventory'); check(f1.length === 0, 'Summa-UI checks: inventory has no failing finding', f1.map(f => `${f.checkId} ${f.target}`).join('; '))

  // ---- search, filter, sort
  await page.getByLabel('Search runners').fill('win')
  check((await rowNames()).join() === 'win-laptop', 'search narrows by name')
  await page.getByLabel('Search runners').fill('a100')
  check((await rowNames()).join() === 'org-gpu-1', 'search also matches custom labels')
  await page.getByLabel('Search runners').fill('')
  await page.getByRole('tab', { name: /^GitHub only/ }).click()
  check((await rowNames()).sort().join() === 'busy-box,org-gpu-1,win-laptop', 'the GitHub only filter keeps the runners not installed here')
  await page.getByRole('tab', { name: /^All/ }).click()
  await page.getByRole('button', { name: /^Status/ }).click()
  check((await rowNames())[0] === 'busy-box', 'sorting by status puts the busy runner first', (await rowNames()).join(','))
  await page.getByRole('button', { name: /^Runner/ }).first().click()

  // ---- details
  await row.click()
  await page.waitForSelector('.gm-rdetail')
  const detail = page.locator('.gm-rdetail')
  check((await detail.innerText()).includes('42') && (await detail.innerText()).includes(INSTALLED_VERSION), 'details show the GitHub id and the installed version')
  check(await detail.locator('.tag', { hasText: 'gpu' }).count() === 1 && await detail.locator('.tag', { hasText: 'self-hosted' }).count() === 1, 'default and custom labels are listed')
  check((await detail.locator('.gm-runs-on').innerText()) === 'runs-on: [self-hosted, Linux, X64, gpu]', 'the runs-on example uses the labels GitHub confirmed', await detail.locator('.gm-runs-on').innerText())
  check((await detail.innerText()).includes(`${PACKAGE_VERSION} is the latest release`), 'an available update is reported without pretending the runner was updated')
  await detail.getByRole('button', { name: 'Read' }).click()
  await page.waitForSelector('.gm-diag')
  check((await detail.locator('.gm-diag').innerText()).includes('Runner_20261030'), 'diagnostic logs are read from _diag')
  await shot('04-detail')
  const f2 = await summa('detail'); check(f2.length === 0, 'Summa-UI checks: details have no failing finding', f2.map(f => `${f.checkId} ${f.target}`).join('; '))
  await detail.getByRole('button', { name: 'More runner actions' }).click()
  await page.getByRole('menuitem', { name: 'Runner settings on GitHub' }).click()
  const opened = await app.evaluate(() => globalThis.__opened)
  check(opened.includes('https://github.com/FarmaanFJM/GitManager/settings/actions/runners/42'), 'the GitHub runner settings page opens for the right runner', opened.join(', '))

  // ---- workflows
  await tab('Workflows')
  await page.getByRole('button', { name: 'Repository' }).click()
  await page.getByRole('option', { name: 'FarmaanFJM/GitManager' }).click()
  await page.waitForSelector('.gm-wf-job')
  const jobs = await page.locator('.gm-wf-job').allInnerTexts()
  check(jobs.some(j => /build/.test(j) && /build-box/.test(j)), 'a job asking for self-hosted, linux, gpu is matched to build-box', jobs.join(' | '))
  check(jobs.some(j => /package/.test(j) && /GitHub-hosted/.test(j)), 'a GitHub-hosted job is not matched to a self-hosted runner')
  check(jobs.some(j => /windows-tests/.test(j) && /No known runner/.test(j)), 'a job whose labels no runner carries is reported')
  check(await page.locator('text=do not by themselves authorize').count() === 1, 'the report says matching labels do not grant access')
  await shot('05-workflows')

  // ---- wizard
  await tab('Runners')
  await page.getByRole('button', { name: 'Add runner' }).first().click()
  const dlg = page.getByRole('dialog')
  await dlg.waitFor()
  check(await dlg.getByRole('button', { name: /^Linux/ }).count() === 1 && await dlg.getByRole('button', { name: /^Windows/ }).count() === 0, 'only platforms this host can install are offered')
  await dlg.getByRole('button', { name: /^Linux/ }).click()
  await dlg.getByRole('button', { name: 'Next' }).click()
  await dlg.getByRole('button', { name: /Native Linux/ }).click()
  await page.waitForSelector('.gm-probe')
  check((await dlg.locator('.gm-probe').innerText()).includes('x64'), 'the environment step probes the machine and shows its architecture')
  await shot('06-wizard-environment')
  await dlg.getByRole('button', { name: 'Next' }).click()
  await dlg.getByRole('button', { name: 'Repository', exact: true }).click()
  await page.getByRole('option', { name: 'FarmaanFJM/GitManager' }).click()
  await shot('07-wizard-scope')
  await dlg.getByRole('button', { name: 'Next' }).click()
  await dlg.getByLabel('Runner name').fill('e2e-runner')
  // first the directory of the existing installation: a blocker on any host (existing installations are never overwritten)
  await dlg.getByLabel('Installation directory').fill(existing)
  await dlg.getByLabel('Custom labels').fill('docker, e2e')
  if (await dlg.getByLabel('Service user').count()) await dlg.getByLabel('Service user').fill('runner')
  // the service stays off in both environments: the stand-in svc.sh has no systemd to talk to, and a real unit must not be installed on a shared machine
  await dlg.getByRole('switch', { name: 'Install as a service' }).click()
  await dlg.getByRole('button', { name: 'Review plan' }).click()
  await page.waitForSelector('.gm-plan')
  check((await dlg.locator('.gm-plan').innerText()).includes('already holds a runner installation'), 'the plan blocks a directory that already holds an installation and says so')
  check(await dlg.getByRole('button', { name: 'Install runner' }).isDisabled(), 'a blocked plan cannot be installed')
  await shot('08-plan-blocked')
  await dlg.getByRole('button', { name: 'Back' }).click()
  await dlg.getByLabel('Installation directory').fill(join(runnersDir, 'e2e-runner'))
  await dlg.getByRole('button', { name: 'Review plan' }).click()
  await page.waitForSelector('.gm-plan')
  const planText = await dlg.locator('.gm-plan').innerText()
  check(planText.includes('--token <registration token>') && !/A[A-Z2-7]{28}/.test(planText), 'the plan shows the exact commands with a placeholder for the token')
  check(planText.includes(pkg.filename) && planText.includes('SHA-256'), 'the plan names the package and its checksum source')
  check(ghLog().filter(l => l.startsWith('POST')).length === 0, 'planning requested no token')
  check(await dlg.getByRole('button', { name: 'Install runner' }).isDisabled(), 'the install button waits for the explicit acknowledgement')
  await shot('09-plan')
  const f3 = await summa('wizard-plan'); check(f3.length === 0, 'Summa-UI checks: plan dialog has no failing finding', f3.map(f => `${f.checkId} ${f.target}`).join('; '))
  // the focus walk ended with Escape and closed the dialog; the plan is kept in the main process for 30 minutes, so open it again
  if (!(await dlg.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: 'Add runner' }).first().click(); await dlg.waitFor()
    await dlg.getByRole('button', { name: /^Linux/ }).click(); await dlg.getByRole('button', { name: 'Next' }).click(); await dlg.getByRole('button', { name: /Native Linux/ }).click(); await page.waitForSelector('.gm-probe'); await dlg.getByRole('button', { name: 'Next' }).click()
    await dlg.getByRole('button', { name: 'Repository', exact: true }).click(); await page.getByRole('option', { name: 'FarmaanFJM/GitManager' }).click(); await dlg.getByRole('button', { name: 'Next' }).click()
    await dlg.getByLabel('Runner name').fill('e2e-runner'); await dlg.getByLabel('Installation directory').fill(join(runnersDir, 'e2e-runner')); await dlg.getByLabel('Custom labels').fill('docker, e2e')
    if (await dlg.getByLabel('Service user').count()) await dlg.getByLabel('Service user').fill('runner')
    await dlg.getByRole('switch', { name: 'Install as a service' }).click(); await dlg.getByRole('button', { name: 'Review plan' }).click(); await page.waitForSelector('.gm-plan')
  }
  await dlg.getByRole('checkbox', { name: 'I reviewed the plan' }).click()
  await dlg.getByRole('button', { name: 'Install runner' }).click()
  await page.waitForSelector('.gm-install-steps')
  await page.waitForFunction(() => document.querySelector('.gm-istep.running') === null && document.querySelectorAll('.gm-istep.done, .gm-istep.skipped, .gm-istep.failed').length >= 11, null, { timeout: 120000 })
  const steps = await dlg.locator('.gm-istep').evaluateAll(els => els.map(e => `${e.textContent.trim().split(' ').slice(0, 2).join(' ')}:${e.className.replace('gm-istep ', '')}`))
  check(steps.filter(s => s.endsWith(':failed')).length === 0, 'every installation step completed or was skipped as requested', steps.join(', '))
  check(steps.some(s => /Installing service.*skipped/.test(s)) && steps.some(s => /Starting service.*skipped/.test(s)), 'the service steps are skipped visibly, not reported as done')
  const w = load()
  const added = w.repos.find(r => r.full === 'FarmaanFJM/GitManager').runners.find(r => r.name === 'e2e-runner')
  check(!!added && added.labels.join() === 'docker,e2e', 'the runner was registered with GitHub through a registration token with the chosen labels', JSON.stringify(added))
  check(existsSync(join(runnersDir, 'e2e-runner', '.runner')) && existsSync(join(runnersDir, 'e2e-runner', 'bin', 'Runner.Listener')), 'the package was extracted and configured in its own directory')
  const outputText = await dlg.locator('.gm-diag-text').evaluate(e => e.textContent ?? '')
  check(/SHA-256 verified/.test(outputText) && /--token \[redacted\]/.test(outputText) && !/A[A-Z2-7]{28}/.test(outputText), 'the output shows the checksum verification and never the token')
  check(w.tokens.length === 0, 'the registration token was consumed and is not stored anywhere', JSON.stringify(Object.keys(w)))
  check(!/A[A-Z2-7]{28}/.test(readFileSync(join(dataDir, 'runners-state.json'), 'utf8')) && !/A[A-Z2-7]{28}/.test(readFileSync(join(dataDir, 'gitmanager.json'), 'utf8')), 'no token in the persisted state or configuration')
  await shot('10-installed')
  await dlg.getByRole('button', { name: 'Show runner' }).click()
  await page.waitForSelector('.gm-rdetail:has-text("e2e-runner")')
  // the scope is re-read from GitHub right after the job; wait for that refresh rather than racing it
  await page.waitForFunction(() => /Registration\s+from GitHub/.test(document.querySelector('.gm-rdetail')?.textContent ?? ''), null, { timeout: 30000 })
  const detailText = await page.locator('.gm-rdetail').innerText()
  check(/e2e-runner/.test(detailText) && /Online/.test(detailText) && /GitHub id\s+101/.test(detailText), 'the new runner opens with GitHub\'s state and its registration read back from GitHub', detailText.split('\n').slice(0, 4).join(' | '))
  check(await stat('Runners') === '5', 'the inventory refreshed without a manual scan')
  await page.locator('.gm-rdetail').getByRole('button', { name: /Close details|^Runners$/ }).first().click()
  await page.waitForSelector('.gm-rrow:has-text("e2e-runner")')
  check(/Online/.test(await page.locator('.gm-rrow', { hasText: 'e2e-runner' }).innerText()), 'the table lists the new runner as online')

  // ---- narrow window
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(940, 760))
  await page.waitForTimeout(500)
  await page.locator('.gm-rrow', { hasText: 'e2e-runner' }).click()
  await page.waitForSelector('.gm-rdetail')
  check(await page.locator('.gm-rdetail.stacked').count() === 1, 'at a narrow width the details replace the table with a back control')
  await shot('11-narrow-detail')
  await page.locator('.gm-rdetail').getByRole('button', { name: 'Runners' }).click()
  await page.waitForTimeout(300)
  check(await page.locator('.gm-rrow').first().isVisible() && await page.locator('.gm-bhead').first().evaluate(e => getComputedStyle(e).display) === 'none', 'the narrow table uses two-line rows without a header', '')
  await shot('12-narrow-table')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1320, 900))
  await page.waitForTimeout(400)

  // ---- lifecycle: a busy runner is protected, a GitHub-only runner has no local controls
  await menuOf('busy-box').click()
  check(await page.getByRole('menuitem', { name: 'Start', exact: true }).isDisabled() && await page.getByRole('menuitem', { name: 'Stop', exact: true }).isDisabled(), 'a runner on another machine has no start or stop')
  await page.keyboard.press('Escape')
  await menuOf('win-laptop').click()
  await page.getByRole('menuitem', { name: 'Remove registration' }).click()
  const confirm = page.getByRole('alertdialog')
  await confirm.waitFor()
  check((await confirm.innerText()).includes('machine that runs it is not touched'), 'removing a GitHub-only runner explains that its machine is untouched')
  await confirm.getByRole('button', { name: 'Remove registration' }).click()
  await page.getByRole('dialog', { name: 'Done' }).waitFor()
  check(!load().repos[0].runners.some(r => r.name === 'win-laptop'), 'the registration was removed on GitHub through the API')
  check(ghLog().filter(l => l.startsWith('DELETE')).join() === 'DELETE /repos/FarmaanFJM/GitManager/actions/runners/43', 'exactly one DELETE was sent, for that runner id', ghLog().filter(l => l.startsWith('DELETE')).join(', '))
  await page.getByRole('dialog', { name: 'Done' }).getByRole('button', { name: 'Close' }).click()
  await page.waitForFunction(() => ![...document.querySelectorAll('.gm-rrow')].some(r => (r.textContent ?? '').includes('win-laptop')), null, { timeout: 20000 })

  // ---- unregister then uninstall the installed runner
  await menuOf('e2e-runner').click()
  await page.getByRole('menuitem', { name: 'Remove registration' }).click()
  await confirm.waitFor()
  check((await confirm.innerText()).includes(join(runnersDir, 'e2e-runner')), 'the confirmation names the directory whose files stay')
  await confirm.getByRole('button', { name: 'Remove registration' }).click()
  await page.getByRole('dialog', { name: 'Done' }).waitFor()
  check(!existsSync(join(runnersDir, 'e2e-runner', '.runner')) && existsSync(join(runnersDir, 'e2e-runner', 'bin', 'Runner.Listener')), 'the runner removed itself with a removal token; its files remain')
  check(!load().repos[0].runners.some(r => r.name === 'e2e-runner'), 'GitHub no longer lists it')
  await shot('13-unregistered')
  await page.getByRole('dialog', { name: 'Done' }).getByRole('button', { name: 'Close' }).click()
  await page.waitForTimeout(800)
  const partial = page.locator('.gm-rrow', { hasText: 'e2e-runner' })
  check(await partial.count() === 1 && await partial.locator('.gm-warn').count() === 1, 'the leftover installation stays listed and flagged')
  await menuOf('e2e-runner').click()
  await page.getByRole('menuitem', { name: 'Uninstall' }).click()
  await confirm.waitFor()
  check((await confirm.innerText()).includes(`Deletes exactly this directory and everything in it: ${join(runnersDir, 'e2e-runner')}`), 'uninstall shows the exact directory before deleting')
  await shot('14-uninstall-confirm')
  await confirm.getByRole('button', { name: 'Delete files' }).click()
  await page.getByRole('dialog', { name: 'Done' }).waitFor()
  check(!existsSync(join(runnersDir, 'e2e-runner')) && existsSync(existing), 'only that directory was deleted')
  await page.getByRole('dialog', { name: 'Done' }).getByRole('button', { name: 'Close' }).click()

  // ---- settings and persistence across a restart
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.waitForSelector('text=Find GitHub Actions runners at startup')
  check(await page.getByRole('switch', { name: 'Find GitHub Actions runners at startup' }).getAttribute('aria-checked') === 'true' && await page.getByRole('switch', { name: 'Also read GitHub at startup' }).getAttribute('aria-checked') === 'false', 'Settings exposes the startup discovery switches with the documented defaults')
  await shot('15-settings')
  await app.close()
  await launch()
  await page.getByRole('button', { name: 'Tools' }).click()
  await page.locator('.gm-tool', { hasText: 'Runners' }).click()
  await page.waitForSelector('.gm-rrow')
  check((await rowNames()).includes('build-box') && (await rowNames()).includes('org-gpu-1'), 'the inventory is shown after a restart before any new request')
  await tab('Discovery')
  await page.waitForSelector('.gm-disc-form', { timeout: 20000 })
  const rootsNow = await page.evaluate(() => window.gitmanager.runnersState().then(s => JSON.stringify(s.config.settings.roots)))
  const rowTexts = await page.locator('.gm-root-row').allInnerTexts()
  check(rowTexts.some(t => t.includes(runnersDir)), 'the discovery folder persisted', `${rootsNow} | rows: ${rowTexts.join(' || ')} | file: ${JSON.stringify(JSON.parse(readFileSync(join(dataDir, 'gitmanager.json'), 'utf8')).runners.settings.roots)}`)
  report.ok = true
} catch (e) {
  report.ok = false; report.error = String(e)
  console.error(e)
  await page?.screenshot({ path: join(OUT, 'failure.png') }).catch(() => {})
} finally {
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2))
  try { await Promise.race([app?.close(), new Promise(r => setTimeout(r, 15000))]) } catch { /* ignore */ }
  if (process.env.E2E_KEEP_WORK) console.log(`work folder kept: ${work}`); else rmSync(work, { recursive: true, force: true })
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true })
  console.log(`\n${report.steps.filter(s => s.ok).length}/${report.steps.length} steps passed; report in ${OUT}`)
  process.exit(report.ok ? 0 : 1)
}
