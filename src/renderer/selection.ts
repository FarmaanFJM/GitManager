// Multi-selection over an ordered list: one item, a toggle, a range from the last click, everything visible, everything eligible, or nothing.
// Pure functions over a Set of keys, so the behaviour is tested without a window. The selection is independent of any search or filter:
// narrowing the list never drops a selected item, and "all visible" adds only what is currently shown.

export type Selection = { keys: ReadonlySet<string>; anchor: string | null }
export const emptySelection = (): Selection => ({ keys: new Set(), anchor: null })

/** A click on an item: plain replaces nothing but toggles it (checkbox behaviour); with `range` it selects from the anchor to the item in list order. */
export function click(sel: Selection, key: string, order: readonly string[], opts: { range?: boolean } = {}): Selection {
  if (opts.range && sel.anchor !== null && sel.anchor !== key) {
    const a = order.indexOf(sel.anchor), b = order.indexOf(key)
    if (a >= 0 && b >= 0) {
      const next = new Set(sel.keys)
      for (const k of order.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(k)
      return { keys: next, anchor: key }
    }
  }
  const next = new Set(sel.keys)
  if (next.has(key)) next.delete(key); else next.add(key)
  return { keys: next, anchor: key }
}

export function add(sel: Selection, keys: readonly string[]): Selection { return { keys: new Set([...sel.keys, ...keys]), anchor: sel.anchor } }
export function remove(sel: Selection, keys: readonly string[]): Selection { const d = new Set(keys); return { keys: new Set([...sel.keys].filter(k => !d.has(k))), anchor: sel.anchor } }
/** Replaces the selection with exactly these keys. */
export function only(keys: readonly string[]): Selection { return { keys: new Set(keys), anchor: keys[keys.length - 1] ?? null } }
/** Drops keys that no longer exist (after a refresh), keeping the rest. */
export function prune(sel: Selection, existing: readonly string[]): Selection {
  const ok = new Set(existing)
  const keys = new Set([...sel.keys].filter(k => ok.has(k)))
  return keys.size === sel.keys.size ? sel : { keys, anchor: sel.anchor && ok.has(sel.anchor) ? sel.anchor : null }
}
/** 'all' when every key is selected, 'some' when part, 'none' otherwise: the state of a select-all checkbox. */
export function state(sel: Selection, keys: readonly string[]): 'all' | 'some' | 'none' {
  const n = keys.filter(k => sel.keys.has(k)).length
  return n === 0 ? 'none' : n === keys.length ? 'all' : 'some'
}
