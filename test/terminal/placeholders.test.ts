import { describe, expect, it } from 'vitest'
import { detectPlaceholders, preparePaste, reconstruct, scanContexts, syntaxForShell } from '../../src/shared/placeholders.js'
import { contextAction, DEFAULT_TERMINAL_PREFS, installedFonts, sanitizeTerminalPrefs, validateTerminalPrefs, xtermOptions } from '../../src/shared/terminalPrefs.js'

const tokens = (t: string, s: 'powershell' | 'posix' = 'powershell') => detectPlaceholders(t, s).map(p => p.token)

describe('placeholder detection', () => {
  it('finds the documented examples', () => {
    for (const t of ['YOUR_TOKEN', 'YOUR_API_KEY', 'URI_KEY', 'YOUR_PASSWORD', 'YOUR_CLIENT_ID', 'YOUR_SECRET']) expect(tokens(`curl -H "x: ${t}" https://api`)).toEqual([t])
    expect(tokens('tool --key <TOKEN> --id <API_KEY>')).toEqual(['<TOKEN>', '<API_KEY>'])
  })

  it('the expected workflow: two assignments, two values, variable names are not placeholders', () => {
    const cmd = '$env:API_TOKEN = "YOUR_TOKEN"\n$env:URI_KEY = "YOUR_URI_KEY"'
    expect(tokens(cmd)).toEqual(['YOUR_TOKEN', 'YOUR_URI_KEY'])
  })

  it('deduplicates repeated references and keeps every occurrence', () => {
    const p = detectPlaceholders('a YOUR_TOKEN b "YOUR_TOKEN" c YOUR_TOKEN')
    expect(p).toHaveLength(1)
    expect(p[0].occurrences.map(o => o.context)).toEqual(['code', 'double', 'code'])
  })

  it('finds placeholders in URLs, arguments, assignments, quotes and across lines', () => {
    expect(tokens('Invoke-RestMethod "https://x.io/YOUR_ORG/repos?token=YOUR_TOKEN"')).toEqual(['YOUR_ORG', 'YOUR_TOKEN'])
    expect(tokens('git clone https://YOUR_USERNAME:YOUR_PASSWORD@github.com/a/b.git')).toEqual(['YOUR_USERNAME', 'YOUR_PASSWORD'])
    expect(tokens('npm config set //r/:_authToken={{ npm_token }}')).toEqual(['{{ npm_token }}'])
    expect(tokens('a `\n  -Token REPLACE_ME `\n  -Name x_HERE')).toEqual(['REPLACE_ME'])
    expect(tokens('x INSERT_TOKEN_HERE')).toEqual(['INSERT_TOKEN_HERE'])
    expect(tokens('tool --key=YOUR_TOKEN --name "YOUR-NAME"')).toEqual(['YOUR_TOKEN', 'YOUR-NAME'])
  })

  it('uses context: a credential name equal to its own variable, or marked by a comment', () => {
    expect(tokens('$env:API_TOKEN = "API_TOKEN"')).toEqual(['API_TOKEN'])
    expect(tokens('# replace the secret below\n$x = "CLIENT_SECRET"')).toEqual(['CLIENT_SECRET'])
    expect(tokens('$x = "CLIENT_SECRET"')).toEqual([])
  })

  it('does not flag valid variables, environment references, literal arguments or ordinary uppercase text', () => {
    const clean = [
      '$env:API_TOKEN = $env:GITHUB_TOKEN', 'echo $YOUR_TOKEN', 'echo ${YOUR_TOKEN}', 'Get-ChildItem Env:URI_KEY', 'echo %URI_KEY%', 'Invoke-X @YOUR_ARGS',
      'Write-Host "HTTP ERROR 404"', 'git log --oneline -n 5', 'npm run BUILD_ALL', '$x = "API_TOKEN"', '[Environment]::GetEnvironmentVariable("API_TOKEN")',
      'export YOUR_TOKEN=abc', 'URI_KEY=abc ./run.sh', '$env:URI_KEY = "abc"', 'echo ${{ secrets.GITHUB_TOKEN }}', 'ls <div>x</div>', 'a=$(( 1<2 ))',
      'echo SHIFT-INSERT-TEXT', 'echo FOR-YOUR-INFO', 'git push --force-with-lease', 'Write-Output TEXT-REPLACE-ALL',
      'Get-Content a.txt # replace YOUR_TOKEN later', 'echo "your-name"', 'Set-Location C:\\Users\\me\\dev', 'git commit -m "update README"', '<# YOUR_TOKEN #> ls',
    ]
    for (const c of clean) expect(tokens(c), c).toEqual([])
  })

  it('masks tokens that look like secrets, not ids or urls', () => {
    const p = Object.fromEntries(detectPlaceholders('YOUR_TOKEN YOUR_CLIENT_ID YOUR_PASSWORD YOUR_URL').map(x => [x.token, x.sensitive]))
    expect(p).toEqual({ YOUR_TOKEN: true, YOUR_CLIENT_ID: false, YOUR_PASSWORD: true, YOUR_URL: false })
  })

  it('reads quote contexts, escapes and here-strings', () => {
    const t = `a 'it''s YOUR_A' "x\`"YOUR_B" "$(echo 'YOUR_C') YOUR_D" @'\nYOUR_E\n'@ YOUR_F`
    const ctx = Object.fromEntries(detectPlaceholders(t).map(p => [p.token, p.occurrences[0].context]))
    expect(ctx).toEqual({ YOUR_A: 'single', YOUR_B: 'double', YOUR_C: 'single', YOUR_D: 'double', YOUR_E: 'here-single', YOUR_F: 'code' })
    expect(scanContexts('# c\nx', 'powershell')[0]).toBe(5)
    expect(tokens('echo \'YOUR_A\' "YOUR_B\\"" YOUR_C', 'posix')).toEqual(['YOUR_A', 'YOUR_B', 'YOUR_C'])
  })
})

