// Builds the acceptance fixture: a CaissaTrainer-shaped project (Vite frontend, Spring Boot backend) in a real Git
// repository with a bare "origin" and a teammate clone that pushes changes. Nothing here is simulated: the app under test
// sees ordinary Git repositories and starts ordinary processes.
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const TEMPLATE = new URL('./template/', import.meta.url).pathname
const ENV = { ...process.env, GIT_AUTHOR_NAME: 'Teammate', GIT_AUTHOR_EMAIL: 'teammate@example.com', GIT_COMMITTER_NAME: 'Teammate', GIT_COMMITTER_EMAIL: 'teammate@example.com' }

export const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8' }).trim()
export const sh = (cwd, file, args, env = {}) => execFileSync(file, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

export function commitFile(repo, file, content, message) {
  writeFileSync(join(repo, file), content)
  git(repo, 'add', file)
  git(repo, 'commit', '-q', '-m', message)
}

/** Returns { root, remote, local, teammate }. `local` is the repository registered in GitManager. */
export function buildFixture(root, { wgetrc } = {}) {
  const remote = join(root, 'origin.git'), seed = join(root, 'seed'), local = join(root, 'caissa-trainer'), teammate = join(root, 'teammate')
  mkdirSync(seed, { recursive: true })
  cpSync(TEMPLATE, seed, { recursive: true })
  git(root, 'init', '-q', '--bare', '-b', 'main', remote)
  git(seed, 'init', '-q', '-b', 'main')
  // The Maven wrapper is generated, not vendored (only-script: no binary jar in the repository).
  sh(join(seed, 'frontend'), 'npm', ['install', '--package-lock-only', '--no-audit', '--no-fund', '--silent'])
  sh(join(seed, 'backend'), 'mvn', ['-q', '-B', 'wrapper:wrapper', '-Dtype=only-script', '-Dmaven=3.9.9'])
  git(seed, 'add', '-A')
  git(seed, 'commit', '-q', '-m', 'CaissaTrainer: frontend and backend')
  git(seed, 'remote', 'add', 'origin', remote)
  git(seed, 'push', '-q', '-u', 'origin', 'main')
  git(root, 'clone', '-q', remote, local)
  git(root, 'clone', '-q', remote, teammate)
  for (const r of [local, teammate]) { git(r, 'config', 'user.name', r === local ? 'Me' : 'Teammate'); git(r, 'config', 'user.email', r === local ? 'me@example.com' : 'teammate@example.com') }
  sh(join(local, 'frontend'), 'npm', ['install', '--no-audit', '--no-fund', '--silent'])
  // Warm the backend build so the first start in GitManager is not a dependency download.
  sh(join(local, 'backend'), './mvnw', ['-q', '-B', '-DskipTests', 'compile'], wgetrc ? { WGETRC: wgetrc } : {})
  return { root, remote, local, teammate }
}
