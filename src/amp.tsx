// Winamp on profiles. A profile's YouTube videos and playlists (Look.amp) play as sound only: YouTube's player sits in
// a hidden frame and is driven over its postMessage API, the same messages its iframe_api script sends. In front is a
// Winamp 2 drawn from a real skin (src/skin.ts). It keeps playing from page to page: away from the owner's profile it
// shrinks to the windowshade bar at the bottom, which opens the full Winamp as a window over the app, and it comes
// back (paused) after a reload until it's closed.
import { render } from 'preact'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { go } from './api.ts'
import { t } from './i18n.ts'
import type { Amp, AmpItem } from './shared.ts'
import { loadSkin, type Skin } from './skin.ts'

const KEY = 'quilcast:amp'
const YT = 'https://www.youtube-nocookie.com'
type St = 'play' | 'pause' | 'stop'
type State = {
  fid: number; who: string; name: string; skin?: string; list: AmpItem[]
  i: number; sub: number; at: number; len: number; st: St; title?: string; ids?: string[]
  vol: number; shuffle: boolean; repeat: boolean; open: boolean; pl: boolean; x?: number; y?: number
}

let s: State | null = null
const subs = new Set<() => void>()
let saved = 0
const save = () => {
  saved = Date.now()
  try {
    s ? localStorage.setItem(KEY, JSON.stringify(s)) : localStorage.removeItem(KEY)
  } catch {}
}
// the time changes every half second, so it's written down only every few seconds
const set = (p: Partial<State>, tick = false) => {
  if (!s) return
  s = { ...s, ...p }
  if (!tick || Date.now() - saved > 5e3) save()
  subs.forEach((f) => f())
}
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
  cmd('setVolume', s!.vol)
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
  if (s.list[s.i]?.pl) {
    if (Array.isArray(i.playlist) && i.playlist.length) p.ids = i.playlist
    if (i.playlistIndex >= 0) p.sub = i.playlistIndex
  }
  set(p, true)
  if (typeof i.playerState === 'number') state(i.playerState)
})

function state(n: number) {
  if (!s || n === last) return
  last = n
  if (n === 1) (fails = 0), set({ st: 'play' })
  // paused from outside, e.g. the phone's lock screen
  else if (n === 2 && s.st === 'play') set({ st: 'pause' })
  else if (n === 0) next(true)
}

