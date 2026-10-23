// Profile looks: MySpace-style customization of profile pages (background, colors, font, boxes, name effects,
// mood, profile song, blurbs, interests, top friends, a GIF wall, stickers anywhere, a moving effect). Kept on our server (server/looks.mjs), checked
// by cleanLook (shared.ts) on the way in and out, and shown only on profile pages unless Settings turns them off.
import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { findUsers, loadUsers, users, type User } from './api.ts'
import { t } from './i18n.ts'
import { PRESETS as EFFECTS, start } from './fx.ts'
import { cleanDesign, cleanLook, DESIGN_KEYS, lookVars, designId, FONTS, FX, INTERESTS, isLookImg, LIMITS, NAME_FX, BORDERS, BG_MODES, SIZES, sized, type Look, type Sticker } from './shared.ts'
import { Avatar, designOf, Icon, Img, nameOf, RichText, shell, toast, userPath, w } from './ui.tsx'

export const clean = cleanLook

/** `l` wearing a shared design: its style is replaced, its words, friends, GIF wall and song stay. */
export const withDesign = (l: Look, d: Look): Look => ({ ...l, ...Object.fromEntries(DESIGN_KEYS.map((k) => [k, undefined])), ...d })

// --- showing a look ---

/** The look's colors and font as CSS variables on the profile's wrapper; the app's styles take them from there. */
export const vars = lookVars

/** The page background, a layer behind everything while the profile is open. */
export const Bg = ({ l }: { l: Look }) =>
  l.bg || l.bgImg ? (
    <div class={`lk-bg ${l.bgMode || 'tile'}`} aria-hidden="true"
      style={{ backgroundColor: l.bg, backgroundImage: l.bgImg ? `url("${l.bgImg}")` : undefined, '--lk-dim': l.bgDim ? String(l.bgDim / 100) : undefined }} />
  ) : null

/** The look's effect (src/fx.ts), on a canvas over the page that never takes a click. */
export function Fx({ fx }: { fx?: Look['fx'] }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => (fx && ref.current ? start(ref.current, fx) : undefined), [fx])
  return fx ? <canvas class="lk-fx" ref={ref} aria-hidden="true" /> : null
}

export const nameClass = (l?: Look | null) => (l?.nameFx && l.nameFx !== 'none' ? `lk-name ${l.nameFx}` : undefined)

export const Banner = ({ l }: { l: Look }) => (l.banner ? <Img class="lk-banner" src={l.banner} /> : null)
export const Mood = ({ l }: { l: Look }) => (l.mood || l.moodEmoji ? <div class="lk-mood"><b>{t('Mood:')}</b> {l.moodEmoji} {l.mood}</div> : null)

const Box = ({ title, children, class: cls = '' }: { title: string; children: ComponentChildren; class?: string }) => (
  <section class={`lk-box lk-sec ${cls}`}><h3>{title}</h3>{children}</section>
)

/** The look's own sections, between the profile header and the casts. `edit` is there while the owner edits. */
export function Sections({ l, u, edit }: { l: Look; u: User; edit?: Set }) {
  const who = nameOf(u)
  const ints = Object.entries(l.interests || {}) as [keyof typeof INTERESTS, string][]
  const at = (k: Sticker['at'], el: ComponentChildren) => <At l={l} at={k} edit={edit}>{el}</At>
  return (
    <>
      {l.song && at('song', <Song s={l.song} />)}
      {l.about && at('about', <Box title={t('About me')}><RichText text={l.about} /></Box>)}
      {l.meet && at('meet', <Box title={t("Who I'd like to meet")}><RichText text={l.meet} /></Box>)}
      {ints.length > 0 && at('int',
        <Box title={t("{name}'s Interests", { name: who })}>
          <dl class="lk-int">{ints.map(([k, v]) => <><dt>{t(INTERESTS[k])}</dt><dd><RichText text={v} /></dd></>)}</dl>
        </Box>,
      )}
      {l.top && at('top', <Top fids={l.top} title={l.topTitle || t("{name}'s Top {n}", { name: who, n: l.top.length })} />)}
      {l.wall && at('wall', <Box title={l.wallTitle || t('GIFs')}><div class="lk-wall">{l.wall.map((src) => <Img src={src} />)}</div></Box>)}
    </>
  )
}

