import { detectPlaceholders, preparePaste, type Placeholder, type ShellSyntax } from '../shared/placeholders'
import { contextAction, type TerminalPrefs } from '../shared/terminalPrefs'

// The terminal's copy and paste behaviour, with no DOM and no xterm import so it can be tested: the dock gives it the few things it
// needs (the selection, a way to insert text, the clipboard) and forwards events to it. Pasted text is only ever *inserted* at the
// prompt (xterm's paste, which brackets it when the shell asked for that); nothing here sends Enter, so a command is never run for the user.

export type TermLike = { getSelection(): string; paste(text: string): void; focus(): void }

export type KeyLike = { type: string; key: string; code?: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean; preventDefault?: () => void }

export type PendingPaste = { text: string; placeholders: Placeholder[]; syntax: ShellSyntax }
export type PasteChoice = { kind: 'original' } | { kind: 'text'; text: string } | { kind: 'cancel' }

export type ControllerDeps = {
  term: TermLike
  prefs: () => TerminalPrefs
  syntax: () => ShellSyntax
  /** The system clipboard, read through the main process. */
  readClipboard: () => Promise<string>
  writeClipboard: (text: string) => Promise<boolean>
  /** A paste with unresolved placeholders: the dock shows the dialog and calls back resolvePaste. */
  ask: (p: PendingPaste) => void
  /** Show the small Copy / Paste menu at a point. */
  menu: (at: { x: number; y: number }, items: ('copy' | 'paste')[]) => void
  notify: (kind: 'error' | 'info', message: string) => void
}

export const isPasteKey = (e: KeyLike) => e.type === 'keydown' && !e.altKey && ((e.ctrlKey && !e.shiftKey && !e.metaKey && e.key.toLowerCase() === 'v')
  || (e.shiftKey && !e.ctrlKey && !e.metaKey && e.key === 'Insert') || (e.ctrlKey && e.shiftKey && !e.metaKey && e.key.toLowerCase() === 'v')
  || (e.metaKey && !e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'v'))
export const isCopyKey = (e: KeyLike) => e.type === 'keydown' && !e.altKey && ((e.ctrlKey && e.shiftKey && !e.metaKey && e.key.toLowerCase() === 'c')
  || (e.ctrlKey && !e.shiftKey && !e.metaKey && e.key === 'Insert') || (e.metaKey && !e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'c'))

export class TerminalController {
  private menuSelection = ''
  constructor(private readonly d: ControllerDeps) {}

  /** Every way text reaches the terminal from outside goes through here: keyboard, right-click, the browser's paste event. */
  paste(raw: string): void {
    const text = preparePaste(raw)
    if (!text) return
    const placeholders = detectPlaceholders(text, this.d.syntax())
    if (!placeholders.length) { this.d.term.paste(text); return }
    this.d.ask({ text, placeholders, syntax: this.d.syntax() })
  }

  async pasteFromClipboard(): Promise<void> {
    let text = ''
    try { text = await this.d.readClipboard() } catch { this.d.notify('error', 'Could not read the clipboard'); return }
    if (!text) { this.d.notify('info', 'The clipboard is empty'); return }
    this.paste(text)
  }

  resolvePaste(p: PendingPaste, choice: PasteChoice): void {
    if (choice.kind === 'original') this.d.term.paste(p.text)
    else if (choice.kind === 'text') this.d.term.paste(preparePaste(choice.text))
    this.d.term.focus()
  }

  async copySelection(text = this.d.term.getSelection()): Promise<boolean> {
    if (!text) return false
    const ok = await this.d.writeClipboard(text)
    if (!ok) this.d.notify('error', 'Could not copy')
    return ok
  }

  /** Mouse button released after a drag: copy the selection when Select to Copy is on. The selection itself is left alone. */
  async selectionReleased(): Promise<void> {
    if (!this.d.prefs().selectToCopy) return
    const text = this.d.term.getSelection()
    if (!text) return
    await this.copySelection(text)
    this.d.term.focus()
  }

  /** Right-click. Returns true when the event was handled (the caller prevents the browser's own menu). */
  contextMenu(at: { x: number; y: number }): boolean {
    const selection = this.d.term.getSelection()
    const action = contextAction(this.d.prefs(), selection.length > 0)
    if (action.kind === 'none') return true
    if (action.kind === 'paste') { void this.pasteFromClipboard(); return true }
    this.menuSelection = selection
    this.d.menu(at, action.items)
    return true
  }

  async choose(item: 'copy' | 'paste'): Promise<void> {
    if (item === 'copy') await this.copySelection(this.menuSelection)
    else await this.pasteFromClipboard()
    this.d.term.focus()
  }

  /**
   * xterm's key handler: false means "handled here, xterm must not process it". Ctrl+C is never taken (it is the interrupt);
   * copying is Ctrl+Shift+C / Ctrl+Insert, pasting is Ctrl+V, Shift+Insert and Ctrl+Shift+V.
   */
  key(e: KeyLike): boolean {
    if (isPasteKey(e)) { e.preventDefault?.(); void this.pasteFromClipboard(); return false }
    if (isCopyKey(e) && this.d.term.getSelection()) { e.preventDefault?.(); void this.copySelection(); return false }
    return true
  }
}
