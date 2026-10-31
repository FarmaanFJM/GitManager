// Inspection and deletion of a repository's local folder. Pure orchestration over injected pieces (a HostShell for the file
// system, Git for facts, a trash function for the native recycle bin), so every rule is tested without touching the real machine.
//
// The rules, in one place:
//  - Nothing is deleted unless the path the user confirmed equals the registered path exactly and a fresh inspection has no blocker.
//  - Protected paths (roots, home folders and their ancestors, system folders, discovery roots, folders that contain other
//    registered repositories or runner installations) can never be deleted; neither can a path that is a symbolic link or
//    junction (the registered path must be the real folder), or a folder that is not the root of a working tree.
//  - Recoverable deletion is the default. When it is unavailable or fails, nothing is deleted until the caller asks for a
//    permanent deletion with a separate confirmation; there is no automatic fallback.
//  - Success is claimed only after the file system confirms the folder is gone; otherwise the remainder is reported.
import type { DeleteOutcome, DeletionFacts, DeletionReport, Location, Repo, TrashSupport } from '../shared/types.js'
import type { RunnerHost } from '../shared/runners.js'
import type { HostShell } from './runners/hosts.js'
import { installsOverlap } from './runners/model.js'
import type { Git } from './git/ops.js'
import { flavorOf, locationKey, normalizePath, wslToWindowsDrive } from './paths.js'

export type DeleteDeps = {
  git: Git
  shellFor: (loc: Location) => HostShell
  /** Moves a native path to the operating system's trash. Rejects when that is not possible. */
  trashNative: ((path: string) => Promise<void>) | null
  os: 'windows' | 'mac' | 'linux'
  /** The user's home folder on this computer. */
  home: string
  /** Other registered repositories. */
  repos: () => Repo[]
  /** Discovery roots (folders GitManager scans for repositories). */
  roots: () => Location[]
  /** Runner installations known to GitManager. */
  runnerInstalls: () => { host: RunnerHost; path: string }[]
  /** Names of running GitManager-managed services of a repository. */
  runningServices: (repoId: string) => string[]
  now?: () => number
}

const SYSTEM_POSIX = /^\/(bin|boot|dev|etc|lib|lib32|lib64|proc|root|run|sbin|snap|sys|usr|var|opt|srv|mnt|media|System|Library|Applications|Volumes|private|Users|home|tmp)$/
const SYSTEM_WIN = /^[a-z]:\\(windows|program files|program files \(x86\)|programdata|users|\$recycle\.bin|system volume information)$/i

const hostOf = (loc: Location): RunnerHost => (loc.kind === 'wsl' ? { kind: 'wsl', distro: loc.distro } : { kind: 'native' })
const isWsl = (loc: Location) => loc.kind === 'wsl'
const sepOf = (key: string) => (key.startsWith('win:') ? '\\' : '/')
const within = (inner: string, outer: string) => { const s = sepOf(outer); const a = inner.endsWith(s) ? inner : inner + s, b = outer.endsWith(s) ? outer : outer + s; return a.startsWith(b) }

/** The path of a repository as a Windows path when it is on a Windows drive (including /mnt/c seen from WSL), for the recycle bin. */
export function windowsPathOf(loc: Location): string | null {
  if (loc.kind === 'native') return flavorOf(loc.path) === 'win32' ? normalizePath(loc.path, 'win32') : null
  return wslToWindowsDrive(loc.path)
}

/**
 * Why a folder must never be deleted whatever the user confirms, from its path alone. `homes` are the user's home folders
 * (this computer's, and the WSL one derived from /home/<user>).
 */