// --- stickers ---
// A sticker sits on one box (the profile header or a section) at a share of that box's width and height, and its
// width is a share of the column. Boxes keep their order and roughly their shape from a phone to a desktop, so a
// sticker lands on the same spot on both.

/** The boxes the look shows; a sticker whose box is gone sits on the profile header. */
const boxesOf = (l: Look) =>
  new Set<string>(['head', ...([['song', l.song], ['about', l.about], ['meet', l.meet], ['int', l.interests], ['top', l.top], ['wall', l.wall]] as const).filter(([, v]) => v).map(([k]) => k)])

/** A box and the stickers on it. */
export function At({ l, at, edit, children }: { l: Look; at: Sticker['at']; edit?: Set; children: ComponentChildren }) {
  const boxes = boxesOf(l)
  const here = (l.stickers || []).map((s, i) => [s, i] as const).filter(([s]) => s.at === at || (at === 'head' && !boxes.has(s.at)))
  return <div class="lk-at" data-at={at}>{children}{here.map(([s, i]) => (edit ? <EditSticker s={s} i={i} set={edit} /> : <img class="lk-stk" src={s.src} alt="" loading="lazy" referrerpolicy="no-referrer" style={place(s)} />))}</div>
}
// a sticker's width is a share of its box; a theme's (on the screen) passes its own `unit`
type Unit = (w: number) => string
const pct: Unit = (w) => `${w}%`
const place = (s: { x: number; y: number; w: number; r?: number }, unit = pct) => ({ left: `${s.x}%`, top: `${s.y}%`, width: unit(s.w), rotate: s.r ? `${s.r}deg` : undefined })
const tenth = (v: number, lo: number, hi: number) => Math.round(Math.min(hi, Math.max(lo, v)) * 10) / 10

/** Where a point on the screen falls: the box under it (or the nearest one), and how far into it. */
function spot(cx: number, cy: number): { at: Sticker['at']; x: number; y: number } {
  const off = (r: DOMRect) => (cy < r.top ? r.top - cy : cy > r.bottom ? cy - r.bottom : 0)
  const el = [...document.querySelectorAll<HTMLElement>('.lk-at')].reduce((a, b) => (off(b.getBoundingClientRect()) < off(a.getBoundingClientRect()) ? b : a))
  const r = el.getBoundingClientRect()
  return { at: el.dataset.at as Sticker['at'], x: tenth(((cx - r.left) / r.width) * 100, 0, 100), y: tenth(((cy - r.top) / r.height) * 100, 0, 100) }
}
// a moved sticker can land in another box, which draws it anew, so it gets its handles back here
export const focusSticker = (i: number) => setTimeout(() => document.querySelector<HTMLElement>(`.lk-stk[data-i="${i}"]`)?.focus({ preventScroll: true }), 30)

