// App themes: the editor, Settings > Theme (built-in themes, the ones this browser kept, Quorum's gallery, imports)
// and sharing. A theme restyles all of Quilcast for whoever wears it (ui.tsx wear(), style.css "app themes"); it's
// plain settings checked by cleanTheme (shared.ts). Quorum skins come in through our server (server/themes.mjs), and
// toSkin() below turns a theme into one Quorum's "Import from clipboard / file" takes.
import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { t, tn } from './i18n.ts'
import { PRESETS as EFFECTS } from './fx.ts'
import { EditSticker, focusSticker, FONT_NAMES, group, row, shareUrl, useEditorKit } from './looks.tsx'
import { BG_MODES, BORDERS, cleanTheme, DEFAULTS, FONTS, FX, HOLIDAYS, LIMITS, NAME_FX, ownMedia, sized, themeId, themeVars, type Theme } from './shared.ts'
import { CARD, copyText, dressed, Img, keepLibrary, library, remember, screenUnit, Seg, shell, theme, themeOf, toast, useApply, useOn, wear, type Saved } from './ui.tsx'

// --- built-in themes ---
// two of Quorum's sample skins (theme/skins/samples.ts) and a few of our own; GIFs are Tenor's
const tenor = (id: string, slug: string, sticker = false) => `https://media.tenor.com/${id}AAAA${sticker ? 'l' : 'x'}/${slug}.webp`
export const BUILT_IN: Theme[] = [
  { name: 'Midnight Neon', base: 'dark', bg: '#0a0612', card: '#120a22', soft: '#190e2e', line: '#2c1a4d', ink: '#f3eeff', muted: '#b9a7e6', accent: '#7c5cff', round: 0.6 },
  { name: 'Paper', base: 'light', bg: '#fbf6ec', card: '#fffdf8', soft: '#f3ead9', line: '#e2d4ba', ink: '#403425', muted: '#7a6a52', accent: '#c2410c', round: 1.6, font: 'georgia' },
  { name: 'Brutalist', base: 'dark', bg: '#000000', card: '#000000', soft: '#151515', line: '#ffffff', ink: '#ffffff', muted: '#bdbdbd', accent: '#ffe600', onAccent: '#000000', like: '#ff3b3b', recast: '#00ff85', round: 0, borderWidth: 2 },
  {
    name: 'Geocities', base: 'dark', bg: '#000033', card: '#000044', soft: '#10105a', line: '#c0c0c0', ink: '#ffff66', muted: '#66ffff', accent: '#ff66ff', onAccent: '#000033', like: '#ff3399', recast: '#33ff33',
    bgImg: tenor('8XfhFrwNfv0', 'space-pixel-art'), bgMode: 'tile', sheer: 82, round: 0, borderWidth: 3, borderStyle: 'ridge', font: 'comic', nameFx: 'rainbow', fx: 'trail',
    stickers: [{ src: tenor('42bcTn0iuVg', 'under-construction-pikachu', true), x: 92, y: 88, w: 22 }, { src: tenor('9KyXLYrmEOM', 'baby-dance', true), x: 7, y: 86, w: 14 }],
  },
  {
    name: 'Vaporwave', base: 'dark', bg: '#1a0b2e', card: '#2a1145', soft: '#33175a', line: '#b967ff', ink: '#ffe9ff', muted: '#c9a3e0', accent: '#ff71ce', onAccent: '#1a0b2e', like: '#ff71ce', recast: '#01cdfe', warn: '#fffb96',
    bgImg: tenor('f-KMXPuqT8I', 'vaporwave-sunset'), bgMode: 'cover', scrim: 35, sheer: 76, round: 1.4, font: 'trebuchet', nameFx: 'glow', nameColor: '#01cdfe', glow: true,
  },
  {
    name: 'Matrix', base: 'dark', bg: '#000000', card: '#020b02', soft: '#061a06', line: '#0f3f0f', ink: '#b6ffb6', muted: '#3fae3f', accent: '#3cff6e', onAccent: '#001a00', like: '#3cff6e', recast: '#3cff6e', warn: '#d4ff3c',
    sheer: 92, round: 0, font: 'courier', nameFx: 'glow', nameColor: '#3cff6e', fx: 'matrix',
  },
  {
    name: 'Winter night', base: 'dark', bg: '#0b1426', card: '#101c33', soft: '#16264a', line: '#22365e', ink: '#eaf3ff', muted: '#9db4d8', accent: '#7cc4ff', onAccent: '#08111f', like: '#ff8fb3', recast: '#6ff0d2',
    bgImg: tenor('Lj04cHtdYjY', 'snow'), bgMode: 'cover', scrim: 45, sheer: 80, round: 1.3, font: 'rounded', fx: 'snow',
  },
  {
    name: 'Sakura', base: 'light', bg: '#fff5f8', card: '#fffafc', soft: '#fde8ef', line: '#f6cfdc', ink: '#4a2232', muted: '#9b6b7c', accent: '#e0507a', like: '#e0507a', recast: '#3a9e78',
    bgImg: tenor('SBwOJlD-haU', 'cherry-blossom-sakura'), bgMode: 'cover', scrim: 55, sheer: 86, round: 1.7, font: 'rounded', fx: 'sakura',
  },
  {
    name: 'Spooky', base: 'dark', bg: '#120b05', card: '#1c1209', soft: '#2a1b0d', line: '#4a2c10', ink: '#ffe8cc', muted: '#c08a55', accent: '#ff7a1a', onAccent: '#120b05', like: '#ff4d2e', recast: '#a3e635',
    sheer: 90, round: 0.8, font: 'impact', nameFx: 'shadow', nameColor: '#ff7a1a', fx: 'bats', stickers: [{ src: tenor('NarRX0m-o1I', 'halloween-ghost', true), x: 94, y: 16, w: 16, r: 12 }],
  },
  {
    name: 'Glitter', base: 'light', bg: '#ffe0f0', card: '#fff0f8', soft: '#ffd6ec', line: '#ff8ac6', ink: '#5a0838', muted: '#a0507c', accent: '#ff2e9a', like: '#ff2e9a', recast: '#7a5cff',
    bgImg: tenor('4AZnyLAk3nE', 'pink-sparkles'), bgMode: 'tile', sheer: 84, round: 2, borderWidth: 3, borderStyle: 'dotted', font: 'comic', nameFx: 'glitter', nameColor: '#ff2e9a', fx: 'glitter',
  },
  {
    // the "the world if…" meme's city
    name: 'Utopia', base: 'light', bg: '#eaf6fb', card: '#f7fcff', soft: '#ddf0f7', line: '#b9dcea', ink: '#0c2a3d', muted: '#3f6074', accent: '#0b647d', like: '#e0457b', recast: '#05875f', warn: '#c2410c',
    bgImg: tenor('0I05Y5gWP7U', 'world-if-world-without'), bgMode: 'cover', scrim: 20, sheer: 80, round: 1.6, glow: true, fx: 'bokeh',
  },
  {
    // the GTA VI logo's pink-to-orange on plum
    name: 'GTA VI', base: 'dark', bg: '#170b1f', card: '#21102c', soft: '#2b1638', line: '#4a2560', ink: '#fff1f6', muted: '#d7a6c8', accent: '#ff4fa3', onAccent: '#1b0c24', like: '#ff3b6b', recast: '#2ee6c5', warn: '#ffb347',
    bgImg: tenor('4bPTY8hgbB0', 'gta-6-grand-theft-auto-6'), bgMode: 'cover', scrim: 40, sheer: 84, round: 1.2, glow: true, nameFx: 'glow', nameColor: '#ffb347', fx: 'money',
  },
  {
    // gmfarcaster.com's purples
    name: 'GM Farcaster', base: 'dark', bg: '#0d0814', card: '#1a1226', soft: '#221833', line: '#33264a', ink: '#f3e8ff', muted: '#c9b8ec', accent: '#a855f7', like: '#e114e5', recast: '#9ee6a0', warn: '#ffd12f',
    round: 2, glow: true, nameFx: 'glow', nameColor: '#e114e5',
  },
  ...HOLIDAYS.map((h) => h.theme),
]

