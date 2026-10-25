// Winamp on profiles. A profile's YouTube videos and playlists (Look.amp) play as sound only: YouTube's player sits in
// a hidden frame and is driven over its postMessage API, the same messages its iframe_api script sends. In front is a
// Winamp 2 drawn from a real skin (src/skin.ts), with its main window, equalizer and playlist. It keeps playing from
// page to page: away from the owner's profile it shrinks to the windowshade bar at the bottom, which opens the full
// Winamp as a window over the app, and it comes back (paused) after a reload until it's closed.
import { render } from 'preact'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { go } from './api.ts'
import { t } from './i18n.ts'
import { ampItem, type Amp, type AmpItem } from './shared.ts'
import { loadSkin, type Skin } from './skin.ts'
import { toast } from './ui.tsx'

const KEY = 'quilcast:amp'
const PREFS = 'quilcast:amp-prefs'
const YT = 'https://www.youtube-nocookie.com'
type St = 'play' | 'pause' | 'stop'
// what's playing: someone's list (which the listener may change for themselves) and where in it
type State = {
  fid: number; who: string; name: string; skin?: string; list: AmpItem[]; orig?: AmpItem[]
  i: number; sub: number; at: number; len: number; st: St; title?: string; ids?: string[]
}
// how the listener likes their Winamp, whoever's list it plays
const P0 = {
  vol: 80, bal: 0, shuffle: false, repeat: true, pl: true, eq: false, eqOn: true, eqAuto: false, bands: Array<number>(11).fill(50),
  rem: false, vis: 0, dbl: true, top: false, shade: false, eqShade: false, plShade: false, open: false,
  // the playlist's size past its smallest, in Winamp's steps of 25 px across and 29 px down
  plW: 0, plH: 0,
  // where the window (x, y) and the bar (bx, by) were dragged to; the bar starts centered under the feed
  x: undefined as number | undefined, y: undefined as number | undefined, bx: undefined as number | undefined, by: undefined as number | undefined,
}
type Prefs = typeof P0
const plWidth = () => 275 + pf.plW * 25
const plMid = () => 116 + pf.plH * 29
/** How wide and tall the windows stand, stacked, at 1×. */
const size = () => [pf.pl ? Math.max(275, plWidth()) : 275, (pf.shade ? 14 : 116) + (pf.eq ? (pf.eqShade ? 14 : 116) : 0) + (pf.pl ? (pf.plShade ? 14 : plMid() + 58) : 0)]

const read = (k: string) => {
  try {
    return JSON.parse(localStorage.getItem(k) || 'null')
  } catch {
    return null
  }
}
const write = (k: string, v: unknown) => {
  try {
    v ? localStorage.setItem(k, JSON.stringify(v)) : localStorage.removeItem(k)
  } catch {}
}

let s: State | null = null
// before 0.24.1 the window's settings were kept with the track
let pf: Prefs = { ...P0, ...((({ vol, shuffle, repeat, pl, open, x, y }) => ({ vol, shuffle, repeat, pl, open, x, y }))(read(KEY) || {})), ...read(PREFS) }
for (const k of Object.keys(pf) as (keyof Prefs)[]) if (pf[k] === undefined && !['x', 'y', 'bx', 'by'].includes(k)) (pf as any)[k] = P0[k]
const subs = new Set<() => void>()
const changed = () => subs.forEach((f) => f())
let saved = 0
const save = () => ((saved = Date.now()), write(KEY, s))
// the time changes every half second, so it's written down only every few seconds
const set = (p: Partial<State>, tick = false) => {
  if (!s) return
  s = { ...s, ...p }
  if (!tick || Date.now() - saved > 5e3) save()
  changed()
}
const pref = (p: Partial<Prefs>) => ((pf = { ...pf, ...p }), write(PREFS, pf), changed())
addEventListener('pagehide', () => s && save())
const useAmp = () => {
  const [, force] = useState(0)
  useEffect(() => {
    const f = () => force((x) => x + 1)
    subs.add(f)
    return () => void subs.delete(f)
  }, [])
  return s
}

// --- the hidden YouTube player ---

let frame: HTMLIFrameElement | null = null
let ready = false
let queue: string[] = []
let cur = ''
let last = -9
let fails = 0
const cmd = (func: string, ...args: unknown[]) => {
  const m = JSON.stringify({ event: 'command', func, args, id: 1, channel: 'widget' })
  ready ? frame?.contentWindow?.postMessage(m, YT) : queue.push(m)
}

// the first sound has to come from a tap, so the frame is made right in the click that starts playing
function mount(it: AmpItem, at: number) {
  const q = new URLSearchParams({ autoplay: '1', playsinline: '1', enablejsapi: '1', origin: location.origin })
  if (at) q.set('start', String(Math.floor(at)))
  if (it.pl) q.set('list', it.id), q.set('index', String(s!.sub))
  frame = document.createElement('iframe')
  frame.className = 'wa-yt'
  frame.title = 'YouTube'
  frame.allow = 'autoplay; encrypted-media'
  // the page sends no referrer, and YouTube's player refuses to play without one
  frame.referrerPolicy = 'strict-origin-when-cross-origin'
  frame.src = `${YT}/embed/${it.pl ? 'videoseries' : it.id}?${q}`
  ready = false
  queue = []
  // the player answers once a page says it's listening; iframe_api keeps saying it until it does
  frame.onload = () => {
    let n = 0
    const id = setInterval(() => (ready || ++n > 40 ? clearInterval(id) : frame?.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), YT)), 250)
  }
  document.body.append(frame)
  cmd('setVolume', pf.vol)
}

addEventListener('message', (e) => {
  if (!frame || e.source !== frame.contentWindow || typeof e.data !== 'string') return
  let d: any
  try {
    d = JSON.parse(e.data)
  } catch {
    return
  }
  if (!ready) (ready = true), queue.splice(0).forEach((m) => frame!.contentWindow!.postMessage(m, YT))
  if (d.event === 'onStateChange') state(d.info)
  if (d.event === 'onError') {
    // gone, private or not allowed off YouTube: on to the next one, unless none of them plays
    if (++fails >= (s?.list.length || 0) + (s?.ids?.length || 0)) return stop()
    setTimeout(() => next(true), 500)
  }
  const i = d.event === 'infoDelivery' && d.info
  if (!i || !s) return
  const p: Partial<State> = {}
  if (typeof i.currentTime === 'number') p.at = i.currentTime
  if (i.duration > 0) p.len = i.duration
  if (i.videoData?.title) p.title = i.videoData.title
  const it = s.list[s.i]
  if (it?.pl) {
    if (Array.isArray(i.playlist) && i.playlist.length) (p.ids = i.playlist), sizes.set(it.id, i.playlist.length)
    if (i.playlistIndex >= 0 && i.playlistIndex !== s.sub) {
      // YouTube went on to the playlist's next video by itself: on shuffle, the next one is ours to pick
      if (pf.shuffle && Date.now() - asked > 3e3) return next(true)
      p.sub = i.playlistIndex
    }
  }
  set(p, true)
  // a playlist shuffle took us to, once its length is known: start on a random video of it
  if (randomSub && s.ids?.length) {
    randomSub = false
    const r = Math.floor(Math.random() * s.ids.length)
    if (r !== s.sub) (asked = Date.now()), set({ sub: r, at: 0, len: 0, title: undefined }), cmd('playVideoAt', r)
  }
  if (typeof i.playerState === 'number') state(i.playerState)
})