// tap to pick a sticker; drag it to move it, drag its corner dot to resize and turn it, × (or Delete) removes it.
// A theme's stickers sit on the screen: it passes where a drop lands (`at`), the width `unit` and a class.
type Put = { src: string; x: number; y: number; w: number; r?: number }
// a look's or a theme's setter: either keeps everything but the stickers as it is
type SetStickers = (f: (d: any) => any) => void
export function EditSticker({ s, i, set, at = spot, unit = pct, class: cls = '' }: { s: Put; i: number; set: SetStickers; at?: (cx: number, cy: number) => Partial<Sticker>; unit?: Unit; class?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const put = (p: Partial<Sticker>) => set((l) => ({ ...l, stickers: l.stickers?.map((x: Put, j: number) => (j === i ? { ...x, ...p } : x)) }))
  const remove = () => set((l) => ({ ...l, stickers: l.stickers?.filter((_: Put, j: number) => j !== i) }))
  // follows the pointer until it lets go; the page only learns the result then, so dragging stays smooth
  const follow = (e: PointerEvent, el: Element, move: (e: PointerEvent) => void, done: (e: PointerEvent) => void) => {
    el.setPointerCapture(e.pointerId)
    const end = (u: PointerEvent) => (el.removeEventListener('pointermove', move as EventListener), el.removeEventListener('pointerup', end as EventListener), el.removeEventListener('pointercancel', end as EventListener), done(u))
    el.addEventListener('pointermove', move as EventListener)
    el.addEventListener('pointerup', end as EventListener)
    el.addEventListener('pointercancel', end as EventListener)
  }
  const drag = (e: PointerEvent) => {
    const el = ref.current!
    el.focus({ preventScroll: true })
    if (e.button || (e.target as Element).closest('button, .lk-turn')) return
    e.preventDefault()
    const [x0, y0] = [e.clientX, e.clientY]
    follow(e, el, (m) => ((el.style.left = `calc(${s.x}% + ${m.clientX - x0}px)`), (el.style.top = `calc(${s.y}% + ${m.clientY - y0}px)`)), (u) => {
      const r = el.getBoundingClientRect()
      ;(el.style.left = `${s.x}%`), (el.style.top = `${s.y}%`)
      if (Math.abs(u.clientX - x0) + Math.abs(u.clientY - y0) < 3) return
      put(at(r.left + r.width / 2, r.top + r.height / 2))
      focusSticker(i)
    })
  }
  const turn = (e: PointerEvent) => {
    e.preventDefault()
    const el = ref.current!, r = el.getBoundingClientRect()
    const [cx, cy] = [r.left + r.width / 2, r.top + r.height / 2]
    const d0 = Math.hypot(e.clientX - cx, e.clientY - cy) || 1, a0 = Math.atan2(e.clientY - cy, e.clientX - cx)
    let [w, rot] = [s.w, s.r || 0]
    follow(e, e.currentTarget as Element, (m) => {
      w = tenth((s.w * Math.hypot(m.clientX - cx, m.clientY - cy)) / d0, 4, 80)
      rot = tenth(((((s.r || 0) + ((Math.atan2(m.clientY - cy, m.clientX - cx) - a0) * 180) / Math.PI) % 360) + 540) % 360 - 180, -180, 180)
      ;(el.style.width = unit(w)), (el.style.rotate = `${rot}deg`)
    }, () => put({ w, r: rot || undefined }))
  }
  const key = (e: KeyboardEvent) => {
    const step = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, number[]>)[e.key]
    if (e.key === 'Delete' || e.key === 'Backspace') e.preventDefault(), remove()
    else if (step) e.preventDefault(), put({ x: tenth(s.x + step[0], 0, 100), y: tenth(s.y + step[1], 0, 100) })
  }
  return (
    <div ref={ref} class={`lk-stk edit ${cls}`} data-i={i} tabIndex={0} style={place(s, unit)} onPointerDown={drag} onKeyDown={key} aria-label={t('Sticker')}>
      <img src={s.src} alt="" draggable={false} referrerpolicy="no-referrer" />
      <button class="lk-x" aria-label={t('Remove')} onClick={remove}>×</button>
      <span class="lk-turn" onPointerDown={turn} aria-hidden="true" />
    </div>
  )
}

function Top({ fids, title }: { fids: number[]; title: string }) {
  const [, force] = useState(0)
  useEffect(() => void loadUsers(fids).then(() => force((x) => x + 1)), [fids.join()])
  return (
    <Box title={title}>
      <div class="lk-top">
        {fids.map((f) => users.get(f)).filter((u): u is User => !!u).map((u) => (
          <a href={userPath(u)}><Avatar u={u} size={64} link={false} /><span>{nameOf(u)}</span></a>
        ))}
      </div>
    </Box>
  )
}

// the song plays in YouTube's own player, and only when the visitor asks for it
function Song({ s }: { s: NonNullable<Look['song']> }) {
  const [on, setOn] = useState(false)
  useEffect(() => setOn(false), [s.id, s.start])
  return (
    <Box title={t('Profile song')} class="lk-song">
      {on ? (
        <iframe src={`https://www.youtube-nocookie.com/embed/${s.id}?autoplay=1&playsinline=1${s.start ? `&start=${s.start}` : ''}`} title={s.title || t('Profile song')}
          allow="autoplay; encrypted-media; picture-in-picture" referrerpolicy="strict-origin-when-cross-origin" allowFullScreen />
      ) : (
        <button class="lk-play" onClick={() => setOn(true)}><span aria-hidden="true">▶︎</span><b>{s.title || t('Play the song')}</b></button>
      )}
    </Box>
  )
}