const same = (a: Theme | null | undefined, b: Theme | null | undefined) => JSON.stringify(a || null) === JSON.stringify(b || null)

// --- sharing and moving themes around ---

const shareLink = async (th: Theme) => shareUrl('theme', cleanTheme(th))
const castTheme = (th: Theme) => shareLink(th).then((url) => shell.compose({ embeds: [url] }), (e) => toast(e.message))

/** Whatever was pasted or picked: a theme link, a Quorum skin's JSON, or a Quilcast theme's. */
async function readTheme(text: string): Promise<Saved> {
  const id = themeId(text)
  if (id) {
    const th = await themeOf(id)
    if (!th) throw new Error("That theme link doesn't work.")
    return { theme: th, id }
  }
  let j: any
  try {
    j = JSON.parse(text)
  } catch {
    throw new Error('Paste a theme link, or a theme from Quorum or Quilcast.')
  }
  if (j?.schemaVersion === 1) {
    const r = await fetch('/api/quorum/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: text })
    const th = await r.json().catch(() => null)
    if (!r.ok) throw new Error(th?.error || "That Quorum theme couldn't be read.")
    return { theme: cleanTheme(th) }
  }
  const th = cleanTheme(j)
  if (!Object.keys(th).length) throw new Error("That isn't a theme.")
  return { theme: th }
}

// --- Quorum export ---
// Quorum's skins hold PNG or JPEG pictures inline, 2 MB at most for all of them together, and nothing remote, so
// pictures are redrawn here as JPEGs (a GIF keeps its first frame), and its own font goes in if it fits.

const mixHex = (a: string, b: string, k: number) => '#' + [1, 3, 5].map((i) => Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - k) + parseInt(b.slice(i, i + 2), 16) * k).toString(16).padStart(2, '0')).join('')
const asData = (b: Blob) => new Promise<string>((ok, no) => Object.assign(new FileReader(), { onload: (e: any) => ok(e.target.result), onerror: no }).readAsDataURL(b))
// the CDN's sized copies decode faster and come out smaller
const fetchable = (u: string) => ownMedia(sized(u, 'w=1600'))

