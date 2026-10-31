// App themes (src/themes.tsx) and Quorum's skins.
//   POST /api/theme             share a theme: stored once in <data>/themes under a hash of itself; answers { id }
//                               for quilcast.com/theme/<id>
//   GET  /api/theme/<id>        a shared theme, or null
//   GET  /api/quorum/skins      Quorum's skin gallery (api.quorummessenger.com/skins, which browsers can't read
//                               from here: it sends no CORS origin), cut to what a list shows
//   GET  /api/quorum/skin/<id>  one of its skins as a Quilcast theme
//   POST /api/quorum/import     a Quorum skin's JSON (copied or saved from the app) as a Quilcast theme
// Quorum skins carry their pictures and font inline as data: URIs; those are checked, kept in the media volume by
// their hash and linked as quilcast.com/m/<hash>.<ext>, so a converted theme is small and shares like any other.
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cleanTheme, DEFAULTS } from '../src/shared.ts'
import { fail, gate, keep, parseJson, readText } from './net.mjs'
import { looksLike, MEDIA, ownThemes } from './upload.mjs'

export const QUORUM = process.env.QUORUM_URL || 'https://api.quorummessenger.com'

let dir = ''
export const loadThemes = (dataDir) => mkdir((dir = join(dataDir, 'themes')), { recursive: true })

export async function putTheme(req) {
  const theme = cleanTheme(parseJson(await readText(req, 12e3)))
  if (!Object.keys(theme).length) throw fail(400, 'That theme is empty.')
  const body = JSON.stringify(theme)
  const id = createHash('sha256').update(body).digest('base64url').slice(0, 10)
  await writeFile(join(dir, `${id}.json`), body, { flag: 'wx' }).catch((e) => {
    if (e.code !== 'EEXIST') throw e
  })
  // its pictures stay when the account that uploaded them is deleted (upload.mjs)
  await ownThemes(body)
  return { id }
}
export const getTheme = (id) => readFile(join(dir, `${id}.json`), 'utf8').then(JSON.parse, () => null)

// --- Quorum ---

// Quorum's API is a fixed address (QUORUM_URL only for tests), so a plain fetch, cut off at `max` bytes
const quorum = async (path, max) => {
  const down = () => fail(502, "Couldn't reach Quorum's theme gallery.")
  const r = await fetch(`${QUORUM}${path}`, { signal: AbortSignal.timeout(20e3), headers: { accept: 'application/json' } }).catch(() => null)
  if (r?.status !== 200 || !r.body) throw down()
  const parts = []
  let n = 0
  for await (const c of r.body) if ((n += c.length) > max) throw down()
  else parts.push(c)
  return parseJson(Buffer.concat(parts).toString('utf8'))
}

const lists = new Map()
export function gallery(q) {
  const sort = q.get('sort') === 'new' ? 'new' : 'popular'
  const search = String(q.get('search') || '').slice(0, 60)
  const offset = Math.min(Math.max(Number(q.get('offset')) || 0, 0), 5000)
  const k = `${sort}:${offset}:${search}`
  const hit = lists.get(k)
  if (hit && hit.at > Date.now() - 300e3) return hit.list
  const list = quorum(`/skins?${new URLSearchParams({ sort, offset: String(offset), limit: '30', ...(search && { search }) })}`, 4e6).then((r) => ({
    more: !!r?.has_more,
    skins: (Array.isArray(r?.entries) ? r.entries : []).filter((e) => typeof e?.id === 'string' && /^Qm\w{44}$/.test(e.id)).map((e) => ({
      id: e.id, name: String(e.name || '').slice(0, 80), description: e.description ? String(e.description).slice(0, 200) : undefined,
      base: e.base === 'light' ? 'light' : 'dark', installs: Number(e.installs) || 0, author: e.author_name ? String(e.author_name).slice(0, 60) : undefined,
    })),
  })).then(async (l) => {
    // the list shows each skin as it looks, so every one is converted (once: quorumSkin keeps them); one that
    // fails just shows without a preview
    await Promise.all(l.skins.map((s) => skinGate(() => quorumSkin(s.id)).then((theme) => (s.theme = theme), () => {})))
    return l
  })
  keep(lists, 200, k, { at: Date.now(), list })
  list.catch(() => lists.delete(k))
  return list
}

const skinGate = gate(6)
// a skin never changes under its id, so its theme is worked out once
const skins = new Map()
export const quorumSkin = (id) => skins.get(id) || keep(skins, 300, id, quorum(`/skins/${id}`, 8e6).then((r) => fromSkin(parseJson(String(r?.manifest || 'null')))))

export const importSkin = async (req) => fromSkin(parseJson(await readText(req, 4e6)))

// fonts: TrueType (00 01 00 00 or "true"), OpenType CFF ("OTTO"); collections ("ttcf") don't load in browsers
const FONT = (b) => b.length > 12 && (b.readUInt32BE(0) === 0x10000 || ['OTTO', 'true'].includes(b.toString('latin1', 0, 4)))
const TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'font/ttf': 'ttf', 'font/otf': 'otf', 'application/font-sfnt': 'ttf' }

