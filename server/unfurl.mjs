// GET /api/unfurl?url=…: Open Graph / mini app metadata for link previews, fetched through
// safeGet (public hosts only). The page is scanned tag by tag in one pass, so hostile HTML
// can't make the parser backtrack.
import { keep, safeGet, UA } from './net.mjs'

const cache = new Map()
const clip = (s, n) => (typeof s === 'string' ? s.slice(0, n) : undefined)
const httpUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u.slice(0, 2048) : undefined)

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
// `&amp;` before an entity counts as escaping it twice (GitHub's og:description does), so both layers come off
const decode = (s) =>
  s?.replace(/&(?:amp;)?(#x[0-9a-f]{1,6}|#\d{1,7}|amp|lt|gt|quot|apos);/gi, (m, e) => {
    if (e[0] !== '#') return ENT[e.toLowerCase()]
    const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m
  })
const attr = (tag, name) => tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'))?.slice(1).find((v) => v !== undefined)

/** meta tags, the icon link and the title from the page's head, in one linear pass */
export function scan(html) {
  const meta = Object.create(null)
  let icon, title
  for (let i = html.indexOf('<'); i !== -1; ) {
    const j = html.indexOf('>', i)
    if (j === -1) break
    const tag = html.slice(i, Math.min(j, i + 4000))
    const name = tag.slice(1, 6).toLowerCase()
    if (name.startsWith('meta')) {
      const key = (attr(tag, 'property') || attr(tag, 'name'))?.toLowerCase()
      const val = attr(tag, 'content')
      if (key && val !== undefined && !(key in meta)) meta[key] = decode(val)
    } else if (name.startsWith('link') && !icon && /\brel\s*=\s*["']?(?:shortcut\s+)?icon\b/i.test(tag)) icon = attr(tag, 'href')
    else if (name.startsWith('title') && title === undefined) {
      const end = html.indexOf('<', j)
      title = decode(html.slice(j + 1, end === -1 ? j + 1 : Math.min(end, j + 1000)).trim())
    } else if (name.startsWith('/head') || name.startsWith('body')) break
    i = html.indexOf('<', j)
  }
  return { meta, icon, title }
}

async function read(url) {
  const r = await safeGet(url, { max: 1.5e6, headers: { accept: 'text/html,*/*;q=0.5' } })
  if (r.type.startsWith('image/')) return { url: r.url, image: r.url }
  if (r.status !== 200 || !r.type.includes('html')) return null
  const { meta, icon, title } = scan(r.body.toString('utf8'))
  // Farcaster mini apps and frames carry a 3:2 image and a button label
  let app
  try {
    app = JSON.parse(meta['fc:miniapp'] || meta['fc:frame'] || 'null')
  } catch {}
  const abs = (u) => {
    try {
      return u ? httpUrl(new URL(u, r.url).href) : undefined
    } catch {}
  }
  // the button opens the app itself, at action.url or this page
  const act = app?.button?.action
  const launch = /^launch_(miniapp|frame)$/.test(act?.type) && {
    url: abs(act.url || r.url),
    name: clip(act.name, 60),
    splash: abs(act.splashImageUrl),
    bg: /^#[0-9a-f]{3,8}$/i.test(act.splashBackgroundColor) ? act.splashBackgroundColor : undefined,
  }
  return {
    url: r.url,
    title: clip(meta['og:title'] || meta['twitter:title'] || title, 300),
    description: clip(meta['og:description'] || meta['twitter:description'] || meta.description, 500),
    image: abs(app?.imageUrl || meta['og:image'] || meta['og:image:url'] || meta['twitter:image'] || meta['twitter:image:src']),
    button: clip(app?.button?.title, 40),
    icon: abs(icon || '/favicon.ico'),
    app: launch?.url ? launch : undefined,
  }
}

// X posts: fxtwitter's public API returns the post itself, which X's own pages don't give bots
async function tweet(url) {
  const m = url.match(/^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/(\w{1,15})\/status(?:es)?\/(\d{1,20})/i)
  if (!m) return
  const r = await fetch(`https://api.fxtwitter.com/${m[1]}/status/${m[2]}`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(5000) })
  const t = (await r.json()).tweet
  if (!t) return null
  return {
    url,
    tweet: {
      text: clip(t.text, 4000),
      author: { name: clip(t.author?.name, 100), handle: clip(t.author?.screen_name, 30), avatar: httpUrl(t.author?.avatar_url) },
      at: Number(t.created_timestamp) || undefined,
      photos: (t.media?.photos || []).map((p) => httpUrl(p.url)).filter(Boolean).slice(0, 4),
      video: httpUrl(t.media?.videos?.[0]?.thumbnail_url),
      likes: Number(t.likes) || 0, replies: Number(t.replies) || 0, reposts: Number(t.retweets) || 0,
      quote: t.quote && { name: clip(t.quote.author?.name, 100), handle: clip(t.quote.author?.screen_name, 30), text: clip(t.quote.text, 1000) },
    },
  }
}

export const cached = (url) => cache.has(url)
export const unfurl = (url) => cache.get(url) || keep(cache, 2000, url, tweet(url).then((t) => (t === undefined ? read(url) : t)).catch(() => null))
