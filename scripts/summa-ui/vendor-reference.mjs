#!/usr/bin/env node
// Copies the Summa-UI reference files (React components and shared CSS) from a summa-ui checkout into
// third_party/summa-ui/src byte for byte and rewrites the `reference` section of summa-ui.lock.json.
// The guidance bundle (third_party/summa-ui/guidance), its digest and the approval fields are never touched:
// this only moves reusable components. Usage: node scripts/summa-ui/vendor-reference.mjs <summa-ui checkout> [--source "<branch@commit>"]
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'

const src = process.argv[2]
if (!src) { console.error('usage: vendor-reference.mjs <summa-ui checkout>'); process.exit(2) }
const files = ['src/ui/index.tsx', 'src/ui/popover.tsx', 'src/ui/icons.tsx', 'src/ui/top.tsx', 'src/presets/Toast.tsx', 'src/presets/Confirm.tsx', 'src/presets/index.ts', 'src/styles/base.css', 'src/styles/top.css']
const lockFile = 'summa-ui.lock.json'
const lock = JSON.parse(readFileSync(lockFile, 'utf8'))
const base = lock.reference.basePath
const sha = b => createHash('sha256').update(b).digest('hex')
const git = (...a) => execFileSync('git', a, { cwd: src, encoding: 'utf8' }).trim()
const entries = []
for (const f of files) {
  const to = join(base, f)
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(join(src, f), to)
  entries.push({ path: f, sha256: sha(readFileSync(to)) })
}
let head = ''
try { head = `${git('rev-parse', '--abbrev-ref', 'HEAD')}@${git('rev-parse', 'HEAD')}` } catch { /* not a git checkout */ }
const srcIdx = process.argv.indexOf('--source')
lock.reference.files = entries
lock.reference.note = 'React components and shared CSS copied byte for byte (SUMMA_INTEGRATION.md allows copying; not a runtime dependency). The guidance bundle above is the approved guidance-v0.1.0 release and is unchanged. The reference files also include the TOP primitives (src/ui/top.tsx, src/styles/top.css) from an unreleased Summa-UI change: ' + (srcIdx > 0 ? process.argv[srcIdx + 1] : head) + '. They are a candidate until the owner releases them; see docs/SUMMA_UI_ADOPTION.md.'
writeFileSync(lockFile, JSON.stringify(lock, null, 2) + '\n')
console.log(`vendored ${entries.length} reference files`)
