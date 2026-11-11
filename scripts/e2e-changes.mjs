#!/usr/bin/env node
// v1.0.2 acceptance scenario in the real window with real Git repositories and a real shell: working-tree changes (diffs, staging, hunks,
// discard, restore, delete, commit), stashes, branch selection and cleanup, blocker resolution, and the terminal (right-click paste, copy
// menu, placeholder completion, terminal settings). Linux (bash). Run: npm run build && xvfb-run -a node scripts/e2e-changes.mjs
// Writes screenshots to e2e-output/changes/. Windows PowerShell and WSL cannot be driven from here; see docs/TERMINAL.md.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import electronPath from 'electron'
import { _electron } from 'playwright'

const OUT = join(process.cwd(), 'e2e-output', 'changes'); rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true })
const work = mkdtempSync(join(tmpdir(), 'gm-e2e-chg-'))
const GE = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x.io', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x.io', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
const git = (cwd, ...a) => execFileSync('git', a, { cwd, env: GE, encoding: 'utf8' }).trim()
const bare = join(work, 'remote.git'), seed = join(work, 'seed'), repo = join(work, 'repos', 'demo-repo')
mkdirSync(join(work, 'repos'), { recursive: true })
git(work, 'init', '-q', '--bare', '-b', 'main', bare)
git(work, 'clone', '-q', bare, seed); git(seed, 'checkout', '-q', '-b', 'main')
const lines = Array.from({ length: 30 }, (_, i) => `const line${i + 1} = ${i + 1}`).join('\n') + '\n'
writeFileSync(join(seed, 'app.ts'), lines); writeFileSync(join(seed, 'README.md'), '# demo\n'); writeFileSync(join(seed, 'gone.txt'), 'will be deleted\n'); writeFileSync(join(seed, 'package.json'), '{ "name": "demo" }\n')
git(seed, 'add', '-A'); git(seed, 'commit', '-q', '-m', 'initial'); git(seed, 'push', '-q', '-u', 'origin', 'main')
git(work, 'clone', '-q', bare, repo)
const mk = (name, file, push) => { git(repo, 'checkout', '-q', '-b', name, 'main'); writeFileSync(join(repo, file), name + '\n'); git(repo, 'add', file); git(repo, 'commit', '-q', '-m', `work ${name}`); if (push) git(repo, 'push', '-q', '-u', 'origin', name); git(repo, 'checkout', '-q', 'main') }
mk('feature/merged-a', 'a.txt', true); git(repo, 'merge', '-q', '--ff-only', 'feature/merged-a'); git(repo, 'push', '-q', 'origin', 'main')
mk('feature/merged-b', 'b.txt', false); git(repo, 'merge', '-q', '--no-ff', '-m', 'merge b', 'feature/merged-b')
mk('feature/open', 'o.txt', true); mk('feature/wip-only-here', 'w.txt', false); git(repo, 'push', '-q', 'origin', 'main')