function state(n: number) {
  if (!s || n === last) return
  last = n
  if (n === 1) (fails = 0), disarm(), set({ st: 'play' })
  // paused from outside, e.g. the phone's lock screen
  else if (n === 2 && s.st === 'play') set({ st: 'pause' })
  else if (n === 0) next(true)
}

let asked = 0
function load(at = 0) {
  const it = s?.list[s.i]
  if (!it) return
  last = -9
  asked = Date.now()
  set({ st: 'play' })
  if (!frame) return void ((cur = it.id), mount(it, at))
  if (it.pl && cur === it.id) return cmd('playVideoAt', s!.sub)
  cur = it.id
  // with a playlist already loaded, YouTube's player loads the one asked for before instead of this one, unless
  // it's stopped first (seen 2026-10-24: switching playlists played the previous one)
  cmd('stopVideo')
  it.pl ? cmd('loadPlaylist', { list: it.id, listType: 'playlist', index: s!.sub, startSeconds: at }) : cmd('loadVideoById', { videoId: it.id, startSeconds: at })
}

const play = () => {
  if (!s) return
  disarm()
  if (s.st === 'pause' && frame) return cmd('playVideo'), set({ st: 'play' })
  load(s.st === 'pause' ? s.at : 0)
}
const pause = () => (s?.st === 'play' ? (cmd('pauseVideo'), set({ st: 'pause' })) : s?.st === 'pause' && play())
const stop = () => (cmd('pauseVideo'), cmd('seekTo', 0, true), set({ st: 'stop', at: 0 }))
const seek = (f: number) => s && s.len && (cmd('seekTo', f * s.len, true), set({ at: f * s.len }))
const volume = (v: number) => (cmd('setVolume', v), pref({ vol: v }))
// how many videos each playlist has, as the player reported them
const sizes = new Map<string, number>()
let randomSub = false
/** Play entry `i` at video `sub` of it (a playlist's; -1 is a random one, once its length is known). */
const pick = (i: number, sub = 0) => {
  randomSub = sub < 0
  set({ i, sub: Math.max(0, sub), at: 0, len: 0, title: undefined, ...(i !== s!.i && { ids: undefined }) })
  load()
}
// where shuffle went, so Previous goes back the same way
let hist: [number, number][] = []
/** Shuffle across every video: one in a playlist is as likely as one on its own, so a 200-song playlist isn't a
 *  single ticket among the other links. A playlist that hasn't played yet counts as 20 until the player says. */
function shuffled() {
  const { list, i, sub } = s!
  const w = list.map((x) => (x.pl ? sizes.get(x.id) || 20 : 1))
  const all = w.reduce((a, b) => a + b, 0)
  for (let tries = 0; tries < 8; tries++) {
    let r = Math.random() * all
    let j = 0
    while (j < w.length - 1 && r >= w[j]) r -= w[j++]
    const it = list[j]
    const n = it.pl ? sizes.get(it.id) : 1
    const k = it.pl ? (n ? Math.floor(Math.random() * n) : -1) : 0
    if (j !== i || (it.pl && k !== sub)) return pick(j, k)
  }
  pick((i + 1) % list.length)
}
function next(auto = false) {
  if (!s) return
  const { i, sub, list, ids } = s
  if (pf.shuffle && (list.length > 1 || list[0]?.pl)) return hist.push([i, sub]), (hist = hist.slice(-100)), shuffled()
  if (list[i]?.pl && ids && sub < ids.length - 1) return pick(i, sub + 1)
  if (i + 1 < list.length || pf.repeat || !auto) return pick((i + 1) % list.length)
  stop()
}
function prev() {
  if (!s) return
  if (pf.shuffle && hist.length) return pick(...hist.pop()!)
  if (s.list[s.i]?.pl && s.sub > 0) return pick(s.i, s.sub - 1)
  pick((s.i - 1 + s.list.length) % s.list.length)
}

/** The listener's own changes to the list (the owner's saved list stays as it is); the track playing stays put. */
function edit(list: AmpItem[]) {
  if (!s) return
  if (!list.length) return close()
  const i = list.indexOf(s.list[s.i])
  if (i >= 0) return set({ list, i })
  set({ list, i: Math.min(s.i, list.length - 1), sub: 0, ids: undefined, title: undefined, at: 0, len: 0 })
  s.st === 'play' ? load() : set({ st: 'stop' })
}

const oembed = (it: AmpItem) =>
  fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(it.pl ? `https://www.youtube.com/playlist?list=${it.id}` : `https://www.youtube.com/watch?v=${it.id}`)}`)
    .then((r) => (r.ok ? r.json() : null)).then((j) => (j?.title ? String(j.title) : null), () => null)
/** Winamp's "Play URL": a YouTube link, added to the list, and played at once unless `later`. */
async function addUrl(later = false) {
  const it = ampItem(prompt(t('YouTube link (a video or a playlist)')) || '')
  if (!it || !s) return
  const title = await oembed(it)
  if (!title) return toast("That YouTube link can't be played on other sites.")
  const old = s.list.find((x) => x.id === it.id)
  if (!old) edit([...s.list, { ...it, title }])
  if (!later) pick(s.list.findIndex((x) => x.id === it.id))
}
const ytUrl = (st: State) => {
  const it = st.list[st.i]
  return it.pl ? (st.ids?.[st.sub] ? `https://www.youtube.com/watch?v=${st.ids[st.sub]}&list=${it.id}` : `https://www.youtube.com/playlist?list=${it.id}`) : `https://www.youtube.com/watch?v=${it.id}`
}

/** Stop and put the Winamp away for good (until someone plays one again). */
export function close() {
  frame?.remove()
  frame = null
  cur = ''
  s = null
  menu = null
  disarm()
  save()
  changed()
}

/** Make `owner`'s list the one playing, stopped at its start. */
function take(o: Owner) {
  if (s?.fid === o.fid) return fresh(o)
  frame?.remove()
  frame = null
  cur = ''
  s = { fid: o.fid, who: o.who, name: o.name, skin: o.amp.skin, list: o.amp.list, orig: o.amp.list, i: 0, sub: 0, at: 0, len: 0, st: 'stop' }
  save()
  mountRoot()
}

