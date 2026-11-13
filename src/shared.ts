// Pure helpers that the app and the server (which imports this file as TypeScript) both use.

export const isImg = (u: string) => /\.(png|jpe?g|gif|webp|avif)(\?|$)/i.test(u) || /imagedelivery\.net|i\.imgur\.com/.test(u)
// Hypersnap V20 (Aug 2026) raised the cap from 2 to 4 for every fid
export const MAX_EMBEDS = 4
/** How many more attachments a composer post takes: MAX_EMBEDS less the ones it has and its fixed embeds (the first
 *  post's quote and a mini app's links). The photo and GIF buttons are off at 0. */
export const embedRoom = (files: number, fixed: number) => Math.max(0, MAX_EMBEDS - files - fixed)
/** A post's attachments plus a picked GIF, which is Tenor's own URL (src/gifs.tsx, nothing is uploaded); the same
 *  attachments when the post has no room left. */
export const withGif = <F extends { url?: string }>(files: F[], fixed: number, gif: F) => (embedRoom(files.length, fixed) ? [...files, gif] : files)
/** A composer post's media embeds: the fixed ones, then its attachments (write.ts post adds the quote and links), less
 *  any the post's text already shows as a Markdown picture. */
export const postMedia = (fixed: string[], files: { url?: string }[], text = '') => [...fixed, ...files.map((f) => f.url!).filter((u) => !imagesIn(text).includes(safeUrl(u) ?? u))]
/** How many of a post's attachments go out as embeds, so how many slots its links don't get (the composer's link cards):
 *  the ones postMedia sends. Uploads are named by their content, so one the text also shows as a picture has the
 *  picture's URL and isn't sent. The room for attachments still counts them all (compose.tsx `room`). */
export const sentFiles = (files: { url?: string }[], text = '') => postMedia([], files, text).length
export const isVid = (u: string) => /\.(m3u8|mp4|webm|mov)(\?|$)/i.test(u)

/** How a cast's embeds sit (ui.tsx Embeds, server/home.mjs): its pictures (one tile, however many) and videos side by
 *  side in a scrolling strip when there are several; its `cards` (links, tweets, Spaces) full width, one under another,
 *  and compact when the cast has anything else to show (squeezed into a strip's tile they stretched and clipped, #257). */
export const embedLayout = (urls: string[], cards: number) => {
  const tiles = +urls.some(isImg) + urls.filter(isVid).length
  return { strip: tiles > 1, compact: cards > 0 && tiles + cards > 1 }
}

/** Farcaster's image CDN resizes on request (`w=96`, `anim=false,w=144`…), so nothing needs the full original. */
export const sized = (u: string, variant: string) => u.replace(/^(https:\/\/imagedelivery\.net\/[\w-]+\/[\w-]+)\/original$/, `$1/${variant}`)
/** A feed picture's widths for the browser to pick from by its box (a phone's 326 px box needn't load 1200 px); only for
 *  boxes that don't take their size from the picture (ui.tsx Media), as a srcset changes a picture's natural size. */
export const srcsetOf = (u: string) => (sized(u, 'w=600') === u ? undefined : `${sized(u, 'w=600')} 600w, ${sized(u, 'w=1200')} 1200w`)
/** Where another site's picture loads from: through our /api/img (server/index.mjs), so its host never sees who is
 *  looking (no tracking pixels: an avatar, a link preview or a mini app icon can't log readers' IP addresses).
 *  Ours, Farcaster's image CDN and Tenor's GIFs, and pictures already on this page's origin or inline, load as they are. */
const DIRECT = /^(?:https:\/\/(?:imagedelivery\.net|quilcast\.com|media1?\.tenor\.com)\/|\/(?![/\\])|data:|blob:)/i
export function proxied(u: string) {
  // tested as a browser reads it, without the tabs and line breaks it drops (/\t/evil.com is //evil.com)
  const bare = u.replace(/[\t\n\r]/g, '')
  return !u || DIRECT.test(bare) || (typeof location !== 'undefined' && bare.startsWith(`${location.origin}/`)) ? u : `/api/img?u=${encodeURIComponent(u)}`
}
/** The home page's first picture through quilcast.com itself (server/index.mjs /i/), so a phone gets it over the
 *  page's own connection instead of opening one to the CDN first. Always WebP (every browser shows it, and the CDN in
 *  front of us caches it by its extension). */
export const viaUs = (u: string) => u.replace(/https:\/\/imagedelivery\.net\/([\w-]+\/[\w-]+\/w=\d+)/g, '/i/$1.webp')
// the box's width: the column less the avatar rail and the cast's padding (not `auto`: Chrome loads the 1200 px
// picture when an image sized by layout is taken off the page)
export const IMG_SIZES = '(max-width: 600px) calc(100vw - 86px), 512px'
/** A lone picture's box, from its size (ui.tsx Media, server/home.mjs): its own shape, at most 510 px tall, and that
 *  size even before it loads, as the `.imgs` around it fits its content (without it the box starts 120 px wide). */
export const boxOf = (one?: [number, number] | null) =>
  one && one[0] > 0 && one[1] > 0 ? `width:min(100%,${one[0]}px,${Math.round((510 * one[0]) / one[1])}px);aspect-ratio:${one[0]}/${one[1]};contain:size;contain-intrinsic-size:${one[0]}px ${one[1]}px` : undefined

