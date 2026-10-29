// A demonstration world for the Storage scenario: four repositories with realistic artifact histories. Demo data only.
const MB = 1024 * 1024
const DAY = 86_400_000

export function storageWorld(now = Date.now()) {
  let run = 5_000_000
  let art = 9_000_000
  const ago = d => new Date(now - d * DAY).toISOString()
  const repo = (full, extra = {}) => ({ full, artifacts: [], runs: [], docs: {}, pulls: [], releases: [], caches: [], ...extra })
  /** adds one artifact with its own run */
  const add = (r, name, days, mb, o = {}) => {
    const id = ++run
    r.runs.push({ id, number: id % 1000, name: o.workflow ?? 'CI', path: o.path ?? '.github/workflows/ci.yml', conclusion: o.conclusion ?? 'success', status: o.status ?? 'completed', branch: o.branch ?? 'main', event: o.event ?? 'push', prs: o.prs })
    r.artifacts.push({ id: ++art, name, size: Math.round(mb * MB), created: ago(days), run: id, expired: !!o.expired })
  }

  const gm = repo('FarmaanFJM/GitManager', { docs: { 'README.md': 'Windows package: attached to every CI run as GitManager-windows-x64.' }, caches: [{ key: 'npm-linux-9f2', size: 310 * MB }, { key: 'npm-windows-1ab', size: 280 * MB }] })
  ;[1, 3, 8, 14, 21, 30, 45, 62].forEach((d, i) => add(gm, 'GitManager-windows-x64', d, 86 + i))
  ;[2, 9, 16, 28, 40].forEach(d => add(gm, 'e2e-output', d, 14))
  add(gm, 'GitManager-windows-x64', 12, 90, { branch: 'v0.1.0', event: 'push' })
  gm.releases = [{ tag: 'v0.1.0' }]
  add(gm, 'GitManager-windows-x64', 2, 88, { branch: 'feature/storage', prs: [7] })
  gm.pulls = [{ number: 7, ref: 'feature/storage', sha: 'zzz' }]

  const summa = repo('FarmaanFJM/Summa', { private: true, docs: { 'docs/AUDIT.md': 'See qualification-run-2026-09 for the signed evidence.' }, caches: [{ key: 'gradle-77c', size: 920 * MB }] })
  ;[4, 11, 18, 33].forEach(d => add(summa, 'security-audit-report', d, 6, { workflow: 'Security audit', path: '.github/workflows/audit.yml' }))
  ;[7, 21, 50].forEach(d => add(summa, 'release-qualification-evidence', d, 38))
  ;[2, 6, 15, 24, 31, 45, 70].forEach((d, i) => add(summa, 'summa-linux-x64-build', d, 142 + i * 2))
  ;[1, 5, 12, 26, 35].forEach(d => add(summa, 'test-results', d, 9))
  add(summa, 'summa-linux-x64-build', 20, 150, { conclusion: 'failure' })
  add(summa, 'summa-linux-x64-build', 1, 150, { conclusion: 'failure' })
  add(summa, 'qualification-run-2026-09', 55, 61)

  const herc = repo('FarmaanFJM/Herc-s-Adventure', { private: true, caches: [{ key: 'unity-lib', size: 1.4 * 1024 * MB }] })
  ;[1, 4, 9, 15, 22, 29, 38, 47, 58, 75].forEach((d, i) => add(herc, 'herc-windows-private-build', d, 214 + i * 3))
  ;[3, 17, 41].forEach(d => add(herc, 'playtest-logs', d, 22))
  add(herc, 'herc-windows-private-build', 80, 230, { expired: true })

  const md = repo('FarmaanFJM/Markdown-Studio', { docs: {}, caches: [{ key: 'pnpm-store', size: 410 * MB }] })
  ;[2, 10, 19, 31, 44, 60].forEach((d, i) => add(md, 'markdown-studio-setup-win', d, 96 + i))
  ;[3, 13, 25, 39, 52].forEach((d, i) => add(md, 'markdown-studio-macos-dmg', d, 118 + i))
  ;[3, 13, 25, 39, 52].forEach((d, i) => add(md, 'markdown-studio-linux-appimage', d, 104 + i))
  ;[6, 20].forEach(d => add(md, 'coverage-report', d, 5))

  const flaky = repo('FarmaanFJM/Notes-Sync', { push: false })
  add(flaky, 'notes-sync-linux-build', 5, 40)

  return {
    login: 'FarmaanFJM', scopes: 'repo, read:org, gist', repos: [gm, summa, herc, md, flaky],
    packages: [{ name: 'markdown-studio', visibility: 'private', version_count: 12, updated_at: ago(3), repository: { full_name: 'FarmaanFJM/Markdown-Studio' } }],
    billing: { usageItems: [{ product: 'actions', sku: 'actions_storage', unitType: 'GigabyteHours', quantity: 1480.2, grossAmount: 0.4, netAmount: 0 }, { product: 'actions', sku: 'actions_linux', unitType: 'Minutes', quantity: 812, grossAmount: 6.5, netAmount: 0 }] },
    fail: [],
  }
}