/** The owner changed their list or skin since it started playing here: the player takes the new ones (the
 *  listener's own changes to the old list go), and the track playing stays on if it's still in the list. */
function fresh(o: Owner) {
  if (!s || s.fid !== o.fid) return
  if (s.skin !== o.amp.skin) set({ skin: o.amp.skin })
  if (JSON.stringify(s.orig) === JSON.stringify(o.amp.list)) return
  const playing = s.list[s.i]?.id
  set({ orig: o.amp.list })
  edit(o.amp.list.map((x) => (x.id === playing ? s!.list[s!.i] : x)))
}

// coming back to a page that was playing, it starts again where it was. Browsers allow sound without a tap only on
// sites people often play media on (Chrome), so when it hasn't started after a few seconds it waits for the first
// tap or key anywhere and starts from there (the frame is made again inside that tap, which every browser allows).
const first = (e: Event) => {
  if ((e.target as Element).closest?.('.wa, .wa-menu') || !s) return
  disarm()
  if (last === 1) return
  frame?.remove()
  frame = null
  cur = ''
  set({ st: 'pause' })
  play()
}
const disarm = () => (removeEventListener('pointerdown', first, true), removeEventListener('keydown', first, true))
{
  const j = read(KEY)
  if (j?.list?.length) {
    s = { fid: j.fid, who: j.who, name: j.name, skin: j.skin, list: j.list, orig: j.orig || j.list, i: j.i, sub: j.sub, at: j.at, len: j.len, title: j.title, ids: j.ids, st: j.st === 'stop' ? 'stop' : 'pause' }
    if (j.st === 'play') {
      addEventListener('pointerdown', first, true)
      addEventListener('keydown', first, true)
      setTimeout(() => {
        if (!s || frame || s.st !== 'pause') return
        load(s.at)
        setTimeout(() => last !== 1 && frame && s?.st === 'play' && ((frame.remove(), (frame = null), (cur = '')), set({ st: 'pause' })), 5e3)
      })
    }
  }
}

// --- menus (Winamp's are the system's own, so these look like Windows ones) ---

type Item = [label: string, run: () => void, on?: boolean] | null
let menu: { x: number; y: number; items: Item[] } | null = null
const openMenu = (e: MouseEvent, items: Item[]) => {
  e.preventDefault()
  e.stopPropagation()
  menu = { x: e.clientX, y: e.clientY, items }
  changed()
}
const shut = () => menu && ((menu = null), changed())
addEventListener('pointerdown', (e) => !(e.target as Element).closest?.('.wa-menu') && shut(), true)
addEventListener('keydown', (e) => e.key === 'Escape' && shut())

function Menu() {
  const ref = useRef<HTMLDivElement>(null)
  const [xy, setXy] = useState<[number, number] | null>(null)
  // it opens where it was asked for, moved back inside the window if it would run off an edge
  useLayoutEffect(() => {
    if (!menu || !ref.current) return setXy(null)
    const r = ref.current.getBoundingClientRect()
    setXy([Math.max(4, Math.min(menu.x, innerWidth - r.width - 4)), Math.max(4, Math.min(menu.y, innerHeight - r.height - 4))])
    ref.current.querySelector('button')?.focus()
  }, [menu])
  if (!menu) return null
  return (
    <div class="wa-menu" ref={ref} role="menu" style={{ left: `${xy?.[0] ?? menu.x}px`, top: `${xy?.[1] ?? menu.y}px`, visibility: xy ? 'visible' : 'hidden' }}>
      {menu.items.map((it) => (it ? (
        <button role={it[2] === undefined ? 'menuitem' : 'menuitemcheckbox'} aria-checked={it[2]} onClick={() => (shut(), it[1]())}>
          <span>{it[2] ? '✓' : ''}</span>{it[0]}
        </button>
      ) : <hr />))}
    </div>
  )
}

const VIS: [string, number][] = [['Spectrum analyzer', 0], ['Oscilloscope', 1], ['No visualization', 2]]
const visItems = (): Item[] => VIS.map(([l, n]) => [t(l), () => pref({ vis: n }), pf.vis === n])
const skinPage = (md5?: string) => open(`https://skins.webamp.org/skin/${md5 || BASE_MD5}/`, '_blank', 'noopener')
const BASE_MD5 = '5e4f10275dcb1fb211d4a8b4f1bda236'
/** The main menu (the button at the top left, the O on the side, or a right click). */
const options = (skin?: string, win = true): Item[] => [
  [t('Play a YouTube link…'), () => addUrl()],
  ...(s ? [[t("{name}'s profile", { name: s.name }), () => go(s!.who)] as Item] : []),
  null,
  [t('Playlist editor'), () => pref({ pl: !pf.pl }), pf.pl],
  [t('Equalizer'), () => pref({ eq: !pf.eq }), pf.eq],
  [t('Always on top'), () => pref({ top: !pf.top }), pf.top],
  [t('Double size'), () => pref({ dbl: !pf.dbl }), pf.dbl],
  [t('Time remaining'), () => pref({ rem: !pf.rem }), pf.rem],
  null,
  ...visItems(),
  null,
  [t('About this skin'), () => skinPage(skin)],
  ...(s ? [[win ? t('Close Winamp') : t('Stop'), win ? close : stop] as Item] : []),
]

// --- drawing it ---

const FONT = new Map<string, [number, number]>()
;['abcdefghijklmnopqrstuvwxyz"@', "0123456789….:()-'!_+\\/[]^&%,=$#", 'ÅÖÄ?*'].forEach((r, y) => [...r].forEach((c, x) => FONT.set(c, [x, y])))
FONT.set(' ', [30, 0])
for (const [a, b] of ['<[', '>]', '{[', '}]']) FONT.set(a, FONT.get(b)!)
/** Text in the skin's own pixel font (TEXT.BMP); letters it doesn't have fall back to a real font. */
const chars = (str: string) => [...str].map((c) => {
  const p = FONT.get(c.toLowerCase()) || FONT.get(c.toUpperCase())
  return p ? <i class="wa-ch" style={{ backgroundPosition: `-${p[0] * 5}px -${p[1] * 6}px` }} /> : <i class="wa-u">{c}</i>
})
const mmss = (n: number) => `${String(Math.min(99, Math.floor(n / 60))).padStart(2, '0')}:${String(Math.floor(n % 60)).padStart(2, '0')}`
const mss = (n: number) => mmss(n).replace(/^0/, '')
const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches
// the time shown: gone by, or (Winamp's other mode) still to go
const shown = (v: View) => (pf.rem && v.len ? Math.max(0, v.len - v.at) : v.at)

