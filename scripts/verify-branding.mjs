#!/usr/bin/env node
// Verifies GitManager's Summa logo assets and their use in packaging. No image libraries: PNG and ICO are parsed here.
//   node scripts/verify-branding.mjs                 assets, colours, transparency, ICO frames, packaging config
//   node scripts/verify-branding.mjs --exe <file>    additionally: the icon embedded in a built Windows executable
import { readFileSync, existsSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const TILE = [0x1b, 0x1c, 0x1c], SYMBOL = [0x10, 0xb9, 0x81]
const errors = [], warnings = []
const err = m => errors.push(m)
const warn = m => warnings.push(m)
const ok = m => console.log('  ok  ' + m)
const hex = c => '#' + c.slice(0, 3).map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase()

/** Decodes a non-interlaced 8-bit RGBA PNG into { w, h, px(x, y) -> [r, g, b, a] }. */
export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')
  let pos = 8, w = 0, h = 0, type = 0, depth = 0, interlace = 0
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), name = buf.toString('ascii', pos + 4, pos + 8), data = buf.subarray(pos + 8, pos + 8 + len)
    if (name === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; type = data[9]; interlace = data[12] }
    if (name === 'IDAT') idat.push(data)
    pos += 12 + len
  }
  if (type !== 6 || depth !== 8 || interlace) throw new Error(`expected 8-bit RGBA non-interlaced, got type ${type} depth ${depth} interlace ${interlace}`)
  const raw = inflateSync(Buffer.concat(idat)), bpp = 4, stride = w * bpp
  const out = Buffer.alloc(h * stride)
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0, b = y ? out[(y - 1) * stride + x] : 0, c = x >= bpp && y ? out[(y - 1) * stride + x - bpp] : 0
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      out[y * stride + x] = (line[x] + pred) & 0xff
    }
  }
  return { w, h, px: (x, y) => [...out.subarray(y * stride + x * 4, y * stride + x * 4 + 4)] }
}

/** Every opaque pixel must be the tile colour, the symbol colour, or an anti-aliasing blend of the two: no gradient, glow or shadow. */
function checkRaster(name, img, { strict = true } = {}) {
  const report = strict ? err : warn
  const corners = [[0, 0], [img.w - 1, 0], [0, img.h - 1], [img.w - 1, img.h - 1]]
  const maxCornerAlpha = Math.max(...corners.map(([x, y]) => img.px(x, y)[3]))
  if (maxCornerAlpha > 8) err(`${name}: corners are not transparent (alpha ${maxCornerAlpha})`)
  let tile = 0, symbol = 0, transparent = 0, off = 0
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
    const [r, g, b, a] = img.px(x, y)
    if (a === 0) { transparent++; continue }
    if (r === TILE[0] && g === TILE[1] && b === TILE[2]) { tile++; continue }
    if (r === SYMBOL[0] && g === SYMBOL[1] && b === SYMBOL[2]) { symbol++; continue }
    // distance from the line between the two brand colours (in RGB), allowing rounding from anti-aliasing
    const t = Math.max(0, Math.min(1, ((r - TILE[0]) * (SYMBOL[0] - TILE[0]) + (g - TILE[1]) * (SYMBOL[1] - TILE[1]) + (b - TILE[2]) * (SYMBOL[2] - TILE[2])) / ((SYMBOL[0] - TILE[0]) ** 2 + (SYMBOL[1] - TILE[1]) ** 2 + (SYMBOL[2] - TILE[2]) ** 2)))
    const d = Math.hypot(r - (TILE[0] + t * (SYMBOL[0] - TILE[0])), g - (TILE[1] + t * (SYMBOL[1] - TILE[1])), b - (TILE[2] + t * (SYMBOL[2] - TILE[2])))
    if (d > 6 && a > 200) off++
  }
  const total = img.w * img.h
  if (!transparent) err(`${name}: no transparent pixels`)
  if (!tile) err(`${name}: no pixel is exactly ${hex(TILE)}`)
  if (!symbol && img.w >= 24) report(`${name}: no pixel is exactly ${hex(SYMBOL)}`)
  if (off > total * 0.002) report(`${name}: ${off} opaque pixels are neither brand colour nor a blend of them (resampling ringing)`)
  return { tile: tile / total, symbol: symbol / total, transparent: transparent / total, off }
}

function parseIco(buf) {
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) throw new Error('not an ICO file')
  const n = buf.readUInt16LE(4)
  return Array.from({ length: n }, (_, i) => {
    const e = 6 + i * 16
    const w = buf[e] || 256, h = buf[e + 1] || 256, size = buf.readUInt32LE(e + 8), offset = buf.readUInt32LE(e + 12)
    return { w, h, data: buf.subarray(offset, offset + size) }
  })
}