export function protectedPathReason(loc: Location, home: string): string | null {
  const win = loc.kind === 'native' && flavorOf(loc.path) === 'win32'
  const p = normalizePath(loc.path, win ? 'win32' : 'posix')
  if (win) {
    if (/^[a-z]:\\?$/i.test(p)) return 'A drive root is never deleted.'
    if (/^\\\\[^\\]+\\[^\\]+\\?$/.test(p)) return 'A network share root is never deleted.'
    if (SYSTEM_WIN.test(p)) return 'A system folder is never deleted.'
    const h = normalizePath(home, 'win32')
    const k = p.toLowerCase(), hk = h.toLowerCase()
    if (k === hk) return 'Your home folder is never deleted.'
    if (within(hk + '\\', k + '\\') && k !== hk) return 'A folder that contains your home folder is never deleted.'
    if (/^[a-z]:\\users\\[^\\]+\\(desktop|documents|downloads|pictures|music|videos|appdata|onedrive)$/i.test(p)) return 'A standard user folder is never deleted.'
    if (/^[a-z]:\\(windows|program files|program files \(x86\)|programdata)\\/i.test(p)) return 'A folder inside a system location is never deleted.'
    return null
  }
  if (p === '/' || p === '') return 'The root folder is never deleted.'
  const abs = loc.kind === 'native' ? normalizePath(home, 'posix') : null
  if (SYSTEM_POSIX.test(p)) return 'A system or top-level folder is never deleted.'
  if (/^\/(bin|boot|dev|etc|lib|lib32|lib64|proc|run|sbin|sys|usr|System|Library|private)\//.test(p) && !/^\/(usr\/local|private\/var|private\/tmp)\//.test(p)) return 'A folder inside a system location is never deleted.'
  if (abs && (p === abs || (abs + '/').startsWith(p + '/'))) return p === abs ? 'Your home folder is never deleted.' : 'A folder that contains your home folder is never deleted.'
  if (/^\/(home|Users)\/[^/]+$/.test(p) || /^\/root$/.test(p)) return 'A home folder is never deleted.'
  if (/^\/(home|Users)\/[^/]+\/(Desktop|Documents|Downloads|Pictures|Music|Videos|Library|\.config|\.local|\.ssh)$/.test(p)) return 'A standard user folder is never deleted.'
  if (/^\/mnt\/[a-z]$/.test(p)) return 'A drive root is never deleted.'
  if (/^\/mnt\/[a-z]\/(Windows|Program Files|Program Files \(x86\)|ProgramData|Users)$/i.test(p)) return 'A Windows system folder is never deleted.'
  return null
}

const num = (s: string) => { const n = Number.parseInt(s.trim(), 10); return Number.isFinite(n) ? n : null }

export class RepoDeleter {
  private readonly now: () => number
  constructor(private readonly d: DeleteDeps) { this.now = d.now ?? Date.now }

  /* ------------------------------------------------------------ trash */

  async trashSupport(loc: Location, shell: HostShell): Promise<TrashSupport> {
    const win = windowsPathOf(loc)
    if (win || loc.kind === 'native') {
      const label = this.d.os === 'windows' ? 'Recycle Bin' : this.d.os === 'mac' ? 'Trash' : 'Trash'
      return this.d.trashNative ? { available: true, label, reason: null } : { available: false, label, reason: 'This system offers no way to move folders to the trash from GitManager.' }
    }
    // inside a WSL distribution: the distribution's own freedesktop trash through gio or trash-cli; the Windows recycle bin cannot hold Linux files
    const label = `Trash in ${isWsl(loc) ? (loc as { distro: string }).distro : 'WSL'}`
    const r = await shell.script('if command -v gio >/dev/null 2>&1; then echo gio; elif command -v trash-put >/dev/null 2>&1; then echo trash-put; fi', [], { timeoutMs: 20_000 })
    const tool = r.stdout.trim().split(/\s+/)[0]
    return tool === 'gio' || tool === 'trash-put'
      ? { available: true, label, reason: null }
      : { available: false, label, reason: `${isWsl(loc) ? (loc as { distro: string }).distro : 'This distribution'} has no trash tool (gio or trash-put), and the Windows Recycle Bin cannot hold files from the Linux file system. Recoverable deletion is not possible here.` }
  }

  private async moveToTrash(loc: Location, shell: HostShell): Promise<{ ok: true } | { ok: false; message: string }> {
    const win = windowsPathOf(loc)
    try {
      if (win || loc.kind === 'native') {
        if (!this.d.trashNative) return { ok: false, message: 'No trash is available on this system.' }
        await this.d.trashNative(win ?? loc.path)
        return { ok: true }
      }
      const gio = await shell.run('gio', ['trash', '--', loc.path], { timeoutMs: 600_000 })
      if (gio.code === 0) return { ok: true }
      if (gio.code === 127 || gio.spawnError) {
        const tp = await shell.run('trash-put', ['--', loc.path], { timeoutMs: 600_000 })
        return tp.code === 0 ? { ok: true } : { ok: false, message: (tp.stderr || tp.spawnError || `trash-put exited with ${tp.code}`).trim() }
      }
      return { ok: false, message: (gio.stderr || `gio exited with ${gio.code}`).trim() }
    } catch (e) { return { ok: false, message: (e as Error).message } }
  }

  /* ------------------------------------------------------------ inspection */

  private async facts(loc: Location): Promise<DeletionFacts> {
    const g = this.d.git
    const status = await g.status(loc).catch(() => null)
    const [only, stash] = await Promise.all([
      g.exec(loc, ['rev-list', '--count', '--branches', '--not', '--remotes']).catch(() => null),
      g.exec(loc, ['stash', 'list']).catch(() => null),
    ])
    const s = status && status.ok ? status.value : null
    return {
      changes: s ? s.changes : null,
      upstream: s?.upstream ?? null,
      ahead: s && s.upstream ? s.ahead : null,
      localOnlyCommits: only && only.code === 0 ? num(only.stdout) : null,
      stashes: stash && stash.code === 0 ? stash.stdout.split(/\r?\n/).filter(Boolean).length : null,
    }
  }

  /** Folders with their own .git below the root (not submodules, which have a .git file pointing into modules/). Bounded; never follows anything it cannot list. */
  private async nested(shell: HostShell, root: string, sep: string): Promise<{ repos: string[]; submodules: string[]; truncated: boolean }> {
    const repos: string[] = [], subs: string[] = []
    let visited = 0, truncated = false
    const skip = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'target', 'dist', 'build'])
    const walk = async (dir: string, depth: number) => {
      if (depth > 4 || truncated) return
      const names = await shell.listDir(dir)
      if (!names) return
      for (const n of names) {
        if (truncated) return
        if (skip.has(n)) continue
        const p = dir + sep + n
        if (++visited > 3000) { truncated = true; return }
        const gitPath = p + sep + '.git'
        if (await shell.isDir(gitPath)) { repos.push(p.slice(root.length + 1)); continue }
        if (await shell.exists(gitPath)) {
          const t = (await shell.readFile(gitPath, 512)) ?? ''
          if (/modules[\\/]/.test(t)) subs.push(p.slice(root.length + 1)); else repos.push(p.slice(root.length + 1))
          continue
        }
        if (await shell.isDir(p)) await walk(p, depth + 1)
      }
    }
    await walk(root, 0)
    return { repos, submodules: subs, truncated }
  }

  async inspect(repo: Repo): Promise<DeletionReport> {
    const loc = repo.location
    const shell = this.d.shellFor(loc)
    const win = loc.kind === 'native' && flavorOf(loc.path) === 'win32'
    const sep = win ? '\\' : '/'
    const norm = normalizePath(loc.path, win ? 'win32' : 'posix')
    const blockers: string[] = [], warnings: string[] = []
    const environment = loc.kind === 'wsl' ? `WSL: ${loc.distro}` : this.d.os === 'windows' ? 'Windows' : this.d.os === 'mac' ? 'macOS' : 'Linux'
    const display = loc.kind === 'wsl' ? `${loc.distro}: ${loc.path}` : loc.path
    const exists = await shell.isDir(norm)
    const base: DeletionReport = {
      repoId: repo.id, name: repo.name, location: loc, display, environment, exists, resolvedPath: null,
      facts: { changes: null, upstream: null, ahead: null, localOnlyCommits: null, stashes: null }, runningServices: this.d.runningServices(repo.id), nestedRepos: [], linkedWorktrees: [], worktreeOf: null,
      submodules: [], runnerInstallations: [], containedRepos: [], trash: { available: false, label: '', reason: null }, blockers, warnings, losesWork: false, inspectedAt: new Date(this.now()).toISOString(),
    }
    base.trash = await this.trashSupport(loc, shell)
    if (!exists) { warnings.push('The folder no longer exists. Nothing needs deleting; the repository can be removed from GitManager.'); return base }

    const prot = protectedPathReason(loc, this.d.home)
    if (prot) blockers.push(`${prot} (${display})`)

    // real path: a link or junction anywhere in the path means the registered path is not the folder that would be affected
    const real = await this.realPath(loc, shell, norm)
    base.resolvedPath = real
    if (real === null) warnings.push('The real location of the folder could not be resolved, so links in its path could not be ruled out.')
    else if (this.comparable(real, win) !== this.comparable(norm, win)) blockers.push(`The path is, or passes through, a symbolic link or junction (it resolves to ${real}). Register the real folder to delete it; GitManager will not delete through a link.`)

    // must be the root of a working tree
    const gitEntry = norm + sep + '.git'
    const isGitDir = await shell.isDir(gitEntry)
    const isGitFile = !isGitDir && (await shell.exists(gitEntry))
    if (!isGitDir && !isGitFile) blockers.push('This folder has no .git entry of its own, so it is not the root of a repository. Deleting it could remove something that is not this project.')
    if (isGitFile) {
      const t = ((await shell.readFile(gitEntry, 2048)) ?? '').trim()
      const m = /^gitdir:\s*(.+)$/m.exec(t)
      const target = m ? m[1].trim() : ''
      if (/[\\/]worktrees[\\/][^\\/]+[\\/]?$/.test(target)) {
        base.worktreeOf = target.replace(/[\\/]\.git[\\/]worktrees[\\/][^\\/]+[\\/]?$/, '') || target
        warnings.push(`This is a linked worktree of ${base.worktreeOf}. Deleting its folder does not delete that repository; its record of this worktree is cleaned up with git worktree prune.`)
      } else if (/modules[\\/]/.test(target)) {
        blockers.push(`This folder is a submodule (its Git data lives in ${target}). Remove it through its parent repository, not by deleting the folder here.`)
      }
    }

    // linked worktrees of this repository: their .git files point into this folder
    if (isGitDir) {
      const dirs = (await shell.listDir(gitEntry + sep + 'worktrees')) ?? []
      for (const name of dirs) {
        const gd = (await shell.readFile(gitEntry + sep + 'worktrees' + sep + name + sep + 'gitdir', 1024))?.trim().replace(/[\\/]\.git$/, '')
        if (!gd) continue
        const wexists = await shell.isDir(gd)
        const inside = within(this.comparable(gd, win), this.comparable(norm, win))
        base.linkedWorktrees.push({ path: gd, exists: wexists, inside })
        if (wexists && !inside) blockers.push(`A linked worktree of this repository exists outside it (${gd}). Its Git data lives in this folder, so deleting it would break that worktree. Remove the worktree first (git worktree remove).`)
      }
      const modules = await shell.exists(norm + sep + '.gitmodules')
      if (modules) {
        const t = (await shell.readFile(norm + sep + '.gitmodules', 64 * 1024)) ?? ''
        for (const m of t.matchAll(/^\s*path\s*=\s*(.+)$/gm)) base.submodules.push(m[1].trim())
      }
    }

    const nested = await this.nested(shell, norm, sep)
    base.nestedRepos = nested.repos
    for (const s of nested.submodules) if (!base.submodules.includes(s)) base.submodules.push(s)
    if (nested.truncated) warnings.push('The folder is very large; nested repositories beyond the first few thousand entries were not searched.')

    // other things GitManager knows that live inside
    const here = locationKey(loc)
    for (const r of this.d.repos()) {
      if (r.id === repo.id) continue
      const k = locationKey(r.location)
      if (within(k, here) && k !== here && !r.worktree) base.containedRepos.push({ id: r.id, name: r.name, path: r.location.path })
      else if (k === here) blockers.push(`${r.name} is registered for the same folder.`)
    }
    if (base.containedRepos.length) blockers.push(`This folder contains ${base.containedRepos.length} other repositor${base.containedRepos.length === 1 ? 'y' : 'ies'} registered in GitManager (${base.containedRepos.slice(0, 3).map(r => r.name).join(', ')}${base.containedRepos.length > 3 ? ', ...' : ''}). It looks like a parent folder, not one project. Remove those from GitManager first if you really mean to delete everything.`)
    for (const root of this.d.roots()) {
      const k = locationKey(root)
      if (k === here) blockers.push('This folder is a discovery root (a folder GitManager scans for repositories). Remove it from Settings first.')
      else if (within(k, here)) blockers.push(`A discovery root (${root.path}) is inside this folder. It looks like a parent folder, not one project.`)
    }
    const repoHost = hostOf(loc)
    for (const r of this.d.runnerInstalls()) if (installsOverlap({ host: repoHost, path: norm }, r)) base.runnerInstallations.push(r.path)
    if (base.runnerInstallations.length) blockers.push(`A GitHub Actions runner installation is inside this folder (${base.runnerInstallations[0]}). Deleting the folder would delete the runner, its credentials and work folder. Uninstall or move the runner first.`)

    if (base.runningServices.length) blockers.push(`Services started by GitManager are running for this repository (${base.runningServices.join(', ')}). Stop them first, then delete.`)

    base.facts = await this.facts(loc)
    const f = base.facts
    const lost: string[] = []
    if (f.changes === null) warnings.push('Git could not read this repository, so uncommitted work could not be checked. Assume there may be unsaved changes.')
    else {
      if (f.changes.staged + f.changes.unstaged + f.changes.conflicted > 0) lost.push('uncommitted changes')
      if (f.changes.untracked > 0) lost.push('untracked files')
    }
    if ((f.ahead ?? 0) > 0) lost.push(`${f.ahead} commit${f.ahead === 1 ? '' : 's'} not on ${f.upstream}`)
    else if (f.upstream === null && (f.localOnlyCommits ?? 0) > 0) lost.push(`${f.localOnlyCommits} commit${f.localOnlyCommits === 1 ? ' that exists' : 's that exist'} on no remote`)
    if ((f.stashes ?? 0) > 0) lost.push(`${f.stashes} stash${f.stashes === 1 ? '' : 'es'}`)
    base.losesWork = lost.length > 0
    if (lost.length) warnings.push(`Deleting the folder loses ${lost.join(', ')}.`)
    if (base.nestedRepos.length) warnings.push(`${base.nestedRepos.length} nested repositor${base.nestedRepos.length === 1 ? 'y' : 'ies'} inside the folder will be deleted with it (${base.nestedRepos.slice(0, 3).join(', ')}${base.nestedRepos.length > 3 ? ', ...' : ''}).`)
    if (base.linkedWorktrees.some(w => w.inside)) warnings.push('Linked worktrees stored inside this folder will be deleted with it.')
    if (base.submodules.length) warnings.push(`${base.submodules.length} submodule${base.submodules.length === 1 ? '' : 's'} and their checked-out files go with the folder.`)
    return base
  }

  private comparable(p: string, win: boolean) { const n = normalizePath(p, win ? 'win32' : 'posix'); return win ? n.toLowerCase() : n }

  private async realPath(loc: Location, shell: HostShell, norm: string): Promise<string | null> {
    if (loc.kind === 'native') {
      try { const { realpath } = await import('node:fs/promises'); const r = await realpath(norm); return normalizePath(r, flavorOf(norm)).replace(/^\\\\\?\\/, '') } catch { return null }
    }
    const r = await shell.run('realpath', ['-e', '--', norm], { timeoutMs: 20_000 })
    return r.code === 0 && r.stdout.trim() ? normalizePath(r.stdout.trim().split('\n')[0], 'posix') : null
  }

  /* ------------------------------------------------------------ deletion */

  /**
   * Deletes the folder. `confirmPath` must equal the registered path; `permanent` (with `confirmPermanent`) is the only way
   * past a missing or failed trash, and is never chosen by this function.
   */
  async delete(repo: Repo, o: { confirmPath: string; permanent?: boolean; confirmPermanent?: boolean }): Promise<DeleteOutcome & { report?: DeletionReport }> {
    if (o.confirmPath !== repo.location.path) return { ok: false, code: 'CONFIRM_MISMATCH', message: `The confirmed path does not match the repository folder. Nothing was deleted. The folder is ${repo.location.path}.` }
    const shell = this.d.shellFor(repo.location)
    const report = await this.inspect(repo)
    if (!report.exists) return { ok: true, deleted: false, alreadyGone: true, message: `${report.display} no longer exists, so nothing was deleted.`, notes: [], report }
    if (report.blockers.length) return { ok: false, code: 'REFUSED', message: `Nothing was deleted. ${report.blockers.join(' ')}`, report }
    if (o.permanent && !o.confirmPermanent) return { ok: false, code: 'CONFIRM_REQUIRED', message: 'Permanent deletion needs its own confirmation. Nothing was deleted.' }

    let method: 'trash' | 'permanent' = 'trash'
    if (o.permanent) {
      method = 'permanent'
      const rm = await shell.remove(this.pathOf(repo.location))
      if (!rm.ok) {
        const left = await this.remaining(shell, repo.location)
        if (left === null) return { ok: true, deleted: true, method, message: `${report.display} was deleted permanently.`, notes: [], report }
        return { ok: false, code: 'PARTIAL', message: `The deletion did not complete: ${rm.message ?? 'unknown error'}. ${left.length} item${left.length === 1 ? ' remains' : 's remain'} in ${report.display}. The repository stays in GitManager.`, detail: rm.message, remaining: left, report }
      }
    } else {
      if (!report.trash.available) return { ok: false, code: 'TRASH_UNAVAILABLE', message: `Recoverable deletion is not available here. ${report.trash.reason ?? ''} Nothing was deleted.`.trim(), canDeletePermanently: true, report }
      const t = await this.moveToTrash(repo.location, shell)
      if (!t.ok) {
        const still = await this.remaining(shell, repo.location)
        if (still !== null) return { ok: false, code: 'TRASH_FAILED', message: `The ${report.trash.label} could not take the folder: ${t.message}. Nothing was deleted.`, detail: t.message, canDeletePermanently: true, report }
      }
    }
    const left = await this.remaining(shell, repo.location)
    if (left !== null) return { ok: false, code: 'PARTIAL', message: `${report.display} still exists after the deletion (${left.length} item${left.length === 1 ? '' : 's'} remain${left.length === 1 ? 's' : ''}: ${left.slice(0, 5).join(', ')}${left.length > 5 ? ', ...' : ''}). It was not fully deleted, and the repository stays in GitManager.`, remaining: left, report }
    const notes: string[] = []
    if (report.worktreeOf) {
      const main = report.worktreeOf
      const mainLoc: Location = repo.location.kind === 'wsl' ? { kind: 'wsl', distro: repo.location.distro, path: main } : { kind: 'native', path: main }
      const pr = await this.d.git.exec(mainLoc, ['worktree', 'prune']).catch(() => null)
      notes.push(pr && pr.code === 0 ? `Pruned the stale worktree record in ${main}.` : `Run "git worktree prune" in ${main} to clear the stale worktree record.`)
    }
    return { ok: true, deleted: true, method, message: method === 'trash' ? `${report.display} was moved to the ${report.trash.label}.` : `${report.display} was deleted permanently.`, notes, report }
  }

  private pathOf(loc: Location) { return normalizePath(loc.path, loc.kind === 'native' && flavorOf(loc.path) === 'win32' ? 'win32' : 'posix') }

  /** null when the folder is gone; otherwise the names still in it (or ['(the folder itself)'] when it cannot be listed). */
  private async remaining(shell: HostShell, loc: Location): Promise<string[] | null> {
    const p = this.pathOf(loc)
    if (!(await shell.exists(p))) return null
    return (await shell.listDir(p)) ?? ['(the folder itself)']
  }
}