function Marquee({ text, width = 154, cls = 'wa-marquee' }: { text: string; width?: number; cls?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [w, setW] = useState(0)
  const [x, setX] = useState(0)
  useLayoutEffect(() => (setX(0), setW(ref.current!.offsetWidth)), [text])
  // longer than the display: it goes round, five pixels at a time, with "***" between the ends
  const long = w > width
  useEffect(() => {
    if (!long || still()) return
    const id = setInterval(() => setX((x) => (x + 5) % (w + 35)), 220)
    return () => clearInterval(id)
  }, [w])
  return <div class={cls}><div class="wa-mq" style={{ transform: `translateX(-${x}px)` }}><span ref={ref}>{chars(text)}</span>{long && <>{chars('  ***  ')}{chars(text)}</>}</div></div>
}

// YouTube's sound can't be read from the page, so the visualizer is for the look: it moves in the skin's colors
// while something plays. A click switches between the analyzer, the scope and nothing, as in Winamp.
function Vis({ on, vis, mode, click }: { on: boolean; vis: string[]; mode: number; click: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current!.getContext('2d')!
    const bars = Array<number>(19).fill(0)
    let raf = 0
    let then = 0
    let ph = 0
    const draw = (now: number) => {
      if (on && mode < 2 && !still()) raf = requestAnimationFrame(draw)
      if (now - then < 50) return
      then = now
      c.fillStyle = vis[0]
      c.fillRect(0, 0, 76, 16)
      c.fillStyle = vis[1]
      for (let x = 1; x < 76; x += 2) for (let y = 1; y < 16; y += 2) c.fillRect(x, y, 1, 1)
      if (!on || mode === 2) return
      if (mode === 1) {
        // the scope: a wobbling line, colored by how far it swings (VISCOLOR's 18–22)
        ph += 0.7
        const amp = 3 + Math.random() * 4
        for (let x = 0; x < 76; x++) {
          const y = Math.round(7.5 + Math.sin(x / 4 + ph) * amp * Math.sin(x / 19 + ph / 3) + (Math.random() - 0.5) * 2)
          c.fillStyle = vis[18 + Math.min(4, Math.abs(y - 7.5) | 0)] || vis[18]
          c.fillRect(x, Math.max(0, Math.min(15, y)), 1, 1)
        }
        return
      }
      bars.forEach((h, i) => {
        const want = Math.random() ** 1.6 * 17 * (1 - i / 28)
        h = bars[i] = want > h ? want : Math.max(0, h - 1.5)
        for (let y = 16 - Math.min(16, Math.round(h)); y < 16; y++) (c.fillStyle = vis[2 + y]), c.fillRect(i * 4, y, 3, 1)
      })
    }
    draw(100)
    return () => cancelAnimationFrame(raf)
  }, [on, vis, mode])
  return <canvas class="wa-vis" width={76} height={16} ref={ref} onClick={click} role="button" aria-label={t('Visualization')} />
}

/** Drag along a bar: `to` gets the share of its width (or height, top first) as the pointer moves, `end` the last one. */
const drag = (to: (f: number) => void, end?: (f: number) => void, down = false) => (e: PointerEvent) => {
  if (e.button) return
  const el = e.currentTarget as HTMLElement
  const r = el.getBoundingClientRect()
  const f = (ev: PointerEvent) => Math.min(1, Math.max(0, down ? (ev.clientY - r.top) / r.height : (ev.clientX - r.left) / r.width))
  el.setPointerCapture(e.pointerId)
  to(f(e))
  el.onpointermove = (ev) => to(f(ev))
  el.onpointerup = el.onpointercancel = (ev) => ((el.onpointermove = el.onpointerup = el.onpointercancel = null), end?.(f(ev)))
}

const vars = (k: Skin) => {
  const v: Record<string, string> = { '--wa-fg': k.pl.normal, '--wa-cur': k.pl.current, '--wa-bg': k.pl.bg, '--wa-sel': k.pl.sel, '--wa-font': `"${k.pl.font}", Arial, sans-serif` }
  for (const [n, u] of Object.entries(k.img)) v[`--s-${n}`] = `url("${u}")`
  v['--s-num'] = v['--s-nums_ex'] || v['--s-numbers']
  return v
}
const useSkin = (md5?: string) => {
  const [k, setK] = useState<Skin | null>(null)
  useEffect(() => {
    let live = true
    loadSkin(md5).then((k) => live && setK(k), () => {})
    return () => void (live = false)
  }, [md5])
  return k
}

type Owner = { fid: number; who: string; name: string; amp: Amp }
// what a Winamp shows: the one playing, or a profile's list, stopped, until it's played
type View = Pick<State, 'list' | 'i' | 'sub' | 'at' | 'len' | 'st' | 'title' | 'ids'>
const idle = (a: Amp): View => ({ list: a.list, i: 0, sub: 0, at: 0, len: 0, st: 'stop' })
// what the title bar buttons do where this Winamp is: over the app (`float`) or on a profile
type Win = { float: boolean; min: () => void; close: () => void; move?: (e: PointerEvent) => void }

/** The windowshade bar: the main window folded to its title bar, with small controls. */
function ShadeBar({ v, md5, a, win, unshade }: { v: View; md5?: string; a: (f: () => void) => () => void; win: Win; unshade: () => void }) {
  const frac = v.len ? Math.min(1, v.at / v.len) : 0
  return (
    <div class="wa-sh" onPointerDown={win.move} onDblClick={(e) => !justMoved() && !(e.target as Element).closest('button, .wa-sh-pos') && unshade()}
      onClick={(e) => !win.float && !justMoved() && e.target === e.currentTarget && unshade()} onContextMenu={(e) => openMenu(e, options(md5, win.float))}>
      <button class="wa-opt" aria-label={t('Options')} aria-haspopup="menu" onClick={(e) => openMenu(e, options(md5, win.float))} />
      <button class="wa-min" aria-label={t('Minimize')} onClick={win.min} />
      <button class="wa-unshade" aria-label={t('Open Winamp')} onClick={unshade} />
      <button class="wa-close" aria-label={win.float ? t('Close Winamp') : t('Close Winamp')} onClick={win.close} />
      <button class="wa-sh-time" aria-label={t('Time remaining')} onClick={() => pref({ rem: !pf.rem })}>{v.st === 'stop' ? null : chars((pf.rem && v.len ? '-' : ' ') + mss(shown(v)).padStart(4, ' '))}</button>
      <button class="wa-sp" style={{ left: '169px', width: '7px' }} aria-label={t('Previous')} onClick={a(prev)} />
      <button class="wa-sp" style={{ left: '176px', width: '10px' }} aria-label={t('Play')} onClick={a(play)} />
      <button class="wa-sp" style={{ left: '186px', width: '9px' }} aria-label={t('Pause')} onClick={a(pause)} />
      <button class="wa-sp" style={{ left: '195px', width: '9px' }} aria-label={t('Stop')} onClick={a(stop)} />
      <button class="wa-sp" style={{ left: '204px', width: '10px' }} aria-label={t('Next')} onClick={a(() => next())} />
      <button class="wa-sp" style={{ left: '215px', width: '10px' }} aria-label={t('Play a YouTube link…')} onClick={a(() => addUrl())} />
      <div class="wa-sh-pos" role="slider" aria-label={t('Position')} aria-valuenow={Math.round(v.at)} onPointerDown={v.st !== 'stop' && v.len ? drag(() => {}, seek) : undefined}>
        {v.st !== 'stop' && <i style={{ left: `${Math.round(frac * 14)}px` }} />}
      </div>
    </div>
  )
}

