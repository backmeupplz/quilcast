// The share cards' and NFTs' SVGs, built from what server/index.mjs fetches for them. Quilcast Cards: a Farcaster profile
// as a trading card, a free 1/1 NFT on Base (contracts/src/QuilcastCards.sol, token id = the FID). The card shows the
// profile as it was when it was collected; server/index.mjs keeps that snapshot.
import { castText, DEFAULTS, FONTS as FONT_STACKS, isImg, isVid, LOGO, n, P, styled, unmarkdown, urlsOf, X_LOGO } from '../src/shared.ts'
import { PRESETS as EFFECTS } from '../src/fx.ts'
import { fname, nameOf as profileName } from './profile.mjs'
import { cut, ends, esc, exactly, initial, layout, richSvg, textSvg, width, wrap } from './text.mjs'

/** How rare a card is, by how early its account joined: the lower the FID, the older the card. */
export const TIERS = [
  { max: 1000, name: 'Legendary', foil: ['#fff4c2', '#e8b94a', '#9a6a1c', '#ffe08a', '#c8902e'], glow: '#6b4a12', ink: '#ffe9a8' },
  { max: 20000, name: 'Epic', foil: ['#ffb3f0', '#b46bff', '#5b3df5', '#ff7ad9', '#8a5cff'], glow: '#4a2390', ink: '#e3c4ff' },
  { max: 250000, name: 'Rare', foil: ['#b8f3ff', '#4cc9ff', '#2f5bff', '#7fe3ff', '#3a86ff'], glow: '#123d7a', ink: '#bfe9ff' },
  { max: Infinity, name: 'Common', foil: ['#f4f5f9', '#b9bdca', '#6d7283', '#e2e4ec', '#9095a6'], glow: '#2c2f3a', ink: '#dfe2ea' },
]
export const tierOf = (fid) => TIERS.find((t) => fid <= t.max)
/** 0 to 100 from followers, on a log scale: 10 is 17, 1,000 is 50, a million or more is 100. */
export const powerOf = (followers) => Math.min(100, Math.round((Math.log10((followers || 0) + 1) / 6) * 100))
const dayOf = (at) => new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
const nameOf = (u) => cut(u.display_name || u.username || `!${u.fid}`, 80)
/** Quilcast's logo on its tile, 32 px times `s`, its corner at `x`, `y`. */
export const logoTile = (x, y, s) => `<g transform="translate(${x} ${y}) scale(${s})"><rect width="32" height="32" rx="9" fill="#5b3df5"/><path d="${LOGO}" fill="#fff"/></g>`
// the cast and profile cards' footer
const FOOT = `<line x1="84" y1="540" x2="1116" y2="540" stroke="#25232d" stroke-width="2"/>
  ${logoTile(84, 562, 1.25)}
  <text x="138" y="593" font-family="Inter" font-weight="700" font-size="28" fill="#edebf3">Quilcast</text>`
// the rainbow and glitter name effects' fills, glitter's in `color`
const nameFxDefs = (color) => `<linearGradient id="rainbow"><stop offset="0" stop-color="#ff004c"/><stop offset="0.2" stop-color="#ff8a00"/><stop offset="0.4" stop-color="#ffe600"/><stop offset="0.6" stop-color="#2bd44a"/><stop offset="0.8" stop-color="#00a2ff"/><stop offset="1" stop-color="#8a2be2"/></linearGradient>
    <linearGradient id="glitter" x2="1" y2="0.3"><stop offset="0.3" stop-color="${color}"/><stop offset="0.5" stop-color="#fff"/><stop offset="0.7" stop-color="${color}"/></linearGradient>`
// SVG strokes for the CSS border styles (`bw` wide)
const dashOf = (style, bw) => (style === 'dashed' ? ` stroke-dasharray="${bw * 3} ${bw * 2}"` : style === 'dotted' ? ` stroke-dasharray="0 ${bw * 2}" stroke-linecap="round"` : '')
/** ASCII `t` (digits, a date) right-aligned to `x` */
const right = (t, x, { y, size, bold, fill }) => `<text x="${x}" y="${y}" font-family="Inter" font-size="${size}"${bold ? ' font-weight="700"' : ''} fill="${fill}" text-anchor="end">${t}</text>`
// a four-pointed star, the tier's mark
const STAR = 'M0-1C.12-.3.3-.12 1 0 .3.12.12.3 0 1-.12.3-.3.12-1 0-.3-.12-.12-.3 0-1z'

/** The card, 1200×1200: the profile's name and FID on top, its picture in a foil window, its counts as stats, the bio as
 *  flavor text, and the tier, set and date at the bottom. `pfp` is a data URI (or null); `at` when it was collected. */
