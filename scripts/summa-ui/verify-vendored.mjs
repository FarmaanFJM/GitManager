#!/usr/bin/env node
// Verifies a vendored copy of the guidance bundle against a lock file. Deterministic, no network.
// This is the check a consuming repository (for example Summa) runs in CI and at task start.
// Usage: node scripts/verify-vendored.mjs <vendoredDir> <lockFile> [--allow-draft]
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative } from 'node:path'

const args = process.argv.slice(2).filter(a => !a.startsWith('--'))
const [dir, lockFile] = args
if (!dir || !lockFile) { console.error('usage: verify-vendored.mjs <vendoredDir> <lockFile> [--allow-draft]'); process.exit(2) }
const sha = b => createHash('sha256').update(b).digest('hex')
const errors = []
const lock = JSON.parse(readFileSync(lockFile, 'utf8'))
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
for (const f of manifest.files) {
  const p = join(dir, f.path)
  if (!existsSync(p)) { errors.push(`missing ${f.path}`); continue }
  if (sha(readFileSync(p)) !== f.sha256) errors.push(`modified ${f.path}`)
}
const walk = d => readdirSync(d).flatMap(n => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]))
const listed = new Set([...manifest.files.map(f => f.path), 'manifest.json'])
for (const abs of walk(dir)) { const rel = relative(dir, abs).split('\\').join('/'); if (!listed.has(rel)) errors.push(`unexpected file ${rel}`) }
const digest = sha(manifest.files.map(f => `${f.path}:${f.sha256}`).join('\n'))
if (digest !== manifest.bundleDigest) errors.push('manifest bundleDigest does not match its file list')
if (digest !== lock.bundleDigest) errors.push(`digest ${digest} does not match the lock (${lock.bundleDigest})`)
if (manifest.version !== lock.version) errors.push(`version ${manifest.version} does not match the lock (${lock.version})`)
if (manifest.channel !== 'approved' && !process.argv.includes('--allow-draft')) errors.push(`channel is "${manifest.channel}", not approved`)
if (errors.length) { console.error('verify-vendored FAILED'); errors.forEach(e => console.error(' - ' + e)); process.exit(1) }
console.log(`verified ${manifest.name}@${manifest.version} (${manifest.channel}) digest ${digest.slice(0, 12)}`)
