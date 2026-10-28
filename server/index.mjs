// Serves the built app from dist/ with strict security headers, fills in meta tags for /c/<hash>
// and /u/<name>, renders a 1200×630 card per cast at /og/c/<hash>.png, serves uploads from /m/,
// and fronts the upload, link-preview and video-poster APIs.
import { renderAsync } from '@resvg/resvg-js'
import { createHash } from 'node:crypto'
import { createReadStream, readFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { promisify } from 'node:util'
import { brotliCompress, gzip } from 'node:zlib'
import { castText, cleanDesign, cleanTheme, DEFAULTS, FONTS as FONT_STACKS, isImg, isVid, LOGO, n, sized, X_LOGO } from '../src/shared.ts'
import { PRESETS as EFFECTS } from '../src/fx.ts'
import { clientIp, fetchJson, gate, imageInfo, keep, readJson, safeGet } from './net.mjs'
import { loadTranslations, lookup as translations, translate } from './translate.mjs'
import { dm } from './dm.mjs'
import { space } from './spaces.mjs'
import { cached, unfurl } from './unfurl.mjs'
import { chunk, done, EXT, MEDIA, start, status } from './upload.mjs'
import { load, route as notifyRoute } from './notify.mjs'
import { keys as vapidKeys } from './push.mjs'
import { credits, gifs, pick, refresh } from './shrek.mjs'
import { getDesign, getLook, listLooks, loadLooks, putDesign, putLook } from './looks.mjs'
import { getMutes, loadMutes, putMutes } from './mutes.mjs'
import { gallery, getTheme, importSkin, loadThemes, putTheme, quorumSkin } from './themes.mjs'
import { body as profileBody, describe, fname, hidden, ld, nameOf, pathOf } from './profile.mjs'
import { body as homeBody, FOLD, lean, trending, wants } from './home.mjs'

const NODE = process.env.NODE_URL || 'https://haatz.quilibrium.com'
const SITE = process.env.SITE_URL || 'https://quilcast.com'
const DIST = new URL('../dist/', import.meta.url).pathname
// The standalone pages (About, the legal pages) carry their small stylesheet inline, so they paint without waiting
// for a second request; the CSP allows exactly that stylesheet by its hash
const LEGAL_CSS = (() => { try { return readFileSync(join(DIST, 'legal.css'), 'utf8') } catch { return '' } })()
const LEGAL_LINK = '<link rel="stylesheet" href="/legal.css" />'
// notification tokens and the push key live in the data volume with the uploads (/m/ only serves media names)
const DATA = process.env.DATA_DIR || MEDIA
load(DATA)
loadLooks(DATA)
loadTranslations(DATA)
// cast translations (server/translate.mjs): free OpenRouter models, set by OPENROUTER_API_KEY
const TRANSLATOR = { key: process.env.OPENROUTER_API_KEY, url: process.env.OPENROUTER_URL, site: SITE, models: process.env.OPENROUTER_MODELS?.split(',').map((m) => m.trim()).filter(Boolean) }
loadMutes(DATA)
loadThemes(DATA)
const FONTS = ['Inter-Regular.ttf', 'Inter-Bold.ttf', 'NotoEmoji.ttf'].map((f) => new URL(`fonts/${f}`, import.meta.url).pathname)

// a stray rejection somewhere must not take the whole server down
process.on('unhandledRejection', (e) => console.error('unhandled rejection', e))

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

// --- headers ---

// The app keeps users' keys in localStorage, so scripts may only come from this origin, and only Quilcast itself and
// Farcaster and Base clients may frame the page, as a mini app (their frame gets its own storage, apart from quilcast.com's;
// Quilcast in Quilcast shares it, being the same app). Mini apps are https pages framed by the app (src/miniapp.tsx sandboxes them). Images and video come from anywhere (avatars, embeds, CDNs); the node
// and RPC URLs are user settings, hence https: for connect-src; messages and Spaces update over farcaster.xyz's websocket, and Spaces audio comes from LiveKit.
// index.html's one inline script (it hides the server-drawn home page from browsers with their own account), by hash
const INLINE_JS = readFileSync(join(DIST, 'index.html'), 'utf8').match(/<script>([^<]*)<\/script>/)?.[1]
const sha = (s) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`
const CSP = [
  "default-src 'self'", `script-src 'self'${INLINE_JS ? ` ${sha(INLINE_JS)}` : ''} ${sha(FOLD)}`, `style-src 'self'${LEGAL_CSS && ` 'sha256-${createHash('sha256').update(LEGAL_CSS).digest('base64')}'`}`, 'img-src * data: blob:', 'media-src * data: blob:',
  "connect-src 'self' https: wss://ws.farcaster.xyz wss://*.livekit.cloud http://localhost:* http://127.0.0.1:*", "worker-src 'self' blob:", "font-src 'self'", "manifest-src 'self'",
  "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-src https:",
  "frame-ancestors 'self' https://farcaster.xyz https://*.farcaster.xyz https://warpcast.com https://*.warpcast.com https://base.app https://*.base.app https://*.coinbase.com",
].join('; ')
const SECURITY = {
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  // camera and microphone can be handed to a mini app's frame (its allow attribute, set per app the person allowed); nothing else
  'permissions-policy': 'camera=*, microphone=*, geolocation=(), usb=(), payment=()',
}

// --- abuse limits ---

const hits = new Map()
const limited = (key, max, ms = 60e3) => {
  const now = Date.now()
  let h = hits.get(key)
  if (!h || h.reset < now) hits.set(key, (h = { n: 0, reset: now + ms }))
  return ++h.n > max
}
setInterval(() => {
  const now = Date.now()
  for (const [k, h] of hits) h.reset < now && hits.delete(k)
}, 60e3).unref()

// --- mini app directory ---

// farcaster.xyz's public top mini apps (its CORS doesn't allow us), trimmed to what the Discover list shows.
// Kept ten minutes; if farcaster.xyz fails, the last good list stays.
let directory = { at: 0, apps: null }
const https_ = (u) => (typeof u === 'string' && /^https:\/\//.test(u) && u.length < 1024 ? u : undefined)
const text = (v, n) => (typeof v === 'string' ? v.slice(0, n) : undefined)
async function apps() {
  if (directory.apps && directory.at > Date.now() - 600e3) return directory.apps
  const r = await fetchJson('https://api.farcaster.xyz/v1/top-frameapps?limit=100', 8000).catch(() => null)
  const list = (r?.result?.frames || []).flatMap((f) => {
    const url = https_(f.homeUrl)
    return url ? [{
      url, name: text(f.name, 60) || new URL(url).host, tagline: text(f.tagline || f.subtitle || f.description, 140), icon: https_(f.iconUrl),
      splash: https_(f.splashImageUrl), bg: /^#[0-9a-f]{3,8}$/i.test(f.splashBackgroundColor) ? f.splashBackgroundColor : undefined,
      category: typeof f.primaryCategory === 'string' && /^[a-z-]{1,30}$/.test(f.primaryCategory) ? f.primaryCategory : undefined,
    }] : []
  })
  if (list.length) directory = { at: Date.now(), apps: list }
  return directory.apps || []
}

const renders = gate(2)
const previews = gate(16)
const gifCache = new Map()

// --- share cards ---

// ponytail: per-character width guesses instead of real font metrics; fine for wrapping, may misjudge exotic scripts
const charW = (c) => (/[iljI.,'!|:;`]/.test(c) ? 0.27 : c === ' ' ? 0.28 : /[mwMW@%]/.test(c) ? 0.86 : /[A-Z]/.test(c) ? 0.68 : /[0-9a-z]/.test(c) ? 0.56 : c.codePointAt(0) > 0x2e7f ? 1.05 : 0.6)
const width = (s, px) => [...s].reduce((w, c) => w + charW(c) * px, 0)
function wrap(text, px, max, lines) {
  const out = []
  for (const para of text.split('\n')) {
    let line = ''
    for (const word of para.split(/(\s+)/)) {
      if (width(line + word, px) > max && line.trim()) out.push(line.trimEnd()), (line = word.trimStart())
      else line += word
      while (width(line, px) > max) {
        let i = line.length
        while (i > 1 && width(line.slice(0, i), px) > max) i--
        out.push(line.slice(0, i))
        line = line.slice(i)
      }
    }
    out.push(line.trimEnd())
    if (out.length > lines) break
  }
  while (out.length && !out.at(-1)) out.pop()
  if (out.length > lines) {
    out.length = lines
    out[lines - 1] = out[lines - 1].replace(/\s*\S{0,12}$/, '') + '…'
  }
  return out
}