/** Farcaster's streams get a first-frame poster from our server (server/index.mjs /api/poster), in the video's shape. */
export const poster = (src?: string) => (src && /^https:\/\/stream\.farcaster\.xyz\//.test(src) ? `/api/poster?url=${encodeURIComponent(src)}` : undefined)
type Shape = [number, number] | null | undefined
const real = (s: Shape): s is [number, number] => !!s && s[0] > 0 && s[1] > 0 && Number.isFinite(s[0] / s[1])
/** A video's shape: its own once it has played, else its poster's (Hypersnap's embeds carry no size; the server reads
 *  the poster before the feed draws, or the app once it shows), else none, and the box stays 16:9. */
export const vidShape = (played: Shape, posterShape: Shape) => (real(played) ? played : real(posterShape) ? posterShape : null)
/** The played size, only while it's this video's: a Video handed another src must not keep the last one's shape. */
export const playedOf = (p: { src: string; size: [number, number] } | null, src: string) => (p?.src === src ? p.size : null)
/** A video's box in its shape (ui.tsx Video, server/home.mjs, style.css `.vid.shaped`): alone, at most 510 px tall like a
 *  lone picture (`--alone`, its width at that height); in a strip or a composer's preview, at most 300 px (`--tile`). No
 *  shape, no box: the 16:9 one. */
export const vidBoxOf = (s: Shape) =>
  real(s) ? `--ar:${s[0]}/${s[1]};--alone:${Math.round((510 * s[0]) / s[1])}px;--tile:${Math.round((300 * s[0]) / s[1])}px` : undefined

export const n = (x = 0) => (x >= 1e6 ? (x / 1e6).toFixed(1) + 'M' : x >= 1e4 ? Math.round(x / 1e3) + 'K' : x >= 1e3 ? (x / 1e3).toFixed(1) + 'K' : String(x))

type Mentioned = { text?: string; mentioned_profiles?: { username?: string }[]; mentioned_profiles_ranges?: { start: number; end: number }[] }
/** Ends a mention castText put back, where the text right after it could pass for more of the name: display (TOKENS)
 *  stops there, and html() drops it. */
export const MENTION_END = '⁠'
/** Hypersnap leaves mentions out of `text` and gives their UTF-8 byte offsets; put "@name" back in. For display, `ended`
 *  closes each one with MENTION_END when a letter, digit, "." or "-" follows, so a mention of adam followed by "-" links
 *  adam, not "adam-". */
export function castText(c: Mentioned, ended = false) {
  const bytes = new TextEncoder().encode(c.text || '')
  const at = (c.mentioned_profiles_ranges || [])
    .map((r, i) => ({ at: r.start, name: r.start === r.end && c.mentioned_profiles?.[i]?.username }))
    .filter((r) => r.name && r.at <= bytes.length)
    .sort((a, b) => a.at - b.at)
  if (!at.length) return c.text || ''
  const dec = new TextDecoder()
  let out = dec.decode(bytes.subarray(0, at[0].at))
  at.forEach((r, i) => {
    const rest = dec.decode(bytes.subarray(r.at, at[i + 1]?.at ?? bytes.length))
    out += '@' + r.name + (ended && /^[a-zA-Z0-9.-]/.test(rest) ? MENTION_END : '') + rest
  })
  return out
}

/** The `shown` set (oncePerFeed) a feed's load for key `k` uses, taken when the load starts. A first page starts a
 *  new one for `k`; a later page keeps it, or gets a throwaway one when the feed has moved to another key since, so
 *  a slow load for the key before never resets or fills the current key's set. */
export function shownFor(held: { k: string; set: Set<string> }, k: string, first: boolean) {
  if (first) return Object.assign(held, { k, set: new Set<string>() }).set
  return held.k === k ? held.set : new Set<string>()
}

type Unit = { hash: string; up?: { hash: string }[]; gap?: boolean }
/** Home's threads (app.tsx threads()) with every post shown once per feed: `shown` holds what earlier pages showed. A
 *  cast already up, or another reply to a parent already up, is left out; one whose root is already up shows
 *  without it, behind "Show full thread". */
export function oncePerFeed<T extends Unit>(units: (T | null)[], shown: Set<string>): T[] {
  const out: T[] = []
  for (let c of units) {
    if (!c || shown.has(c.hash) || (c.up && shown.has(c.up[c.up.length - 1].hash))) continue
    if (c.up && c.up.length > 1 && shown.has(c.up[0].hash)) c = { ...c, up: c.up.slice(1), gap: true }
    out.push(c)
    for (const p of [c, ...(c.up || [])]) shown.add(p.hash)
  }
  return out
}

type Dated = { hash: string; timestamp?: string; up?: { hash: string }[]; recaster?: { fid?: number } | null }
const timeOf = (c: { timestamp?: string }) => Date.parse(c.timestamp || '') || 0
/** What a feed's first page, read again, has that's newer than the list on screen (#640): the casts above the list's
 *  top ones that it doesn't show yet, or with `byTime` (Trending, whose order isn't by time) the ones posted after the
 *  newest it shows. `gap`: none of the list's top casts is on the page, so it can't tell what's between them (the list
 *  is empty, or there's more that's new than a page holds); then the page takes the list's place. */
export function newOnTop<T extends Dated>(have: Dated[], page: T[], byTime = false): { items: T[]; gap: boolean } {
  const known = new Set(have.flatMap((c) => [c.hash, ...(c.up || []).map((p) => p.hash)]))
  if (byTime) {
    const newest = Math.max(0, ...have.map(timeOf))
    return { items: page.filter((c) => !known.has(c.hash) && timeOf(c) > newest), gap: false }
  }
  // a few, in case the top one was deleted; a recast of something further down doesn't count, as it's shown already.
  // An entry is its cast and who recast it, so a fresh recast of one of the top casts isn't taken for that cast
  // itself, which would hide whatever's new below it
  const entry = (c: Dated) => `${c.hash}:${c.recaster?.fid ?? ''}`
  const top = new Set(have.slice(0, 5).map(entry))
  const i = page.findIndex((c) => top.has(entry(c)))
  return { items: (i < 0 ? page : page.slice(0, i)).filter((c) => !known.has(c.hash)), gap: i < 0 }
}

export const LOGO = 'M23.5 6.5c-6 .5-10.5 4.8-12 11.5l-1.6 7.5 1.4.4 2-5.2c4.6-.4 8.4-3.4 9.6-8.2-1.3.6-2.7.9-4 .9 1.9-1.2 3.6-3.6 4.6-6.9z'
export const X_LOGO = 'M17.75 3h3.07l-6.7 7.66L22 21h-6.17l-4.83-6.32L5.47 21H2.4l7.17-8.19L2 3h6.33l4.37 5.77zm-1.08 16.17h1.7L7.4 4.74H5.58z'

// --- profile looks (MySpace-style customization, src/looks.tsx and server/looks.mjs) ---
// A look is plain settings, never CSS or HTML: every value is checked here, by the server before it stores one
// and by the app again before it shows one, so a stored look can't carry anything a page would run or fetch
// beyond the images below.

export const FONTS = {
  system: 'ui-sans-serif, system-ui, sans-serif',
  verdana: 'Verdana, Tahoma, Geneva, sans-serif',
  arial: 'Arial, Helvetica, sans-serif',
  trebuchet: "'Trebuchet MS', 'Segoe UI', sans-serif",
  georgia: 'Georgia, Cambria, serif',
  times: "'Times New Roman', Times, serif",
  courier: "'Courier New', Courier, ui-monospace, monospace",
  comic: "'Comic Sans MS', 'Comic Neue', 'Chalkboard SE', 'Comic Sans', cursive",
  impact: "Impact, 'Arial Black', 'Franklin Gothic Bold', sans-serif",
  rounded: "ui-rounded, 'SF Pro Rounded', 'Arial Rounded MT Bold', system-ui, sans-serif",
  pixel: "'Lucida Console', Monaco, ui-monospace, monospace",
} as const
export const BG_MODES = ['tile', 'cover', 'center'] as const
export const BORDERS = ['solid', 'dashed', 'dotted', 'double', 'groove', 'ridge', 'none'] as const
export const NAME_FX = ['none', 'rainbow', 'glow', 'glitter', 'shadow', 'outline'] as const
export const SIZES = ['small', 'normal', 'large'] as const
// profile effects, drawn by src/fx.ts
export const FX = ['snow', 'flakes', 'rain', 'storm', 'leaves', 'sakura', 'confetti', 'hearts', 'bubbles', 'stars', 'glitter', 'fireflies', 'embers', 'bokeh',
  'meteors', 'fireworks', 'matrix', 'money', 'pizza', 'balloons', 'bats', 'ghosts', 'spooky', 'butterflies', 'notes', 'emoji', 'trail'] as const
export type Fx = (typeof FX)[number]
// the boxes a sticker can sit on; its place is a share of that box, so it lands on the same spot on any screen
export const STICKER_AT = ['head', 'song', 'amp', 'about', 'meet', 'int', 'top', 'wall'] as const
export type Sticker = { src: string; at: (typeof STICKER_AT)[number]; x: number; y: number; w: number; r?: number }
export const INTERESTS = { general: 'General', music: 'Music', movies: 'Movies', tv: 'Television', books: 'Books', heroes: 'Heroes' } as const

export type Look = {
  bg?: string; bgImg?: string; bgMode?: (typeof BG_MODES)[number]; bgDim?: number
  text?: string; muted?: string; link?: string
  box?: string; boxAlpha?: number; border?: string; borderStyle?: (typeof BORDERS)[number]; borderWidth?: number; radius?: number
  font?: keyof typeof FONTS; size?: (typeof SIZES)[number]
  nameFx?: (typeof NAME_FX)[number]; nameColor?: string
  banner?: string; mood?: string; moodEmoji?: string
  about?: string; meet?: string; interests?: Partial<Record<keyof typeof INTERESTS, string>>
  top?: number[]; topTitle?: string
  wall?: string[]; wallTitle?: string
  song?: { id: string; start?: number; title?: string }
  amp?: Amp
  fx?: Fx; fxAlpha?: number
  stickers?: Sticker[]
  marquee?: Marquee
}
export const LIMITS = { about: 1500, meet: 600, interest: 300, mood: 60, title: 40, top: 8, wall: 12, songTitle: 100, stickers: 16, amp: 50, marquee: 100 }

// the marquee (looks.tsx Marquee): one line of plain text that scrolls across the profile, old-web style. `dir` is
// where it scrolls to; its colors are optional
export const MARQUEE_SPEEDS = ['slow', 'normal', 'fast'] as const
export const MARQUEE_DIRS = ['left', 'right'] as const
export type Marquee = { text: string; speed?: (typeof MARQUEE_SPEEDS)[number]; dir?: (typeof MARQUEE_DIRS)[number]; color?: string; bg?: string }

// Winamp on the profile (src/amp.tsx): YouTube videos and playlists played as audio in a skin from the Winamp Skin
// Museum (skins.webamp.org, by the skin file's md5). `on` shows it; the list stays while it's off.
export type AmpItem = { id: string; pl?: 1; title?: string }
export type Amp = { on?: true; skin?: string; list: AmpItem[] }
/** A YouTube link (watch, youtu.be, shorts, embed, playlist) as a Winamp list item; a link with a playlist is the playlist. */
export function ampItem(s: string): AmpItem | undefined {
  const pl = s.match(/[?&]list=([\w-]{12,64})/)?.[1]
  if (pl) return { id: pl, pl: 1 }
  const id = (s.match(/(?:youtu\.be\/|[?&]v=|\/(?:embed|shorts|live)\/)([\w-]{11})/) || s.trim().match(/^([\w-]{11})$/))?.[1]
  return id ? { id } : undefined
}
const cleanAmp = (o: any): Amp | undefined => {
  if (!o || typeof o !== 'object' || !Array.isArray(o.list)) return
  const seen = new Set<string>()
  const list = o.list.flatMap((x: any): AmpItem[] => {
    const pl = x?.pl === 1
    if (typeof x?.id !== 'string' || !(pl ? /^[\w-]{12,64}$/ : /^[\w-]{11}$/).test(x.id) || seen.has(x.id)) return []
    seen.add(x.id)
    const title = text(x.title, LIMITS.songTitle)
    return [{ id: x.id, ...(pl ? { pl: 1 as const } : {}), ...(title ? { title } : {}) }]
  }).slice(0, LIMITS.amp)
  if (!list.length) return
  return { ...(o.on === true ? { on: true as const } : {}), ...(typeof o.skin === 'string' && /^[0-9a-f]{32}$/.test(o.skin) ? { skin: o.skin } : {}), list }
}

// images only from the GIF search (Tenor), Farcaster's image CDN, and our own uploads; nothing in these can break
// out of a CSS url("…")
export const isLookImg = (u: unknown): u is string =>
  typeof u === 'string' && u.length <= 300 &&
  /^https:\/\/(media1?\.tenor\.com\/[\w-]+(\/[\w-]+)*\/[\w-]+\.(gif|webp|png)|imagedelivery\.net\/[\w-]+\/[\w-]+\/[\w=,-]+|quilcast\.com\/m\/[0-9a-f]{24}\.(gif|png|jpg|webp))$/.test(u)

const color = (v: unknown) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : undefined)
const int = (v: unknown, lo: number, hi: number) => (Number.isInteger(v) ? Math.min(hi, Math.max(lo, v as number)) : undefined)
// a number in range, to a tenth
const num = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(hi, Math.max(lo, v)) * 10) / 10 : undefined)
const pick = <T extends readonly string[]>(v: unknown, list: T) => (list.includes(v as string) ? (v as T[number]) : undefined)
// text is shown as text; control characters (other than new lines) go, and so does anything past the limit
const text = (v: unknown, max: number) => {
  if (typeof v !== 'string') return
  const s = v.replace(/[\u0000-\u0009\u000b-\u001f\u007f‪-‮⁦-⁩]/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, max)
  return s || undefined
}

/** The valid part of a marquee: one line of plain text up to the limit in characters, a known speed and direction, and
 *  colors. Text with nothing to see (blank, or only invisible characters) is no marquee. */
export function cleanMarquee(o: any): Marquee | undefined {
  if (!o || typeof o !== 'object' || typeof o.text !== 'string') return
  // (cut short first, without leaving half an emoji at the cut)
  const raw = o.text.slice(0, 4e3).replace(/[\ud800-\udbff]$/, '').replace(/[\n\r\u2028\u2029]+/g, ' ')
  const s = [...(text(raw, 4e3) || '')].slice(0, LIMITS.marquee).join('').trim()
  if (!/[^\s\p{Cf}\p{Z}\u00ad\u034f\u115f\u1160\u2800\u3164\ufe00-\ufe0f\uffa0\u{e0100}-\u{e01ef}]/u.test(s)) return
  const m: Marquee = { text: s, speed: pick(o.speed, MARQUEE_SPEEDS), dir: pick(o.dir, MARQUEE_DIRS), color: color(o.color), bg: color(o.bg) }
  if (m.speed === 'normal') delete m.speed
  if (m.dir === 'left') delete m.dir
  for (const k of Object.keys(m) as (keyof Marquee)[]) if (m[k] === undefined) delete m[k]
  return m
}
/** How marquee `m` is drawn on look `l`: its text and background colors, and the seconds one pass takes (about the
 *  same speed for short and long text). Its colors follow the look's base like the rest of it: a background gets
 *  readable text, and text colored on a look without a base (one that follows the viewer's light or dark) brings the
 *  background it reads on, so it never vanishes into the viewer's page. Without colors it's the look's link color on
 *  its boxes (and that link color, when it's the look's only color, brings its background the same way). */
export function marqueeStyle(l: Look, m: Marquee) {
  let { color: ink, bg } = m
  if (bg && !ink) ink = readableOn(bg)
  const shown = ink || l.link
  if (shown && !bg && !lookBase(l)) bg = DEFAULTS[readableOn(shown) === '#ffffff' ? 'light' : 'dark'].card
  // one pass crosses the box and the text; a box is about 30em wide and a character about 0.6em
  const secs = Math.max(4, Math.round((30 + [...m.text].length * 0.6) / { slow: 3, normal: 5, fast: 9 }[m.speed || 'normal']))
  return { ink, bg, secs }
}