/** A picture as a JPEG data: URI of at most `max` bytes and `px` on its longest side, on `bg` where it's see-through. */
async function jpeg(url: string, px: number, max: number, bg: string) {
  const img = await createImageBitmap(await (await fetch(fetchable(url))).blob())
  for (let scale = Math.min(1, px / Math.max(img.width, img.height)); scale > 0.05; scale *= 0.75) {
    const c = Object.assign(document.createElement('canvas'), { width: Math.max(1, Math.round(img.width * scale)), height: Math.max(1, Math.round(img.height * scale)) })
    const g = c.getContext('2d')!
    g.fillStyle = bg
    g.fillRect(0, 0, c.width, c.height)
    g.drawImage(img, 0, 0, c.width, c.height)
    for (const q of [0.86, 0.72, 0.58]) {
      const b = await new Promise<Blob | null>((ok) => c.toBlob(ok, 'image/jpeg', q))
      if (b && b.size <= max) return asData(b)
    }
  }
  throw new Error('A picture is too big for Quorum.')
}

/** The theme as a Quorum skin (Quorum's theme/skins/types.ts SkinOverride, passing its validate.ts). Quorum has no
 *  GIFs, stickers, effects, name effects or system fonts, so those stay behind. */
export async function toSkin(th: Theme) {
  const base = th.base || 'dark'
  const c = { ...DEFAULTS[base], ...th }
  const ramp = (k: number) => mixHex(c.card, c.ink, k)
  const colors = {
    accent: c.accent, accentLight: mixHex(c.accent, '#ffffff', 0.45), accentDark: mixHex(c.accent, '#000000', 0.4),
    surface0: c.bg, surface1: c.bg, surface2: c.card, surface3: c.soft, surface4: c.line, surface5: c.line,
    surface6: ramp(0.2), surface7: ramp(0.32), surface8: ramp(0.45), surface9: ramp(0.58), surface10: ramp(0.68),
    textStrong: c.ink, textMain: c.ink, textSubtle: c.muted, textMuted: mixHex(c.muted, c.bg, 0.3),
    danger: c.like, warning: c.warn, success: c.recast, info: c.accent,
  }
  const [wall, bar, btn] = await Promise.all([
    th.bgImg && jpeg(th.bgImg, 1600, 1.1e6, c.bg),
    th.barImg && jpeg(th.barImg, 900, 0.25e6, c.bar || c.bg),
    th.btnImg && jpeg(th.btnImg, 600, 0.2e6, c.accent),
  ])
  // what's left of the 2 MB after the pictures, for the font
  const left = 1.95e6 - [wall, bar, btn].reduce((n, u) => n + (u ? (u.length * 3) / 4 : 0), 0)
  const fontBlob = th.fontUrl ? await fetch(ownMedia(th.fontUrl)).then((r) => (r.ok ? r.blob() : null), () => null) : null
  const font = fontBlob && fontBlob.size < left ? (await asData(fontBlob)).replace(/^data:[^;]*/, th.fontUrl!.endsWith('.otf') ? 'data:font/otf' : 'data:font/ttf') : null
  const surfaces: Record<string, { background: string; text?: string }> = {}
  if (bar || c.bar) surfaces.header = surfaces.tabBar = { background: bar || c.bar! }
  if (btn) surfaces.button = { background: btn, text: c.onAccent }
  return {
    schemaVersion: 1, id: '',
    meta: { name: th.name || 'Quilcast theme', description: 'Made in Quilcast (quilcast.com)' },
    base,
    colors: { [base]: colors },
    ...(th.round !== undefined && { radii: { scale: th.round } }),
    borders: { scale: th.borderStyle === 'none' ? 0 : th.borderWidth ?? 1, color: c.line },
    ...(th.size && { fontScale: th.size }),
    ...(font && { font: { family: 'Quilcast theme', source: { dataUri: font }, weights: 'static-single' } }),
    ...(wall && { wallpaper: { source: { dataUri: wall }, fit: th.bgMode === 'cover' ? 'cover' : th.bgMode === 'center' ? 'contain' : 'tile', scrimOpacity: (th.scrim || 0) / 100, surfaceAlpha: (th.sheer ?? 88) / 100 } }),
    ...(Object.keys(surfaces).length && { surfaces }),
    ...((th.glow || th.round === 0) && { frame: { ...(th.glow && { panelGlow: true }), ...(th.round === 0 && { corner: 'square' }) } }),
  }
}
const skinJson = (th: Theme) => toSkin(th).then((s) => JSON.stringify(s))
const download = (th: Theme) => skinJson(th).then((json) => {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([json], { type: 'application/json' })), download: `${(th.name || 'quilcast-theme').replace(/[^\w-]+/g, '-').toLowerCase()}.json` })
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}, (e) => toast(e.message))