/** An image from a user-supplied URL as a data URI with its size, or null; anything resvg would struggle to decode is skipped. */
async function imageData(url, max = 4e6) {
  try {
    const r = await safeGet(url, { max, timeout: 5000 })
    if (r.status !== 200 || r.truncated) return null
    const info = imageInfo(r.body)
    if (!info || info.w * info.h > 16e6 || info.w > 8192 || info.h > 8192) return null
    return { uri: `data:${info.type};base64,${r.body.toString('base64')}`, w: info.w, h: info.h }
  } catch {
    return null
  }
}
const dataUri = (url) => imageData(url).then((i) => i?.uri ?? null)
// An image's pixel size from its first 64 KB (the formats imageInfo reads keep it in the header), or null
const shapes = new Map()
async function shapeOf(url) {
  const r = await safeGet(url, { max: 65536, timeout: 4000 })
  const info = r.status === 200 && imageInfo(r.body)
  return info ? [info.w, info.h] : null
}

// Farcaster's videos live on Cloudflare Stream; the signed playlist path also serves a thumbnail
const posters = new Map()
async function posterOf(u) {
  const id = u.match(/^https:\/\/stream\.farcaster\.xyz\/v1\/video\/([0-9a-f-]{36})\.m3u8$/i)?.[1]
  if (!id) return null
  const hit = posters.get(id)
  if (hit && Date.now() - hit.at < 6 * 3600e3) return hit.url
  const r = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
  const loc = r.headers.get('location') || ''
  if (!/^https:\/\/customer-[a-z0-9]+\.cloudflarestream\.com\/[\w.-]+\/manifest\/video\.m3u8/.test(loc)) return null
  return keep(posters, 2000, id, { url: loc.replace(/\/manifest\/video\.m3u8.*$/, '/thumbnails/thumbnail.jpg?time=1s&height=720'), at: Date.now() }).url
}

/** The picture for the card: an attached image, else a link's preview image or X photo, else a video frame. */
async function visualOf(c) {
  const urls = (Array.isArray(c.embeds) ? c.embeds : []).map((e) => e?.url).filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u))
  const img = urls.find(isImg)
  if (img) return { src: img }
  // a shared design shows its own card
  const design = urls.map((u) => u.match(/^https:\/\/quilcast\.com\/design\/([\w-]{10})$/)?.[1]).find(Boolean)
  const d = design && (await getDesign(design))
  if (d) return { design, d, wide: true }
  const themeLink = urls.map((u) => u.match(/^https:\/\/quilcast\.com\/theme\/([\w-]{10})$/)?.[1]).find(Boolean)
  const th = themeLink && (await getTheme(themeLink))
  if (th) return { theme: themeLink, th, wide: true }
  for (const u of urls.filter((u) => !isVid(u)).slice(0, 2)) {
    const d = await unfurl(u).catch(() => null)
    if (d?.tweet) return d.tweet.photos[0] || d.tweet.video ? { src: d.tweet.photos[0] || d.tweet.video, label: `@${d.tweet.author.handle} on X`, video: !d.tweet.photos[0] } : { tweet: d.tweet }
    if (d?.image) return { src: d.image, label: new URL(u).hostname.replace(/^www\./, ''), wide: true }
  }
  const vid = urls.find(isVid)
  if (vid) return { src: await posterOf(vid).catch(() => null), video: true }
}