/** The valid part of a look; anything unknown or out of range is dropped. */
export function cleanLook(x: unknown): Look {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return {}
  const o = x as Record<string, any>
  const interests: Look['interests'] = {}
  if (o.interests && typeof o.interests === 'object') for (const k of Object.keys(INTERESTS) as (keyof typeof INTERESTS)[]) {
    const t = Object.hasOwn(o.interests, k) ? text(o.interests[k], LIMITS.interest) : undefined
    if (t) interests[k] = t
  }
  const song = o.song && typeof o.song === 'object' && typeof o.song.id === 'string' && /^[\w-]{11}$/.test(o.song.id)
    ? { id: o.song.id, start: int(o.song.start, 0, 36000) || undefined, title: text(o.song.title, LIMITS.songTitle) }
    : undefined
  const l: Look = {
    bg: color(o.bg), bgImg: isLookImg(o.bgImg) ? o.bgImg : undefined, bgMode: pick(o.bgMode, BG_MODES), bgDim: int(o.bgDim, 0, 80) || undefined,
    text: color(o.text), muted: color(o.muted), link: color(o.link),
    box: color(o.box), boxAlpha: int(o.boxAlpha, 0, 100), border: color(o.border), borderStyle: pick(o.borderStyle, BORDERS), borderWidth: int(o.borderWidth, 0, 8), radius: int(o.radius, 0, 32),
    font: Object.hasOwn(FONTS, o.font) ? o.font : undefined, size: pick(o.size, SIZES),
    nameFx: pick(o.nameFx, NAME_FX), nameColor: color(o.nameColor),
    banner: isLookImg(o.banner) ? o.banner : undefined, mood: text(o.mood, LIMITS.mood), moodEmoji: text(o.moodEmoji, 8),
    about: text(o.about, LIMITS.about), meet: text(o.meet, LIMITS.meet), interests: Object.keys(interests).length ? interests : undefined,
    top: Array.isArray(o.top) ? [...new Set(o.top.filter((f: unknown) => Number.isSafeInteger(f) && (f as number) > 0))].slice(0, LIMITS.top) as number[] : undefined,
    topTitle: text(o.topTitle, LIMITS.title),
    wall: Array.isArray(o.wall) ? [...new Set(o.wall.filter(isLookImg))].slice(0, LIMITS.wall) as string[] : undefined,
    wallTitle: text(o.wallTitle, LIMITS.title),
    song, amp: cleanAmp(o.amp), fx: pick(o.fx, FX), fxAlpha: int(o.fxAlpha, 0, 100),
    stickers: Array.isArray(o.stickers) ? o.stickers.flatMap((x: any): Sticker[] => {
      const [px, py, w, r] = [num(x?.x, 0, 100), num(x?.y, 0, 100), num(x?.w, 4, 80), num(x?.r, -180, 180)]
      if (!isLookImg(x?.src) || !STICKER_AT.includes(x.at) || px === undefined || py === undefined || w === undefined) return []
      return [{ src: x.src, at: x.at, x: px, y: py, w, ...(r ? { r } : {}) }]
    }).slice(0, LIMITS.stickers) : undefined,
    marquee: cleanMarquee(o.marquee),
  }
  if (!l.top?.length) delete l.top
  if (!l.stickers?.length) delete l.stickers
  if (!l.wall?.length) delete l.wall
  // an effect's opacity goes with the effect
  if (!l.fx) delete l.fxAlpha
  for (const k of Object.keys(l) as (keyof Look)[]) if (l[k] === undefined) delete l[k]
  if (l.song && !l.song.start) delete l.song.start
  if (l.song && !l.song.title) delete l.song.title
  return l
}

