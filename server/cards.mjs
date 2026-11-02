// Quilcast Cards: a Farcaster profile as a trading card, a free 1/1 NFT on Base (contracts/src/QuilcastCards.sol, token
// id = the FID). The card shows the profile as it was when it was collected; server/index.mjs keeps that snapshot.
import { LOGO, n } from '../src/shared.ts'
import { cut, initial, textSvg, wrap } from './text.mjs'

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
  <g transform="translate(92 ${1096}) scale(0.9)"><rect width="32" height="32" rx="9" fill="#5b3df5"/><path d="${LOGO}" fill="#fff"/></g>
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