function load(at = 0) {
  const it = s?.list[s.i]
  if (!it) return
  last = -9
  set({ st: 'play' })
  if (!frame) return void ((cur = it.id), mount(it, at))
  if (it.pl && cur === it.id) return cmd('playVideoAt', s!.sub)
  cur = it.id
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
const volume = (v: number) => (cmd('setVolume', v), set({ vol: v }))
const pick = (i: number, sub = 0) => (set({ i, sub, at: 0, len: 0, title: undefined, ...(i !== s!.i && { ids: undefined }) }), load())
function next(auto = false) {
  if (!s) return
  const { i, sub, list, ids } = s
  if (list[i]?.pl && ids && sub < ids.length - 1) return pick(i, sub + 1)
  if (s.shuffle && list.length > 1) return pick((i + 1 + Math.floor(Math.random() * (list.length - 1))) % list.length)
  if (i + 1 < list.length || s.repeat || !auto) return pick((i + 1) % list.length)
  stop()
}
function prev() {
  if (!s) return
  if (s.at > 3) return seek(0)
  if (s.list[s.i]?.pl && s.sub > 0) return pick(s.i, s.sub - 1)
  pick((s.i - 1 + s.list.length) % s.list.length)
}

/** Stop and put the Winamp away for good (until someone plays one again). */
export function close() {
  frame?.remove()
  frame = null
  cur = ''
  s = null
  disarm()
  save()
  subs.forEach((f) => f())
}

/** Make `owner`'s list the one playing, stopped at its start. */
function take(o: Owner) {
  if (s?.fid === o.fid) return
  frame?.remove()
  frame = null
  cur = ''
  s = { fid: o.fid, who: o.who, name: o.name, skin: o.amp.skin, list: o.amp.list, i: 0, sub: 0, at: 0, len: 0, st: 'stop', vol: s?.vol ?? 80, shuffle: false, repeat: true, open: false, pl: true }
  save()
  mountRoot()
}

// coming back to a page that was playing: browsers allow sound only after a tap or key, so the first one picks it up
const first = (e: Event) => !(e.target as Element).closest?.('.wa') && play()
const disarm = () => (removeEventListener('pointerdown', first, true), removeEventListener('keydown', first, true))
try {
  const j = JSON.parse(localStorage.getItem(KEY) || 'null')
  if (j?.list?.length) {
    s = { ...j, st: j.st === 'stop' ? 'stop' : 'pause' }
    if (j.st === 'play') addEventListener('pointerdown', first, true), addEventListener('keydown', first, true)
  }
} catch {}

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
const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches

function Marquee({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [w, setW] = useState(0)
  const [x, setX] = useState(0)
  useLayoutEffect(() => (setX(0), setW(ref.current!.offsetWidth)), [text])
  // longer than the display: it goes round, five pixels at a time, with "***" between the ends
  const long = w > 154
  useEffect(() => {
    if (!long || still()) return
    const id = setInterval(() => setX((x) => (x + 5) % (w + 35)), 220)
    return () => clearInterval(id)
  }, [w])
  return <div class="wa-marquee"><div class="wa-mq" style={{ transform: `translateX(-${x}px)` }}><span ref={ref}>{chars(text)}</span>{long && <>{chars('  ***  ')}{chars(text)}</>}</div></div>
}

// YouTube's sound can't be read from the page, so the spectrum is for the look: bars in the skin's colors while it plays
function Vis({ on, vis }: { on: boolean; vis: string[] }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current!.getContext('2d')!
    const bars = Array<number>(19).fill(0)
    let raf = 0
    let then = 0
    const draw = (now: number) => {
      if (on && !still()) raf = requestAnimationFrame(draw)
      if (now - then < 50) return
      then = now
      c.fillStyle = vis[0]
      c.fillRect(0, 0, 76, 16)
      c.fillStyle = vis[1]
      for (let x = 1; x < 76; x += 2) for (let y = 1; y < 16; y += 2) c.fillRect(x, y, 1, 1)
      if (!on) return
      bars.forEach((h, i) => {
        const want = Math.random() ** 1.6 * 17 * (1 - i / 28)
        h = bars[i] = want > h ? want : Math.max(0, h - 1.5)
        for (let y = 16 - Math.min(16, Math.round(h)); y < 16; y++) (c.fillStyle = vis[2 + y]), c.fillRect(i * 4, y, 3, 1)
      })
    }
    draw(100)
    return () => cancelAnimationFrame(raf)
  }, [on, vis])
  return <canvas class="wa-vis" width={76} height={16} ref={ref} />
}

/** Drag along a bar: `to` gets the share of its width (0 to 1) as the pointer moves, `end` the last one. */
const drag = (to: (f: number) => void, end?: (f: number) => void) => (e: PointerEvent) => {
  const el = e.currentTarget as HTMLElement
  const r = el.getBoundingClientRect()
  const f = (ev: PointerEvent) => Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width))
  el.setPointerCapture(e.pointerId)
  to(f(e))
  el.onpointermove = (ev) => to(f(ev))
  el.onpointerup = el.onpointercancel = (ev) => ((el.onpointermove = el.onpointerup = el.onpointercancel = null), end?.(f(ev)))
}