const CLUTTER: [string, string][] = [['o', 'Options'], ['a', 'Always on top'], ['i', 'Track info on YouTube'], ['d', 'Double size'], ['v', 'Visualization']]

/** The main window, the equalizer and the playlist. `before` runs ahead of every control (a profile's list takes over). */
function Winamp({ v, k, md5, before = () => {}, win }: { v: View; k: Skin; md5?: string; before?: () => void; win: Win }) {
  const [pos, setPos] = useState<number | null>(null)
  const a = (f: () => void) => () => (before(), f())
  const it = v.list[v.i]
  const name = (it?.pl && v.title) || it?.title || ''
  const frac = pos ?? (v.len ? Math.min(1, v.at / v.len) : 0)
  const shade = () => pref({ shade: !pf.shade })
  const clutter = (c: string, e: MouseEvent) =>
    c === 'o' ? openMenu(e, options(md5, win.float))
      : c === 'a' ? pref({ top: !pf.top })
        : c === 'i' ? s && s.fid && v === s && open(ytUrl(s), '_blank', 'noopener')
          : c === 'd' ? pref({ dbl: !pf.dbl })
            : openMenu(e, visItems())
  const bal = Math.round(Math.abs(pf.bal) / 100 * 27)
  return (
    <div class="wa" data-st={v.st} data-ex={k.img.nums_ex ? '' : undefined} style={vars(k)} onContextMenu={(e) => openMenu(e, options(md5, win.float))}>
      {pf.shade ? <ShadeBar v={v} md5={md5} a={a} win={win} unshade={shade} /> : (
        <div class="wa-main">
          <div class="wa-tb" onPointerDown={win.move} onDblClick={(e) => !(e.target as Element).closest('button') && shade()}>
            <button class="wa-opt" aria-label={t('Options')} aria-haspopup="menu" onClick={(e) => openMenu(e, options(md5, win.float))} />
            <button class="wa-min" aria-label={win.float ? t('Minimize') : t('Open Winamp')} onClick={win.min} />
            <button class="wa-shade" aria-label={t('Shade')} onClick={shade} />
            <button class="wa-close" aria-label={win.float ? t('Close Winamp') : t('Stop')} onClick={win.close} />
          </div>
          <div class="wa-clutter">
            {CLUTTER.map(([c, l]) => <button class={`c-${c}${(c === 'a' && pf.top) || (c === 'd' && pf.dbl) ? ' on' : ''}`} aria-label={t(l)} aria-pressed={c === 'a' ? pf.top : c === 'd' ? pf.dbl : undefined} onClick={(e) => clutter(c, e)} />)}
          </div>
          <div class="wa-st" />
          {v.st === 'play' && <div class="wa-work" />}
          <button class="wa-time" aria-label={t('Time remaining')} aria-pressed={pf.rem} onClick={() => pref({ rem: !pf.rem })}>
            {pf.rem && v.len > 0 && <i class="wa-minus" />}
            {[...mmss(shown(v)).replace(':', '')].map((d, i) => <i class={`wa-d d${i}`} style={{ backgroundPosition: `-${Number(d) * 9}px 0` }} />)}
          </button>
          <Vis on={v.st === 'play'} vis={k.vis} mode={pf.vis} click={() => pref({ vis: (pf.vis + 1) % 3 })} />
          <Marquee text={it ? `${v.i + 1}. ${name}${v.len ? ` (${mss(v.len)})` : ''}` : 'Winamp'} />
          {v.st !== 'stop' && <div class="wa-kbps">{chars('128')}</div>}
          {v.st !== 'stop' && <div class="wa-khz">{chars('44')}</div>}
          <div class="wa-mono" />
          <div class={`wa-stereo${v.st === 'play' ? ' on' : ''}`} />
          <div class="wa-vol" style={{ backgroundPosition: `0 -${Math.round(pf.vol / 100 * 27) * 15}px` }} role="slider" aria-label={t('Volume')} aria-valuenow={pf.vol} tabIndex={0}
            onPointerDown={drag((f) => volume(Math.round(f * 100)))}
            onKeyDown={(e) => (e.key === 'ArrowRight' || e.key === 'ArrowLeft') && volume(Math.min(100, Math.max(0, pf.vol + (e.key === 'ArrowRight' ? 5 : -5))))}>
            <i style={{ left: `${Math.round(pf.vol / 100 * 51)}px` }} />
          </div>
          {/* YouTube's player has no balance, so this one is for the look; it snaps to the middle like Winamp's */}
          <div class="wa-bal" style={{ backgroundPosition: `-9px -${bal * 15}px` }} role="slider" aria-label={t('Balance')} aria-valuenow={pf.bal} tabIndex={0}
            onPointerDown={drag((f) => pref({ bal: Math.abs(f * 200 - 100) < 12 ? 0 : Math.round(f * 200 - 100) }))}>
            <i style={{ left: `${Math.round((pf.bal + 100) / 200 * 24)}px` }} />
          </div>
          <button class={`wa-eqb${pf.eq ? ' on' : ''}`} aria-label={t('Equalizer')} aria-pressed={pf.eq} onClick={() => pref({ eq: !pf.eq })} />
          <button class={`wa-plb${pf.pl ? ' on' : ''}`} aria-label={t('Playlist editor')} aria-pressed={pf.pl} onClick={() => pref({ pl: !pf.pl })} />
          <div class="wa-pos" role="slider" aria-label={t('Position')} aria-valuenow={Math.round(v.at)}
            onPointerDown={v.st !== 'stop' && v.len ? drag(setPos, (f) => (setPos(null), seek(f))) : undefined}>
            {v.st !== 'stop' && <i style={{ left: `${Math.round(frac * 219)}px` }} />}
          </div>
          <button class="wa-btn wa-prev" aria-label={t('Previous')} onClick={a(prev)} />
          <button class="wa-btn wa-play" aria-label={t('Play')} onClick={a(play)} />
          <button class="wa-btn wa-pause" aria-label={t('Pause')} onClick={a(pause)} />
          <button class="wa-btn wa-stop" aria-label={t('Stop')} onClick={a(stop)} />
          <button class="wa-btn wa-next" aria-label={t('Next')} onClick={a(() => next())} />
          <button class="wa-eject" aria-label={t('Play a YouTube link…')} onClick={a(() => addUrl())} />
          <button class={`wa-shuf${pf.shuffle ? ' on' : ''}`} aria-label={t('Shuffle')} aria-pressed={pf.shuffle} onClick={() => pref({ shuffle: !pf.shuffle })} />
          <button class={`wa-rep${pf.repeat ? ' on' : ''}`} aria-label={t('Repeat')} aria-pressed={pf.repeat} onClick={() => pref({ repeat: !pf.repeat })} />
          <button class="wa-about" aria-label={t('About this skin')} onClick={() => skinPage(md5)} />
        </div>
      )}
      {pf.eq && <Eq k={k} move={win.move} />}
      {pf.pl && <List v={v} a={a} move={win.move} />}
    </div>
  )
}

