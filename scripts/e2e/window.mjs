// Window checks shared by the acceptance scenario (scripts/e2e.mjs) and the installed Windows build (scripts/e2e-windows.mjs).

/**
 * The title bar as the page lays it out around the window controls overlay: the drag strip's geometry, the caption
 * button area, interactive elements inside the strip that would start a window drag instead of receiving the click,
 * and controls that would sit under the caption buttons.
 */
export async function titlebarReport(page) {
  return page.evaluate(() => {
    const region = el => { const cs = getComputedStyle(el); return cs.getPropertyValue('-webkit-app-region') || cs.getPropertyValue('app-region') }
    const name = el => `${el.tagName.toLowerCase()}${el.getAttribute('aria-label') ? `[${el.getAttribute('aria-label')}]` : ''} "${(el.textContent ?? '').trim().slice(0, 24)}"`
    const wco = navigator.windowControlsOverlay
    const area = wco?.visible ? wco.getTitlebarAreaRect().toJSON() : null
    const strip = document.querySelector('.gm-titlebar')
    const s = strip.getBoundingClientRect()
    const interactive = 'button, input, select, textarea, a[href], label, summary, [role="button"], [role="tab"], [role="switch"], [role="combobox"], [tabindex]:not([tabindex="-1"])'
    const dragging = [], underCaption = []
    for (const el of document.querySelectorAll(interactive)) {
      const b = el.getBoundingClientRect()
      if (!b.width || !b.height) continue
      if (b.top < s.bottom && b.bottom > s.top && b.left < s.right && b.right > s.left && region(el) !== 'no-drag') dragging.push(name(el))
      if (area && b.top < area.height && b.right > area.x + area.width + 0.5) underCaption.push(name(el))
    }
    return {
      overlay: document.documentElement.dataset.titlebar === 'overlay',
      area, innerWidth, devicePixelRatio,
      strip: { x: s.x, y: s.y, width: s.width, height: s.height, region: region(strip) },
      captionWidth: area ? innerWidth - area.x - area.width : 0,
      dragging, underCaption,
    }
  })
}

/** Problems in a titlebarReport, empty when the title bar is laid out correctly. */
export function titlebarProblems(r, height = 52) {
  const p = []
  if (!r.overlay) p.push('the window controls overlay is not active')
  if (!r.area) return p
  if (r.strip.region !== 'drag') p.push(`the title bar strip is not draggable (${r.strip.region})`)
  if (Math.abs(r.strip.height - height) > 0.5 || Math.abs(r.area.height - height) > 0.5) p.push(`title bar height ${r.strip.height}/${r.area.height}, expected ${height}`)
  if (Math.abs(r.strip.x + r.strip.width - (r.area.x + r.area.width)) > 0.5) p.push('the drag strip reaches under the caption buttons')
  if (r.captionWidth < 40) p.push(`caption buttons area is ${r.captionWidth}px wide`)
  if (r.dragging.length) p.push(`controls inside the drag strip without no-drag: ${r.dragging.join(', ')}`)
  if (r.underCaption.length) p.push(`controls under the caption buttons: ${r.underCaption.join(', ')}`)
  return p
}
