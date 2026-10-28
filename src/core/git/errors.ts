import type { OpError } from '../../shared/types.js'
import type { ExecResult } from '../exec.js'

const KNOWN: { re: RegExp; code: string; message: string }[] = [
  { re: /would be overwritten by (checkout|merge|switch)/i, code: 'LOCAL_CHANGES', message: 'Your uncommitted changes would be overwritten. Nothing was changed. Commit or stash them yourself, then try again.' },
  { re: /not possible to fast-forward|Not possible to fast-forward|diverging branches/i, code: 'NOT_FAST_FORWARD', message: 'The branch cannot be fast-forwarded. Nothing was changed.' },
  { re: /Authentication failed|could not read Username|terminal prompts disabled|Permission denied \(publickey/i, code: 'AUTH', message: 'The remote rejected the credentials. GitManager uses your existing Git credentials; check them in a terminal.' },
  { re: /Could not resolve host|unable to access .*: (Failed to connect|Could not connect)|Connection (timed out|refused)|Network is unreachable/i, code: 'NETWORK', message: 'The remote could not be reached. Check your network connection.' },
  { re: /does not appear to be a git repository|repository .* not found|Repository not found/i, code: 'REMOTE_NOT_FOUND', message: 'The remote repository was not found.' },
  { re: /not a git repository/i, code: 'NOT_A_REPO', message: 'This folder is not a Git repository.' },
  { re: /already exists/i, code: 'EXISTS', message: 'A branch with that name already exists.' },
  { re: /You have unmerged paths|unresolved conflict|needs merge/i, code: 'CONFLICTS', message: 'The repository has unresolved conflicts.' },
  { re: /There is no distribution with the supplied name|WSL_E_DISTRO_NOT_FOUND/i, code: 'WSL_DISTRO', message: 'The WSL distribution for this repository was not found.' },
  { re: /git: (command )?not found|exec: git: not found|execvpe\(git\) failed/i, code: 'GIT_MISSING', message: 'Git is not installed in this environment.' },
]

/** Removes Git's hints and progress noise and keeps the lines that explain what went wrong. */
export function trimGitOutput(text: string): string {
  return text.split(/\r?\n/).map(l => l.replace(/\r.*$/, '').trimEnd())
    .filter(l => l && !/^hint:/i.test(l) && !/^(remote: )?(Counting|Compressing|Receiving|Resolving|Enumerating|Total) /i.test(l))
    .slice(0, 12).join('\n')
}

export function gitError(r: ExecResult, fallback: string): OpError {
  if (r.spawnError) {
    const wsl = /wsl\.exe/i.test(r.spawnError)
    return { code: wsl ? 'WSL_MISSING' : 'GIT_MISSING', message: wsl ? 'WSL is not available on this computer.' : 'Git was not found. Install Git and make sure it is on PATH.', detail: r.spawnError }
  }
  if (r.timedOut) return { code: 'TIMEOUT', message: 'Git did not respond in time and was stopped.', detail: trimGitOutput(r.stderr) || undefined }
  const text = `${r.stderr}\n${r.stdout}`
  const detail = trimGitOutput(r.stderr || r.stdout) || undefined
  for (const k of KNOWN) if (k.re.test(text)) return { code: k.code, message: k.message, detail }
  return { code: 'GIT_FAILED', message: fallback, detail }
}
