import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { ExecResult } from '../../src/core/exec.js'
import { NativeShell, type HostShell, type RunOpts } from '../../src/core/runners/hosts.js'
import type { RunnerHost, RunnerOs } from '../../src/shared/runners.js'
import {
  DepsCache, inspectDependencies, parsePosixDepsOutput, parseWindowsDepsOutput, validateExtras, verifiedInFor,
  POSIX_DEPS_SCRIPT, WINDOWS_DEPS_SCRIPT, type ParseCtx,
} from '../../src/core/runners/deps.js'
import type { DependencyReport } from '../../src/shared/deps.js'

type Tool = { l?: string; r?: string; v?: [number, string]; x?: [number, string] }
/** Builds what POSIX_DEPS_SCRIPT prints. */
function posixOut(tools: Record<string, Tool>, o: { user?: string; runnerPath?: '.path' | '.env' | ''; service?: boolean } = {}): string {
  const out = ['@@META\tprobe\t1', `@@META\tuser\t${o.user ?? 'farmaan'}`, '@@META\tsystem\tLinux', `@@META\trunnerpath\t${o.runnerPath ?? ''}`, `@@META\tservice\t${o.service ? 1 : 0}`]
  for (const [tag, t] of Object.entries(tools)) {
    out.push(`@@LOOK\t${tag}\tL\t${t.l ?? ''}`)
    if (o.runnerPath) out.push(`@@LOOK\t${tag}\tR\t${t.r ?? ''}`)
    for (const [k, v] of [['V', t.v], ['X', t.x]] as const) if (v) out.push(`@@RUN\t${tag}\t${k}\t${v[0]}`, ...v[1].split('\n').map(l => `|${l}`), '@@END')
  }
  out.push('@@DONE')
  return out.join('\n') + '\n'
}
const ALL = ['git', 'python3', 'python', 'pip', 'node', 'npm', 'java', 'mvn', 'gradle', 'dotnet', 'docker', 'tesseract', 'make', 'gcc', 'curl', 'unzip']
const missingAll = () => Object.fromEntries(ALL.map(t => [t, {} as Tool]))

class FakeHost implements HostShell {
  calls: { file: string; args: string[]; opts?: RunOpts }[] = []
  constructor(readonly host: RunnerHost, readonly os: RunnerOs, private reply: (file: string, args: string[]) => ExecResult | Promise<ExecResult>) {}
  private go(file: string, args: string[], opts?: RunOpts) { this.calls.push({ file, args, opts }); return Promise.resolve(this.reply(file, args)) }
  run(file: string, args: string[], opts?: RunOpts) { return this.go(file, args, opts) }
  script(script: string, args: string[], opts?: RunOpts) { return this.go('sh', [script, ...args], opts) }
  readFile = async () => null; exists = async () => false; isDir = async () => false; listDir = async () => null
  mkdirp = async () => ({ ok: true }); remove = async () => ({ ok: true }); move = async () => ({ ok: true }); putFile = async () => ({ ok: true })
  elevated() { return null }; elevationNote() { return null }
}
const ok = (stdout: string, extra: Partial<ExecResult> = {}): ExecResult => ({ code: 0, stdout, stderr: '', timedOut: false, ...extra })
const by = (r: DependencyReport, id: string) => r.results.find(x => x.id === id)!
const wsl = (out: string) => new FakeHost({ kind: 'wsl', distro: 'Ubuntu-24.04' }, 'linux', () => ok(out))
const RUNNER = '/home/farmaan/actions-runner-caissatrainer'
const run = (shell: HostShell, extra: Parameters<typeof inspectDependencies>[1] extends infer T ? Partial<T> : never = {}) => inspectDependencies(shell, { cwd: RUNNER, refresh: true, cache: null, ...extra })