const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(' ')
/** White or near-black, whichever reads better on `bg` (WCAG relative luminance; they tie at about 0.19). */
export function readableOn(bg: string) {
  const [r, g, b] = rgb(bg).split(' ').map((v) => { const c = +v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.187 ? '#0b0b0f' : '#ffffff'
}

/** Light or dark: what a look's colors were picked against (its text, else its page or boxes). A look that sets none
 *  fits either, so it has none and follows the viewer's. */
export function lookBase(l: Look): 'light' | 'dark' | undefined {
  const c = l.text || l.bg || l.box
  if (!c) return
  const darkOn = readableOn(c) === '#ffffff'
  // light text wants a dark page; a dark page or box is a dark one
  return (l.text ? !darkOn : darkOn) ? 'dark' : 'light'
}
/** The page color behind a look: its own, else its base's, so light text never lands on a light viewer's white. */
export const lookPage = (l: Look) => l.bg || (lookBase(l) && DEFAULTS[lookBase(l)!].bg)

/** The look's colors and font as CSS variables on the profile's wrapper; the app's styles take them from there. A look
 *  with a base gets that base's colors for whatever it leaves out, whichever the viewer wears. */
export function lookVars(l: Look) {
  const v: Record<string, string> = {}
  const base = lookBase(l)
  if (base) {
    const d = DEFAULTS[base]
    Object.assign(v, { colorScheme: base, '--bg': d.bg, '--card': d.card, '--ink': d.ink, '--muted': d.muted, '--line': d.line, '--soft': d.soft, '--hover': `rgb(${rgb(d.ink)} / 0.04)`,
      '--accent': d.accent, '--accent-soft': `rgb(${rgb(d.accent)} / 0.16)`, '--on-accent': d.onAccent, '--like': d.like, '--recast': d.recast, '--warn': d.warn })
  }
  if (l.text) (v['--ink'] = l.text), (v['--soft'] = `rgb(${rgb(l.text)} / 0.08)`), (v['--hover'] = `rgb(${rgb(l.text)} / 0.04)`)
  if (l.muted) v['--muted'] = l.muted
  if (l.link) (v['--accent'] = l.link), (v['--accent-soft'] = `rgb(${rgb(l.link)} / 0.16)`)
  if (l.box) (v['--lk-box'] = `rgb(${rgb(l.box)} / ${(l.boxAlpha ?? 90) / 100})`), (v['--bg'] = l.box), (v['--card'] = l.box)
  // without a box color the boxes are the page's background color, as see-through as the owner says
  if (l.boxAlpha !== undefined) v['--lk-box-a'] = `${l.boxAlpha}%`
  if (l.fxAlpha !== undefined) v['--lk-fx-a'] = String(l.fxAlpha / 100)
  if (l.border) v['--line'] = l.border
  if (l.borderStyle) v['--lk-bs'] = l.borderStyle
  if (l.borderWidth !== undefined) v['--lk-bw'] = `${l.borderWidth}px`
  if (l.radius !== undefined) v['--lk-r'] = `${l.radius}px`
  if (l.nameColor) v['--lk-name'] = l.nameColor
  if (l.font) v.fontFamily = FONTS[l.font]
  if (l.size && l.size !== 'normal') v.fontSize = l.size === 'small' ? '13px' : '17px'
  return v
}

/** A look's design: its style and effect, without the words, friends, GIF wall, stickers and song. Shared as quilcast.com/design/<id>. */
export const DESIGN_KEYS = ['bg', 'bgImg', 'bgMode', 'bgDim', 'text', 'muted', 'link', 'box', 'boxAlpha', 'border', 'borderStyle', 'borderWidth', 'radius', 'font', 'size', 'nameFx', 'nameColor', 'banner', 'fx', 'fxAlpha'] as const
export const cleanDesign = (x: unknown): Look => {
  const l = cleanLook(x)
  return Object.fromEntries(DESIGN_KEYS.filter((k) => l[k] !== undefined).map((k) => [k, l[k]]))
}
/** A shared design's id, from its link or the bare id. */
export const designId = (s: string) => s.trim().match(/^(?:https?:\/\/[^/]+)?(?:\/design\/)?([\w-]{10})\/?$/)?.[1]

/** The images a look shows, for the server's size checks: [url, the most bytes it may have]. */
export const lookImages = (l: Look): [string, number][] => [
  ...(l.bgImg ? [[l.bgImg, 6e6] as [string, number]] : []),
  ...(l.banner ? [[l.banner, 4e6] as [string, number]] : []),
  ...(l.wall || []).map((u): [string, number] => [u, 4e6]),
  ...[...new Set((l.stickers || []).map((s) => s.src))].map((u): [string, number] => [u, 4e6]),
]

// --- app themes (src/themes.tsx, server/themes.mjs) ---
// A theme restyles the whole app for whoever wears it: colors, a background (a GIF works), bars and buttons, corners,
// borders, a font, the size of everything, name effects, a moving effect and stickers on the screen. Like a look it's
// plain settings checked here, never CSS. Quorum's skins (github.com/QuilibriumNetwork/quorum-mobile, theme/skins)
// convert into these on our server (server/themes.mjs) and back in the browser (themes.tsx toSkin).

export const THEME_COLORS = ['bg', 'card', 'ink', 'muted', 'line', 'soft', 'accent', 'onAccent', 'like', 'recast', 'warn', 'bar', 'nameColor'] as const
type ThemeColor = (typeof THEME_COLORS)[number]
/** Stickers on a theme sit on the screen: x and y are % of it, w is about a share of its width (capped on wide screens). */
export type ScreenSticker = Omit<Sticker, 'at'>
export type Theme = Partial<Record<ThemeColor, string>> & {
  name?: string; base?: 'light' | 'dark'
  // `sheer` is how solid the content (the column, sidebars, header) is over a picture or an effect, in %
  bgImg?: string; bgMode?: (typeof BG_MODES)[number]; scrim?: number; sheer?: number
  barImg?: string; btnImg?: string
  round?: number; borderWidth?: number; borderStyle?: (typeof BORDERS)[number]; glow?: boolean
  font?: keyof typeof FONTS; fontUrl?: string; size?: number
  nameFx?: (typeof NAME_FX)[number]; fx?: Fx; fxAlpha?: number
  stickers?: ScreenSticker[]
}
/** The app's own colors, for anything a theme leaves out (style.css :root has the same). */
export const DEFAULTS = {
  light: { bg: '#ffffff', card: '#ffffff', ink: '#0f1419', muted: '#64676f', line: '#e8e8ec', soft: '#f4f4f6', accent: '#6447f5', onAccent: '#ffffff', like: '#d41f57', recast: '#007f5f', warn: '#c2410c' },
  dark: { bg: '#0b0b0f', card: '#131319', ink: '#ececf1', muted: '#8b8b98', line: '#23232b', soft: '#1a1a21', accent: '#8f7bff', onAccent: '#0b0b0f', like: '#f9518e', recast: '#2fd08c', warn: '#fb923c' },
}
// a font a Quorum skin brought along, kept on our server
export const isThemeFont = (u: unknown): u is string => typeof u === 'string' && /^https:\/\/quilcast\.com\/m\/[0-9a-f]{24}\.(ttf|otf)$/.test(u)

/** The valid part of a theme; anything unknown or out of range is dropped. */
export function cleanTheme(x: unknown): Theme {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return {}
  const o = x as Record<string, any>
  const img = (v: unknown) => (isLookImg(v) ? v : undefined)
  const th: Theme = {
    name: text(o.name, 60)?.replace(/\n/g, ' '), base: pick(o.base, ['light', 'dark'] as const),
    ...Object.fromEntries(THEME_COLORS.map((k) => [k, color(o[k])])),
    bgImg: img(o.bgImg), bgMode: pick(o.bgMode, BG_MODES), scrim: int(o.scrim, 0, 90) || undefined, sheer: int(o.sheer, 0, 100),
    barImg: img(o.barImg), btnImg: img(o.btnImg),
    round: num(o.round, 0, 3), borderWidth: int(o.borderWidth, 0, 6), borderStyle: pick(o.borderStyle, BORDERS), glow: o.glow === true || undefined,
    font: Object.hasOwn(FONTS, o.font) ? o.font : undefined, fontUrl: isThemeFont(o.fontUrl) ? o.fontUrl : undefined, size: num(o.size, 0.8, 1.4),
    nameFx: pick(o.nameFx, NAME_FX), fx: pick(o.fx, FX), fxAlpha: int(o.fxAlpha, 0, 100),
    stickers: Array.isArray(o.stickers) ? o.stickers.flatMap((x: any): ScreenSticker[] => {
      const [px, py, w, r] = [num(x?.x, 0, 100), num(x?.y, 0, 100), num(x?.w, 4, 80), num(x?.r, -180, 180)]
      return isLookImg(x?.src) && px !== undefined && py !== undefined && w !== undefined ? [{ src: x.src, x: px, y: py, w, ...(r ? { r } : {}) }] : []
    }).slice(0, LIMITS.stickers) : undefined,
  }
  if (th.size === 1) delete th.size
  if (th.nameFx === 'none') delete th.nameFx
  if (!th.stickers?.length) delete th.stickers
  if (!th.fx) delete th.fxAlpha
  for (const k of Object.keys(th) as (keyof Theme)[]) if (th[k] === undefined) delete th[k]
  return th
}

/** Our own media as a same-origin path, so it loads wherever this copy runs (and fonts pass font-src 'self'). */
export const ownMedia = (u: string) => u.replace(/^https:\/\/quilcast\.com(?=\/m\/)/, '')

/** The theme as CSS variables, for the page (app.tsx) or one element (a theme's card); style.css takes them from there. */
export function themeVars(th: Theme) {
  const v: Record<string, string> = {}
  const set = (k: string, val?: string) => val !== undefined && (v[k] = val)
  set('--bg', th.bg), set('--card', th.card), set('--ink', th.ink), set('--muted', th.muted), set('--line', th.line), set('--soft', th.soft)
  set('--accent', th.accent), set('--on-accent', th.onAccent ?? (th.accent ? readableOn(th.accent) : undefined)), set('--like', th.like), set('--recast', th.recast), set('--warn', th.warn)
  set('--bar', th.bar), set('--lk-name', th.nameColor)
  if (th.ink) v['--hover'] = `rgb(${rgb(th.ink)} / 0.04)`
  if (th.accent) v['--accent-soft'] = `color-mix(in srgb, ${th.accent} 16%, ${th.bg || 'var(--bg)'})`
  if (th.bgImg) v['--th-img'] = `url("${ownMedia(th.bgImg)}")`
  if (th.barImg) v['--th-bar'] = `url("${ownMedia(th.barImg)}")`
  if (th.btnImg) v['--th-btn'] = `url("${ownMedia(th.btnImg)}")`
  // Quorum's scrim: white over a light theme's wallpaper, black over a dark one
  if (th.scrim) v['--th-scrim'] = `rgb(${th.base === 'light' ? '255 255 255' : '0 0 0'} / ${th.scrim / 100})`
  if (th.sheer !== undefined) v['--th-sheer'] = `${th.sheer}%`
  if (th.fxAlpha !== undefined) v['--th-fx-a'] = String(th.fxAlpha / 100)
  if (th.round !== undefined) v['--rs'] = String(th.round)
  if (th.borderWidth !== undefined) v['--bw'] = `${th.borderWidth}px`
  if (th.borderStyle) v['--bs'] = th.borderStyle
  if (th.fontUrl) v['--th-font'] = `'quilcast-theme', ${FONTS.system}`
  else if (th.font) v['--th-font'] = FONTS[th.font]
  if (th.size) v['--zoom'] = String(th.size)
  return v
}

// Holidays: their theme is worn, from `from` to `to` (MM-DD, both days in), by whoever wears no theme of their own,
// unless Settings turned it off (ui.tsx dressed). index.html's inline script has the same dates: keep them in step.
const tenor = (id: string, slug: string, sticker = false) => `https://media.tenor.com/${id}AAAA${sticker ? 'l' : 'x'}/${slug}.webp`
export const HOLIDAYS: { from: string; to: string; theme: Theme }[] = [
  {
    from: '10-24', to: '11-01', theme: {
      name: 'Halloween', base: 'dark', bg: '#0d0714', card: '#170d22', soft: '#22122f', line: '#3d1f52', ink: '#fff1e0', muted: '#c79a6b', accent: '#ff7a1a', onAccent: '#140a02', like: '#ff4d2e', recast: '#9be15d', warn: '#ffd23f',
      bgImg: tenor('LgYV36XUrfw', 'halloween-haunted-house'), bgMode: 'cover', scrim: 40, sheer: 84, round: 0.9, font: 'trebuchet', nameFx: 'glow', nameColor: '#ff9a3c', fx: 'spooky',
      stickers: [{ src: tenor('0UlFI1EDUoM', 'halloween-pumpkin', true), x: 7, y: 88, w: 16 }, { src: tenor('J7UIYXHZL5g', 'witch-witchcraft', true), x: 91, y: 84, w: 18, r: -8 }],
    },
  },
  {
    from: '12-18', to: '12-31', theme: {
      name: 'Christmas', base: 'dark', bg: '#120806', card: '#1d0e0b', soft: '#2a1410', line: '#5a1e18', ink: '#fff6e8', muted: '#d8b48a', accent: '#e8b64c', onAccent: '#1a0d05', like: '#ff4d4d', recast: '#4cc38a', warn: '#ffd23f',
      bgImg: tenor('5zlS7a5TKf8', 'deck-the-halls'), bgMode: 'cover', scrim: 45, sheer: 84, round: 1.3, font: 'georgia', nameFx: 'glow', nameColor: '#ffd77a', fx: 'flakes',
      stickers: [{ src: tenor('AapSUCEYnas', 'gingerbread-man-gingerbread-cookie', true), x: 7, y: 88, w: 13, r: -6 }, { src: tenor('eQiQsknXopw', 'christmas-tree-christmas', true), x: 93, y: 84, w: 14 }],
    },
  },
]
/** The holiday on `day`, if one is on. */
export const holidayOn = (day: Date) => {
  const md = `${day.getMonth() + 1}`.padStart(2, '0') + '-' + `${day.getDate()}`.padStart(2, '0')
  return HOLIDAYS.find((h) => h.from <= md && md <= h.to)?.theme
}

/** A shared theme's id, from its link or the bare id. */
export const themeId = (s: string) => s.trim().match(/^(?:https?:\/\/[^/]+)?(?:\/theme\/)?([\w-]{10})\/?$/)?.[1]

// --- mutes and blocks (src/mutes.ts keeps them, server/mutes.mjs stores them) ---
// `until` is when a mute ends (ms); none means it lasts until it's lifted
export type Timed<T> = { v: T; until?: number }
export type Mutes = { words: Timed<string>[]; users: Timed<number>[]; blocks: Timed<number>[] }
const live = (x: Timed<unknown>, now: number) => !x.until || x.until > now
// --- theme sync (src/prefs.ts, server/prefs.mjs) ---
/** A theme kept in the library (Settings → Theme → Mine); a shared one keeps its link id, a Quorum one its skin id. */
export type Saved = { theme: Theme; id?: string; quorum?: string }
export const LIBRARY_MAX = 40
/** The library's valid entries, the same theme once (the first one winning), at most LIBRARY_MAX. */
export function cleanLibrary(xs: unknown): Saved[] {
  const seen = new Set<string>()
  return (Array.isArray(xs) ? xs : []).flatMap((x: any): Saved[] => {
    const th = cleanTheme(x?.theme)
    const k = JSON.stringify(th)
    if (!Object.keys(th).length || seen.has(k)) return []
    seen.add(k)
    return [{ theme: th, ...(typeof x.id === 'string' && /^[\w-]{10}$/.test(x.id) && { id: x.id }), ...(typeof x.quorum === 'string' && /^[\w-]{1,64}$/.test(x.quorum) && { quorum: x.quorum }) }]
  }).slice(0, LIBRARY_MAX)
}
/** What Settings → Sync themes keeps with the account: the worn theme, the library, light or dark, holiday themes,
 *  Quorum mode, and when they last changed. */
export type Prefs = { theme: Theme | null; library: Saved[]; mode: 'system' | 'light' | 'dark'; holidays: boolean; quorum: boolean; at: number }
export function cleanPrefs(x: any): Prefs | null {
  if (!x || typeof x !== 'object' || !Number.isSafeInteger(x.at) || x.at < 0) return null
  const th = cleanTheme(x.theme)
  return { theme: Object.keys(th).length ? th : null, library: cleanLibrary(x.library), mode: pick(x.mode, ['system', 'light', 'dark'] as const) || 'system', holidays: x.holidays !== false, quorum: x.quorum === true, at: x.at }
}

// plural forms in each language's order (src/i18n.ts, and server/alerts.mjs's pushes); the translation holds them joined with "|"
// (a rule a language has but its forms don't, like French "many" for a million, takes the last form)
const two: Intl.LDMLPluralRule[] = ['one', 'other']
const slavic: Intl.LDMLPluralRule[] = ['one', 'few', 'many']
export const PLURALS = {
  en: two, ar: ['zero', 'one', 'two', 'few', 'many', 'other'], de: two, es: two, fr: two, hi: two, id: ['other'], it: two, ja: ['other'], ko: ['other'],
  nl: two, pl: slavic, 'pt-BR': two, 'pt-PT': two, ru: slavic, sv: two, th: ['other'], tr: two, uk: slavic, vi: ['other'], 'zh-Hans': ['other'], 'zh-Hant': ['other'],
} satisfies Record<string, Intl.LDMLPluralRule[]>
/** Mutes cut down to what's allowed and still running; the same word or person once, the later entry winning. */
export function cleanMutes(raw: any, now = Date.now()): Mutes {
  const list = <T,>(xs: unknown, ok: (v: any) => T | undefined, max: number) => {
    const out = new Map<T, Timed<T>>()
    for (const x of Array.isArray(xs) ? xs : []) {
      const v = ok(x?.v)
      const until = Number.isSafeInteger(x?.until) && x.until > 0 ? x.until : undefined
      if (v !== undefined && live({ v, until }, now)) out.set(v, until ? { v, until } : { v })
    }
    return [...out.values()].slice(-max)
  }
  const fid = (v: any) => (Number.isSafeInteger(v) && v > 0 ? v : undefined)
  const word = (v: any) => (typeof v === 'string' && (v = v.trim().toLowerCase().slice(0, 60)) ? v : undefined)
  return { words: list(raw?.words, word, 300), users: list(raw?.users, fid, 3000), blocks: list(raw?.blocks, fid, 3000) }
}
/** One pattern for all muted words: whole words, any case, so "$based" doesn't catch "$basedgod". Chinese and Japanese
 *  have no spaces between words, so words in those scripts match anywhere. */
export function wordsRe(words: string[]) {
  const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const cjk = (w: string) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(w)
  const whole = words.filter((w) => !cjk(w)).map(esc)
  const parts = [...(whole.length ? [`(?:^|[^\\p{L}\\p{N}_])(?:${whole.join('|')})(?![\\p{L}\\p{N}_])`] : []), ...words.filter(cjk).map(esc)]
  return parts.length ? new RegExp(parts.join('|'), 'iu') : null
}

// links as people write them: with a scheme, or a bare domain on a common TLD ("quilcast.com/x")
const TLDS = 'com|org|net|xyz|io|app|dev|ai|co|me|gg|so|sh|fm|tv|art|fun|lol|wtf|info|page|site|tech|link|to|us|uk|de|fr|eu|ca|ly|cc|club|blog|news|social|world|live|studio|games|finance|money|cash|network|systems|build|tools'
// A bare domain glued to a letter, mark or digit of another script isn't one: Cyrillic аpple.com would link only
// pple.com, google.coм only google.co, and apple.com.рф or google.co.ukм only apple.com or google.co, real sites the
// text doesn't name. Nor do invisible characters in between (а, a zero-width space, pple.com) unglue them. Scripts
// written without spaces between words (访问quilcast.com, quilcast.comで) still link, and so do domains next to
// emoji: a variation selector is an invisible mark and a keycap encloses an emoji (➡️quilcast.com, 1️⃣quilcast.com),
// though a letter it encloses is still glued (a⃣pple.com, a️⃣pple.com). Script_Extensions, not Script, so the
// characters those scripts share with others count too (サーバーquilcast.com: ー is Common, 〆, ｰ, Bopomofo ㄅ). Nor
// do the digits every script shares (①quilcast.comにアクセス, ２０２４quilcast.com), only a script's own (٣pple.com).
// A mark those scripts share (a tilde or dot below also listed for Thai, kana voicing marks) glues when the letter it
// sits on does: ãpple.com, españa.com and google.cõm written with a combining tilde, but not ガquilcast.com.
const SPACELESS = '\\p{scx=Han}\\p{scx=Hiragana}\\p{scx=Katakana}\\p{scx=Bopomofo}\\p{scx=Hangul}\\p{scx=Thai}\\p{scx=Lao}\\p{scx=Khmer}\\p{scx=Myanmar}'
const INVISIBLE = '\\p{Default_Ignorable_Code_Point}*'
const GLUED = `\\w|[^\\P{N}\\p{scx=Common}${SPACELESS}]|[^\\P{L}${SPACELESS}]`
// The checks on what a mark sits on run only once their mark has matched, not at every spot a match backs off to (a
// long run of invisible characters would make that quadratic). Inside a lookbehind, which matches right to left, that
// means writing them before the mark, so WORDY_BEHIND is the same set of characters for use in one.
const MARK = '[^\\P{M}\\p{Me}\\p{Default_Ignorable_Code_Point}]'
const ON_GLUED = `(?<=(?:${GLUED})[\\p{M}\\p{Default_Ignorable_Code_Point}]*)`
const ON_LETTER = `(?<=\\p{L}${INVISIBLE})`
const WORDY_START = `${GLUED}|[^\\P{M}\\p{Me}\\p{Default_Ignorable_Code_Point}${SPACELESS}]`
const WORDY = `${WORDY_START}|${MARK}${ON_GLUED}|\\p{Me}(?<=\\p{L}${INVISIBLE}\\p{Me})`
const WORDY_BEHIND = `${WORDY_START}|${ON_GLUED}${MARK}|${ON_LETTER}\\p{Me}`
// These regexps need the u flag for \p{…}, and with u the i flag folds ſ and the Kelvin sign K into s and k, so
// [a-z], \w and even [\x00-\x7f] would match them. So no i flag: letters are spelled out in both cases.
const anyCase = (s: string) => s.replace(/[a-z]/g, (c) => `[${c}${c.toUpperCase()}]`)
// In order, all at the start so each runs once per possible domain and the whole match stays linear: a domain char
// (the lookbehind scans back over invisible characters), nothing glued before it, and its run of domain chars, dots
// and invisible characters doesn't end in a glued letter (google.co.ukм). A check after the TLD would rescan that run
// on every label the match backs off. Then the domain itself, with nothing glued right after it.
const BARE = `(?=[a-zA-Z0-9-])(?<!(?:[@.\\/\\-]|${WORDY_BEHIND})${INVISIBLE})(?![\\p{Default_Ignorable_Code_Point}a-zA-Z0-9.-]*(?![\\x00-\\x7f])(?:${WORDY}))(?:[a-zA-Z0-9-]+\\.)+(?:${anyCase(TLDS)})(?!${INVISIBLE}(?:${WORDY}))`
export const LINK_RE = new RegExp(`${anyCase('http')}[sS]?:\\/\\/[^\\s<>"]+[^\\s<>".,;:!?)\\]'"]|${BARE}(?:\\/[^\\s<>"]*[^\\s<>".,;:!?)\\]'"])?`, 'gu')
export const toUrl = (s: string) => (/^https?:\/\//i.test(s) ? s : `https://${s}`)
/** A cast's links, shown as its pictures and cards. Some clients leave a link in the text without embedding it, so a
 *  cast with no embeds at all gets its first typed http(s) link instead. */
export const urlsOf = (c: { text?: string; embeds?: { url?: string }[] }) => {
  // less the pictures and [label](url) links the text already shows with Markdown (other clients still get them as embeds)
  const shown = new Set([...imagesIn(c.text || ''), ...linksIn(c.text || '')])
  const urls = c.embeds?.length ? c.embeds.flatMap((e) => safeUrl(e?.url) ?? []) : typed(c.text || '').filter((u) => /^https?:\/\//i.test(u)).slice(0, 1).flatMap((u) => safeUrl(u) ?? [])
  return urls.filter((u) => !shown.has(u))
}
/** A new cast's embeds (write.ts post), at most MAX_EMBEDS: its media and a quoted cast first, then links from its text,
 *  less the pictures the text shows with Markdown. Readers' Quilcast hides those (urlsOf), so they'd only take a slot. */
export const castEmbeds = <Q>(text: string, media: string[], quote?: Q) => {
  const out: (string | Q)[] = [...media, ...(quote ? [quote] : [])]
  for (const u of textLinks(text)) if (out.length < MAX_EMBEDS) out.push(u)
  return out.slice(0, MAX_EMBEDS)
}
/** The links typed in a text, as castEmbeds embeds them and the composer shows their cards: less the pictures the text
 *  shows with Markdown, compared as safeUrl puts them (imagesIn), so https://A.com and ![](https://a.com) are one. */
export const textLinks = (text: string) => {
  const shown = new Set(imagesIn(text))
  return [...new Set(typed(text).map(toUrl))].filter((u) => !shown.has(safeUrl(u) ?? u))
}
/** A Markdown picture, ![alt](url), as markdown() reads it (INLINE). */
const PICTURE = /!\[[^\]\n]*\]\(([^\s()]+)\)/g
/** A Markdown link, [label](url), as markdown() reads it (INLINE): its URL is already in the text, so it gets no card. */
const LINK = /(?<!!)\[[^\]\n]+\]\(([^\s()]+)\)/g
const linksIn = (text: string) => [...text.matchAll(LINK)].flatMap((m) => safeUrl(m[1]) ?? [])
/** The links typed in a text, less any that starts inside a Markdown picture's ![…](…) or link's […](…): that's its URL
 *  (or its alt text or label), even with words stuck to its ")" (`![](https://…/original)nice`, or Japanese, which has
 *  no spaces). */
const typed = (text: string) => {
  const pics = [...text.matchAll(PICTURE), ...text.matchAll(LINK)].map((m) => [m.index, m.index + m[0].length])
  return [...text.matchAll(LINK_RE)].filter((m) => !pics.some(([a, b]) => m.index >= a && m.index < b)).map((m) => m[0])
}
/** The composer's stand-in for a picture still uploading, ![…](uploading:…) (see format's `picture`). */
export const PICTURE_TOKEN = 'uploading:'
// every token handed out on this page, so a broken-up stand-in is known by its token alone, and text that merely reads
// like one ("uploading:complete") isn't
const tokens = new Set<string>()
/** A new stand-in's token: PICTURE_TOKEN and 8 letters or digits. */
export const pictureToken = () => {
  const token = PICTURE_TOKEN + Math.random().toString(36).slice(2, 10).padEnd(8, '0')
  tokens.add(token)
  return token
}
/** Whether a text still holds such a stand-in, even one the author broke up (its ![…]( gone, or its ] or ) deleted) or
 *  moved to another post while it uploaded: that text is never sent or saved as a draft, as the stand-in would go out
 *  as it's typed. */
export const holdsPicture = (text: string) => text.includes(`](${PICTURE_TOKEN}`) || [...tokens].some((t) => text.includes(t))
/** The pictures Markdown puts in a text, ![alt](url), as safe URLs. */
export const imagesIn = (text: string) => [...text.matchAll(PICTURE)].flatMap((m) => safeUrl(m[1]) ?? [])

// URLs from casts, profiles and link previews are untrusted: Snapchain only checks their length, so
// a "link" can be javascript:… or point at the viewer's own network. Only public http(s) gets through.
const LOCAL = /^(localhost|.*\.localhost|.*\.local|0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|\[)/i
export function safeUrl(u?: string | null) {
  if (typeof u !== 'string') return
  try {
    const x = new URL(u)
    if (/^https?:$/.test(x.protocol) && !x.username && !x.password && !LOCAL.test(x.hostname)) return x.href
  } catch {}
}

/** A link's host as written in Unicode, when it has any non-ASCII letters (an `xn--` label once parsed), else ''.
 *  Such a host can pass for another: Cyrillic аpple.com is not apple.com. Links out check this before opening
 *  (ui.tsx RichText, LinkCard, LinkSheet). Only the host counts: Unicode in the path or query (a Russian Wikipedia
 *  article) can't make a link pass for another site. */
export function lookalike(u: string) {
  let x: URL
  try {
    x = new URL(u)
  } catch {
    return ''
  }
  if (!/(^|\.)xn--/i.test(x.hostname)) return ''
  // a label that won't decode is shown as it is
  return x.hostname.split('.').map((l) => (/^xn--/i.test(l) && puny(l.slice(4))) || l).join('.')
}

// RFC 3492 Punycode decoding, '' when broken (browsers have no toUnicode; the URL parser has already checked the label)
const adapt = (delta: number, len: number, first: boolean) => {
  delta = first ? Math.floor(delta / 700) : delta >> 1
  delta += Math.floor(delta / len)
  let k = 0
  for (; delta > 455; k += 36) delta = Math.floor(delta / 35)
  return k + Math.floor((36 * delta) / (delta + 38))
}
function puny(s: string) {
  const d = s.lastIndexOf('-')
  const out = [...s.slice(0, Math.max(d, 0))].map((c) => c.charCodeAt(0))
  let n = 128, i = 0, bias = 72
  for (let p = d > 0 ? d + 1 : 0; p < s.length; ) {
    const old = i
    for (let w = 1, k = 36; ; k += 36) {
      const c = p < s.length ? s.charCodeAt(p++) : -1
      const digit = c >= 48 && c <= 57 ? c - 22 : c >= 65 && c <= 90 ? c - 65 : c >= 97 && c <= 122 ? c - 97 : 36
      if (digit > 35) return ''
      i += digit * w
      const t = k <= bias ? 1 : k >= bias + 26 ? 26 : k - bias
      if (digit < t) break
      w *= 36 - t
    }
    bias = adapt(i - old, out.length + 1, old === 0)
    n += Math.floor(i / (out.length + 1))
    if (n > 0x10ffff) return ''
    i %= out.length + 1
    out.splice(i++, 0, n)
  }
  const u = String.fromCodePoint(...out)
  // one that decodes to control characters is broken
  return /[\0-\x1f\x7f-\x9f]/.test(u) ? '' : u
}

// the app's icons (24×24 stroked paths), also drawn by the server's home page (server/home.mjs)
export const P = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-4.3-4.3',
  user: 'M20 21a8 8 0 0 0-16 0M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10z',
  reply: 'M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.8-.9L3 20l1.1-4.6A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4z',
  recast: 'M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3',
  quote: 'M7 7h4v4c0 3-1.5 4.5-4 5M15 7h4v4c0 3-1.5 4.5-4 5',
  like: 'M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z',
  // a gem: the Collect button (collect.quilcast.com)
  collect: 'M6 3h12l4 6-10 12L2 9zM2 9h20M11 3 8 9l4 12 4-12-3-6',
  share: 'M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7M16 6l-4-4-4 4M12 2v14',
  back: 'M19 12H5M12 19l-7-7 7-7',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  pen: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6',
  smile: 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01',
  markdown: 'M3 6h18v12H3zM6 15V9l3 3 3-3v6M17 9v6M14.5 12.5 17 15l2.5-2.5',
  article: 'M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h5',
  link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
  code: 'M16 18l6-6-6-6M8 6l-6 6 6 6',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  olist: 'M10 6h11M10 12h11M10 18h11M4 6h1v4M4 10h2M6 18H4c0-1 2-2 2-3s-1-1.5-2-1',
  gif: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM9.5 9h-2a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h2v-3h-1M12 9v6M17.5 9h-3v6M14.5 12h2.5',
  table: 'M4 5h16v14H4zM4 10h16M4 15h16M12 5v14',
  image: 'M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM3 16l5-5 5 5M14 14l2-2 5 5M15.5 8.5h.01',
  hash: 'M4 9h16M4 15h16M10 3 8 21M16 3l-2 18',
  x: 'M18 6 6 18M6 6l12 12',
  play: 'M7 4v16l13-8z',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  vmore: 'M12 5h.01M12 12h.01M12 19h.01',
  bell: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0',
  mail: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM3 7l9 6 9-6',
  plus: 'M12 5v14M5 12h14',
  check: 'M20 6 9 17l-5-5',
  min: 'M6 12h12',
  wallet: 'M19 7V5a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H5a2 2 0 0 1-2-2V6M16.5 13.5h.01',
  apps: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  mic: 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v3',
  micOff: 'M2 2l20 20M19 10v2a7 7 0 0 1-.1 1M5 10v2a7 7 0 0 0 12 5M15 9.3V5a3 3 0 0 0-5.7-1.3M9 9v3a3 3 0 0 0 5.1 2.1M12 19v3',
  mute: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0M3 3l18 18',
  flag: 'M4 22V4s1-1 4-1 5 2 8 2 4-1 4-1v11s-1 1-4 1-5-2-8-2-4 1-4 1',
  block: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM5.6 5.6l12.8 12.8',
  explore: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM16.2 7.8l-2.1 6.3-6.3 2.1 2.1-6.3z',
  refresh: 'M21 12a9 9 0 1 1-2.6-6.4L21 8M21 3v5h-5',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  expand: 'M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7',
  shrink: 'M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7',
  copy: 'M8 8h12v12H8zM4 16V4h12',
  chev: 'M9 6l6 6-6 6',
  swap: 'M7 4v13M3 13l4 4 4-4M17 20V7M21 11l-4-4-4 4',
  up: 'M12 19V5M5 12l7-7 7 7',
  down: 'M12 5v14M5 12l7 7 7-7',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  pin: 'M12 17v5M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2v.8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.8a2 2 0 0 0-1.1-1.8l-1.8-.9a2 2 0 0 1-1.1-1.8V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z',
}

/** A username after "@": a letter or digit, then letters, digits, "." and "-", which may end it (fnames like "adam-", ENS
 *  names like "bob.eth"). No Farcaster name has a "_" (join.tsx NAME_RE), so "@dwr_" is dwr. Compose's suggestions
 *  (compose.tsx), sending (fc.ts mentions) and display (TOKENS) all read names with it. */
export const MENTION_NAME = '[a-zA-Z0-9][a-zA-Z0-9.-]*'
/** The "@name" being typed up to the caret, which the composer's suggestions complete. */
export const TYPING_MENTION = new RegExp(`(?:^|\\s)@(${MENTION_NAME})$`)
/** The names "@name" in a cast can mean, longest first: punctuation right after a name ("@adam-." or "@adam--") comes off
 *  a character at a time. No name ends in ".", so "@alice." is "alice" and costs one lookup. After the whole name, only the
 *  first two marks of a longer run come off ("@adam-----" tries adam-----, adam--, adam- and adam), so a cast never waits
 *  on more than four lookups per mention. */
export function mentionTries(name: string) {
  // the whole name is what display links: without a sentence's "."
  let whole = name.length
  while (name[whole - 1] === '.') whole--
  let end = whole
  while ('.-'.includes(name[end - 1])) end--
  const out = whole > end + 2 ? [name.slice(0, whole)] : []
  for (name = name.slice(0, Math.min(whole, end + 2)); ; name = name.slice(0, -1)) {
    if (!name.endsWith('.')) out.push(name)
    if (name.length === end) return out
  }
}

/** A "#hashtag" as Hypersnap reads it (PR #59, search.rs hashtag_spans): a letter, then letters, digits and "_", not right
 *  after a letter, digit, "_", "/", "&" or "#" (so no "a#b", URL fragment, "&#39;" or "##"). */
export const HASHTAG = '(?<![\\p{Alphabetic}\\p{N}_/&#])#\\p{Alphabetic}[\\p{Alphabetic}\\p{N}_]*'
const TAG_CHAR = '[\\p{Alphabetic}\\p{N}_]'
/** The tags of a cast's text that Hypersnap indexes (search.rs hashtags), lowercased: the first 32 distinct ones of up to
 *  64 characters (counted lowercased), in text order. Only these are linked, so every tag a cast shows finds that cast. */
export function taggable(text: string) {
  const tags = new Set<string>()
  for (const [t] of text.matchAll(new RegExp(HASHTAG, 'gu'))) {
    const tag = t.toLowerCase()
    if ([...tag].length <= 65) tags.add(tag)
    if (tags.size === 32) break
  }
  return tags
}
/** Search's casts tab for a hashtag: the tag's casts, newest first (app.tsx Search). */
export const tagPath = (tag: string) => `/search?${new URLSearchParams({ q: tag.toLowerCase(), t: 'casts' })}`
/** Whether a search has a hashtag in it, so it lists the newest casts first instead of the best matches. */
export const hasTag = (q: string) => new RegExp(HASHTAG, 'u').test(q)

// links, @mentions, /channels and #hashtags inside cast text; a mention shows as the longest name it can be, without a sentence's ".".
// A tag is shown only whole and when it could be indexed (up to 64 characters), and gives way to a link that starts inside it,
// so "#base.org" and "#gm__https://x.com" keep their links as before tags were links.
const TAG_TOKEN = `(?<![\\p{Alphabetic}\\p{N}_/&#])#(?!${TAG_CHAR}{0,63}?(?=${TAG_CHAR})(?:${LINK_RE.source}))\\p{Alphabetic}${TAG_CHAR}{0,63}(?!${TAG_CHAR})`
export const TOKENS = new RegExp(`(${LINK_RE.source}|(?<![\\w/])@${MENTION_NAME}(?<!\\.)|(?<![\\w/:])\\/[a-zA-Z0-9-]{2,}(?![\\w/])|${TAG_TOKEN})`, 'gu')
/** A link's page as people read it (its decoded path), for the link card of a site that won't tell us its title. */
export const pathOf = (u: string) => {
  try {
    return decodeURIComponent(new URL(u).pathname).replace(/^\/+|\/+$/g, '')
  } catch {
    return ''
  }
}
export const shortUrl = (s: string) => ((s = s.replace(/^https?:\/\/(www\.)?/, '')), s.length > 40 ? s.slice(0, 40) + '…' : s)

// --- cast text as HTML (ui.tsx RichText, server/home.mjs) ---
const bare = (s: string) => s.replaceAll(MENTION_END, '')
const html = (s: string) => bare(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const ext = (u: string, label: string, cls = '') => `<a${cls && ` class="${cls}"`} href="${html(u)}" target="_blank" rel="noopener noreferrer nofollow">${label}</a>`
/** Plain text with its links, @mentions, /channels and #hashtags made live, as HTML. `tags` are the cast's tags that may
 *  be linked (taggable), when this is only a piece of it. */
export const linkify = (text: string, tags = taggable(text)) =>
  text.split(TOKENS).map((p, i) => {
    if (i % 2 === 0) return html(p)
    if (p[0] === '@') return `<a href="/u/${html(p.slice(1))}">${html(p)}</a>`
    if (p[0] === '/') return `<a class="chan-ref" href="/channel/${html(p.slice(1).toLowerCase())}">${html(p)}</a>`
    if (p[0] === '#') return tags.has(p.toLowerCase()) ? `<a class="tag-ref" href="${html(tagPath(p))}">${html(p)}</a>` : html(p)
    // a mention castText put back inside a link (another client's ranges) leaves the link as it was
    const u = safeUrl(toUrl(bare(p)))
    return u ? ext(u, html(shortUrl(p))) : html(p)
  }).join('')

// the leftmost of these wins; at one spot, the earlier one. Links and mentions come before emphasis so an
// underscore in a URL stays in it, and _ never emphasizes inside a word (snake_case, @some_x_handle).
const INLINE = new RegExp([
  /(?<tick>`+)(?<code>[^`]|[^`][\s\S]*?[^`])\k<tick>(?!`)/.source,
  /!\[(?<alt>[^\]\n]*)\]\((?<src>[^\s()]+)\)/.source,
  /\[(?<label>[^\]\n]+)\]\((?<href>[^\s()]+)\)/.source,
  `(?<token>${TOKENS.source})`,
  /\*\*(?=\S)(?<bold>[\s\S]*?\S)\*\*(?!\*)/.source,
  /(?<!\w)__(?=\S)(?<bold2>[\s\S]*?\S)__(?!\w)/.source,
  /~~(?=\S)(?<strike>[\s\S]*?\S)~~/.source,
  /\*(?=[^\s*])(?<em>[\s\S]*?[^\s*])\*/.source,
  /(?<!\w)_(?=[^\s_])(?<em2>[\s\S]*?[^\s_])_(?!\w)/.source,
].join('|'), 'gu')


// a "#" right after one of these is no hashtag to Hypersnap (HASHTAG's lookbehind), also across emphasis: "_#gm_" isn't one
const NOT_BEFORE_TAG = /[\p{Alphabetic}\p{N}_/&#]$/u
// and a tag runs on through these, also across emphasis: in "_x #gm_" Hypersnap's tag is "gm_", which "#gm" wouldn't find
const TAG_GOES_ON = /^[\p{Alphabetic}\p{N}_]/u

/** Inline Markdown as HTML. `tags` are the cast's tags that may be linked (taggable), or null to keep mentions, channels,
 *  tags and bare links as text, inside a [label](url) that is a link already. `before` and `after` are the source characters
 *  just before and after `s` (the delimiters of the emphasis around it). */
function inline(s: string, tags: Set<string> | null, before = '', after = '', re = INLINE): string {
  let out = ''
  let at = 0
  // matchAll works on a copy of INLINE, so the calls inside don't move this one along
  for (const m of s.matchAll(re)) {
    const g = m.groups!
    out += html(s.slice(at, m.index))
    at = m.index + m[0].length
    // code and LaTeX are literal in article Markdown: an escape there keeps its backslash (unhide)
    if (g.code !== undefined) out += `<code>${html(unhide(g.code.replace(/^ (.*[^ ].*) $/s, '$1'), re))}</code>`
    else if (g.src !== undefined) {
      const u = safeUrl(bare(unescaped(g.src, re)))
      out += u ? `<img class="md-img" src="${html(proxied(u))}" alt="${html(g.alt)}" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : html(g.alt)
    } else if (g.label !== undefined) {
      const u = safeUrl(bare(unescaped(g.href, re)))
      // its text can say anything, so the app shows where it really goes before opening it (ui.tsx LinkSheet)
      // a link can't hold another, so a label's tags and mentions stay text
      out += u ? ext(u, inline(g.label, null, '[', ']', re), 'md-link') : inline(g.label, tags, '[', ']', re)
    } else if (g.token !== undefined) {
      const notTag = g.token[0] === '#' && (NOT_BEFORE_TAG.test(m.index ? s.slice(Math.max(0, m.index - 2), m.index) : before) || TAG_GOES_ON.test(at < s.length ? s.slice(at, at + 2) : after))
      // an escape in a link is the character itself (its address mustn't carry the stand-in)
      const token = unescaped(g.token, re)
      out += tags && !notTag ? linkify(token, tags) : html(token)
    } else if (g.bold !== undefined) out += `<strong>${inline(g.bold, tags, '*', '*', re)}</strong>`
    else if (g.bold2 !== undefined) out += `<strong>${inline(g.bold2, tags, '_', '_', re)}</strong>`
    else if (g.strike !== undefined) out += `<s>${inline(g.strike, tags, '~', '~', re)}</s>`
    else if (g.under !== undefined) out += `<u>${inline(g.under, tags, '+', '+', re)}</u>`
    else if (g.math !== undefined) out += `<code class="md-math">${html(unhide(g.math, re))}</code>`
    else if (g.em !== undefined) out += `<em>${inline(g.em, tags, '*', '*', re)}</em>`
    else out += `<em>${inline(g.em2, tags, '_', '_', re)}</em>`
  }
  return out + html(s.slice(at))
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const QUOTE = /^ {0,3}> ?/
const ITEM = /^( {0,3})([-*+]|(\d{1,9})[.)])[ \t]+/
const ROW = /^\s*\|?(.*?)\|?\s*$/
const DIVIDER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/
const cells = (line: string) => line.replace(ROW, '$1').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'))
const isTable = (l: string, next = '') => l.includes('|') && next.includes('|') && DIVIDER.test(next) && cells(l).length === cells(next).length
const starts = (l: string, next?: string) => FENCE.test(l) || HEADING.test(l) || RULE.test(l) || QUOTE.test(l) || ITEM.test(l) || isTable(l, next)

/** Where format's `picture` puts a new picture for the selection [start, end): there, unless the selection takes in a
 *  picture still uploading (or is a caret inside one, or inside the token of one the author broke up), whose stand-in
 *  would be broken up in the new one's alt text and never found again (settlePicture). That selection is let go, and
 *  the picture goes in after it, with no alt text. */
export function pictureSpot(text: string, start: number, end: number): [number, number] {
  const ends = [...text.matchAll(new RegExp(`!\\[[^\\]\\n]*\\]\\(${PICTURE_TOKEN}[a-z0-9]+\\)|${PICTURE_TOKEN}[a-z0-9]+`, 'g'))]
    .map((m) => [m.index, m.index + m[0].length])
    .filter(([s, e]) => (start === end ? s < start && start < e : s < end && start < e))
    .map(([, e]) => e)
  if (!ends.length && !text.slice(start, end).includes(PICTURE_TOKEN)) return [start, end]
  const at = Math.max(end, ...ends)
  return [at, at]
}

export type Format = { mark: string } | { line: string } | { link: string } | { picture: string } | { table: string }
/** What the composer's Markdown buttons do to the text and its selection [start, end), returning both after: `mark`
 *  wraps the selection in "**", "*", "~~" or "`" (or unwraps it when it's wrapped already), `line` starts each line
 *  the selection touches with "## ", "- ", "1. " or "> " (or takes it off when they all have it), and `link` makes
 *  the selection, or the given word, a link with its URL selected to paste over. `picture` puts ![selection](src) on a
 *  line of its own, the selection as its alt text, with the caret after it, at its pictureSpot. `table` puts a two-column
 *  table on lines of its own, the selection (or the given word) heading its first column, which is selected. */
export function format(text: string, start: number, end: number, how: Format): [string, number, number] {
  if ('picture' in how) [start, end] = pictureSpot(text, start, end)
  const sel = text.slice(start, end)
  if ('mark' in how) {
    const m = how.mark
    const n = m.length
    if (text.slice(start - n, start) === m && text.slice(end, end + n) === m) return [text.slice(0, start - n) + sel + text.slice(end + n), start - n, end - n]
    if (sel.length >= 2 * n && sel.startsWith(m) && sel.endsWith(m)) return [text.slice(0, start) + sel.slice(n, -n) + text.slice(end), start, end - 2 * n]
    return [text.slice(0, start) + m + sel + m + text.slice(end), start + n, end + n]
  }
  if ('picture' in how) {
    const before = text.slice(0, start)
    const after = text.slice(end)
    const pic = `${before && !before.endsWith('\n') ? '\n' : ''}![${sel.replace(/[[\]\n]+/g, ' ').trim()}](${how.picture})${after && !after.startsWith('\n') ? '\n' : ''}`
    return [before + pic + after, start + pic.length, start + pic.length]
  }
  if ('table' in how) {
    const before = text.slice(0, start)
    const after = text.slice(end)
    const head = sel.replace(/[|\n]+/g, ' ').trim() || how.table
    const lead = before && !before.endsWith('\n') ? '\n' : ''
    const table = `${lead}| ${head} | ${how.table} |\n| --- | --- |\n|  |  |${after && !after.startsWith('\n') ? '\n' : ''}`
    const at = start + lead.length + 2
    return [before + table + after, at, at + head.length]
  }
  if ('link' in how) {
    const label = sel.trim() || how.link
    const at = start + label.length + 3
    return [`${text.slice(0, start)}[${label}](https://)${text.slice(end)}`, at, at + 8]
  }
  const from = text.lastIndexOf('\n', start - 1) + 1
  const stop = text.indexOf('\n', Math.max(end - (end > start && text[end - 1] === '\n' ? 1 : 0), start))
  const to = stop < 0 ? text.length : stop
  const lines = text.slice(from, to).split('\n')
  const ordered = how.line === '1. '
  const has = (l: string) => (ordered ? /^\d+[.)] / : new RegExp(`^${how.line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)).test(l)
  const off = lines.every(has)
  const next = lines.map((l, i) => (off ? l.replace(/^(#{1,6} |> |[-*+] |\d+[.)] )/, '') : (ordered ? `${i + 1}. ` : how.line) + l.replace(/^(#{1,6} |> |[-*+] |\d+[.)] )/, ''))).join('\n')
  return [text.slice(0, from) + next + text.slice(to), from, from + next.length]
}

/** The composer's picture `token` (see format's `picture`) once its upload is done: the uploaded `url` in its place, or
 *  with no url (it failed, or was taken out) the picture taken out again and its alt text left in its place: the `put`
 *  text format() put in, line breaks and all, back to the `alt` selection it was made from when that's still there
 *  whole, else the ![…](token) on its line down to the alt text it holds now. */
export const settlePicture = (text: string, token: string, url?: string, put = '', alt = '') => {
  const at = text.indexOf(`](${token})`)
  if (at < 0) {
    // the author broke its ![…](…) up while it uploaded: the token alone is still put right (the URL, or nothing), so it
    // never goes out as it's typed, nor holds the post back (holdsPicture) once nothing is uploading for it any more
    const bare = text.indexOf(token)
    return bare < 0 ? text : text.slice(0, bare) + (url || '') + text.slice(bare + token.length)
  }
  if (url) return text.slice(0, at + 2) + url + text.slice(at + 2 + token.length)
  if (put.includes(`](${token})`) && text.includes(put)) {
    const i = text.indexOf(put)
    const head = text.slice(0, i) + alt
    const tail = text.slice(i + put.length)
    // a picture put in right after this one shared its line break, which keeps it on a line of its own
    return head + (head && !head.endsWith('\n') && tail.startsWith('![') ? '\n' : '') + tail
  }
  const from = text.lastIndexOf('![', at)
  if (from > text.lastIndexOf('\n', at)) return text.slice(0, from) + text.slice(from + 2, at) + text.slice(at + token.length + 3)
  return text.slice(0, at) + text.slice(at + token.length + 3)
}

/** At most `n` jobs at a time; the rest wait their turn, in order, each starting once one before it is done or failed. */
export function queue(n: number) {
  let busy = 0
  const waiting: (() => void)[] = []
  return async <T>(job: () => Promise<T>): Promise<T> => {
    if (busy >= n) await new Promise<void>((go) => waiting.push(go))
    else busy++
    try {
      return await job()
    } finally {
      // the slot passes straight to the next one waiting, so nothing new can take it in between
      const next = waiting.shift()
      if (next) next()
      else busy--
    }
  }
}

/** Where a caret or selection [start, end) in `was` is in `now`, after an edit somewhere else in it (an upload done): by
 *  the text after it, or else by the text before it, or else at the end. */
export function remap(was: string, start: number, end: number, now: string): [number, number] {
  if (was === now) return [start, end]
  const sel = was.slice(start, end)
  const tail = sel + was.slice(end)
  if (now.endsWith(tail)) return [now.length - tail.length, now.length - was.length + end]
  if (now.startsWith(was.slice(0, end))) return [start, end]
  return [now.length, now.length]
}

/** How a character of styled() text looked, as bits: strong, em, code, a link (or mention, or channel), a heading's,
 *  a quote's, struck through, and a table cell's alignment. */
export const MD = { bold: 1, italic: 2, code: 4, link: 8, heading: 16, quote: 32, strike: 64, right: 128, center: 256 }
const BITS: Record<string, number> = { strong: MD.bold, em: MD.italic, code: MD.code, a: MD.link, span: MD.link, blockquote: MD.quote, s: MD.strike, h1: MD.heading, h2: MD.heading, h3: MD.heading, h4: MD.heading, h5: MD.heading, h6: MD.heading }
/** What ends each cell of a table row in styled() text: the cards draw the row as columns, meta tags as "a · b". */
export const CELL = '\x1f'
/** Cast text as it reads, without its Markdown (unmarkdown), with how each UTF-16 unit of it looked (MD bits), for
 *  share cards: what markdown() draws, flattened (lists keep their bullets and numbers, a link shows its label). */
export function styled(text: string): { text: string; marks: number[] } {
  const lists: number[] = [] // per open list, the next number, or 0 for bullets
  const open: number[] = [] // the bits of the open tags that have one
  let out = ''
  const marks: number[] = []
  const put = (str: string) => {
    const on = open.reduce((a, b) => a | b, 0)
    // never more than one blank line in a row
    for (const ch of str) if (ch !== '\n' || !out.endsWith('\n\n')) (out += ch), marks.push(...Array(ch.length).fill(on))
  }
  for (const [all, close, tag, start, ent] of markdown(text).matchAll(/<(\/?)(\w+)[^>]*?(?: start="(\d+)")?>|&#(\d+);|[^<&]+/g)) {
    if (ent) put(String.fromCharCode(+ent))
    // (the cell separator never comes from the text itself)
    else if (!tag) put(all.replaceAll(CELL, ''))
    else if (tag === 'ul' || tag === 'ol') close ? (lists.pop(), put('\n')) : lists.push(tag === 'ol' ? +(start || 1) : 0)
    else if (tag === 'li') !close && put(`\n${'  '.repeat(lists.length - 1)}${lists.at(-1) ? `${lists[lists.length - 1]++}. ` : '• '}`)
    // a header cell is bold; a cell keeps its column's alignment
    else if (tag === 'td' || tag === 'th') close ? (open.pop(), put(CELL)) : open.push((tag === 'th' ? MD.bold : 0) | (all.includes('md-right') ? MD.right : all.includes('md-center') ? MD.center : 0))
    // a row's last cell drops its separator
    else if (tag === 'tr') close && (out.endsWith(CELL) && ((out = out.slice(0, -1)), marks.length--), put('\n'))
    else {
      if (/^(h\d|blockquote|pre|hr|table)$/.test(tag)) put('\n')
      if (BITS[tag]) close ? open.pop() : open.push(BITS[tag])
    }
  }
  const lead = out.length - out.trimStart().length
  const kept = out.trim().length
  return { text: out.slice(lead, lead + kept), marks: marks.slice(lead, lead + kept) }
}
/** Cast text as it reads, without its Markdown, for meta tags (see styled). */
export const unmarkdown = (text: string) => styled(text).text.replaceAll(CELL, ' · ')

/** Cast text as HTML, with Markdown: headings, **bold**, *italic*, ~~strike~~, `code` and fenced blocks, [links](…), ![pictures](…),
 *  lists, > quotes, rules and tables. Text between those keeps its line breaks as typed (.text is pre-wrap), so a cast
 *  without Markdown looks exactly as before. People's own HTML is shown as text, and links go through safeUrl. */
export function markdown(text: string, tags = taggable(text)): string {
  const lines = text.split('\n')
  let out = ''
  let para: string[] = []
  const flush = () => {
    const p = para.join('\n').replace(/^\n+|\n+$/g, '')
    para = []
    // a paragraph between blocks drops the blank lines around it: the blocks have margins. So does a picture, which is
    // a block too: the line break on each side of it would draw an empty line under pre-wrap
    out += inline(p, tags).replace(/\n?(<img class="md-img"[^>]*>)\n?/g, '$1')
  }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    let m
    // as in CommonMark, only a list from 1 breaks into a paragraph: "born in\n1990. Then…" stays text
    const num = l.match(ITEM)?.[3]
    if (!starts(l, lines[i + 1]) || (num !== undefined && +num !== 1 && para.length && para[para.length - 1].trim())) {
      para.push(l)
      continue
    }
    flush()
    if ((m = l.match(FENCE))) {
      const end = lines.findIndex((x, j) => j > i && x.trim().startsWith(m![1]) && !x.trim().slice(m![1].length).trim())
      const stop = end < 0 ? lines.length : end
      out += `<pre><code>${html(lines.slice(i + 1, stop).join('\n'))}</code></pre>`
      i = stop
    } else if ((m = l.match(HEADING))) out += `<h${m[1].length}>${inline(m[2], tags)}</h${m[1].length}>`
    else if (RULE.test(l)) out += '<hr>'
    else if (QUOTE.test(l)) {
      const q = []
      while (i < lines.length && QUOTE.test(lines[i])) q.push(lines[i++].replace(QUOTE, ''))
      i--
      out += `<blockquote>${markdown(q.join('\n'), tags)}</blockquote>`
    } else if ((m = l.match(ITEM))) {
      const ordered = m[3] !== undefined
      const items: string[][] = []
      // an item runs on over the indented lines under it (a nested list, say); an unindented line ends the list
      const under = new RegExp(`^ {0,${m[0].length}}`)
      for (; i < lines.length; i++) {
        const x = lines[i]
        const it = x.match(ITEM)
        if (it && it[1].length <= m[1].length && (it[3] !== undefined) === ordered) items.push([x.slice(it[0].length)])
        else if (/^\s{2,}\S/.test(x)) items[items.length - 1].push(x.replace(under, ''))
        else break
      }
      i--
      const tag = ordered ? 'ol' : 'ul'
      const start = ordered && +m[3] !== 1 ? ` start="${+m[3]}"` : ''
      out += `<${tag}${start}>${items.map((it) => `<li>${markdown(it.join('\n'), tags)}</li>`).join('')}</${tag}>`
    } else {
      const head = cells(l)
      const align = cells(lines[i + 1]).map((c) => (c.endsWith(':') ? (c.startsWith(':') ? 'center' : 'right') : ''))
      const row = (cs: string[], tag: string) => `<tr>${head.map((_, k) => `<${tag}${align[k] ? ` class="md-${align[k]}"` : ''}>${inline(cs[k] || '', tags)}</${tag}>`).join('')}</tr>`
      out += `<table><thead>${row(head, 'th')}</thead><tbody>`
      for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) out += row(cells(lines[i]), 'td')
      i--
      out += '</tbody></table>'
    }
  }
  flush()
  return out
}

// article Markdown's inline styles add ++underline++ and $$LaTeX$$ (shown as its source: there's no TeX here)
const ARTICLE_INLINE = new RegExp([/\$\$(?<math>[^\n]+?)\$\$/.source, INLINE.source, /\+\+(?=\S)(?<under>[\s\S]*?\S)\+\+(?!\+)/.source].join('|'), 'gu')
// what a backslash escapes in article Markdown, each hidden as a private-use character while the line is parsed
const ESCAPED = '\\*_~+[]'
const hideEscapes = (s: string) => s.replace(/\\([\\*_~+[\]])/g, (_, c: string) => String.fromCharCode(0xe000 + ESCAPED.indexOf(c)))
const unescaped = (s: string, re: RegExp) => (re === ARTICLE_INLINE ? s.replace(/[\ue000-\ue006]/g, (c) => ESCAPED[c.charCodeAt(0) - 0xe000]) : s)
const unhide = (s: string, re: RegExp) => (re === ARTICLE_INLINE ? s.replace(/[\ue000-\ue006]/g, (c) => '\\' + ESCAPED[c.charCodeAt(0) - 0xe000]) : s)
const showEscapes = (s: string) => s.replace(/[-]/g, (c) => `&#${ESCAPED.charCodeAt(c.charCodeAt(0) - 0xe000)};`)
const ARTICLE_ITEM = /^((?: {2})*)(?:(-)|\d{1,9}\.) /
const ARTICLE_DIVIDER = /^\|(?:\s*:?-+:?\s*\|)+\s*$/
/** A table row's cells: plain text, where \| \\ and \- are escapes. */
const articleCells = (l: string) => {
  const out: string[] = []
  let cur = ''
  const s = l.trim().replace(/^\|/, '')
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && '|\\-'.includes(s[i + 1] ?? 'x')) cur += s[++i]
    else if (s[i] === '|') out.push(cur.trim()), (cur = '')
    else cur += s[i]
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

/** Article Markdown (format_version 1, FIP "Cast Format and Chained Casts" section 6) as HTML: a block per line,
 *  # and ## headings (h2 and h3, under the article's title), > quotes, - and numbered lists (two spaces of indent a
 *  level, numbered by the reader), --- dividers, ``` code blocks, $$ LaTeX (as its source), |tables|, and **bold**,
 *  _italic_, ~~strike~~, ++underline++ and [links](…) inside lines. A line ending in an odd number of backslashes goes
 *  on to the next one, a backslash escapes \ * _ ~ + [ ] (and at the start of a line, the block syntax), an empty line
 *  is an empty paragraph. HTML shows as text and links go through safeUrl, as in markdown(). The text's mentions are
 *  already put back (castText). With `preview` (an article's opening in the feed), headings are styled paragraphs. Link previews and [$N] embeds are split off first (article.ts segments). */
export function articleHtml(text: string, tags = taggable(text), preview = false): string {
  // the private-use characters hideEscapes uses can't come from the text itself
  const lines = text.replace(/[-]/g, '�').split('\n')
  // Farcaster's editor can leave a space inside a closing ** ("**Embedded casts **"), which still reads as bold there
  const tidy = (s: string) => s.replace(/\*\*(?=\S)([^*\n]*?\S)([ \t]+)\*\*(?!\*)/g, '**$1**$2')
  const line = (s: string) => showEscapes(inline(tidy(hideEscapes(s)), tags, '', '', ARTICLE_INLINE)).replace(/\n/g, '<br>')
  let out = ''
  const lists: boolean[] = [] // the open lists, true for numbered ones
  let quote = false
  const closeLists = (depth = 0) => {
    while (lists.length > depth) out += `</li></${lists.pop() ? 'ol' : 'ul'}>`
  }
  const endQuote = () => quote && ((out += '</blockquote>'), (quote = false))
  for (let i = 0; i < lines.length; i++) {
    let l = lines[i]
    const fence = l.match(/^(`{3,})[^`]*$/)?.[1] || (l === '$$' ? '$$' : '')
    if (fence) {
      closeLists(), endQuote()
      const end = lines.findIndex((x, j) => j > i && x === fence)
      const stop = end < 0 ? lines.length : end
      out += `<pre${fence === '$$' ? ' class="md-math"' : ''}><code>${html(lines.slice(i + 1, stop).join('\n'))}</code></pre>`
      i = stop
      continue
    }
    if (l.startsWith('|') && ARTICLE_DIVIDER.test(lines[i + 1] || '')) {
      closeLists(), endQuote()
      const head = articleCells(l)
      const row = (cs: string[], tag: string) => `<tr>${head.map((_, k) => `<${tag}>${linkify(cs[k] || '', tags)}</${tag}>`).join('')}</tr>`
      out += `<table><thead>${row(head, 'th')}</thead><tbody>`
      for (i += 2; i < lines.length && lines[i].startsWith('|'); i++) out += row(articleCells(lines[i]), 'td')
      i--
      out += '</tbody></table>'
      continue
    }
    // the lines a backslash carries on to are this block's
    while ((l.match(/\\+$/)?.[0].length || 0) % 2 === 1) {
      l = l.slice(0, -1)
      if (i + 1 >= lines.length) break
      l += '\n' + lines[++i]
    }
    // a backslash first: no block syntax (and it goes, unless it escapes what follows)
    if (l[0] === '\\') {
      closeLists(), endQuote()
      out += `<p>${line(ESCAPED.includes(l[1] ?? 'x') ? l : l.slice(1))}</p>`
      continue
    }
    const item = l.match(ARTICLE_ITEM)
    if (item) {
      endQuote()
      const ordered = !item[2]
      // a level deeper than the next one in comes in at that next one
      const depth = Math.min(item[1].length / 2, lists.length)
      closeLists(depth + 1)
      if (lists.length === depth + 1 && lists[depth] !== ordered) closeLists(depth)
      if (lists.length === depth + 1) out += '</li><li>'
      else out += `<${ordered ? 'ol' : 'ul'}><li>`, lists.push(ordered)
      out += line(l.slice(item[0].length))
      continue
    }
    closeLists()
    const q = l.match(/^>(?: |$)/)
    if (q) {
      if (!quote) (out += '<blockquote>'), (quote = true)
      out += `<p>${line(l.slice(q[0].length))}</p>`
      continue
    }
    endQuote()
    const h = l.match(/^(#{1,2}) (.*)$/s)
    // a preview in the feed has no title above it, so its headings are styled lines, not a heading level that skips one
    if (h && preview) out += `<p class="md-head md-h${h[1].length + 1}">${line(h[2])}</p>`
    else if (h) out += `<h${h[1].length + 1}>${line(h[2])}</h${h[1].length + 1}>`
    else if (l.trim() === '---') out += '<hr>'
    else if (/^\$\$.+\$\$$/.test(l)) out += `<pre class="md-math"><code>${html(l.slice(2, -2))}</code></pre>`
    else out += l ? `<p>${line(l)}</p>` : '<p class="md-gap"></p>'
  }
  closeLists(), endQuote()
  return out
}

/** The cast hash in one of our own /c/<hash> paths. */
export const castOf = (path: string) => path.match(/^\/c\/(?:0x)?([0-9a-f]{40})$/i)?.[1].toLowerCase()

/** The room id in a farcaster.xyz Space link. */
export const spaceOf = (u: string) => u.match(/^https?:\/\/(?:www\.)?(?:warpcast\.com|farcaster\.xyz)\/~\/spaces\/([\w-]{1,64})\/?(?:[?#].*)?$/)?.[1]
