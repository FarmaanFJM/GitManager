import { installedFonts } from '../shared/terminalPrefs'

let cache: string[] | null = null

/** The monospace fonts from GitManager's candidate list that are installed on this computer (measured once with a canvas). */
export function installedMonospaceFonts(): string[] {
  if (cache) return cache
  try {
    const ctx = document.createElement('canvas').getContext('2d')
    if (!ctx) return (cache = [])
    const sample = 'mmmmmmmmmmlli WwOo0@#'
    cache = installedFonts(family => { ctx.font = `64px ${family}`; return ctx.measureText(sample).width })
  } catch { cache = [] }
  return cache
}