describe('results come only from the queried environment', () => {
  const windowsJson = JSON.stringify({ probe: 1, user: 'farmaan', runnerpath: '', tools: [{ tag: 'tesseract', l: 'C:\\Program Files\\Tesseract-OCR\\tesseract.exe', v: { rc: 0, out: 'tesseract v5.3.3.20231005\r\n', timedOut: false } }] })
  it('Tesseract on Windows does not make it present in the WSL distribution, and each result says where it was verified', async () => {
    const win = new FakeHost({ kind: 'native' }, 'windows', () => ok(windowsJson))
    const ubuntu = wsl(posixOut({ ...missingAll(), git: { l: '/usr/bin/git', r: '/usr/bin/git', v: [0, 'git version 2.43.0'] } }, { runnerPath: '.path', service: true }))
    const w = await run(win, { cwd: 'C:\\actions-runner' }), u = await run(ubuntu)
    expect(by(w, 'tesseract')).toMatchObject({ status: 'found', version: '5.3.3.20231005', verifiedIn: { label: 'Windows', os: 'windows' } })
    expect(by(u, 'tesseract')).toMatchObject({ status: 'missing', version: null, path: null, verifiedIn: { label: 'WSL Ubuntu-24.04', host: { kind: 'wsl', distro: 'Ubuntu-24.04' } }, installHint: 'open-terminal' })
    expect(by(u, 'git')).toMatchObject({ status: 'found', version: '2.43.0', path: '/usr/bin/git' })
    expect(u.hostLabel).toBe('WSL Ubuntu-24.04')
    expect(u.user).toBe('farmaan')
    // the WSL fake was asked once, with a fixed script and the runner directory as a positional argument
    expect(ubuntu.calls).toHaveLength(1)
    expect(ubuntu.calls[0].args[0]).toBe(POSIX_DEPS_SCRIPT)
    expect(ubuntu.calls[0].args[1]).toBe(RUNNER)
    expect(win.calls[0].file).toBe('powershell.exe')
    expect(win.calls[0].opts?.env?.GM_RUNNER_DIR).toBe('C:\\actions-runner')
  })
})

describe('runner PATH', () => {
  const tools = { ...missingAll(), node: { l: '/home/farmaan/.nvm/bin/node' }, git: { l: '/usr/bin/git', r: '/usr/bin/git', v: [0, 'git version 2.43.0'] as [number, string] } }
  it('is not found when only the login PATH has it, and is found only when executable on the runner PATH', async () => {
    const r = await run(wsl(posixOut(tools, { runnerPath: '.path', service: true })))
    expect(by(r, 'node')).toMatchObject({ status: 'missing', detail: 'Not on the runner PATH', loginPath: '/home/farmaan/.nvm/bin/node', via: 'service-path', path: null })
    expect(by(r, 'git')).toMatchObject({ status: 'found', via: 'service-path' })
    expect(by(r, 'make')).toMatchObject({ status: 'missing' })
    expect(by(r, 'make').detail).toBeUndefined()
    expect(r.runnerEnvNote).toMatch(/recorded/)
  })
  it('without a recorded PATH only the login PATH is used and the note says so', async () => {
    const r = await run(wsl(posixOut({ ...missingAll(), node: { l: '/usr/bin/node', v: [0, 'v22.11.0'] } }, { service: true })))
    expect(by(r, 'node')).toMatchObject({ status: 'found', version: '22.11.0', via: 'path-lookup' })
    expect(r.runnerEnvNote).toMatch(/no recorded PATH/)
  })
})