// Winamp's presets, as slider places (50 is 0 dB, 100 is +12): 60 Hz to 16 kHz
const PRESETS: [string, number[]][] = [
  ['Flat', [50, 50, 50, 50, 50, 50, 50, 50, 50, 50]],
  ['Classical', [50, 50, 50, 50, 50, 50, 32, 32, 32, 29]],
  ['Club', [50, 50, 60, 66, 66, 66, 60, 50, 50, 50]],
  ['Dance', [75, 68, 54, 50, 50, 32, 29, 29, 50, 50]],
  ['Full bass', [75, 75, 75, 66, 54, 39, 29, 23, 21, 21]],
  ['Full treble', [25, 25, 25, 39, 57, 78, 89, 89, 89, 93]],
  ['Pop', [45, 62, 68, 70, 63, 47, 43, 43, 45, 45]],
  ['Rock', [70, 61, 36, 30, 40, 60, 73, 79, 79, 79]],
  ['Techno', [70, 66, 50, 36, 39, 50, 70, 73, 73, 72]],
]
const HZ = ['60', '170', '310', '600', '1K', '3K', '6K', '12K', '14K', '16K']

// The equalizer. YouTube doesn't let a page change its sound, so it keeps its settings and draws them, and that's all.
function Eq({ k, move }: { k: Skin; move?: (e: PointerEvent) => void }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const b = pf.bands
  useEffect(() => {
    const c = ref.current?.getContext('2d')
    if (!c) return
    c.clearRect(0, 0, 113, 19)
    // the curve through the ten bands, a pixel a column, colored by height from the skin's strip
    const ys = b.slice(1).map((v) => (1 - v / 100) * 18)
    for (let x = 0; x < 113; x++) {
      const f = Math.min(8.999, Math.max(0, (x - 2) / 108 * 9))
      const j = Math.floor(f)
      const y = Math.round(ys[j] + (ys[j + 1] - ys[j]) * (f - j))
      c.fillStyle = k.eqLine[y]
      c.fillRect(x, y, 1, 1)
    }
  }, [b.join(), k])
  const band = (i: number) => drag((f) => {
    const v = Math.round((1 - f) * 100)
    const bands = [...pf.bands]
    bands[i] = Math.abs(v - 50) < 4 ? 50 : v
    pref({ bands })
  }, undefined, true)
  const n = (v: number) => Math.round(v / 100 * 27)
  if (pf.eqShade) return (
    <div class="wa-eq shade" onPointerDown={move} title={t("YouTube doesn't let pages change its sound, so the equalizer only keeps your settings.")}>
      <button class="wa-eq-unshade" aria-label={t('Open the equalizer')} onClick={() => pref({ eqShade: false })} />
      <button class="wa-eq-sx" aria-label={t('Close the equalizer')} onClick={() => pref({ eq: false })} />
    </div>
  )
  return (
    <div class="wa-eq" title={t("YouTube doesn't let pages change its sound, so the equalizer only keeps your settings.")}>
      <div class="wa-eq-tb" onPointerDown={move} onDblClick={() => pref({ eqShade: true })}>
        <button class="wa-eq-shade" aria-label={t('Shade')} onClick={() => pref({ eqShade: true })} />
        <button class="wa-eq-x" aria-label={t('Close the equalizer')} onClick={() => pref({ eq: false })} />
      </div>
      <button class={`wa-eq-on${pf.eqOn ? ' on' : ''}`} aria-label={t('Equalizer on')} aria-pressed={pf.eqOn} onClick={() => pref({ eqOn: !pf.eqOn })} />
      <button class={`wa-eq-auto${pf.eqAuto ? ' on' : ''}`} aria-label={t('Auto')} aria-pressed={pf.eqAuto} onClick={() => pref({ eqAuto: !pf.eqAuto })} />
      <canvas class="wa-eq-graph" width={113} height={19} ref={ref} />
      <button class="wa-eq-pre" aria-label={t('Presets')} aria-haspopup="menu"
        onClick={(e) => openMenu(e, PRESETS.map(([l, v]) => [t(l), () => pref({ bands: [pf.bands[0], ...v] }), v.join() === pf.bands.slice(1).join()] as Item))} />
      {b.map((v, i) => (
        <div class="wa-band" style={{ left: `${i ? 78 + (i - 1) * 18 : 21}px`, backgroundPosition: `-${13 + (n(v) % 14) * 15}px -${164 + Math.floor(n(v) / 14) * 65}px` }}
          role="slider" aria-label={i ? `${HZ[i - 1]}Hz` : t('Preamp')} aria-valuenow={v} onPointerDown={band(i)}>
          <i style={{ top: `${Math.round((1 - v / 100) * 51)}px` }} />
        </div>
      ))}
    </div>
  )
}

// titles of a playlist's videos, which only the one playing brings along
const titles = new Map<string, Promise<string>>()
const titleOf = (id: string) => {
  if (!titles.has(id)) titles.set(id, oembed({ id }).then((x) => x || id))
  return titles.get(id)!
}
function Title({ id }: { id: string }) {
  const [x, setX] = useState('')
  useEffect(() => void titleOf(id).then(setX), [id])
  return <>{x || '…'}</>
}
const touch = () => matchMedia('(pointer: coarse)').matches
const byTitle = (x: AmpItem, y: AmpItem) => (x.title || x.id).localeCompare(y.title || y.id)

// the corner at the playlist's bottom right resizes it in Winamp's steps (the page may be zoomed, so pixels are
// measured against the window's drawn size)
function resize(e: PointerEvent) {
  if (e.button) return
  e.stopPropagation()
  const el = e.currentTarget as HTMLElement
  const box = el.parentElement!
  const z = box.getBoundingClientRect().width / box.offsetWidth
  const [x0, y0, w0, h0] = [e.clientX, e.clientY, pf.plW, pf.plH]
  el.setPointerCapture(e.pointerId)
  el.onpointermove = (ev) => {
    const plW = Math.min(12, Math.max(0, w0 + Math.round((ev.clientX - x0) / z / 25)))
    const plH = Math.min(16, Math.max(0, h0 + Math.round((ev.clientY - y0) / z / 29)))
    if (plW !== pf.plW || plH !== pf.plH) pref({ plW, plH })
  }
  el.onpointerup = el.onpointercancel = () => (el.onpointermove = el.onpointerup = el.onpointercancel = null)
}

