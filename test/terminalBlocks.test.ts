import { describe, expect, it } from 'vitest'
import { cleanOutput, collectBlocks, formatBlocks, readLines, recordCommand, wholeBuffer } from '../src/renderer/terminalBlocks'

/** A minimal stand-in for xterm's buffer: rows of text, some marked as the wrapped continuation of the row above. */
function fakeTerm(rows: { t: string; wrapped?: boolean }[], cursorY: number) {
  const markers: { line: number; isDisposed: boolean }[] = []
  const buffer = {
    baseY: 0, cursorY, length: rows.length,
    getLine: (y: number) => (rows[y] ? { isWrapped: !!rows[y].wrapped, translateToString: () => rows[y].t } : undefined),
  }
  return {
    term: { buffer: { active: buffer }, registerMarker: (off: number) => { const m = { line: cursorY + off, isDisposed: false }; markers.push(m); return m } } as never,
    markers,
  }
}

describe('terminal output blocks', () => {
  it('joins wrapped rows and trims trailing spaces', () => {
    const { term } = fakeTerm([{ t: 'PS C:\\p> long command ' }, { t: 'continued', wrapped: true }, { t: 'out   ' }], 2)
    expect(readLines((term as { buffer: { active: never } }).buffer.active, 0, 3)).toEqual(['PS C:\\p> long command continued', 'out'])
  })

  it('drops the trailing blank lines and the next prompt, keeps real output', () => {
    expect(cleanOutput(['a', 'b', '', ''], false)).toEqual(['a', 'b'])
    expect(cleanOutput(['a', 'PS C:\\p>'], true)).toEqual(['a'])
    expect(cleanOutput(['a', 'PS C:\\p>', '', ''], true)).toEqual(['a']) // blank rows under the cursor
    expect(cleanOutput(['a', 'user@host:~$'], true)).toEqual(['a'])
    // a line that merely ends in a prompt character in the middle of output is kept when it is not the waiting prompt
    expect(cleanOutput(['a', 'cost: 5$'], false)).toEqual(['a', 'cost: 5$'])
  })

  it('formats one block per command, the command first', () => {
    const text = formatBlocks([{ command: 'PS C:\\p> git status', output: ['On branch main', 'clean'] }, { command: 'PS C:\\p> node -v', output: ['v22.0.0'] }])
    expect(text).toBe('PS C:\\p> git status\nOn branch main\nclean\n\nPS C:\\p> node -v\nv22.0.0')
  })

  it('records the command row (even when it wraps) and reads each block back', () => {
    const rows = [
      { t: 'PS C:\\p> git status' }, { t: 'On branch main' }, { t: 'nothing to commit' },
      { t: 'PS C:\\p> echo a very long' }, { t: ' command line', wrapped: true }, { t: 'a very long command line' },
      { t: 'PS C:\\p> ' },
    ]
    // Enter pressed on the first command, then on the second whose cursor row was its last wrapped row
    const a = fakeTerm(rows, 0), b = fakeTerm(rows, 4)
    const r1 = recordCommand(a.term), r2 = recordCommand(b.term)
    expect(r1.rows).toBe(1); expect(r2.rows).toBe(2)
    expect(r2.marker.line).toBe(3)
    // collect from a terminal whose cursor now sits on the final prompt row
    const final = fakeTerm(rows, 6)
    const blocks = collectBlocks(final.term, [r1, r2])
    expect(blocks).toEqual([
      { command: 'PS C:\\p> git status', output: ['On branch main', 'nothing to commit'] },
      { command: 'PS C:\\p> echo a very long command line', output: ['a very long command line'] },
    ])
    expect(wholeBuffer(final.term)).toBe('PS C:\\p> git status\nOn branch main\nnothing to commit\nPS C:\\p> echo a very long command line\na very long command line')
  })

  it('ignores commands whose lines have scrolled out of the buffer', () => {
    const rows = [{ t: 'PS> one' }, { t: 'x' }, { t: 'PS> two' }, { t: 'y' }, { t: 'PS>' }]
    const t = fakeTerm(rows, 4)
    const r1 = { marker: { line: 0, isDisposed: true } as never, rows: 1 }
    const r2 = { marker: { line: 2, isDisposed: false } as never, rows: 1 }
    expect(collectBlocks(t.term, [r1, r2])).toEqual([{ command: 'PS> two', output: ['y'] }])
  })
})