// --- editing ---

// each preset sets every style field and leaves the images and the words alone
const STYLE: Look = { bg: undefined, text: undefined, muted: undefined, link: undefined, box: undefined, boxAlpha: undefined, border: undefined, borderStyle: undefined, borderWidth: undefined, radius: undefined, font: undefined, size: undefined, nameFx: undefined, nameColor: undefined }
const PRESETS: [string, Look][] = [
  ['Classic', { bg: '#e5ecf9', text: '#000000', muted: '#555555', link: '#003399', box: '#ffffff', boxAlpha: 100, border: '#6699cc', borderStyle: 'solid', borderWidth: 1, radius: 0, font: 'verdana', size: 'small', nameFx: 'none' }],
  ['Emo night', { bg: '#000000', text: '#f2f2f2', muted: '#9a9a9a', link: '#ff2e88', box: '#111111', boxAlpha: 90, border: '#ff2e88', borderStyle: 'dashed', borderWidth: 2, radius: 0, font: 'courier', nameFx: 'glow', nameColor: '#ff2e88' }],
  ['Glitter', { bg: '#ffd6ec', text: '#5a0838', muted: '#a0507c', link: '#e0007a', box: '#fff0f8', boxAlpha: 85, border: '#ff8ac6', borderStyle: 'dotted', borderWidth: 3, radius: 18, font: 'comic', nameFx: 'glitter', nameColor: '#ff3fa4' }],
  ['Scene kid', { bg: '#14001f', text: '#e9ffe0', muted: '#9fd48a', link: '#39ff14', box: '#24003a', boxAlpha: 85, border: '#ff00e6', borderStyle: 'double', borderWidth: 4, radius: 6, font: 'impact', nameFx: 'rainbow' }],
  ['Y2K chrome', { bg: '#c9d3e0', text: '#1a2233', muted: '#4c5a70', link: '#0057d9', box: '#eef2f8', boxAlpha: 92, border: '#8a9ab3', borderStyle: 'ridge', borderWidth: 4, radius: 12, font: 'trebuchet', nameFx: 'outline', nameColor: '#0057d9' }],
  ['Swamp', { bg: '#1c2a0c', text: '#e4eecb', muted: '#98a67a', link: '#9acd32', box: '#172010', boxAlpha: 88, border: '#4f6b00', borderStyle: 'groove', borderWidth: 3, radius: 14, font: 'rounded', nameFx: 'shadow', nameColor: '#7cb518' }],
]
const FONT_NAMES: Record<keyof typeof FONTS, string> = { system: 'System', verdana: 'Verdana', arial: 'Arial', trebuchet: 'Trebuchet', georgia: 'Georgia', times: 'Times', courier: 'Courier', comic: 'Comic Sans', impact: 'Impact', rounded: 'Rounded', pixel: 'Console' }
const cap = (s: string) => s[0].toUpperCase() + s.slice(1)

// a YouTube link (watch, youtu.be, shorts, embed) and its start time (t=95, t=1m35s)
const ytId = (s: string) => (s.match(/(?:youtu\.be\/|[?&]v=|\/(?:embed|shorts|live)\/)([\w-]{11})/) || s.trim().match(/^([\w-]{11})$/))?.[1]
const ytStart = (s: string) => {
  const m = s.match(/[?&](?:t|start)=(?:(\d+)m)?(\d+)s?\b/)
  return m ? Number(m[1] || 0) * 60 + Number(m[2]) : undefined
}

type Set = (f: (d: Look) => Look) => void
type Pick = { pick: (url: string) => void }

