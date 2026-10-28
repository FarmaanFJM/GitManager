// Runs Summa-UI's objective checks (guidance-v0.1.0 checks/rules.json) against a live GitManager window.
// collector.mjs is copied unchanged from summa-ui@guidance-v0.1.0 (scripts/lib/collector.mjs); the keyboard focus walk
// below follows summa-ui's scripts/run-checks.mjs (CHK-004, CHK-018, CHK-022). Desktop only: GitManager has no phone
// layout, so the touch target check CHK-020 does not apply.
import { collect } from './collector.mjs'

export async function runSummaChecks(page, { focusStops = 30 } = {}) {
  const vw = page.viewportSize()?.width ?? 1320
  const findings = (await page.evaluate(collect, { scope: 'body', vw })).filter(f => f.checkId !== 'CHK-020')
  const focus = []
  await page.evaluate(() => (document.activeElement)?.blur?.())
  for (let i = 0; i < focusStops; i++) {
    await page.keyboard.press('Tab')
    await page.waitForTimeout(120)
    const f = await page.evaluate(() => {
      const e = document.activeElement
      if (!e || e === document.body) return null
      const s = getComputedStyle(e); const r = e.getBoundingClientRect()
      const rgba = c => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return [0, 0, 0, 0]; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p[3] ?? 1] }
      const over = (top, bot) => { const a = top[3] + bot[3] * (1 - top[3]); return a === 0 ? [0, 0, 0, 0] : [0, 1, 2].map(i => (top[i] * top[3] + bot[i] * bot[3] * (1 - top[3])) / a).concat(a) }
      let bg = [0, 0, 0, 0]; for (let p = e.parentElement; p; p = p.parentElement) bg = over(bg, rgba(getComputedStyle(p).backgroundColor)); bg = over(bg, [20, 21, 21, 1])
      let ring = null, width = 0
      if (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) { ring = rgba(s.outlineColor); width = parseFloat(s.outlineWidth) }
      else { const m = s.boxShadow.match(/(rgba?\([^)]+\))\s+0px\s+0px\s+0px\s+([\d.]+)px/); if (m) { ring = rgba(m[1]); width = parseFloat(m[2]) } }
      const name = e.tagName.toLowerCase() + (e.getAttribute('aria-label') ? `[${e.getAttribute('aria-label')}]` : (e.textContent || '').trim() ? ` "${(e.textContent || '').trim().slice(0, 24)}"` : '')
      return { name, ring, width, bg, visible: r.width > 0 }
    })
    if (f && f.visible) focus.push(f)
  }
  const lum = ([r, g, b]) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b) }
  const contrast = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05) }
  for (const f of focus) {
    if (!f.ring) { findings.push({ checkId: 'CHK-022', status: 'needs-human', target: f.name, evidence: 'no outline or ring detected on keyboard focus (may use a surface change)' }); continue }
    const eff = [0, 1, 2].map(i => f.ring[i] * f.ring[3] + f.bg[i] * (1 - f.ring[3]))
    const c = contrast(eff, f.bg)
    if (c < 3) findings.push({ checkId: 'CHK-018', status: 'fail', target: f.name, evidence: `focus ring contrast ${c.toFixed(2)}:1` })
    if (f.width > 2) findings.push({ checkId: 'CHK-018', status: 'fail', target: f.name, evidence: `focus ring ${f.width}px exceeds 2px`, severity: 'warning' })
    const [r, g, b] = f.ring; if (g > r * 1.4 && g > b * 1.15 && g > 120) findings.push({ checkId: 'CHK-004', status: 'fail', target: f.name, evidence: `focus ring is green (${f.ring.join(',')})` })
  }
  await page.keyboard.press('Escape')
  return { focusStops: focus.length, findings }
}
