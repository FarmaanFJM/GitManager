import type { Blocker, OpError } from '../../shared/types.js'
import type { ExecResult } from '../exec.js'

const KNOWN: { re: RegExp; code: string; message: string }[] = [
  { re: /Unable to create '[^']*\.lock': File exists|Another git process seems to be running/i, code: 'LOCKED', message: 'Git is locked by another process (a lock file exists). Wait for the other Git operation to finish, then try again.' },
  { re: /is already (checked out|used by worktree) at|is already used by worktree at/i, code: 'WORKTREE_CHECKED_OUT', message: 'That branch is checked out in another worktree.' },
  { re: /Permission denied|unable to unlink|Access is denied|being used by another process|Device or resource busy/i, code: 'PERMISSION', message: 'The operating system refused access to a file. It may be open in another program, or you may not have permission.' },
  { re: /no tracking information for the current branch|has no upstream branch|There is no tracking information/i, code: 'NO_UPSTREAM', message: 'The current branch has no upstream branch.' },
  { re: /Please tell me who you are|unable to auto-detect email address|Author identity unknown/i, code: 'NO_IDENTITY', message: 'Git does not know who you are. Set user.name and user.email in your Git configuration.' },
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

/** File names from Git's "would be overwritten" lists (tab-indented lines after the sentence). */
export function parseOverwritten(stderr: string): string[] {
  const out: string[] = []
  let inList = false
  for (const raw of stderr.split(/\r?\n/)) {
    if (/would be overwritten by|already exists, no checkout|untracked working tree files would be/i.test(raw)) { inList = true; continue }
    if (inList) { if (/^[\t ]+\S/.test(raw)) out.push(raw.trim()); else if (raw.trim()) inList = false }
  }
  return out
}

/** The file named by a lock or permission failure, when Git printed one. */
export function failureFile(stderr: string): string | null {
  return /Unable to create '([^']+\.lock)'/.exec(stderr)?.[1] ?? /(?:unable to (?:unlink|create file|open)[^'\n]*|error: open\()?['"]([^'"\n]+)['"][^\n]*(?:Permission denied|Access is denied)/i.exec(stderr)?.[1] ?? null
}

/** The worktree folder from "'x' is already checked out at '<path>'". */
export function worktreeOf(stderr: string): string | null {
  return /(?:checked out|used by worktree) at '([^']+)'/.exec(stderr)?.[1] ?? null
}

export function gitError(r: ExecResult, fallback: string): OpError {
  if (r.spawnError) {
    const wsl = /wsl\.exe/i.test(r.spawnError)
    return { code: wsl ? 'WSL_MISSING' : 'GIT_MISSING', message: wsl ? 'WSL is not available on this computer.' : 'Git was not found. Install Git and make sure it is on PATH.', detail: r.spawnError }
  }
  if (r.timedOut) return { code: 'TIMEOUT', message: 'Git did not respond in time and was stopped.', detail: trimGitOutput(r.stderr) || undefined }
  const text = `${r.stderr}\n${r.stdout}`
  const detail = trimGitOutput(r.stderr || r.stdout) || undefined
  for (const k of KNOWN) {
    if (!k.re.test(text)) continue
    let message = k.message
    let blocker: Blocker | undefined
    if (k.code === 'LOCAL_CHANGES') {
      const files = parseOverwritten(text)
      blocker = { ...(files.length ? { files } : {}), actions: [{ id: 'view-changes', label: 'View Changes' }, { id: 'stash', label: 'Stash Changes' }] }
    } else if (k.code === 'WORKTREE_CHECKED_OUT') {
      const wt = worktreeOf(text)
      if (wt) { message = `That branch is checked out in another worktree (${wt}).`; blocker = { worktree: wt, actions: [{ id: 'open-worktree', label: 'Open Worktree', target: wt }] } }
    } else if (k.code === 'LOCKED') {
      const file = failureFile(text)
      if (file) message = `Git is locked: ${file} exists. Wait for the other Git operation to finish, then try again.`
      blocker = { ...(file ? { files: [file] } : {}), actions: [{ id: 'retry', label: 'Try again' }] }
    } else if (k.code === 'PERMISSION') {
      const file = failureFile(text)
      if (file) { message = `The operating system refused access to ${file}. It may be open in another program, or you may not have permission.`; blocker = { files: [file], actions: [{ id: 'retry', label: 'Try again' }] } }
    } else if (k.code === 'CONFLICTS') {
      blocker = { actions: [{ id: 'view-conflicts', label: 'View conflicts' }] }
    }
    return { code: k.code, message, detail, ...(blocker ? { blocker } : {}) }
  }
  return { code: 'GIT_FAILED', message: fallback, detail }
}
