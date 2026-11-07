#!/usr/bin/env node
// Release consistency check: the application version, the Git tag and the built Windows artifacts must agree.
//
//   node scripts/versioning/check.mjs                         package.json and package-lock.json agree (and the tag, when one is given or implied)
//   node scripts/versioning/check.mjs --tag v1.0.1            ... and the tag is exactly v<version>
//   node scripts/versioning/check.mjs --artifacts release     ... and the files in release/ carry that version: names, and the version
//                                                            resource of the installer and of win-unpacked/GitManager.exe
// On a tag build (GITHUB_REF_TYPE=tag) the tag is taken from GITHUB_REF_NAME. Exit code 1 lists every mismatch.
import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/** "v1.0.0" or "refs/tags/v1.0.0" -> "1.0.0"; null when it is not a version tag. */
export function versionOfTag(ref) {
  const m = /^(?:refs\/tags\/)?v(.+)$/.exec(String(ref ?? '').trim())
  return m && SEMVER.test(m[1]) ? m[1] : null
}

/** The version in package.json and the root entries of package-lock.json, and the tag when given. Returns a list of problems. */
export function checkSource({ pkg, lock, tag }) {
  const errors = []
  const v = pkg?.version
  if (typeof v !== 'string' || !SEMVER.test(v)) { errors.push(`package.json version "${v}" is not a semantic version`); return errors }
  if (lock) {
    if (lock.version !== v) errors.push(`package-lock.json version is ${lock.version}, package.json says ${v} (run: npm install --package-lock-only)`)
    const root = lock.packages?.['']
    if (root && root.version !== v) errors.push(`package-lock.json packages[""] version is ${root.version}, package.json says ${v}`)
    if (lock.name !== undefined && lock.name !== pkg.name) errors.push(`package-lock.json name is ${lock.name}, package.json says ${pkg.name}`)
  }
  if (tag !== undefined && tag !== null && tag !== '') {
    const tv = versionOfTag(tag)
    if (tv === null) errors.push(`tag "${tag}" is not a version tag (expected v${v})`)
    else if (tv !== v) errors.push(`tag ${tag} says ${tv} but package.json says ${v}: the installers would be named and stamped ${v}. Fix the version or the tag`)
  }
  return errors
}

/** The expected artifact names for a version. */
export const artifactNames = version => ({ installer: `GitManager-${version}-x64.exe`, zip: `GitManager-${version}-x64.zip` })

/** Files in a release folder that look like GitManager artifacts of another version. */
export function strayArtifacts(files, version) {
  return files.filter(f => /^GitManager-.+-x64\.(exe|zip)$/.test(f) && !f.startsWith(`GitManager-${version}-`))
}

/** FileVersion and ProductVersion strings and the numeric file version of a Windows executable (from its version resource). */
export function readVersionInfo(buffer) {
  const require = createRequire(import.meta.url)
  const { NtExecutable, NtExecutableResource, Resource } = require('resedit')
  const res = NtExecutableResource.from(NtExecutable.from(buffer, { ignoreCert: true }))
  const info = Resource.VersionInfo.fromEntries(res.entries)[0]
  if (!info) return null
  const lang = info.getAllLanguagesForStringValues()[0]
  const s = lang ? info.getStringValues(lang) : {}
  const f = info.fixedInfo
  const numeric = `${f.fileVersionMS >>> 16}.${f.fileVersionMS & 0xffff}.${f.fileVersionLS >>> 16}.${f.fileVersionLS & 0xffff}`
  const productNumeric = `${f.productVersionMS >>> 16}.${f.productVersionMS & 0xffff}.${f.productVersionLS >>> 16}.${f.productVersionLS & 0xffff}`
  return { fileVersion: s.FileVersion ?? null, productVersion: s.ProductVersion ?? null, productName: s.ProductName ?? null, numeric, productNumeric }
}

/** "1.0.0", "1.0.0.0" and "1.0.0-rc.1" (numeric 1.0.0.0) all describe 1.0.0 for a Windows version resource. */
export function versionMatches(found, version) {
  if (!found) return false
  const core = version.split(/[-+]/)[0]
  return found === version || found === core || found === `${core}.0`
}

export function checkVersionInfo(label, info, version) {
  const errors = []
  if (!info) return [`${label}: no version resource found`]
  if (!versionMatches(info.productVersion, version)) errors.push(`${label}: ProductVersion is ${info.productVersion}, expected ${version}`)
  if (!versionMatches(info.fileVersion, version)) errors.push(`${label}: FileVersion is ${info.fileVersion}, expected ${version}`)
  const core = version.split(/[-+]/)[0]
  if (info.numeric !== `${core}.0` || info.productNumeric !== `${core}.0`) errors.push(`${label}: numeric version is ${info.numeric} / ${info.productNumeric}, expected ${core}.0`)
  return errors
}

export function checkArtifacts({ dir, version, read = p => readFileSync(p), list = d => readdirSync(d), exists = existsSync, readInfo = readVersionInfo }) {
  const errors = []
  const names = artifactNames(version)
  if (!exists(dir)) return [`${dir} does not exist: build first (npx electron-builder --win --x64)`]
  const files = list(dir)
  for (const n of Object.values(names)) if (!files.includes(n)) errors.push(`missing ${n} in ${dir}`)
  for (const f of strayArtifacts(files, version)) errors.push(`${f} is not version ${version} (stale build output? remove it)`)
  const targets = [[names.installer, join(dir, names.installer)], ['win-unpacked/GitManager.exe', join(dir, 'win-unpacked', 'GitManager.exe')]]
  for (const [label, p] of targets) {
    if (!exists(p)) { if (label !== names.installer) errors.push(`missing ${label}`); continue }
    let info
    try { info = readInfo(read(p)) } catch (e) { errors.push(`${label}: version resource unreadable: ${e.message}`); continue }
    errors.push(...checkVersionInfo(label, info, version))
    if (info?.productName && info.productName !== 'GitManager') errors.push(`${label}: ProductName is ${info.productName}, expected GitManager`)
  }
  return errors
}

function main(argv, env) {
  const opt = n => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined }
  const root = process.cwd()
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const lock = existsSync(join(root, 'package-lock.json')) ? JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')) : null
  const tag = opt('tag') ?? (env.GITHUB_REF_TYPE === 'tag' ? env.GITHUB_REF_NAME : undefined)
  const errors = checkSource({ pkg, lock, tag })
  const artifacts = opt('artifacts')
  if (artifacts && !errors.length) errors.push(...checkArtifacts({ dir: resolve(root, artifacts), version: pkg.version }))
  if (errors.length) { console.error('release check FAILED'); for (const e of errors) console.error(` - ${e}`); process.exit(1) }
  console.log(`release check passed: version ${pkg.version}${tag ? `, tag ${tag}` : ''}${artifacts ? `, artifacts in ${artifacts}` : ''}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2), process.env)
