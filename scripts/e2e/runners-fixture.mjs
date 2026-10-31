// The Runners scenario's world and stand-ins: GitHub repositories and organizations with registered runners, an existing
// installation on disk, and a stand-in runner package whose config.sh registers with the fake GitHub exactly as the real
// one would (token checked, .runner and .credentials written). Demo data only; nothing here talks to github.com.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const PACKAGE_VERSION = '2.321.0'
export const INSTALLED_VERSION = '2.319.1'

export function runnersWorld() {
  const repo = (full, extra = {}) => ({ full, artifacts: [], runs: [], docs: {}, pulls: [], releases: [], caches: [], runners: [], ...extra })
  const gm = repo('FarmaanFJM/GitManager', {
    runners: [
      { id: 42, name: 'build-box', os: 'Linux', status: 'online', labels: ['gpu'] },
      { id: 43, name: 'win-laptop', os: 'Windows', status: 'offline' },
      { id: 44, name: 'busy-box', os: 'Linux', status: 'online', busy: true, labels: ['docker'] },
    ],
    docs: {
      '.github/workflows/ci.yml': 'name: CI\non: [push]\njobs:\n  build:\n    runs-on: [self-hosted, linux, gpu]\n    steps:\n      - run: make\n  package:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hosted\n  windows-tests:\n    runs-on: [self-hosted, windows, msvc]\n    steps:\n      - run: echo win\n',
    },
  })
  const summa = repo('FarmaanFJM/Summa', { private: true, runnersForbidden: true, runners: [{ id: 50, name: 'hidden', os: 'Linux', status: 'online' }] })
  const md = repo('FarmaanFJM/Markdown-Studio', { runners: [] })
  return {
    login: 'FarmaanFJM', repos: [gm, summa, md],
    orgs: [{ login: 'Summa-Labs', role: 'admin', runners: [{ id: 70, name: 'org-gpu-1', os: 'Linux', status: 'online', group: 2, labels: ['gpu', 'a100'] }], groups: [{ id: 1, name: 'Default', default: true }, { id: 2, name: 'gpu-pool', visibility: 'selected', repos: ['Summa-Labs/trainer'] }] }],
    runnerPackage: { version: PACKAGE_VERSION, sha256: {} },
    tokens: [],
  }
}

/** The stand-in runner package: config.sh (registers through the world file), svc.sh (as the real one, refuses without root), run.sh and a listener that answers --version. */
export function buildPackage(dir, version = PACKAGE_VERSION) {
  const src = join(dir, 'pkg-src')
  mkdirSync(join(src, 'bin'), { recursive: true })
  writeFileSync(join(src, 'bin', 'Runner.Listener'), `#!/bin/sh\n[ "$1" = "--version" ] && { echo ${version}; exit 0; }\n[ "$1" = "run" ] && { echo "Listening for Jobs"; exec sleep 3600; }\necho "stand-in listener"; exit 1\n`)
  writeFileSync(join(src, 'bin', 'fake-config.cjs'), FAKE_CONFIG)
  writeFileSync(join(src, 'config.sh'), '#!/bin/sh\n# stand-in for the GitHub Actions runner configure step (see scripts/e2e/runners-fixture.mjs)\nexec node "$(dirname "$0")/bin/fake-config.cjs" "$@"\n')
  writeFileSync(join(src, 'svc.sh'), '#!/bin/sh\nuser_id=$(id -u)\nif [ $user_id -ne 0 ]; then echo "Must run as sudo"; exit 1; fi\necho "systemd is not available in this environment"; exit 1\n')
  writeFileSync(join(src, 'run.sh'), '#!/bin/sh\nexec "$(dirname "$0")/bin/Runner.Listener" run\n')
  for (const f of ['bin/Runner.Listener', 'config.sh', 'svc.sh', 'run.sh']) chmodSync(join(src, f), 0o755)
  const out = join(dir, 'packages')
  mkdirSync(out, { recursive: true })
  const filename = `actions-runner-linux-x64-${version}.tar.gz`
  execFileSync('tar', ['-czf', join(out, filename), '-C', src, '.'])
  const sha256 = createHash('sha256').update(readFileSync(join(out, filename))).digest('hex')
  return { dir: out, filename, sha256 }
}

