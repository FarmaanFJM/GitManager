import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
}

export const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8' }).trim()

export function tempDir(prefix = 'gm-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

export function commit(repo: string, file: string, content: string, message = `change ${file}`) {
  writeFileSync(join(repo, file), content)
  git(repo, 'add', file)
  git(repo, 'commit', '-q', '-m', message)
}

/** A bare "remote", a working clone ("local") and a second clone ("other") that pushes changes to the remote. */
export function remoteFixture() {
  const t = tempDir()
  const remote = join(t.dir, 'remote.git'), local = join(t.dir, 'local'), other = join(t.dir, 'other')
  git(t.dir, 'init', '-q', '--bare', '-b', 'main', remote)
  git(t.dir, 'clone', '-q', remote, other)
  git(other, 'checkout', '-q', '-b', 'main')
  commit(other, 'README.md', 'hello\n', 'initial')
  git(other, 'push', '-q', '-u', 'origin', 'main')
  git(t.dir, 'clone', '-q', remote, local)
  return { ...t, remote, local, other }
}

/** Isolates the tests from the developer's own Git configuration (also applies to the GitManager code under test). */
export function isolateGitConfig() {
  for (const [k, v] of Object.entries(ENV)) if (k.startsWith('GIT_')) process.env[k] = v
}
