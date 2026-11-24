// Serves the built app from dist/ with strict security headers, fills in meta tags for /c/<hash>
// and /u/<name>, renders a 1200×630 card per cast at /og/c/<hash>.png, serves uploads from /m/,
// and fronts the upload, link-preview and video-poster APIs.
import { renderAsync } from '@resvg/resvg-js'
import { createHash } from 'node:crypto'
import { createReadStream, readdirSync, readFileSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, normalize, relative } from 'node:path'
import { promisify } from 'node:util'
import { brotliCompress, gzip } from 'node:zlib'
import { castText, imagesIn, queue, rpc, safeUrl, unmarkdown, cleanDesign, cleanTheme, isImg, isVid, n, sized, stickerPack, urlsOf } from '../src/shared.ts'
import { classify, classifyPart, coverOf, fromV2, headOf, isArticle, maybeArticle, partNow, plainOpening } from '../src/article.ts'
import { clientIp, fail, fetchJson, fresh, gate, httpsUrl, imageInfo, ipGroup, keep, lru, parseJson, proxiedPic, readJson, readJsonFile, readText, safeGet, sendOn } from './net.mjs'
import { loadTranslations, lookup as translations, translate } from './translate.mjs'
import { dm } from './dm.mjs'
import { space } from './spaces.mjs'
import { cached, unfurl } from './unfurl.mjs'
import { cancel, chunk, done, EXT, loadOwners, MEDIA, start, status } from './upload.mjs'
import { crosspost, deleteAccount } from './account.mjs'
import { load, route as notifyRoute } from './notify.mjs'
import { keys as vapidKeys } from './push.mjs'
import { credits, gifs, pick, refresh } from './shrek.mjs'
import { getDesign, getLook, keySigned, listLooks, loadLooks, putDesign, putLook } from './looks.mjs'
import { joined, loadStats, ready as statsReady, stats } from './stats.mjs'
import { getMutes, loadMutes, putMutes } from './mutes.mjs'
import { alertState, flushAlerts, loadAlerts, offAlerts, putAlerts, watchAlerts } from './alerts.mjs'
import { loadReports, report } from './report.mjs'
import { getDrafts, loadDrafts, putDraft } from './drafts.mjs'
import { addReminder, loadRemind, oneClickReminder, watchRemind } from './remind.mjs'
import { addPoll, getPoll, loadPolls, no, pollCard, tally, vote } from './poll.mjs'
import { cancelScheduled, getScheduled, loadScheduled, putScheduled, watchScheduled } from './scheduled.mjs'
import { getPrefs, loadPrefs, putPrefs } from './prefs.mjs'
import { getPin, loadPins, putPin } from './pins.mjs'
import { getJob, getPack, isSticker, listPacks, loadStickers, postStickers, stickerFile, stickerStill } from './stickers.mjs'
import { gallery, getTheme, importSkin, loadThemes, putTheme, quorumSkin } from './themes.mjs'
import { body as profileBody, clip, describe, fname, hidden, ld, nameOf, pathOf } from './profile.mjs'
import { rss, shown } from './feed.mjs'
import { body as homeBody, FOLD, lean, trending, wants } from './home.mjs'
import { channels, search } from './channels.mjs'
import { cardArt, cardMeta, castSvg, designSvg, nftMeta, nftSvg, ownerName, packSvg, profileSvg, shareSvg, tall, themeSvg, tierOf } from './cards.mjs'
import { cut, esc, FONTS, pictures } from './text.mjs'

const NODE = process.env.NODE_URL || 'https://haatz.quilibrium.com'
// a public Snapchain node, for keys added on Optimism since Hypersnap's fork (Remind me's one-click check); '' turns it off
const SNAPCHAIN = process.env.SNAPCHAIN_URL ?? 'https://crackle.farcaster.xyz:3381'
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
// push notifications for accounts' own activity (server/alerts.mjs): a look at the node for each signed-up account every minute
loadAlerts(DATA)
watchAlerts({ node: NODE, spamUrl: process.env.SPAM_URL || 'https://spam.quilcast.com', every: Number(process.env.ALERTS_EVERY_MS) || 60e3 })
// a deploy stops the server with SIGTERM (within Docker's 10 s before SIGKILL): it keeps serving for 5 s, while the
// proxy may still send requests here, then takes no new connections, lets the requests under way finish (up to 2 s)
// and the 1 s debounced writes (mini app inboxes, …) land, and writes what alerts handled last, so nothing is pushed twice
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms))
process.once('SIGTERM', async () => {
  await wait(5000)
  const closed = new Promise((ok) => server.close(ok))
  server.closeIdleConnections()
  await Promise.race([closed, wait(2000)])
  await wait(1500)
  await flushAlerts().catch((e) => console.error('alerts', e.message))
  process.exit(0)
})
loadReports(DATA)
loadDrafts(DATA)
// scheduled casts, signed in the browser and sent from here at their time (server/scheduled.mjs)
loadScheduled(DATA).then(() => watchScheduled({ node: NODE, every: Number(process.env.SCHEDULED_EVERY_MS) || 15e3 }))
// Remind me's reminders (server/remind.mjs), sent as mini app notifications when they're due
loadRemind(DATA, SITE).then(() => watchRemind(Number(process.env.REMIND_EVERY_MS) || 15e3))
// Poll's polls and votes (server/poll.mjs)
loadPolls(DATA)
loadPrefs(DATA)
loadPins(DATA)
loadStickers(DATA)
loadThemes(DATA)
loadStats(DATA)
loadOwners()
channels()

// a stray rejection somewhere must not take the whole server down
process.on('unhandledRejection', (e) => console.error('unhandled rejection', e))

// esc() (server/text.mjs) also drops what XML can't hold: one control character in a name or cast would make resvg
// reject the whole card

// --- headers ---

