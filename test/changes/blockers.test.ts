import { describe, expect, it } from 'vitest'
import { editorFileSpec } from '../../src/core/launchers.js'
import { gitError, parseOverwritten, trimGitOutput } from '../../src/core/git/errors.js'

const fail = (stderr: string) => gitError({ code: 1, stdout: '', stderr, timedOut: false }, 'fallback')

describe('blockers are detected from what Git actually said', () => {
  it('local changes: the files from Git\'s own list, and only View Changes and Stash', () => {
    const e = fail('error: Your local changes to the following files would be overwritten by merge:\n\tsrc/a.ts\n\tdocs/my file.md\nPlease commit your changes or stash them before you merge.\nAborting\n')
    expect(e).toMatchObject({ code: 'LOCAL_CHANGES', blocker: { files: ['src/a.ts', 'docs/my file.md'] } })
    expect(e.blocker?.actions.map(a => a.id)).toEqual(['view-changes', 'stash'])
    expect(parseOverwritten('error: The following untracked working tree files would be overwritten by checkout:\n\tnew.txt\nAborting')).toEqual(['new.txt'])
  })

  it('another worktree: the folder, and Open Worktree for exactly that folder', () => {
    for (const msg of ["fatal: 'feature' is already checked out at '/work/app-feature'", "fatal: 'feature' is already used by worktree at '/work/app-feature'"]) {
      const e = fail(msg)
      expect(e).toMatchObject({ code: 'WORKTREE_CHECKED_OUT', blocker: { worktree: '/work/app-feature', actions: [{ id: 'open-worktree', target: '/work/app-feature' }] } })
    }
  })

  it('a lock file: the file is named, the only action is to try again, nothing is deleted for the user', () => {
    const e = fail("fatal: Unable to create '/repo/.git/index.lock': File exists.\n\nAnother git process seems to be running in this repository")
    expect(e).toMatchObject({ code: 'LOCKED', blocker: { files: ['/repo/.git/index.lock'], actions: [{ id: 'retry' }] } })
    expect(e.message).toContain('/repo/.git/index.lock')
  })

  it('a permission error names the file; without a file there is no invented action', () => {
    const named = fail("error: unable to unlink old 'src/a.ts': Permission denied")
    expect(named.code).toBe('PERMISSION')
    const plain = fail('fatal: could not open directory: Permission denied')
    expect(plain).toMatchObject({ code: 'PERMISSION' })
    expect(plain.blocker).toBeUndefined()
  })

  it('a missing upstream is stated and carries no action', () => {
    const e = fail('There is no tracking information for the current branch.\nPlease specify which branch you want to merge with.')
    expect(e).toMatchObject({ code: 'NO_UPSTREAM' })
    expect(e.blocker).toBeUndefined()
  })

  it('unknown failures stay generic and carry no blocker', () => {
    const e = fail('fatal: something unexpected happened')
    expect(e).toMatchObject({ code: 'GIT_FAILED', message: 'fallback' })
    expect(e.blocker).toBeUndefined()
    expect(trimGitOutput('hint: x\nreal problem')).toBe('real problem')
  })

  it('a missing identity says what to set', () => {
    expect(fail('Author identity unknown\n\n*** Please tell me who you are.')).toMatchObject({ code: 'NO_IDENTITY' })
  })
})

describe('opening one file in the editor', () => {
  it('passes the file as its own argument on Linux and macOS', () => {
    expect(editorFileSpec('code --reuse-window', { kind: 'native', path: '/home/me/app' }, 'src/a b.ts', 'linux')).toMatchObject({ file: 'code', args: ['--reuse-window', '/home/me/app/src/a b.ts'], verbatim: false })
  })
  it('quotes for cmd.exe on Windows and refuses names cmd.exe could misread', () => {
    const s = editorFileSpec('code', { kind: 'native', path: 'C:\\dev\\app' }, 'src/a.ts', 'windows')
    expect(s?.args.at(-1)).toMatch(/^"code "C:\\dev\\app[\\/]src[\\/]a\.ts""$/)
    expect(s?.verbatim).toBe(true)
    for (const bad of ['a&b.ts', 'a%PATH%.ts', 'a"b.ts', 'a^b']) expect(editorFileSpec('code', { kind: 'native', path: 'C:\\dev\\app' }, bad, 'windows')).toBeNull()
  })
  it('runs inside the distribution for WSL and quotes the path for the shell', () => {
    const s = editorFileSpec('code', { kind: 'wsl', distro: 'Ubuntu', path: '/home/me/app' }, "it's.ts", 'windows')
    expect(s?.file).toBe('wsl.exe')
    expect(s?.args).toEqual(['-d', 'Ubuntu', '--cd', '/home/me/app', '--exec', 'bash', '-lc', "code '/home/me/app/it'\\''s.ts'"])
  })
})
