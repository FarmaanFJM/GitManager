#!/usr/bin/env node
// Writes summa-ui.usage.json for an application: which guidance version and digest it was built with.
// Reads the consumer's lock file (summa-ui.lock.json), so the record is derived from the pinned, verified bundle, never typed by hand.
// Usage: node scripts/record-guidance-usage.mjs --app <name> --lock <summa-ui.lock.json> [--repository <url>] [--commit <sha>] [--exception P22:"reason":"scope"] [--out summa-ui.usage.json]
import { readFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
const all = n => args.flatMap((a, i) => (a === `--${n}` ? [args[i + 1]] : []))
const one = (n, d) => all(n)[0] ?? d
const die = m => { console.error('record-guidance-usage: ' + m); process.exit(1) }
const app = one('app'), lockPath = one('lock')
if (!app || !lockPath) die('needs --app and --lock')
const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
if (lock.bundle !== 'summa-ui-guidance' || !lock.version || !lock.bundleDigest) die('the lock file is not a Summa-UI guidance lock')
if (lock.channel && lock.channel !== 'approved') die(`the lock pins a ${lock.channel} bundle; applications record only approved guidance`)
const exceptions = all('exception').map(e => { const [principle, reason, scope] = e.split(':'); if (!/^P\d{2}$/.test(principle) || !reason) die(`bad --exception "${e}", expected P##:reason[:scope]`); return { principle, reason, ...(scope ? { scope } : {}) } })
const record = {
  schemaVersion: 1,
  application: { name: app, ...(one('repository') ? { repository: one('repository') } : {}), ...(one('commit') ? { commit: one('commit') } : {}) },
  guidance: { name: 'summa-ui-guidance', version: lock.version, bundleDigest: lock.bundleDigest, ...(lock.tag ? { tag: lock.tag } : {}), source: 'vendored' },
  recordedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  ...(exceptions.length ? { exceptions } : {}),
}
writeFileSync(one('out', 'summa-ui.usage.json'), JSON.stringify(record, null, 2) + '\n')
console.log(`recorded ${app} -> summa-ui-guidance@${lock.version} (${lock.bundleDigest.slice(0, 12)})`)