// The app keeps users' keys in localStorage, so scripts may only come from this origin, and only Quilcast itself and
// Farcaster and Base clients may frame the page, as a mini app (their frame gets its own storage, apart from quilcast.com's;
// Quilcast in Quilcast shares it, being the same app). Mini apps are https pages framed by the app (src/miniapp.tsx sandboxes them). Images and video come from anywhere (avatars, embeds, CDNs); the node
// and RPC URLs are user settings, hence https: for connect-src; WalletConnect pairs over Reown's relay, messages and Spaces update over farcaster.xyz's websocket, and Spaces audio comes from LiveKit.
// index.html's one inline script (it hides the server-drawn home page from browsers with their own account), by hash
const INLINE_JS = readFileSync(join(DIST, 'index.html'), 'utf8').match(/<script>([^<]*)<\/script>/)?.[1]
const sha = (s) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`
const CSP = [
  "default-src 'self'", `script-src 'self'${INLINE_JS ? ` ${sha(INLINE_JS)}` : ''} ${sha(FOLD)}`, `style-src 'self'${LEGAL_CSS && ` 'sha256-${createHash('sha256').update(LEGAL_CSS).digest('base64')}'`}`, 'img-src * data: blob:', 'media-src * data: blob:',
  "connect-src 'self' https: wss://ws.farcaster.xyz wss://relay.walletconnect.org wss://relay.walletconnect.com wss://*.livekit.cloud http://localhost:* http://127.0.0.1:*", "worker-src 'self' blob:", "font-src 'self'", "manifest-src 'self'",
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
const text = (v, n) => (typeof v === 'string' ? v.slice(0, n) : undefined)
async function apps() {
  if (directory.apps && directory.at > Date.now() - 600e3) return directory.apps
  const r = await fetchJson('https://api.farcaster.xyz/v1/top-frameapps?limit=100', 8000).catch(() => null)
  const list = (r?.result?.frames || []).flatMap((f) => {
    const url = httpsUrl(f.homeUrl)
    return url ? [{
      url, name: text(f.name, 60) || new URL(url).host, tagline: text(f.tagline || f.subtitle || f.description, 140), icon: httpsUrl(f.iconUrl),
      splash: httpsUrl(f.splashImageUrl), bg: /^#[0-9a-f]{3,8}$/i.test(f.splashBackgroundColor) ? f.splashBackgroundColor : undefined,
      category: typeof f.primaryCategory === 'string' && /^[a-z-]{1,30}$/.test(f.primaryCategory) ? f.primaryCategory : undefined,
    }] : []
  })
  if (list.length) directory = { at: Date.now(), apps: list }
  return directory.apps || []
}

const renders = gate(2)
const previews = gate(16)
// /api/img's pictures: 64 MB of them (none over 2 MB) kept a day, an address that gave no picture ten minutes. Fetched
// through a gate of their own, as a feed of new avatars at once mustn't hold up link previews.
const pics = lru({ bytes: 64e6, count: 20000, big: 2e6, ttl: 86400e3, miss: 600e3 })
const picFetches = gate(24, 300)
// A picture over 8 MB (a long animated GIF, #676), or one still coming after 8 s (a slow or cold upstream, #677), is
// checked by what came so far like any other, then the rest goes on to the reader as it comes (/api/img sendOn): never
// held whole, never kept, at most 64 MB within 60 s. The 8 s still holds for the headers and the picture's own header.
const BIG_PIC = 64e6
async function fetchPic(u) {
  return proxiedPic(await picFetches(() => safeGet(u, { max: 8e6, timeout: 8000, keep: true })), { big: BIG_PIC, pixels: 50e6 })
}
const pic = (u) => pics.get(u, () => fetchPic(u))
const gifCache = new Map()

// --- share cards ---

// widths, wrapping and color emoji: server/text.mjs

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

// a picture's size, or a video's from its poster (only Farcaster's streams have one; it's in the video's shape)
const shapeOfAny = (url) => (isVid(url) ? posterOf(url).then((p) => p && shapeOf(p)) : shapeOf(url))

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
  const urls = urlsOf(c)
  // a picture the text shows with Markdown counts too, but not an inline sticker: the card's text has it, as its alt
  // (unless that's all the text, and it says nothing)
  const pics = imagesIn(c.text || '')
  const img = urls.find(isImg) || pics.find((u) => !stickerPack(u)) || (unmarkdown(c.text || '') ? undefined : pics[0])
  // a sticker (shared.ts stickerPack) is drawn whole and frameless, from its still: resvg draws no animated WebP
  const st = img?.match(/^https:\/\/quilcast\.com\/st\/([\w-]{8})\/([0-9a-f]{24})\.webp$/)
  if (st && isSticker(st[1], st[2])) return { src: img, sticker: st[2] }
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
    const pic = d?.tweet && (d.tweet.photos[0] || d.tweet.article?.cover)
    if (d?.tweet) return pic || d.tweet.video ? { src: pic || d.tweet.video, label: `@${d.tweet.author.handle} on X`, video: !pic } : { tweet: d.tweet }
    if (d?.image) return { src: d.image, label: new URL(u).hostname.replace(/^www\./, ''), wide: true }
  }
  const vid = urls.find(isVid)
  if (vid) return { src: await posterOf(vid).catch(() => null), video: true }
}

/** The visual as a data URI: a shared design's or theme's own card, else the picture (`w`: the CDN size asked for). */
const pictureOf = (v, w) =>
  v?.design ? designPng(v.design, v.d).then((p) => `data:image/png;base64,${p.toString('base64')}`, () => null)
    : v?.theme ? themePng(v.theme, v.th).then((p) => `data:image/png;base64,${p.toString('base64')}`, () => null)
    : v?.sticker ? stickerStill(v.sticker) : v?.src ? dataUri(sized(v.src, w)) : null

// the CDN's resized copies are a fraction of the originals and decode faster
const pfpOf = (u, w) => (u?.pfp_url ? dataUri(sized(u.pfp_url, w)) : null)
/** A cast's share card (castSvg), with its pictures */
async function card(c) {
  const v = await visualOf(c)
  return castSvg(c, v, ...(await Promise.all([pfpOf(c.author, 'w=176'), pictureOf(v, 'w=840')])))
}
// resvg can't decode animated WebP, Tenor's usual format; its small GIF of the same picture ("AAAAe") works, and a
// sticker's transparent one is "AAAAi"
const tenorGif = (u, v = 'e') => u.replace(/^(https:\/\/media\.tenor\.com\/[\w-]+AAAA)\w(\/[\w-]+)\.\w+$/, `$1${v}$2.gif`)
/** A shared design's card (designSvg), with its background */
const designCard = async (d) => designSvg(d, d.bgImg && (await imageData(tenorGif(d.bgImg), 6e6)))

/** What a pack's card shows, as a short hash: its name and first stickers. */
const packVersion = (p) => createHash('sha256').update(p.title + p.stickers.slice(0, 12).map((s) => s.h).join()).digest('hex').slice(0, 8)

/** A sticker pack's share card (packSvg), with its stickers' first frames and its maker */
async function packCard(p, tall = false) {
  const stills = (await Promise.all(p.stickers.slice(0, 24).map((s) => stickerStill(s.h)))).filter(Boolean).slice(0, (tall ? 4 : 3) * 3)
  const owner = await userByFid(p.fid).catch(() => null)
  return packSvg(p, tall, stills, owner)
}

// a design never changes, so neither does its card; called inside a render slot already (renders() isn't reentrant)
const designPng = (id, d) => once(`design:${id}`, () => designCard(cleanDesign(d)))

/** A theme's picture: our own media from the volume, Tenor's animated WebP as its GIF (resvg can't decode animated
 *  WebP; Tenor's "AAAAe" variant is a small GIF of the same picture), anything else fetched. */
const themeImage = (u, max = 6e6, sticker = false) => {
  const own = u.match(/^https:\/\/quilcast\.com\/m\/([0-9a-f]{24}\.(png|jpg|gif|webp))$/)
  if (own) return readFile(join(MEDIA, own[1])).then((b) => {
    const info = imageInfo(b)
    return info && info.w * info.h <= 16e6 ? { uri: `data:${info.type};base64,${b.toString('base64')}`, w: info.w, h: info.h } : null
  }, () => null)
  return imageData(tenorGif(u, sticker ? 'i' : 'e'), max)
}

/** A theme's share card (themeSvg), with its pictures */
async function themeCard(id, raw) {
  const th = cleanTheme(raw)
  const [img, bar, btn] = await Promise.all([th.bgImg && themeImage(th.bgImg), th.barImg && themeImage(th.barImg, 4e6), th.btnImg && themeImage(th.btnImg, 4e6)])
  const stickers = (await Promise.all((th.stickers || []).slice(0, 16).map(async (s) => ({ s, i: await themeImage(s.src, 4e6, true) })))).filter((x) => x.i)
  return themeSvg(id, th, img, bar, btn, stickers)
}
// Sendclap (sendclap.com) keeps who supports whom (src/support.tsx); a profile's card shows its supporters
const SENDCLAP = (process.env.SENDCLAP_URL || 'https://sendclap.com').replace(/\/$/, '')
/** How many support `fid` (active memberships and tips), their monthly total and the first few faces; none when Sendclap
 *  can't say, so the card never waits long on it. */
async function supportersOf(fid) {
  const list = (await fetch(`${SENDCLAP}/api/v1/farcaster/${fid}`, { signal: AbortSignal.timeout(4000) }).then((r) => (r.ok ? r.json() : null), () => null))?.supporters
  if (!Array.isArray(list) || !list.length) return { n: 0, monthly: 0, pfps: [] }
  const users = (await nodeJson(`/v2/farcaster/user/bulk?fids=${list.slice(0, 6).map((s) => Number(s.fid)).join(',')}`).catch(() => null))?.users || []
  const pfps = (await Promise.all(users.map((x) => (x.pfp_url ? dataUri(sized(x.pfp_url, 'w=112')).catch(() => null) : null)))).filter(Boolean)
  return { n: list.length, monthly: list.reduce((a, s) => a + (Number(s.monthly_cents) || 0), 0), pfps }
}
/** A profile's share card (profileSvg) */
const profileCard = async (u) => profileSvg(u, ...(await Promise.all([pfpOf(u, 'w=352'), supportersOf(u.fid)])))

// a theme never changes, so neither does its card (as designPng)
const themePng = (id, th) => once(`theme:${id}`, () => themeCard(id, th))

// --- Quilcast Collect: a cast as a 1/1 NFT (contract in backmeupplz/quilcast-collect, token id = the cast's hash) ---

/** The NFT's picture (nftSvg) */
async function collectible(c) {
  const v = await visualOf(c)
  return nftSvg(c, v, ...(await Promise.all([pfpOf(c.author, 'w=240'), pictureOf(v, 'w=1100')])))
}

const COLLECTION = {
  name: 'Quilcast Collect',
  description: 'Casts from Farcaster, collected on Quilcast. Every cast can be collected once, for free, as a 1/1: open a cast on quilcast.com and tap Collect.',
  image: `${SITE}/nft/collection.png`,
  banner_image: `${SITE}/nft/banner.png`,
  featured_image: `${SITE}/nft/banner.png`,
  external_link: SITE,
}
// a collected cast is kept as it was first seen here, so its NFT stays when the cast is deleted; one nobody has collected
// is only shown as it is now, so deleting it takes it down here too
const NFT_DIR = join(DATA, 'nft')
const keepNft = (file, v, tag) => mkdir(NFT_DIR, { recursive: true }).then(() => writeFile(file, JSON.stringify(v))).catch((e) => console.error(tag, e))
async function keptCast(hash) {
  const file = join(NFT_DIR, `${hash}.json`)
  const kept = await readJsonFile(file)
  if (kept) return kept
  const c = await getCast(hash)
  if (c && (await ownerOf(hash))) await keepNft(file, c, 'nft: keep')
  return c
}

// --- collect.quilcast.com: the Collect mini app (collect/), each cast's page with share tags and pictures ---
const COLLECT_HOST = process.env.COLLECT_HOST || 'collect.quilcast.com'
const STICKERS_HOST = process.env.STICKERS_HOST || 'stickers.quilcast.com'
// wasm.quilcast.com: Quilcast built as a WebAssembly module (wasm/, built into wasm/dist). Its pages come from there and
// its /api/ calls reach this server's handlers like the app's do. The module needs 'wasm-unsafe-eval' to be compiled;
// no other script runs (the shell is a file of this site), and nothing may frame it.
const WASM_HOST = process.env.WASM_HOST || 'wasm.quilcast.com'
const WASM_DIR = join(process.env.WASM_DIR || new URL('../wasm/dist/', import.meta.url).pathname, '/')
const WASM_CSP = [
  "default-src 'self'", "script-src 'self' 'wasm-unsafe-eval'", "style-src 'self'", 'img-src * data: blob:', 'media-src * data: blob:',
  "connect-src 'self' https: http://localhost:* http://127.0.0.1:*", "font-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-src 'none'", "frame-ancestors 'none'",
].join('; ')
const COLLECT = `https://${COLLECT_HOST}`
const CONTRACT = '0x5961d6a95f140b40cb993190e9dc5076f0830d3e'
const BASE_RPC = process.env.BASE_RPC || 'https://mainnet.base.org'
const COLLECT_DIR = new URL('../collect/', import.meta.url).pathname
// the app reads Base, the node (who owns it) and quilcast.com (the NFT's metadata); Farcaster clients and Quilcast frame it
const COLLECT_CSP = `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ${BASE_RPC} ${SITE} ${NODE}; img-src 'self' data: https:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors *`
const collectIndex = readFileSync(join(COLLECT_DIR, 'index.html'), 'utf8')
const CARDS = '0x6acfccd110900d86b2aead4b7c4c9e1673669f13'
// who holds a cast's NFT (`hash`, the token id in hex) or a profile's card (`to` CARDS): an address and their Farcaster
// account (kept 5 minutes), or null while nobody does (asked every time)
const owners = new Map()
function ownerOf(id, to = CONTRACT) {
  const hash = `${to}:${id}`
  const hit = owners.get(hash)
  if (hit && Date.now() - hit.at < 300e3) return hit.p
  const p = rpc(BASE_RPC, 'eth_call', [{ to, data: '0x6352211e' + id.padStart(64, '0') }, 'latest'], AbortSignal.timeout(5000))
    .then(async (result) => {
      // ownerOf reverts for a cast nobody has (an error answer, which lands below); that isn't kept, so a link shared right
      // after collecting shows the collector
      if (!/^0x[0-9a-f]{64}$/i.test(result || '')) return owners.get(hash)?.p === p && owners.delete(hash), null
      const address = '0x' + result.slice(-40).toLowerCase()
      const u = (await nodeJson(`/v2/farcaster/user/bulk-by-address?addresses=${address}`).catch(() => null))?.users?.[0]
      return { address, user: u?.username ? u : null }
    })
    // a revert, or Base didn't answer: asked again next time
    .catch(() => (owners.get(hash)?.p === p && owners.delete(hash), null))
  keep(owners, 2000, hash, { at: Date.now(), p })
  return p
}
// each cast's square picture is drawn once and reused by the wide ones
const squares = new Map()
const squareOf = (hash, c) => squares.get(hash) || keep(squares, 100, hash, collectible(c))
/** shareSvg with the owner's picture */
const shareCard = async (square, o, H, card = false) => shareSvg(square, o, H, card, o?.user?.pfp_url ? await dataUri(sized(o.user.pfp_url, 'w=176')) : null)
// A profile's card shows it as it was when the card was collected: kept then (the first time it's asked for after), and
// until then drawn from the profile as it is now. { u, at, kept }, or null for no such account.
async function keptCard(fid) {
  const file = join(NFT_DIR, `card-${fid}.json`)
  const kept = await readJsonFile(file)
  if (kept) return kept
  const owned = !!(await ownerOf(fid.toString(16), CARDS))
  // collected: the profile right now, not a cached one
  if (owned) cache.delete(`fid:${fid}`)
  const u = await userByFid(fid).catch(() => null)
  if (!u) return null
  const k = { u, at: Date.now(), kept: owned }
  if (owned) await keepNft(file, k, 'nft: keep card')
  return k
}
const cardSquare = async (k) => cardArt(k.u, await pfpOf(k.u, 'w=600'), k.at)
const CARDS_COLLECTION = {
  name: 'Quilcast Cards',
  description: 'Farcaster profiles as trading cards, collected on Quilcast. Every profile has one card, free to collect as a 1/1: it shows the profile as it was the day it was collected. The lower the FID, the rarer the card: Legendary (up to 1,000), Epic (up to 20,000), Rare (up to 250,000) and Common.',
  image: `${SITE}/nft/cards.png`,
  banner_image: `${SITE}/nft/cards-banner.png`,
  featured_image: `${SITE}/nft/cards-banner.png`,
  external_link: COLLECT,
}