export function Editor({ draft: d, set, close, saved }: { draft: Look; set: Set; close: () => void; saved: (l: Look | null) => void }) {
  const [min, setMin] = useState(false)
  const [busy, setBusy] = useState(false)
  const [gif, setGif] = useState<(Pick & { stickers?: boolean }) | null>(null)
  const [song, setSong] = useState(d.song ? `https://youtu.be/${d.song.id}${d.song.start ? `?t=${d.song.start}` : ''}` : '')
  const [q, setQ] = useState('')
  const [link, setLink] = useState('')
  const [found, setFound] = useState<User[]>([])
  const file = useRef<HTMLInputElement>(null)
  const onFile = useRef<(u: string) => void>(() => {})
  const up = (p: Look) => set((x) => ({ ...x, ...p }))

  useEffect(() => {
    if (!q.trim()) return setFound([])
    let live = true
    const t = setTimeout(() => findUsers(q.trim()).then((r) => live && setFound(r.slice(0, 6)), () => {}), 300)
    return () => ((live = false), clearTimeout(t))
  }, [q])

  const upload = (then: (u: string) => void) => ((onFile.current = then), file.current?.click())
  const gotFile = async (f?: File) => {
    if (!f) return
    toast('Uploading…')
    try {
      // the CDN serves any width, so a background never needs the full original
      const url = sized(await (await w()).upload(f), 'w=1600')
      if (!isLookImg(url)) throw new Error("That image can't be used here.")
      onFile.current(url)
    } catch (e: any) {
      toast(e.message)
    }
  }
  const save = async () => {
    setBusy(true)
    try {
      const l = cleanLook(d)
      const r = await (await w()).saveLook(Object.keys(l).length ? l : null)
      saved(r ? cleanLook(r) : null)
      toast('Your profile look is saved')
    } catch (e: any) {
      toast(e.message)
    }
    setBusy(false)
  }

  const load = async () => {
    const des = await designOf(designId(link)!)
    if (!des) return toast("That design link doesn't work.")
    set((x) => withDesign(x, des))
    setLink('')
    toast('Design loaded. Save to keep it.')
  }
  // sharing stores the design and gives its link: in a new cast, where it shows a "Use this design" button, or copied
  const designLink = async () => {
    const des = cleanDesign(d)
    if (!Object.keys(des).length) throw new Error('Pick some colors or a background first.')
    const r = await fetch('/api/design', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(des) })
    const j = await r.json().catch(() => null)
    if (!r.ok || !j?.id) throw new Error(j?.error || 'Sharing failed.')
    return `${location.origin}/design/${j.id}`
  }
  const castIt = () => designLink().then((url) => shell.compose({ embeds: [url] }), (e) => toast(e.message))
  // Safari only lets a click write the clipboard if the write starts right away, so the link goes in as a promise
  const copy = () => {
    const url = designLink()
    const done = typeof ClipboardItem !== 'undefined'
      ? navigator.clipboard.write([new ClipboardItem({ 'text/plain': url.then((u) => new Blob([u], { type: 'text/plain' })) })])
      : url.then((u) => navigator.clipboard.writeText(u))
    done.then(() => toast('Link copied'), () => url.then(() => toast("Couldn't copy the link."), (e) => toast(e.message)))
  }

  // controls are plain functions, not components, so typing or dragging doesn't remount them
  const row = (label: string, ctl: ComponentChildren) => <label class="lk-row"><span>{label}</span><span class="lk-ctl">{ctl}</span></label>
  const clear = (k: keyof Look, label: string) => d[k] !== undefined && <button type="button" class="lk-x" aria-label={t('Reset {name}', { name: label })} onClick={(e) => (e.preventDefault(), up({ [k]: undefined }))}>×</button>
  const color = (k: 'bg' | 'text' | 'muted' | 'link' | 'box' | 'border' | 'nameColor', label: string, fallback: string) =>
    row(label, <><input type="color" value={d[k] || fallback} onInput={(e) => up({ [k]: e.currentTarget.value })} />{clear(k, label)}</>)
  const range = (k: 'bgDim' | 'boxAlpha' | 'borderWidth' | 'radius', label: string, min: number, max: number, fallback: number, unit = '') =>
    row(label, <><input type="range" min={min} max={max} value={d[k] ?? fallback} onInput={(e) => up({ [k]: Number(e.currentTarget.value) })} /><output>{d[k] ?? fallback}{unit}</output></>)
  const select = (k: 'bgMode' | 'borderStyle' | 'font' | 'size' | 'nameFx' | 'fx', label: string, options: readonly string[], names: Record<string, string> = {}) =>
    row(label, <select value={d[k] || ''} onChange={(e) => up({ [k]: e.currentTarget.value || undefined })}><option value="">{t('Default')}</option>{options.map((o) => <option value={o}>{t(names[o] || cap(o))}</option>)}</select>)
  const text = (k: 'mood' | 'moodEmoji' | 'about' | 'meet' | 'topTitle' | 'wallTitle', label: string, max: number, ph = '', area = false) => {
    const p = { value: d[k] || '', maxLength: max, placeholder: ph, onInput: (e: { currentTarget: { value: string } }) => up({ [k]: e.currentTarget.value || undefined }) }
    return <label class="field"><span>{label}</span>{area ? <textarea rows={4} {...p} /> : <input {...p} />}</label>
  }
  const image = (k: 'bgImg' | 'banner', label: string) => (
    <div class="lk-row"><span>{label}</span><span class="lk-ctl">
      {d[k] && <Img class="lk-thumb" src={d[k]} />}
      <button type="button" class="btn ghost small" onClick={() => setGif({ pick: (u) => up({ [k]: u }) })}>{t('GIF')}</button>
      <button type="button" class="btn ghost small" onClick={() => upload((u) => up({ [k]: u }))}>{t('Upload')}</button>
      {clear(k, label)}
    </span></div>
  )
  // a new sticker goes on the box in the middle of the screen, where it can be seen and dragged; on a phone the
  // editor folds away to show it
  const addSticker = (src: string) => {
    const at = spot(innerWidth / 2, innerHeight * 0.35)
    const n = d.stickers?.length || 0
    set((x) => ({ ...x, stickers: [...(x.stickers || []), { src, ...at, x: 50, w: 30 }].slice(0, LIMITS.stickers) }))
    if (matchMedia('(max-width: 1099px)').matches) setMin(true)
    focusSticker(n)
    toast('Drag it anywhere')
  }
  const addWall = (u: string) => set((x) => ({ ...x, wall: [...new Set([...(x.wall || []), u])].slice(0, LIMITS.wall) }))
  const group = (title: string, body: ComponentChildren, open = false) => <details class="lk-group" open={open}><summary>{title}</summary>{body}</details>

  return (
    <div class={`lk-edit${min ? ' min' : ''}`} role="dialog" aria-label={t('Customize your profile')}>
      <div class="lk-edit-head">
        <button class="icon-btn" onClick={() => setMin(!min)} aria-label={min ? t('Show the editor') : t('Hide the editor')} aria-expanded={!min}><Icon d={min ? 'M18 15l-6-6-6 6' : 'M6 9l6 6 6-6'} size={20} /></button>
        <b>{t('Customize')}</b>
        <button class="btn ghost small" onClick={close}>{t('Cancel')}</button>
        <button class="btn small" disabled={busy} onClick={save}>{busy ? t('Saving…') : t('Save')}</button>
      </div>
      <input ref={file} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(e) => (gotFile(e.currentTarget.files?.[0]), (e.currentTarget.value = ''))} />
      {/* the editor stays mounted under the picker, so its open groups and scroll survive a pick */}
      {gif && <GifPicker stickers={gif.stickers} pick={(u) => (gif.pick(u), setGif(null))} close={() => setGif(null)} />}
      <div class="lk-edit-body" hidden={!!gif}>
        {group(t('Layouts'), <>
          <div class="lk-presets">{PRESETS.map(([name, p]) => <button class="btn ghost small" onClick={() => up({ ...STYLE, ...p })}>{t(name)}</button>)}</div>
          <div class="lk-design">
            <input value={link} placeholder={t('Paste a design link')} aria-label={t('Design link')} onInput={(e) => setLink(e.currentTarget.value)} onKeyDown={(e) => e.key === 'Enter' && designId(link) && load()} />
            <button class="btn ghost small" disabled={!designId(link)} onClick={load}>{t('Load')}</button>
          </div>
          <div class="btns">
            <button class="btn ghost small" onClick={castIt}>{t('Cast this design')}</button>
            <button class="btn ghost small" onClick={copy}>{t('Copy link')}</button>
          </div>
          <p class="hint">{t('Sharing makes a link to your colors, background, fonts, banner and effect, without your words, friends, GIFs, stickers or song. Paste one here, or tap "Use this design" on a cast, to try it on.')}</p>
        </>, true)}
        {group(t('Background'), <>
          {color('bg', t('Color'), '#ffffff')}
          {image('bgImg', t('Image'))}
          {select('bgMode', t('Image fit'), BG_MODES, { tile: 'Tiled', cover: 'Fill the screen', center: 'Centered once' })}
          {range('bgDim', t('Darken'), 0, 80, 0, '%')}
        </>)}
        {group(t('Effect'), <>
          {select('fx', t('Effect'), FX, Object.fromEntries(FX.map((k) => [k, EFFECTS[k].name])))}
          <p class="hint">{t('Snow, confetti, fireflies and more, moving over your whole profile. Visitors who ask their device for less motion don\'t see it.')}</p>
        </>)}
        {group(t('Stickers ({n}/{max})', { n: d.stickers?.length || 0, max: LIMITS.stickers }), <>
          <div class="lk-wall edit">
            {(d.stickers || []).map((st, i) => <span><Img src={st.src} /><button class="lk-x" aria-label={t('Remove')} onClick={() => set((x) => ({ ...x, stickers: x.stickers!.filter((_, j) => j !== i) }))}>×</button></span>)}
          </div>
          {(d.stickers?.length || 0) < LIMITS.stickers && (
            <div class="btns">
              <button class="btn ghost small" onClick={() => setGif({ pick: addSticker, stickers: true })}>{t('Add a sticker')}</button>
              <button class="btn ghost small" onClick={() => upload(addSticker)}>{t('Upload')}</button>
            </div>
          )}
          <p class="hint">{t('Drag a sticker anywhere on your profile. Tap it, then drag its corner dot to resize and turn it. Stickers stay on the box they sit on, so they land in the same place on phones and computers.')}</p>
        </>)}
        {group(t('Colors and text'), <>
          {color('text', t('Text'), '#000000')}
          {color('muted', t('Quiet text'), '#666666')}
          {color('link', t('Links and buttons'), '#6447f5')}
          {select('font', t('Font'), Object.keys(FONTS), FONT_NAMES)}
          {select('size', t('Text size'), SIZES)}
        </>)}
        {group(t('Boxes'), <>
          {color('box', t('Box color'), '#ffffff')}
          {range('boxAlpha', t('Box opacity'), 0, 100, 90, '%')}
          {color('border', t('Border color'), '#e8e8ec')}
          {select('borderStyle', t('Border style'), BORDERS)}
          {range('borderWidth', t('Border width'), 0, 8, 1, 'px')}
          {range('radius', t('Corners'), 0, 32, 14, 'px')}
        </>)}
        {group(t('Name and mood'), <>
          {select('nameFx', t('Name effect'), NAME_FX)}
          {color('nameColor', t('Effect color'), '#ff3fa4')}
          {image('banner', t('Banner'))}
          {text('moodEmoji', t('Mood emoji'), 8, '😎')}
          {text('mood', t('Mood'), LIMITS.mood, t('chillin'))}
        </>)}
        {group(t('Profile song'), <>
          <label class="field"><span>{t('YouTube link')}</span>
            <input value={song} placeholder="https://youtu.be/…" onInput={(e) => {
              const v = e.currentTarget.value
              setSong(v)
              const id = ytId(v)
              if (id || !v.trim()) up({ song: id ? { id, start: ytStart(v) } : undefined })
            }} />
          </label>
          <p class="hint">{d.song ? d.song.title ? t('Now: {title}', { title: d.song.title }) : t('The song is checked when you save.') : t('Visitors press play to hear it. Add ?t=37 to start partway in.')}</p>
        </>)}
        {group(t('About me'), <>
          {text('about', t('About me'), LIMITS.about, '', true)}
          {text('meet', t("Who I'd like to meet"), LIMITS.meet, '', true)}
        </>)}
        {group(t('Interests'), (Object.keys(INTERESTS) as (keyof typeof INTERESTS)[]).map((k) => (
          <label class="field"><span>{t(INTERESTS[k])}</span>
            <input value={d.interests?.[k] || ''} maxLength={LIMITS.interest} onInput={(e) => {
              const v = e.currentTarget.value
              set((x) => ({ ...x, interests: { ...x.interests, [k]: v || undefined } }))
            }} />
          </label>
        )))}
        {group(t('Top friends ({n}/{max})', { n: d.top?.length || 0, max: LIMITS.top }), <>
          {text('topTitle', t('Title'), LIMITS.title, t('Top {n}', { n: 8 }))}
          <div class="lk-chips">
            {(d.top || []).map((f, i) => {
              const u = users.get(f)
              return (
                <span class="lk-chip">
                  {u && <Avatar u={u} size={22} link={false} />}{u ? nameOf(u) : `fid ${f}`}
                  {i > 0 && <button aria-label={t('Move left')} onClick={() => set((x) => ({ ...x, top: x.top!.map((y, j) => (j === i - 1 ? x.top![i] : j === i ? x.top![i - 1] : y)) }))}>‹</button>}
                  <button aria-label={t('Remove')} onClick={() => set((x) => ({ ...x, top: x.top!.filter((y) => y !== f) }))}>×</button>
                </span>
              )
            })}
          </div>
          {(d.top?.length || 0) < LIMITS.top && (
            <>
              <label class="field"><span>{t('Add someone')}</span><input value={q} placeholder={t('Search people')} onInput={(e) => setQ(e.currentTarget.value)} /></label>
              {found.map((u) => (
                <button class="lk-found" onClick={() => (users.set(u.fid, u), set((x) => ({ ...x, top: [...new Set([...(x.top || []), u.fid])].slice(0, LIMITS.top) })), setQ(''))}>
                  <Avatar u={u} size={28} link={false} /><b>{nameOf(u)}</b><span class="muted">@{u.username}</span>
                </button>
              ))}
            </>
          )}
        </>)}
        {group(t('GIF wall ({n}/{max})', { n: d.wall?.length || 0, max: LIMITS.wall }), <>
          {text('wallTitle', t('Title'), LIMITS.title, t('GIFs'))}
          <div class="lk-wall edit">
            {(d.wall || []).map((u) => <span><Img src={u} /><button class="lk-x" aria-label={t('Remove')} onClick={() => set((x) => ({ ...x, wall: x.wall!.filter((y) => y !== u) }))}>×</button></span>)}
          </div>
          {(d.wall?.length || 0) < LIMITS.wall && (
            <div class="btns">
              <button class="btn ghost small" onClick={() => setGif({ pick: addWall })}>{t('Add a GIF')}</button>
              <button class="btn ghost small" onClick={() => upload(addWall)}>{t('Upload')}</button>
            </div>
          )}
        </>)}
        <button class="btn danger small lk-reset" onClick={() => set(() => ({}))}>{t('Start over (plain profile)')}</button>
        <p class="hint">{t('Images can be up to 6 MB for the background and 4 MB for everything else. People can turn profile looks off in their Settings.')}</p>
      </div>
    </div>
  )
}

