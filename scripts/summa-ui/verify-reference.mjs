#!/usr/bin/env node
// Verifies that the copied Summa-UI reference files (React components, shared CSS) are byte-identical
// to the files pinned in summa-ui.lock.json, and that nothing else was added next to them.
// Companion to verify-vendored.mjs (copied unchanged from summa-ui), which verifies the guidance bundle.
// Usage: node scripts/summa-ui/verify-reference.mjs [summa-ui.lock.json]
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative } from 'node:path'

const lockFile = process.argv[2] ?? 'summa-ui.lock.json'
const lock = JSON.parse(readFileSync(lockFile, 'utf8'))
const ref = lock.reference
const sha = b => createHash('sha256').update(b).digest('hex')
const errors = []
if (!ref?.basePath || !Array.isArray(ref.files)) errors.push('lock has no reference section')
else {
  for (const f of ref.files) {
    const p = join(ref.basePath, f.path)
    if (!existsSync(p)) { errors.push(`missing ${f.path}`); continue }
    if (sha(readFileSync(p)) !== f.sha256) errors.push(`modified ${f.path} (copied files must stay identical to ${lock.tag}; put changes in src/renderer)`)
  }
  const listed = new Set(ref.files.map(f => f.path))
  const walk = d => readdirSync(d).flatMap(n => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]))
  for (const abs of walk(join(ref.basePath, 'src'))) {
    const rel = relative(ref.basePath, abs).split('\\').join('/')
    if (!listed.has(rel)) errors.push(`unexpected file ${rel}`)
  }
}
if (errors.length) { console.error('verify-reference FAILED'); errors.forEach(e => console.error(' - ' + e)); process.exit(1) }
console.log(`verified ${ref.files.length} Summa-UI reference files from ${lock.tag} (${lock.commit.slice(0, 12)})`)
