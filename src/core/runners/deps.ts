// Inspects which developer tools a runner can actually use, inside the runner's OWN operating environment: the Windows
// shell for a Windows runner, the specific WSL distribution (or Linux/macOS/SSH host) for the others. A tool found in
// another environment proves nothing, so nothing is ever inferred across environments. The probe is one fixed POSIX sh
// script or one fixed PowerShell command; the only variable inputs are positional arguments / environment variables,
// never interpolated text. Read-only: nothing is installed, and the only "fix" offered is the id of a manual next step.
import type { RunnerHost, RunnerOs } from '../../shared/runners.js'
import type { BuiltinDependencyId, DependencyId, DependencyReport, DependencyResult, DependencyStatus, DependencyVerifiedIn, ExtraDependency } from '../../shared/deps.js'
import type { HostShell } from './hosts.js'

/* ------------------------------------------------------------ catalogue */

type Entry = {
  id: BuiltinDependencyId
  label: string
  optional: boolean
  /** Command names tried in order (the first one found wins). */
  cands: string[]
  winCands?: string[]
  posix?: boolean
  windows?: boolean
  vargs: string[]
  vto: number
  /** A second command (language list, daemon check). */
  xargs?: string[]
  xto?: number
  parse: (text: string) => string | null
}

const first = (re: RegExp) => (t: string) => { const m = re.exec(t); return m ? m[1] : null }
const firstLine = (t: string) => t.split(/\r?\n/).map(s => s.trim()).find(Boolean) ?? ''
const cmpVersion = (a: string, b: string) => {
  const pa = a.split(/[.-]/).map(n => parseInt(n, 10) || 0), pb = b.split(/[.-]/).map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] ?? 0) - (pb[i] ?? 0); if (d) return d }
  return 0
}
const dotnetSdks = (t: string) => t.split(/\r?\n/).map(l => /^(\d+\.\d+\.\d+\S*)\s+\[/.exec(l.trim())?.[1]).filter((x): x is string => !!x)

export const CATALOGUE: readonly Entry[] = [
  { id: 'git', label: 'Git', optional: false, cands: ['git'], vargs: ['--version'], vto: 10, parse: first(/git version (\S+)/i) },
  { id: 'python3', label: 'Python 3', optional: false, cands: ['python3'], vargs: ['--version'], vto: 10, parse: first(/Python (\d+\.\d+\.\d+\S*)/i) },
  { id: 'python', label: 'Python', optional: false, cands: ['python'], vargs: ['--version'], vto: 10, parse: first(/Python (\d+\.\d+\.\d+\S*)/i) },
  { id: 'py', label: 'Python launcher (py)', optional: false, cands: ['py'], posix: false, vargs: ['--version'], vto: 10, parse: first(/Python (\d+\.\d+\.\d+\S*)/i) },
  { id: 'pip', label: 'pip', optional: false, cands: ['pip3', 'pip'], winCands: ['pip', 'pip3'], vargs: ['--version'], vto: 15, parse: first(/^pip (\d+(?:\.\d+)+)/m) },
  { id: 'node', label: 'Node.js', optional: false, cands: ['node'], vargs: ['--version'], vto: 10, parse: first(/^v?(\d+\.\d+\.\d+\S*)/m) },
  { id: 'npm', label: 'npm', optional: false, cands: ['npm'], vargs: ['--version'], vto: 20, parse: first(/^v?(\d+\.\d+\.\d+\S*)/m) },
  { id: 'java', label: 'Java', optional: false, cands: ['java'], vargs: ['-version'], vto: 15, parse: t => first(/(?:openjdk|java) version "([^"]+)"/i)(t) ?? first(/^(?:openjdk|java) (\d+[\d._]*)/im)(t) },
  { id: 'mvn', label: 'Maven', optional: false, cands: ['mvn'], winCands: ['mvn'], vargs: ['--version'], vto: 25, parse: first(/Apache Maven (\S+)/i) },
  { id: 'gradle', label: 'Gradle', optional: false, cands: ['gradle'], vargs: ['--version'], vto: 40, parse: first(/^Gradle (\S+)/m) },
  { id: 'dotnet', label: '.NET SDK', optional: false, cands: ['dotnet'], vargs: ['--list-sdks'], vto: 20, parse: t => dotnetSdks(t).sort(cmpVersion).pop() ?? null },
  { id: 'docker', label: 'Docker', optional: false, cands: ['docker'], vargs: ['--version'], vto: 10, xargs: ['info', '--format', '{{.ServerVersion}}'], xto: 12, parse: first(/Docker version ([^,\s]+)/i) },
  { id: 'tesseract', label: 'Tesseract OCR', optional: false, cands: ['tesseract'], vargs: ['--version'], vto: 10, xargs: ['--list-langs'], xto: 10, parse: first(/tesseract\s+v?(\d+(?:\.\d+)+\S*)/i) },
  { id: 'make', label: 'make', optional: true, cands: ['make'], vargs: ['--version'], vto: 10, parse: first(/GNU Make (\S+)/i) },
  { id: 'gcc', label: 'gcc', optional: true, cands: ['gcc'], vargs: ['--version'], vto: 10, parse: t => { const m = firstLine(t).match(/\d+\.\d+(?:\.\d+)?/g); return m ? m[m.length - 1] : null } },
  { id: 'curl', label: 'curl', optional: true, cands: ['curl'], vargs: ['--version'], vto: 10, parse: first(/^curl (\S+)/im) },
  { id: 'unzip', label: 'unzip', optional: true, cands: ['unzip'], vargs: ['-v'], vto: 10, parse: first(/UnZip (\S+)/i) },
]
const catalogueFor = (windows: boolean) => CATALOGUE.filter(e => (windows ? e.windows !== false : e.posix !== false))
const genericVersion = first(/(\d+(?:\.\d+)+)/)

/* ------------------------------------------------------------ extra tools */

const EXTRA_CMD = /^[A-Za-z0-9._+-]+$/
const EXTRA_ARG = /^[A-Za-z0-9._+=-]{1,40}$/
const EXTRA_ID = /^[A-Za-z0-9._-]{1,40}$/
export const MAX_EXTRAS = 10

export type ValidExtra = { id: string; label: string; command: string; args: string[] }
export type RejectedExtra = { id: string; reason: string }

/** Only plain command names and plain arguments pass: no spaces, quotes, separators, substitutions or paths. */
export function validateExtras(extra: readonly ExtraDependency[] | undefined): { valid: ValidExtra[]; rejected: RejectedExtra[] } {
  const valid: ValidExtra[] = [], rejected: RejectedExtra[] = []
  const seen = new Set<string>()
  for (const e of extra ?? []) {
    const id = typeof e?.id === 'string' ? e.id : String(e?.id ?? '')
    const bad = (reason: string) => rejected.push({ id: id.slice(0, 40), reason })
    if (valid.length >= MAX_EXTRAS) { bad(`At most ${MAX_EXTRAS} additional tools are checked`); continue }
    if (!EXTRA_ID.test(id)) { bad('The tool id may only contain letters, digits, dot, dash and underscore'); continue }
    if (seen.has(id)) { bad('Duplicate tool id'); continue }
    if (typeof e.command !== 'string' || !EXTRA_CMD.test(e.command) || e.command.startsWith('-')) { bad('The command must be a plain program name (letters, digits and . _ + -)'); continue }
    const args = e.args ?? ['--version']
    if (!Array.isArray(args) || args.length > 4 || !args.every(a => typeof a === 'string' && EXTRA_ARG.test(a))) { bad('Arguments must be at most 4 plain words'); continue }
    seen.add(id)
    valid.push({ id, label: (typeof e.label === 'string' && e.label.trim() ? e.label.trim() : e.command).slice(0, 60), command: e.command, args: args.length ? args : ['--version'] })
  }
  return { valid, rejected }
}

/* ------------------------------------------------------------ the probes (fixed text) */

/**
 * Positional arguments: $1 runner directory, then pairs (command, space-separated plain arguments) for extra tools.
 * Output is line based. Meta lines: @@META<TAB>key<TAB>value. Lookups: @@LOOK<TAB>tag<TAB>L|R<TAB>absolute path or empty
 * (L = login PATH, R = the runner's recorded PATH). Command output: @@RUN<TAB>tag<TAB>V|X<TAB>exit code, body lines
 * prefixed with "|", @@END. The final line is @@DONE. Nothing in the script depends on untrusted text being parsed
 * as shell syntax: set -f turns off globbing for the word splitting of the validated argument lists.
 */
export const POSIX_DEPS_SCRIPT = String.raw`
LC_ALL=C; LANG=C; export LC_ALL LANG
set -f
dir=$1; [ $# -gt 0 ] && shift
tmo() { _t=$1; shift; if command -v timeout >/dev/null 2>&1; then timeout "$_t" "$@"; else "$@"; fi; }
look() {
  for _c in $2; do
    _p=$( PATH=$1; command -v "$_c" 2>/dev/null ) || continue
    case $_p in /*) if [ -f "$_p" ] && [ -x "$_p" ]; then printf '%s\n' "$_p"; return 0; fi ;; esac
  done
  return 1
}
runv() {
  _tag=$1; _kind=$2; _path=$3; _exe=$4; _to=$5; shift 5
  _o=$( PATH=$_path; export PATH; tmo "$_to" "$_exe" "$@" 2>&1 </dev/null ); _rc=$?
  printf '@@RUN\t%s\t%s\t%s\n' "$_tag" "$_kind" "$_rc"
  printf '%s\n' "$_o" | head -n 400 | cut -c1-300 | sed 's/^/|/'
  printf '@@END\n'
}
probe() {
  _tag=$1; _cands=$2; _vto=$3; _vargs=$4; _xto=$5; _xargs=$6
  _l=$(look "$LP" "$_cands")
  printf '@@LOOK\t%s\tL\t%s\n' "$_tag" "$_l"
  if [ -n "$RPSRC" ]; then
    _r=$(look "$RP" "$_cands")
    printf '@@LOOK\t%s\tR\t%s\n' "$_tag" "$_r"
    _use=$_r; _P=$RP
  else
    _use=$_l; _P=$LP
  fi
  if [ -n "$_use" ]; then
    runv "$_tag" V "$_P" "$_use" "$_vto" $_vargs
    if [ -n "$_xargs" ]; then runv "$_tag" X "$_P" "$_use" "$_xto" $_xargs; fi
  fi
}
RP=''; RPSRC=''; HASSVC=0
if [ -n "$dir" ] && [ -f "$dir/.path" ] && [ -r "$dir/.path" ]; then
  RP=$(head -n 1 "$dir/.path" | head -c 8192 | tr -d '\r')
  if [ -n "$RP" ]; then RPSRC='.path'; fi
fi
if [ -n "$dir" ] && [ -f "$dir/.env" ] && [ -r "$dir/.env" ]; then
  EP=$(grep -m1 '^PATH=' "$dir/.env" | head -c 8192 | tr -d '\r' | sed -e 's/^PATH=//' -e 's/^"//' -e 's/"$//')
  if [ -n "$EP" ]; then RP=$EP; RPSRC='.env'; fi
fi
if [ -n "$dir" ] && [ -f "$dir/.service" ]; then HASSVC=1; fi
LP=$PATH
if command -v bash >/dev/null 2>&1; then
  _x=$(tmo 8 bash -lc 'printf "%s" "$PATH"' 2>/dev/null </dev/null | head -c 8192)
  if [ -n "$_x" ]; then LP=$_x; fi
fi
printf '@@META\tprobe\t1\n'
printf '@@META\tuser\t%s\n' "$(id -un 2>/dev/null)"
printf '@@META\tsystem\t%s\n' "$(uname -s 2>/dev/null)"
printf '@@META\trunnerpath\t%s\n' "$RPSRC"
printf '@@META\tservice\t%s\n' "$HASSVC"
probe git git 10 '--version' '' ''
probe python3 python3 10 '--version' '' ''
probe python python 10 '--version' '' ''
probe pip 'pip3 pip' 15 '--version' '' ''
probe node node 10 '--version' '' ''
probe npm npm 20 '--version' '' ''
probe java java 15 '-version' '' ''
probe mvn mvn 25 '--version' '' ''
probe gradle gradle 40 '--version' '' ''
probe dotnet dotnet 20 '--list-sdks' '' ''
probe docker docker 10 '--version' 12 'info --format {{.ServerVersion}}'
probe tesseract tesseract 10 '--version' 10 '--list-langs'
probe make make 10 '--version' '' ''
probe gcc gcc 10 '--version' '' ''
probe curl curl 10 '--version' '' ''
probe unzip unzip 10 '-v' '' ''
i=0
while [ $# -ge 2 ]; do
  probe "X$i" "$1" 10 "$2" '' ''
  shift 2; i=$((i+1))
done
printf '@@DONE\n'
`

/**
 * The Windows probe. Constant text, sent as -EncodedCommand. Inputs arrive in environment variables: GM_RUNNER_DIR and
 * GM_EXTRAS (a JSON array of {tag, cands, v} already validated by the caller). It prints one JSON document.
 */
export const WINDOWS_DEPS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
function First-Line([string]$f) { try { if (Test-Path -LiteralPath $f -PathType Leaf) { $t = Get-Content -LiteralPath $f -Raw -ErrorAction Stop; if ($t) { return (($t -split '\r?\n')[0]).Trim() } } } catch { } return $null }
function Find-Exe($cands) {
  foreach ($c in $cands) {
    try { $g = Get-Command -Name $c -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1 } catch { $g = $null }
    if ($g -and $g.Source) { return [string]$g.Source }
  }
  return $null
}
function Invoke-Probe([string]$exe, $argv, [int]$sec) {
  $r = @{ rc = $null; out = ''; timedOut = $false; failed = $false }
  try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $exe
    $psi.Arguments = (@($argv) -join ' ')
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.RedirectStandardInput = $true
    $psi.CreateNoWindow = $true
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8; $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    $p = [System.Diagnostics.Process]::Start($psi)
    $p.StandardInput.Close()
    $so = $p.StandardOutput.ReadToEndAsync(); $se = $p.StandardError.ReadToEndAsync()
    if (-not $p.WaitForExit($sec * 1000)) { try { $p.Kill() } catch { }; $r.timedOut = $true }
    else { $p.WaitForExit(); $r.rc = $p.ExitCode; $r.out = ([string]$so.Result + [Environment]::NewLine + [string]$se.Result) }
  } catch { $r.failed = $true; $r.out = $_.Exception.Message }
  return $r
}
$dir = $env:GM_RUNNER_DIR
$orig = $env:PATH
$rp = $null; $rpsrc = ''
if ($dir) {
  $t = First-Line (Join-Path $dir '.path'); if ($t) { $rp = $t; $rpsrc = '.path' }
  try {
    $ef = Join-Path $dir '.env'
    if (Test-Path -LiteralPath $ef -PathType Leaf) {
      foreach ($l in (Get-Content -LiteralPath $ef -ErrorAction Stop)) { if ($l -match '^PATH=(.+)$') { $rp = $Matches[1].Trim().Trim([char]34); $rpsrc = '.env'; break } }
    }
  } catch { }
}
$tools = @(
  @{ tag='git'; cands=@('git'); v=@('--version'); vto=15 },
  @{ tag='python3'; cands=@('python3'); v=@('--version'); vto=15 },
  @{ tag='python'; cands=@('python'); v=@('--version'); vto=15 },
  @{ tag='py'; cands=@('py'); v=@('--version'); vto=15 },
  @{ tag='pip'; cands=@('pip','pip3'); v=@('--version'); vto=20 },
  @{ tag='node'; cands=@('node'); v=@('--version'); vto=15 },
  @{ tag='npm'; cands=@('npm'); v=@('--version'); vto=25 },
  @{ tag='java'; cands=@('java'); v=@('-version'); vto=20 },
  @{ tag='mvn'; cands=@('mvn'); v=@('--version'); vto=30 },
  @{ tag='gradle'; cands=@('gradle'); v=@('--version'); vto=45 },
  @{ tag='dotnet'; cands=@('dotnet'); v=@('--list-sdks'); vto=25 },
  @{ tag='docker'; cands=@('docker'); v=@('--version'); vto=15; x=@('info','--format','{{.ServerVersion}}'); xto=15 },
  @{ tag='tesseract'; cands=@('tesseract'); v=@('--version'); vto=15; x=@('--list-langs'); xto=15 },
  @{ tag='make'; cands=@('make'); v=@('--version'); vto=15 },
  @{ tag='gcc'; cands=@('gcc'); v=@('--version'); vto=15 },
  @{ tag='curl'; cands=@('curl'); v=@('--version'); vto=15 },
  @{ tag='unzip'; cands=@('unzip'); v=@('-v'); vto=15 }
)
if ($env:GM_EXTRAS) {
  try { $ex = ConvertFrom-Json -InputObject $env:GM_EXTRAS; foreach ($e in $ex) { $tools += @{ tag=[string]$e.tag; cands=@([string]$e.cands); v=@($e.v | ForEach-Object { [string]$_ }); vto=15 } } } catch { }
}
$out = New-Object System.Collections.ArrayList
foreach ($t in $tools) {
  $o = @{ tag = $t.tag; l = $null; r = $null; v = $null; x = $null }
  try {
    $o.l = Find-Exe $t.cands
    $use = $o.l
    if ($rpsrc) { $env:PATH = $rp; try { $o.r = Find-Exe $t.cands } finally { $env:PATH = $orig }; $use = $o.r }
    if ($use) {
      if ($rpsrc) { $env:PATH = $rp }
      try {
        $o.v = Invoke-Probe $use $t.v $t.vto
        if ($t.x) { $o.x = Invoke-Probe $use $t.x $t.xto }
      } finally { $env:PATH = $orig }
    }
  } catch { $o.err = $_.Exception.Message }
  [void]$out.Add($o)
}
$res = @{ probe = 1; user = [Environment]::UserName; runnerpath = $rpsrc; tools = @($out) }
[Console]::Out.Write(($res | ConvertTo-Json -Depth 6 -Compress))
`
export const windowsProbeArgs = (): string[] => ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_DEPS_SCRIPT, 'utf16le').toString('base64')]

/* ------------------------------------------------------------ parsing (pure) */

export type ParseCtx = {
  verifiedIn: DependencyVerifiedIn
  checkedAt: string
  extras?: ValidExtra[]
  rejected?: RejectedExtra[]
  /** Why nothing could be reported for tools the output does not mention. */
  missingDetail?: string
}
export type ParsedDeps = { user: string | null; results: DependencyResult[]; runnerEnvNote?: string; probeRan: boolean }

type RawRun = { rc: number | null; text: string; timedOut: boolean; failed: boolean }
type RawTool = { l?: string | null; r?: string | null; v?: RawRun; x?: RawRun }
type Spec = { id: DependencyId; label: string; optional: boolean; parse: (t: string) => string | null; entry?: Entry }

const specs = (windows: boolean, extras: ValidExtra[]): Spec[] => [
  ...catalogueFor(windows).map(e => ({ id: e.id as DependencyId, label: e.label, optional: e.optional, parse: e.parse, entry: e })),
  ...extras.map(e => ({ id: `extra:${e.id}` as DependencyId, label: e.label, optional: true, parse: genericVersion })),
]
const tagOf = (s: Spec, extras: ValidExtra[]) => (s.id.startsWith('extra:') ? `X${extras.findIndex(e => `extra:${e.id}` === s.id)}` : s.id)

const note = (known: string, hasService: boolean | null): string => known
  ? `Checked against the PATH the runner recorded (${known}), which is what the runner service sees. A tool on your login PATH only is reported as not on the runner PATH.`
  : `${hasService ? 'The runner has a service but no recorded PATH (.path) could be read' : 'No recorded runner PATH (.path) was found'}, so only the login PATH of this environment was checked. The runner service may see a different PATH.`

function evaluate(spec: Spec, raw: RawTool | undefined, ctx: ParseCtx, runnerPathKnown: boolean, windows: boolean): DependencyResult {
  const base = { id: spec.id, label: spec.label, verifiedIn: ctx.verifiedIn, checkedAt: ctx.checkedAt, via: runnerPathKnown ? 'service-path' as const : 'path-lookup' as const, optional: spec.optional }
  const res = (status: DependencyStatus, o: { version?: string | null; path?: string | null; detail?: string; loginPath?: string | null } = {}): DependencyResult => ({
    ...base, status, version: o.version ?? null, path: o.path ?? null,
    ...(o.detail ? { detail: o.detail } : {}),
    ...(o.loginPath ? { loginPath: o.loginPath } : {}),
    ...(status === 'missing' || status === 'error' ? { installHint: 'open-terminal' as const } : {}),
  })
  const decisive = raw ? (runnerPathKnown ? raw.r : raw.l) : undefined
  if (!raw || raw.l === undefined || decisive === undefined) return res('unknown', { detail: ctx.missingDetail ?? 'The check did not report on this tool' })
  const loginPath = raw.l || null
  if (!decisive) return res('missing', { detail: runnerPathKnown && loginPath ? 'Not on the runner PATH' : undefined, loginPath })
  if (windows && spec.id.startsWith('python') && /\\WindowsApps\\/i.test(decisive)) return res('missing', { detail: 'Only the Microsoft Store shortcut exists, not a Python installation', loginPath })
  const path = decisive
  if (!raw.v) return res('unknown', { path, detail: 'Found, but its version command was not run', loginPath })
  if (raw.v.timedOut) return res('error', { path, detail: 'Version command timed out', loginPath })
  const text = raw.v.text
  const version = spec.parse(text)
  const e = spec.entry
  if (raw.v.failed || (raw.v.rc !== 0 && !version)) return res('error', { path, version, detail: `Version command failed: ${firstLine(text) || (raw.v.rc !== null ? `exit code ${raw.v.rc}` : 'no output')}`.slice(0, 200), loginPath })
  if (e?.id === 'dotnet') {
    const sdks = dotnetSdks(text)
    if (!sdks.length) return res('missing', { path, detail: 'dotnet is installed but no SDK is (runtime only)', loginPath })
    return res('found', { path, version, detail: `SDKs: ${sdks.join(', ')}`.slice(0, 200), loginPath })
  }
  let detail: string | undefined
  if (e?.id === 'tesseract' && raw.x) {
    if (raw.x.timedOut || raw.x.failed || raw.x.rc !== 0) detail = 'Could not list languages'
    else {
      const langs = raw.x.text.split(/\r?\n/).map(s => s.trim()).filter(s => s && !/^list of available languages/i.test(s))
      detail = `${langs.length} language${langs.length === 1 ? '' : 's'}${langs.length ? `: ${langs.slice(0, 8).join(', ')}${langs.length > 8 ? ', ...' : ''}` : ''}`
    }
  }
  if (e?.id === 'docker' && raw.x) {
    if (raw.x.timedOut) detail = 'Docker daemon did not answer in time'
    else if (raw.x.failed || raw.x.rc !== 0) detail = `Docker daemon is not reachable${firstLine(raw.x.text) ? `: ${firstLine(raw.x.text)}` : ''}`.slice(0, 200)
    else detail = `Daemon ${firstLine(raw.x.text) || 'running'} is running`
  }
  if (!version) detail = `Version not recognised: ${firstLine(text)}`.slice(0, 200)
  return res('found', { path, version, detail, loginPath })
}

const rejectedResults = (ctx: ParseCtx): DependencyResult[] => (ctx.rejected ?? []).map(r => ({
  id: `extra:${r.id}` as DependencyId, label: r.id || 'Additional tool', status: 'error' as const, version: null, path: null, verifiedIn: ctx.verifiedIn,
  checkedAt: ctx.checkedAt, detail: `Not checked: ${r.reason}`, via: 'path-lookup' as const, optional: true,
}))

function assemble(windows: boolean, raws: Map<string, RawTool>, ctx: ParseCtx, user: string | null, rpSrc: string, hasService: boolean | null, probeRan: boolean): ParsedDeps {
  const extras = ctx.extras ?? []
  const known = !!rpSrc
  const results = [...specs(windows, extras).map(s => evaluate(s, raws.get(tagOf(s, extras)), ctx, known, windows)), ...rejectedResults(ctx)]
  return { user, results, runnerEnvNote: note(rpSrc, hasService), probeRan }
}

/** Parses the output of POSIX_DEPS_SCRIPT. Never throws; anything it cannot read becomes 'unknown'. */
export function parsePosixDepsOutput(stdout: string, ctx: ParseCtx): ParsedDeps {
  const raws = new Map<string, RawTool>()
  const meta = new Map<string, string>()
  const get = (tag: string) => { let r = raws.get(tag); if (!r) { r = {}; raws.set(tag, r) } return r }
  let cur: { tag: string; kind: string; rc: number | null; lines: string[] } | null = null
  for (const line of (stdout ?? '').replace(/\r/g, '').split('\n')) {
    if (cur) {
      if (line === '@@END') {
        const t = get(cur.tag); const run: RawRun = { rc: cur.rc, text: cur.lines.join('\n'), timedOut: cur.rc === 124, failed: cur.rc === null }
        if (cur.kind === 'V') t.v = run; else if (cur.kind === 'X') t.x = run
        cur = null
      } else if (line.startsWith('|')) cur.lines.push(line.slice(1))
      else cur = null // unterminated block: drop it, the tool stays unknown
      if (cur || line === '@@END') continue
    }
    if (!line.startsWith('@@')) continue
    const p = line.split('\t')
    if (p[0] === '@@META' && p.length >= 2) meta.set(p[1], p.slice(2).join('\t'))
    else if (p[0] === '@@LOOK' && p.length >= 4 && (p[2] === 'L' || p[2] === 'R')) { const t = get(p[1]); if (p[2] === 'L') t.l = p[3]; else t.r = p[3] }
    else if (p[0] === '@@RUN' && p.length >= 4) { const rc = /^\d+$/.test(p[3] ?? '') ? Number(p[3]) : null; cur = { tag: p[1], kind: p[2], rc, lines: [] } }
  }
  const probeRan = meta.get('probe') === '1'
  const out = assemble(false, raws, probeRan ? ctx : { ...ctx, missingDetail: ctx.missingDetail ?? 'The check produced no readable output' }, meta.get('user')?.trim() || null, meta.get('runnerpath') ?? '', meta.has('service') ? meta.get('service') === '1' : null, probeRan)
  if (!probeRan) delete out.runnerEnvNote
  return out
}

type WinRun = { rc?: number | null; out?: string; timedOut?: boolean; failed?: boolean } | null | undefined
const winRun = (r: WinRun): RawRun | undefined => (r && typeof r === 'object' ? { rc: typeof r.rc === 'number' ? r.rc : null, text: typeof r.out === 'string' ? r.out : '', timedOut: r.timedOut === true, failed: r.failed === true } : undefined)

/** Parses the JSON printed by WINDOWS_DEPS_SCRIPT. Tolerates noise around the JSON; never throws. */
export function parseWindowsDepsOutput(stdout: string, ctx: ParseCtx): ParsedDeps {
  let j: { probe?: number; user?: unknown; runnerpath?: unknown; tools?: unknown } | null = null
  const text = (stdout ?? '').replace(/^﻿/, '')
  const a = text.indexOf('{'), b = text.lastIndexOf('}')
  if (a >= 0 && b > a) { try { j = JSON.parse(text.slice(a, b + 1)) } catch { j = null } }
  const ok = !!j && typeof j === 'object' && j.probe === 1 && Array.isArray(j.tools)
  const raws = new Map<string, RawTool>()
  if (ok) {
    for (const t of j!.tools as { tag?: unknown; l?: unknown; r?: unknown; v?: WinRun; x?: WinRun }[]) {
      if (!t || typeof t.tag !== 'string') continue
      raws.set(t.tag, {
        l: typeof t.l === 'string' ? t.l : null, r: typeof t.r === 'string' ? t.r : null,
        v: winRun(t.v), x: winRun(t.x),
      })
    }
  }
  const rpSrc = ok && typeof j!.runnerpath === 'string' ? j!.runnerpath : ''
  // On Windows the lookup that is skipped without a recorded runner PATH is "r"; make the shapes agree with the POSIX parser.
  if (!rpSrc) for (const t of raws.values()) delete t.r
  const out = assemble(true, raws, ok ? ctx : { ...ctx, missingDetail: ctx.missingDetail ?? 'The check produced no readable output' }, ok && typeof j!.user === 'string' ? j!.user : null, rpSrc, null, ok)
  if (!ok) delete out.runnerEnvNote
  return out
}

export function parseDepsOutput(os: RunnerOs, stdout: string, ctx: ParseCtx): ParsedDeps {
  return os === 'windows' ? parseWindowsDepsOutput(stdout, ctx) : parsePosixDepsOutput(stdout, ctx)
}

/* ------------------------------------------------------------ inspection */

export const verifiedInFor = (host: RunnerHost, os: RunnerOs): DependencyVerifiedIn => {
  const label = host.kind === 'wsl' ? `WSL ${host.distro}` : host.kind === 'ssh' ? `SSH ${host.host}` : os === 'windows' ? 'Windows' : os === 'macos' ? 'macOS' : os === 'linux' ? 'Linux' : 'This computer'
  return { host, os, label }
}

export type InspectOptions = {
  /** The runner directory in the host's own path syntax (where .path, .env and .service live). */
  cwd: string
  extra?: ExtraDependency[]
  /** Skip the cache and probe again. */
  refresh: boolean
  signal?: AbortSignal
  /** Whole-probe time limit. Default 120 s. */
  timeoutMs?: number
  now?: () => number
  /** Cache to use; null disables caching. Default: a shared cache with a 60 s lifetime. */
  cache?: DepsCache | null
  /** Cache key; default derived from the host, runner directory and extra tools. */
  key?: string
}

export const hostKeyOf = (h: RunnerHost) => (h.kind === 'wsl' ? `wsl:${h.distro}` : h.kind === 'ssh' ? `ssh:${h.host}` : 'native')

const abortable = <T,>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T | 'aborted'> => {
  if (!signal) return p
  if (signal.aborted) return Promise.resolve('aborted' as const)
  return new Promise(resolve => {
    const onAbort = () => resolve('aborted')
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(v => { signal.removeEventListener('abort', onAbort); resolve(v) }, () => { signal.removeEventListener('abort', onAbort); resolve('aborted') })
  })
}

const firstOf = (s: string) => firstLine(s).slice(0, 200)

async function probeOnce(shell: HostShell, opts: InspectOptions, valid: ValidExtra[], rejected: RejectedExtra[], iso: string): Promise<DependencyReport> {
  const verifiedIn = verifiedInFor(shell.host, shell.os)
  const ctx: ParseCtx = { verifiedIn, checkedAt: iso, extras: valid, rejected }
  const key = opts.key ?? `${hostKeyOf(shell.host)}|${opts.cwd}|${valid.map(e => `${e.id}=${e.command} ${e.args.join(' ')}`).join(',')}`
  const timeoutMs = opts.timeoutMs ?? 120_000
  const windows = shell.os === 'windows'
  let run: Promise<import('../exec.js').ExecResult>
  try {
    run = windows
      ? shell.run('powershell.exe', windowsProbeArgs(), { timeoutMs, env: { GM_RUNNER_DIR: opts.cwd, GM_EXTRAS: JSON.stringify(valid.map((e, i) => ({ tag: `X${i}`, cands: e.command, v: e.args }))) } })
      : shell.script(POSIX_DEPS_SCRIPT, [opts.cwd, ...valid.flatMap(e => [e.command, e.args.join(' ')])], { timeoutMs })
  } catch (e) { run = Promise.reject(e) }
  const r = await abortable(run, opts.signal)
  const fail = (status: DependencyStatus, detail: string): DependencyReport => {
    const specsAll = specs(windows, valid)
    const results: DependencyResult[] = [
      ...specsAll.map(s => ({ id: s.id, label: s.label, status, version: null, path: null, verifiedIn, checkedAt: iso, detail, via: 'path-lookup' as const, optional: s.optional })),
      ...rejectedResults(ctx),
    ]
    return { key, host: shell.host, hostLabel: verifiedIn.label, user: null, results, collectedAt: iso }
  }
  if (r === 'aborted') return fail('unknown', 'Cancelled')
  if (r.spawnError) return fail('error', `Could not run the check: ${firstOf(r.spawnError)}`)
  const parsed = parseDepsOutput(shell.os, r.stdout, r.timedOut ? { ...ctx, missingDetail: 'Not checked: the dependency check timed out' } : ctx)
  if (!parsed.probeRan) {
    if (r.timedOut) return fail('error', 'The dependency check timed out')
    return fail('error', r.code !== 0 ? `The dependency check failed: ${firstOf(r.stderr) || `exit code ${r.code}`}` : 'The dependency check produced no readable output')
  }
  return { key, host: shell.host, hostLabel: verifiedIn.label, user: parsed.user, results: parsed.results, ...(parsed.runnerEnvNote ? { runnerEnvNote: parsed.runnerEnvNote } : {}), collectedAt: iso }
}

/**
 * Checks the dependencies of a runner inside the environment the shell runs in. The report always says where each
 * answer was verified. Results are cached per runner key (see DepsCache); `refresh: true` forces a new probe.
 */
export async function inspectDependencies(shell: HostShell, opts: InspectOptions): Promise<DependencyReport> {
  const { valid, rejected } = validateExtras(opts.extra)
  const now = opts.now ?? Date.now
  const key = opts.key ?? `${hostKeyOf(shell.host)}|${opts.cwd}|${valid.map(e => `${e.id}=${e.command} ${e.args.join(' ')}`).join(',')}`
  const cache = opts.cache === undefined ? defaultDepsCache : opts.cache
  const work = () => probeOnce(shell, { ...opts, key }, valid, rejected, new Date(now()).toISOString())
  if (!cache) return work()
  return cache.get(key, work, { refresh: opts.refresh })
}

/* ------------------------------------------------------------ cache */

/** Remembers one report per runner key for a while. Concurrent requests share one probe. Cancelled/failed probes are not cached. */
export class DepsCache {
  private readonly entries = new Map<string, { at: number; report: DependencyReport }>()
  private readonly inflight = new Map<string, Promise<DependencyReport>>()
  constructor(private readonly ttlMs = 60_000, private readonly now: () => number = Date.now) {}

  peek(key: string): DependencyReport | null {
    const e = this.entries.get(key)
    return e && this.now() - e.at < this.ttlMs ? e.report : null
  }
  async get(key: string, load: () => Promise<DependencyReport>, o: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<DependencyReport> {
    if (!o.refresh) { const hit = this.peek(key); if (hit) return hit }
    let p = this.inflight.get(key)
    if (!p || o.refresh) {
      const mine: Promise<DependencyReport> = load().then(report => {
        const cacheable = report.results.length > 0 && !report.results.every(r => r.status === 'unknown' || (r.status === 'error' && !r.version && !r.path && r.via === 'path-lookup' && /^(The dependency check|Could not run|Cancelled)/.test(r.detail ?? '')))
        if (cacheable) this.entries.set(key, { at: this.now(), report })
        return report
      }).finally(() => { if (this.inflight.get(key) === mine) this.inflight.delete(key) })
      this.inflight.set(key, mine)
      p = mine
    }
    const r = await abortable(p, o.signal)
    if (r === 'aborted') throw Object.assign(new Error('Cancelled'), { name: 'AbortError' })
    return r
  }
  invalidate(key?: string) { if (key === undefined) this.entries.clear(); else this.entries.delete(key) }
}

export const defaultDepsCache = new DepsCache()