export function cardArt(u, pfp, at) {
  const t = tierOf(u.fid), [f0, f1, f2, f3, f4] = t.foil
  const name = nameOf(u)
  const fid = String(u.fid)
  // Inter's bold digits are about 0.6 em wide each
  const fidW = fid.length * 0.6 * 56
  const followers = u.follower_count || 0
  const power = powerOf(followers)
  const bio = wrap((u.profile?.bio?.text || '').replace(/\s+/g, ' ').trim() || `@${u.username || u.fid} on Farcaster.`, 28, 976, 2)
  // the window: the picture blurred behind it, sharp in the middle
  const W = { x: 92, y: 214, w: 1016, h: 520 }
  const P = { s: 440, x: 600 - 220, y: W.y + 40 }
  const stat = (i, label, value, bar) => {
    const x = 92 + i * 344, w = 328
    return `<rect x="${x}" y="822" width="${w}" height="124" rx="22" fill="#000" fill-opacity="0.32" stroke="${f1}" stroke-opacity="0.35" stroke-width="2"/>
  ${textSvg([label], { x: x + 26, y: 862, size: 22, bold: true, fill: t.ink })}
  ${textSvg([value], { x: x + 26, y: 918, size: 46, bold: true, fill: '#fff' })}
  ${bar ? `<rect x="${x + 172}" y="900" width="130" height="14" rx="7" fill="#fff" fill-opacity="0.12"/><rect x="${x + 172}" y="900" width="${Math.max(14, 1.3 * power)}" height="14" rx="7" fill="url(#qc-foil)"/>` : ''}`
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200" viewBox="0 0 1200 1200">
  <defs>
    <linearGradient id="qc-foil" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${f0}"/><stop offset="0.28" stop-color="${f1}"/><stop offset="0.5" stop-color="${f2}"/><stop offset="0.72" stop-color="${f3}"/><stop offset="1" stop-color="${f4}"/></linearGradient>
    <linearGradient id="qc-holo" x1="0" y1="0" x2="1" y2="1" spreadMethod="repeat" gradientTransform="scale(0.18)"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.45" stop-color="#fff" stop-opacity="0.22"/><stop offset="0.55" stop-color="#fff" stop-opacity="0"/></linearGradient>
    <radialGradient id="qc-glow" cx="0.5" cy="0.32" r="0.75"><stop offset="0" stop-color="${t.glow}"/><stop offset="1" stop-color="#0e0d14"/></radialGradient>
    <linearGradient id="qc-shade" x1="0" y1="0" x2="0" y2="1"><stop offset="0.55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.55"/></linearGradient>
    <filter id="qc-blur" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="28"/></filter>
    <filter id="qc-drop" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="14" stdDeviation="18" flood-color="#000" flood-opacity="0.55"/></filter>
    <clipPath id="qc-win"><rect x="${W.x}" y="${W.y}" width="${W.w}" height="${W.h}" rx="26"/></clipPath>
    <linearGradient id="qc-sheen" x1="0" y1="0" x2="1" y2="1"><stop offset="0.3" stop-color="#fff" stop-opacity="0"/><stop offset="0.42" stop-color="#fff" stop-opacity="0.16"/><stop offset="0.5" stop-color="#fff" stop-opacity="0"/></linearGradient>
    <clipPath id="qc-pic"><rect x="${P.x}" y="${P.y}" width="${P.s}" height="${P.s}" rx="36"/></clipPath>
  </defs>
  <rect width="1200" height="1200" fill="#0b0a10"/>
  <rect x="24" y="24" width="1152" height="1152" rx="56" fill="url(#qc-foil)"/>
  <rect x="24" y="24" width="1152" height="1152" rx="56" fill="url(#qc-holo)"/>
  <rect x="52" y="52" width="1096" height="1096" rx="34" fill="url(#qc-glow)"/>
  <rect x="52" y="52" width="1096" height="1096" rx="34" fill="none" stroke="#000" stroke-opacity="0.45" stroke-width="3"/>
  ${textSvg([wrap(name, 52, 1016 - fidW - 120, 1, { bold: true })[0] || ''], { x: 92, y: 140, size: 52, bold: true, fill: '#fff' })}
  ${textSvg([wrap(`@${u.username || u.fid}`, 28, 700, 1)[0] || ''], { x: 92, y: 184, size: 28, fill: t.ink })}
  ${right(fid, 1108, { y: 140, size: 56, bold: true, fill: '#fff' })}
  ${right('FID', 1108 - fidW - 14, { y: 140, size: 24, bold: true, fill: t.ink })}
  <rect x="${W.x - 6}" y="${W.y - 6}" width="${W.w + 12}" height="${W.h + 12}" rx="32" fill="url(#qc-foil)"/>
  <g clip-path="url(#qc-win)">
    <rect x="${W.x}" y="${W.y}" width="${W.w}" height="${W.h}" fill="${t.glow}"/>
    ${pfp ? `<image href="${pfp}" x="${W.x - 60}" y="${W.y - 300}" width="${W.w + 120}" height="${W.w + 120}" preserveAspectRatio="xMidYMid slice" filter="url(#qc-blur)" opacity="0.85"/>` : ''}
    <rect x="${W.x}" y="${W.y}" width="${W.w}" height="${W.h}" fill="#0b0a10" fill-opacity="0.25"/>
    <rect x="${W.x}" y="${W.y}" width="${W.w}" height="${W.h}" fill="url(#qc-holo)"/>
    <rect x="${W.x}" y="${W.y}" width="${W.w}" height="${W.h}" fill="url(#qc-shade)"/>
  </g>
  <rect x="${P.x - 5}" y="${P.y - 5}" width="${P.s + 10}" height="${P.s + 10}" rx="40" fill="url(#qc-foil)" filter="url(#qc-drop)"/>
  <rect x="${P.x}" y="${P.y}" width="${P.s}" height="${P.s}" rx="36" fill="#2a2735"/>
  ${pfp ? `<image href="${pfp}" x="${P.x}" y="${P.y}" width="${P.s}" height="${P.s}" preserveAspectRatio="xMidYMid slice" clip-path="url(#qc-pic)"/>` : initial(name, 600, P.y + P.s / 2 + 60, 170, '#9893a5')}
  <rect x="${P.x}" y="${P.y}" width="${P.s}" height="${P.s}" rx="36" fill="url(#qc-sheen)"/>
  <g transform="translate(92 784)">
    <g transform="translate(14 -9) scale(14)"><path d="${STAR}" fill="url(#qc-foil)"/></g>
    ${textSvg([t.name.toUpperCase()], { x: 40, y: 0, size: 24, bold: true, fill: t.ink })}
  </g>
  ${right(`Farcaster profile · No. ${Number(u.fid).toLocaleString('en-US')}`, 1108, { y: 784, size: 24, fill: '#cfcbe0' })}
  ${stat(0, 'FOLLOWERS', n(followers))}
  ${stat(1, 'FOLLOWING', n(u.following_count || 0))}
  ${stat(2, 'POWER', String(power), true)}
  <rect x="92" y="966" width="1016" height="108" rx="18" fill="#fff" fill-opacity="0.05"/>
  ${textSvg(bio, { x: 118, y: bio.length > 1 ? 1010 : 1030, lh: 40, size: 28, fill: '#e6e3f0' })}
  ${logoTile(92, 1096, 0.9)}
  ${textSvg(['Quilcast Cards'], { x: 132, y: 1121, size: 24, bold: true, fill: '#fff' })}
  ${right(dayOf(at), 1108, { y: 1121, size: 24, fill: '#cfcbe0' })}
</svg>`
}

/** The token's metadata, as OpenSea and Blockscout read it. */
export function cardMeta(u, at, site) {
  const who = `@${u.username || u.fid}`
  const t = tierOf(u.fid)
  return {
    name: `${nameOf(u)} (${who}) · ${t.name}`,
    description: `${(u.profile?.bio?.text || '').trim()}\n\nThe Quilcast Card of ${who}, FID ${u.fid}: their Farcaster profile on ${dayOf(at)}, collected as a 1/1 on Quilcast.`.trim(),
    image: `${site}/nft/card/${u.fid}.png`,
    external_url: `${site}/u/${encodeURIComponent(u.username || u.fid)}`,
    attributes: [
      { trait_type: 'Rarity', value: t.name },
      { trait_type: 'Profile', value: who },
      { trait_type: 'FID', value: Number(u.fid), display_type: 'number' },
      { trait_type: 'Followers', value: u.follower_count || 0, display_type: 'number' },
      { trait_type: 'Following', value: u.following_count || 0, display_type: 'number' },
      { trait_type: 'Power', value: powerOf(u.follower_count), max_value: 100, display_type: 'number' },
      { trait_type: 'Collected', value: Math.floor(at / 1000), display_type: 'date' },
    ],
  }
}

// card text's colors: words, links and mentions, code, quotes
const INK = { fill: '#edebf3', accent: '#a99bff', code: '#f0c48a', muted: '#9893a5' }
/** A cast's share card, 1200×630: `v` its visual (index.mjs visualOf), `pfp` and `pic` data URIs or null. */
export function castSvg(c, v, pfp, pic) {
  const a = c.author || {}
  const replies = Number(c.replies?.count) || 0
  const recasts = Number(c.reactions?.recasts_count) || 0
  const likes = Number(c.reactions?.likes_count) || 0
  // only the first ~8 lines fit, so long casts are cut before wrapping
  // its Markdown drawn (richSvg)
  const md = styled(castText(c, true))
  const text = cut(md.text, 600)
  const tile = !!(pic || v?.video || v?.tweet)
  // link previews are ~1.91:1, so they get a landscape tile; everything else a square
  const [ty, th] = v?.wide ? [172, 220] : [72, 420]
  const textW = tile ? 600 : 1040
  const size = text.length < 90 ? 46 : text.length < 200 ? 38 : 32
  // (links already show short, as the app does; bold text is measured as such, so a line of it can't run long)
  const lines = layout(text, md.marks, size, textW, 300 / (size * 1.32))
  const name = nameOf(a)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <radialGradient id="g" cx="0.9" cy="0.05" r="0.8"><stop offset="0" stop-color="#3a2a9a"/><stop offset="1" stop-color="#0d0c11" stop-opacity="0"/></radialGradient>
    <clipPath id="av"><circle cx="128" cy="120" r="44"/></clipPath>
    <clipPath id="pic"><rect x="712" y="${ty}" width="420" height="${th}" rx="28"/></clipPath>
  </defs>
  <rect width="1200" height="630" fill="#0d0c11"/><rect width="1200" height="630" fill="url(#g)"/>
  <circle cx="128" cy="120" r="44" fill="#2a2735"/>
  ${pfp ? `<image href="${pfp}" x="84" y="76" width="88" height="88" preserveAspectRatio="xMidYMid slice" clip-path="url(#av)"/>` : initial(name, 128, 136, 40, '#9893a5')}
  ${textSvg([wrap(name, 34, (tile ? 680 : 1100) - 196, 1)[0] || ''], { x: 196, y: 112, size: 34, bold: true, fill: '#edebf3' })}
  ${textSvg([`@${cut(a.username || a.fid, 40)}`], { x: 196, y: 150, size: 26, fill: '#9893a5' })}
  ${richSvg(lines, { x: 84, y: 232, lh: size * 1.32, size, ...INK })}
  ${tile && !v?.sticker ? `<rect x="712" y="${ty}" width="420" height="${th}" rx="28" fill="#1c1a23" stroke="#2a2735" stroke-width="2"/>` : ''}
  ${pic ? `<image href="${pic}" x="712" y="${ty}" width="420" height="${th}" preserveAspectRatio="xMidYMid ${v?.sticker ? 'meet' : 'slice'}" clip-path="url(#pic)"/>` : ''}
  ${v?.video ? `<circle cx="922" cy="282" r="46" fill="#000" fill-opacity="0.55"/><path d="M908 258v48l40-24z" fill="#fff"/>` : ''}
  ${v?.label ? `<rect x="728" y="${ty + th - 48}" width="${Math.min(388, Math.round(width(v.label, 20) + 28))}" height="34" rx="17" fill="#000" fill-opacity="0.6"/><text x="742" y="${ty + th - 25}" font-family="Inter" font-weight="700" font-size="20" fill="#fff">${esc(wrap(v.label, 20, 360, 1)[0] || '')}</text>` : ''}
  ${v?.tweet ? `<g transform="translate(744 104) scale(1.4)"><path d="${X_LOGO}" fill="#edebf3"/></g>
  ${textSvg([wrap(v.tweet.author.name || '', 24, 320, 1)[0] || ''], { x: 790, y: 128, size: 24, bold: true, fill: '#edebf3' })}
  ${textSvg([`@${v.tweet.author.handle || ''}`], { x: 744, y: 168, size: 20, fill: '#9893a5' })}
  ${textSvg(wrap(cut((v.tweet.text || '').replace(/https?:\/\/\S+/g, '').trim(), 600) || ' ', 24, 356, 9), { x: 744, y: 214, lh: 32, size: 24, fill: '#edebf3' })}` : ''}
  ${FOOT}
  <text x="1116" y="592" xml:space="preserve" font-family="Inter" font-size="24" fill="#9893a5" text-anchor="end">${n(replies)} ${replies === 1 ? 'reply' : 'replies'}  ·  ${n(recasts)} ${recasts === 1 ? 'recast' : 'recasts'}  ·  <tspan fill="#ff5c8a">♥ ${n(likes)}</tspan></text>
</svg>`
}

/** The share card of a shared design: a profile wearing it, drawn at about twice its size on screen. `img` its
 *  background picture ({ uri, w, h }) or nothing. */
export function designSvg(d, img) {
  const ink = d.text || '#edebf3'
  const muted = d.muted || '#9893a5'
  const link = d.link || '#6447f5'
  const box = d.box || '#16151c'
  const line = d.border || '#2a2735'
  const fx = d.nameFx || 'none'
  const fxColor = d.nameColor || link
  const bw = d.borderStyle === 'none' ? 0 : (d.borderWidth ?? 1) * 2
  const r = (d.radius ?? 14) * 2
  // the background as the profile shows it: tiled at its own size, filling the card, or once in the middle
  const bg = !img ? '' : d.bgMode === 'cover'
    ? `<image href="${img.uri}" width="1200" height="630" preserveAspectRatio="xMidYMid slice"/>`
    : d.bgMode === 'center'
      ? `<image href="${img.uri}" x="${(1200 - Math.min(img.w, 1200)) / 2}" y="${(630 - Math.min(img.h, 630)) / 2}" width="${Math.min(img.w, 1200)}" height="${Math.min(img.h, 630)}" preserveAspectRatio="xMidYMid meet"/>`
      : `<rect width="1200" height="630" fill="url(#tile)"/>`
  // SVG strokes for the CSS border styles; double is two thin lines, groove and ridge stay solid
  const frame = (x, y, w, h) => {
    if (!bw) return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${box}" fill-opacity="${(d.boxAlpha ?? 90) / 100}"/>`
    const base = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${box}" fill-opacity="${(d.boxAlpha ?? 90) / 100}"`
    if (d.borderStyle === 'double' && bw >= 6) {
      const t = bw / 3
      return `${base} stroke="${line}" stroke-width="${t}"/><rect x="${x + 2 * t}" y="${y + 2 * t}" width="${w - 4 * t}" height="${h - 4 * t}" rx="${Math.max(0, r - 2 * t)}" fill="none" stroke="${line}" stroke-width="${t}"/>`
    }
    return `${base} stroke="${line}" stroke-width="${bw}"${dashOf(d.borderStyle, bw)}/>`
  }
  const name = (x, y) => {
    const t = (attrs) => `<text x="${x}" y="${y}" font-family="Inter" font-weight="800" font-size="64" ${attrs}>Profile design</text>`
    if (fx === 'rainbow') return t('fill="url(#rainbow)"')
    if (fx === 'glitter') return t('fill="url(#glitter)"')
    if (fx === 'glow') return t(`fill="${fxColor}" filter="url(#glow)"`) + t(`fill="${ink}"`)
    if (fx === 'shadow') return `<g transform="translate(5 5)">${t(`fill="${ink}"`)}</g>` + t(`fill="${fxColor}"`)
    if (fx === 'outline') return t(`fill="none" stroke="${fxColor}" stroke-width="2.4"`)
    return t(`fill="${d.nameColor || ink}"`)
  }
  const tw = img && d.bgMode !== 'cover' && d.bgMode !== 'center' ? Math.max(40, img.w) : 0
  const th = tw ? Math.round((img.h * tw) / img.w) : 0
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    ${tw ? `<pattern id="tile" width="${tw}" height="${th}" patternUnits="userSpaceOnUse"><image href="${img.uri}" width="${tw}" height="${th}"/></pattern>` : ''}
    ${nameFxDefs(fxColor)}
    <filter id="glow" x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation="9"/></filter>
  </defs>
  <rect width="1200" height="630" fill="${d.bg || '#0d0c11'}"/>${bg}
  ${d.bgDim ? `<rect width="1200" height="630" fill="#000" fill-opacity="${d.bgDim / 100}"/>` : ''}
  ${frame(80, 64, 1040, 196)}
  ${logoTile(124, 114, 3)}
  ${name(250, 166)}
  <text x="252" y="214" font-family="Inter" font-size="30" fill="${muted}">A Quilcast profile design</text>
  ${frame(80, 292, 1040, 274)}
  <clipPath id="sec"><rect x="${80 + bw / 2}" y="${292 + bw / 2}" width="${1040 - bw}" height="${274 - bw}" rx="${Math.max(0, r - bw / 2)}"/></clipPath>
  <rect x="80" y="292" width="1040" height="${64 + bw}" fill="${link}" fill-opacity="0.16" clip-path="url(#sec)"/>
  <text x="122" y="${336 + bw / 2}" font-family="Inter" font-weight="800" font-size="30" fill="${link}">Profile design</text>
  <text x="122" y="${426 + bw / 2}" font-family="Inter" font-size="32" fill="${ink}">Colors, background and fonts for your profile.</text>
  <rect x="122" y="${462 + bw / 2}" width="330" height="64" rx="32" fill="${link}"/>
  <text x="287" y="${505 + bw / 2}" font-family="Inter" font-weight="700" font-size="28" fill="${d.box || '#fff'}" text-anchor="middle">Use this design</text>
</svg>`
}

/** A sticker pack's share card, 1200×630 (or 1200×800, `tall`, for mini app embeds, which Farcaster shows at 3:2): its
 *  name, count and maker on the left, a sheet of its first stickers (their first frames) on soft tiles on the right.
 *  `stills` are their first frames as data URIs, `owner` the maker's account or null. */
export function packSvg(p, tall, stills, owner) {
  const H = tall ? 800 : 630
  const rows = tall ? 4 : 3
  const cell = 172, gap = 14
  const gx = 1200 - 64 - 3 * cell - 2 * gap
  const gy = (H - rows * cell - (rows - 1) * gap) / 2
  const tiles = Array.from({ length: rows * 3 }, (_, i) => {
    const x = gx + (i % 3) * (cell + gap), y = gy + Math.floor(i / 3) * (cell + gap)
    const b = stills[i]
    return `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="26" fill="#fff" fill-opacity="${b ? 0.06 : 0.03}"/>` +
      (b ? `<image href="${b}" x="${x + 12}" y="${y + 12}" width="${cell - 24}" height="${cell - 24}" preserveAspectRatio="xMidYMid meet"/>` : '')
  }).join('')
  const title = wrap(p.title, 58, gx - 64 - 48, 3, { bold: true })
  const ty = H / 2 - ((title.length - 1) * 66) / 2 + 6
  const count = p.stickers.length === 1 ? '1 sticker' : `${p.stickers.length} stickers`
  const meta = owner?.username ? `${count} · by @${owner.username}` : count
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="${H}" viewBox="0 0 1200 ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1d1540"/><stop offset="0.6" stop-color="#110e1f"/><stop offset="1" stop-color="#0d0c11"/></linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#6447f5" stop-opacity="0.35"/><stop offset="1" stop-color="#6447f5" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="1200" height="${H}" fill="url(#bg)"/>
  <circle cx="${gx + 1.5 * cell + gap}" cy="${H / 2}" r="${H * 0.62}" fill="url(#glow)"/>
  ${logoTile(64, 60, 1.5)}
  <text x="124" y="95" font-family="Inter" font-weight="800" font-size="30" fill="#edebf3">Quilcast</text>
  <text x="64" y="${ty - 74}" font-family="Inter" font-weight="800" font-size="22" letter-spacing="3" fill="#a594ff">STICKER PACK</text>
  ${textSvg(title, { x: 64, y: ty, lh: 66, size: 58, bold: true, weight: 800, fill: '#f4f2fa' })}
  ${textSvg([meta], { x: 64, y: ty + (title.length - 1) * 66 + 54, size: 26, fill: '#a7a2b8' })}
  <rect x="64" y="${H - 124}" width="272" height="60" rx="30" fill="#6447f5"/>
  <text x="200" y="${H - 85}" font-family="Inter" font-weight="700" font-size="24" fill="#fff" text-anchor="middle">Add in Quilcast</text>
  ${tiles}
</svg>`
}

// the same random spread every time a theme's card is drawn
// the feed's icons (ui.tsx P)
const ICONS = {
  reply: 'M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.8-.9L3 20l1.1-4.6A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4z',
  recast: 'M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3',
  like: 'M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z',
}
const seeded = (s) => {
  let h = [...s].reduce((a, c) => Math.imul(a ^ c.charCodeAt(0), 16777619), 2166136261) >>> 0
  return () => ((h = Math.imul(h ^ (h >>> 15), 2246822507) ^ Math.imul(h ^ (h >>> 13), 3266489909)), (h >>>= 0) / 4294967296)
}
const mixHex = (a, b, t) => '#' + [1, 3, 5].map((i) => Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - t) + parseInt(b.slice(i, i + 2), 16) * t).toString(16).padStart(2, '0')).join('')