/** The mini app's page for a cast's `hash`, a profile's card (`fid`) or its home page: the tags a shared link shows,
 *  the embed that opens it. */
async function collectPage(hash, fid) {
  let title = 'Quilcast Collect', desc = 'Collect any Farcaster cast or profile card as a free 1/1 NFT on Base, or see who already owns it.'
  let og = `${COLLECT}/og.png`, embed = `${COLLECT}/embed.png`, button = 'Open Quilcast Collect'
  // a cast's or a card's link opens at it even when the lookup fails (the app says what went wrong there): a preview
  // read meanwhile would otherwise launch the home page, and Farcaster clients keep previews for hours
  let path = hash ? `/c/${hash}` : fid ? `/p/${fid}` : '/'
  const c = hash && (await keptCast(hash).catch(() => null))
  const k = fid && (await keptCard(fid).catch(() => null))
  if (k) {
    const o = await ownerOf(fid.toString(16), CARDS)
    const who = `@${k.u.username || fid}`
    const v = o ? o.address.slice(2, 10) : 'open'
    title = o ? `${who}'s card, collected by ${ownerName(o)}` : `Collect ${who}'s card`
    desc = `${tierOf(fid).name} Quilcast Card · FID ${fid} · ${n(k.u.follower_count || 0)} followers · ${o ? 'Collected on Quilcast Collect' : 'Free to collect as a 1/1 on Base'}`
    og = `${SITE}/nft/card/${fid}.og.png?v=${v}`
    embed = `${SITE}/nft/card/${fid}.3x2.png?v=${v}`
    button = o ? 'See the card' : 'Collect this card'
  } else if (c) {
    const o = await ownerOf(hash)
    const who = `@${c.author?.username || c.author?.fid}`
    // the owner in the picture's address, so a link shared again after the cast is collected isn't stuck on the old one
    const v = o ? o.address.slice(2, 10) : 'open'
    title = o ? `${who}'s cast, collected by ${ownerName(o)}` : `Collect ${who}'s cast`
    desc = `${cut(unmarkdown(castText(c)).replace(/\s+/g, ' '), 200) || 'A cast on Farcaster'} · ${o ? 'Collected on Quilcast Collect' : 'Free to collect as a 1/1 on Base'}`
    og = `${SITE}/nft/0x${hash}.og.png?v=${v}`
    embed = `${SITE}/nft/0x${hash}.3x2.png?v=${v}`
    button = o ? 'See the collected cast' : 'Collect this cast'
  }
  const h = shareTags(collectIndex.replace(/<title>[^<]*<\/title>/, () => `<title>${esc(title)}</title>`), title, desc, COLLECT + path, og)
  return embedTags(h, embed, button, 'Quilcast Collect', COLLECT + path, `${COLLECT}/splash.png`).replace(/(<link rel="canonical" href=")[^"]*/, (_, p) => p + esc(COLLECT + path))
}
// A pasted cast link → its full hash, which is its token id, so every link to a cast collects the same NFT: anything
// carrying all 40 hex digits (quilcast.com/c/<hash>, a bare hash, farcaster.xyz/~/conversations/0x…), or
// farcaster.xyz / warpcast.com /<name>/0x<first digits>, found among that account's casts, newest first.
// ponytail: at most 10 pages of 1000 casts are searched; an older cast of a very busy account needs its full hash.
// Lookups are kept (a miss for 10 minutes, a node failure not at all) and page the node two at a time.
const resolved = new Map()
const finds = gate(2, 20)
async function castFromLink(text) {
  const s = String(text || '').trim().slice(0, 500)
  const full = s.match(/(?:^|[^0-9a-f])(?:0x)?([0-9a-f]{40})(?![0-9a-f])/i)?.[1]?.toLowerCase()
  if (full) return (await getCast(full)) ? full : null
  const m = s.match(/^(?:https?:\/\/)?(?:www\.)?(?:farcaster\.xyz|warpcast\.com)\/([^/?#~][^/?#]*)\/0x([0-9a-f]{6,39})(?:[/?#]|$)/i)
  if (!m) return null
  const k = `${m[1]}/${m[2]}`.toLowerCase()
  if (resolved.has(k)) return resolved.get(k)
  const p = finds(async () => {
    const u = await findUser(decodeURIComponent(m[1]))
    if (!u) return null
    const prefix = '0x' + m[2].toLowerCase()
    let token = ''
    for (let i = 0; i < 10; i++) {
      const r = await nodeJson(`/v1/castsByFid?fid=${u.fid}&pageSize=1000&reverse=true${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`)
      const hit = r?.messages?.find((x) => x.hash?.toLowerCase().startsWith(prefix))
      if (hit) return hit.hash.slice(2).toLowerCase()
      if (!(token = r?.nextPageToken)) break
    }
    return null
  })
  keep(resolved, 1000, k, p)
  p.then((h) => h || setTimeout(() => resolved.get(k) === p && resolved.delete(k), 600e3).unref(), () => {})
  return p
}
// A pasted profile link or name → its FID: quilcast.com/u/<name>, farcaster.xyz/<name>, warpcast.com/<name>, @name,
// a bare name or FID
async function fidFromLink(text) {
  const s = String(text || '').trim().slice(0, 200)
  const m = s.match(/^(?:https?:\/\/)?(?:www\.)?(?:quilcast\.com\/u|farcaster\.xyz|warpcast\.com)\/([^/?#~][^/?#]*)\/?(?:[?#].*)?$/i) || s.match(/^@?([\w.-]{1,40})$/)
  if (!m) return null
  return (await findUser(decodeURIComponent(m[1])).catch(() => null))?.fid || null
}
// collect/'s files, listed once: nothing else under it is served
const collectFiles = new Set(readdirSync(COLLECT_DIR, { recursive: true, withFileTypes: true }).filter((d) => d.isFile() && d.name !== 'index.html').map((d) => '/' + relative(COLLECT_DIR, join(d.parentPath, d.name))))

// Quilcast's own cast actions (src/actions.json) and composer actions (src/composer-actions.json), each a mini app on
// its own host: actions/<name>/, and actions/shared/ for what they all load. Static pages; they read the node and
// spam.quilcast.com themselves, and Remind me and Poll keep what they need here.
const ACTIONS_DIR = new URL('../actions/', import.meta.url).pathname
const ACTION_HOSTS = { [process.env.SPAMCHECK_HOST || 'spamcheck.quilcast.com']: 'spamcheck', [process.env.TIP_HOST || 'tip.quilcast.com']: 'tip', [process.env.REMIND_HOST || 'remind.quilcast.com']: 'remindme', [process.env.POLL_HOST || 'poll.quilcast.com']: 'poll' }
const actionFiles = new Set(readdirSync(ACTIONS_DIR, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => '/' + relative(ACTIONS_DIR, join(d.parentPath, d.name))))
const ACTION_CSP = `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ${NODE} https://spam.quilcast.com; img-src 'self' data: https:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors *`
/** The file an action's host serves at `path`, or undefined. */
const actionFile = (name, path) => [`/${name}${path === '/' ? '/index.html' : path}`, `/shared${path}`].find((f) => actionFiles.has(f))

// rendering runs on libuv's pool, so it never blocks the event loop (laying out the text measures a bounded number of
// runs on the main thread first: server/text.mjs)
const render = (svg) => renderAsync(pictures(svg), { font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'Inter' } }).then((img) => img.asPng())

// small caches; failures drop out so they're retried. Rendered PNGs get their own, smaller one.
const cache = new Map()
const pngs = new Map()
/** `make()`'s SVG as a PNG, kept in pngs under `k`, rendered in its turn (renders); `once` is for inside a turn already. */
const png = (k, make) => pngs.get(k) || keep(pngs, 100, k, renders(async () => render(await make())))
const once = (k, make) => pngs.get(k) || keep(pngs, 100, k, make().then(render))
// a miss isn't kept, so the next request asks the node again
const lookup = (k, path, pick) => cache.get(k) || keep(cache, 1000, k, fetchJson(NODE + path).then((r) => pick(r) || (cache.delete(k), null)))
// follow counts move, so people and the pictures showing their counts are looked up again every 10 minutes
// (a collected card is kept: it shows the profile as it was)
const STALE = /^(fid:|u:|card:\d+:live)/
setInterval(() => { for (const m of [cache, pngs]) for (const k of m.keys()) STALE.test(k) && m.delete(k) }, 600e3).unref()
const getCast = (hash) => lookup(hash, `/v2/farcaster/cast?identifier=${hash}&type=hash`, (r) => r?.cast)
const userByFid = (fid) => lookup(`fid:${fid}`, `/v2/farcaster/user?fid=${fid}`, (r) => (r?.user?.custody_address ? r.user : null))
// the node's answer; null when it says there's no such thing, a throw when it fails
async function nodeJson(path) {
  const r = await fetch(NODE + path, { signal: AbortSignal.timeout(5000) })
  if (r.status === 404) return null
  if (!r.ok) throw new Error(`node answered ${r.status}`)
  return r.json()
}
// Farcaster Articles (src/article.ts): a node with farcasterorg/hypersnap#69 says in each /v2 cast whether it's part of an
// article (fromV2), so only a later part not in article Markdown has its first cast asked about. On an older node a cast
// that could be one (maybeArticle) is looked up in the node's /v1 API: the cast as an article's first or later part, or
// null. Kept, as a cast never changes; a failure is null and isn't kept. Eight at a time, so a page of casts doesn't
// flood the node.
const formats = new Map()
const formatLookups = queue(8)
function articleOf(c) {
  const hash = String(c?.hash || '').replace(/^0x/, '').toLowerCase()
  if (!c?.author?.fid || !/^[0-9a-f]{40}$/.test(hash)) return Promise.resolve(null)
  const x = fromV2(c)
  const now = x ? partNow(x) : maybeArticle(c) ? undefined : null
  if (now !== undefined) return Promise.resolve(now)
  let p = formats.get(hash)
  if (!p) {
    p = formatLookups(async () => (x ? classifyPart(nodeJson, x, true) : classify(nodeJson, await nodeJson(`/v1/castById?fid=${c.author.fid}&hash=0x${hash}`))))
    keep(formats, 5000, hash, p)
    p.catch(() => formats.get(hash) === p && formats.delete(hash))
  }
  // a failure is "don't know" (undefined), which leaves the app to ask, not "isn't one"
  return p.catch(() => undefined)
}
/** Marks each cast that's part of an article (`article`, as the app's api.ts articleOf has it), waiting at most `ms`:
 *  one not back by then is left for the app to ask about. */
const markArticles = (casts, ms) =>
  Promise.race([Promise.allSettled(casts.map((c) => articleOf(c).then((a) => a !== undefined && (c.article = a)))), wait(ms)])
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
const getProfile = (name) => fresh(profiles, 2000, 600e3, name.toLowerCase(), () => findUser(name).then(async (u) => {
  if (!u) return u
  const casts = (await nodeJson(`/v2/farcaster/feed/user/casts?fid=${u.fid}&limit=25`).catch(() => null))?.casts || []
  await markArticles(casts, 2000)
  return { u, casts }
}))
// RSS feeds (server/feed.mjs) as finished XML, kept ten minutes like profiles (a "no such feed" too), so readers polling
// every few minutes don't each reach the node; a failure isn't kept
// (a feed can run to a few hundred KB, so fewer are kept than profiles)
const feeds = new Map()
const feedKept = (k) => feeds.get(k)?.at > Date.now() - 600e3
// `packed` holds its br/gzip bodies (send), which go when it does
const getFeed = (k, make) => fresh(feeds, 300, 600e3, k, () => make().then((x) => x && { at: Date.now(), xml: Buffer.from(x), packed: {} }))
// a feed's cache key: a name in any case, or a FID however it's written (the node reads "003" as 3)
const feedKey = (user, name, replies) => (user ? `u:${/^\d{1,10}$/.test(name) ? +name : name.toLowerCase()}:${+replies}` : `ch:${name}`)
// an account's latest casts; replies only with ?replies=1. Taken-down and nameless accounts have no feed, as their
// profile page shows no casts. Someone who mostly replies gets a second page, so their feed isn't left short.
const userFeed = (name, replies) => getFeed(feedKey(true, name, replies), async () => {
  const u = await findUser(name)
  if (!u || hidden(u)) return null
  const page = (cursor) => nodeJson(`/v2/farcaster/feed/user/casts?fid=${u.fid}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
  const first = await page()
  let casts = first?.casts || []
  if (!replies && shown(casts).length < 25 && first?.next?.cursor) casts = [...casts, ...((await page(first.next.cursor).catch(() => null))?.casts || [])]
  const at = `@${fname(u)}`
  return rss({
    title: `${nameOf(u)} (${at}) on Farcaster`, link: SITE + pathOf(u), self: `${SITE}${pathOf(u)}/rss${replies ? '?replies=1' : ''}`, site: SITE,
    desc: clip(u.profile?.bio?.text, 500) || `The latest casts from ${at} on Farcaster, on Quilcast.`, image: u.pfp_url && sized(u.pfp_url, 'w=176'),
    casts: shown(casts, { replies }),
  })
})
// a channel's casts, under its real parent URL (the oldest channels' isn't …/~/channel/<id>). Without the directory
// that URL isn't known, so it's a failure (not kept) rather than a feed that may be empty or another channel's.
const channelFeed = (id) => getFeed(feedKey(false, id), async () => {
  const dir = await channels()
  if (!dir.list.length) throw new Error('no channel directory')
  const c = dir.byId.get(id)
  if (!c) return null
  const casts = (await nodeJson(`/v2/farcaster/feed/parent_urls?parent_urls=${encodeURIComponent(c.url)}&limit=50`))?.casts || []
  return rss({
    title: `${c.name} (/${c.id}) on Farcaster`, link: `${SITE}/channel/${id}`, self: `${SITE}/channel/${id}/rss`, site: SITE,
    desc: c.desc || `Casts in /${id} on Farcaster, on Quilcast.`, image: c.image, casts: shown(casts, { max: 50 }),
  })
})

const index = await readFile(join(DIST, 'index.html'), 'utf8')

// The signed-out home page (server/home.mjs): trending's first 20 casts with the previews, quoted casts and image sizes
// they show, drawn into the page. Redrawn at most once a minute, in the background, so visitors and crawlers never
// wait on the node; what isn't back within 3 s is drawn as the app would before it arrives.
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const APP_CSS_LINK = index.match(/<link rel="stylesheet" crossorigin href="\/assets\/[^"]+\.css">/)?.[0]
const APP_JS = /<script type="module"[^>]*><\/script>|<link rel="modulepreload"[^>]*>/g
const APP_CSS = APP_CSS_LINK ? readFileSync(join(DIST, APP_CSS_LINK.match(/href="\/([^"]+)"/)[1]), 'utf8') : ''
let home = null
let homeAt = 0
// the pictures the home page has led with lately (home.mjs `lead`), the only ones /i/ passes on
const leads = new Set()
const leadImgs = new Map()
/** A lead picture from Farcaster's CDN as WebP (it answers AVIF, WebP or JPEG by Accept). */
const leadImg = (u) => leadImgs.get(u) || keep(leadImgs, 40, u, safeGet(u, { max: 4e6, headers: { accept: 'image/webp' } }).then((r) => {
  if (r.status !== 200 || r.truncated || r.type !== 'image/webp') throw new Error(`lead ${r.status} ${r.type}`)
  return r
}))
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
    ...w.lone.map((u) => (shapes.get(u) || keep(shapes, 2000, u, previews(() => shapeOfAny(u)).catch(() => null))).then((x) => (sizes[u] = x))),
    markArticles(casts, 3000),
  ]), wait(3000)])
  const data = { casts, got: { ...got }, shapes: { ...sizes } }
  const { html: app, css, lead, meta } = homeBody(data, VERSION)
  if (lead) leads.add(lead), (data.lead = lead), leads.size > 20 && leads.delete(leads.values().next().value)
  // the app's stylesheet comes inline too: the page paints without a second round trip
  const style = APP_CSS + css
  // the page is drawn without the app, so index.html's head script loads the app's scripts once its first picture is
  // shown (or at once in a browser with its own account, which never shows this page)
  const page = index.replace(APP_JS, '').replace('<script>', () => `<template id="app-js">${index.match(APP_JS).join('')}</template>${meta}<script>`)
    .replace(APP_CSS_LINK, () => `<style>${style}</style>`)
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
/** The tags a shared link shows: its title, description, address and (if any) picture. */
function shareTags(h, title, desc, url, image) {
  for (const [a, k, v] of [['name', 'description', desc], ['property', 'og:title', title], ['property', 'og:description', desc], ['property', 'og:url', url], ['name', 'twitter:title', title], ['name', 'twitter:description', desc], ...(image ? [['property', 'og:image', image], ['name', 'twitter:image', image]] : [])]) h = meta(h, a, k, v)
  return h
}
// in Farcaster clients (and Quilcast) a link is a card that opens that same page as a mini app; fc:frame is the older name
/** The mini app embed's tags: `imageUrl` its 3:2 picture, a button `title` that opens `url` as the mini app `name`. */
function embedTags(h, imageUrl, title, name, url, splashImageUrl) {
  for (const [k, type] of [['fc:miniapp', 'launch_miniapp'], ['fc:frame', 'launch_frame']])
    h = meta(h, 'name', k, JSON.stringify({ version: '1', imageUrl, button: { title, action: { type, name, url, splashImageUrl, splashBackgroundColor: '#0d0c11' } } }))
  return h
}
/** Quilcast's embed: `embed` its 3:2 picture, `launch` a button other than "Open in Quilcast" and where it goes. */
const launchAt = (h, path, embed = `${SITE}/embed.png`, launch = { title: 'Open in Quilcast', url: SITE + path }) => embedTags(h, embed, launch.title, 'Quilcast', launch.url, `${SITE}/splash.png`)
function page({ title, desc, path, image, alt, embed, launch, type = 'article', robots, json, body, feed }) {
  let h = shareTags(launchAt(index.replace(/<title>[^<]*<\/title>/, () => `<title>${esc(title)}</title>`), path, embed, launch), title, desc, SITE + path, image)
  if (image) h = meta(meta(h, 'property', 'og:image:alt', alt), 'name', 'twitter:image:alt', alt)
  h = h.replace(/(<link rel="canonical" href=")[^"]*/, (_, p) => p + esc(SITE + path)).replace('<meta property="og:type" content="website" />', () => `<meta property="og:type" content="${type}" />`)
  // JSON-LD isn't run, so the CSP leaves it be; "<" is escaped so user text can't close the script
  if (json) h = h.replace('</head>', () => `<script type="application/ld+json">${JSON.stringify(json).replace(/</g, '\\u003c')}</script>\n</head>`)
  // the page's RSS feed, which readers find from the page's own address
  if (feed) h = h.replace('</head>', () => `<link rel="alternate" type="application/rss+xml" title="${esc(feed.title)}" href="${esc(SITE + feed.path)}" />\n</head>`)
  if (body) h = h.replace('<div id="app"></div>', () => `<div id="app">${body}</div>`)
  return robots ? noindex(h) : h
}
// out of search: no canonical, a robots tag instead
const noindex = (h) => h.replace(/\s*<link rel="canonical" href="[^"]*" \/>/, '').replace('</head>', '<meta name="robots" content="noindex, follow" />\n</head>')

// an account's own stores, signed for it (server/mutes, prefs, drafts, scheduled.mjs): its handlers by method, how many
// requests an address may make in 10 minutes, and the 405's answer
const STORES = {
  mutes: [{ GET: getMutes, PUT: putMutes }, 120, { error: 'GET or PUT' }],
  prefs: [{ GET: getPrefs, PUT: putPrefs }, 120, { error: 'GET or PUT' }],
  drafts: [{ GET: getDrafts, PUT: putDraft }, 300, { error: 'GET or PUT' }],
  scheduled: [{ GET: getScheduled, PUT: putScheduled, DELETE: cancelScheduled }, 300, { error: 'use GET, PUT or DELETE' }],
}
// shared designs (server/looks.mjs) and app themes (server/themes.mjs): get, put, the 405's and the 429's answers
const SHARED = {
  design: [getDesign, putDesign, { error: 'POST /api/design or GET /api/design/<id>' }, { error: 'Too many designs, try again in a few minutes.' }],
  theme: [getTheme, putTheme, { error: 'POST /api/theme or GET /api/theme/<id>' }, { error: 'Too many themes, try again in a few minutes.' }],
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.json': 'application/json', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm' }

// static files under a path without their extension: About (plain HTML for crawlers), the legal pages the stores link to, and Apple's universal links file
// the standalone pages in the app's other languages (public/<lang>/<page>.html), each at its own address
const TRANSLATED = /^\/(?:ar|de|es|fr|hi|id|it|ja|ko|nl|pl|pt-br|pt-pt|ru|sv|th|tr|uk|vi|zh-hans|zh-hant)\/(?:about|safety|delete)$/
const OLD_LEGAL = /^\/(?:ar|de|es|fr|hi|id|it|ja|ko|nl|pl|pt-br|pt-pt|ru|sv|th|tr|uk|vi|zh-hans|zh-hant)\/(privacy|terms)$/
const PAGES = { '/about': 'about.html', '/developers/cast-actions': 'developers/cast-actions.html', '/developers/composer-actions': 'developers/composer-actions.html', '/developers/inline-embeds': 'developers/inline-embeds.html', '/developers/mini-apps': 'developers/mini-apps.html', '/developers/stickers': 'developers/stickers.html', '/terms': 'terms.html', '/privacy': 'privacy.html', '/delete': 'delete.html', '/safety': 'safety.html', '/.well-known/apple-app-site-association': '.well-known/apple-app-site-association.json' }

// dist/ never changes while we run: its files are read once, and compressed once per encoding
const files = new Map()
const packed = new Map()
const zip = { br: promisify(brotliCompress), gzip: promisify(gzip) }
/** Send `body`, compressed when it's text over 1 KB and the client takes br or gzip. A `memo` key marks a body that never
 *  changes (its compressed copies kept in `packed`); an object `memo` keeps them itself, for a body that goes stale (a feed),
 *  so it can't push dist/'s files out of `packed`. */
async function send(req, res, code, headers, body, memo) {
  if (body.length > 1024 && /^(text\/|application\/(json|manifest|rss\+xml|wasm)|image\/svg)/.test(headers['content-type'])) {
    const accept = String(req.headers['accept-encoding'] || '')
    const enc = /\bbr\b/.test(accept) ? 'br' : /\bgzip\b/.test(accept) ? 'gzip' : ''
    headers = { ...headers, vary: 'accept-encoding' }
    if (enc) {
      body = await (typeof memo === 'object' ? (memo[enc] ||= zip[enc](body).catch((e) => { delete memo[enc]; throw e }))
        : memo ? packed.get(memo + enc) || keep(packed, 100, memo + enc, zip[enc](body)) : zip[enc](body))
      headers['content-encoding'] = enc
    }
  }
  res.writeHead(code, { ...headers, 'content-length': body.length }).end(body)
}

const server = createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY)) res.setHeader(k, v)
  // no-transform: Cloudflare leaves the page as we sent it (no analytics beacon or other rewriting)
  // with no control characters, which no page needs (they're HTML parse errors): an ESC from a cast's text would fail
  // scripts/verify.mjs, which takes one as a sign of another encoding
  const html = (body, memo) => send(req, res, 200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache, no-transform' }, Buffer.from(String(body).replace(/[\0-\x08\x0b\x0e-\x1f\x7f]/g, '')), memo)
  const json = (code, body, cache = 'no-store') => send(req, res, code, { 'content-type': 'application/json', 'cache-control': cache }, Buffer.from(JSON.stringify(body)))
  // a handler's result; its error's own message when it carries a status, else one logged under `tag` and answered `fallback`
  const answer = (tag, p, fallback, cache) => p.then((r) => json(200, r, cache), (e) => (e.status || console.error(tag, e), json(e.status || 500, { error: e.status ? e.message : fallback })))
  // a static file, typed by its name
  const serve = (file, body, cache, memo, more) => send(req, res, 200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': cache, ...more }, body, memo)
  // every other page is the app as is, its embed opening that page
  const app = () => (path === '/' || !path ? html(index, 'index.html') : html(launchAt(index, path)))
  // the home page with the signed-out feed drawn in, or the bare app when there's none yet (2 s at most)
  const homePage = async () => {
    const h = await Promise.race([getHome(), wait(2000)])
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
  // rate limits count IPv6 by its /64, which one connection can rotate through
  const ip = ipGroup(clientIp(req))
  const host = String(req.headers.host || '').split(':')[0]
  try {
    if (path === '/health') return res.end('ok')

    // collect.quilcast.com: the Collect mini app, a page per cast (/c/<hash>, or ?cast=<hash> as Quilcast first opened it)
    if (host === COLLECT_HOST) {
      res.setHeader('content-security-policy', COLLECT_CSP)
      if (path === '/api/find') {
        // the mini app words the errors itself
        if (limited(`resolve:${ip}`, 30)) return json(429, {})
        const q = url.searchParams.get('url')
        const hash = await castFromLink(q)
        const fid = !hash && (await fidFromLink(q))
        return hash ? json(200, { hash }) : fid ? json(200, { fid }) : json(404, {})
      }
      // a profile's card: /p/<fid>, or ?fid=
      const fid = Number(path.match(/^\/p\/(\d{1,10})$/)?.[1] || (path === '/' && url.searchParams.get('fid')?.match(/^\d{1,10}$/)?.[0]))
      if (fid) {
        if (!cache.has(`fid:${fid}`) && limited(`look:${ip}`, 120)) return res.writeHead(429).end()
        return html(await collectPage(null, fid))
      }
      // ?castHash= is how Farcaster clients hand over a cast shared to the app (the manifest's castShareUrl)
      const asked = path === '/' ? url.searchParams.get('cast') || url.searchParams.get('castHash') : undefined
      const hash = (path.match(/^\/c\/(?:0x)?([0-9a-f]{40})$/i)?.[1] || asked?.match(/^(?:0x)?([0-9a-f]{40})$/i)?.[1])?.toLowerCase()
      if (hash || path === '/') {
        if (hash && !cache.has(hash) && limited(`look:${ip}`, 120)) return res.writeHead(429).end()
        return html(await collectPage(hash))
      }
      // the mini app side is the cast actions' (actions/shared/miniapp.js)
      if (path === '/miniapp.js') return serve(path, await readFile(join(ACTIONS_DIR, 'shared/miniapp.js')), 'public, max-age=300', 'action:/shared/miniapp.js')
      if (!collectFiles.has(path)) return res.writeHead(404).end()
      return serve(path, await readFile(join(COLLECT_DIR, path)), 'public, max-age=300', 'collect:' + path, path.startsWith('/.well-known/') && { 'access-control-allow-origin': '*' })
    }

    const action = ACTION_HOSTS[host]
    // Remind me's one-click entries POST here from people's browsers (any client's), so it answers CORS
    if (action === 'remindme' && path === '/api/action') {
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST' }
      if (req.method === 'OPTIONS') return res.writeHead(204, cors).end()
      const reply = (code, body) => send(req, res, code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors }, Buffer.from(JSON.stringify(body)))
      if (req.method !== 'POST') return reply(405, { message: 'POST a signed tap here.' })
      // the same daily cap as /api/remind, on the same count, so no one fills the store with made-up tokens
      const who = ipGroup(ip)
      if (limited(`remind:action:${who}`, 30)) return reply(429, { message: 'Slow down a little.' })
      if (limited(`remind:day:${who}`, 200, 86400e3)) return reply(429, { message: 'Too many reminders right now. Try again later.' })
      const r = await readJson(req, 8000).then((b) => oneClickReminder(b, host, { nodes: [NODE, SNAPCHAIN].filter(Boolean), node: NODE })).catch((e) => e)
      if (r instanceof Error && !r.status) console.error('remind action', r)
      return r instanceof Error ? reply(r.status || 500, { message: r.status ? r.message : 'Something went wrong.' }) : reply(200, r)
    }
    // Remind me also keeps reminders (server/remind.mjs) and takes its manifest's webhook events (not kept)
    if (action === 'remindme' && req.method === 'POST' && (path === '/api/remind' || path === '/webhook')) {
      // IPv6 counted by its /64; a day's reminders are capped too, so no one fills the store
      const who = ipGroup(ip)
      if (limited(`remind:${path}:${who}`, 30)) return json(429, { error: 'Slow down a little.' })
      if (path === '/webhook') return json(200, { ok: true })
      if (limited(`remind:day:${who}`, 200, 86400e3)) return json(429, { error: 'too many reminders' })
      return answer('remind', readJson(req, 8000).then((b) => addReminder(b, host)), 'Something went wrong.')
    }
    // Poll keeps polls and votes (server/poll.mjs); a poll's page is the app with its own embed tags and picture
    if (action === 'poll') {
      const who = ipGroup(ip)
      const polled = (p) => answer('poll', p, 'Something went wrong. Try again.')
      if (path === '/api/poll' && req.method === 'POST') {
        if (limited(`poll:new:${who}`, 20) || limited(`poll:day:${who}`, 200, 86400e3)) return polled(Promise.reject(no(429, 'Too many polls right now. Try again later.')))
        return polled(readJson(req, 8000).then((b) => addPoll(b, host)))
      }
      const api = path.match(/^\/api\/poll\/([0-9a-f]{12})(\/vote)?$/)
      if (api && api[2] && req.method === 'POST') {
        if (limited(`poll:vote:${who}`, 30)) return polled(Promise.reject(no(429, 'Slow down a little.')))
        return polled(readJson(req, 8000).then((b) => vote(api[1], b, host, { node: NODE, snapchain: SNAPCHAIN })))
      }
      if (api && !api[2]) {
        const p = await getPoll(api[1])
        return polled(p ? tally(api[1], p) : Promise.reject(no(404, 'That poll is gone.')))
      }
      const card = path === '/embed.png' ? 'home' : path.match(/^\/p\/([0-9a-f]{12})\.png$/)?.[1]
      if (card) {
        const p = card === 'home' ? { question: 'What should we ask?', options: ['Write 2 to 4 options', 'Put the poll in your cast', 'Everyone votes once'] } : await getPoll(card)
        if (!p) return res.writeHead(404).end()
        // a poll never changes, so neither does its picture
        return send(req, res, 200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=31536000, immutable' }, await png(`poll:${card}`, () => pollCard(p)))
      }
      const id = path.match(/^\/p\/([0-9a-f]{12})$/)?.[1]
      if (id) {
        const p = await getPoll(id)
        let h = await readFile(join(ACTIONS_DIR, 'poll/index.html'), 'utf8')
        if (p) {
          const url = `https://${host}/p/${id}`
          h = embedTags(shareTags(h, p.question.replace(/\s+/g, ' ').slice(0, 120), p.options.join(' · '), url, `${url}.png`), `${url}.png`, 'Vote', 'Poll', url, `https://${host}/icon.png`)
          // its options, or the bars once voted, then a line for the count (actions/poll/app.js inline)
          h = meta(h, 'name', 'fc:miniapp:inline', JSON.stringify({ url: `${url}?inline`, height: 36 + 48 * p.options.length }))
        }
        res.setHeader('content-security-policy', ACTION_CSP)
        return html(h)
      }
    }
    if (action) {
      const f = actionFile(action, path)
      if (!f) return res.writeHead(404).end()
      return serve(f, await readFile(join(ACTIONS_DIR, f)), 'public, max-age=300', 'action:' + f, { 'content-security-policy': ACTION_CSP, ...(path.startsWith('/.well-known/') && { 'access-control-allow-origin': '*' }) })
    }

    // stickers.quilcast.com/<pack> is a sticker pack's short link; the packs live in the app (src/stickers.tsx)
    if (host === STICKERS_HOST) {
      const id = path.match(/^\/([\w-]{8})$/)?.[1]
      return res.writeHead(301, { location: `${SITE}/stickers${id ? `/${id}` : ''}`, 'cache-control': 'public, max-age=86400' }).end()
    }

    if (host === WASM_HOST && !path.startsWith('/api/')) {
      res.setHeader('content-security-policy', WASM_CSP)
      const file = normalize(join(WASM_DIR, path))
      if (file.startsWith(WASM_DIR) && extname(file) && extname(file) !== '.html') {
        const body = await readFile(file).catch(() => null)
        if (!body) return res.writeHead(404).end()
        return serve(file, body, path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600', 'wasm:' + file)
      }
      // every page is the app, which reads the address itself
      const page = await readFile(join(WASM_DIR, 'index.html')).catch(() => null)
      if (!page) return res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' }).end('This server was built without Quilcast WASM (wasm/build.sh).')
      return html(page, 'wasm:index')
    }

    // ogre mode's GIFs: a random one each time (server/shrek.mjs)
    if (/^\/shrek\/(dance|card|roar)$/.test(path)) return res.writeHead(302, { location: pick(), 'cache-control': 'no-store' }).end()
    if (path === '/shrek/credits.html') return html(credits())

    const up = path.match(/^\/api\/upload(?:\/([0-9a-f-]{36})(\/done)?)?$/)
    if (up) {
      const [, id, fin] = up
      if (!id && req.method === 'POST' && limited(`up:${ip}`, 30, 600e3)) return json(429, { error: 'Too many uploads, try again in a few minutes.' })
      const r = Promise.resolve().then(() =>
        !id && req.method === 'POST' ? start(req, { node: NODE })
          : id && fin && req.method === 'POST' ? done(req, id, { site: SITE, node: NODE })
            : id && req.method === 'PUT' ? chunk(req, id, Number(url.searchParams.get('offset')))
              : id && req.method === 'GET' ? status(id)
                : id && !fin && req.method === 'DELETE' ? cancel(id)
                  : Promise.reject(fail(404, 'not found')),
      )
      return answer('upload', r, 'Upload failed')
    }

    if (path === '/api/translate' || path === '/api/translations') {
      // whether translating is set up here; browsers offer it only when it is
      if (path === '/api/translate' && req.method === 'GET') return json(200, { on: !!TRANSLATOR.key }, 'public, max-age=300')
      if (req.method !== 'POST') return json(405, { error: 'POST' })
      const one = path === '/api/translate'
      if (one ? limited(`tr:${ip}`, 30, 600e3) : limited(`look:${ip}`, 300)) return json(429, { error: 'Too many translations at once, try again in a few minutes.' })
      return answer('translate', readJson(req, 4e3).then((b) => (one ? translate(b, getCast, TRANSLATOR) : translations(b))), "Couldn't translate that right now.")
    }
    // profile looks (server/looks.mjs) and their GIF search
    if (path === '/api/looks') return limited(`look:${ip}`, 300) ? json(429, null) : json(200, await listLooks())
    const look = path.match(/^\/api\/look\/([1-9]\d{0,9})$/)
    if (look) {
      const fid = Number(look[1])
      if (req.method === 'GET') return limited(`look:${ip}`, 300) ? json(429, null) : json(200, await getLook(fid))
      if (req.method !== 'PUT') return json(405, { error: 'GET or PUT' })
      if (limited(`lookput:${ip}`, 30, 600e3)) return json(429, { error: 'Too many saves, try again in a few minutes.' })
      // the per-account limit counts signed saves only, like pins'
      return answer('look', putLook(req, fid, NODE, () => limited(`lookfid:${fid}`, 30, 600e3)), 'Saving failed.')
    }
    // pinned casts (server/pins.mjs): public like looks, saved signed
    const pin = path.match(/^\/api\/pin\/([1-9]\d{0,9})$/)
    if (pin) {
      const fid = Number(pin[1])
      if (req.method === 'GET') return limited(`pin:${ip}`, 300) ? json(429, null) : json(200, await getPin(fid))
      if (req.method !== 'PUT') return json(405, { error: 'GET or PUT' })
      if (limited(`pinip:${ip}`, 30, 600e3)) return json(429, { error: 'Too many pins, try again in a few minutes.' })
      // the per-account limit counts signed saves only, or anyone could lock someone's pin with unsigned ones; its own
      // prefix, as an address (the last X-Forwarded-For hop, unchecked) may look like a FID
      return answer('pin', putPin(req, fid, NODE, () => limited(`pinfid:${fid}`, 30, 600e3)), 'Saving failed.')
    }
    // sticker packs (server/stickers.mjs)
    if (path.startsWith('/api/stickers/')) {
      const job = path.match(/^\/api\/stickers\/job\/([0-9a-f]{16})$/)
      if (job) return json(200, getJob(job[1]))
      const pack = path.match(/^\/api\/stickers\/pack\/([\w-]{8})$/)
      if (pack) return limited(`look:${ip}`, 300) ? json(429, null) : json(200, await getPack(pack[1]))
      const fid = Number(path.match(/^\/api\/stickers\/([1-9]\d{0,9})$/)?.[1])
      if (!fid) return json(404, { error: 'not found' })
      if (req.method === 'GET') return limited(`look:${ip}`, 300) ? json(429, null) : json(200, await listPacks(fid))
      if (req.method !== 'POST') return json(405, { error: 'GET or POST' })
      if (limited(`stickip:${ip}`, 300, 600e3)) return json(429, { error: 'Too many changes, try again in a few minutes.' })
      return answer('stickers', postStickers(req, fid, NODE, () => limited(`stickfid:${fid}`, 300, 600e3)), 'Saving failed.')
    }

    // the ⋯ menu's Report (server/report.mjs)
    if (path === '/api/report') {
      if (req.method !== 'POST') return json(405, { error: 'only POST' })
      if (limited(`report:${ip}`, 20, 600e3)) return json(429, { error: 'Too many reports, try again in a few minutes.' })
      return answer('report', report(req, { node: NODE, site: SITE }), "The report couldn't be sent. Try again.")
    }
    // an account's own signed stores (STORES)
    const store = path.match(/^\/api\/(mutes|prefs|drafts|scheduled)\/([1-9]\d{0,9})$/)
    if (store) {
      const [by, max, methods] = STORES[store[1]]
      if (!by[req.method]) return json(405, methods)
      if (limited(`${store[1]}:${ip}`, max, 600e3)) return json(429, { error: 'Too many changes, try again in a few minutes.' })
      return answer(store[1], by[req.method](req, Number(store[2]), NODE), 'Saving failed.')
    }
    // push notifications for the account's activity (server/alerts.mjs)
    const alerts = path.match(/^\/api\/alerts\/([1-9]\d{0,9})(?:\/(state|off))?$/)
    if (alerts) {
      const fid = Number(alerts[1])
      if (alerts[2] ? req.method !== 'POST' : req.method !== 'PUT') return json(405, { error: alerts[2] ? 'POST' : 'PUT' })
      if (limited(`alerts:${ip}`, 120, 600e3)) return json(429, { error: 'Too many changes, try again in a few minutes.' })
      return answer('alerts', alerts[2] === 'state' ? alertState(req, fid) : alerts[2] === 'off' ? offAlerts(req, fid) : putAlerts(req, fid, NODE), 'Saving failed.')
    }
    // counts only (server/stats.mjs): accounts a day, and the sign-ups each campaign link brought
    if (path === '/api/stats') {
      if (req.method !== 'GET') return json(405, { error: 'use GET' })
      return limited(`stats:${ip}`, 60) ? json(429, null) : json(200, stats(), 'public, max-age=60')
    }
    // a browser's first sign-in, from a campaign's link: signed "quilcast-signup:<fid>:<ts>:<body>", body {"campaign"}.
    // The account is in x-fid, never the path, so no request log ties it to a campaign.
    if (path === '/api/signup') {
      if (req.method !== 'POST') return json(405, { error: 'use POST' })
      if (limited(`signup:${ip}`, 10, 600e3)) return json(429, { error: 'Slow down a little.' })
      const fid = /^[1-9]\d{0,9}$/.test(String(req.headers['x-fid'] || '')) ? Number(req.headers['x-fid']) : 0
      if (!fid) return json(400, { error: 'x-fid missing' })
      const r = readText(req, 1e3).then(async (body) => (await keySigned(req, 'quilcast-signup', fid, body, NODE), await statsReady, { counted: joined(fid, parseJson(body)?.campaign) }))
      return answer('signup', r, 'Failed.')
    }
    // X crossposting: its own service holds the keys (server/crosspost.mjs); requests go there as they came
    const xp = path.match(/^\/api\/crosspost\/([1-9]\d{0,19})$/)
    if (xp) {
      if (!['GET', 'POST', 'PUT', 'DELETE'].includes(req.method)) return json(405, { error: 'use GET, POST, PUT or DELETE' })
      if (limited(`crosspost:${ip}`, 60, 600e3)) return json(429, { error: 'Too many changes, try again in a few minutes.' })
      const r = await readText(req, 4e3).then((body) => crosspost(req.method, xp[1], req.headers, body)).catch((e) => e)
      if (r instanceof Error && !r.status) console.error('crosspost', r.message)
      return r instanceof Error ? json(r.status || 503, { error: r.status ? r.message : 'unavailable' }) : json(r.status, r.body)
    }
    // deleting an account: everything kept here for it (server/account.mjs)
    const del = path.match(/^\/api\/account\/([1-9]\d{0,9})$/)
    if (del) {
      if (req.method !== 'DELETE') return json(405, { error: 'use DELETE' })
      if (limited(`del:${ip}`, 60, 600e3)) return json(429, { error: 'Too many changes, try again in a few minutes.' })
      return answer('account', deleteAccount(req, Number(del[1]), url.searchParams.get('run'), { node: NODE, site: SITE }), 'Deleting failed. Try again.')
    }
    // shared designs and app themes (SHARED)
    const shared = path.match(/^\/api\/(design|theme)(?:\/([\w-]{10}))?$/)
    if (shared) {
      const [, kind, id] = shared
      const [get, put, methods, busy] = SHARED[kind]
      if (req.method === 'GET' && id) {
        if (limited(`look:${ip}`, 300)) return json(429, null)
        // the id is a hash of the content, so it never changes once found
        const found = await get(id)
        return json(200, found, found ? 'public, max-age=31536000, immutable' : 'no-store')
      }
      if (req.method !== 'POST' || id) return json(405, methods)
      if (limited(`${kind}:${ip}`, 30, 600e3)) return json(429, busy)
      return answer(kind, put(req), 'Sharing failed.')
    }
    // Quorum's skins (server/themes.mjs)
    const skin = path.match(/^\/api\/quorum\/(skins|skin\/(Qm\w{44})|import)$/)
    if (skin) {
      const imp = skin[1] === 'import'
      if (imp !== (req.method === 'POST')) return json(405, { error: 'GET /api/quorum/skins or /api/quorum/skin/<id>, POST /api/quorum/import' })
      if (imp ? limited(`skinput:${ip}`, 20, 600e3) : limited(`skins:${ip}`, 120)) return json(429, { error: 'Too many themes, try again in a few minutes.' })
      return answer('quorum', imp ? importSkin(req, ip) : skin[2] ? quorumSkin(skin[2]) : gallery(url.searchParams), "Couldn't load that theme.", skin[2] ? 'public, max-age=86400' : 'no-store')
    }
    if (path === '/api/gifs') {
      const q = (url.searchParams.get('q') || '').trim().slice(0, 60)
      if (!q) return json(200, [])
      const stickers = url.searchParams.has('stickers')
      const k = `${stickers ? 's:' : ''}${q.toLowerCase()}`
      if (!gifCache.has(k) && limited(`gifs:${ip}`, 30)) return json(429, [])
      let p = gifCache.get(k)
      if (!p) {
        p = keep(gifCache, 500, k, previews(() => gifs(q, stickers)))
        // searches change, and the composer opens on "trending": an hour, like the browsers' cache below
        setTimeout(() => gifCache.get(k) === p && gifCache.delete(k), 3600e3).unref()
      }
      const r = await p.catch(() => [])
      return json(200, r, 'public, max-age=3600')
    }

    if (path === '/api/apps') {
      if (limited(`apps:${ip}`, 60)) return json(429, [])
      return json(200, await apps(), 'public, max-age=600')
    }
    // the channel directory (server/channels.mjs): ?q= searches it, without q it's the top channels by followers
    if (path === '/api/channels') {
      if (limited(`channels:${ip}`, 300)) return json(429, [])
      const { list } = await channels()
      const q = (url.searchParams.get('q') || '').trim().slice(0, 64)
      const n = Math.min(100, Math.max(1, +url.searchParams.get('n') || 50))
      return json(200, q ? search(list, q, n) : list.slice(0, n), 'public, max-age=600')
    }
    if (path === '/api/channels/legacy') return json(200, (await channels()).legacy, 'public, max-age=86400')
    // whether someone is a member of a members-only channel, whose other casts farcaster.xyz leaves out of it
    const member = path.match(/^\/api\/channel\/([a-z0-9-]{1,64})\/member\/([1-9]\d{0,9})$/)
    if (member) {
      if (limited(`member:${ip}`, 60)) return json(429, null)
      const r = await fetchJson(`https://api.farcaster.xyz/fc/channel-members?channelId=${member[1]}&fid=${member[2]}`, 5000).catch(() => null)
      return json(200, { member: r ? !!r.result?.members?.length : null }, 'private, max-age=300')
    }
    const chan = path.match(/^\/api\/channel\/([a-z0-9-]{1,64})$/)
    if (chan) {
      const c = (await channels()).byId.get(chan[1])
      return c ? json(200, c, 'public, max-age=600') : json(404, null, 'public, max-age=600')
    }

    if (path === '/api/notify' || path.startsWith('/api/notify/') || path === '/api/manifest') {
      // apps' servers send notifications in bursts; everything else is one browser's own calls
      if (limited(`notify:${path === '/api/notify' ? 'send' : path}:${ip}`, path === '/api/notify' ? 600 : path === '/api/notify/inbox' ? 120 : 30)) return json(429, { error: 'Slow down a little.' })
      return answer('notify', notifyRoute(req, path, url, SITE, () => vapidKeys(DATA).public) || Promise.reject(fail(404, 'not found')), 'Something went wrong.')
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
      return json(200, await previews(() => unfurl(target)), 'public, max-age=3600')
    }

    // up to 8 images' (or videos') sizes: the feed draws a lone image or a video at its final size before it loads, so
    // nothing below it jumps when it arrives (src/ui.tsx warm)
    if (path === '/api/shapes') {
      const urls = url.searchParams.getAll('u').filter((u) => /^https:\/\//i.test(u) && u.length <= 2048).slice(0, 8)
      if (limited(`shapes:${ip}`, 120)) return json(429, {})
      const sizes = await Promise.all(urls.map((u) => shapes.get(u) || keep(shapes, 2000, u, previews(() => shapeOfAny(u)).catch(() => null))))
      return json(200, Object.fromEntries(urls.map((u, i) => [u, sizes[i]])), 'public, max-age=86400')
    }

    // the home page's first picture, from quilcast.com itself (server/home.mjs, shared.ts viaUs)
    const via = path.match(/^\/i\/([\w-]+\/[\w-]+)\/(w=600|w=1200)\.webp$/)
    if (via) {
      const u = `https://imagedelivery.net/${via[1]}/${via[2]}`
      if (!leads.has(`https://imagedelivery.net/${via[1]}/w=1200`)) return res.writeHead(404).end()
      if (limited(`i:${ip}`, 120)) return res.writeHead(302, { location: u }).end()
      const r = await leadImg(u).catch(() => null)
      if (!r) return res.writeHead(302, { location: u }).end()
      return res.writeHead(200, { 'content-type': r.type, 'content-length': r.body.length, 'cache-control': 'public, max-age=31536000, immutable' }).end(r.body)
    }

    // Another site's picture (shared.ts proxied: avatars, link previews, embeds, mini app icons, Markdown pictures),
    // fetched here so its host never sees who is looking (no tracking pixels) and can't point a reader's browser at
    // their own network: public addresses only (safeGet, also after redirects), a real PNG, JPEG, GIF, WebP, AVIF or
    // SVG by its bytes, at most 50 megapixels and 64 MB (over 8 MB passed on as it comes, not kept), served inert. Kept
    // a while (pics), so a popular avatar is fetched once, not once per reader, and only fetches count towards the limit.
    // ponytail: served at the size it comes in; resize (avatars are shown at 40 px) if this traffic grows
    if (path === '/api/img') {
      const target = safeUrl(url.searchParams.get('u'))
      if (!target || target.length > 2048) return res.writeHead(400).end()
      if (!pics.has(target) && limited(`img:${ip}`, 600)) return res.writeHead(429).end()
      let p = await pic(target)
      // a big one's rest is one reader's: another who asked at the same moment fetches it again, and that counts
      if (p?.rest && p.taken) {
        if (limited(`img:${ip}`, 600)) return res.writeHead(429).end()
        p = await fetchPic(target).catch(() => null)
      }
      if (!p) return res.writeHead(404).end()
      res.setHeader('content-security-policy', "default-src 'none'; sandbox")
      const head = { 'content-type': p.type, 'cache-control': 'public, max-age=86400' }
      if (!p.rest) return res.writeHead(200, { ...head, 'content-length': p.body.length }).end(p.body)
      p.taken = true
      res.writeHead(200, p.size >= p.body.length ? { ...head, 'content-length': p.size } : head)
      return sendOn(res, p.body, p.rest, { max: BIG_PIC, ms: 60e3 })
    }

    if (path === '/api/poster') {
      if (limited(`poster:${ip}`, 240)) return res.writeHead(429).end()
      const p = await previews(() => posterOf(url.searchParams.get('url') || '')).catch(() => null)
      return p ? res.writeHead(302, { location: p, 'cache-control': 'public, max-age=3600' }).end() : res.writeHead(404).end()
    }

    // a sticker; the pack in its address is where Quilcast opens it from
    const st = path.match(/^\/st\/([\w-]{8})\/([0-9a-f]{24})\.webp$/)
    if (st) {
      const body = isSticker(st[1], st[2]) && (await readFile(stickerFile(st[2])).catch(() => null))
      if (!body) return res.writeHead(404).end()
      res.setHeader('content-security-policy', "default-src 'none'; sandbox")
      return res.writeHead(200, { 'content-type': 'image/webp', 'content-length': body.length, 'cache-control': 'public, max-age=31536000, immutable', 'access-control-allow-origin': '*' }).end(req.method === 'HEAD' ? undefined : body)
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
      return res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=3600' }).end(await png(k, () => card(c).then((svg) => (og[2] ? tall(svg) : svg))))
    }

    if (path === '/nft/collection.json') return json(200, COLLECTION, 'public, max-age=3600')
    if (path === '/nft/cards.json') return json(200, CARDS_COLLECTION, 'public, max-age=3600')
    // a profile's card: /nft/card/<fid> its metadata, .png the card, .3x2.png and .og.png what a shared link shows
    const pc = path.match(/^\/nft\/card\/(\d{1,10})(\.png|\.3x2\.png|\.og\.png)?$/)
    if (pc) {
      const fid = Number(pc[1])
      const wide = pc[2] && pc[2] !== '.png' ? (pc[2] === '.og.png' ? 630 : 800) : 0
      if (!cache.has(`fid:${fid}`) && limited(`nft:${ip}`, 600)) return res.writeHead(429).end()
      const k = fid && (await keptCard(fid))
      if (!k) return res.writeHead(404, { 'access-control-allow-origin': '*' }).end()
      if (!pc[2]) return res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600', 'access-control-allow-origin': '*' }).end(JSON.stringify(cardMeta(k.u, k.at, SITE)))
      const o = wide ? await ownerOf(fid.toString(16), CARDS) : null
      const key = `card:${fid}:${k.kept ? k.at : 'live'}${wide ? `:${wide}:${o?.address || ''}` : ''}`
      if (!pngs.has(key) && limited(`og:${ip}`, 30)) return res.writeHead(429).end()
      const p = await png(key, () => cardSquare(k).then((sq) => (wide ? shareCard(sq, o, wide, true) : sq)))
      // until it's collected, the card follows the profile
      return res.writeHead(200, { 'content-type': 'image/png', 'cache-control': `public, max-age=${wide ? 300 : k.kept ? 86400 : 600}`, 'access-control-allow-origin': '*' }).end(p)
    }
    // .png: the NFT itself; .3x2.png and .og.png: the pictures a shared Collect link shows, with who owns it
    const nft = path.match(/^\/nft\/0x([0-9a-f]{40})(\.png|\.3x2\.png|\.og\.png)?$/i)
    if (nft) {
      const hash = nft[1].toLowerCase()
      const wide = nft[2] && nft[2] !== '.png' ? (nft[2] === '.og.png' ? 630 : 800) : 0
      const o = wide ? await ownerOf(hash) : null
      const k = `nft:${hash}${wide ? `:${wide}:${o?.address || ''}` : ''}`
      // rendering is what costs, so it gets the share cards' limit; marketplaces fetch metadata in bulk
      if (nft[2] ? !pngs.has(k) && limited(`og:${ip}`, 30) : limited(`nft:${ip}`, 600)) return res.writeHead(429).end()
      const c = await keptCast(hash)
      if (!c) return res.writeHead(404, { 'access-control-allow-origin': '*' }).end()
      // the Collect mini app (collect.quilcast.com) reads it too
      if (!nft[2]) return res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600', 'access-control-allow-origin': '*' }).end(JSON.stringify(nftMeta(c, hash, SITE)))
      const p = await png(k, () => (wide ? squareOf(hash, c).then((sq) => shareCard(sq, o, wide)) : squareOf(hash, c)))
      return res.writeHead(200, { 'content-type': 'image/png', 'cache-control': `public, max-age=${wide ? 300 : 86400}` }).end(p)
    }

    const cast = path.match(/^\/c\/(?:0x)?([0-9a-f]{40})$/i)
    if (cast) {
      const hash = cast[1].toLowerCase()
      if (!cache.has(hash) && limited(`look:${ip}`, 120)) return app()
      const c = await getCast(hash)
      if (!c) return app()
      const by = `${c.author?.display_name || c.author?.username} (@${c.author?.username})`
      // an article shares as its title, opening and cover
      const a = await Promise.race([articleOf(c), wait(2000)])
      if (isArticle(a)) {
        const { title, opening } = headOf(castText(c))
        const cover = coverOf(c.embeds)
        const desc = cut(plainOpening(opening, c.embeds).replace(/\s+/g, ' '), 280) || `An article by ${by} on Farcaster`
        const image = cover ? sized(cover, 'w=1200') : `${SITE}/og/c/${hash}.png`
        const json = { '@context': 'https://schema.org', '@type': 'Article', headline: cut(title, 110), url: SITE + path, datePublished: c.timestamp, author: { '@type': 'Person', name: c.author?.display_name || c.author?.username, url: `${SITE}/u/${c.author?.username || c.author?.fid}` }, ...(cover && { image }) }
        return html(page({ title: `${title} · ${by} on Quilcast`, desc, path, image, alt: title, embed: `${SITE}/og/c/${hash}.3x2.png`, json }))
      }
      const desc = cut(unmarkdown(castText(c)), 280) || 'A cast on Farcaster'
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
      // a shared support cast links to ?tab=supporters (src/support.tsx): its embed's button goes there and says so
      const support = url.searchParams.get('tab') === 'supporters'
      return html(page({
        title: `${name}${at ? ` (@${at})` : ''} on Farcaster · Quilcast`, desc: describe(u), path: pathOf(u), type: 'profile', robots: off,
        // ?v=2: the cards gained supporters (2026-11-15), and Cloudflare kept the old ones
        image: `${SITE}/og/u/${u.fid}.png?v=2`, embed: `${SITE}/og/u/${u.fid}.3x2.png?v=2`, alt: `${name} on Farcaster`,
        ...(support && { launch: { title: cut(`Support @${at || u.fid}`, 32), url: `${SITE}${pathOf(u)}?tab=supporters` } }),
        json: ld(u, SITE + pathOf(u)), body: profileBody(u, off ? [] : casts),
        ...(!off && { feed: { title: `${name} (@${at}) on Quilcast`, path: `${pathOf(u)}/rss` } }),
      }))
    }
    // RSS: an account's casts and a channel's, each XML kept ten minutes (getFeed); a reader that misses the cache shares
    // the profile pages' limit
    const feedOf = path.match(/^\/u\/([^/]{1,64})\/rss$/) || path.match(/^\/channel\/([a-z0-9-]{1,64})\/rss$/)
    if (feedOf) {
      const replies = url.searchParams.get('replies') === '1'
      const ofUser = path.startsWith('/u/')
      const k = feedKey(ofUser, feedOf[1], replies)
      const plain = (code, more = {}) => res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', ...more }).end(code === 404 ? 'No such feed.' : code === 429 ? 'Slow down a little.' : 'Try again in a minute.')
      if (!feedKept(k) && limited(`look:${ip}`, 120)) return plain(429, { 'retry-after': '60' })
      const f = await (ofUser ? userFeed(feedOf[1], replies) : channelFeed(feedOf[1])).catch(() => undefined)
      if (f === undefined) return plain(502, { 'retry-after': '60' })
      if (!f) return plain(404, { 'cache-control': 'public, max-age=600' })
      return send(req, res, 200, { 'content-type': 'application/rss+xml; charset=utf-8', 'cache-control': 'public, max-age=600' }, f.xml, f.packed)
    }
    // .3x2.png is the same card for mini app embeds (what Farcaster clients and Quilcast show for a shared profile link)
    const ogUser = path.match(/^\/og\/u\/([1-9]\d{0,9})(\.3x2)?\.png$/)
    if (ogUser) {
      // drawn again each hour, for new supporters
      const k = `u:${ogUser[1]}${ogUser[2] || ''}:${Math.floor(Date.now() / 3600e3)}`
      if (!pngs.has(k) && limited(`og:${ip}`, 30)) return res.writeHead(429).end()
      const p = await getProfile(ogUser[1]).catch(() => null)
      if (!p) return res.writeHead(404).end()
      // supporters change, so a few hours rather than a day
      return res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=10800' }).end(await png(k, () => profileCard(p.u).then((svg) => (ogUser[2] ? tall(svg) : svg))))
    }

    const channelPage = path.match(/^\/channel\/([a-z0-9-]{1,64})$/)
    if (channelPage) {
      const c = (await channels()).byId.get(channelPage[1])
      if (!c) return app()
      const desc = cut(c.desc || `Casts in /${c.id} on Farcaster.`, 280)
      return html(page({ title: `${c.name} (/${c.id}) on Farcaster · Quilcast`, desc, path, image: c.image, alt: c.name, feed: { title: `${c.name} (/${c.id}) on Quilcast`, path: `/channel/${c.id}/rss` } }))
    }

    const designPage = path.match(/^\/design\/([\w-]{10})$/)
    if (designPage) {
      const desc = 'Colors, a background and fonts for a Quilcast profile. Open it to use this design on yours.'
      const found = await getDesign(designPage[1])
      return html(page({ title: 'A profile design on Quilcast', desc, path, ...(found && { image: `${SITE}/og/design/${designPage[1]}.png`, alt: 'A preview of the profile design' }) }))
    }
    const ogShared = path.match(/^\/og\/(design|theme)\/([\w-]{10})\.png$/)
    if (ogShared) {
      const [, kind, id] = ogShared
      const k = `${kind}:${id}`
      if (!pngs.has(k) && limited(`og:${ip}`, 30)) return res.writeHead(429).end()
      const x = await SHARED[kind][0](id)
      if (!x) return res.writeHead(404).end()
      const p = await (pngs.get(k) || renders(() => (kind === 'design' ? designPng : themePng)(id, x)))
      return res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=31536000, immutable' }).end(p)
    }

    const packPage = path.match(/^\/stickers\/([\w-]{8})$/)
    if (packPage) {
      const p = await getPack(packPage[1])
      if (!p) return app()
      const desc = `${p.stickers.length} stickers. Open the pack in Quilcast to add it and send them in casts and messages.`
      const v = packVersion(p)
      return html(page({ title: `${p.title}: a sticker pack on Quilcast`, desc, path, image: `${SITE}/og/stickers/${p.id}.png?v=${v}`, embed: `${SITE}/og/stickers/${p.id}.3x2.png?v=${v}`, alt: `Stickers from ${p.title}` }))
    }
    // .3x2.png is the mini app embed's; pages link them with ?v=<the pack's version>, so a changed pack gets a new
    // address (Farcaster clients keep an embed's picture for good)
    const ogPack = path.match(/^\/og\/stickers\/([\w-]{8})(\.3x2)?\.png$/)
    if (ogPack) {
      const p = await getPack(ogPack[1])
      if (!p) return res.writeHead(404).end()
      const k = `stickers:${ogPack[1]}${ogPack[2] || ''}:${packVersion(p)}`
      if (!pngs.has(k) && limited(`og:${ip}`, 30)) return res.writeHead(429).end()
      return res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=600' }).end(await png(k, () => packCard(p, !!ogPack[2])))
    }

    const themePage = path.match(/^\/theme\/([\w-]{10})$/)
    if (themePage) {
      const th = await getTheme(themePage[1])
      const name = th?.name || 'A Quilcast theme'
      const desc = 'A theme for Quilcast: colors, a background, fonts and more for the whole app. Open it to try it on.'
      return html(page({ title: th?.name ? `${th.name}, a theme for Quilcast` : 'A theme for Quilcast', desc, path, ...(th && { image: `${SITE}/og/theme/${themePage[1]}.png`, alt: `A preview of ${name}` }) }))
    }

    // the link every train cast carries (TRAIN in src/shared.ts): Quilcast hides it, other Farcaster clients show it as a
    // card, so it says what the cast is and opens Quilcast; only this exact path, /trains and the like are other pages
    if (path === '/train') {
      return html(page({
        title: 'Join the train on Quilcast',
        desc: 'This cast is a train. In Quilcast anyone can join it with one tap, which posts a quote of it with the same text from their own account as the next car.',
        path, image: `${SITE}/og-train.png`, embed: `${SITE}/embed-train.png`, type: 'website',
        alt: 'A Quilcast train: casts with the same text coupled like train cars, with the words "Join the train"',
        launch: { title: 'Join the train on Quilcast', url: `${SITE}/` },
      }))
    }
    // browsing as someone (src/browse.ts) shows their feed, not the signed-out one the home page draws
    if (path === '/') return url.searchParams.has('as') ? app() : homePage()
    const oldLegal = path.match(OLD_LEGAL)
    if (oldLegal) return res.writeHead(301, { location: `${SITE}/${oldLegal[1]}`, 'cache-control': 'public, max-age=86400' }).end()
    const file = normalize(join(DIST, PAGES[path] || (TRANSLATED.test(path) ? path.slice(1) + '.html' : path)))
    if (file.startsWith(DIST) && extname(file)) {
      const page = extname(file) === '.html'
      const read = page ? readFile(file).then((b) => Buffer.from(String(b).replace(LEGAL_LINK, `<style>${LEGAL_CSS}</style>`))) : readFile(file)
      const body = await (files.get(file) || keep(files, 300, file, read)).catch(() => null)
      if (!body) return res.writeHead(404).end()
      // no-transform on pages: Cloudflare leaves them as we sent them (no analytics beacon, which the CSP would block anyway)
      // /build.json names the build the pages load, so it has to change with them, never an hour late (verify.mjs)
      const cache = path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : page ? 'public, max-age=3600, no-transform' : path === '/build.json' ? 'no-cache' : 'public, max-age=3600'
      return serve(file, body, cache, file)
    }
    return app()
  } catch (e) {
    if (e.status === 503) return res.headersSent ? res.destroy() : res.writeHead(503).end()
    console.error(path, e)
    res.headersSent ? res.destroy() : app()
  }
}).listen(process.env.PORT || 3000)