/** Share and export buttons for a theme. */
export function Share({ th }: { th: Theme }) {
  return (
    <>
      <div class="btns wrap">
        <button type="button" class="btn ghost small" onClick={() => castTheme(th)}>{t('Cast this theme')}</button>
        <button type="button" class="btn ghost small" onClick={() => copyText(shareLink(th), 'Link copied')}>{t('Copy link')}</button>
      </div>
      <div class="btns wrap">
        <button type="button" class="btn ghost small" onClick={() => copyText(skinJson(th), 'Copied. In Quorum, open Skins and import from the clipboard.')}>{t('Copy for Quorum')}</button>
        <button type="button" class="btn ghost small" onClick={() => download(th)}>{t('Save for Quorum')}</button>
      </div>
    </>
  )
}

// --- Settings > Theme ---

/** A theme in small: a window on its background, with a card of text lines and an accent button, in its corners
 *  and borders. Everything the theme leaves out is the plain app's. */
export function Mini({ th }: { th: Theme }) {
  const c: Theme = { ...DEFAULTS[th.base || 'dark'], ...th }
  return (
    <span class={`th-mini${th.btnImg ? ' thc-btn' : ''}`} style={{ ...CARD, '--lk-name': c.accent, ...themeVars(c), colorScheme: c.base || 'dark' }}>
      {th.bgImg && <Img src={ownMedia(th.bgImg)} />}
      <span class="th-mini-card"><i /><em /><em /></span>
      <b />
    </span>
  )
}