async function card(c) {
  const a = c.author || {}
  const replies = Number(c.replies?.count) || 0
  const recasts = Number(c.reactions?.recasts_count) || 0
  const likes = Number(c.reactions?.likes_count) || 0
  // only the first ~8 lines fit, so long casts are cut before wrapping
  const text = castText(c).slice(0, 600)
  const v = await visualOf(c)
  // the CDN's resized copies are a fraction of the originals and decode faster
  const [pfp, pic] = await Promise.all([
    a.pfp_url ? dataUri(sized(a.pfp_url, 'w=176')) : null,
    v?.design ? designPng(v.design, v.d).then((p) => `data:image/png;base64,${p.toString('base64')}`, () => null)
      : v?.theme ? themePng(v.theme, v.th).then((p) => `data:image/png;base64,${p.toString('base64')}`, () => null) : v?.src ? dataUri(sized(v.src, 'w=840')) : null,
  ])
  const tile = !!(pic || v?.video || v?.tweet)
  // link previews are ~1.91:1, so they get a landscape tile; everything else a square
  const [ty, th] = v?.wide ? [172, 220] : [72, 420]
  const textW = tile ? 600 : 1040
  const size = text.length < 90 ? 46 : text.length < 200 ? 38 : 32
  const short = text.replace(/https?:\/\/(www\.)?(\S{28})\S+/g, '$2…').replace(/https?:\/\/(www\.)?/g, '')
  const lines = wrap(short || ' ', size, textW, Math.floor(300 / (size * 1.32)))
  const name = String(a.display_name || a.username || `!${a.fid}`).slice(0, 80)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <radialGradient id="g" cx="0.9" cy="0.05" r="0.8"><stop offset="0" stop-color="#3a2a9a"/><stop offset="1" stop-color="#0d0c11" stop-opacity="0"/></radialGradient>
    <clipPath id="av"><circle cx="128" cy="120" r="44"/></clipPath>
    <clipPath id="pic"><rect x="712" y="${ty}" width="420" height="${th}" rx="28"/></clipPath>
  </defs>
  <rect width="1200" height="630" fill="#0d0c11"/><rect width="1200" height="630" fill="url(#g)"/>
  <circle cx="128" cy="120" r="44" fill="#2a2735"/>
  ${pfp ? `<image href="${pfp}" x="84" y="76" width="88" height="88" preserveAspectRatio="xMidYMid slice" clip-path="url(#av)"/>` : `<text x="128" y="136" font-family="Inter" font-weight="700" font-size="40" fill="#9893a5" text-anchor="middle">${esc([...name][0]?.toUpperCase() || '?')}</text>`}
  <text x="196" y="112" font-family="Inter, Noto Emoji" font-weight="700" font-size="34" fill="#edebf3">${esc(wrap(name, 34, (tile ? 680 : 1100) - 196, 1)[0] || '')}</text>
  <text x="196" y="150" font-family="Inter" font-size="26" fill="#9893a5">@${esc(String(a.username || a.fid).slice(0, 40))}</text>
  <text font-family="Inter, Noto Emoji" font-size="${size}" fill="#edebf3">${lines.map((l, i) => `<tspan x="84" y="${232 + i * size * 1.32}">${esc(l) || ' '}</tspan>`).join('')}</text>
  ${tile ? `<rect x="712" y="${ty}" width="420" height="${th}" rx="28" fill="#1c1a23" stroke="#2a2735" stroke-width="2"/>` : ''}
  ${pic ? `<image href="${pic}" x="712" y="${ty}" width="420" height="${th}" preserveAspectRatio="xMidYMid slice" clip-path="url(#pic)"/>` : ''}
  ${v?.video ? `<circle cx="922" cy="282" r="46" fill="#000" fill-opacity="0.55"/><path d="M908 258v48l40-24z" fill="#fff"/>` : ''}
  ${v?.label ? `<rect x="728" y="${ty + th - 48}" width="${Math.min(388, Math.round(width(v.label, 20) + 28))}" height="34" rx="17" fill="#000" fill-opacity="0.6"/><text x="742" y="${ty + th - 25}" font-family="Inter" font-weight="700" font-size="20" fill="#fff">${esc(wrap(v.label, 20, 360, 1)[0] || '')}</text>` : ''}
  ${v?.tweet ? `<g transform="translate(744 104) scale(1.4)"><path d="${X_LOGO}" fill="#edebf3"/></g>
  <text x="790" y="128" font-family="Inter, Noto Emoji" font-weight="700" font-size="24" fill="#edebf3">${esc(wrap(v.tweet.author.name || '', 24, 320, 1)[0] || '')}</text>
  <text x="744" y="168" font-family="Inter" font-size="20" fill="#9893a5">@${esc(v.tweet.author.handle || '')}</text>
  <text font-family="Inter, Noto Emoji" font-size="24" fill="#edebf3">${wrap((v.tweet.text || '').replace(/https?:\/\/\S+/g, '').trim().slice(0, 600) || ' ', 24, 356, 9).map((l, i) => `<tspan x="744" y="${214 + i * 32}">${esc(l) || ' '}</tspan>`).join('')}</text>` : ''}
  <line x1="84" y1="540" x2="1116" y2="540" stroke="#25232d" stroke-width="2"/>
  <g transform="translate(84 562) scale(1.25)"><rect width="32" height="32" rx="9" fill="#5b3df5"/><path d="${LOGO}" fill="#fff"/></g>
  <text x="138" y="593" font-family="Inter" font-weight="700" font-size="28" fill="#edebf3">Quilcast</text>
  <text x="1116" y="592" xml:space="preserve" font-family="Inter" font-size="24" fill="#9893a5" text-anchor="end">${n(replies)} ${replies === 1 ? 'reply' : 'replies'}  ·  ${n(recasts)} ${recasts === 1 ? 'recast' : 'recasts'}  ·  <tspan fill="#ff5c8a">♥ ${n(likes)}</tspan></text>
</svg>`
}
/** The share card of a shared design: a profile wearing it, drawn at about twice its size on screen. */
async function designCard(d) {
  const ink = d.text || '#edebf3'
  const muted = d.muted || '#9893a5'
  const link = d.link || '#6447f5'
  const box = d.box || '#16151c'
  const line = d.border || '#2a2735'
  const fx = d.nameFx || 'none'
  const fxColor = d.nameColor || link
  const bw = d.borderStyle === 'none' ? 0 : (d.borderWidth ?? 1) * 2
  const r = (d.radius ?? 14) * 2
  // resvg can't decode animated WebP, Tenor's usual format; its small GIF of the same picture ("AAAAe") works
  const img = d.bgImg && (await imageData(d.bgImg.replace(/^(https:\/\/media\.tenor\.com\/[\w-]+AAAA)\w(\/[\w-]+)\.\w+$/, '$1e$2.gif'), 6e6))
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
    const dash = d.borderStyle === 'dashed' ? ` stroke-dasharray="${bw * 3} ${bw * 2}"` : d.borderStyle === 'dotted' ? ` stroke-dasharray="0 ${bw * 2}" stroke-linecap="round"` : ''
    return `${base} stroke="${line}" stroke-width="${bw}"${dash}/>`
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
    <linearGradient id="rainbow"><stop offset="0" stop-color="#ff004c"/><stop offset="0.2" stop-color="#ff8a00"/><stop offset="0.4" stop-color="#ffe600"/><stop offset="0.6" stop-color="#2bd44a"/><stop offset="0.8" stop-color="#00a2ff"/><stop offset="1" stop-color="#8a2be2"/></linearGradient>
    <linearGradient id="glitter" x2="1" y2="0.3"><stop offset="0.3" stop-color="${fxColor}"/><stop offset="0.5" stop-color="#fff"/><stop offset="0.7" stop-color="${fxColor}"/></linearGradient>
    <filter id="glow" x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation="9"/></filter>
  </defs>
  <rect width="1200" height="630" fill="${d.bg || '#0d0c11'}"/>${bg}
  ${d.bgDim ? `<rect width="1200" height="630" fill="#000" fill-opacity="${d.bgDim / 100}"/>` : ''}
  ${frame(80, 64, 1040, 196)}
  <g transform="translate(124 114) scale(3)"><rect width="32" height="32" rx="9" fill="#5b3df5"/><path d="${LOGO}" fill="#fff"/></g>
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

// a design never changes, so neither does its card; called inside a render slot already (renders() isn't reentrant)
const designPng = (id, d) => pngs.get(`design:${id}`) || keep(pngs, 100, `design:${id}`, designCard(cleanDesign(d)).then(render))

/** A theme's picture: our own media from the volume, Tenor's animated WebP as its GIF (resvg can't decode animated
 *  WebP; Tenor's "AAAAe" variant is a small GIF of the same picture), anything else fetched. */
const themeImage = (u, max = 6e6, sticker = false) => {
  const own = u.match(/^https:\/\/quilcast\.com\/m\/([0-9a-f]{24}\.(png|jpg|gif|webp))$/)
  if (own) return readFile(join(MEDIA, own[1])).then((b) => {
    const info = imageInfo(b)
    return info && info.w * info.h <= 16e6 ? { uri: `data:${info.type};base64,${b.toString('base64')}`, w: info.w, h: info.h } : null
  }, () => null)
  // a sticker's transparent GIF is "AAAAi"
  return imageData(u.replace(/^(https:\/\/media\.tenor\.com\/[\w-]+AAAA)\w(\/[\w-]+)\.\w+$/, `$1${sticker ? 'i' : 'e'}$2.gif`), max)
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

/** The share card of a theme: Quilcast itself wearing it (sidebar, a feed of casts, its effect and stickers), next
 *  to the theme's name, its colors and an "Apply theme" button. */
async function themeCard(id, raw) {
  const th = cleanTheme(raw)
  const base = th.base || 'dark'
  const c = { ...DEFAULTS[base], ...Object.fromEntries(Object.entries(th).filter(([k, v]) => typeof v === 'string' && v.startsWith('#'))) }
  const rs = th.round ?? 1
  const bw = th.borderStyle === 'none' ? 0 : (th.borderWidth ?? 1) * 1.5
  const dash = th.borderStyle === 'dashed' ? ` stroke-dasharray="${bw * 3} ${bw * 2}"` : th.borderStyle === 'dotted' ? ` stroke-dasharray="0 ${bw * 2}" stroke-linecap="round"` : ''
  const stroke = (color = c.line) => (bw ? ` stroke="${color}" stroke-width="${bw}"${dash}` : '')
  const R = (px) => Math.min(px * rs, 999)
  const [img, bar, btn] = await Promise.all([th.bgImg && themeImage(th.bgImg), th.barImg && themeImage(th.barImg, 4e6), th.btnImg && themeImage(th.btnImg, 4e6)])
  const stickers = (await Promise.all((th.stickers || []).slice(0, 16).map(async (s) => ({ s, i: await themeImage(s.src, 4e6, true) })))).filter((x) => x.i)
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
  // a name in the theme's name effect
  const fxColor = th.nameColor || c.accent
  const named = (x, y, size, s, base = c.ink) => {
    const t = (attrs) => `<text x="${x}" y="${y}" font-family="Inter, Noto Emoji" font-weight="800" font-size="${size}" ${attrs}>${esc(s)}</text>`
    const fx = th.nameFx
    if (fx === 'rainbow') return t('fill="url(#rainbow)"')
    if (fx === 'glitter') return t('fill="url(#glitter)"') + `<path d="M0 -1C.1 -.3 .3 -.1 1 0C.3 .1 .1 .3 0 1C-.1 .3 -.3 .1 -1 0C-.3 -.1 -.1 -.3 0 -1z" fill="#ffc928" transform="translate(${x + width(s, size) * 1.04 + size * 0.5} ${y - size * 0.35}) scale(${size * 0.3})"/>`
    if (fx === 'glow') return t(`fill="${fxColor}" filter="url(#glow)"`) + t(`fill="${base}"`)
    if (fx === 'shadow') return `<g transform="translate(3 3)">${t(`fill="${base}"`)}</g>` + t(`fill="${fxColor}"`)
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
    ${named(X + 84, y + 34, 21, name)}<text x="${X + 92 + width(name, 21) * 1.06 + (th.nameFx === 'glitter' ? 20 : 0)}" y="${y + 34}" font-family="Inter" font-size="19" fill="${c.muted}">@${user} · ${i + 2}h</text>
    <text font-family="Inter, Noto Emoji" font-size="21" fill="${c.ink}">${lines.map((l, j) => `<tspan x="${X + 84}" y="${y + 66 + j * 28}">${esc(l)}</tspan>`).join('')}</text>
    ${[[ICONS.reply, rep, c.muted], [ICONS.recast, rc, c.recast], [ICONS.like, lk, c.like]].map(([d, k, col], j) => `<g transform="translate(${X + 84 + j * 110} ${y + 112}) scale(0.85)"><path d="${d}" fill="none" stroke="${col}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></g><text x="${X + 112 + j * 110}" y="${y + 130}" font-family="Inter" font-size="18" fill="${col}">${k}</text>`).join('')}
    <rect x="${X}" y="${y + 154}" width="${W}" height="${bw}" fill="${c.line}"/>`
  }).join('')
  const nav = ['Home', 'Search', 'Notifications', 'Messages', 'Profile'].map((label, i) => {
    const y = 132 + i * 54
    return `<circle cx="78" cy="${y - 8}" r="11" fill="none" stroke="${c.ink}" stroke-width="2.4"/><text x="104" y="${y}" font-family="Inter" font-weight="${i ? 400 : 800}" font-size="22" fill="${c.ink}">${label}</text>`
  }).join('')
  // the name in up to two lines, smaller when it's long
  const title = th.name || 'Untitled theme'
  const ts = width(title, 52) > 680 ? 40 : 52
  const tl = wrap(title, ts, 352, 2)
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
    ${tl.map((l, i) => named(780, 266 + i * ts * 1.1, ts, l)).join('')}
    ${swatches}
    <text font-family="Inter" font-size="20" fill="${c.muted}">${fl.map((l, i) => `<tspan x="780" y="${380 + ty + i * 26}">${esc(l)}</tspan>`).join('')}</text>
    <rect x="780" y="${412 + ty}" width="340" height="60" rx="${R(30)}" fill="${btnFill}"/>
    <text x="950" y="${451 + ty}" font-family="Inter" font-weight="800" font-size="24" ${btnText} text-anchor="middle">Apply theme</text>
  </g>`
  const stk = stickers.map(({ s, i }) => {
    const w = s.w * 6, h = (w * i.h) / i.w, x = (s.x / 100) * 1200, y = (s.y / 100) * 630
    return `<image href="${i.uri}" x="${x - w / 2}" y="${y - h / 2}" width="${w}" height="${h}"${s.r ? ` transform="rotate(${s.r} ${x} ${y})"` : ''}/>`
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="rainbow"><stop offset="0" stop-color="#ff004c"/><stop offset="0.2" stop-color="#ff8a00"/><stop offset="0.4" stop-color="#ffe600"/><stop offset="0.6" stop-color="#2bd44a"/><stop offset="0.8" stop-color="#00a2ff"/><stop offset="1" stop-color="#8a2be2"/></linearGradient>
    <linearGradient id="glitter" x2="1" y2="0.3"><stop offset="0.3" stop-color="${fxColor}"/><stop offset="0.5" stop-color="#fff"/><stop offset="0.7" stop-color="${fxColor}"/></linearGradient>
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
/** A profile's share card: their picture, name, bio and follower counts. */
async function profileCard(u) {
  const name = nameOf(u).slice(0, 80)
  const pfp = u.pfp_url ? await dataUri(sized(u.pfp_url, 'w=352')) : null
  const bio = wrap(String(u.profile?.bio?.text || '').slice(0, 400) || ' ', 34, 1032, 4)
  const f = u.follower_count || 0
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <radialGradient id="g" cx="0.9" cy="0.05" r="0.8"><stop offset="0" stop-color="#3a2a9a"/><stop offset="1" stop-color="#0d0c11" stop-opacity="0"/></radialGradient>
    <clipPath id="av"><circle cx="172" cy="172" r="88"/></clipPath>
  </defs>
  <rect width="1200" height="630" fill="#0d0c11"/><rect width="1200" height="630" fill="url(#g)"/>
  <circle cx="172" cy="172" r="88" fill="#2a2735"/>
  ${pfp ? `<image href="${pfp}" x="84" y="84" width="176" height="176" preserveAspectRatio="xMidYMid slice" clip-path="url(#av)"/>` : `<text x="172" y="198" font-family="Inter" font-weight="700" font-size="72" fill="#9893a5" text-anchor="middle">${esc([...name][0]?.toUpperCase() || '?')}</text>`}
  <text x="300" y="160" font-family="Inter, Noto Emoji" font-weight="700" font-size="52" fill="#edebf3">${esc(wrap(name, 52, 816, 1)[0] || '')}</text>
  <text x="300" y="214" font-family="Inter" font-size="32" fill="#9893a5">@${esc(fname(u) || u.fid)}</text>
  <text font-family="Inter, Noto Emoji" font-size="34" fill="#edebf3">${bio.map((l, i) => `<tspan x="84" y="${336 + i * 45}">${esc(l) || ' '}</tspan>`).join('')}</text>
  <line x1="84" y1="540" x2="1116" y2="540" stroke="#25232d" stroke-width="2"/>
  <g transform="translate(84 562) scale(1.25)"><rect width="32" height="32" rx="9" fill="#5b3df5"/><path d="${LOGO}" fill="#fff"/></g>
  <text x="138" y="593" font-family="Inter" font-weight="700" font-size="28" fill="#edebf3">Quilcast</text>
  <text x="1116" y="592" xml:space="preserve" font-family="Inter" font-size="26" fill="#9893a5" text-anchor="end"><tspan font-weight="700" fill="#edebf3">${n(u.following_count || 0)}</tspan> following  ·  <tspan font-weight="700" fill="#edebf3">${n(f)}</tspan> ${f === 1 ? 'follower' : 'followers'}</text>
</svg>`
}

// a theme never changes, so neither does its card; called inside a render slot already (renders() isn't reentrant)
const themePng = (id, th) => pngs.get(`theme:${id}`) || keep(pngs, 100, `theme:${id}`, themeCard(id, th).then(render))

// rendering runs on libuv's pool, so it never blocks the event loop
/** A 1200×630 cast card grown to 1200×800, its background carried into the new space above and below. */
const tall = (svg) => svg.replace('height="630" viewBox="0 0 1200 630"', 'height="800" viewBox="0 -85 1200 800"').replace(/<rect width="1200" height="630" fill="(#0d0c11|url\(#g\))"\/>/g, '<rect y="-85" width="1200" height="800" fill="$1"/>')
const render = (svg) => renderAsync(svg, { font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'Inter' } }).then((img) => img.asPng())

// small caches; failures drop out so they're retried. Rendered PNGs get their own, smaller one.
const cache = new Map()
const pngs = new Map()
// a miss isn't kept, so the next request asks the node again
const lookup = (k, path, pick) => cache.get(k) || keep(cache, 1000, k, fetchJson(NODE + path).then((r) => pick(r) || (cache.delete(k), null)))
const getCast = (hash) => lookup(hash, `/v2/farcaster/cast?identifier=${hash}&type=hash`, (r) => r?.cast)
// the node's answer; null when it says there's no such thing, a throw when it fails
async function nodeJson(path) {
  const r = await fetch(NODE + path, { signal: AbortSignal.timeout(5000) })
  if (r.status === 404) return null
  if (!r.ok) throw new Error(`node answered ${r.status}`)
  return r.json()
}
// by-username only knows fnames; ENS names ("shoni.eth") are found by search, exact match only. An unused FID comes
// back as an empty user.
async function findUser(name) {
  if (/^\d{1,10}$/.test(name)) return nodeJson(`/v2/farcaster/user?fid=${name}`).then((r) => (r?.user?.custody_address ? r.user : null))
  const u = (await nodeJson(`/v2/farcaster/user/by-username?username=${encodeURIComponent(name)}`))?.user
  if (u) return u
  const s = await nodeJson(`/v2/farcaster/user/search?q=${encodeURIComponent(name)}&limit=10`)
  return (s?.users || s?.result?.users || []).find((x) => x.username?.toLowerCase() === name.toLowerCase()) || null
}
// a profile page's user and latest casts, kept ten minutes (a "no such user" too), so crawlers don't send every hit to
// the node; a failure isn't kept
const profiles = new Map()
function getProfile(name) {
  const k = name.toLowerCase()
  const hit = profiles.get(k)
  if (hit && hit.at > Date.now() - 600e3) return hit.p
  const p = findUser(name).then(async (u) => u && { u, casts: (await nodeJson(`/v2/farcaster/feed/user/casts?fid=${u.fid}&limit=25`).catch(() => null))?.casts || [] })
  keep(profiles, 2000, k, { at: Date.now(), p })
  p.catch(() => profiles.delete(k))
  return p
}

const index = await readFile(join(DIST, 'index.html'), 'utf8')

// The signed-out home page (server/home.mjs): trending's first 20 casts with the previews, quoted casts and image sizes
// they show, drawn into the page. Redrawn at most once a minute, in the background, so visitors and crawlers never
// wait on the node; what isn't back within 3 s is drawn as the app would before it arrives.
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const APP_CSS_LINK = index.match(/<link rel="stylesheet" crossorigin href="\/assets\/[^"]+\.css">/)?.[0]
const APP_CSS = APP_CSS_LINK ? readFileSync(join(DIST, APP_CSS_LINK.match(/href="\/([^"]+)"/)[1]), 'utf8') : ''
let home = null
let homeAt = 0
// the pictures the home page has led with lately (home.mjs `lead`), the only ones /i/ passes on
const leads = new Set()
const leadImgs = new Map()
/** A lead picture from Farcaster's CDN in the format the browser asked for (it answers AVIF, WebP or JPEG by Accept). */
const leadImg = (u, accept) => {
  const as = /image\/avif/.test(accept) ? 'image/avif' : /image\/webp/.test(accept) ? 'image/webp' : 'image/jpeg'
  const k = `${as} ${u}`
  return leadImgs.get(k) || keep(leadImgs, 40, k, safeGet(u, { max: 4e6, headers: { accept: as } }).then((r) => {
    if (r.status !== 200 || r.truncated || !/^image\//.test(r.type)) throw new Error(`lead ${r.status}`)
    return r
  }))
}
let homeNext = null
async function drawHome() {
  const casts = trending((await nodeJson('/v2/farcaster/feed/trending?limit=50'))?.casts || []).slice(0, 20).map(lean)
  if (!casts.length) throw new Error('no trending casts')
  const w = wants(casts)
  const got = {}
  const sizes = {}
  await Promise.race([Promise.allSettled([
    ...w.links.map((u) => previews(() => unfurl(u)).then((x) => (got[`u:${u}`] = x ?? null))),
    ...w.quotes.map((h) => getCast(h).then((c) => c && (got[`c:${h}`] = lean(c)))),
    ...w.lone.map((u) => (shapes.get(u) || keep(shapes, 2000, u, previews(() => shapeOf(u)).catch(() => null))).then((x) => (sizes[u] = x))),
  ]), new Promise((ok) => setTimeout(ok, 3000))])
  const data = { casts, got: { ...got }, shapes: { ...sizes } }
  const { html: app, css, lead } = homeBody(data, VERSION)
  if (lead) leads.add(lead), (data.lead = lead), leads.size > 20 && leads.delete(leads.values().next().value)
  // the app's stylesheet comes inline too: the page paints without a second round trip
  const style = APP_CSS + css
  // the page is drawn without the app, so its scripts come after the page's own pictures
  const page = index.replace(APP_CSS_LINK, () => `<style>${style}</style>`)
    .replace(/<(script type="module"|link rel="modulepreload") crossorigin /g, '<$1 crossorigin fetchpriority="low" ')
    .replace('<div id="app"></div>', () => `<div id="app">${app}<script type="application/json" id="boot">${JSON.stringify(data).replace(/</g, '\\u003c')}</script></div>`)
  return { at: Date.now(), page, csp: CSP.replace("style-src 'self'", () => `style-src 'self' ${sha(style)}`) }
}
function getHome() {
  if (!homeNext && Date.now() - homeAt > 60e3) {
    homeNext = drawHome().then((h) => ((home = h), (homeAt = h.at)), (e) => (console.error('home', e.message), (homeAt = Date.now() - 50e3)))
      .finally(() => (homeNext = null))
  }
  return home ? Promise.resolve(home) : homeNext ? homeNext.then(() => home) : Promise.resolve(null)
}
getHome()
refresh()
setInterval(refresh, 6 * 3600e3).unref()
// swap the default title/description/url/image in index.html for page-specific ones; replacements
// are functions so `$` sequences in user text are never treated as replacement patterns
const meta = (h, attr, k, v) => h.replace(new RegExp(`(<meta ${attr}="${k}" content=")[^"]*`), (_, p) => p + esc(v))
// in Farcaster clients (and Quilcast) a link is a card that opens that same page as a mini app; fc:frame is the older name
function launchAt(h, path, embed = `${SITE}/embed.png`) {
  for (const [k, type] of [['fc:miniapp', 'launch_miniapp'], ['fc:frame', 'launch_frame']]) {
    h = meta(h, 'name', k, JSON.stringify({ version: '1', imageUrl: embed, button: { title: 'Open in Quilcast', action: { type, name: 'Quilcast', url: SITE + path, splashImageUrl: `${SITE}/splash.png`, splashBackgroundColor: '#0d0c11' } } }))
  }
  return h
}
function page({ title, desc, path, image, alt, embed, type = 'article', robots, json, body }) {
  let h = launchAt(index.replace(/<title>[^<]*<\/title>/, () => `<title>${esc(title)}</title>`), path, embed)
  const set = (attr, keys, v) => keys.forEach((k) => (h = meta(h, attr, k, v)))
  set('name', ['description', 'twitter:description'], desc)
  set('property', ['og:description'], desc)
  set('property', ['og:title'], title)
  set('name', ['twitter:title'], title)
  set('property', ['og:url'], SITE + path)
  if (image) set('property', ['og:image'], image), set('name', ['twitter:image'], image), set('property', ['og:image:alt'], alt), set('name', ['twitter:image:alt'], alt)
  h = h.replace(/(<link rel="canonical" href=")[^"]*/, (_, p) => p + esc(SITE + path)).replace('<meta property="og:type" content="website" />', () => `<meta property="og:type" content="${type}" />`)
  // JSON-LD isn't run, so the CSP leaves it be; "<" is escaped so user text can't close the script
  if (json) h = h.replace('</head>', () => `<script type="application/ld+json">${JSON.stringify(json).replace(/</g, '\\u003c')}</script>\n</head>`)
  if (body) h = h.replace('<div id="app"></div>', () => `<div id="app">${body}</div>`)
  return robots ? noindex(h) : h
}
// out of search: no canonical, a robots tag instead
const noindex = (h) => h.replace(/\s*<link rel="canonical" href="[^"]*" \/>/, '').replace('</head>', '<meta name="robots" content="noindex, follow" />\n</head>')

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.json': 'application/json', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' }

// static files under a path without their extension: About (plain HTML for crawlers), the legal pages the stores link to, and Apple's universal links file
const PAGES = { '/about': 'about.html', '/terms': 'terms.html', '/privacy': 'privacy.html', '/delete': 'delete.html', '/safety': 'safety.html', '/.well-known/apple-app-site-association': '.well-known/apple-app-site-association.json' }

// dist/ never changes while we run: its files are read once, and compressed once per encoding
const files = new Map()
const packed = new Map()
const zip = { br: promisify(brotliCompress), gzip: promisify(gzip) }
/** Send `body`, compressed when it's text over 1 KB and the client takes br or gzip. A `memo` key marks a body that never changes. */
async function send(req, res, code, headers, body, memo) {
  if (body.length > 1024 && /^(text\/|application\/(json|manifest)|image\/svg)/.test(headers['content-type'])) {
    const accept = String(req.headers['accept-encoding'] || '')
    const enc = /\bbr\b/.test(accept) ? 'br' : /\bgzip\b/.test(accept) ? 'gzip' : ''
    headers = { ...headers, vary: 'accept-encoding' }
    if (enc) {
      body = await (memo ? packed.get(memo + enc) || keep(packed, 100, memo + enc, zip[enc](body)) : zip[enc](body))
      headers['content-encoding'] = enc
    }
  }
  res.writeHead(code, { ...headers, 'content-length': body.length }).end(body)
}

createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY)) res.setHeader(k, v)
  // no-transform: Cloudflare leaves the page as we sent it (no analytics beacon or other rewriting)
  const html = (body, memo) => send(req, res, 200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache, no-transform' }, Buffer.from(body), memo)
  const json = (code, body, cache = 'no-store') => send(req, res, code, { 'content-type': 'application/json', 'cache-control': cache }, Buffer.from(JSON.stringify(body)))
  // every other page is the app as is, its embed opening that page
  const app = () => (path === '/' || !path ? html(index, 'index.html') : html(launchAt(index, path)))
  // the home page with the signed-out feed drawn in, or the bare app when there's none yet (2 s at most)
  const homePage = async () => {
    const h = await Promise.race([getHome(), new Promise((ok) => setTimeout(ok, 2000))])
    if (!h) return app()
    res.setHeader('content-security-policy', h.csp)
    return html(h.page, `home:${h.at}`)
  }
  let url, path
  try {
    url = new URL(req.url, 'http://x')
    path = decodeURIComponent(url.pathname)
  } catch {
    return res.writeHead(400).end()
  }
  const ip = clientIp(req)
  try {
    if (path === '/health') return res.end('ok')

    // ogre mode's GIFs: a random one each time (server/shrek.mjs)
    if (/^\/shrek\/(dance|card|roar)$/.test(path)) return res.writeHead(302, { location: pick(), 'cache-control': 'no-store' }).end()
    if (path === '/shrek/credits.html') return html(credits())

    const up = path.match(/^\/api\/upload(?:\/([0-9a-f-]{36})(\/done)?)?$/)
    if (up) {
      const [, id, fin] = up
      if (!id && req.method === 'POST' && limited(`up:${ip}`, 30, 600e3)) return json(429, { error: 'Too many uploads, try again in a few minutes.' })
      const r = await Promise.resolve()
        .then(() =>
          !id && req.method === 'POST' ? start(req, { node: NODE })
            : id && fin && req.method === 'POST' ? done(req, id, { site: SITE, node: NODE })
              : id && req.method === 'PUT' ? chunk(req, id, Number(url.searchParams.get('offset')))
                : id && req.method === 'GET' ? status(id)
                  : Promise.reject(Object.assign(new Error('not found'), { status: 404 })),
        )
        .catch((e) => e)
      const err = r instanceof Error
      if (err && !r.status) console.error('upload', r)
      return json(err ? r.status || 500 : 200, err ? { error: r.status ? r.message : 'Upload failed' } : r)
    }

    if (path === '/api/translate' || path === '/api/translations') {
      // whether translating is set up here; browsers offer it only when it is
      if (path === '/api/translate' && req.method === 'GET') return json(200, { on: !!TRANSLATOR.key }, 'public, max-age=300')
      if (req.method !== 'POST') return json(405, { error: 'POST' })
      const one = path === '/api/translate'
      if (one ? limited(`tr:${ip}`, 30, 600e3) : limited(`look:${ip}`, 300)) return json(429, { error: 'Too many translations at once, try again in a few minutes.' })
      const r = await readJson(req, 4e3).then((b) => (one ? translate(b, getCast, TRANSLATOR) : translations(b))).catch((e) => e)
      const err = r instanceof Error
      if (err && !r.status) console.error('translate', r)
      return json(err ? r.status || 500 : 200, err ? { error: r.status ? r.message : "Couldn't translate that right now." } : r)
    }
    // profile looks (server/looks.mjs) and their GIF search
    if (path === '/api/looks') return limited(`look:${ip}`, 300) ? json(429, null) : json(200, await listLooks())
    const look = path.match(/^\/api\/look\/([1-9]\d{0,9})$/)
    if (look) {
      const fid = Number(look[1])
      if (req.method === 'GET') return limited(`look:${ip}`, 300) ? json(429, null) : json(200, await getLook(fid))
      if (req.method !== 'PUT') return json(405, { error: 'GET or PUT' })
      if (limited(`lookput:${ip}`, 30, 600e3) || limited(`lookput:${fid}`, 30, 600e3)) return json(429, { error: 'Too many saves, try again in a few minutes.' })
      const r = await putLook(req, fid, NODE).catch((e) => e)
      const err = r instanceof Error
      if (err && !r.status) console.error('look', r)
      return json(err ? r.status || 500 : 200, err ? { error: r.status ? r.message : 'Saving failed.' } : r)
    }
    // mutes and blocks (server/mutes.mjs)
    const mutes = path.match(/^\/api\/mutes\/([1-9]\d{0,9})$/)
    if (mutes) {
      const fid = Number(mutes[1])
      if (req.method !== 'GET' && req.method !== 'PUT') return json(405, { error: 'GET or PUT' })
      if (limited(`mutes:${ip}`, 120, 600e3)) return json(429, { error: 'Too many changes, try again in a few minutes.' })
      const r = await (req.method === 'GET' ? getMutes : putMutes)(req, fid, NODE).catch((e) => e)
      const err = r instanceof Error
      if (err && !r.status) console.error('mutes', r)
      return json(err ? r.status || 500 : 200, err ? { error: r.status ? r.message : 'Saving failed.' } : r)
    }
    const design = path.match(/^\/api\/design(?:\/([\w-]{10}))?$/)
    if (design) {
      if (req.method === 'GET' && design[1]) {
        if (limited(`look:${ip}`, 300)) return json(429, null)
        // the id is a hash of the content, so a design never changes once found
        const found = await getDesign(design[1])
        return json(200, found, found ? 'public, max-age=31536000, immutable' : 'no-store')
      }
      if (req.method !== 'POST' || design[1]) return json(405, { error: 'POST /api/design or GET /api/design/<id>' })
      if (limited(`design:${ip}`, 30, 600e3)) return json(429, { error: 'Too many designs, try again in a few minutes.' })
      const r = await putDesign(req).catch((e) => e)
      if (r instanceof Error && !r.status) console.error('design', r)
      return r instanceof Error ? json(r.status || 500, { error: r.status ? r.message : 'Sharing failed.' }) : json(200, r)
    }
    // app themes and Quorum's skins (server/themes.mjs)
    const theme = path.match(/^\/api\/theme(?:\/([\w-]{10}))?$/)
    if (theme) {
      if (req.method === 'GET' && theme[1]) {
        if (limited(`look:${ip}`, 300)) return json(429, null)
        // the id is a hash of the content, so a theme never changes once found
        const found = await getTheme(theme[1])
        return json(200, found, found ? 'public, max-age=31536000, immutable' : 'no-store')
      }
      if (req.method !== 'POST' || theme[1]) return json(405, { error: 'POST /api/theme or GET /api/theme/<id>' })
      if (limited(`theme:${ip}`, 30, 600e3)) return json(429, { error: 'Too many themes, try again in a few minutes.' })
      const r = await putTheme(req).catch((e) => e)
      if (r instanceof Error && !r.status) console.error('theme', r)
      return r instanceof Error ? json(r.status || 500, { error: r.status ? r.message : 'Sharing failed.' }) : json(200, r)
    }
    const skin = path.match(/^\/api\/quorum\/(skins|skin\/(Qm\w{44})|import)$/)
    if (skin) {
      const imp = skin[1] === 'import'
      if (imp !== (req.method === 'POST')) return json(405, { error: 'GET /api/quorum/skins or /api/quorum/skin/<id>, POST /api/quorum/import' })
      if (imp ? limited(`skinput:${ip}`, 20, 600e3) : limited(`skins:${ip}`, 120)) return json(429, { error: 'Too many themes, try again in a few minutes.' })
      const r = await (imp ? importSkin(req) : skin[2] ? quorumSkin(skin[2]) : gallery(url.searchParams)).catch((e) => e)
      if (r instanceof Error && !r.status) console.error('quorum', r)
      return r instanceof Error ? json(r.status || 500, { error: r.status ? r.message : "Couldn't load that theme." }) : json(200, r, skin[2] ? 'public, max-age=86400' : 'no-store')
    }
    if (path === '/api/gifs') {
      const q = (url.searchParams.get('q') || '').trim().slice(0, 60)
      if (!q) return json(200, [])
      const stickers = url.searchParams.has('stickers')
      const k = `${stickers ? 's:' : ''}${q.toLowerCase()}`
      if (!gifCache.has(k) && limited(`gifs:${ip}`, 30)) return json(429, [])
      const r = await (gifCache.get(k) || keep(gifCache, 500, k, previews(() => gifs(q, stickers)))).catch(() => [])
      return json(200, r, 'public, max-age=3600')
    }

    if (path === '/api/apps') {
      if (limited(`apps:${ip}`, 60)) return json(429, [])
      return json(200, await apps(), 'public, max-age=600')
    }

    if (path === '/api/notify' || path.startsWith('/api/notify/') || path === '/api/manifest') {
      // apps' servers send notifications in bursts; everything else is one browser's own calls
      if (limited(`notify:${path === '/api/notify' ? 'send' : path}:${ip}`, path === '/api/notify' ? 600 : path === '/api/notify/inbox' ? 120 : 30)) return json(429, { error: 'Slow down a little.' })
      const r = await (notifyRoute(req, path, url, SITE, () => vapidKeys(DATA).public) || Promise.reject(Object.assign(new Error('not found'), { status: 404 }))).catch((e) => e)
      const err = r instanceof Error
      if (err && !r.status) console.error('notify', r)
      return json(err ? r.status || 500 : 200, err ? { error: r.status ? r.message : 'Something went wrong.' } : r)
    }

    const sop = path.match(/^\/api\/space\/(\w{1,20})$/)?.[1]
    if (sop) {
      if (limited(`space:${ip}`, 600)) return json(429, { error: 'Slow down a little.' })
      // like messages: a failure here may hold someone's token, so it isn't logged
      const r = await space(req, sop, url).catch((e) => ({ status: e.status || 502, body: { error: e.status ? e.message : "farcaster.xyz didn't answer." } }))
      return json(r.status, r.body)
    }

    const op = path.match(/^\/api\/dm\/(\w{1,20})$/)?.[1]
    if (op) {
      if (limited(`dm:${ip}`, 240)) return json(429, { error: 'Slow down a little.' })
      // a failure here says nothing about the request: it may hold someone's token or messages
      const r = await dm(req, op, url).catch((e) => ({ status: e.status || 502, body: { error: e.status ? e.message : "farcaster.xyz didn't answer." } }))
      return json(r.status, r.body)
    }

    if (path === '/api/unfurl') {
      const target = url.searchParams.get('url') || ''
      if (!/^https?:\/\//i.test(target) || target.length > 2048) return json(200, null)
      if (!cached(target) && limited(`unfurl:${ip}`, 90)) return json(429, null)
      return json(200, await previews(() => unfurl(target)), 'public, max-age=86400')
    }

    // up to 8 images' sizes: the feed draws a lone image at its final size before it loads, so nothing below it
    // jumps when it arrives (src/ui.tsx warm)
    if (path === '/api/shapes') {
      const urls = url.searchParams.getAll('u').filter((u) => /^https:\/\//i.test(u) && u.length <= 2048).slice(0, 8)
      if (limited(`shapes:${ip}`, 120)) return json(429, {})
      const sizes = await Promise.all(urls.map((u) => shapes.get(u) || keep(shapes, 2000, u, previews(() => shapeOf(u)).catch(() => null))))
      return json(200, Object.fromEntries(urls.map((u, i) => [u, sizes[i]])), 'public, max-age=86400')
    }

    // the home page's first picture, from quilcast.com itself (server/home.mjs, shared.ts viaUs)
    const via = path.match(/^\/i\/([\w-]+\/[\w-]+)\/(w=600|w=1200)$/)
    if (via) {
      const u = `https://imagedelivery.net/${via[1]}/${via[2]}`
      if (!leads.has(`https://imagedelivery.net/${via[1]}/w=1200`)) return res.writeHead(404).end()
      if (limited(`i:${ip}`, 120)) return res.writeHead(302, { location: u }).end()
      const r = await leadImg(u, req.headers.accept || '').catch(() => null)
      if (!r) return res.writeHead(302, { location: u }).end()
      return res.writeHead(200, { 'content-type': r.type, 'content-length': r.body.length, 'cache-control': 'public, max-age=31536000, immutable', vary: 'accept' }).end(r.body)
    }

    if (path === '/api/poster') {
      if (limited(`poster:${ip}`, 240)) return res.writeHead(429).end()
      const p = await previews(() => posterOf(url.searchParams.get('url') || '')).catch(() => null)
      return p ? res.writeHead(302, { location: p, 'cache-control': 'public, max-age=3600' }).end() : res.writeHead(404).end()
    }

    const media = path.match(/^\/m\/([0-9a-f]{24})\.([a-z0-9]{3,4})$/)
    if (media) {
      // fonts get here only from Quorum themes (server/themes.mjs)
      const type = Object.keys(EXT).find((t) => EXT[t] === media[2]) || { ttf: 'font/ttf', otf: 'font/otf' }[media[2]]
      const file = join(MEDIA, `${media[1]}.${media[2]}`)
      const size = type && (await stat(file).catch(() => null))?.size
      if (!size) return res.writeHead(404).end()
      // uploads are served inert: no sniffing, no scripts, sandboxed if anything tries to render them as a page
      res.setHeader('content-security-policy', "default-src 'none'; sandbox")
      const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/)
      let from = 0
      let to = size - 1
      if (range) {
        from = range[1] ? Number(range[1]) : size - Number(range[2])
        to = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
        if (!(from >= 0 && from <= to)) return res.writeHead(416, { 'content-range': `bytes */${size}` }).end()
      }
      res.writeHead(range ? 206 : 200, { 'content-type': type, 'content-length': to - from + 1, 'accept-ranges': 'bytes', 'cache-control': 'public, max-age=31536000, immutable', ...(range && { 'content-range': `bytes ${from}-${to}/${size}` }) })
      if (req.method === 'HEAD') return res.end()
      return createReadStream(file, { start: from, end: to }).on('error', () => res.destroy()).pipe(res)
    }

    // .3x2.png is the same card for mini app embeds, which Farcaster clients show at 3:2
    const og = path.match(/^\/og\/c\/(?:0x)?([0-9a-f]{40})(\.3x2)?\.png$/i)
    if (og) {
      const hash = og[1].toLowerCase()
      const k = hash + (og[2] || '')
      if (!pngs.has(k) && limited(`og:${ip}`, 30)) return res.writeHead(429).end()
      const c = await getCast(hash)
      if (!c) return res.writeHead(404).end()
      const png = await (pngs.get(k) || keep(pngs, 100, k, renders(() => card(c).then((svg) => render(og[2] ? tall(svg) : svg)))))
      return res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=3600' }).end(png)
    }

    const cast = path.match(/^\/c\/(?:0x)?([0-9a-f]{40})$/i)
    if (cast) {
      const hash = cast[1].toLowerCase()
      if (!cache.has(hash) && limited(`look:${ip}`, 120)) return app()
      const c = await getCast(hash)
      if (!c) return app()
      const desc = castText(c).slice(0, 280) || 'A cast on Farcaster'
      return html(page({ title: `${c.author?.display_name || c.author?.username} (@${c.author?.username}) on Quilcast`, desc, path, image: `${SITE}/og/c/${hash}.png`, alt: desc, embed: `${SITE}/og/c/${hash}.3x2.png` }))
    }

    // someone's following and followers lists are only lists of other profiles
    if (/^\/u\/[^/]{1,64}\/(following|followers)$/.test(path)) return html(noindex(launchAt(index, path)))
    const user = path.match(/^\/u\/([^/]{1,64})$/)
    if (user) {
      if (!profiles.has(user[1].toLowerCase()) && limited(`look:${ip}`, 120)) return app()
      // when the node fails, the app still gets its chance to load the profile
      const p = await getProfile(user[1]).catch(() => undefined)
      if (p === undefined) return app()
      if (!p) return send(req, res, 404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache, no-transform' }, Buffer.from(noindex(launchAt(index, path))))
      const { u, casts } = p
      const at = fname(u)
      const name = nameOf(u)
      const off = hidden(u)
      return html(page({
        title: `${name}${at ? ` (@${at})` : ''} on Farcaster · Quilcast`, desc: describe(u), path: pathOf(u), type: 'profile', robots: off,
        image: `${SITE}/og/u/${u.fid}.png`, alt: `${name} on Farcaster`, json: ld(u, SITE + pathOf(u)), body: profileBody(u, off ? [] : casts),
      }))
    }
    const ogUser = path.match(/^\/og\/u\/([1-9]\d{0,9})\.png$/)
    if (ogUser) {
      const k = `u:${ogUser[1]}`
      if (!pngs.has(k) && limited(`og:${ip}`, 30)) return res.writeHead(429).end()
      const p = await getProfile(ogUser[1]).catch(() => null)
      if (!p) return res.writeHead(404).end()
      // ponytail: a card stays until it falls out of the cache or the server restarts; key it by a profile hash if edits must show sooner
      const png = await (pngs.get(k) || keep(pngs, 100, k, renders(() => profileCard(p.u).then(render))))
      return res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' }).end(png)
    }

    const designPage = path.match(/^\/design\/([\w-]{10})$/)
    if (designPage) {
      const desc = 'Colors, a background and fonts for a Quilcast profile. Open it to use this design on yours.'
      const found = await getDesign(designPage[1])
      return html(page({ title: 'A profile design on Quilcast', desc, path, ...(found && { image: `${SITE}/og/design/${designPage[1]}.png`, alt: 'A preview of the profile design' }) }))
    }
    const ogDesign = path.match(/^\/og\/design\/([\w-]{10})\.png$/)
    if (ogDesign) {
      const k = `design:${ogDesign[1]}`
      if (!pngs.has(k) && limited(`og:${ip}`, 30)) return res.writeHead(429).end()
      const d = await getDesign(ogDesign[1])
      if (!d) return res.writeHead(404).end()
      const png = await (pngs.get(k) || renders(() => designPng(ogDesign[1], d)))
      return res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=31536000, immutable' }).end(png)
    }

    const themePage = path.match(/^\/theme\/([\w-]{10})$/)
    if (themePage) {
      const th = await getTheme(themePage[1])
      const name = th?.name || 'A Quilcast theme'
      const desc = 'A theme for Quilcast: colors, a background, fonts and more for the whole app. Open it to try it on.'
      return html(page({ title: th?.name ? `${th.name}, a theme for Quilcast` : 'A theme for Quilcast', desc, path, ...(th && { image: `${SITE}/og/theme/${themePage[1]}.png`, alt: `A preview of ${name}` }) }))
    }
    const ogTheme = path.match(/^\/og\/theme\/([\w-]{10})\.png$/)
    if (ogTheme) {
      const k = `theme:${ogTheme[1]}`
      if (!pngs.has(k) && limited(`og:${ip}`, 30)) return res.writeHead(429).end()
      const th = await getTheme(ogTheme[1])
      if (!th) return res.writeHead(404).end()
      const png = await (pngs.get(k) || renders(() => themePng(ogTheme[1], th)))
      return res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=31536000, immutable' }).end(png)
    }

    if (path === '/') return homePage()
    const file = normalize(join(DIST, PAGES[path] || path))
    if (file.startsWith(DIST) && extname(file)) {
      const page = extname(file) === '.html'
      const read = page ? readFile(file).then((b) => Buffer.from(String(b).replace(LEGAL_LINK, `<style>${LEGAL_CSS}</style>`))) : readFile(file)
      const body = await (files.get(file) || keep(files, 300, file, read)).catch(() => null)
      if (!body) return res.writeHead(404).end()
      // no-transform on pages: Cloudflare leaves them as we sent them (no analytics beacon, which the CSP would block anyway)
      const cache = path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : page ? 'public, max-age=3600, no-transform' : 'public, max-age=3600'
      return send(req, res, 200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': cache }, body, file)
    }
    return app()
  } catch (e) {
    if (e.status === 503) return res.headersSent ? res.destroy() : res.writeHead(503).end()
    console.error(path, e)
    res.headersSent ? res.destroy() : app()
  }
}).listen(process.env.PORT || 3000)
