// The Collect mini app's own pictures: its icon, splash, embed and og images in collect/, and the OpenSea collection
// image and banner in public/nft/ (served at quilcast.com/nft/). Run `node scripts/collect-art.mjs` after changing them.
import { Resvg } from '@resvg/resvg-js'
import { writeFileSync } from 'node:fs'
import { LOGO } from '../src/shared.ts'
const root = new URL('..', import.meta.url).pathname
const pub = root + 'collect/'
const fontFiles = [root + 'server/fonts/Inter-Bold.ttf', root + 'server/fonts/Inter-Regular.ttf']
const GEM = 'M6 3h12l4 6-10 12L2 9zM2 9h20M11 3 8 9l4 12 4-12-3-6'
const BG = '#0d0c11', INK = '#edebf3', MUTED = '#9893a5', ACCENT = '#5b3df5'

const bg = (w, h) => `<defs><radialGradient id="g" cx="0.85" cy="0" r="0.9"><stop offset="0" stop-color="#3a2a9a"/><stop offset="1" stop-color="${BG}" stop-opacity="0"/></radialGradient>
  <linearGradient id="tile" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7a61ff"/><stop offset="1" stop-color="#4a2fd6"/></linearGradient></defs>
  <rect width="${w}" height="${h}" fill="${BG}"/><rect width="${w}" height="${h}" fill="url(#g)"/>`
/** The gem in a purple tile, `s` px wide, top left at x, y. */
const tile = (x, y, s) => `<rect x="${x}" y="${y}" width="${s}" height="${s}" rx="${s * 0.22}" fill="url(#tile)"/>
  <g transform="translate(${x + s * 0.2} ${y + s * 0.2}) scale(${(s * 0.6) / 24})"><path d="${GEM}" fill="none" stroke="#fff" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></g>`
/** A collected cast, drawn abstractly (no one's real cast): avatar, text lines, picture, footer. 300×300 at scale 1. */
const card = (x, y, s, rot, hue) => `<g transform="translate(${x} ${y}) rotate(${rot}) scale(${s})">
  <rect x="-150" y="-150" width="300" height="300" rx="22" fill="#1c1a23" stroke="#2f2c3b" stroke-width="2"/>
  <circle cx="-114" cy="-114" r="16" fill="${hue}"/><rect x="-88" y="-124" width="92" height="12" rx="6" fill="${INK}" fill-opacity="0.85"/><rect x="-88" y="-106" width="60" height="9" rx="4.5" fill="${MUTED}" fill-opacity="0.7"/>
  <rect x="-130" y="-76" width="236" height="11" rx="5.5" fill="${INK}" fill-opacity="0.7"/><rect x="-130" y="-56" width="170" height="11" rx="5.5" fill="${INK}" fill-opacity="0.7"/>
  <rect x="-130" y="-30" width="260" height="128" rx="14" fill="${hue}" fill-opacity="0.35"/>
  <line x1="-130" y1="114" x2="130" y2="114" stroke="#2f2c3b" stroke-width="2"/>
  <rect x="-130" y="124" width="14" height="14" rx="4" fill="${ACCENT}"/><rect x="-108" y="127" width="64" height="8" rx="4" fill="${INK}" fill-opacity="0.6"/>
</g>`
const svg = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${bg(w, h)}${body}</svg>`
const draw = (s, file) => writeFileSync(file, new Resvg(s, { font: { loadSystemFonts: false, fontFiles, defaultFontFamily: 'Inter' } }).render().asPng())
const text = (x, y, size, fill, t, bold = false) => `<text x="${x}" y="${y}" font-family="Inter" font-size="${size}"${bold ? ' font-weight="700"' : ''} fill="${fill}">${t}</text>`
const cards = (cx, cy, s) => card(cx - 150 * s, cy + 20 * s, s * 0.9, -9, '#ff5c8a') + card(cx + 150 * s, cy + 20 * s, s * 0.9, 9, '#3fd0a4') + card(cx, cy, s, 0, '#7a61ff')

// icon: the tile filling the square (stores want no transparency); splash: the tile on the dark background
draw(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><defs><linearGradient id="tile" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7a61ff"/><stop offset="1" stop-color="#4a2fd6"/></linearGradient></defs><rect width="1024" height="1024" fill="url(#tile)"/><g transform="translate(205 205) scale(${614 / 24})"><path d="${GEM}" fill="none" stroke="#fff" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></g></svg>`, pub + 'icon.png')
draw(svg(200, 200, tile(40, 40, 120)), pub + 'splash.png')
// 3:2 embed and 1200×630 og: name and line on the left, a fan of collected casts on the right
const wide = (w, h) => svg(w, h, `${tile(80, h / 2 - 150, 96)}
  ${text(80, h / 2 + 18, 64, INK, 'Quilcast Collect', true)}
  ${text(80, h / 2 + 72, 30, MUTED, 'Any cast, collected as a free 1/1 on Base')}
  <g transform="translate(78 ${h / 2 + 116}) scale(1.1)"><rect width="32" height="32" rx="9" fill="${ACCENT}"/><path d="${LOGO}" fill="#fff"/></g>${text(126, h / 2 + 145, 28, INK, 'Quilcast', true)}
  ${cards(935, h / 2 - 10, 0.74)}`)
draw(wide(1200, 800), pub + 'embed.png')
draw(wide(1200, 630), pub + 'og.png')
// OpenSea: a square collection image and a 1400×350 banner (its middle is what shows on phones)
draw(svg(1000, 1000, tile(200, 200, 600)), root + 'public/nft/collection.png')
draw(svg(1400, 350, `${cards(215, 175, 0.55)}${cards(1185, 175, 0.55)}
  ${text(700, 168, 56, INK, 'Quilcast Collect', true).replace('<text', '<text text-anchor="middle"')}
  ${text(700, 216, 26, MUTED, 'Any cast, collected as a free 1/1 on Base').replace('<text', '<text text-anchor="middle"')}`), root + 'public/nft/banner.png')