/** An installation that was registered earlier (runner id 42 of FarmaanFJM/GitManager), with a systemd unit recorded and an older version. */
export function buildExistingInstall(dir) {
  mkdirSync(join(dir, 'bin'), { recursive: true }); mkdirSync(join(dir, '_diag'), { recursive: true })
  writeFileSync(join(dir, '.runner'), JSON.stringify({ agentId: 42, agentName: 'build-box', poolId: 1, poolName: 'Default', ephemeral: false, serverUrl: 'https://pipelinesghubeus2.actions.githubusercontent.com/demo/', gitHubUrl: 'https://github.com/FarmaanFJM/GitManager', workFolder: '_work', disableUpdate: false }, null, 2))
  writeFileSync(join(dir, '.service'), 'actions.runner.FarmaanFJM-GitManager.build-box.service')
  writeFileSync(join(dir, '.credentials'), '{"scheme":"OAuth","data":{"clientId":"demo"}}')
  writeFileSync(join(dir, 'config.sh'), '#!/bin/sh\nexec node "$(dirname "$0")/bin/fake-config.cjs" "$@"\n')
  writeFileSync(join(dir, 'bin', 'fake-config.cjs'), FAKE_CONFIG)
  writeFileSync(join(dir, 'svc.sh'), '#!/bin/sh\necho "Must run as sudo"; exit 1\n')
  writeFileSync(join(dir, 'bin', 'Runner.Listener'), `#!/bin/sh\n[ "$1" = "--version" ] && echo ${INSTALLED_VERSION}\n`)
  writeFileSync(join(dir, '_diag', 'Runner_20261030-100001-utc.log'), `[2026-10-30 10:00:01Z INFO Listener] Version: ${INSTALLED_VERSION}\n[2026-10-30 10:00:02Z INFO Listener] Connecting to GitHub\n[2026-10-30 10:00:03Z INFO Listener] Listening for Jobs\n`)
  for (const f of ['config.sh', 'svc.sh', 'bin/Runner.Listener']) chmodSync(join(dir, f), 0o755)
  return dir
}

const FAKE_CONFIG = `// Stand-in for "Runner.Listener configure" and "remove": validates the token against the fake GitHub world, registers or
// removes the runner there, and writes or deletes .runner and .credentials in the current directory.
const fs = require('node:fs')
const path = require('node:path')
const file = process.env.FAKE_GH_STATE
if (!file) { console.error('FAKE_GH_STATE is not set'); process.exit(2) }
const args = process.argv.slice(2)
const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null }
const world = JSON.parse(fs.readFileSync(file, 'utf8'))
const save = () => fs.writeFileSync(file, JSON.stringify(world))
const token = opt('--token')
const dir = process.cwd()
if (args[0] === 'remove') {
  const t = (world.tokens || []).find(x => x.token === token && x.kind === 'remove')
  if (!t) { console.error('Http response code: NotFound from https://api.github.com/actions/runner-registration'); process.exit(1) }
  const runner = JSON.parse(fs.readFileSync(path.join(dir, '.runner'), 'utf8'))
  for (const r of world.repos) r.runners = (r.runners || []).filter(x => x.id !== runner.agentId)
  for (const o of world.orgs || []) o.runners = (o.runners || []).filter(x => x.id !== runner.agentId)
  world.tokens = world.tokens.filter(x => x !== t); save()
  fs.rmSync(path.join(dir, '.runner'), { force: true }); fs.rmSync(path.join(dir, '.credentials'), { force: true }); fs.rmSync(path.join(dir, '.service'), { force: true })
  console.log('# Runner removed successfully'); process.exit(0)
}
const url = opt('--url'), name = opt('--name')
if (!args.includes('--unattended') || !url || !name || !token) { console.error('Must provide --url, --token and --name in unattended mode'); process.exit(1) }
const scopeKey = url.replace('https://github.com/', '')
const t = (world.tokens || []).find(x => x.token === token && x.kind === 'register' && x.scope.toLowerCase() === scopeKey.toLowerCase())
if (!t) { console.error('Http response code: Forbidden from https://api.github.com/actions/runner-registration'); process.exit(1) }
if (t.expires < Date.now()) { console.error('Http response code: Unauthorized (token expired)'); process.exit(1) }
const holder = world.repos.find(r => r.full.toLowerCase() === scopeKey.toLowerCase()) || (world.orgs || []).find(o => o.login.toLowerCase() === scopeKey.toLowerCase())
if (!holder) { console.error('Http response code: NotFound'); process.exit(1) }
holder.runners = holder.runners || []
if (holder.runners.some(r => r.name === name)) { if (args.includes('--replace')) holder.runners = holder.runners.filter(r => r.name !== name); else { console.error('A runner exists with the same name'); process.exit(1) } }
const id = (world.nextRunnerId = (world.nextRunnerId || 100) + 1)
holder.runners.push({ id, name, os: 'Linux', status: 'online', busy: false, labels: (opt('--labels') || '').split(',').filter(Boolean), ephemeral: args.includes('--ephemeral') })
world.tokens = world.tokens.filter(x => x !== t); save()
fs.writeFileSync(path.join(dir, '.runner'), JSON.stringify({ agentId: id, agentName: name, poolId: 1, poolName: 'Default', ephemeral: args.includes('--ephemeral'), serverUrl: 'https://pipelinesghubeus2.actions.githubusercontent.com/demo/', gitHubUrl: url, workFolder: opt('--work') || '_work', disableUpdate: args.includes('--disableupdate') }, null, 2))
fs.writeFileSync(path.join(dir, '.credentials'), JSON.stringify({ scheme: 'OAuth', data: { clientId: 'demo-' + id } }))
console.log('√ Connected to GitHub\\n√ Runner successfully added\\n√ Runner connection is good\\n√ Settings Saved.')
`