/** The playlist folded to a strip: what's playing (going round when it's long) and its length. */
function PlStrip({ v, move, open, close }: { v: View; move?: (e: PointerEvent) => void; open: () => void; close: () => void }) {
  const it = v.list[v.i]
  const now = it ? `${v.i + 1}. ${(it.pl && v.title) || it.title || it.id}` : ''
  return (
    <div class="wa-pl shade" style={{ width: `${plWidth()}px` }} onPointerDown={move}>
      <i class="l" /><i class="r" />
      <div class="wa-pls-box" style={{ width: `${plWidth() - 75}px` }}><Marquee text={now} width={plWidth() - 75} cls="wa-pls-title" /></div>
      <span class="wa-pls-time">{v.len ? chars(mss(v.len)) : null}</span>
      <button class="wa-pl-sh" aria-label={t('Open the playlist')} onClick={open} />
      <button class="wa-pl-x" aria-label={t('Close the playlist')} onClick={close} />
    </div>
  )
}

function List({ v, a, move }: { v: View; a: (f: () => void) => () => void; move?: (e: PointerEvent) => void }) {
  const box = useRef<HTMLDivElement>(null)
  const [top, setTop] = useState(0)
  // the row picked with a click (a double click, or a tap on a phone, plays it)
  const [sel, setSel] = useState<number | null>(null)
  const scrolled = () => {
    const el = box.current!
    setTop(el.scrollHeight > el.clientHeight ? el.scrollTop / (el.scrollHeight - el.clientHeight) : 0)
  }
  const scrollTo = (f: number) => {
    const el = box.current!
    el.scrollTop = f * (el.scrollHeight - el.clientHeight)
  }
  const page = (d: number) => box.current!.scrollBy({ top: d * box.current!.clientHeight })
  useEffect(() => void box.current?.querySelector('.cur')?.scrollIntoView({ block: 'nearest' }), [v.i, v.sub])
  useEffect(() => setSel(null), [v.list])
  const playRow = (i: number, sub = 0) => a(() => pick(i, sub))()
  const row = (i: number, sub?: number) => ({
    onClick: () => (touch() ? playRow(i, sub) : sub === undefined && setSel(i)),
    onDblClick: () => playRow(i, sub),
    onKeyDown: (e: KeyboardEvent) => e.key === 'Enter' && (e.preventDefault(), playRow(i, sub)),
  })
  // the bottom buttons' menus; changes are the listener's own, and LIST puts the owner's list back
  const list = () => s!.list
  const menus: Record<string, () => Item[]> = {
    add: () => [[t('Add a YouTube link…'), a(() => addUrl(true))]],
    rem: () => [
      [t('Remove selected'), a(() => sel !== null && edit(list().filter((_, i) => i !== sel)))],
      [t('Crop to selected'), a(() => sel !== null && edit([list()[sel]]))],
    ],
    sel: () => [[t('Select the playing track'), () => setSel(v.i)], [t('Select none'), () => setSel(null)]],
    misc: () => [
      [t('Sort by title'), a(() => edit([...list()].sort(byTitle)))],
      [t('Reverse the list'), a(() => edit([...list()].reverse()))],
      [t('Randomize the list'), a(() => edit([...list()].map((x) => [Math.random(), x] as const).sort((x, y) => x[0] - y[0]).map((x) => x[1])))],
      [t('Track info on YouTube'), a(() => s && open(ytUrl(s), '_blank', 'noopener'))],
    ],
    list: () => [
      [t("Back to {name}'s list", { name: s?.name || '' }), a(() => s?.orig && edit(s.orig))],
      [t('Copy the list links'), () => navigator.clipboard.writeText(v.list.map((x) => (x.pl ? `https://www.youtube.com/playlist?list=${x.id}` : `https://youtu.be/${x.id}`)).join('\n')).then(() => toast('Links copied'), () => {})],
    ],
  }
  if (pf.plShade) return <PlStrip v={v} move={move} open={() => pref({ plShade: false })} close={() => pref({ pl: false })} />
  return (
    <div class="wa-pl" style={{ width: `${plWidth()}px`, height: `${plMid() + 58}px` }}>
      <div class="wa-pl-top" onPointerDown={move} onDblClick={(e) => !(e.target as Element).closest('button') && pref({ plShade: true })}>
        <i class="l" /><i class="t" /><i class="r" />
        <button class="wa-pl-sh" aria-label={t('Shade')} onClick={() => pref({ plShade: true })} />
        <button class="wa-pl-x" aria-label={t('Close the playlist')} onClick={() => pref({ pl: false })} />
      </div>
      <div class="wa-pl-mid" style={{ height: `${plMid()}px` }}>
        <i class="l" />
        <div class="r" onPointerDown={drag(scrollTo, undefined, true)}><i class="wa-pl-thumb" style={{ top: `${Math.round(top * (plMid() - 18))}px` }} /></div>
        <div class="wa-rows" ref={box} onScroll={scrolled}>
          {v.list.map((x, i) => (
            <>
              <button class={`wa-row${i === v.i && !x.pl ? ' cur' : ''}${sel === i ? ' sel' : ''}`} {...row(i)}>
                <span>{i + 1}. {x.pl ? '▸ ' : ''}{x.title || x.id}</span>{i === v.i && !x.pl && v.len ? <span>{mss(v.len)}</span> : null}
              </button>
              {x.pl && i === v.i && v.ids?.map((id, j) => (
                <button class={`wa-row sub${j === v.sub ? ' cur' : ''}`} {...row(i, j)}>
                  <span>{j + 1}. {j === v.sub && v.title ? v.title : <Title id={id} />}</span>{j === v.sub && v.len ? <span>{mss(v.len)}</span> : null}
                </button>
              ))}
            </>
          ))}
        </div>
      </div>
      <div class="wa-pl-bot">
        <i class="l" /><i class="r" />
        {(['add', 'rem', 'sel', 'misc', 'list'] as const).map((m) => (
          <button class={`wa-plm m-${m}`} aria-label={t(m === 'add' ? 'Add' : m === 'rem' ? 'Remove' : m === 'sel' ? 'Select' : m === 'misc' ? 'Misc' : 'List')} aria-haspopup="menu" onClick={(e) => openMenu(e, menus[m]())} />
        ))}
        <div class="wa-pl-br">
          <span class="wa-pl-run">{v.st === 'stop' ? null : chars(`${mss(v.at)}/${mss(v.len)}`)}</span>
          <button class="wa-pl-mini" aria-label={t('Time remaining')} onClick={() => pref({ rem: !pf.rem })}>{v.st === 'stop' ? null : chars((pf.rem && v.len ? '-' : ' ') + mss(shown(v)).padStart(4, ' '))}</button>
          {([[prev, 'Previous'], [play, 'Play'], [pause, 'Pause'], [stop, 'Stop'], [() => next(), 'Next'], [() => addUrl(), 'Play a YouTube link…']] as const).map(([f, l], i) => (
            <button class="wa-pl-tp" style={{ left: `${3 + i * 10}px` }} aria-label={t(l)} onClick={a(f)} />
          ))}
        </div>
        <button class="wa-pl-up" aria-label={t('Scroll up')} onClick={() => page(-1)} />
        <button class="wa-pl-down" aria-label={t('Scroll down')} onClick={() => page(1)} />
      </div>
      <div class="wa-pl-grip" role="slider" aria-label={t('Resize the playlist')} onPointerDown={resize} />
    </div>
  )
}