describe('version parsing fixtures', () => {
  const ctx: ParseCtx = { verifiedIn: verifiedInFor({ kind: 'native' }, 'linux'), checkedAt: '2026-01-01T00:00:00.000Z' }
  const parse = (tools: Record<string, Tool>) => parsePosixDepsOutput(posixOut(tools), ctx)
  const f = (p: string, v: string, rc = 0): Tool => ({ l: p, v: [rc, v] })
  const res = parse({
    ...missingAll(),
    git: f('/usr/bin/git', 'git version 2.43.0'),
    python3: f('/usr/bin/python3', 'Python 3.12.3'),
    pip: f('/usr/bin/pip3', 'pip 24.0 from /usr/lib/python3/dist-packages/pip (python 3.12)'),
    node: f('/usr/bin/node', 'v22.11.0'),
    npm: f('/usr/bin/npm', '10.9.0'),
    java: f('/usr/bin/java', 'openjdk version "21.0.4" 2024-07-16\nOpenJDK Runtime Environment (build 21.0.4+7-Ubuntu-1ubuntu224.04)\nOpenJDK 64-Bit Server VM (build 21.0.4+7, mixed mode, sharing)'),
    mvn: f('/usr/bin/mvn', 'Apache Maven 3.9.6 (bc0240f3c744dd6852bd49fb16ac3ac5b6e7d8e0)\nMaven home: /usr/share/maven'),
    gradle: f('/usr/bin/gradle', '\n------------------------------------------------------------\nGradle 8.5\n------------------------------------------------------------'),
    dotnet: f('/usr/bin/dotnet', '6.0.428 [/usr/lib/dotnet/sdk]\n8.0.100 [/usr/lib/dotnet/sdk]'),
    docker: { l: '/usr/bin/docker', v: [0, 'Docker version 24.0.7, build afdd53b'], x: [1, 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?'] },
    tesseract: { l: '/usr/bin/tesseract', v: [0, 'tesseract 5.3.4\n leptonica-1.82.0\n  libgif 5.2.1 : libjpeg 8d (libjpeg-turbo 2.1.5) : libpng 1.6.43'], x: [0, 'List of available languages in "/usr/share/tesseract-ocr/5/tessdata/" (3):\neng\nosd\nfra'] },
    make: f('/usr/bin/make', 'GNU Make 4.3\nBuilt for x86_64-pc-linux-gnu'),
    gcc: f('/usr/bin/gcc', 'gcc (Ubuntu 13.2.0-23ubuntu4) 13.2.0'),
    curl: f('/usr/bin/curl', 'curl 8.5.0 (x86_64-pc-linux-gnu) libcurl/8.5.0'),
    unzip: f('/usr/bin/unzip', 'UnZip 6.00 of 20 April 2009, by Debian.'),
  })
  const v = (id: string) => res.results.find(r => r.id === id)!
  it.each([['git', '2.43.0'], ['python3', '3.12.3'], ['pip', '24.0'], ['node', '22.11.0'], ['npm', '10.9.0'], ['java', '21.0.4'], ['mvn', '3.9.6'], ['gradle', '8.5'], ['dotnet', '8.0.100'], ['docker', '24.0.7'], ['tesseract', '5.3.4'], ['make', '4.3'], ['gcc', '13.2.0'], ['curl', '8.5.0'], ['unzip', '6.00']])('%s -> %s', (id, ver) => {
    expect(v(id)).toMatchObject({ status: 'found', version: ver })
  })
  it('lists tesseract languages and dotnet SDKs briefly', () => {
    expect(v('tesseract').detail).toBe('3 languages: eng, osd, fra')
    expect(v('dotnet').detail).toBe('SDKs: 6.0.428, 8.0.100')
  })
  it('docker with the daemon down is found, with the reason', () => {
    expect(v('docker')).toMatchObject({ status: 'found', version: '24.0.7' })
    expect(v('docker').detail).toMatch(/^Docker daemon is not reachable: Cannot connect/)
  })
  it('java on stderr (java -version style, old 1.8 string) and a runtime-only dotnet', () => {
    const r = parse({ ...missingAll(), java: f('/usr/bin/java', 'java version "1.8.0_392"\nJava(TM) SE Runtime Environment'), dotnet: f('/usr/bin/dotnet', '') })
    expect(r.results.find(x => x.id === 'java')).toMatchObject({ status: 'found', version: '1.8.0_392' })
    expect(r.results.find(x => x.id === 'dotnet')).toMatchObject({ status: 'missing' })
  })
  it('a failing version command is an error, distinct from missing; a timeout is an error too', () => {
    const r = parse({ ...missingAll(), node: f('/usr/bin/node', 'node: error while loading shared libraries: libfoo.so', 127), npm: { l: '/usr/bin/npm', v: [124, ''] } })
    expect(r.results.find(x => x.id === 'node')).toMatchObject({ status: 'error', path: '/usr/bin/node', version: null })
    expect(r.results.find(x => x.id === 'node')!.detail).toMatch(/shared libraries/)
    expect(r.results.find(x => x.id === 'npm')).toMatchObject({ status: 'error', detail: 'Version command timed out' })
  })
})

describe('Windows PowerShell JSON', () => {
  const ctx: ParseCtx = { verifiedIn: verifiedInFor({ kind: 'native' }, 'windows'), checkedAt: 'now' }
  const j = {
    probe: 1, user: 'farmaan', runnerpath: '.path', tools: [
      { tag: 'git', l: 'C:\\Git\\git.exe', r: 'C:\\Git\\git.exe', v: { rc: 0, out: 'git version 2.45.1.windows.1\r\n', timedOut: false } },
      { tag: 'python', l: 'C:\\Users\\f\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe', r: 'C:\\Users\\f\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe', v: { rc: 9009, out: 'Python was not found', timedOut: false } },
      { tag: 'java', l: 'C:\\jdk\\bin\\java.exe', r: null, v: null },
      { tag: 'node', l: 'C:\\node\\node.exe', r: 'C:\\node\\node.exe', v: { rc: null, out: '', timedOut: true } },
      { tag: 'py', l: 'C:\\Windows\\py.exe', r: 'C:\\Windows\\py.exe', v: { rc: 0, out: 'Python 3.12.3\n', timedOut: false } },
    ],
  }
  const r = parseWindowsDepsOutput(`noise\n${JSON.stringify(j)}\n`, ctx)
  const by2 = (id: string) => r.results.find(x => x.id === id)!
  it('parses found, store alias, runner-path miss, timeout, and unreported tools', () => {
    expect(r.user).toBe('farmaan')
    expect(by2('git')).toMatchObject({ status: 'found', version: '2.45.1.windows.1', via: 'service-path', verifiedIn: { label: 'Windows' } })
    expect(by2('python').status).toBe('missing')
    expect(by2('java')).toMatchObject({ status: 'missing', detail: 'Not on the runner PATH' })
    expect(by2('node')).toMatchObject({ status: 'error', detail: 'Version command timed out' })
    expect(by2('py')).toMatchObject({ status: 'found', version: '3.12.3' })
    expect(by2('docker').status).toBe('unknown')
  })
  it('the Windows script is constant text with no double quotes (it is passed as -EncodedCommand)', () => {
    expect(WINDOWS_DEPS_SCRIPT).not.toMatch(/"/)
  })
})

describe('failures of the probe itself', () => {
  it('malformed output gives unknown for every tool, never found', async () => {
    for (const out of ['', 'garbage\n@@LOOK\tgit', '{not json']) {
      for (const shell of [wsl(out), new FakeHost({ kind: 'native' }, 'windows', () => ok(out))]) {
        const r = await run(shell)
        // empty successful output cannot be read: reported as an error of the check, not as missing
        expect(r.results.every(x => x.status === 'error' || x.status === 'unknown')).toBe(true)
        expect(r.results.some(x => x.status === 'found' || x.status === 'missing')).toBe(false)
      }
    }
  })
  it('truncated output keeps what was read and leaves the rest unknown', () => {
    const text = posixOut({ git: { l: '/usr/bin/git', v: [0, 'git version 2.43.0'] } }).replace('@@DONE\n', '')
    const r = parsePosixDepsOutput(text, { verifiedIn: verifiedInFor({ kind: 'native' }, 'linux'), checkedAt: 'x', missingDetail: 'Not checked: timed out' })
    expect(r.results.find(x => x.id === 'git')!.status).toBe('found')
    expect(r.results.find(x => x.id === 'java')).toMatchObject({ status: 'unknown', detail: 'Not checked: timed out' })
  })
  it('a whole-probe timeout with partial output', async () => {
    const partial = posixOut({ git: { l: '/usr/bin/git', v: [0, 'git version 2.43.0'] } }, {}).replace('@@DONE\n', '')
    const r = await run(new FakeHost({ kind: 'native' }, 'linux', () => ({ code: null, stdout: partial, stderr: '', timedOut: true })))
    expect(by(r, 'git').status).toBe('found')
    expect(by(r, 'node')).toMatchObject({ status: 'unknown' })
    expect(by(r, 'node').detail).toMatch(/timed out/)
  })
  it('timeout without output and spawn errors are errors', async () => {
    const t = await run(new FakeHost({ kind: 'native' }, 'linux', () => ({ code: null, stdout: '', stderr: '', timedOut: true })))
    expect(by(t, 'git')).toMatchObject({ status: 'error', detail: 'The dependency check timed out' })
    const s = await run(new FakeHost({ kind: 'wsl', distro: 'Gone' }, 'linux', () => ({ code: null, stdout: '', stderr: '', timedOut: false, spawnError: 'ENOENT wsl.exe' })))
    expect(by(s, 'git').detail).toMatch(/Could not run the check: ENOENT/)
    expect(s.hostLabel).toBe('WSL Gone')
  })
  it('a failing script reports the first stderr line', async () => {
    const r = await run(new FakeHost({ kind: 'native' }, 'linux', () => ({ code: 2, stdout: '', stderr: 'sh: oops\nsecond', timedOut: false })))
    expect(by(r, 'git').detail).toBe('The dependency check failed: sh: oops')
  })
  it('can be cancelled through an AbortSignal', async () => {
    const ac = new AbortController()
    const shell = new FakeHost({ kind: 'native' }, 'linux', () => new Promise<ExecResult>(() => {}))
    const p = run(shell, { signal: ac.signal })
    ac.abort()
    const r = await p
    expect(r.results.every(x => x.status === 'unknown' && x.detail === 'Cancelled')).toBe(true)
  })
})

describe('extra tools', () => {
  it.each([[';rm'], ['$(x)'], ['a b'], ['`id`'], ['x|y'], ['../bin/x'], ['-rf'], ['a\nb'], ['']])('rejects command %j', c => {
    const { valid, rejected } = validateExtras([{ id: 'x', label: 'X', command: c }])
    expect(valid).toEqual([])
    expect(rejected).toHaveLength(1)
  })
  it('rejects bad ids and arguments, accepts plain ones', () => {
    expect(validateExtras([{ id: 'a b', label: '', command: 'ok' }]).valid).toEqual([])
    expect(validateExtras([{ id: 'a', label: '', command: 'ok', args: ['--v;x'] }]).valid).toEqual([])
    expect(validateExtras([{ id: 'a', label: '', command: 'ok', args: ['$(x)'] }]).valid).toEqual([])
    expect(validateExtras([{ id: 'a', label: 'Cargo', command: 'cargo', args: ['--version'] }, { id: 'a', label: '', command: 'x' }])).toMatchObject({ valid: [{ command: 'cargo' }], rejected: [{ id: 'a' }] })
  })
  it('only valid extras reach the script, as positional arguments; rejected ones show as errors', async () => {
    const shell = wsl(posixOut({ ...missingAll(), X0: { l: '/usr/bin/cargo', v: [0, 'cargo 1.80.0 (a4f5 2024-07-01)'] } }))
    const r = await run(shell, { extra: [{ id: 'cargo', label: 'Cargo', command: 'cargo', args: ['--version'] }, { id: 'evil', label: 'x', command: ';rm -rf /' }, { id: 'sub', label: 'x', command: '$(x)' }] })
    expect(shell.calls[0].args.slice(1)).toEqual([RUNNER, 'cargo', '--version'])
    expect(by(r, 'extra:cargo')).toMatchObject({ status: 'found', version: '1.80.0', label: 'Cargo', optional: true })
    expect(by(r, 'extra:evil').status).toBe('error')
    expect(by(r, 'extra:evil').detail).toMatch(/^Not checked/)
    expect(by(r, 'extra:sub').status).toBe('error')
  })
})

describe('cache', () => {
  it('serves cached reports within the TTL, refreshes on request, shares in-flight probes', async () => {
    let n = 0, t = 1000
    const shell = new FakeHost({ kind: 'native' }, 'linux', () => { n++; return ok(posixOut({ git: { l: '/usr/bin/git', v: [0, 'git version 2.43.0'] } })) })
    const cache = new DepsCache(5000, () => t)
    const opts = { cwd: RUNNER, cache, now: () => t }
    await inspectDependencies(shell, { ...opts, refresh: false })
    await inspectDependencies(shell, { ...opts, refresh: false })
    expect(n).toBe(1)
    await inspectDependencies(shell, { ...opts, refresh: true })
    expect(n).toBe(2)
    t += 6000
    await inspectDependencies(shell, { ...opts, refresh: false })
    expect(n).toBe(3)
    const [a, b] = await Promise.all([inspectDependencies(shell, { ...opts, cwd: '/other', refresh: false }), inspectDependencies(shell, { ...opts, cwd: '/other', refresh: false })])
    expect(n).toBe(4)
    expect(a).toBe(b)
  })
  it('does not cache a failed probe', async () => {
    let n = 0
    const shell = new FakeHost({ kind: 'native' }, 'linux', () => { n++; return { code: null, stdout: '', stderr: '', timedOut: true } })
    const cache = new DepsCache()
    await inspectDependencies(shell, { cwd: '/r', refresh: false, cache })
    await inspectDependencies(shell, { cwd: '/r', refresh: false, cache })
    expect(n).toBe(2)
  })
})

describe.skipIf(process.platform === 'win32')('real shell on this machine', () => {
  const sh = (() => { try { execFileSync('sh', ['-c', 'command -v git && command -v node'], { stdio: 'pipe' }); return true } catch { return false } })()
  it.skipIf(!sh)('finds git and node with versions and reports a bogus tool as missing', async () => {
    const r = await inspectDependencies(new NativeShell(), { cwd: tmpdir(), refresh: true, cache: null, extra: [{ id: 'bogus', label: 'Bogus', command: 'definitely-not-a-tool-xyz' }] })
    expect(by(r, 'git')).toMatchObject({ status: 'found', via: 'path-lookup' })
    expect(by(r, 'git').version).toMatch(/^\d+\.\d+/)
    expect(by(r, 'node')).toMatchObject({ status: 'found' })
    expect(by(r, 'node').version).toMatch(/^\d+\.\d+\.\d+/)
    expect(by(r, 'node').path).toMatch(/^\//)
    expect(by(r, 'extra:bogus')).toMatchObject({ status: 'missing', version: null, path: null })
    expect(r.user).toBeTruthy()
    expect(r.results.every(x => x.verifiedIn.label !== '')).toBe(true)
  }, 120_000)
  it.skipIf(!sh)('honours a runner .path file: a tool outside the recorded PATH is "Not on the runner PATH"', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deps-'))
    try {
      const bin = join(dir, 'bin'); mkdirSync(bin)
      symlinkSync(execFileSync('sh', ['-c', 'command -v git']).toString().trim(), join(bin, 'git'))
      writeFileSync(join(dir, '.path'), bin + '\n')
      const r = await inspectDependencies(new NativeShell(), { cwd: dir, refresh: true, cache: null })
      expect(by(r, 'git')).toMatchObject({ status: 'found', via: 'service-path', path: join(bin, 'git') })
      expect(by(r, 'node')).toMatchObject({ status: 'missing', detail: 'Not on the runner PATH' })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 120_000)
})
