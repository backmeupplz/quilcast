// Pure helpers that the app and the server (which imports this file as TypeScript) both use.

export const isImg = (u: string) => /\.(png|jpe?g|gif|webp|avif)(\?|$)/i.test(u) || /imagedelivery\.net|i\.imgur\.com/.test(u)
export const isVid = (u: string) => /\.(m3u8|mp4|webm|mov)(\?|$)/i.test(u)

/** Farcaster's image CDN resizes on request (`w=96`, `anim=false,w=144`…), so nothing needs the full original. */
export const sized = (u: string, variant: string) => u.replace(/^(https:\/\/imagedelivery\.net\/[\w-]+\/[\w-]+)\/original$/, `$1/${variant}`)

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
}
export const LIMITS = { about: 1500, meet: 600, interest: 300, mood: 60, title: 40, top: 8, wall: 12, songTitle: 100 }

// images only from the GIF search (Tenor), Farcaster's image CDN, and our own uploads; nothing in these can break
// out of a CSS url("…")
export const isLookImg = (u: unknown): u is string =>
  typeof u === 'string' && u.length <= 300 &&
  /^https:\/\/(media1?\.tenor\.com\/[\w-]+(\/[\w-]+)*\/[\w-]+\.(gif|webp|png)|imagedelivery\.net\/[\w-]+\/[\w-]+\/[\w=,-]+|quilcast\.com\/m\/[0-9a-f]{24}\.(gif|png|jpg|webp))$/.test(u)

const color = (v: unknown) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : undefined)
const int = (v: unknown, lo: number, hi: number) => (Number.isInteger(v) ? Math.min(hi, Math.max(lo, v as number)) : undefined)
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
    song,
  }
  if (!l.top?.length) delete l.top
  if (!l.wall?.length) delete l.wall
  for (const k of Object.keys(l) as (keyof Look)[]) if (l[k] === undefined) delete l[k]
  if (l.song && !l.song.start) delete l.song.start
  if (l.song && !l.song.title) delete l.song.title
  return l
}

const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(' ')

/** The look's colors and font as CSS variables on the profile's wrapper; the app's styles take them from there. */
export function lookVars(l: Look) {
  const v: Record<string, string> = {}
  if (l.text) (v['--ink'] = l.text), (v['--soft'] = `rgb(${rgb(l.text)} / 0.08)`), (v['--hover'] = `rgb(${rgb(l.text)} / 0.04)`)
  if (l.muted) v['--muted'] = l.muted
  if (l.link) (v['--accent'] = l.link), (v['--accent-soft'] = `rgb(${rgb(l.link)} / 0.16)`)
  if (l.box) (v['--lk-box'] = `rgb(${rgb(l.box)} / ${(l.boxAlpha ?? 90) / 100})`), (v['--bg'] = l.box), (v['--card'] = l.box)
  if (l.border) v['--line'] = l.border
  if (l.borderStyle) v['--lk-bs'] = l.borderStyle
  if (l.borderWidth !== undefined) v['--lk-bw'] = `${l.borderWidth}px`
  if (l.radius !== undefined) v['--lk-r'] = `${l.radius}px`
  if (l.nameColor) v['--lk-name'] = l.nameColor
  if (l.font) v.fontFamily = FONTS[l.font]
  if (l.size && l.size !== 'normal') v.fontSize = l.size === 'small' ? '13px' : '17px'
  return v
}

/** A look's design: its style, without the words, friends, GIF wall and song. Shared as quilcast.com/design/<id>. */
export const DESIGN_KEYS = ['bg', 'bgImg', 'bgMode', 'bgDim', 'text', 'muted', 'link', 'box', 'boxAlpha', 'border', 'borderStyle', 'borderWidth', 'radius', 'font', 'size', 'nameFx', 'nameColor', 'banner'] as const
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
]
