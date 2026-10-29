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
/** A composer post's media embeds: the fixed ones, then its attachments (write.ts post adds the quote and links). */
export const postMedia = (fixed: string[], files: { url?: string }[]) => [...fixed, ...files.map((f) => f.url!)]
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
/** Hypersnap leaves mentions out of `text` and gives their UTF-8 byte offsets; put "@name" back in. */
export function castText(c: Mentioned) {
  const bytes = new TextEncoder().encode(c.text || '')
  const at = (c.mentioned_profiles_ranges || [])
    .map((r, i) => ({ at: r.start, name: r.start === r.end && c.mentioned_profiles?.[i]?.username }))
    .filter((r) => r.name && r.at <= bytes.length)
    .sort((a, b) => a.at - b.at)
  if (!at.length) return c.text || ''
  const dec = new TextDecoder()
  let out = ''
  let last = 0
  for (const r of at) (out += dec.decode(bytes.subarray(last, r.at)) + '@' + r.name), (last = r.at)
  return out + dec.decode(bytes.subarray(last))
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
}
export const LIMITS = { about: 1500, meet: 600, interest: 300, mood: 60, title: 40, top: 8, wall: 12, songTitle: 100, stickers: 16, amp: 50 }

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

/** The look's colors and font as CSS variables on the profile's wrapper; the app's styles take them from there. */
export function lookVars(l: Look) {
  const v: Record<string, string> = {}
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
/** A shared theme's id, from its link or the bare id. */
export const themeId = (s: string) => s.trim().match(/^(?:https?:\/\/[^/]+)?(?:\/theme\/)?([\w-]{10})\/?$/)?.[1]

// --- mutes and blocks (src/mutes.ts keeps them, server/mutes.mjs stores them) ---
// `until` is when a mute ends (ms); none means it lasts until it's lifted
export type Timed<T> = { v: T; until?: number }
export type Mutes = { words: Timed<string>[]; users: Timed<number>[]; blocks: Timed<number>[] }
const live = (x: Timed<unknown>, now: number) => !x.until || x.until > now
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
export const LINK_RE = new RegExp(`https?:\\/\\/[^\\s<>"]+[^\\s<>".,;:!?)\\]'"]|(?<![@\\w.\\/-])(?:[a-z0-9-]+\\.)+(?:${TLDS})\\b(?:\\/[^\\s<>"]*[^\\s<>".,;:!?)\\]'"])?`, 'gi')
export const toUrl = (s: string) => (/^https?:\/\//i.test(s) ? s : `https://${s}`)

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

// the app's icons (24×24 stroked paths), also drawn by the server's home page (server/home.mjs)
export const P = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-4.3-4.3',
  user: 'M20 21a8 8 0 0 0-16 0M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10z',
  reply: 'M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.8-.9L3 20l1.1-4.6A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4z',
  recast: 'M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3',
  quote: 'M7 7h4v4c0 3-1.5 4.5-4 5M15 7h4v4c0 3-1.5 4.5-4 5',
  like: 'M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z',
  share: 'M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7M16 6l-4-4-4 4M12 2v14',
  back: 'M19 12H5M12 19l-7-7 7-7',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  pen: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6',
  gif: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM9.5 9h-2a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h2v-3h-1M12 9v6M17.5 9h-3v6M14.5 12h2.5',
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
  copy: 'M8 8h12v12H8zM4 16V4h12',
  chev: 'M9 6l6 6-6 6',
  swap: 'M7 4v13M3 13l4 4 4-4M17 20V7M21 11l-4-4-4 4',
  up: 'M12 19V5M5 12l7-7 7 7',
  down: 'M12 5v14M5 12l7 7 7-7',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  pin: 'M12 17v5M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2v.8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.8a2 2 0 0 0-1.1-1.8l-1.8-.9a2 2 0 0 1-1.1-1.8V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z',
}

// links, @mentions and /channels inside cast text
export const TOKENS = new RegExp(`(${LINK_RE.source}|(?<![\\w/])@[a-z0-9][a-z0-9.-]*[a-z0-9]|(?<![\\w/:])\\/[a-z0-9-]{2,}(?![\\w/]))`, 'gi')
export const shortUrl = (s: string) => ((s = s.replace(/^https?:\/\/(www\.)?/, '')), s.length > 40 ? s.slice(0, 40) + '…' : s)

/** The cast hash in one of our own /c/<hash> paths. */
export const castOf = (path: string) => path.match(/^\/c\/(?:0x)?([0-9a-f]{40})$/i)?.[1].toLowerCase()

/** The room id in a farcaster.xyz Space link. */
export const spaceOf = (u: string) => u.match(/^https?:\/\/(?:www\.)?(?:warpcast\.com|farcaster\.xyz)\/~\/spaces\/([\w-]{1,64})\/?(?:[?#].*)?$/)?.[1]