/** A skin's inline file, checked and kept in the media volume; its quilcast.com link, or undefined. */
async function store(uri) {
  const m = typeof uri === 'string' && uri.match(/^data:([\w/+.-]+);base64,([A-Za-z0-9+/=\s]+)$/)
  if (!m || !TYPES[m[1]]) return
  const b = Buffer.from(m[2], 'base64')
  if (b.length > 3e6) return
  const font = TYPES[m[1]] === 'ttf' || TYPES[m[1]] === 'otf'
  if (font ? !FONT(b) : !looksLike(m[1], b)) return
  const ext = font ? (b.toString('latin1', 0, 4) === 'OTTO' ? 'otf' : 'ttf') : TYPES[m[1]]
  const name = `${createHash('sha256').update(b).digest('hex').slice(0, 24)}.${ext}`
  await mkdir(MEDIA, { recursive: true })
  await writeFile(join(MEDIA, name), b, { flag: 'wx' }).catch((e) => {
    if (e.code !== 'EEXIST') throw e
  })
  // the themes' own too (once per run), so deleting an account that uploaded the same picture doesn't take it (account.mjs)
  await ownThemes(`/m/${name}`)
  return `https://quilcast.com/m/${name}`
}

// Quorum's own palette (theme/colors.ts), for tokens a skin leaves out, so it looks here the way it does there
const QUORUM_BASE = {
  light: { surface1: '#f6f6f9', surface2: '#eeeef3', surface3: '#e6e6eb', surface4: '#dedee3', textMain: '#363636', textSubtle: '#818181', accent: '#0287f2', danger: '#e74a4a', warning: '#e7b04a', success: '#46c236' },
  dark: { surface1: '#241f27', surface2: '#2c252e', surface3: '#312935', surface4: '#3a313f', textMain: '#f4f1f6', textSubtle: '#9b8fa6', accent: '#0287f2', danger: '#c73737', warning: '#d09a3d', success: '#379e2b' },
}
// Quorum colors may be #rgb, #rrggbbaa or rgba(); ours are #rrggbb
const hex = (v) => {
  if (typeof v !== 'string') return
  let m = v.trim().match(/^#([0-9a-f]{3,8})$/i)?.[1]
  if (m && m.length <= 4) m = [...m.slice(0, 3)].map((c) => c + c).join('')
  if (m?.length >= 6) return '#' + m.slice(0, 6).toLowerCase()
  const r = v.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i)
  return r ? '#' + r.slice(1, 4).map((x) => Math.min(255, Number(x)).toString(16).padStart(2, '0')).join('') : undefined
}
// whether black text reads better than white on this color (WCAG relative luminance)
const light = (h) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.179
}
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})

/** A Quorum skin (theme/skins/types.ts SkinOverride) as a Quilcast theme. Spacing and icon swaps have no match here. */
export async function fromSkin(skin) {
  const s = obj(skin)
  if (s.schemaVersion !== 1 || !['light', 'dark'].includes(s.base)) throw fail(400, "That isn't a Quorum theme.")
  const base = s.base
  const own = obj(obj(s.colors)[base])
  const c = (k) => hex(own[k]) || QUORUM_BASE[base][k]
  const surf = obj(s.surfaces)
  // a slot's style: the slot itself or its first dotted variant (button.primary for button)
  const slot = (name) => obj(surf[name] || surf[Object.keys(surf).find((k) => k.startsWith(name + '.'))])
  const img = async (v) => (typeof v === 'string' && v.startsWith('data:') ? store(v) : undefined)
  const wall = obj(s.wallpaper)
  const bgImg = (await img(obj(wall.source).dataUri)) || (await img(['feed', 'profile', 'messages', 'wallet', 'spaces'].map((k) => slot(k).background).find((b) => b?.startsWith?.('data:'))))
  const radii = obj(s.radii), borders = obj(s.borders), frame = obj(s.frame), border = obj(frame.accentBorder)
  // corners: one scale for all, like Quorum's radii.scale; `set` and named sizes become the scale nearest them
  const round = radii.scale ?? (radii.set !== undefined ? radii.set / 10 : radii.md !== undefined ? radii.md / 8 : frame.corner === 'square' ? 0 : frame.corner === 'pill' ? 2.2 : undefined)
  const width = border.width ? (border.width === 'thick' ? 2 : 1) : borders.scale !== undefined ? Math.round(borders.scale) : borders.thin
  const button = slot('button')
  const header = slot('header').background ? slot('header') : slot('tabBar')
  const bar = hex(header.background) || hex(obj(frame.headerBar).background)
  const th = cleanTheme({
    name: obj(s.meta).name, base,
    bg: c('surface1'), card: c('surface2'), soft: c('surface3'), line: hex(border.color) || hex(borders.color) || (border.width ? c('accent') : c('surface4')),
    ink: c('textMain'), muted: hex(own.textSubtle) || hex(own.textMuted) || QUORUM_BASE[base].textSubtle,
    accent: c('accent'), onAccent: hex(button.text) || (light(c('accent')) ? '#000000' : DEFAULTS[base].onAccent), like: c('danger'), recast: c('success'), warn: c('warning'),
    bar,
    bgImg, bgMode: !bgImg ? undefined : wall.fit === 'tile' ? 'tile' : wall.fit === 'contain' ? 'center' : 'cover',
    scrim: bgImg ? Math.round((wall.scrimOpacity ?? (wall.source ? 0.6 : 0)) * 100) : undefined,
    sheer: bgImg && wall.surfaceAlpha !== undefined ? Math.round(wall.surfaceAlpha * 100) : undefined,
    barImg: await img(header.background), btnImg: await img(button.background),
    round: typeof round === 'number' ? Math.min(3, Math.max(0, round)) : undefined,
    borderWidth: typeof width === 'number' ? Math.min(6, Math.max(0, Math.round(width))) : undefined,
    glow: frame.panelGlow === true,
    fontUrl: await img(obj(obj(s.font).source).dataUri),
    size: typeof s.fontScale === 'number' ? Math.min(1.4, Math.max(0.8, s.fontScale)) : undefined,
  })
  // `name` is the only words a skin brings; the rest is checked by cleanTheme like any theme
  return th
}