describe('command reconstruction', () => {
  const run = (cmd: string, values: Record<string, string>, syntax: 'powershell' | 'posix' = 'powershell') => reconstruct(cmd, detectPlaceholders(cmd, syntax), values, { syntax })

  it('rebuilds the workflow command and preserves formatting exactly', () => {
    const cmd = '$env:API_TOKEN = "YOUR_TOKEN"   # keep\r\n$env:URI_KEY = "YOUR_URI_KEY"\n'
    const r = run(cmd, { YOUR_TOKEN: 'abc123', YOUR_URI_KEY: 'u-1' })
    expect(r).toMatchObject({ ok: true, text: '$env:API_TOKEN = "abc123"   # keep\r\n$env:URI_KEY = "u-1"\n' })
  })

  it('replaces every reference of a repeated placeholder', () => {
    expect(run('a YOUR_TOKEN b "YOUR_TOKEN"', { YOUR_TOKEN: 'k' })).toMatchObject({ ok: true, text: 'a k b "k"' })
  })

  it('escapes PowerShell-sensitive characters for the quote context', () => {
    const v = 'p a"s$s`&\'x'
    expect(run('x "YOUR_P"', { YOUR_P: v })).toMatchObject({ text: 'x "p a`"s`$s``&\'x"' })
    expect(run('x \'YOUR_P\'', { YOUR_P: v })).toMatchObject({ text: 'x \'p a"s$s`&\'\'x\'' })
    expect(run('x YOUR_P', { YOUR_P: v })).toMatchObject({ text: 'x \'p a"s$s`&\'\'x\'' }) // a bare word becomes a single-quoted word
    expect(run('x YOUR_P', { YOUR_P: 'abc-1.2' })).toMatchObject({ text: 'x abc-1.2' })
    expect(run('x YOUR_P', { YOUR_P: '-rf' })).toMatchObject({ text: 'x \'-rf\'' })
    expect(run('x "YOUR_P"', { YOUR_P: '\u201Cq\u201D' })).toMatchObject({ text: 'x "`\u201Cq`\u201D"' })
    expect(run('x \'YOUR_P\'', { YOUR_P: '\u2019' })).toMatchObject({ text: 'x \'\u2019\u2019\'' })
  })

  it('escapes POSIX quoting for WSL shells', () => {
    expect(run('x "YOUR_P"', { YOUR_P: 'a"b$c`d\\e' }, 'posix')).toMatchObject({ text: 'x "a\\"b\\$c\\`d\\\\e"' })
    expect(run('x \'YOUR_P\'', { YOUR_P: 'it\'s' }, 'posix')).toMatchObject({ text: 'x \'it\'\\\'\'s\'' })
    expect(run('x "YOUR_P"', { YOUR_P: 'hi!' }, 'posix')).toMatchObject({ ok: false })
    expect(run('x YOUR_P', { YOUR_P: 'a b' }, 'posix')).toMatchObject({ text: 'x \'a b\'' })
  })

  it('refuses instead of changing a value silently', () => {
    const r = run('curl https://x/?t=YOUR_TOKEN&a=1', { YOUR_TOKEN: 'a&b' })
    expect(r).toMatchObject({ ok: false })
    expect(!r.ok && r.problems[0].reason).toMatch(/part of a larger unquoted word/)
    expect(run('x "YOUR_P"', { YOUR_P: 'a\nb' })).toMatchObject({ ok: false })
    expect(run('@\'\nYOUR_E\n\'@', { YOUR_E: 'ok \'@' })).toMatchObject({ ok: true })
    expect(run('@\'\nYOUR_E\n\'@', { YOUR_E: '\'@x' })).toMatchObject({ ok: false })
  })

  it('leaves placeholders without a value alone and masks sensitive values in a preview', () => {
    const cmd = 'a YOUR_TOKEN b YOUR_CLIENT_ID'
    const ph = detectPlaceholders(cmd)
    expect(reconstruct(cmd, ph, { YOUR_CLIENT_ID: 'cid' })).toMatchObject({ ok: true, text: 'a YOUR_TOKEN b cid', unchanged: ['YOUR_TOKEN'] })
    const prev = reconstruct(cmd, ph, { YOUR_TOKEN: 'sekret', YOUR_CLIENT_ID: 'cid' }, { maskedTokens: new Set(['YOUR_TOKEN']) })
    expect(prev.ok && prev.text).toBe('a \u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022 b cid')
  })

  it('handles <TOKEN> forms as whole words and a value that looks like another placeholder only once', () => {
    expect(run('tool <API_KEY>', { '<API_KEY>': 'k-1' })).toMatchObject({ text: 'tool k-1' })
    expect(run('tool "<API_KEY>"', { '<API_KEY>': 'k 1' })).toMatchObject({ text: 'tool "k 1"' })
    expect(run('tool YOUR_A', { YOUR_A: 'YOUR_B' })).toMatchObject({ text: 'tool YOUR_B' })
  })

  it('never executes: the result is only text', () => {
    expect(run('a YOUR_X', { YOUR_X: '$(Remove-Item -Recurse /)' })).toMatchObject({ text: 'a \'$(Remove-Item -Recurse /)\'' })
    expect(run('a "YOUR_X"', { YOUR_X: '$(calc)' })).toMatchObject({ text: 'a "`$(calc)"' })
  })
})

