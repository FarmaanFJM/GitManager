import { describe, expect, it } from 'vitest'
import { TerminalController, isCopyKey, isPasteKey, type ControllerDeps, type KeyLike, type PendingPaste } from '../../src/renderer/terminalController.js'
import { DEFAULT_TERMINAL_PREFS, type TerminalPrefs } from '../../src/shared/terminalPrefs.js'

function setup(over: Partial<TerminalPrefs> = {}, clip = 'clipboard text') {
  const log = { pasted: [] as string[], copied: [] as string[], asked: [] as PendingPaste[], menus: [] as ('copy' | 'paste')[][], notes: [] as string[], focus: 0 }
  const st = { selection: '', clip, writeOk: true, prefs: { ...DEFAULT_TERMINAL_PREFS, ...over } }
  const deps: ControllerDeps = {
    term: { getSelection: () => st.selection, paste: t => { log.pasted.push(t) }, focus: () => { log.focus++ } },
    prefs: () => st.prefs, syntax: () => 'powershell',
    readClipboard: async () => st.clip, writeClipboard: async t => { if (st.writeOk) log.copied.push(t); return st.writeOk },
    ask: p => { log.asked.push(p) }, menu: (_at, items) => { log.menus.push(items) }, notify: (_k, m) => { log.notes.push(m) },
  }
  return { c: new TerminalController(deps), log, st }
}
const key = (k: Partial<KeyLike> & { key: string }): KeyLike => ({ type: 'keydown', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...k })
const tick = () => new Promise(r => setTimeout(r, 0))

describe('terminal paste', () => {
  it('right-click without a selection pastes the clipboard (when enabled); with the setting off it does nothing', async () => {
    const a = setup()
    expect(a.c.contextMenu({ x: 1, y: 1 })).toBe(true)
    await tick()
    expect(a.log.pasted).toEqual(['clipboard text']); expect(a.log.menus).toEqual([])
    const b = setup({ rightClickPaste: false })
    b.c.contextMenu({ x: 1, y: 1 }); await tick()
    expect(b.log.pasted).toEqual([]); expect(b.log.menus).toEqual([])
  })

  it('Ctrl+V, Shift+Insert and Ctrl+Shift+V paste; Ctrl+C is left to the shell as the interrupt', async () => {
    const { c, log } = setup()
    for (const k of [key({ key: 'v', ctrlKey: true }), key({ key: 'Insert', shiftKey: true }), key({ key: 'V', ctrlKey: true, shiftKey: true })]) {
      let prevented = false
      expect(c.key({ ...k, preventDefault: () => { prevented = true } })).toBe(false)
      expect(prevented).toBe(true)
    }
    await tick()
    expect(log.pasted).toEqual(['clipboard text', 'clipboard text', 'clipboard text'])
    expect(c.key(key({ key: 'c', ctrlKey: true }))).toBe(true) // xterm sends ^C
    expect(c.key(key({ key: 'a' }))).toBe(true)
    expect(isPasteKey(key({ key: 'v', ctrlKey: true, altKey: true }))).toBe(false)
    expect(isPasteKey(key({ key: 'v', type: 'keyup', ctrlKey: true }))).toBe(false)
    expect(isCopyKey(key({ key: 'c', ctrlKey: true }))).toBe(false)
  })

  it('never executes: trailing newlines are removed, nothing but the text is inserted', async () => {
    const { c, log } = setup({}, 'git status\r\n\r\n')
    await c.pasteFromClipboard()
    expect(log.pasted).toEqual(['git status'])
    c.paste('line1\nline2\n')
    expect(log.pasted[1]).toBe('line1\nline2')
    c.paste('\n\n'); c.paste('')
    expect(log.pasted).toHaveLength(2)
  })

  it('an empty or unreadable clipboard says so and inserts nothing', async () => {
    const e = setup({}, '')
    await e.c.pasteFromClipboard()
    expect(e.log.pasted).toEqual([]); expect(e.log.notes).toEqual(['The clipboard is empty'])
  })
})