console.log('Summa logo assets')
const svg = readFileSync('assets/brand/GitManager-Summa.svg', 'utf8').replace(/<!--[\s\S]*?-->/g, '') // comments may mention 'gradients'
if (!/<rect[^>]*rx="\d+"[^>]*fill="#1B1C1C"/i.test(svg)) err('SVG: no rounded rect filled #1B1C1C')
if (!/stroke="#10B981"/i.test(svg)) err('SVG: symbol stroke is not #10B981')
if (/gradient|filter|<text|<image|opacity=|shadow|blur/i.test(svg)) err('SVG: contains a gradient, filter, text, image or effect')
const colours = [...new Set((svg.match(/#[0-9a-f]{6}\b/gi) ?? []).map(c => c.toUpperCase()))]
if (colours.sort().join() !== '#10B981,#1B1C1C') err(`SVG: colours are ${colours.join(', ')}, expected only #1B1C1C and #10B981`)
else ok('SVG: rounded #1B1C1C tile, one #10B981 symbol, no effects')

for (const f of ['GitManager-Summa.png', 'GitManager-Summa-512.png', 'GitManager-Summa-256.png', 'GitManager-Summa-128.png', 'GitManager-Summa-64.png', 'GitManager-Summa-32.png']) {
  const img = decodePng(readFileSync(`assets/brand/${f}`))
  const s = checkRaster(f, img)
  ok(`${f}: ${img.w}x${img.h} RGBA, transparent corners, tile ${(s.tile * 100).toFixed(0)}%, symbol ${(s.symbol * 100).toFixed(1)}% exact colour`)
}

const ico = readFileSync('assets/brand/GitManager-Summa.ico')
const frames = parseIco(ico)
const sizes = frames.map(f => f.w)
for (const need of [16, 24, 32, 48, 64, 128, 256]) if (!sizes.includes(need)) err(`ICO: no ${need}x${need} frame`)
for (const f of frames) {
  if (f.data.readUInt32BE(0) !== 0x89504e47) { ok(`ICO ${f.w}: BMP frame (not decoded)`); continue }
  const img = decodePng(f.data)
  if (img.w !== f.w) err(`ICO ${f.w}: frame is ${img.w} pixels wide`)
  // The supplied ICO is shipped as supplied. Its small frames were downsampled with a ringing filter; that is reported, not failed.
  checkRaster(`ICO ${f.w}x${f.h}`, img, { strict: false })
}
ok(`ICO: ${sizes.join(', ')} px frames with transparency`)

console.log('Packaging')
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const b = pkg.build ?? {}
if (!existsSync('build/icon.ico') || !readFileSync('build/icon.ico').equals(ico)) err('build/icon.ico is missing or differs from assets/brand/GitManager-Summa.ico')
if (b.win?.icon !== 'build/icon.ico') err('build.win.icon is not build/icon.ico')
for (const k of ['installerIcon', 'uninstallerIcon', 'installerHeaderIcon']) if (b.nsis?.[k] !== 'build/icon.ico') err(`build.nsis.${k} is not build/icon.ico`)
if (b.nsis?.createDesktopShortcut === false) err('the installer does not create a desktop shortcut')
if (!(b.files ?? []).some(f => f.startsWith('assets/brand'))) err('the window icon (assets/brand) is not packaged')
if (!errors.length) ok('electron-builder uses build/icon.ico for the executable, installer, uninstaller and shortcuts; the window icon is packaged')

const exeIdx = process.argv.indexOf('--exe')
if (exeIdx > 0) {
  const exe = process.argv[exeIdx + 1]
  console.log(`Executable ${exe}`)
  const { NtExecutable, NtExecutableResource, Resource } = require('resedit')
  const res = NtExecutableResource.from(NtExecutable.from(readFileSync(exe), { ignoreCert: true }))
  const groups = Resource.IconGroupEntry.fromEntries(res.entries)
  if (!groups.length) err(`${exe}: no icon group resource`)
  const icons = groups.flatMap(g => g.getIconItemsFromEntries(res.entries))
  const embedded = icons.map(i => (i.data ? Buffer.from(i.data) : Buffer.from(i.bin ?? [])))
  const expected = frames.map(f => f.data)
  const matched = expected.filter(e => embedded.some(x => x.equals(e))).length
  if (matched !== expected.length) err(`${exe}: ${matched} of ${expected.length} GitManager icon frames found in the executable (default Electron icon?)`)
  else ok(`${exe}: carries all ${expected.length} GitManager icon frames, byte for byte`)
}

if (warnings.length) { console.log('\nwarnings (supplied assets, shipped unchanged):'); warnings.forEach(w => console.log(' - ' + w)) }
if (errors.length) { console.error('\nbranding verification FAILED'); errors.forEach(e => console.error(' - ' + e)); process.exit(1) }
console.log('\nbranding verified')
