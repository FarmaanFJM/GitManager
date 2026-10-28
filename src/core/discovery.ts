import { access, open, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { Location, Result } from '../shared/types.js'
import { programSpec, run, type HostOs } from './exec.js'
import { flavorOf, normalizePath } from './paths.js'

/** Folders that never contain the user's repositories but can be huge: dependencies, build output, OS and app data. */
export const SKIP = [
  'node_modules', 'vendor', 'target', 'build', 'dist', 'out', 'bin', 'obj', 'venv', '__pycache__', 'bower_components', 'Pods', 'snap',
  'AppData', 'Library', 'Applications', 'Windows', 'Program Files', 'Program Files (x86)', 'ProgramData', 'PerfLogs', 'Recovery',
  'System Volume Information', 'MSOCache', 'OneDriveTemp',
]
const MAX_DIRS = 20_000
const MAX_REPOS = 500

export type Found = { location: Location; worktree: boolean }
export type ScanOptions = { deadlineMs?: number; maxDirs?: number; readdirImpl?: typeof readdir }

/**
 * Classifies a `.git` entry. A directory with HEAD is a repository. A `.git` file holds `gitdir: <path>`: a path into
 * `<repo>/.git/worktrees/<name>` is a linked worktree (registered), a path into `.git/modules/` is a submodule (part of
 * its parent, not registered), anything else is a repository with a separate git directory.
 */
export function classifyGitFile(content: string): 'worktree' | 'submodule' | 'repository' | null {
  const m = /^gitdir:\s*(.+)$/m.exec(content)
  if (!m) return null
  const p = m[1].trim().replace(/\\/g, '/')
  if (/\/worktrees\/[^/]+\/?$/.test(p)) return 'worktree'
  if (/(^|\/)modules\//.test(p)) return 'submodule'
  return 'repository'
}

async function readHead(file: string, bytes = 512): Promise<string> {
  const h = await open(file, 'r')
  try { const b = Buffer.alloc(bytes); const { bytesRead } = await h.read(b, 0, bytes, 0); return b.subarray(0, bytesRead).toString('utf8') } finally { await h.close() }
}

/**
 * Bounded search for Git repositories below a root: at most `depth` levels, hidden, dependency and system folders
 * skipped, symbolic links and junctions not followed, unreadable folders ignored, and hard caps on folders visited,
 * repositories returned and time spent. Read-only: it only lists folders and reads `.git` files.
 */
export async function discover(root: Location, depth: number, opts: ScanOptions = {}): Promise<Result<Found[]>> {
  return root.kind === 'wsl' ? discoverWsl(root, depth, opts) : discoverNative(root.path, depth, opts)
}

async function discoverNative(rootPath: string, depth: number, opts: ScanOptions): Promise<Result<Found[]>> {
  const lib = flavorOf(rootPath) === 'win32' ? path.win32 : path.posix
  const found: Found[] = []
  const seen = new Set<string>()
  const deadline = Date.now() + (opts.deadlineMs ?? 30_000)
  const maxDirs = opts.maxDirs ?? MAX_DIRS
  let visited = 0
  let queue: string[] = [rootPath]
  const list = (opts.readdirImpl ?? readdir) as typeof readdir
  try { await list(rootPath) } catch (e) { return { ok: false, error: { code: 'NOT_FOUND', message: `The folder ${rootPath} cannot be read.`, detail: (e as Error).message } } }
  for (let level = 0; level <= depth && queue.length; level++) {
    const next: string[] = []
    for (const dir of queue) {
      if (++visited > maxDirs || found.length >= MAX_REPOS || Date.now() > deadline) return { ok: true, value: found }
      let entries
      try { entries = await list(dir, { withFileTypes: true }) } catch { continue } // permission denied, vanished: skip
      const git = entries.find(e => e.name === '.git')
      if (git) {
        const gp = lib.join(dir, '.git')
        let kind: 'worktree' | 'submodule' | 'repository' | null = null
        try {
          if (git.isDirectory()) { await access(lib.join(gp, 'HEAD')); kind = 'repository' }
          else if (git.isFile()) kind = classifyGitFile(await readHead(gp))
        } catch { kind = null }
        if (kind === 'repository' || kind === 'worktree') {
          // Collapse junctions, symbolic links and letter case to one path, so the same folder is not found twice.
          let real = dir
          try { real = await realpath(dir) } catch { /* keep the path as found */ }
          const id = flavorOf(real) === 'win32' ? normalizePath(real, 'win32').toLowerCase() : normalizePath(real, 'posix')
          if (!seen.has(id)) { seen.add(id); found.push({ location: { kind: 'native', path: normalizePath(real) }, worktree: kind === 'worktree' }) }
        }
      }
      if (level === depth) continue
      for (const e of entries) {
        if (!e.isDirectory() || e.isSymbolicLink() || e.name.startsWith('.') || e.name.startsWith('$')) continue
        if (SKIP.includes(e.name)) continue
        next.push(lib.join(dir, e.name))
      }
    }
    queue = next
  }
  return { ok: true, value: found }
}

/**
 * The same search inside a WSL distribution, as one `find` run there. It stays on the Linux filesystem (`-xdev`, and
 * 9p/drvfs mounts are pruned), so Windows drives under /mnt are never scanned a second time through WSL.
 */
export function wslScanScript(): string {
  const names = SKIP.map(n => `-name '${n.replace(/'/g, `'\\''`)}'`).join(' -o ')
  return [
    'root=$1; depth=$2',
    `find "$root" -xdev -mindepth 1 -maxdepth "$depth" \\( -fstype 9p -o -fstype drvfs -o -path /mnt -o -path '/mnt/*' -o ${names} -o \\( -name '.*' ! -name .git \\) \\) -prune -o -name .git -print -prune 2>/dev/null | head -n ${MAX_REPOS * 2} | while IFS= read -r g; do`,
    '  d=${g%/.git}',
    '  if [ -d "$g" ]; then [ -f "$g/HEAD" ] && printf "R\\t%s\\n" "$d"',
    '  else l=$(head -c 512 "$g" 2>/dev/null); case "$l" in *"/worktrees/"*) printf "W\\t%s\\n" "$d";; *"modules/"*) ;; "gitdir: "*) printf "R\\t%s\\n" "$d";; esac; fi',
    'done',
    'exit 0',
  ].join('\n')
}

export function parseWslScan(out: string, distro: string): Found[] {
  return out.split('\n').map(l => l.trim()).filter(l => /^[RW]\t\//.test(l)).slice(0, MAX_REPOS)
    .map(l => ({ location: { kind: 'wsl' as const, distro, path: normalizePath(l.slice(2) || '/', 'posix') }, worktree: l[0] === 'W' }))
    .filter(f => !f.location.path.startsWith('/mnt/'))
}

async function discoverWsl(root: Extract<Location, { kind: 'wsl' }>, depth: number, opts: ScanOptions): Promise<Result<Found[]>> {
  if (root.path === '/mnt' || root.path.startsWith('/mnt/')) return { ok: false, error: { code: 'WINDOWS_MOUNT', message: `${root.path} is a Windows drive seen from WSL. Search it as a Windows folder instead.` } }
  const r = await run(programSpec({ kind: 'wsl', distro: root.distro }, 'sh', ['-c', wslScanScript(), 'sh', root.path, String(depth + 1)]), { timeoutMs: opts.deadlineMs ?? 60_000 })
  if (r.spawnError) return { ok: false, error: { code: 'WSL_MISSING', message: 'WSL is not available on this computer.' } }
  const found = parseWslScan(r.stdout, root.distro)
  if (r.code !== 0 && !found.length) return { ok: false, error: { code: 'NOT_FOUND', message: `The folder ${root.path} cannot be read in ${root.distro}.`, detail: r.stderr.trim() } }
  return { ok: true, value: found }
}

/** The home folder of a WSL distribution's default user, asked from inside the distribution (no user name is assumed). */
export async function wslHome(distro: string): Promise<string | null> {
  const r = await run(programSpec({ kind: 'wsl', distro }, 'sh', ['-c', 'printf %s "$HOME"']), { timeoutMs: 20_000 })
  const home = r.stdout.trim()
  return r.code === 0 && home.startsWith('/') && !home.startsWith('/mnt/') && home !== '/' ? normalizePath(home, 'posix') : null
}

export type Target = { location: Location; depth: number; label: string }

/** Common names for development folders, relative to a home folder or a drive root. */
export const HOME_FOLDERS = ['source/repos', 'Projects', 'projects', 'Documents/GitHub', 'Documents/Projects', 'Documents/Code', 'code', 'Code', 'dev', 'Dev', 'Developer',
  'src', 'repos', 'Repos', 'git', 'Git', 'GitHub', 'workspace', 'Workspace', 'work', 'Work', 'Development', 'IdeaProjects', 'WebstormProjects', 'PycharmProjects', 'go/src']
export const DRIVE_FOLDERS = ['Projects', 'projects', 'dev', 'Dev', 'code', 'Code', 'src', 'repos', 'git', 'GitHub', 'workspace', 'Development', 'Work']

const exists = async (p: string, ms = 1500) => {
  // A disconnected network drive can stall for a long time; give each check a short budget.
  let timer: NodeJS.Timeout | undefined
  try { return await Promise.race([access(p).then(() => true, () => false), new Promise<boolean>(r => { timer = setTimeout(() => r(false), ms) })]) } finally { clearTimeout(timer) }
}

/**
 * Development folders that exist on this computer, found from the home folder and drive letters rather than from any
 * user name: <home>\source\repos, <home>\Projects, C:\Projects, D:\dev and so on, plus the home folder itself (one level).
 * Deep mode returns whole drives (Windows) or the whole home folder (macOS, Linux) with a larger depth.
 */
export async function commonTargets(os: HostOs, home: string, opts: { deep?: boolean; drives?: string[]; depth?: number } = {}): Promise<Target[]> {
  const win = os === 'windows'
  const lib = win ? path.win32 : path.posix
  const depth = opts.depth ?? 3
  const out: Target[] = []
  const add = async (p: string, d: number, label: string) => {
    const key = win ? normalizePath(p, 'win32').toLowerCase() : normalizePath(p, 'posix')
    if (out.some(t => (win ? normalizePath(t.location.path, 'win32').toLowerCase() : t.location.path) === key)) return
    if (await exists(p)) out.push({ location: { kind: 'native', path: normalizePath(p) }, depth: d, label })
  }
  const drives = win ? (opts.drives ?? 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(l => `${l}:\\`)) : []
  const liveDrives = win ? (await Promise.all(drives.map(async d => ((await exists(d)) ? d : null)))).filter(Boolean) as string[] : []
  if (opts.deep) {
    if (win) for (const d of liveDrives) await add(d, Math.max(depth, 4), d)
    else await add(home, Math.max(depth, 5), home)
    return out
  }
  if (home) {
    for (const f of HOME_FOLDERS) await add(lib.join(home, ...f.split('/')), depth, f)
    await add(home, 1, 'home')
  }
  for (const d of liveDrives) for (const f of DRIVE_FOLDERS) await add(lib.join(d, f), depth, lib.join(d, f))
  return out
}