describe('paste preparation and shell syntax', () => {
  it('drops trailing line breaks and control characters, keeps inner line breaks', () => {
    expect(preparePaste('ls\r\n')).toBe('ls')
    expect(preparePaste('a\nb\n\n')).toBe('a\nb')
    expect(preparePaste('a\u001b[201~rm -rf\u0000')).toBe('a[201~rm -rf')
    expect(preparePaste('a\tb')).toBe('a\tb')
  })
  it('maps shell kinds', () => {
    expect(['powershell', 'pwsh', 'wsl', 'posix'].map(syntaxForShell)).toEqual(['powershell', 'powershell', 'posix', 'posix'])
  })
})

describe('terminal preferences', () => {
  it('has sensible defaults and sanitizes unsupported values', () => {
    expect(sanitizeTerminalPrefs(undefined)).toEqual(DEFAULT_TERMINAL_PREFS)
    const p = sanitizeTerminalPrefs({ fontSize: 400, lineHeight: 0.2, scrollback: 3, fontFamily: 'x";}', defaultShell: 'cmd', cursorStyle: 'star', selectToCopy: 'yes', rightClickPaste: false })
    expect(p).toMatchObject({ fontSize: 32, lineHeight: 1, scrollback: 100, fontFamily: '', defaultShell: 'auto', cursorStyle: 'block', selectToCopy: true, rightClickPaste: false })
  })
  it('validates strictly and names the problem', () => {
    expect(validateTerminalPrefs(DEFAULT_TERMINAL_PREFS)).toMatchObject({ ok: true })
    expect(validateTerminalPrefs({ ...DEFAULT_TERMINAL_PREFS, fontSize: 5 })).toMatchObject({ ok: false, message: expect.stringContaining('Font size') })
    expect(validateTerminalPrefs({ ...DEFAULT_TERMINAL_PREFS, fontFamily: 'Comic Sans' })).toMatchObject({ ok: false })
    expect(validateTerminalPrefs({ ...DEFAULT_TERMINAL_PREFS, defaultShell: 'wsl:Ubuntu-22.04' })).toMatchObject({ ok: true })
    expect(validateTerminalPrefs({ ...DEFAULT_TERMINAL_PREFS, defaultShell: 'wsl:../x;rm' })).toMatchObject({ ok: false })
    expect(validateTerminalPrefs({ ...DEFAULT_TERMINAL_PREFS, selectToCopy: 1 })).toMatchObject({ ok: false })
  })
  it('maps to xterm options', () => {
    expect(xtermOptions({ ...DEFAULT_TERMINAL_PREFS, fontFamily: 'Consolas', fontSize: 15, cursorStyle: 'bar' })).toMatchObject({ fontFamily: expect.stringMatching(/^"Consolas", /), fontSize: 15, cursorStyle: 'bar', scrollback: 5000 })
  })
  it('detects installed fonts from measured widths', () => {
    const w = (f: string) => (f.includes('Fira Code') || f.includes('Consolas') ? 7.5 : f.startsWith('monospace') ? 8 : f.startsWith('serif') ? 6 : f.includes('monospace') ? 8 : 6)
    expect(installedFonts(w)).toEqual(['Consolas', 'Fira Code'])
  })
  it('right click: paste without a selection, a menu with one; each behaviour independently configurable', () => {
    const on = { contextMenuCopy: true, rightClickPaste: true }
    expect(contextAction(on, false)).toEqual({ kind: 'paste' })
    expect(contextAction(on, true)).toEqual({ kind: 'menu', items: ['copy', 'paste'] })
    expect(contextAction({ contextMenuCopy: true, rightClickPaste: false }, true)).toEqual({ kind: 'menu', items: ['copy'] })
    expect(contextAction({ contextMenuCopy: false, rightClickPaste: true }, true)).toEqual({ kind: 'menu', items: ['paste'] })
    expect(contextAction({ contextMenuCopy: false, rightClickPaste: false }, true)).toEqual({ kind: 'none' })
    expect(contextAction({ contextMenuCopy: true, rightClickPaste: false }, false)).toEqual({ kind: 'none' })
  })
})
