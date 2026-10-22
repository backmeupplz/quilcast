// Serves the built app from dist/ with strict security headers, fills in meta tags for /c/<hash>
// and /u/<name>, renders a 1200×630 card per cast at /og/c/<hash>.png, serves uploads from /m/,
// and fronts the upload, link-preview and video-poster APIs.
import { renderAsync } from '@resvg/resvg-js'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { promisify } from 'node:util'
import { brotliCompress, gzip } from 'node:zlib'
import { castText, isImg, isVid, LOGO, n, sized, X_LOGO } from '../src/shared.ts'
import { fetchJson, gate, imageInfo, keep, safeGet } from './net.mjs'
import { dm } from './dm.mjs'
import { cached, unfurl } from './unfurl.mjs'
import { chunk, done, EXT, MEDIA, start, status } from './upload.mjs'
import { load, route as notifyRoute } from './notify.mjs'
import { keys as vapidKeys } from './push.mjs'
import { credits, picks, shuffle } from './shrek.mjs'

const NODE = process.env.NODE_URL || 'https://haatz.quilibrium.com'
const SITE = process.env.SITE_URL || 'https://quilcast.com'
const DIST = new URL('../dist/', import.meta.url).pathname
// notification tokens and the push key live in the data volume with the uploads (/m/ only serves media names)
const DATA = process.env.DATA_DIR || MEDIA
load(DATA)
const FONTS = ['Inter-Regular.ttf', 'Inter-Bold.ttf', 'NotoEmoji.ttf'].map((f) => new URL(`fonts/${f}`, import.meta.url).pathname)

// a stray rejection somewhere must not take the whole server down
process.on('unhandledRejection', (e) => console.error('unhandled rejection', e))

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

// --- headers ---

// The app keeps users' keys in localStorage, so scripts may only come from this origin, and the
// page may not be framed. Mini apps are https pages framed by the app (src/miniapp.tsx sandboxes them). Images and video come from anywhere (avatars, embeds, CDNs); the node
// and RPC URLs are user settings, hence https: for connect-src; messages update over farcaster.xyz's websocket.
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", 'img-src * data: blob:', 'media-src * data: blob:',
  "connect-src 'self' https: wss://ws.farcaster.xyz http://localhost:* http://127.0.0.1:*", "worker-src 'self' blob:", "font-src 'self'", "manifest-src 'self'",
  "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-src https:", "frame-ancestors 'none'",
].join('; ')
const SECURITY = {
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  // camera and microphone can be handed to a mini app's frame (its allow attribute, set per app the person allowed); nothing else
  'permissions-policy': 'camera=*, microphone=*, geolocation=(), usb=(), payment=()',
}

// --- abuse limits ---

// Traefik runs with forwardedHeaders.insecure, so it keeps whatever X-Forwarded-For the client sent
// and appends the address it actually saw: only the last entry can be trusted.
const clientIp = (req) => String(req.headers['x-forwarded-for'] || '').split(',').pop().trim() || req.socket.remoteAddress || ''
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

/** An image from a user-supplied URL as a data URI, or null; anything resvg would struggle to decode is skipped. */
async function dataUri(url) {
  try {
    const r = await safeGet(url, { max: 4e6, timeout: 5000 })
    if (r.status !== 200 || r.truncated) return null
    const info = imageInfo(r.body)
    if (!info || info.w * info.h > 16e6 || info.w > 8192 || info.h > 8192) return null
    return `data:${info.type};base64,${r.body.toString('base64')}`
  } catch {
    return null
  }
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
  const [pfp, pic] = await Promise.all([a.pfp_url ? dataUri(sized(a.pfp_url, 'w=176')) : null, v?.src ? dataUri(sized(v.src, 'w=840')) : null])
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
// rendering runs on libuv's pool, so it never blocks the event loop
const render = (svg) => renderAsync(svg, { font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'Inter' } }).then((img) => img.asPng())

// small caches; failures drop out so they're retried. Rendered PNGs get their own, smaller one.
const cache = new Map()
const pngs = new Map()
// a miss isn't kept, so the next request asks the node again
const lookup = (k, path, pick) => cache.get(k) || keep(cache, 1000, k, fetchJson(NODE + path).then((r) => pick(r) || (cache.delete(k), null)))
const getCast = (hash) => lookup(hash, `/v2/farcaster/cast?identifier=${hash}&type=hash`, (r) => r?.cast)
// by-username only knows fnames; ENS names ("shoni.eth") are found by search, exact match only
const byName = (name) => fetchJson(`${NODE}/v2/farcaster/user/by-username?username=${encodeURIComponent(name)}`).then((r) => r?.user ||
  fetchJson(`${NODE}/v2/farcaster/user/search?q=${encodeURIComponent(name)}&limit=10`).then((s) => (s?.users || s?.result?.users || []).find((u) => u.username?.toLowerCase() === name.toLowerCase())))
