// Copying what a terminal showed, one command at a time. The page records where each command was entered (an xterm marker on its
// line, so the position survives scrolling and trimming), and the text is read back from the terminal's own buffer: exactly what is
// on screen, including the prompt, a command completed with Tab or recalled from history, and the output that followed it.
import type { IBuffer, IMarker, Terminal } from '@xterm/xterm'

export type Recorded = { marker: IMarker; /** Lines the command occupies (a long command wraps onto more than one). */ rows: number }
export type Block = { command: string; output: string[] }

const trimEnd = (s: string) => s.replace(/\s+$/, '')

/** Logical lines of a buffer range: wrapped rows are joined, trailing blanks of each row removed. */
export function readLines(buf: Pick<IBuffer, 'getLine'>, from: number, to: number): string[] {
  const out: string[] = []
  for (let y = from; y < to; y++) {
    const line = buf.getLine(y)
    if (!line) continue
    const text = line.translateToString(true)
    if (line.isWrapped && out.length) out[out.length - 1] += text
    else out.push(text)
  }
  return out.map(trimEnd)
}

/** The prompt of the line the cursor is on, with nothing typed: the shell is waiting, so it is not part of any output. */
const PROMPT_END = /[>$#%]$/

/** Drops blank lines at the end, and a final line that is just the shell's next prompt. */
export function cleanOutput(lines: string[], endsAtCursorLine: boolean): string[] {
  const out = [...lines]
  const trim = () => { while (out.length && out[out.length - 1] === '') out.pop() }
  trim() // the rows below the cursor are blank
  if (endsAtCursorLine && out.length && PROMPT_END.test(out[out.length - 1])) { out.pop(); trim() }
  return out
}

/** One text block per command: the command as entered (with its prompt), then its output. */
export function formatBlocks(blocks: Block[]): string {
  return blocks.map(b => [b.command, ...b.output].join('\n')).join('\n\n')
}

/** Records where a command was entered. Call when Enter is pressed: the cursor is still on the command's last row. */
export function recordCommand(term: Terminal): Recorded {
  const buf = term.buffer.active
  const y = buf.baseY + buf.cursorY
  let start = y
  while (start > 0 && buf.getLine(start)?.isWrapped) start--
  let end = y
  while (buf.getLine(end + 1)?.isWrapped) end++
  return { marker: term.registerMarker(start - y)!, rows: end - start + 1 }
}

/** The blocks still in the buffer (a marker is disposed when its line scrolls out of the scrollback). */
export function collectBlocks(term: Terminal, records: Recorded[]): Block[] {
  const buf = term.buffer.active
  const live = records.filter(r => r && !r.marker.isDisposed && r.marker.line >= 0).sort((a, b) => a.marker.line - b.marker.line)
  const cursorLine = buf.baseY + buf.cursorY
  return live.map((r, i) => {
    const start = r.marker.line
    const afterCommand = start + r.rows
    const next = live[i + 1]?.marker.line ?? buf.length
    const command = readLines(buf, start, afterCommand).join('\n')
    const output = cleanOutput(readLines(buf, afterCommand, next), next - 1 >= cursorLine)
    return { command, output }
  })
}

/** Everything the terminal still holds, as plain text. */
export function wholeBuffer(term: Terminal): string {
  const buf = term.buffer.active
  return cleanOutput(readLines(buf, 0, buf.length), true).join('\n')
}