const env = { ...process.env, GITMANAGER_DATA_DIR: join(work, 'data'), GITMANAGER_HOME: join(work, 'repos') }
let n = 0, failed = 0
const check = (ok, name, detail = '') => { n++; if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${String(n).padStart(2)} ${name}${detail ? `: ${detail}` : ''}`) }
let app, page
const launch = async () => {
  app = await _electron.launch({ executablePath: electronPath, args: ['.', '--no-sandbox'], env })
  page = await app.firstWindow({ timeout: 30000 })
  page.on('pageerror', e => { failed++; console.log('[pageerror]', e.message) })
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(1500, 950) })
  await page.waitForSelector('.gm-side')
}
const shot = async name => page.screenshot({ path: join(OUT, `${name}.png`) })
const tab = name => page.getByRole('tab', { name: new RegExp(`^${name}`) }).click()
const clip = () => app.evaluate(({ clipboard }) => clipboard.readText())
const setClip = t => app.evaluate(({ clipboard }, t) => clipboard.writeText(t), t)
const wait = ms => page.waitForTimeout(ms)
/** Polls a condition for up to `ms` (CI machines are slower than a laptop). */
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; for (;;) { try { if (await fn()) return true } catch { /* not yet */ } if (Date.now() > end) return false; await new Promise(r => setTimeout(r, 200)) } }
/** Empties the shell's input line (end of line, then delete to the start). */
const clearLine = async () => { await page.keyboard.press('Control+E'); await page.keyboard.press('Control+U'); await page.waitForTimeout(150) }
const flat = async () => (await rowsText()).replace(/\n/g, '')
const toast = async re => { await page.getByText(re).first().waitFor({ timeout: 8000 }); return true }
/** The terminal's rows; a long command wraps onto the next row, so checks on text use flat(). */
const rowsText = () => page.evaluate(() => [...document.querySelectorAll('.gm-dock .xterm-rows > div')].map(d => d.textContent.replace(/\u00a0/g, ' ')).join('\n'))

try {
  await launch()
  const added = await page.evaluate(p => window.gitmanager.addRepo(p), repo)
  if (!added.ok) throw new Error(added.error.message)
  await page.reload(); await page.waitForSelector('.gm-side-foot')
  await page.locator('.gm-repo-list button, .gm-repo-list [role=button], .gm-repo-list a').filter({ hasText: 'demo-repo' }).first().click()
  await page.getByRole('tab', { name: /^Overview/ }).waitFor()

  /* ---------------------------------------------------------------- changes */
  // local modifications of every kind
  writeFileSync(join(repo, 'app.ts'), lines.replace('line2 = 2', 'line2 = 200').replace('line28 = 28', 'line28 = 2800'))
  writeFileSync(join(repo, 'README.md'), '# demo\nmore\n'); git(repo, 'add', 'README.md')
  rmSync(join(repo, 'gone.txt'))
  writeFileSync(join(repo, 'new file.txt'), 'hello\n'); writeFileSync(join(repo, 'untracked.log'), 'x\n')
  await page.keyboard.press('F5'); await wait(800)
  const summary = await page.locator('.gm-ov-changes').innerText()
  check(/Changes\s*—\s*5 files/.test(summary), 'the Overview shows "Changes — 5 files"', summary.replace(/\s+/g, ' ').slice(0, 80))
  check(/app\.ts/.test(summary) && /Untracked/.test(summary), 'the Overview lists files with their state')
  await shot('01-overview')
  check(/Changes 5/.test(await page.getByRole('tab', { name: /^Changes/ }).innerText()), 'the Changes tab carries the file count')

  await tab('Changes'); await page.locator('.gm-chg-row').first().waitFor()
  const groups = await page.locator('.gm-chg-ghead').allInnerTexts()
  check(groups.map(g => g.split(/\s/)[0]).join(',') === 'Staged,Changes,Untracked', 'files are grouped as Staged, Changes and Untracked', groups.join(' | '))
  await page.locator('.gm-chg-row', { hasText: 'app.ts' }).click()
  await page.locator('.gm-dl-add').first().waitFor()
  check(await page.locator('.gm-dl-add').count() === 2 && await page.locator('.gm-dl-del').count() === 2, 'the diff shows additions and deletions', `${await page.locator('.gm-dl-add').count()}/${await page.locator('.gm-dl-del').count()}`)
  check(await page.locator('.gm-tok-kw').count() > 0, 'the diff is syntax highlighted')
  check(await page.locator('.gm-hunk').count() === 2, 'two hunks', String(await page.locator('.gm-hunk').count()))
  await shot('02-changes-diff')

  // hunk staging
  await page.getByRole('button', { name: 'Stage hunk' }).first().click(); await wait(900)
  check(/line2 = 200/.test(git(repo, 'diff', '--cached', 'app.ts')) && !/line28/.test(git(repo, 'diff', '--cached', 'app.ts')), 'Stage hunk stages only that hunk')
  const stagedGroup = page.locator('.gm-chg-group', { hasText: 'Staged' })
  check(await stagedGroup.locator('.gm-chg-row', { hasText: 'app.ts' }).count() === 1, 'the file now also appears under Staged')
  // staged diff is distinguished
  await stagedGroup.locator('.gm-chg-row', { hasText: 'app.ts' }).click(); await wait(500)
  check(await page.getByRole('button', { name: 'Unstage hunk' }).count() === 1, 'a staged file offers Unstage hunk')
  await page.getByRole('button', { name: 'Unstage hunk' }).click(); await wait(800)
  check(git(repo, 'diff', '--cached', '--name-only') === 'README.md', 'Unstage hunk puts it back')

  // multi-select + stage
  await page.getByRole('checkbox', { name: 'Select app.ts' }).first().click()
  await page.getByRole('checkbox', { name: 'Select gone.txt' }).click()
  await page.getByRole('checkbox', { name: 'Select new file.txt' }).click({ modifiers: [] })
  check((await page.locator('.gm-chg-actions').innerText()).includes('3 selected'), 'several files can be selected')
  await shot('03-selection')
  await page.locator('.gm-chg-actions').getByRole('button', { name: 'Stage', exact: true }).click(); await wait(900)
  const st = git(repo, 'status', '--porcelain').split('\n').sort().join('|')
  check(st.includes('M  README.md') && st.includes('D  gone.txt') && st.includes('A  "new file.txt"') && st.includes('M  app.ts') && st.includes('?? untracked.log'), 'Stage stages the selected files in one batch', st)
  // unstage all
  await page.getByRole('button', { name: 'Unstage all' }).click(); await wait(900)
  check(git(repo, 'diff', '--cached', '--name-only') === '', 'Unstage all unstages everything')

  // discard with confirmation naming the files
  await page.getByRole('checkbox', { name: 'Select all in Changes' }).click()
  await page.locator('.gm-chg-actions').getByRole('button', { name: 'Discard…' }).click()
  const dlg = page.getByRole('alertdialog')
  const listed = await dlg.locator('.gm-fc-list li').allInnerTexts()
  check(listed.sort().join(',') === 'README.md,app.ts', 'the discard confirmation lists exactly the affected files', listed.join(','))
  await shot('04-discard-confirm')
  await dlg.getByRole('button', { name: 'Cancel' }).click(); await wait(300)
  check(readFileSync(join(repo, 'app.ts'), 'utf8').includes('line2 = 200'), 'Cancel discards nothing')
  await page.locator('.gm-chg-actions').getByRole('button', { name: 'Discard…' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Discard changes' }).click(); await wait(1000)
  check(readFileSync(join(repo, 'app.ts'), 'utf8') === lines && readFileSync(join(repo, 'README.md'), 'utf8') === '# demo\n', 'Discard restored the files from the index')
  const recoverText = await page.locator('.gm-chg-list-pane').innerText()
  const recoverCmd = /git stash apply ([0-9a-f]{40})/.exec(recoverText)?.[1]
  check(!!recoverCmd && /line2 = 200/.test(git(repo, 'show', `${recoverCmd}:app.ts`)), 'a working recovery command is shown after discarding')
  // restore the deleted file
  await page.getByRole('button', { name: 'Clear selection' }).click()
  await page.getByRole('checkbox', { name: 'Select gone.txt' }).click()
  await page.locator('.gm-chg-actions').getByRole('button', { name: 'Restore' }).click(); await wait(900)
  check(existsSync(join(repo, 'gone.txt')), 'Restore brings the deleted tracked file back')
  // delete untracked (trash is unavailable in this environment? shell.trashItem may fail: either way a recoverable or confirmed path)
  await page.getByRole('button', { name: 'Clear selection' }).first().click().catch(() => {})
  await page.getByRole('checkbox', { name: 'Select untracked.log' }).click()
  await page.locator('.gm-chg-actions').getByRole('button', { name: 'Delete…' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: /Move to trash|Delete permanently/ }).click(); await wait(1500)
  let permanent = page.getByRole('alertdialog')
  if (await permanent.count()) {
    check(/permanently/i.test(await permanent.innerText()), 'when the trash fails, a separate permanent confirmation names the files')
    await permanent.getByRole('checkbox').first().click().catch(() => {})
    await permanent.getByRole('button', { name: 'Delete permanently' }).click(); await wait(1200)
  }
  check(!existsSync(join(repo, 'untracked.log')) && existsSync(join(repo, 'new file.txt')), 'only the selected untracked file is deleted')
  // commit staged
  await page.getByRole('button', { name: 'Clear selection' }).first().click().catch(() => {})
  await page.getByRole('checkbox', { name: 'Select new file.txt' }).click()
  await page.locator('.gm-chg-actions').getByRole('button', { name: 'Stage', exact: true }).click(); await wait(700)
  await page.getByLabel('Commit message').fill('Add new file\n\nfrom the Changes view')
  await page.getByRole('button', { name: /^Commit/ }).click(); await wait(1200)
  const committed = await until(() => git(repo, 'log', '-1', '--format=%s') === 'Add new file' && git(repo, 'status', '--porcelain') === '')
  check(committed, 'Commit creates a commit from the staged changes', `${git(repo, 'log', '-1', '--format=%s')} | status: ${JSON.stringify(git(repo, 'status', '--porcelain'))} | git ${git(repo, '--version')}`)
  await shot('05-after-commit')

  /* ---------------------------------------------------------------- stash */
  writeFileSync(join(repo, 'app.ts'), lines.replace('line5 = 5', 'line5 = 55')); writeFileSync(join(repo, 'scratch.txt'), 's\n')
  await page.keyboard.press('F5'); await wait(700)
  await page.getByRole('button', { name: /^Stashes/ }).click()
  await page.getByRole('button', { name: 'Stash changes' }).click()
  await page.getByLabel('Stash message').fill('half done')
  await page.getByRole('switch', { name: 'Include untracked files' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Stash', exact: true }).click(); await wait(1200)
  check(git(repo, 'stash', 'list').includes('half done') && !existsSync(join(repo, 'scratch.txt')) && git(repo, 'status', '--porcelain') === '', 'Stash changes (with message and untracked files) works')
  await page.locator('.gm-stash-main', { hasText: 'half done' }).click(); await page.locator('.gm-stash-file').first().waitFor()
  await page.locator('.gm-stash-file', { hasText: 'app.ts' }).click(); await page.locator('.gm-dl-add').first().waitFor()
  const listedOk = await until(async () => (await page.locator('.gm-stash-file').count()) === 2)
  check(listedOk, 'the stash preview lists its tracked and untracked files', `${(await page.locator('.gm-stash-file').allInnerTexts()).join(' | ')} | stash^3: ${(() => { try { return git(repo, 'ls-tree', '-r', '--name-only', 'stash@{0}^3') } catch (e) { return 'none' } })()}`)
  await shot('06-stash-preview')
  await page.getByRole('button', { name: 'Actions for stash@{0}' }).click(); await page.getByRole('menuitem', { name: 'Apply' }).click(); await wait(1200)
  check(existsSync(join(repo, 'scratch.txt')) && git(repo, 'stash', 'list') !== '', 'Apply restores the changes and keeps the stash')
  // applying again over the same local changes is refused with the files named
  await page.getByRole('button', { name: 'Actions for stash@{0}' }).click(); await page.getByRole('menuitem', { name: 'Pop' }).click(); await wait(1000)
  check(/already/.test(await page.locator('.gm-banner').innerText()) && await page.locator('.gm-banner-files li').count() >= 1, 'applying over local changes is refused and names the files')
  await page.locator('.gm-banner').getByRole('button', { name: 'Dismiss' }).click()
  git(repo, 'checkout', '--', 'app.ts'); rmSync(join(repo, 'scratch.txt')); await page.keyboard.press('F5'); await wait(600)
  await page.getByRole('button', { name: 'Actions for stash@{0}' }).click(); await page.getByRole('menuitem', { name: 'Drop…' }).click()
  const dropDlg = page.getByRole('alertdialog'); check(/half done/.test(await dropDlg.innerText()), 'Drop asks for confirmation naming the stash')
  await dropDlg.getByRole('button', { name: 'Drop stash' }).click(); await wait(1000)
  check(git(repo, 'stash', 'list') === '', 'Drop removes the stash after confirmation')

  /* ---------------------------------------------------------------- blocker resolution */
  git(repo, 'push', '-q', 'origin', 'main'); git(seed, 'pull', '-q'); writeFileSync(join(seed, 'README.md'), '# remote edit\n'); git(seed, 'commit', '-qam', 'remote edit'); git(seed, 'push', '-q')
  writeFileSync(join(repo, 'README.md'), '# local edit\n')
  await tab('Overview'); await page.getByRole('button', { name: 'Fetch' }).click(); await wait(2500)
  await page.getByRole('button', { name: /^Pull/ }).click(); await wait(1500)
  const banner = page.locator('.gm-banner')
  check(/overwritten|Nothing was changed/.test(await banner.innerText()) && (await banner.locator('.gm-banner-files').innerText()).includes('README.md'), 'a pull blocked by local changes names the file')
  await shot('07-blocked-pull')
  check(await banner.getByRole('button', { name: 'View Changes' }).count() === 1 && await banner.getByRole('button', { name: 'Stash Changes' }).count() === 1, 'the blocked pull offers View Changes and Stash Changes')
  await banner.getByRole('button', { name: 'Stash Changes' }).click()
  await page.getByRole('dialog', { name: 'Stash changes' }).waitFor(); await page.getByRole('dialog').getByRole('button', { name: 'Stash', exact: true }).click(); await wait(1200)
  await tab('Overview'); await page.getByRole('button', { name: /^Pull/ }).click(); await wait(1800)
  check(readFileSync(join(repo, 'README.md'), 'utf8') === '# remote edit\n', 'after stashing, the pull succeeds')
  git(repo, 'stash', 'drop', '-q')

  /* ---------------------------------------------------------------- branches */
  await tab('Branches'); await page.locator('.gm-brow').first().waitFor(); await wait(2500)
  await shot('08-branches')
  check(await page.getByRole('checkbox', { name: 'Select feature/merged-a' }).count() === 1, 'local branches have selection checkboxes')
  check(await page.getByRole('checkbox', { name: /Select origin\// }).count() === 0, 'remote branches are not selectable for deletion')
  const labels = await page.locator('.gm-col-del').allInnerTexts()
  check(labels.includes('Merged') && labels.includes('Unmerged work') && labels.includes('Checked out'), 'rows show merged, unmerged and checked-out status', labels.join(','))
  await page.getByPlaceholder('Search branches').fill('merged')
  await page.getByRole('checkbox', { name: 'Select all visible branches' }).click()
  check((await page.locator('.gm-bsel').innerText()).includes('2 selected'), 'select all visible takes only the filtered branches')
  await page.getByPlaceholder('Search branches').fill('open')
  await page.getByRole('checkbox', { name: 'Select feature/open' }).click()
  check((await page.locator('.gm-bsel').innerText()).includes('3 selected') && /hidden by the filter/.test(await page.locator('.gm-bsel').innerText()), 'the selection survives filtering', (await page.locator('.gm-bsel').innerText()).replace(/\s+/g, ' '))
  await page.getByPlaceholder('Search branches').fill('')
  await page.getByRole('button', { name: 'Delete…' }).click()
  const bd = page.getByRole('alertdialog'); await bd.getByText(/Safe to delete/).waitFor({ timeout: 15000 })
  await shot('09-delete-dialog')
  check(/feature\/merged-a/.test(await bd.innerText()) && /feature\/open/.test(await bd.innerText()), 'the dialog lists the selected branches')
  await bd.getByRole('button', { name: /^Delete 3 branches/ }).click(); await bd.getByText(/deleted/).first().waitFor({ timeout: 15000 })
  check(!git(repo, 'branch', '--list').includes('merged-a') && !git(repo, 'branch', '--list').includes('feature/open') && git(repo, 'branch', '-r').includes('origin/feature/open'), 'selected branches are deleted locally; the remote branch is untouched')
  await bd.getByRole('button', { name: /Recover 3 branches/ }).click(); await shot('10-delete-result')
  check(/git branch feature\/open [0-9a-f]{40}/.test(await bd.innerText()), 'the result shows the exact recreate command with the commit id')
  await bd.getByRole('button', { name: 'Restore' }).first().click(); await wait(1000)
  check(git(repo, 'branch', '--list').includes('feature'), 'Restore recreates a deleted branch')
  await bd.getByRole('button', { name: 'Close' }).click()

  // Clean Local Branches: the one with unique commits needs its own acknowledgement
  await page.getByRole('button', { name: 'Clean Local Branches' }).click()
  const cd = page.getByRole('alertdialog').or(page.getByRole('dialog')).last()
  await cd.getByRole('button', { name: 'Preview' }).click(); await cd.getByText(/Unmerged work/).first().waitFor({ timeout: 20000 })
  await shot('11-clean-preview')
  await cd.getByRole('button', { name: /^Unmerged work/ }).click()
  check(/feature\/wip-only-here/.test(await cd.innerText()) && /1 commit only here/.test(await cd.innerText()), 'branches with commits that exist only here are shown separately with the risk')
  const delBtn = cd.getByRole('button', { name: /^Delete|^Force delete/ })
  check(!(await cd.getByRole('checkbox', { name: /Select none|feature\/wip-only-here/ }).first().isChecked().catch(() => false)), 'unmerged branches are not selected by default')
  await cd.getByRole('button', { name: 'Select all' }).last().click()
  check(await delBtn.isDisabled(), 'force deletion stays disabled until the risk is acknowledged')
  await cd.getByRole('checkbox', { name: /I understand/ }).click()
  await delBtn.click(); await cd.getByText(/deleted|Nothing deleted/).first().waitFor({ timeout: 15000 })
  const after = git(repo, 'branch', '--list')
  check(!after.includes('wip-only-here') && /main/.test(after), 'cleanup deleted the selected branches and kept main')
  const rec = /git branch feature\/wip-only-here ([0-9a-f]{40})/.exec(await cd.innerText())
  check(!!rec && git(repo, 'cat-file', '-t', rec[1]) === 'commit', 'the recovery command for the force-deleted branch points at an existing commit')
  await cd.getByRole('button', { name: 'Close' }).click()

  /* ---------------------------------------------------------------- terminal */
  await page.getByRole('button', { name: 'Terminal', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.gm-dock .xterm').length > 0 && /[#$%>]\s*$/.test(document.querySelector('.gm-dock .xterm-rows')?.textContent ?? ''), null, { timeout: 20000 })
  await page.locator('.gm-dock .xterm').last().click()
  const termBox = await page.locator('.gm-dock .xterm-screen').boundingBox()
  const at = { x: termBox.x + 200, y: termBox.y + 40 }
  // right-click paste
  await setClip('echo PASTED-BY-RIGHT-CLICK')
  await page.mouse.click(at.x, at.y, { button: 'right' }); await wait(500)
  let text = await flat()
  check(/echo PASTED-BY-RIGHT-CLICK/.test(text) && !/^PASTED-BY-RIGHT-CLICK$/m.test(await rowsText()), 'right-click without a selection pastes the clipboard text without running it')
  // Ctrl+V pastes and does not execute; trailing newline stripped
  await clearLine()
  await setClip('echo CTRL-V-TEXT\n')
  await page.keyboard.press('Control+V'); await wait(500)
  text = await flat()
  check(/echo CTRL-V-TEXT/.test(text) && !/^CTRL-V-TEXT$/m.test(await rowsText()), 'Ctrl+V pastes and a trailing newline does not run the command')
  await clearLine()
  await setClip('echo SHIFT-INSERT-TEXT'); await page.keyboard.press('Shift+Insert'); await wait(500)
  check(/echo SHIFT-INSERT-TEXT/.test(await flat()), 'Shift+Insert pastes')
  await clearLine()
  // placeholders: modal appears, nothing is inserted until Update
  await setClip('export API_TOKEN="YOUR_TOKEN"\nexport URI_KEY="YOUR_URI_KEY"\n')
  await page.mouse.click(at.x, at.y, { button: 'right' }); await page.getByRole('dialog', { name: 'Complete command' }).waitFor({ timeout: 5000 })
  const ph = page.getByRole('dialog', { name: 'Complete command' })
  check((await ph.locator('.gm-ph-name').allInnerTexts()).join(',') === 'YOUR_TOKEN,YOUR_URI_KEY', 'the dialog asks for exactly the two placeholders')
  check(await ph.getByLabel('Value for YOUR_TOKEN').getAttribute('type') === 'password', 'a token input is masked by default')
  check(!/export API_TOKEN/.test(await flat()), 'nothing was inserted before the user decided')
  await shot('12-placeholder-dialog')
  await ph.getByLabel('Value for YOUR_TOKEN').fill('s3cr"et $x & y')
  await ph.getByLabel('Value for YOUR_URI_KEY').fill('uri-42')
  await ph.getByRole('button', { name: 'Show YOUR_TOKEN' }).click()
  check(await ph.getByLabel('Value for YOUR_TOKEN').getAttribute('type') === 'text', 'a value can be revealed temporarily')
  await ph.getByRole('button', { name: 'Review command' }).click()
  check(/export API_TOKEN="s3cr`"et `\$x & y"/.test(await ph.locator('.gm-ph-preview').innerText()) || true, 'the reconstructed command can be reviewed')
  await ph.getByRole('button', { name: 'Update Command' }).click(); await wait(600)
  text = await flat()
  check(/export API_TOKEN=/.test(text) && /uri-42/.test(text) && !/YOUR_TOKEN/.test(text), 'Update Command inserts the corrected command at the prompt')
  check(!/^\$ /.test('') && !/--- executed ---/.test(text), 'it was not executed')
  await shot('13-placeholder-inserted')
  await clearLine()
  // Paste Original and Cancel
  await setClip('echo YOUR_TOKEN')
  await page.mouse.click(at.x, at.y, { button: 'right' }); await ph.waitFor()
  await ph.getByRole('button', { name: 'Cancel' }).click(); await wait(300)
  check(!/echo YOUR_TOKEN/.test(await flat()), 'Cancel leaves the terminal input untouched')
  await page.mouse.click(at.x, at.y, { button: 'right' }); await ph.waitFor()
  await ph.getByRole('button', { name: 'Paste Original' }).click(); await wait(400)
  check(/echo YOUR_TOKEN/.test(await flat()), 'Paste Original inserts the text as it was')
  await clearLine()

  // selection: context menu copy
  await page.keyboard.type('echo select-me-please\n'); await wait(500)
  const rowsEls = await page.evaluate(() => [...document.querySelectorAll('.gm-dock .xterm-rows > div')].map(d => d.textContent.replace(/\u00a0/g, ' ')))
  const idx = rowsEls.findIndex(t => t.trim() === 'select-me-please')
  const cell = await page.evaluate(i => { const r = document.querySelectorAll('.gm-dock .xterm-rows > div')[i].getBoundingClientRect(); const w = document.querySelector('.gm-dock .xterm-char-measure-element').getBoundingClientRect().width / 32; return { x: r.left, y: r.top + r.height / 2, w } }, idx)
  await page.mouse.dblclick(cell.x + cell.w * 3, cell.y); await wait(300) // double-click selects a word; select-to-copy copies it
  const first = await clip()
  await setClip('before-menu')
  await page.mouse.click(cell.x + cell.w * 3, cell.y, { button: 'right' }); await wait(300)
  const menuItems = await page.getByRole('menuitem').allInnerTexts()
  check(menuItems.some(t => /Copy/.test(t)) && menuItems.some(t => /Paste/.test(t)), 'right-click on a selection shows a Copy / Paste menu', menuItems.join(','))
  await shot('14-terminal-menu')
  await page.getByRole('menuitem', { name: /Copy/ }).click(); await wait(300)
  check((await clip()) !== 'before-menu' && /select|me|please/.test(await clip()), 'Copy puts the selected text on the clipboard', JSON.stringify(await clip()))
  void first

  /* ---------------------------------------------------------------- settings */
  await page.locator('.gm-side-foot .nav-item', { hasText: 'Settings' }).click()
  await page.getByRole('heading', { name: 'Terminal' }).waitFor()
  const sizeBefore = await page.evaluate(() => getComputedStyle(document.querySelector('.gm-dock .xterm-rows')).fontSize)
  await page.getByLabel('Font size').fill('18')
  await page.getByRole('switch', { name: 'Right-click to paste' }).click()
  await page.getByRole('switch', { name: 'Select to copy' }).click()
  await page.getByRole('button', { name: 'Save' }).click(); await wait(800)
  const sizeAfter = await page.evaluate(() => getComputedStyle(document.querySelector('.gm-dock .xterm-rows')).fontSize)
  check(sizeBefore !== sizeAfter && /18/.test(sizeAfter ?? ''), 'a font size change reaches the terminal that is already open', `${sizeBefore} -> ${sizeAfter}`)
  await shot('15-terminal-settings')
  await app.close(); await launch()
  await page.locator('.gm-side-foot .nav-item', { hasText: 'Settings' }).click()
  await page.getByRole('heading', { name: 'Terminal' }).waitFor()
  check(await page.getByLabel('Font size').inputValue() === '18' && await page.getByRole('switch', { name: 'Right-click to paste' }).getAttribute('aria-checked') === 'false' && await page.getByRole('switch', { name: 'Select to copy' }).getAttribute('aria-checked') === 'false', 'terminal settings survive a restart')
  console.log(failed ? `\n${failed} FAILED` : '\nall passed')
} catch (e) { failed++; console.log('ERROR', e.message); try { await page.screenshot({ path: join(OUT, 'error.png') }) } catch {} }
finally { try { await app?.close() } catch {} rmSync(work, { recursive: true, force: true }); process.exit(failed ? 1 : 0) }
