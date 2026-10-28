// In-page collector for the objective checks. Serialised by Playwright's page.evaluate, so it must stay self-contained.
/* Runs inside the page. Returns findings for the checks implemented here. */
export function collect({ scope, vw }) {
  const out = []
  const root = document.querySelector(scope) ?? document.body
  const all = [root, ...root.querySelectorAll('*')].filter(e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' })
  const rgba = c => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return [0, 0, 0, 0]; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p[3] ?? 1] }
  const over = (top, bot) => { const a = top[3] + bot[3] * (1 - top[3]); return a === 0 ? [0, 0, 0, 0] : [0, 1, 2].map(i => (top[i] * top[3] + bot[i] * bot[3] * (1 - top[3])) / a).concat(a) }
  const bgOf = el => { let acc = [0, 0, 0, 0]; const chain = []; for (let e = el; e; e = e.parentElement) chain.push(rgba(getComputedStyle(e).backgroundColor)); for (const c of chain) acc = over(acc, c); return over(acc, [20, 21, 21, 1]) }
  const lum = ([r, g, b]) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b) }
  const contrast = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05) }
  const hsl = ([r, g, b]) => { r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; let h = 0; if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return [(h * 60 + 360) % 360, d === 0 ? 0 : d / (1 - Math.abs(mx + mn - 1)), (mx + mn) / 2] }
  const sel = e => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.') : '') + ((e.textContent || '').trim() ? ` "${e.textContent.trim().slice(0, 24)}"` : '')
  const add = (checkId, e, evidence, status = 'fail') => out.push({ checkId, status, target: sel(e), evidence })
  const media = e => e.closest('svg,img,canvas,video,[data-media],.skeleton,.md-tile,.sc-media')
  const overlay = e => e.closest('[role=dialog],[role=menu],[role=listbox],.popover,.dialog,.sm-toast,[role=status],[role=alert]')
  const bordered = e => { const s = getComputedStyle(e); return ['Top', 'Right', 'Bottom', 'Left'].some(k => parseFloat(s[`border${k}Width`]) >= 1 && s[`border${k}Style`] !== 'none' && rgba(s[`border${k}Color`])[3] > 0.04) }
  const isControl = e => /^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName) || e.getAttribute('role') === 'checkbox' || e.getAttribute('role') === 'switch'

  // CHK-001 nested borders
  for (const e of all) {
    if (!bordered(e) || isControl(e) || overlay(e)) continue
    for (let p = e.parentElement; p && p !== root.parentElement; p = p.parentElement) { if (bordered(p) && !overlay(p)) { add('CHK-001', e, `bordered inside bordered ancestor ${sel(p)}`); break } }
  }
  // CHK-002 thick left border
  for (const e of all) { const s = getComputedStyle(e); const l = parseFloat(s.borderLeftWidth), r = parseFloat(s.borderRightWidth); if (l >= 2 && l > r && s.borderLeftStyle !== 'none' && rgba(s.borderLeftColor)[3] > 0.04 && e.tagName !== 'BLOCKQUOTE' && !e.closest('blockquote,[data-semantic-gutter]')) add('CHK-002', e, `border-left ${l}px`) }
  // CHK-003 / CHK-019 destructive buttons
  const verb = /^(delete|remove|discard|destroy|erase|reset|revoke|cancel subscription|resign|close position)\b/i
  for (const e of all.filter(e => e.matches('button,[role=button],a.btn,.btn'))) {
    if (e.closest('[role=menu]')) continue
    const s = getComputedStyle(e); const fg = rgba(s.color); const [h, sat] = hsl(fg); const reddish = (h < 22 || h > 338) && sat > 0.35
    const label = (e.getAttribute('aria-label') || e.textContent || '').trim()
    if (!(reddish || verb.test(label))) continue
    const bg = rgba(s.backgroundColor)
    if (reddish && bg[3] > 0.01 && bg[3] < 0.9) add('CHK-003', e, `translucent tinted bg alpha ${bg[3].toFixed(2)} with red text`)
    else if (reddish && bg[3] === 0) add('CHK-003', e, 'red text on transparent background (ghost destructive)', 'needs-human')
    const c = contrast(fg, bgOf(e)); if ((reddish || verb.test(label)) && bg[3] >= 0.9 && c < 4.5) add('CHK-019', e, `contrast ${c.toFixed(2)}:1`)
    if (verb.test(label) && bg[3] >= 0.9 && c < 4.5) add('CHK-019', e, `contrast ${c.toFixed(2)}:1`)
  }
  // CHK-006 placeholder initials avatar
  for (const e of all) { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); const rad = parseFloat(s.borderTopLeftRadius); if (r.width <= 64 && r.width >= 14 && Math.abs(r.width - r.height) < 2 && (rad >= r.width / 2 - 1 || s.borderTopLeftRadius.includes('%')) && /^[A-Za-z]{1,2}$/.test((e.textContent || '').trim()) && !e.querySelector('img,svg')) add('CHK-006', e, 'round element containing only initials') }
  // CHK-013 gradients and glow on chrome
  for (const e of all) { if (media(e)) continue; const s = getComputedStyle(e); if (/gradient\(/.test(s.backgroundImage) && !e.closest('[class*=scrim]')) add('CHK-013', e, 'gradient background on chrome', 'needs-human'); for (const m of s.boxShadow.matchAll(/(rgba?\([^)]+\))\s+(-?\d+)px\s+(-?\d+)px\s+(\d+)px/g)) { const [r, g, b, a] = rgba(m[1]); if (+m[4] >= 12 && +m[2] === 0 && +m[3] === 0 && (r + g + b > 30) && a > 0.15) add('CHK-013', e, `glow blur ${m[4]}px color ${m[1]}`) } }
  // CHK-017 em dash
  const EM = '—'
  const txt = root.innerText || ''
  if (txt.includes(EM)) out.push({ checkId: 'CHK-017', status: 'fail', target: scope, evidence: `rendered text contains an em dash (${txt.split(EM).length - 1}x)` })
  for (const e of all) for (const a of ['aria-label', 'placeholder', 'title', 'alt']) if ((e.getAttribute(a) || '').includes(EM)) add('CHK-017', e, `${a} contains an em dash`)
  // CHK-008 send and stop together
  for (const c of all.filter(e => e.querySelector('button,.btn'))) { const bs = [...c.querySelectorAll('button,.btn')].filter(b => b.offsetParent); const n = b => (b.getAttribute('aria-label') || b.textContent || '').trim(); if (bs.some(b => /^(send|submit|generate)\b/i.test(n(b))) && bs.some(b => /^(stop|cancel|abort)\b/i.test(n(b))) && bs.length <= 6) add('CHK-008', c, 'Send and Stop visible together') }
  // CHK-009 create beside dropdown
  for (const t of all.filter(e => e.matches('select,[role=combobox],[aria-haspopup=listbox]'))) { const sib = [...(t.parentElement?.children ?? [])].filter(x => x !== t && x.matches('button')); for (const b of sib) if (/^(create|new|add)\b/i.test((b.textContent || '').trim()) && (b.textContent || '').trim().length > 3) add('CHK-009', b, `Create button adjacent to dropdown ${sel(t)}`, 'needs-human') }
  // CHK-011 stacked navigation sidebars
  const navs = all.filter(e => e.matches('nav,aside,[role=navigation]') && e.getBoundingClientRect().height >= innerHeight * 0.6 && e.getBoundingClientRect().width <= 360 && e.getBoundingClientRect().left < 480)
  if (navs.length >= 2) { const rs = navs.map(n => n.getBoundingClientRect()); const sideBySide = rs.some((a, i) => rs.some((b, j) => i < j && Math.abs(a.right - b.left) < 24)); if (sideBySide) out.push({ checkId: 'CHK-011', status: 'fail', target: navs.map(sel).join(' + '), evidence: 'two navigation columns side by side' }) }
  // CHK-012 accent overuse (heuristic)
  let area = 0, filled = 0
  for (const e of all) { if (media(e)) continue; const bg = rgba(getComputedStyle(e).backgroundColor); const [h, sat] = hsl(bg); if (bg[3] > 0.8 && h > 140 && h < 170 && sat > 0.5) { const r = e.getBoundingClientRect(); area += r.width * r.height; filled++ } }
  if (area / (innerWidth * innerHeight) > 0.02 || filled > 3) out.push({ checkId: 'CHK-012', status: 'needs-human', target: scope, evidence: `accent fills ${filled}, area ${(100 * area / (innerWidth * innerHeight)).toFixed(1)}% of viewport` })
  // CHK-020 touch targets (mobile only)
  if (vw <= 480) for (const e of all.filter(e => e.matches('button,a[href],input:not([type=hidden]),[role=button],[role=tab],select'))) { if (e.closest('p,li > span')) continue; const r = e.getBoundingClientRect(); if ((r.width < 40 || r.height < 40) && r.width > 0) add('CHK-020', e, `${Math.round(r.width)}x${Math.round(r.height)}px`) }
  // CHK-021 overflow
  if (document.documentElement.scrollWidth > innerWidth) out.push({ checkId: 'CHK-021', status: 'fail', target: 'document', evidence: `scrollWidth ${document.documentElement.scrollWidth} > ${innerWidth}` })
  return out
}