// how far past a name's end glitter's sparkle reaches, in em: its middle is 0.4 em past it, its points 0.3 em around
const SPARKLE = 0.7

/** The share card of a theme: Quilcast itself wearing it (sidebar, a feed of casts, its effect and stickers), next
 *  to the theme's name, its colors and an "Apply theme" button. `th` is cleaned; `img`, `bar` and `btn` are its pictures
 *  ({ uri, w, h } or nothing), `stickers` [{ s, i }] its stickers with their pictures. */
export function themeSvg(id, th, img, bar, btn, stickers) {
  const base = th.base || 'dark'
  const c = { ...DEFAULTS[base], ...Object.fromEntries(Object.entries(th).filter(([k, v]) => typeof v === 'string' && v.startsWith('#'))) }
  const rs = th.round ?? 1
  const bw = th.borderStyle === 'none' ? 0 : (th.borderWidth ?? 1) * 1.5
  const stroke = (color = c.line) => (bw ? ` stroke="${color}" stroke-width="${bw}"${dashOf(th.borderStyle, bw)}` : '')
  const R = (px) => Math.min(px * rs, 999)
  // over a picture or an effect the column turns see-through, as it does in the app
  const p = th.fx && EFFECTS[th.fx]
  const sheer = img || p ? (th.sheer ?? 88) / 100 : 1
  const rnd = seeded(id)
  const defs = []
  const fill = (k, im, w, h) => {
    if (!im) return null
    defs.push(`<pattern id="${k}" width="1" height="1" patternContentUnits="objectBoundingBox"><image href="${im.uri}" width="1" height="1" preserveAspectRatio="xMidYMid slice"/></pattern>`)
    return `url(#${k})`
  }
  // the page background as the app draws it: tiled at its own size, filling the screen, or once in the middle
  let bg = ''
  if (img) {
    if (th.bgMode === 'tile' || !th.bgMode) {
      const tw = Math.max(40, Math.min(img.w, 600)), tht = Math.round((img.h * tw) / img.w)
      defs.push(`<pattern id="tile" width="${tw}" height="${tht}" patternUnits="userSpaceOnUse"><image href="${img.uri}" width="${tw}" height="${tht}"/></pattern>`)
      bg = `<rect width="1200" height="630" fill="url(#tile)"/>`
    } else if (th.bgMode === 'center') bg = `<image href="${img.uri}" x="${(1200 - Math.min(img.w, 1200)) / 2}" y="${(630 - Math.min(img.h, 630)) / 2}" width="${Math.min(img.w, 1200)}" height="${Math.min(img.h, 630)}" preserveAspectRatio="xMidYMid meet"/>`
    else bg = `<image href="${img.uri}" width="1200" height="630" preserveAspectRatio="xMidYMid slice"/>`
    if (th.scrim) bg += `<rect width="1200" height="630" fill="${base === 'light' ? '#fff' : '#000'}" fill-opacity="${th.scrim / 100}"/>`
  }
  // the effect, frozen: a scatter of its particles in its own colors
  let fx = ''
  if (p) {
    const count = Math.max(8, Math.min(46, Math.round(p.n / 3)))
    for (let i = 0; i < count; i++) {
      const x = rnd() * 1200, y = rnd() * 630
      // the sidebar sits on the background itself, so nothing lands on its words
      if (x < 250 && y < 470) continue
      const size = (p.size[0] + rnd() * (p.size[1] - p.size[0])) * 1.6
      const col = p.colors ? p.colors[Math.floor(rnd() * p.colors.length)] : '#fff'
      const a = p.alpha ?? 0.9
      const ch = Array.isArray(p.draw) && p.draw[Math.floor(rnd() * p.draw.length)].replace(/\uFE0F/g, '')
      // Inter and Noto Emoji have no ✦ ✧ ⋆, katakana or ❅ ❆: stars are drawn, code rains as digits, flakes are ❄
      if (ch && /[✦✧⋆]/.test(ch)) fx += `<path d="M0 -1C.1 -.3 .3 -.1 1 0C.3 .1 .1 .3 0 1C-.1 .3 -.3 .1 -1 0C-.3 -.1 -.1 -.3 0 -1z" fill="${col}" fill-opacity="${a}" transform="translate(${x} ${y}) scale(${size * 0.7})"/>`
      else if (ch && th.fx === 'matrix') fx += `<text font-family="Inter" font-weight="700" font-size="${size}" fill="${col}" text-anchor="middle">${[...Array(6)].map((_, j) => `<tspan x="${x}" y="${y + j * size * 1.1}" fill-opacity="${(1 - j / 6).toFixed(2)}">${rnd() < 0.5 ? 0 : 1}</tspan>`).join('')}</text>`
      else if (ch) fx += `<text x="${x}" y="${y}" font-family="Noto Emoji, Inter" font-size="${size * 1.3}" fill="${p.colors ? col : c.accent}" fill-opacity="${a}" transform="rotate(${Math.round((rnd() - 0.5) * 60)} ${x} ${y})">${esc(/[❅❆]/.test(ch) ? '❄' : ch)}</text>`
      else if (p.draw === 'rect') fx += `<rect x="${x}" y="${y}" width="${size}" height="${size * 0.5}" fill="${col}" transform="rotate(${Math.round(rnd() * 180)} ${x} ${y})"/>`
      else if (p.draw === 'line') fx += `<line x1="${x}" y1="${y}" x2="${x - size * (p.slant || 0.15)}" y2="${y + size}" stroke="${col}" stroke-opacity="${a}" stroke-width="2" stroke-linecap="round"/>`
      else if (p.draw === 'ring') fx += `<circle cx="${x}" cy="${y}" r="${size / 2}" fill="none" stroke="${col}" stroke-opacity="${a}" stroke-width="2"/>`
      else fx += (p.draw === 'glow' ? `<circle cx="${x}" cy="${y}" r="${size * 2.4}" fill="${col}" fill-opacity="0.25" filter="url(#soft)"/>` : '') + `<circle cx="${x}" cy="${y}" r="${size / 2}" fill="${col}" fill-opacity="${a}"/>`
    }
  }
  // a name in the theme's name effect; glitter's sparkle follows where the name is drawn to
  const fxColor = th.nameColor || c.accent
  // (emoji in it are Twemoji's pictures, on top of the effect)
  const named = (x, y, size, s, base = c.ink) => {
    const t = (...paint) => textSvg([s], { x, y, size, weight: 800, paint })
    const fx = th.nameFx
    if (fx === 'rainbow') return t('fill="url(#rainbow)"')
    if (fx === 'glitter') return t('fill="url(#glitter)"') + `<path d="M0 -1C.1 -.3 .3 -.1 1 0C.3 .1 .1 .3 0 1C-.1 .3 -.3 .1 -1 0C-.3 -.1 -.1 -.3 0 -1z" fill="#ffc928" transform="translate(${x + ends(s, size, true) + size * (SPARKLE - 0.3)} ${y - size * 0.35}) scale(${size * 0.3})"/>`
    if (fx === 'glow') return t(`fill="${fxColor}" filter="url(#glow)"`, `fill="${base}"`)
    if (fx === 'shadow') return t(`fill="${base}" transform="translate(3 3)"`, `fill="${fxColor}"`)
    if (fx === 'outline') return t(`fill="none" stroke="${fxColor}" stroke-width="1.6"`)
    return t(`fill="${th.nameColor || base}"`)
  }
  const btnFill = fill('btn', btn) || c.accent
  // words on a button picture are white with a dark edge, as in the app
  const btnText = btn ? 'fill="#fff" stroke="#000" stroke-opacity="0.55" stroke-width="4" paint-order="stroke"' : `fill="${c.onAccent}"`
  const barFill = fill('bar', bar)
  // the feed: three casts as a phone or desktop would show them
  const X = 256, W = 452
  const casts = [
    ['Quilcast', 'quilcast', 'gm! trying on a brand new theme today ☀️', [3, 12, 48]],
    ['Ada', 'ada', 'the colors, the background, the stickers… everything changes ✨', [9, 31, 212]],
    ['Satoshi', 'sats', 'ok this one is going in my rotation', [1, 4, 27]],
  ].map(([name, user, text, [rep, rc, lk]], i) => {
    const y = 120 + i * 156
    const lines = wrap(text, 21, W - 108, 2)
    const ay = y + 40
    const hue = [c.accent, c.like, c.recast][i]
    return `<circle cx="${X + 44}" cy="${ay}" r="26" fill="${hue}"/><text x="${X + 44}" y="${ay + 9}" font-family="Inter" font-weight="800" font-size="24" fill="${c.onAccent}" text-anchor="middle">${name[0]}</text>
    ${named(X + 84, y + 34, 21, name)}<text x="${X + 92 + ends(name, 21, true) + (th.nameFx === 'glitter' ? SPARKLE * 21 : 0)}" y="${y + 34}" font-family="Inter" font-size="19" fill="${c.muted}">@${user} · ${i + 2}h</text>
    ${textSvg(lines, { x: X + 84, y: y + 66, lh: 28, size: 21, fill: c.ink })}
    ${[[ICONS.reply, rep, c.muted], [ICONS.recast, rc, c.recast], [ICONS.like, lk, c.like]].map(([d, k, col], j) => `<g transform="translate(${X + 84 + j * 110} ${y + 112}) scale(0.85)"><path d="${d}" fill="none" stroke="${col}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></g><text x="${X + 112 + j * 110}" y="${y + 130}" font-family="Inter" font-size="18" fill="${col}">${k}</text>`).join('')}
    <rect x="${X}" y="${y + 154}" width="${W}" height="${bw}" fill="${c.line}"/>`
  }).join('')
  const nav = ['Home', 'Search', 'Notifications', 'Messages', 'Profile'].map((label, i) => {
    const y = 132 + i * 54
    return `<circle cx="78" cy="${y - 8}" r="11" fill="none" stroke="${c.ink}" stroke-width="2.4"/><text x="104" y="${y}" font-family="Inter" font-weight="${i ? 400 : 800}" font-size="22" fill="${c.ink}">${label}</text>`
  }).join('')
  // the name in up to two lines, smaller when it doesn't fit at 52 px; measured as it's drawn, bold. It (and glitter's
  // sparkle after each line) may reach into the panel's right padding, up to 8 px from its edge (1152). Wrapped and drawn
  // measured, every run of it (a name is at most 60 characters): a guess past the card's budget runs wider
  // than resvg draws a tightly kerned line ("TyTy"), which would put the sparkle outside
  const title = th.name || 'Untitled theme'
  const room = (ts) => 364 - (th.nameFx === 'glitter' ? SPARKLE * ts : 0)
  const ts = exactly(() => wrap(title, 52, room(52), 3, { bold: true })).length > 2 ? 40 : 52
  const tl = exactly(() => wrap(title, ts, room(ts), 2, { bold: true }))
  const facts = [base === 'light' ? 'Light' : 'Dark', p?.name, th.font && th.font !== 'system' ? FONT_STACKS[th.font].split(',')[0].replace(/'/g, '') : th.fontUrl ? 'Own font' : null, stickers.length ? `${stickers.length} sticker${stickers.length > 1 ? 's' : ''}` : null].filter(Boolean).join(' · ')
  const swatches = ['bg', 'card', 'ink', 'accent', 'like', 'recast'].map((k, i) => `<circle cx="${790 + i * 52}" cy="${320 + (tl.length - 1) * ts * 1.1}" r="19" fill="${c[k]}" stroke="${mixHex(c.card, c.ink, 0.25)}" stroke-width="2"/>`).join('')
  const fl = wrap(facts, 20, 352, 2)
  // everything under the facts moves down by a second line of them
  const ty = (tl.length - 1) * ts * 1.1 + (fl.length - 1) * 26
  const panelH = 352 + ty
  const py = Math.round((630 - panelH) / 2)
  const panel = `<g transform="translate(0 ${py - 150})">
    ${th.glow ? `<rect x="748" y="150" width="404" height="${panelH}" rx="${R(28)}" fill="${c.accent}" fill-opacity="0.55" filter="url(#soft)"/>` : ''}
    <rect x="748" y="150" width="404" height="${panelH}" rx="${R(28)}" fill="${c.card}" fill-opacity="${Math.max(sheer, 0.9)}"${stroke()}/>
    <rect x="780" y="182" width="${width('QUILCAST THEME', 16) * 1.12 + 32}" height="34" rx="${R(17)}" fill="${c.accent}" fill-opacity="0.16"/>
    <text x="796" y="205" font-family="Inter" font-weight="800" font-size="16" letter-spacing="1.6" fill="${c.accent}">QUILCAST THEME</text>
    ${exactly(() => tl.map((l, i) => named(780, 266 + i * ts * 1.1, ts, l)).join(''))}
    ${swatches}
    ${textSvg(fl, { x: 780, y: 380 + ty, lh: 26, size: 20, fill: c.muted })}
    <rect x="780" y="${412 + ty}" width="340" height="60" rx="${R(30)}" fill="${btnFill}"/>
    <text x="950" y="${451 + ty}" font-family="Inter" font-weight="800" font-size="24" ${btnText} text-anchor="middle">Apply theme</text>
  </g>`
  const stk = stickers.map(({ s, i }) => {
    const w = s.w * 6, h = (w * i.h) / i.w, x = (s.x / 100) * 1200, y = (s.y / 100) * 630
    return `<image href="${i.uri}" x="${x - w / 2}" y="${y - h / 2}" width="${w}" height="${h}"${s.r ? ` transform="rotate(${s.r} ${x} ${y})"` : ''}/>`
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    ${nameFxDefs(fxColor)}
    <filter id="glow" x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation="5"/></filter>
    <filter id="soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="18"/></filter>
    <clipPath id="col"><rect x="${X}" y="0" width="${W}" height="630"/></clipPath>
    ${defs.join('')}
  </defs>
  <rect width="1200" height="630" fill="${c.bg}"/>${bg}
  ${fx && th.fxAlpha !== undefined ? `<g opacity="${th.fxAlpha / 100}">${fx}</g>` : fx}
  <g transform="translate(64 40)"><rect width="34" height="34" rx="${R(10)}" fill="${c.accent}"/><g transform="translate(1 1)"><path d="${LOGO}" fill="${c.onAccent}"/></g></g>
  <text x="110" y="66" font-family="Inter" font-weight="800" font-size="25" fill="${c.ink}">Quilcast</text>
  ${nav}
  <rect x="64" y="404" width="170" height="54" rx="${R(27)}" fill="${btnFill}"/><text x="149" y="439" font-family="Inter" font-weight="800" font-size="22" ${btnText} text-anchor="middle">Cast</text>
  ${th.glow ? `<rect x="${X}" y="0" width="${W}" height="630" fill="${c.accent}" fill-opacity="0.45" filter="url(#soft)"/>` : ''}
  <g clip-path="url(#col)">
    <rect x="${X}" y="0" width="${W}" height="630" fill="${c.bg}" fill-opacity="${sheer}"/>
    <rect x="${X}" y="0" width="${W}" height="112" fill="${th.bar || c.bg}" fill-opacity="${img ? 0.9 : 0.97}"/>
    ${barFill ? `<rect x="${X}" y="0" width="${W}" height="112" fill="${barFill}"/>` : ''}
    <text x="${X + 24}" y="44" font-family="Inter" font-weight="800" font-size="24" fill="${c.ink}">Home</text>
    <text x="${X + W / 4}" y="94" font-family="Inter" font-weight="700" font-size="19" fill="${c.ink}" text-anchor="middle">Following</text>
    <text x="${X + (W * 3) / 4}" y="94" font-family="Inter" font-weight="700" font-size="19" fill="${c.muted}" text-anchor="middle">Trending</text>
    <rect x="${X + W / 4 - 32}" y="106" width="64" height="5" rx="2.5" fill="${c.accent}"/>
    <rect x="${X}" y="111" width="${W}" height="${bw}" fill="${c.line}"/>
    ${casts}
  </g>
  ${bw ? `<line x1="${X}" y1="0" x2="${X}" y2="630"${stroke()}/><line x1="${X + W}" y1="0" x2="${X + W}" y2="630"${stroke()}/>` : ''}
  ${panel}
  ${stk}
</svg>`
}

/** A row of overlapping supporter faces and "N supporters · $X/mo", its left edge at x, centered on y. */
function supportRow(s, x, y) {
  const faces = s.pfps.map((p, i) => `<clipPath id="sp${i}"><circle cx="${x + 30 + i * 44}" cy="${y}" r="28"/></clipPath>
  <circle cx="${x + 30 + i * 44}" cy="${y}" r="31" fill="#0d0c11"/><image href="${p}" x="${x + 2 + i * 44}" y="${y - 28}" width="56" height="56" preserveAspectRatio="xMidYMid slice" clip-path="url(#sp${i})"/>`).join('')
  const tx = x + (s.pfps.length ? 30 + (s.pfps.length - 1) * 44 + 52 : 0)
  const monthly = s.monthly ? `  ·  $${(s.monthly / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}/mo` : ''
  return `${faces}<text x="${tx}" y="${y + 10}" xml:space="preserve" font-family="Inter" font-size="28" fill="#9893a5"><tspan font-weight="700" fill="#edebf3">${n(s.n)}</tspan> ${s.n === 1 ? 'supporter' : 'supporters'}${monthly}</text>`
}

/** A profile's share card: their picture (`pfp`, a data URI or null), name, bio, supporters (`s`) and follower counts. */
export function profileSvg(u, pfp, s) {
  const name = cut(profileName(u), 80)
  // supporters take the bio's last two lines
  const bio = wrap(cut(u.profile?.bio?.text || '', 400) || ' ', 34, 1032, s.n ? 2 : 4)
  const f = u.follower_count || 0
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <radialGradient id="g" cx="0.9" cy="0.05" r="0.8"><stop offset="0" stop-color="#3a2a9a"/><stop offset="1" stop-color="#0d0c11" stop-opacity="0"/></radialGradient>
    <clipPath id="av"><circle cx="172" cy="172" r="88"/></clipPath>
  </defs>
  <rect width="1200" height="630" fill="#0d0c11"/><rect width="1200" height="630" fill="url(#g)"/>
  <circle cx="172" cy="172" r="88" fill="#2a2735"/>
  ${pfp ? `<image href="${pfp}" x="84" y="84" width="176" height="176" preserveAspectRatio="xMidYMid slice" clip-path="url(#av)"/>` : initial(name, 172, 198, 72, '#9893a5')}
  ${textSvg([wrap(name, 52, 816, 1)[0] || ''], { x: 300, y: 160, size: 52, bold: true, fill: '#edebf3' })}
  ${textSvg([`@${fname(u) || u.fid}`], { x: 300, y: 214, size: 32, fill: '#9893a5' })}
  ${textSvg(bio, { x: 84, y: 336, lh: 45, size: 34, fill: '#edebf3' })}
  ${s.n ? supportRow(s, 84, 466) : ''}
  ${FOOT}
  <text x="1116" y="592" xml:space="preserve" font-family="Inter" font-size="26" fill="#9893a5" text-anchor="end"><tspan font-weight="700" fill="#edebf3">${n(u.following_count || 0)}</tspan> following  ·  <tspan font-weight="700" fill="#edebf3">${n(f)}</tspan> ${f === 1 ? 'follower' : 'followers'}</text>
</svg>`
}

/** A 1200×630 cast card grown to 1200×800, its background carried into the new space above and below. */
export const tall = (svg) => svg.replace('height="630" viewBox="0 0 1200 630"', 'height="800" viewBox="0 -85 1200 800"').replace(/<rect width="1200" height="630" fill="(#0d0c11|url\(#g\))"\/>/g, '<rect y="-85" width="1200" height="800" fill="$1"/>')

const dateOf = (c) => new Date(c.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
/** The NFT's picture, 1200×1200: the author on top, then the text, then its picture or quoted post filling what's left,
 *  and the footer. Text alone sits in the middle of the space, at a size its length allows. No counts: they'd go stale.
 *  `v`, `pfp` and `pic` as castSvg's. */
export function nftSvg(c, v, pfp, pic) {
  const a = c.author || {}
  const name = nameOf(a)
  // its Markdown drawn, as on the share card (card); links already show short
  const md = styled(castText(c, true))
  const short = cut(md.text, 1000)
  const box = !!(pic || v?.video || v?.tweet)
  // the content area: 88 px margins, between the author row and the footer
  const X = 88, W = 1024, TOP = 272, BOTTOM = 1032
  let body = ''
  let y = TOP
  if (short) {
    const size = box ? (short.length < 90 ? 48 : short.length < 200 ? 40 : 34) : short.length < 60 ? 72 : short.length < 140 ? 60 : short.length < 280 ? 48 : short.length < 500 ? 40 : 34
    const lh = Math.round(size * 1.3)
    const lines = layout(short, md.marks, size, W, (box ? 280 : BOTTOM - TOP) / lh)
    const h = lines.reduce((a, l) => a + l.h, 0) * lh
    // alone, the text is centered in the space; the first baseline is about one size below the line's top
    const top = box ? TOP : TOP + Math.max(0, (BOTTOM - TOP - h) / 2)
    body += richSvg(lines, { x: X, y: top + size, lh, size, ...INK })
    y = top + h + 36
  }
  if (v?.sticker && pic) {
    // on the background, as the app shows it, no larger than twice its 320 px
    const s = Math.min(BOTTOM - y, 640)
    body += `<image href="${pic}" x="${X + (W - s) / 2}" y="${y + (BOTTOM - y - s) / 2}" width="${s}" height="${s}" preserveAspectRatio="xMidYMid meet"/>`
  } else if (box) {
    const h = BOTTOM - y
    body += `<clipPath id="nft-pic"><rect x="${X}" y="${y}" width="${W}" height="${h}" rx="32"/></clipPath>
  <rect x="${X}" y="${y}" width="${W}" height="${h}" rx="32" fill="#1c1a23" stroke="#2a2735" stroke-width="2"/>`
    if (pic) body += `<image href="${pic}" x="${X}" y="${y}" width="${W}" height="${h}" preserveAspectRatio="xMidYMid slice" clip-path="url(#nft-pic)"/>`
    if (v?.video) body += `<circle cx="${X + W / 2}" cy="${y + h / 2}" r="56" fill="#000" fill-opacity="0.55"/><path d="M${X + W / 2 - 17} ${y + h / 2 - 29}v58l48-29z" fill="#fff"/>`
    if (v?.label) {
      const l = wrap(v.label, 24, 600, 1)[0] || ''
      body += `<rect x="${X + 20}" y="${y + h - 64}" width="${Math.round(width(l, 24) + 36)}" height="44" rx="22" fill="#000" fill-opacity="0.6"/>${textSvg([l], { x: X + 38, y: y + h - 33, size: 24, fill: '#fff' })}`
    }
    if (v?.tweet && !pic) {
      const tl = wrap(cut((v.tweet.text || '').replace(/https?:\/\/\S+/g, '').trim(), 800) || ' ', 32, W - 96, Math.max(1, Math.floor((h - 180) / 44)))
      body += `<g transform="translate(${X + 48} ${y + 52}) scale(1.6)"><path d="${X_LOGO}" fill="#edebf3"/></g>
  ${textSvg([wrap(v.tweet.author.name || '', 32, W - 200, 1, { bold: true })[0] || ''], { x: X + 112, y: y + 84, size: 32, bold: true, fill: '#edebf3' })}
  ${textSvg([`@${v.tweet.author.handle || ''}`], { x: X + 48, y: y + 140, size: 26, fill: '#9893a5' })}
  ${textSvg(tl, { x: X + 48, y: y + 196, lh: 44, size: 32, fill: '#edebf3' })}`
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200" viewBox="0 0 1200 1200">
  <defs>
    <radialGradient id="nft-g" cx="0.92" cy="0.04" r="0.75"><stop offset="0" stop-color="#3a2a9a"/><stop offset="1" stop-color="#0d0c11" stop-opacity="0"/></radialGradient>
    <clipPath id="nft-av"><circle cx="148" cy="148" r="60"/></clipPath>
  </defs>
  <rect width="1200" height="1200" fill="#0d0c11"/><rect width="1200" height="1200" fill="url(#nft-g)"/>
  <circle cx="148" cy="148" r="60" fill="#2a2735"/>
  ${pfp ? `<image href="${pfp}" x="88" y="88" width="120" height="120" preserveAspectRatio="xMidYMid slice" clip-path="url(#nft-av)"/>` : initial(name, 148, 166, 52, '#9893a5')}
  ${textSvg([wrap(name, 44, 1112 - 240, 1, { bold: true })[0] || ''], { x: 240, y: 140, size: 44, bold: true, fill: '#edebf3' })}
  ${textSvg([wrap(`@${a.username || a.fid}`, 32, 1112 - 240, 1)[0] || ''], { x: 240, y: 192, size: 32, fill: '#9893a5' })}
  ${body}
  <line x1="88" y1="1068" x2="1112" y2="1068" stroke="#25232d" stroke-width="2"/>
  ${logoTile(88, 1092, 1.25)}
  <text x="144" y="1123" font-family="Inter" font-weight="700" font-size="30" fill="#edebf3">Quilcast Collect</text>
  <text x="1112" y="1122" font-family="Inter" font-size="28" fill="#9893a5" text-anchor="end">${esc(dateOf(c))}</text>
</svg>`
}

/** The token's metadata, as OpenSea and Blockscout read it. */
export function nftMeta(c, hash, site) {
  const a = c.author || {}
  const who = `@${a.username || a.fid}`
  // marketplaces draw Markdown in a description, not in a name
  const text = castText(c).trim()
  const urls = urlsOf(c)
  const media = urls.some(isImg) ? 'Image' : urls.some(isVid) ? 'Video' : urls.length ? 'Link' : 'Text'
  const channel = c.parent_url?.match(/\/~\/channel\/([\w-]+)$/)?.[1] || c.channel?.id
  return {
    name: `${who}: ${cut(unmarkdown(text).replace(/\s+/g, ' '), 60) || 'a cast'}`,
    description: `${text}\n\nA cast by ${who} on Farcaster, collected on Quilcast.`.trim(),
    image: `${site}/nft/0x${hash}.png`,
    external_url: `${site}/c/${hash}`,
    attributes: [
      { trait_type: 'Author', value: who },
      { trait_type: 'FID', value: Number(a.fid) || 0, display_type: 'number' },
      { trait_type: 'Cast', value: Math.floor(new Date(c.timestamp).getTime() / 1000), display_type: 'date' },
      { trait_type: 'Media', value: media },
      ...(channel ? [{ trait_type: 'Channel', value: `/${channel}` }] : []),
    ],
  }
}

export const ownerName = (o) => (o.user ? `@${o.user.username}` : `${o.address.slice(0, 6)}…${o.address.slice(-4)}`)

/** A share picture, 1200 wide and `H` tall: the NFT (`square`, its SVG) on the left, and on the right who collected it
 *  (or that it's free to collect) under the Quilcast Collect name. A profile's card (`card`) brings its own frame.
 *  `pfp`: the owner's picture, a data URI or null. */
export function shareSvg(square, o, H, card, pfp) {
  const m = card ? 40 : 56, S = H - 2 * m, x = S + 2 * m + 8, w = 1200 - x - 64
  const inner = square.replace(/<svg [^>]*>/, `<svg x="${m}" y="${m}" width="${S}" height="${S}" viewBox="0 0 1200 1200">`).replace('<rect width="1200" height="1200" fill="#0b0a10"/>', '')
  // the column (logo row, then who has it) is centered on the card's height
  let who, top
  if (o) {
    const name = o.user ? cut(o.user.display_name || o.user.username, 80) : ownerName(o)
    top = (H - 232) / 2
    who = `${textSvg(['Collected by'], { x, y: top + 136, size: 30, fill: '#9893a5' })}
  <clipPath id="cw-av"><circle cx="${x + 36}" cy="${top + 196}" r="36"/></clipPath><circle cx="${x + 36}" cy="${top + 196}" r="36" fill="#2a2735"/>
  ${pfp ? `<image href="${pfp}" x="${x}" y="${top + 160}" width="72" height="72" preserveAspectRatio="xMidYMid slice" clip-path="url(#cw-av)"/>` : initial(name, x + 36, top + 210, 32, '#9893a5')}
  ${textSvg([wrap(name, 34, w - 92, 1, { bold: true })[0] || ''], { x: x + 92, y: top + (o.user ? 190 : 208), size: 34, bold: true, fill: '#edebf3' })}
  ${o.user ? textSvg([wrap(`@${o.user.username}`, 26, w - 92, 1)[0] || ''], { x: x + 92, y: top + 226, size: 26, fill: '#9893a5' }) : ''}`
  } else {
    const lines = wrap(card ? 'Collect this card' : 'Collect this cast', 46, w, 2, { bold: true })
    const sub = 150 + (lines.length - 1) * 56 + 64
    top = (H - sub - 8) / 2
    who = `${textSvg(lines, { x, y: top + 150, lh: 56, size: 46, bold: true, fill: '#edebf3' })}
  ${textSvg(['A free 1/1 on Base'], { x, y: top + sub, size: 28, fill: '#9893a5' })}`
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="${H}" viewBox="0 0 1200 ${H}">
  <defs>
    <radialGradient id="cw-g" cx="0.95" cy="0" r="0.9"><stop offset="0" stop-color="#3a2a9a"/><stop offset="1" stop-color="#0d0c11" stop-opacity="0"/></radialGradient>
    <linearGradient id="cw-tile" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7a61ff"/><stop offset="1" stop-color="#4a2fd6"/></linearGradient>
    <clipPath id="cw-nft"><rect x="${m}" y="${m}" width="${S}" height="${S}" rx="28"/></clipPath>
  </defs>
  <rect width="1200" height="${H}" fill="#0d0c11"/><rect width="1200" height="${H}" fill="url(#cw-g)"/>
  ${card ? inner : `<g clip-path="url(#cw-nft)">${inner}</g>
  <rect x="${m}" y="${m}" width="${S}" height="${S}" rx="28" fill="none" stroke="#2f2c3b" stroke-width="3"/>`}
  <rect x="${x}" y="${top}" width="64" height="64" rx="14" fill="url(#cw-tile)"/>
  <g transform="translate(${x + 13} ${top + 13}) scale(${38 / 24})"><path d="${P.collect}" fill="none" stroke="#fff" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></g>
  <text x="${x + 84}" y="${top + 43}" font-family="Inter" font-weight="700" font-size="30" fill="#edebf3">Quilcast Collect</text>
  ${who}
</svg>`
}