function Row({ th, sub, meta, del }: { th: Theme; sub?: ComponentChildren; meta?: Omit<Saved, 'theme'>; del?: () => void }) {
  const a = useApply(th, meta)
  return (
    <div class={`th-row${a.on ? ' on' : ''}`}>
      <button type="button" class="th-swatch" onClick={a.apply} aria-label={t('Apply theme')}><Mini th={th} /></button>
      <span class="th-name"><b>{th.name || t('Untitled theme')}</b><small>{sub || (th.base === 'light' ? t('Light') : t('Dark'))}</small></span>
      <span class="btns">
        {a.undo ? <button type="button" class="btn ghost small" onClick={a.undo}>{t('Undo')}</button>
          : <button type="button" class="btn small" disabled={a.on} onClick={a.apply}>{a.on ? t('On') : t('Apply')}</button>}
        {del && <button type="button" class="lk-x" aria-label={t('Remove')} onClick={del}>×</button>}
      </span>
    </div>
  )
}

type Skin = { id: string; name: string; description?: string; base: 'light' | 'dark'; installs: number; author?: string; theme?: Theme }
/** Quorum's gallery, through our server, which converts every skin it lists (a few may come without). */
function Gallery() {
  const [sort, setSort] = useState<'popular' | 'new'>('popular')
  const [q, setQ] = useState('')
  const [list, setList] = useState<Skin[] | null>(null)
  const [more, setMore] = useState(false)
  const [busy, setBusy] = useState('')
  const [got, setGot] = useState<Record<string, Theme>>({})
  const load = (offset: number) =>
    fetch(`/api/quorum/skins?${new URLSearchParams({ sort, offset: String(offset), ...(q.trim() && { search: q.trim() }) })}`)
      .then((r) => r.json()).then((j) => {
        if (!Array.isArray(j?.skins)) throw new Error(j?.error || "Couldn't reach Quorum's theme gallery.")
        setList((l) => [...(offset ? l || [] : []), ...j.skins])
        setMore(!!j.more)
      }).catch((e) => (toast(e.message), setList((l) => l || [])))
  useEffect(() => {
    setList(null)
    const tm = setTimeout(() => load(0), q ? 350 : 0)
    return () => clearTimeout(tm)
  }, [sort, q])
  const facts = (s: Skin) => [s.base === 'light' ? t('Light') : t('Dark'), s.author, tn(s.installs, '{n} install', '{n} installs')].filter(Boolean).join(' · ')
  const open = async (s: Skin) => {
    setBusy(s.id)
    try {
      const r = await fetch(`/api/quorum/skin/${s.id}`)
      const j = await r.json().catch(() => null)
      if (!r.ok) throw new Error(j?.error || "Couldn't load that theme.")
      const th = cleanTheme(j)
      setGot((g) => ({ ...g, [s.id]: th }))
      remember({ theme: th, quorum: s.id })
      wear(th, true)
      toast('Theme applied')
    } catch (e: any) {
      toast(e.message)
    }
    setBusy('')
  }
  return (
    <div class="th-gallery">
      <div class="th-gallery-head">
        <input value={q} placeholder={t('Search Quorum themes')} aria-label={t('Search Quorum themes')} onInput={(e) => setQ(e.currentTarget.value)} />
        <Seg opts={[['popular', t('Popular')], ['new', t('New')]]} on={sort} set={setSort} />
      </div>
      {!list ? <div class="spinner" /> : !list.length ? <p class="hint">{t('No themes found.')}</p> : list.map((s) => (
        got[s.id] || s.theme ? <Row th={got[s.id] || cleanTheme(s.theme)} meta={{ quorum: s.id }} sub={facts(s)} /> : (
          <div class="th-row">
            <span class={`th-swatch q ${s.base}`} />
            <span class="th-name"><b>{s.name || t('Untitled theme')}</b><small>{facts(s)}</small></span>
            <span class="btns"><button type="button" class="btn small" disabled={!!busy} onClick={() => open(s)}>{busy === s.id ? t('Loading…') : t('Apply')}</button></span>
          </div>
        )
      ))}
      {more && <button type="button" class="btn ghost small wide" onClick={() => load(list!.length)}>{t('Show more')}</button>}
      <p class="hint">{t("Themes people made in Quorum, Quilibrium's messenger. Pictures come along; icon and spacing changes have no match here.")}</p>
    </div>
  )
}