describe('placeholder interception on every paste path', () => {
  const cmd = '$env:API_TOKEN = "YOUR_TOKEN"\n$env:URI_KEY = "YOUR_URI_KEY"\n'
  it('right-click, Ctrl+V and Shift+Insert all ask first instead of inserting', async () => {
    const { c, log } = setup({}, cmd)
    c.contextMenu({ x: 0, y: 0 }); await tick()
    c.key(key({ key: 'v', ctrlKey: true })); await tick()
    c.key(key({ key: 'Insert', shiftKey: true })); await tick()
    c.paste(cmd) // the browser's paste event
    expect(log.pasted).toEqual([])
    expect(log.asked).toHaveLength(4)
    expect(log.asked[0].placeholders.map(p => p.token)).toEqual(['YOUR_TOKEN', 'YOUR_URI_KEY'])
    expect(log.asked[0].text).toBe(cmd.trimEnd())
  })

  it('plain text pastes instantly without asking', () => {
    const { c, log } = setup()
    c.paste('Get-ChildItem -Recurse | Select-Object -First 5')
    expect(log.asked).toEqual([]); expect(log.pasted).toHaveLength(1)
  })

  it('Update inserts the corrected command, Paste Original the original, Cancel nothing; none of them presses Enter', () => {
    const { c, log } = setup()
    c.paste(cmd)
    const p = log.asked[0]
    c.resolvePaste(p, { kind: 'text', text: '$env:API_TOKEN = "abc"\n$env:URI_KEY = "u"\n' })
    c.resolvePaste(p, { kind: 'original' })
    c.resolvePaste(p, { kind: 'cancel' })
    expect(log.pasted).toEqual(['$env:API_TOKEN = "abc"\n$env:URI_KEY = "u"', cmd.trimEnd()])
    expect(log.pasted.every(t => !/[\r\n]$/.test(t))).toBe(true)
    expect(log.focus).toBe(3)
  })
})

describe('copy: select to copy and context-menu copy', () => {
  it('select to copy copies exactly the selection on release, keeps it, and can be off', async () => {
    const sel = 'partial line\nsecond line\n  indented tail'
    const a = setup({ selectToCopy: true }); a.st.selection = sel
    await a.c.selectionReleased()
    expect(a.log.copied).toEqual([sel]); expect(a.st.selection).toBe(sel); expect(a.log.focus).toBe(1)
    const b = setup({ selectToCopy: false }); b.st.selection = sel
    await b.c.selectionReleased()
    expect(b.log.copied).toEqual([]) // turning it off does not stop the user from selecting
    const e = setup(); await e.c.selectionReleased(); expect(e.log.copied).toEqual([])
  })

  it('a failed copy is reported', async () => {
    const a = setup(); a.st.selection = 'x'; a.st.writeOk = false
    await a.c.selectionReleased()
    expect(a.log.notes).toEqual(['Could not copy'])
  })

  it('right-click on a selection offers Copy and Paste; Copy puts exactly that text on the clipboard', async () => {
    const a = setup(); a.st.selection = 'chosen text'
    a.c.contextMenu({ x: 5, y: 5 })
    expect(a.log.menus).toEqual([['copy', 'paste']]); expect(a.log.pasted).toEqual([])
    a.st.selection = '' // the click on the menu may clear the selection; Copy uses what was selected when the menu opened
    await a.c.choose('copy')
    expect(a.log.copied).toEqual(['chosen text'])
    await a.c.choose('paste')
    expect(a.log.pasted).toEqual(['clipboard text'])
  })

  it('both copy methods can be on together and each is independent', async () => {
    const both = setup({ selectToCopy: true, contextMenuCopy: true }); both.st.selection = 'abc'
    await both.c.selectionReleased(); both.c.contextMenu({ x: 0, y: 0 }); await both.c.choose('copy')
    expect(both.log.copied).toEqual(['abc', 'abc'])
    const menuOnly = setup({ selectToCopy: false, contextMenuCopy: true, rightClickPaste: false }); menuOnly.st.selection = 'abc'
    menuOnly.c.contextMenu({ x: 0, y: 0 })
    expect(menuOnly.log.menus).toEqual([['copy']])
    const none = setup({ contextMenuCopy: false, rightClickPaste: false }); none.st.selection = 'abc'
    none.c.contextMenu({ x: 0, y: 0 }); expect(none.log.menus).toEqual([])
  })

  it('Ctrl+Shift+C and Ctrl+Insert copy a selection, and are ignored without one', async () => {
    const a = setup(); a.st.selection = 'sel'
    expect(a.c.key(key({ key: 'C', ctrlKey: true, shiftKey: true }))).toBe(false)
    expect(a.c.key(key({ key: 'Insert', ctrlKey: true }))).toBe(false)
    await tick()
    expect(a.log.copied).toEqual(['sel', 'sel'])
    a.st.selection = ''
    expect(a.c.key(key({ key: 'C', ctrlKey: true, shiftKey: true }))).toBe(true)
  })
})