const vars = (k: Skin) => {
  const v: Record<string, string> = { '--wa-fg': k.pl.normal, '--wa-cur': k.pl.current, '--wa-bg': k.pl.bg, '--wa-font': `"${k.pl.font}", Arial, sans-serif` }
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
type View = Pick<State, 'list' | 'i' | 'sub' | 'at' | 'len' | 'st' | 'title' | 'ids' | 'vol' | 'shuffle' | 'repeat' | 'pl'>
const idle = (a: Amp): View => ({ list: a.list, i: 0, sub: 0, at: 0, len: 0, st: 'stop', vol: s?.vol ?? 80, shuffle: false, repeat: true, pl: true })

/** The main window and the playlist under it. `before` runs ahead of every button (a profile's list takes over). */
function Winamp({ v, k, before = () => {}, win }: { v: View; k: Skin; before?: () => void; win?: { shade: () => void; close: () => void } }) {
  const [pos, setPos] = useState<number | null>(null)
  const a = (f: () => void) => () => (before(), f())
  const it = v.list[v.i]
  const name = (it?.pl && v.title) || it?.title || ''
  const frac = pos ?? (v.len ? Math.min(1, v.at / v.len) : 0)
  const vol = Math.round(v.vol / 100 * 27)
  return (
    <div class="wa" data-st={v.st} style={vars(k)}>
      <div class="wa-main">
        <div class="wa-tb" onPointerDown={win && moveWin}>
          {win && <button class="wa-min" aria-label={t('Minimize')} onClick={win.shade} />}
          {win && <button class="wa-shade" aria-label={t('Minimize')} onClick={win.shade} />}
          <button class="wa-close" aria-label={win ? t('Close Winamp') : t('Stop')} onClick={win ? win.close : a(stop)} />
        </div>
        <div class="wa-clutter" />
        <div class="wa-st" />
        {v.st === 'play' && <div class="wa-work" />}
        <div class="wa-time">{[...mmss(v.at).replace(':', '')].map((d, i) => <i class={`wa-d d${i}`} style={{ backgroundPosition: `-${Number(d) * 9}px 0` }} />)}</div>
        <Vis on={v.st === 'play'} vis={k.vis} />
        <Marquee text={it ? `${v.i + 1}. ${name}${v.len ? ` (${mmss(v.len).replace(/^0/, '')})` : ''}` : 'Winamp'} />
        <div class="wa-mono" />
        <div class={`wa-stereo${v.st === 'play' ? ' on' : ''}`} />
        <div class="wa-vol" style={{ backgroundPosition: `0 -${vol * 15}px` }} role="slider" aria-label={t('Volume')} aria-valuenow={v.vol} tabIndex={0}
          onPointerDown={drag((f) => (before(), volume(Math.round(f * 100))))}
          onKeyDown={(e) => (e.key === 'ArrowRight' || e.key === 'ArrowLeft') && (before(), volume(Math.min(100, Math.max(0, v.vol + (e.key === 'ArrowRight' ? 5 : -5)))))}>
          <i style={{ left: `${Math.round(v.vol / 100 * 51)}px` }} />
        </div>
        <div class="wa-bal"><i /></div>
        <div class="wa-eqb" />
        <button class={`wa-plb${v.pl ? ' on' : ''}`} aria-label={t('Playlist')} aria-pressed={v.pl} onClick={a(() => set({ pl: !s!.pl }))} />
        <div class="wa-pos" role="slider" aria-label={t('Position')} aria-valuenow={Math.round(v.at)}
          onPointerDown={v.st !== 'stop' && v.len ? drag(setPos, (f) => (setPos(null), seek(f))) : undefined}>
          {v.st !== 'stop' && <i style={{ left: `${Math.round(frac * 219)}px` }} />}
        </div>
        <button class="wa-btn wa-prev" aria-label={t('Previous')} onClick={a(prev)} />
        <button class="wa-btn wa-play" aria-label={t('Play')} onClick={a(play)} />
        <button class="wa-btn wa-pause" aria-label={t('Pause')} onClick={a(pause)} />
        <button class="wa-btn wa-stop" aria-label={t('Stop')} onClick={a(stop)} />
        <button class="wa-btn wa-next" aria-label={t('Next')} onClick={a(() => next())} />
        <button class="wa-eject" aria-label={t('Open the profile')} onClick={() => s && go(s.who)} />
        <button class={`wa-shuf${v.shuffle ? ' on' : ''}`} aria-label={t('Shuffle')} aria-pressed={v.shuffle} onClick={a(() => set({ shuffle: !s!.shuffle }))} />
        <button class={`wa-rep${v.repeat ? ' on' : ''}`} aria-label={t('Repeat')} aria-pressed={v.repeat} onClick={a(() => set({ repeat: !s!.repeat }))} />
      </div>
      {v.pl && <List v={v} play={(i, sub) => (before(), pick(i, sub))} close={a(() => set({ pl: false }))} move={win && moveWin} />}
    </div>
  )
}

// titles of a playlist's videos, which only the one playing brings along
const titles = new Map<string, Promise<string>>()
const titleOf = (id: string) => {
  if (!titles.has(id)) titles.set(id, fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`).then((r) => r.json()).then((j) => String(j.title || id), () => id))
  return titles.get(id)!
}
function Title({ id }: { id: string }) {
  const [x, setX] = useState('')
  useEffect(() => void titleOf(id).then(setX), [id])
  return <>{x || '…'}</>
}

function List({ v, play, close, move }: { v: View; play: (i: number, sub?: number) => void; close: () => void; move?: (e: PointerEvent) => void }) {
  const box = useRef<HTMLDivElement>(null)
  const [top, setTop] = useState(0)
  const scrolled = () => {
    const el = box.current!
    setTop(el.scrollHeight > el.clientHeight ? el.scrollTop / (el.scrollHeight - el.clientHeight) : 0)
  }
  useEffect(() => void box.current?.querySelector('.cur')?.scrollIntoView({ block: 'nearest' }), [v.i, v.sub])
  return (
    <div class="wa-pl">
      <div class="wa-pl-top" onPointerDown={move}><i class="l" /><i class="t" /><i class="r" /><button class="wa-pl-x" aria-label={t('Close the playlist')} onClick={close} /></div>
      <div class="wa-pl-mid">
        <i class="l" /><i class="r" /><i class="wa-pl-thumb" style={{ top: `${Math.round(top * 98)}px` }} />
        <div class="wa-rows" ref={box} onScroll={scrolled}>
          {v.list.map((it, i) => (
            <>
              <button class={`wa-row${i === v.i && !it.pl ? ' cur' : ''}`} onClick={() => play(i)}>
                <span>{i + 1}. {it.pl ? '▸ ' : ''}{it.title || it.id}</span>{i === v.i && !it.pl && v.len ? <span>{mmss(v.len).replace(/^0/, '')}</span> : null}
              </button>
              {it.pl && i === v.i && v.ids?.map((id, j) => (
                <button class={`wa-row sub${j === v.sub ? ' cur' : ''}`} onClick={() => play(i, j)}>
                  <span>{j + 1}. {j === v.sub && v.title ? v.title : <Title id={id} />}</span>{j === v.sub && v.len ? <span>{mmss(v.len).replace(/^0/, '')}</span> : null}
                </button>
              ))}
            </>
          ))}
        </div>
      </div>
      <div class="wa-pl-bot"><i class="l" /><i class="r" /></div>
    </div>
  )
}

/** A profile's Winamp: the one playing when it's this profile's list, else that list ready to play. */
export function ProfileAmp({ owner }: { owner: Owner }) {
  const live = useAmp()
  const k = useSkin(owner.amp.skin)
  const box = useRef<HTMLDivElement>(null)
  const z = useFit(box)
  const mine = live?.fid === owner.fid
  // while it's on screen here, the bar at the bottom steps aside
  useEffect(() => {
    showing.add(owner.fid)
    subs.forEach((f) => f())
    return () => (showing.delete(owner.fid), subs.forEach((f) => f()))
  }, [owner.fid])
  return (
    <div class="wa-in" ref={box}>
      {k ? <div style={{ zoom: z }}><Winamp v={mine ? live : idle(owner.amp)} k={k} before={() => take(owner)} /></div> : <div class="wa-wait" />}
    </div>
  )
}
const showing = new Set<number>()

// pixels stay sharp at whole sizes, and a phone gets as much as fits
function useFit(ref: { current: HTMLElement | null }) {
  const [z, setZ] = useState(1)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const o = new ResizeObserver(() => setZ(Math.min(2, Math.max(1, Math.floor(el.clientWidth / 275 * 4) / 4))))
    o.observe(el)
    return () => o.disconnect()
  }, [])
  return z
}
const fitWindow = () => Math.min(2, Math.max(1, Math.floor((innerWidth - 32) / 275 * 4) / 4))

// the full Winamp over the app moves by its title bars, like the real one
function moveWin(e: PointerEvent) {
  if ((e.target as Element).closest('button')) return
  const el = (e.currentTarget as Element).closest('.wa-float') as HTMLElement
  const r = el.getBoundingClientRect()
  const [dx, dy] = [e.clientX - r.left, e.clientY - r.top]
  const t = e.currentTarget as HTMLElement
  t.setPointerCapture(e.pointerId)
  const at = (ev: PointerEvent) => [Math.round(ev.clientX - dx), Math.round(ev.clientY - dy)] as const
  t.onpointermove = (ev) => {
    const [x, y] = at(ev)
    el.style.left = `${x}px`
    el.style.top = `${y}px`
  }
  t.onpointerup = t.onpointercancel = (ev) => {
    t.onpointermove = t.onpointerup = t.onpointercancel = null
    const [x, y] = at(ev)
    set({ x, y })
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
  if (!v || !k) return null
  const z = fitWindow()
  if (v.open) {
    const [w, h] = [275 * z, (v.pl ? 290 : 116) * z]
    const x = Math.min(Math.max(0, v.x ?? innerWidth - w - 16), innerWidth - w)
    const y = Math.min(Math.max(0, v.y ?? innerHeight - h - 90), innerHeight - 14 * z)
    return (
      // zoom on a fixed box would scale its place too, so it goes on the inside
      <div class="wa-float" style={{ left: `${x}px`, top: `${y}px` }} role="dialog" aria-label={t("{name}'s Winamp", { name: v.name })}>
        <div style={{ zoom: z }}><Winamp v={v} k={k} win={{ shade: () => set({ open: false }), close }} /></div>
      </div>
    )
  }
  if (showing.has(v.fid)) return null
  const frac = v.len ? Math.min(1, v.at / v.len) : 0
  const it = v.list[v.i]
  return (
    <div class="wa-bar" role="region" aria-label={t("{name}'s Winamp", { name: v.name })} title={(it?.pl && v.title) || it?.title}>
      <div class="wa" data-st={v.st} style={{ ...vars(k), zoom: z }}>
        <div class="wa-sh" onClick={(e) => e.target === e.currentTarget && set({ open: true })}>
          <button class="wa-min" aria-label={t('Open Winamp')} onClick={() => set({ open: true })} />
          <button class="wa-unshade" aria-label={t('Open Winamp')} onClick={() => set({ open: true })} />
          <button class="wa-close" aria-label={t('Close Winamp')} onClick={close} />
          <span class="wa-sh-time">{v.st === 'stop' ? null : chars(mmss(v.at))}</span>
          <button class="wa-sp" style={{ left: '169px', width: '7px' }} aria-label={t('Previous')} onClick={prev} />
          <button class="wa-sp" style={{ left: '176px', width: '10px' }} aria-label={t('Play')} onClick={play} />
          <button class="wa-sp" style={{ left: '186px', width: '9px' }} aria-label={t('Pause')} onClick={pause} />
          <button class="wa-sp" style={{ left: '195px', width: '9px' }} aria-label={t('Stop')} onClick={stop} />
          <button class="wa-sp" style={{ left: '204px', width: '10px' }} aria-label={t('Next')} onClick={() => next()} />
          <button class="wa-sp" style={{ left: '215px', width: '10px' }} aria-label={t('Open the profile')} onClick={() => go(v.who)} />
          <div class="wa-sh-pos">{v.st !== 'stop' && <i style={{ left: `${Math.round(frac * 14)}px` }} />}</div>
        </div>
      </div>
    </div>
  )
}

let root: HTMLElement | null = null
function mountRoot() {
  if (!root) render(<Shell />, (root = document.body.appendChild(document.createElement('div'))))
}
if (s) mountRoot()