const getUser = (name) => cache.get(`u:${name}`) || keep(cache, 1000, `u:${name}`, (/^\d+$/.test(name) ? fetchJson(`${NODE}/v2/farcaster/user?fid=${name}`).then((r) => r?.user) : byName(name)).then((u) => u || (cache.delete(`u:${name}`), null)))

const index = await readFile(join(DIST, 'index.html'), 'utf8')
shuffle()
// swap the default title/description/url/image in index.html for page-specific ones; replacements
// are functions so `$` sequences in user text are never treated as replacement patterns
function page({ title, desc, path, image, alt }) {
  let h = index.replace(/<title>[^<]*<\/title>/, () => `<title>${esc(title)}</title>`)
  const set = (attr, keys, v) => keys.forEach((k) => (h = h.replace(new RegExp(`(<meta ${attr}="${k}" content=")[^"]*`), (_, p) => p + esc(v))))
  set('name', ['description', 'twitter:description'], desc)
  set('property', ['og:description'], desc)
  set('property', ['og:title'], title)
  set('name', ['twitter:title'], title)
  set('property', ['og:url'], SITE + path)
  if (image) set('property', ['og:image'], image), set('name', ['twitter:image'], image), set('property', ['og:image:alt'], alt), set('name', ['twitter:image:alt'], alt)
  return h.replace(/(<link rel="canonical" href=")[^"]*/, (_, p) => p + esc(SITE + path)).replace('<meta property="og:type" content="website" />', '<meta property="og:type" content="article" />')
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain', '.json': 'application/json', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' }

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
  const html = (body, memo) => send(req, res, 200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }, Buffer.from(body), memo)
  const json = (code, body, cache = 'no-store') => send(req, res, code, { 'content-type': 'application/json', 'cache-control': cache }, Buffer.from(JSON.stringify(body)))
  const app = () => html(index, 'index.html')
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

    // ogre mode's GIFs, new ones each start (server/shrek.mjs)
    const gif = path.match(/^\/shrek\/(dance|card|roar)$/)
    if (gif) return res.writeHead(302, { location: picks[gif[1]].url, 'cache-control': 'no-cache' }).end()
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

    if (path === '/api/poster') {
      if (limited(`poster:${ip}`, 240)) return res.writeHead(429).end()
      const p = await previews(() => posterOf(url.searchParams.get('url') || '')).catch(() => null)
      return p ? res.writeHead(302, { location: p, 'cache-control': 'public, max-age=3600' }).end() : res.writeHead(404).end()
    }

    const media = path.match(/^\/m\/([0-9a-f]{24})\.([a-z0-9]{3,4})$/)
    if (media) {
      const type = Object.keys(EXT).find((t) => EXT[t] === media[2])
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

    const og = path.match(/^\/og\/c\/(?:0x)?([0-9a-f]{40})\.png$/i)
    if (og) {
      const hash = og[1].toLowerCase()
      if (!pngs.has(hash) && limited(`og:${ip}`, 30)) return res.writeHead(429).end()
      const c = await getCast(hash)
      if (!c) return res.writeHead(404).end()
      const png = await (pngs.get(hash) || keep(pngs, 100, hash, renders(() => card(c).then(render))))
      return res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=3600' }).end(png)
    }

    const cast = path.match(/^\/c\/(?:0x)?([0-9a-f]{40})$/i)
    if (cast) {
      const hash = cast[1].toLowerCase()
      if (!cache.has(hash) && limited(`look:${ip}`, 120)) return app()
      const c = await getCast(hash)
      if (!c) return app()
      const desc = castText(c).slice(0, 280) || 'A cast on Farcaster'
      return html(page({ title: `${c.author?.display_name || c.author?.username} (@${c.author?.username}) on Quilcast`, desc, path, image: `${SITE}/og/c/${hash}.png`, alt: desc }))
    }

    const user = path.match(/^\/u\/([^/]{1,64})$/)
    if (user) {
      if (!cache.has(`u:${user[1]}`) && limited(`look:${ip}`, 120)) return app()
      const u = await getUser(user[1]).catch(() => null)
      if (!u) return app()
      return html(page({ title: `${u.display_name || u.username} (@${u.username}) on Quilcast`, desc: u.profile?.bio?.text || `${u.display_name || u.username} on Farcaster`, path }))
    }

    const file = normalize(join(DIST, path))
    if (file.startsWith(DIST) && extname(file)) {
      const body = await (files.get(file) || keep(files, 300, file, readFile(file))).catch(() => null)
      if (!body) return res.writeHead(404).end()
      return send(req, res, 200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600' }, body, file)
    }
    return app()
  } catch (e) {
    if (e.status === 503) return res.headersSent ? res.destroy() : res.writeHead(503).end()
    console.error(path, e)
    res.headersSent ? res.destroy() : app()
  }
}).listen(process.env.PORT || 3000)