type Gif = { url: string; preview: string; title: string }
export function GifPicker({ pick, close, stickers }: { pick: (url: string) => void; close: () => void; stickers?: boolean }) {
  const [q, setQ] = useState('')
  const [list, setList] = useState<Gif[] | null>(null)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => input.current?.focus(), [])
  useEffect(() => {
    let live = true
    const t = setTimeout(() => {
      setList(null)
      fetch(`/api/gifs?q=${encodeURIComponent(q.trim() || 'sparkle')}${stickers ? '&stickers=1' : ''}`).then((r) => r.json()).then((l) => live && setList(Array.isArray(l) ? l : []), () => live && setList([]))
    }, 350)
    return () => ((live = false), clearTimeout(t))
  }, [q, stickers])
  return (
    <div class="lk-edit-body lk-gifs">
      <div class="lk-gifs-head">
        <input ref={input} value={q} placeholder={stickers ? t('Search stickers') : t('Search GIFs')} onInput={(e) => setQ(e.currentTarget.value)} />
        <button class="btn ghost small" onClick={close}>{t('Back')}</button>
      </div>
      {!list ? <div class="spinner" /> : !list.length ? <p class="hint">{t('No GIFs found.')}</p> : (
        <div class="lk-gif-grid">{list.filter((g) => isLookImg(g.url)).map((g) => <button onClick={() => pick(g.url)} aria-label={g.title || t('GIF')}><Img src={g.preview} /></button>)}</div>
      )}
      <p class="hint">{stickers ? t('Stickers from Tenor.') : t('GIFs from Tenor.')}</p>
    </div>
  )
}