export function ThemeSettings() {
  const [, force] = useState(0)
  const [tab, setTab] = useState<'mine' | 'built' | 'quorum'>(library().length ? 'mine' : 'built')
  const [paste, setPaste] = useState('')
  const file = useRef<HTMLInputElement>(null)
  useOn('theme', () => force((x) => x + 1))
  const kept = library()
  const take = (p: Promise<Saved>) => p.then((s) => (remember(s), wear(s.theme, true), setPaste(''), setTab('mine'), toast('Theme applied')), (e) => toast(e.message))
  return (
    <>
      <div class="th-now">
        <span class="th-name"><small>{t('Wearing')}</small><b>{dressed() ? dressed()!.name || t('Untitled theme') : t('Plain Quilcast')}</b></span>
        <span class="btns">
          <button type="button" class="btn small" onClick={() => shell.editTheme(theme)}>{theme ? t('Customize') : t('Make a theme')}</button>
          {theme && <button type="button" class="btn ghost small" onClick={() => wear(null, true)}>{t('Plain')}</button>}
        </span>
      </div>
      {theme && <Share th={theme} />}
      <nav class="seg th-tabs">
        {([['mine', t('Mine')], ['built', t('Built in')], ['quorum', t('Quorum')]] as const).map(([k, label]) => <button type="button" class={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{label}</button>)}
      </nav>
      {tab === 'mine' && (kept.length ? kept.map((s) => (
        <Row th={s.theme} meta={{ id: s.id, quorum: s.quorum }} sub={s.quorum ? t('From Quorum') : undefined}
          del={() => (keepLibrary(kept.filter((x) => x !== s)), force((x) => x + 1))} />
      )) : <p class="hint">{t('Themes you make, apply or import are kept here.')}</p>)}
      {tab === 'built' && BUILT_IN.map((th) => <Row th={th} />)}
      {tab === 'quorum' && <Gallery />}
      <div class="lk-design">
        <input value={paste} placeholder={t('Paste a theme link or Quorum theme')} aria-label={t('Import a theme')} onInput={(e) => setPaste(e.currentTarget.value)} onKeyDown={(e) => e.key === 'Enter' && paste.trim() && take(readTheme(paste))} />
        <button type="button" class="btn ghost small" disabled={!paste.trim()} onClick={() => take(readTheme(paste))}>{t('Import')}</button>
        <button type="button" class="btn ghost small" onClick={() => file.current?.click()}>{t('File')}</button>
        <input ref={file} type="file" accept="application/json,.json" hidden onChange={(e) => {
          const f = e.currentTarget.files?.[0]
          e.currentTarget.value = ''
          f && take(f.text().then(readTheme))
        }} />
      </div>
      <p class="hint">{t('A theme changes the whole app for you: colors, a background, corners, fonts, effects and stickers. Quorum themes import here, and "Copy for Quorum" makes one Quorum can import.')}</p>
    </>
  )
}

// --- the editor ---

type Set = (f: (d: Theme) => Theme) => void
// a drop's place on the screen
const onScreen = (cx: number, cy: number) => ({ x: Math.round((cx / innerWidth) * 1000) / 10, y: Math.round((cy / innerHeight) * 1000) / 10 })

/** The theme editor: a side panel (a sheet on phones) over the real app, which wears the draft while it's open. */
export function Editor({ start, close }: { start: Theme | null; close: () => void }) {
  const [d, setD] = useState<Theme>(start || { base: (document.documentElement.dataset.theme as 'light' | 'dark') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') })
  const set: Set = (f) => setD((x) => f(x))
  const { min, setMin, gif, up, clear, select, image, head, stickers } = useEditorKit(d, set, ownMedia)
  useEffect(() => void wear(cleanTheme(d)), [d])
  // leaving without saving puts the saved theme back
  const cancel = () => (wear(dressed()), close())
  const save = () => {
    const th = cleanTheme({ ...d, name: d.name || t('My theme') })
    remember({ theme: th })
    wear(th, true)
    toast('Theme saved')
    close()
  }
  const base = d.base || 'dark'
  const def = DEFAULTS[base] as Record<string, string>

  const addSticker = (src: string) => {
    const n = d.stickers?.length || 0
    set((x) => ({ ...x, stickers: [...(x.stickers || []), { src, x: 50, y: 40, w: 30 }].slice(0, LIMITS.stickers) }))
    if (matchMedia('(max-width: 1099px)').matches) setMin(true)
    focusSticker(n)
    toast('Drag it anywhere')
  }

  // controls are plain functions, not components, so typing or dragging doesn't remount them
  const color = (k: 'bg' | 'card' | 'ink' | 'muted' | 'line' | 'soft' | 'accent' | 'onAccent' | 'like' | 'recast' | 'warn' | 'bar' | 'nameColor', label: string) =>
    row(label, <><input type="color" value={d[k] || def[k] || def.accent} onInput={(e) => up({ [k]: e.currentTarget.value })} />{clear(k, label)}</>)
  const range = (k: 'scrim' | 'sheer' | 'fxAlpha' | 'round' | 'borderWidth' | 'size', label: string, min: number, max: number, fallback: number, step = 1, show = (v: number) => String(v)) =>
    row(label, <><input type="range" min={min} max={max} step={step} value={d[k] ?? fallback} onInput={(e) => up({ [k]: Number(e.currentTarget.value) })} /><output>{show(d[k] ?? fallback)}</output></>)
  const times = (v: number) => `${v}×`

  return (
    <>
      {/* the draft's stickers, draggable on the screen */}
      {(d.stickers || []).map((s, i) => <EditSticker s={s} i={i} set={set} at={onScreen} unit={screenUnit} class="th-stk" />)}
      <div class={`lk-edit th-edit${min ? ' min' : ''}`} role="dialog" aria-label={t('Theme editor')}>
        {head(t('Theme'), cancel, save)}
        <div class="lk-edit-body" hidden={!!gif}>
          {group(t('Start from'), <>
            <div class="lk-presets">
              <button class="btn ghost small" onClick={() => setD({ base })}>{t('Plain Quilcast')}</button>
              {BUILT_IN.map((p) => <button class={`btn ghost small${same(cleanTheme(d), cleanTheme(p)) ? ' on' : ''}`} onClick={() => setD({ ...p })}>{p.name}</button>)}
            </div>
            <label class="field"><span>{t('Name')}</span><input value={d.name || ''} maxLength={60} placeholder={t('My theme')} onInput={(e) => up({ name: e.currentTarget.value || undefined })} /></label>
            <div class="lk-row"><span>{t('Light or dark')}</span>
              <Seg<'light' | 'dark'> opts={[['light', t('Light')], ['dark', t('Dark')]]} on={base} set={(b) => up({ base: b })} />
            </div>
          </>, true)}
          {group(t('Colors'), <>
            {color('bg', t('Background'))}
            {color('card', t('Cards and menus'))}
            {color('soft', t('Soft fill'))}
            {color('line', t('Lines and borders'))}
            {color('ink', t('Text'))}
            {color('muted', t('Quiet text'))}
            {color('accent', t('Accent'))}
            {color('onAccent', t('Text on accent'))}
            {color('like', t('Likes'))}
            {color('recast', t('Recasts'))}
            {color('warn', t('Warnings'))}
            {range('sheer', t('Content opacity'), 0, 100, 88, 1, (v) => `${v}%`)}
          </>)}
          {group(t('Background'), <>
            {image('bgImg', t('Picture'))}
            {select('bgMode', t('Picture fit'), BG_MODES, { tile: 'Tiled', cover: 'Fill the screen', center: 'Centered once' })}
            {range('scrim', base === 'light' ? t('Lighten') : t('Darken'), 0, 90, 0, 1, (v) => `${v}%`)}
          </>)}
          {group(t('Bars and buttons'), <>
            {color('bar', t('Bar color'))}
            {image('barImg', t('Bar picture'))}
            {image('btnImg', t('Button picture'))}
          </>)}
          {group(t('Shape'), <>
            {range('round', t('Corners'), 0, 3, 1, 0.1, times)}
            {range('borderWidth', t('Border width'), 0, 6, 1, 1, (v) => `${v}px`)}
            {select('borderStyle', t('Border style'), BORDERS)}
            <div class="lk-row"><span>{t('Glow')}</span>
              <Seg opts={[[true, t('On')], [false, t('Off')]]} on={!!d.glow} set={(v) => up({ glow: v || undefined })} />
            </div>
          </>)}
          {group(t('Text'), <>
            {select('font', t('Font'), Object.keys(FONTS), FONT_NAMES)}
            {d.fontUrl && <p class="hint">{t('This theme has its own font, from Quorum.')} <button type="button" class="link-btn" onClick={() => up({ fontUrl: undefined })}>{t('Remove it')}</button></p>}
            {range('size', t('Size of everything'), 0.8, 1.4, 1, 0.05, times)}
            {select('nameFx', t('Name effect'), NAME_FX)}
            {color('nameColor', t('Effect color'))}
          </>)}
          {group(t('Effect'), <>
            {select('fx', t('Effect'), FX, Object.fromEntries(FX.map((k) => [k, EFFECTS[k].name])))}
            {d.fx && range('fxAlpha', t('Effect opacity'), 0, 100, 100, 1, (v) => `${v}%`)}
            <p class="hint">{t('Snow, confetti, fireflies and more, moving across the whole app behind its columns and cards, which Content opacity makes more or less solid. It stops for people who ask their device for less motion.')}</p>
          </>)}
          {stickers(addSticker, t('Stickers sit on your screen over the app and never get in the way of a tap. Drag one anywhere; tap it, then drag its corner dot to resize and turn it.'))}
          {group(t('Share'), <Share th={cleanTheme(d)} />)}
          <button class="btn danger small lk-reset" onClick={() => setD({ base })}>{t('Start over')}</button>
        </div>
      </div>
    </>
  )
}