/** A profile's Winamp: the one playing when it's this profile's list, else that list ready to play. */
export function ProfileAmp({ owner }: { owner: Owner }) {
  const live = useAmp()
  const k = useSkin(owner.amp.skin)
  const box = useRef<HTMLDivElement>(null)
  const z = useFit(box, size()[0])
  const mine = live?.fid === owner.fid
  // while it's on screen here, the bar at the bottom steps aside
  useEffect(() => fresh(owner), [owner.amp])
  useEffect(() => {
    mountRoot()
    showing.add(owner.fid)
    changed()
    return () => (showing.delete(owner.fid), changed())
  }, [owner.fid])
  const before = () => take(owner)
  // the minimize button takes it off the page into a window over the app
  const win: Win = { float: false, min: () => (before(), pref({ open: true })), close: () => (before(), stop()) }
  return (
    <div class="wa-in" ref={box}>
      {k ? <div style={{ zoom: z }}><Winamp v={mine ? live : idle(owner.amp)} k={k} md5={owner.amp.skin} before={before} win={win} /></div> : <div class="wa-wait" />}
    </div>
  )
}
const showing = new Set<number>()

// pixels stay sharp at whole sizes, and a phone gets as much as fits
// (a playlist made wider than the room shrinks the whole Winamp rather than spill out)
function useFit(ref: { current: HTMLElement | null }, w: number) {
  const [z, setZ] = useState(1)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const o = new ResizeObserver(() => setZ(fit(el.clientWidth, w)))
    o.observe(el)
    return () => o.disconnect()
  }, [w, pf.dbl])
  return z
}
const fit = (room: number, w: number) => (room < w ? room / w : pf.dbl ? Math.min(2, Math.floor(room / w * 4) / 4) : 1)
const fitWindow = () => fit(innerWidth - 32, size()[0])

// the full Winamp over the app moves by its title bars, like the real one, and the bar at the bottom by itself;
// a drag isn't a click, so the bar doesn't open when let go
let moved = 0
const justMoved = () => Date.now() - moved < 300
function moveWin(e: PointerEvent) {
  if ((e.target as Element).closest('button, [role=slider]') || e.button) return
  const el = (e.currentTarget as Element).closest('.wa-float, .wa-bar') as HTMLElement
  const bar = el.classList.contains('wa-bar')
  const r = el.getBoundingClientRect()
  const [dx, dy] = [e.clientX - r.left, e.clientY - r.top]
  const t = e.currentTarget as HTMLElement
  t.setPointerCapture(e.pointerId)
  const at = (ev: PointerEvent) => [Math.round(ev.clientX - dx), Math.round(ev.clientY - dy)] as const
  t.onpointermove = (ev) => {
    const [x, y] = at(ev)
    el.style.left = `${x}px`
    el.style.top = `${y}px`
    el.style.bottom = 'auto'
  }
  t.onpointerup = t.onpointercancel = (ev) => {
    t.onpointermove = t.onpointerup = t.onpointercancel = null
    const [x, y] = at(ev)
    if (Math.abs(x - r.left) + Math.abs(y - r.top) < 4) return
    moved = Date.now()
    pref(bar ? { bx: x, by: y } : { x, y })
  }
}

function Shell() {
  const v = useAmp()
  const k = useSkin(v?.skin)
  const [, force] = useState(0)
  useEffect(() => {
    const f = () => force((x) => x + 1)
    addEventListener('popstate', f)
    addEventListener('resize', f)
    return () => (removeEventListener('popstate', f), removeEventListener('resize', f))
  }, [])
  const z = fitWindow()
  const label = v && t("{name}'s Winamp", { name: v.name })
  let body = null
  if (v && k && pf.open) {
    const [w, hh] = size().map((n) => n * z)
    const x = Math.min(Math.max(0, pf.x ?? innerWidth - w - 16), innerWidth - w)
    const y = Math.min(Math.max(0, pf.y ?? innerHeight - hh - 90), innerHeight - 14 * z)
    body = (
      // zoom on a fixed box would scale its place too, so it goes on the inside
      <div class={`wa-float${pf.top ? ' top' : ''}`} style={{ left: `${x}px`, top: `${y}px` }} role="dialog" aria-label={label!}>
        <div style={{ zoom: z }}><Winamp v={v} k={k} md5={v.skin} win={{ float: true, min: () => pref({ open: false }), close, move: moveWin }} /></div>
      </div>
    )
  } else if (v && k && !showing.has(v.fid)) {
    const it = v.list[v.i]
    const a = (f: () => void) => f
    const [w, h] = [Math.max(275, plWidth()) * z, 28 * z]
    const col = document.querySelector('.col')?.getBoundingClientRect()
    const x = Math.min(Math.max(0, pf.bx ?? (col ? col.left + col.width / 2 - w / 2 : (innerWidth - w) / 2)), innerWidth - w)
    const at = pf.by === undefined ? {} : { top: `${Math.min(Math.max(0, pf.by), innerHeight - h)}px`, bottom: 'auto' }
    body = (
      <div class="wa-bar" style={{ left: `${Math.round(x)}px`, ...at }} role="region" aria-label={label!} title={(it?.pl && v.title) || it?.title}>
        <div class="wa" data-st={v.st} style={{ ...vars(k), zoom: z }}>
          <ShadeBar v={v} md5={v.skin} a={a} win={{ float: false, min: () => pref({ open: true }), close, move: moveWin }} unshade={() => pref({ open: true, shade: false })} />
          {/* Winamp's windowshade has no room for the title, so the shaded playlist is docked under it, as people did */}
          <PlStrip v={v} move={moveWin} open={() => pref({ open: true, pl: true, plShade: false })} close={close} />
        </div>
      </div>
    )
  }
  return <>{body}<Menu /></>
}

let root: HTMLElement | null = null
function mountRoot() {
  if (!root) render(<Shell />, (root = document.body.appendChild(document.createElement('div'))))
}
if (s) mountRoot()
