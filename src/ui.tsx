import type { ComponentChildren } from 'preact'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import { account, back, follow, get, go, LINK_RE, read, save, mine, mineVersion, myUser, posting, safeUrl, settings, toUrl, users, type Cast, type User } from './api.ts'
import { boxOf, castOf, castText, cleanDesign, cleanTheme, DEFAULTS, designId, embedLayout, FONTS, isImg, isVid, LOGO, lookVars, n, ownMedia, P, poster, shortUrl, sized, IMG_SIZES, spaceOf, srcsetOf, themeId, themeVars, TOKENS, viaUs, vidBoxOf, playedOf, vidShape, X_LOGO, type Look, type Theme } from './shared.ts'
export { spaceOf }
import type { AppMeta } from './miniapp.tsx'
import { lang, t, t as tr, tn } from './i18n.ts'
import { blockOf, hides, muteOf, setMute } from './mutes.ts'
import { base, detect } from './lang.ts'

// keys and crypto load only when someone signs in or writes
export const w = () => import('./write.ts')

// module-level hooks the shell fills in, so any component can toast or open the composer
export const shell = {
  toast: (_: string) => {},
  // text, embeds and onDone come from mini apps; onDone gets the new cast's hash, or null if nothing was posted
  compose: (_: { parent?: Cast; quote?: Cast; channel?: string; text?: string; embeds?: string[]; onDone?: (hash: string | null) => void } = {}) => {},
  view: (_urls: string[], _index: number) => {},
  // the account indicator in page headers (app.tsx), for phones
  me: (): ComponentChildren => null,
  // the open mini apps (miniapp.tsx keeps these current and fires 'dock'); the dock shows them next to the pinned ones
  dock: { apps: [] as { id: number; url: string; name: string; icon?: string }[], shown: null as number | null, show: (_id: number) => {} },
  // opens the theme editor (themes.tsx) on a theme, or on the one being worn
  editTheme: (_?: Theme | null) => {},
  // set by a mini app window's search button (Quorum mode): /apps focuses its directory search, then clears it
  findApp: false,
}
// errors thrown with English text (ours and the server's) are translated here too
export const toast = (m: string) => shell.toast(t(m))
export const requireAccount = () => (account?.done ? true : (go('/join'), false))
/** Ask the browser to show notifications. It has to run straight from a click: Firefox drops the prompt
 *  if anything (a lazy import) is awaited first. */
export const askPush = () => ('Notification' in window ? Notification.requestPermission().catch(() => 'denied' as const) : Promise.resolve('denied' as const))
/** Whether this browser already has a push subscription for Quilcast. */
export const pushOn = async () => !!(await (await navigator.serviceWorker?.getRegistration('/sw.js'))?.pushManager.getSubscription())
/** Open a mini app (src/miniapp.tsx, loaded on first use). */
export const launchApp = (m: AppMeta, ctx?: { cast?: Cast; embed?: string }) => requireAccount() && import('./miniapp.tsx').then((x) => x.launch(m, ctx))
/** Mini apps pinned to the dock, in the order they were pinned. */
export const pinned = () => read<AppMeta[]>('quilcast:pinned', [])
// the directory's links and the ones apps open at can differ by a trailing slash
export const sameApp = (a: string, b: string) => !!safeUrl(a) && safeUrl(a) === safeUrl(b)
export const isPinned = (url: string) => pinned().some((a) => sameApp(a.url, url))
export function togglePin(m: AppMeta) {
  const on = isPinned(m.url)
  save('quilcast:pinned', on ? pinned().filter((a) => !sameApp(a.url, m.url)) : [...pinned(), { url: m.url, name: m.name, icon: m.icon }])
  dispatchEvent(new Event('dock'))
  shell.toast(on ? t('Unpinned from the dock') : t('Pinned to the dock'))
}
export type Listed = AppMeta & { tagline?: string; category?: string }
// farcaster.xyz's top mini apps, through our server (cached there); loaded once per visit
let listed: Promise<Listed[]> | undefined
export const loadListed = () => (listed ||= fetch('/api/apps').then((r) => r.json(), () => []).then((l) => (Array.isArray(l) && l.length ? l : ((listed = undefined), []))))
export const launchUrl = (url: string) => requireAccount() && import('./miniapp.tsx').then((x) => x.launchUrl(url))

export { P }
export const Icon = ({ d, fill, size = 18 }: { d: string; fill?: boolean; size?: number }) => (
  <svg class={d === P.back || d === P.chev ? 'flip' : undefined} viewBox="0 0 24 24" width={size} height={size} fill={fill ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
)
export const Logo = ({ size = 28 }: { size?: number }) => (
  <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
    <rect width="32" height="32" rx="9" fill="var(--accent)" />
    <path d={LOGO} fill="#fff" />
  </svg>
)

export const ago = (t: string | number) => {
  const s = (Date.now() - new Date(t).getTime()) / 1000
  if (s < 60) return tr('now')
  if (s < 3600) return tr('{n}m', { n: Math.floor(s / 60) })
  if (s < 86400) return tr('{n}h', { n: Math.floor(s / 3600) })
  if (s < 7 * 86400) return tr('{n}d', { n: Math.floor(s / 86400) })
  return new Date(t).toLocaleDateString(lang, { month: 'short', day: 'numeric', year: s > 300 * 86400 ? 'numeric' : undefined })
}
// accounts without a username show as !fid
const uname = (u: User) => (u.username && !u.username.startsWith('fid:') ? u.username : undefined)
export const handle = (u: User) => uname(u) || `!${u.fid}`
export const nameOf = (u: User) => u.display_name || handle(u)
export const userPath = (u: User) => `/u/${uname(u) || u.fid}`
export const channelOf = (u?: string | null) => u?.match(/(?:warpcast\.com|farcaster\.xyz)\/~\/channel\/([^/?#]+)/)?.[1]
export const channelUrl = (id: string) => `https://warpcast.com/~/channel/${id}`
// keeps a click inside a cast from opening the cast; a link it lands on still opens in place
export const stop = (e: MouseEvent) => (e.stopPropagation(), follow(e))

export const Header = ({ title, back: showBack = true, action, children }: { title?: ComponentChildren; back?: boolean; action?: ComponentChildren; children?: ComponentChildren }) => (
  <div class="phead">
    <div class="phead-row">
      {showBack ? <button class="icon-btn" aria-label={t('Back')} onClick={back}><Icon d={P.back} /></button> : <a class="brand only-mobile" href="/" aria-label={t('Quilcast home')}><Logo size={26} /></a>}
      <h1>{title}</h1>
      {action}
      {shell.me()}
    </div>
    {children}
  </div>
)

const top = (el: Element) => {
  // (on phones that list is the page itself)
  const pane = el.closest('.q-dm-list')
  pane && getComputedStyle(pane).overflowY !== 'visible' ? pane.scrollTo(0, 0) : el.closest('.phead') && scrollTo(0, 0)
}
export const Tabs = <T extends string>({ tabs, value, set }: { tabs: [T, string][]; value: T; set: (t: T) => void }) => (
  <nav class="tabs" role="tablist">
    {/* a list under tabs in the sticky header starts at its top, not wherever the previous one was scrolled to (in
        Quorum mode's Messages the list scrolls in its own pane, and the page beside it is the open conversation) */}
    {tabs.map(([k, label]) => <button type="button" role="tab" aria-selected={value === k} class={value === k ? 'on' : ''} onClick={(e) => (top(e.currentTarget), set(k))}>{label}</button>)}
  </nav>
)

/** Someone else's image: lazy, sent without a referrer, and hidden rather than broken when it fails. An http:// one is
 * asked for over https://, as Chrome would anyway, so the page never loads mixed content. `low`: a link preview's
 * pictures (other sites', often huge for their box) come after the casts' own (server/home.mjs too). */
export const Img = ({ low, ...p }: { src?: string; class?: string; style?: string; srcset?: string; sizes?: string; low?: boolean }) => (
  <img alt="" loading="lazy" fetchpriority={low ? 'low' : undefined} referrerpolicy="no-referrer" onError={(e) => (e.currentTarget.style.display = 'none')} {...p} src={p.src?.replace(/^http:\/\//i, 'https://')} />
)

/** A mini app's icon, or the first letter of its name when there's none or it won't load. */
export function AppIcon({ src, name }: { src?: string; name?: string }) {
  const [bad, setBad] = useState(false)
  return src && !bad ? <img class="app-icon" alt="" loading="lazy" referrerpolicy="no-referrer" src={src} onError={() => setBad(true)} /> : <span class="app-icon">{[...(name || '?')][0]}</span>
}

/** A popup that closes on any click outside it. */
export function Menu({ close, class: cls, children }: { close: () => void; class?: string; children: ComponentChildren }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // capturing, so clicks that other handlers stop still count
    const f = (e: Event) => !ref.current?.contains(e.target as Node) && close()
    addEventListener('click', f, true)
    return () => removeEventListener('click', f, true)
  }, [])
  return <div ref={ref} class={`menu ${cls || ''}`} role="menu">{children}</div>
}

export const Avatar = ({ u, size = 40, link = true, onClick }: { u: User; size?: number; link?: boolean; onClick?: (e: MouseEvent) => void }) => {
  const style = { width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.42)}px` }
  const pfp = safeUrl(u.pfp_url)
  const inner = pfp ? <Img src={sized(pfp, 'anim=false,w=144')} /> : <span>{[...(u.display_name || u.username || '?')][0]}</span>
  return link ? <a class="avatar" href={userPath(u)} style={style} onClick={stop} aria-label={nameOf(u)}>{inner}</a> : <span class="avatar" style={style} onClick={onClick}>{inner}</span>
}

export function RichText({ text, class: cls = 'text' }: { text: string; class?: string }) {
  // dir=auto: an English cast reads left to right in the Arabic UI too, and the other way round
  return (
    <p class={cls} dir="auto">
      {text.split(TOKENS).map((p, i) => {
        if (i % 2 === 0) return p
        if (p[0] === '@') return <a href={`/u/${p.slice(1)}`} onClick={stop}>{p}</a>
        if (p[0] === '/') return <span class="chan-ref">{p}</span>
        const u = safeUrl(toUrl(p))
        return u ? <a href={u} target="_blank" rel="noopener noreferrer nofollow" onClick={stop}>{shortUrl(p)}</a> : p
      })}
    </p>
  )
}

// long text in feeds folds at 10 lines; the button shows only when something is cut
function Folded({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [over, setOver] = useState(false)
  useLayoutEffect(() => {
    const p = ref.current?.firstElementChild
    p && setOver(p.scrollHeight > p.clientHeight + 1)
  }, [text])
  return (
    <div ref={ref}>
      <RichText text={text} class={open ? 'text' : 'text fold'} />
      {over && !open && <button class="show-more" onClick={(e) => (stop(e), setOpen(true))}>{t('Show more')}</button>}
    </div>
  )
}

// --- translations (server/translate.mjs) ---
// A cast in another language than Quilcast's offers a translation. Translations are made once per cast and language
// on our server by a free model and kept there, so ones someone already asked for show up translated right away.
type Tr = { from: string; text: string }
const translated = new Map<string, Tr | null>()
const waiting = new Map<string, ((r: Tr | null) => void)[]>()
let flush = 0
// the casts on screen are asked about together, in one request
function known(hash: string): Promise<Tr | null> {
  if (translated.has(hash)) return Promise.resolve(translated.get(hash)!)
  return new Promise((done) => {
    waiting.set(hash, [...(waiting.get(hash) || []), done])
    flush ||= window.setTimeout(async () => {
      flush = 0
      const asked = new Map(waiting)
      waiting.clear()
      for (let i = 0, hs = [...asked.keys()]; i < hs.length; i += 50) {
        const part = hs.slice(i, i + 50)
        const r: Record<string, Tr> = await fetch('/api/translations', { method: 'POST', body: JSON.stringify({ to: lang, hashes: part }) }).then((x) => (x.ok ? x.json() : {}), () => ({}))
        for (const h of part) asked.get(h)!.forEach((f) => f(r[h] || null))
        for (const h of part) if (r[h]) translated.set(h, r[h])
      }
    }, 60)
  })
}
// whether the server can translate at all (it needs an OpenRouter key), asked once
let canTranslate: Promise<boolean> | undefined
const translates = () => (canTranslate ||= fetch('/api/translate').then((r) => r.json()).then((j) => !!j.on, () => false))
const langName = (code: string) => {
  try {
    return new Intl.DisplayNames([lang], { type: 'language' }).of(code) || code
  } catch {
    return code
  }
}

/** A cast's words, translated when it's in another language and the reader asked (or someone did before). */
function Said({ c, full }: { c: Cast; full?: boolean }) {
  const text = castText(c)
  const from = useMemo(() => {
    const l = detect(text)
    return l && l !== base(lang) ? l : null
  }, [text])
  const [tr, setTr] = useState<Tr | null>(translated.get(c.hash) || null)
  const [orig, setOrig] = useState(false)
  const [busy, setBusy] = useState(false)
  const [on, setOn] = useState(false)
  useEffect(() => {
    let live = true
    if (from && !tr) known(c.hash).then((r) => live && r && setTr(r))
    if (from) translates().then((x) => live && setOn(x))
    return () => void (live = false)
  }, [c.hash, from])
  const ask = async (e: Event) => {
    e.stopPropagation()
    setBusy(true)
    try {
      const r = await fetch('/api/translate', { method: 'POST', body: JSON.stringify({ hash: c.hash, to: lang }) })
      const j = await r.json().catch(() => null)
      if (!r.ok || !j?.text) throw new Error(j?.error || "Couldn't translate that right now.")
      translated.set(c.hash, j)
      setTr(j)
      setOrig(false)
    } catch (err: any) {
      toast(err.message)
    }
    setBusy(false)
  }
  // the model can find it's in the reader's language after all
  const same = tr && base(tr.from) === base(lang)
  const words = tr && !orig && !same ? tr.text : text
  const fromName = langName(tr && tr.from !== 'und' ? tr.from : from || 'und')
  return (
    <>
      {full ? <RichText text={words} /> : <Folded text={words} />}
      {from && !same && (tr || on) && (
        <div class="tr-note" onClick={stop}>
          {tr && !orig ? <>{t('Auto-translated from {language}', { language: fromName })} · <button class="link-btn" onClick={() => setOrig(true)}>{t('View original')}</button></>
            : tr ? <button class="link-btn" onClick={() => setOrig(false)}>{t('View translation')}</button>
              : <button class="link-btn" disabled={busy} onClick={ask}>{busy ? t('Translating…') : t('Translate from {language}', { language: fromName })}</button>}
        </div>
      )}
    </>
  )
}

export const urlsOf = (c: Cast) => c.embeds.flatMap((e) => safeUrl(e.url) ?? [])
/** the cast's first image, or its video's poster */
export const thumbOf = (c: Cast) => {
  const urls = urlsOf(c)
  return urls.find(isImg) || poster(urls.find(isVid))
}

// HLS plays natively in Safari and Chrome; Firefox-based browsers get hls.js, loaded on first play
export function Video({ src }: { src: string }) {
  const ref = useRef<HTMLVideoElement>(null)
  const hls = src.includes('.m3u8') && !document.createElement('video').canPlayType('application/vnd.apple.mpegurl')
  const [ready, setReady] = useState(!hls)
  // its box takes the video's shape: the poster's, from the server (warm) or read here once it shows, then the video's
  // own once it plays; 16:9 while nothing is known
  // (kept with its src: Media keys each Video by its src, and this holds even where a Video is reused for another one)
  const [played, setPlayed] = useState<{ src: string; size: [number, number] } | null>(null)
  const [, learnt] = useState(0)
  const box = vidBoxOf(vidShape(playedOf(played, src), shapes.get(src)))
  useEffect(() => {
    const url = poster(src)
    if (shapes.get(src) || !url) return
    // the same picture the <video> shows as its poster, so it's loaded once
    const i = new Image()
    i.onload = () => i.naturalWidth && (shapes.set(src, [i.naturalWidth, i.naturalHeight]), learnt((x) => x + 1))
    i.src = url
    return () => void (i.onload = null)
  }, [src])
  const start = async (e: Event) => {
    e.stopPropagation()
    // the full build: Farcaster's streams carry audio as a separate rendition, which hls.js/light drops
    const { default: Hls } = await import('hls.js')
    const h = new Hls()
    h.loadSource(src)
    h.attachMedia(ref.current!)
    setReady(true)
    ref.current!.play().catch(() => {})
  }
  return (
    <div class={box ? 'vid shaped' : 'vid'} style={box} onClick={stop}>
      {/* nothing loads from the video's host until it's played (no data spent, no third-party cookies) */}
      <video ref={ref} src={hls ? undefined : src} poster={poster(src)} controls={ready} preload="none" playsInline
        onLoadedMetadata={(e) => e.currentTarget.videoWidth && setPlayed({ src, size: [e.currentTarget.videoWidth, e.currentTarget.videoHeight] })} />
      {!ready && <button class="play" aria-label={t('Play video')} onClick={start}><Icon d={P.play} fill size={26} /></button>}
    </div>
  )
}

/** Images (up to four in a grid, opening the viewer) and videos from a list of URLs. */
// `images`: every url is an image, whatever it looks like (an unfurl found the type)
export function Media({ urls: given, images }: { urls: string[]; images?: boolean }) {
  const urls = given.flatMap((u) => safeUrl(u) ?? [])
  const imgs = images ? urls : urls.filter(isImg)
  const shown = imgs.slice(0, 4)
  // a lone image keeps its own shape; when warm() learned its size, its box has that shape before it loads
  const box = boxOf(shown.length === 1 ? shapes.get(sized(shown[0], 'w=1200')) : null)
  return (
    <>
      {imgs.length > 0 && (
        <div class={`imgs n${shown.length}`} onClick={stop}>
          {shown.map((u, i) => (
            <button class="img" aria-label={t('Open image {n} of {total}', { n: i + 1, total: imgs.length })} onClick={() => shell.view(imgs, i)}>
              <Img src={our(sized(u, 'w=1200'))} style={box} {...((box || shown.length > 1) && srcsetOf(u) ? { srcset: our(srcsetOf(u)!), sizes: IMG_SIZES } : {})} />
              {i === 3 && imgs.length > 4 && <span class="more-imgs">+{imgs.length - 4}</span>}
            </button>
          ))}
        </div>
      )}
      {/* keyed: a Media handed another cast's videos (a tapped reply) starts each one fresh, its shape and player too */}
      {urls.filter(isVid).map((u) => <Video key={u} src={u} />)}
    </>
  )
}

/** Full-screen image viewer: arrows, keyboard and swipe move between images. */
export function Lightbox({ urls, index, close }: { urls: string[]; index: number; close: () => void }) {
  const [i, setI] = useState(index)
  const many = urls.length > 1
  const step = (d: number) => many && setI((x) => (x + d + urls.length) % urls.length)
  const touch = useRef(0)
  useEffect(() => {
    const key = (e: KeyboardEvent) => (e.key === 'Escape' ? close() : e.key === 'ArrowRight' ? step(1) : e.key === 'ArrowLeft' ? step(-1) : null)
    addEventListener('keydown', key)
    document.body.style.overflow = 'hidden'
    return () => (removeEventListener('keydown', key), (document.body.style.overflow = ''))
  }, [])
  const src = safeUrl(urls[i])
  return (
    <div class="lightbox" role="dialog" aria-label={t('Image viewer')} onClick={close}
      onTouchStart={(e) => (touch.current = e.touches[0].clientX)}
      onTouchEnd={(e) => {
        const dx = e.changedTouches[0].clientX - touch.current
        Math.abs(dx) > 50 && step(dx < 0 ? 1 : -1)
      }}>
      <img src={src} alt="" referrerpolicy="no-referrer" onClick={stop} />
      <button class="lb-btn lb-close" aria-label={t('Close')} onClick={close}><Icon d={P.x} size={22} /></button>
      {many && (
        <>
          <button class="lb-btn lb-prev" aria-label={t('Previous image')} onClick={(e) => (stop(e), step(-1))}><Icon d={P.back} size={22} /></button>
          <button class="lb-btn lb-next" aria-label={t('Next image')} onClick={(e) => (stop(e), step(1))}><Icon d={P.back} size={22} /></button>
          <span class="lb-count">{i + 1} / {urls.length}</span>
        </>
      )}
      {src && <a class="lb-open" href={src} target="_blank" rel="noopener noreferrer" onClick={stop}>{t('Open original')}</a>}
    </div>
  )
}

type Tweet = { text: string; author: { name?: string; handle?: string; avatar?: string }; at?: number; photos: string[]; video?: string; likes?: number; replies?: number; reposts?: number; quote?: { name?: string; handle?: string; text?: string } }
type Unfurl = { url: string; title?: string; description?: string; image?: string; button?: string; icon?: string; tweet?: Tweet; app?: AppMeta } | null

function TweetCard({ u, t }: { u: string; t: Tweet }) {
  const video = safeUrl(t.video)
  return (
    <div class="tweet" onClick={(e) => (stop(e), open(u, '_blank', 'noopener,noreferrer'))} role="link" tabIndex={0}>
      <div class="tw-head">
        {safeUrl(t.author.avatar) && <Img class="tw-av" src={safeUrl(t.author.avatar)} low />}
        {/* the X logo by the name: alone in the corner it looked like a close button */}
        <b>{t.author.name}</b><svg class="tw-x" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d={X_LOGO} fill="currentColor" /></svg>
        <span class="handle">@{t.author.handle}</span>
        {t.at && <span class="handle tw-at">· {ago(new Date(t.at * 1000).toISOString())}</span>}
      </div>
      {t.text && <RichText text={t.text.replace(/\s*https:\/\/t\.co\/\S+$/, '')} class="text tw-text" />}
      {t.photos.length > 0 && <Media urls={t.photos} />}
      {!t.photos.length && video && <div class="tw-video"><Img src={video} low /><span class="play"><Icon d={P.play} fill size={24} /></span></div>}
      {t.quote && <div class="tw-quote"><b>{t.quote.name}</b> <span class="handle">@{t.quote.handle}</span><p>{t.quote.text}</p></div>}
      <div class="tw-stats"><span>{tn(t.replies || 0, '{n} reply', '{n} replies', { n: n(t.replies) })}</span><span>{tn(t.reposts || 0, '{n} repost', '{n} reposts', { n: n(t.reposts) })}</span><span>{tn(t.likes || 0, '{n} like', '{n} likes', { n: n(t.likes) })}</span></div>
    </div>
  )
}
const unfurls = new Map<string, Promise<Unfurl>>()
export const unfurl = (u: string) => {
  if (!unfurls.has(u)) unfurls.set(u, fetch(`/api/unfurl?url=${encodeURIComponent(u)}`).then((r) => r.json(), () => null).then((d) => (got.set(`u:${u}`, d), d)))
  return unfurls.get(u)!
}

// What arrived already (link previews `u:`, casts `c:`) and image sizes the server read: a card drawn after warm()
// starts from them, at its final size
const got = new Map<string, unknown>()
const shapes = new Map<string, [number, number] | null>()
// the home page's first picture comes through quilcast.com (server/home.mjs `lead`); the app asks for it the same way,
// so it's the picture already there rather than another download
let lead = ''
const our = (s: string) => (lead && s.includes(lead.replace(/w=1200$/, '')) ? viaUs(s) : s)

/** What the server drew its home page with (server/home.mjs): with them the app's first frame is that page. */
export function seed(d: { got: Record<string, unknown>; shapes: Record<string, [number, number] | null>; lead?: string }) {
  lead = d.lead || ''
  for (const [k, v] of Object.entries(d.got)) {
    got.set(k, v)
    if (k.startsWith('u:')) unfurls.set(k.slice(2), Promise.resolve(v as Unfurl))
    else castCache.set(k.slice(2), Promise.resolve(v as Cast))
  }
  for (const [u, s] of Object.entries(d.shapes)) shapes.set(u, s)
}

/** Before a feed's first page shows: the link previews, quoted casts and lone images' sizes its first casts would load
 * anyway, so each is drawn at its final size instead of growing (and pushing the posts below) when it arrives. Waits
 * at most `ms`; whatever is late loads as before. */
export function warm(casts: Cast[], ms = 800) {
  const jobs: Promise<unknown>[] = []
  const lone: string[] = []
  for (const c of casts) {
    const urls = urlsOf(c)
    const imgs = urls.filter(isImg)
    if (imgs.length === 1) lone.push(sized(imgs[0], 'w=1200'))
    // a video's shape is its poster's, which the server reads (only Farcaster's streams have one)
    lone.push(...urls.filter((u) => isVid(u) && poster(u)))
    for (const u of urls) {
      const path = ownPath(safeUrl(u))
      const q = castOf(path)
      if (q) jobs.push(fetchCast(q))
      else if (!isImg(u) && !isVid(u) && !spaceOf(u) && !/^\/(design|theme)\//.test(path)) jobs.push(unfurl(u))
    }
    for (const e of c.embeds) if (/^(0x)?[0-9a-f]{40}$/i.test(e.cast_id?.hash || '')) jobs.push(fetchCast(e.cast_id!.hash))
  }
  const todo = [...new Set(lone)].filter((u) => !shapes.has(u)).slice(0, 8)
  if (todo.length)
    jobs.push(fetch(`/api/shapes?${todo.map((u) => `u=${encodeURIComponent(u)}`).join('&')}`).then((r) => r.json()).then((d) => {
      for (const u of todo) shapes.set(u, d?.[u] ?? null)
    }, () => {}))
  return Promise.race([Promise.allSettled(jobs), new Promise((ok) => setTimeout(ok, ms))])
}

// --- the app's theme (themes.tsx makes and picks them) ---
// `theme` is the one this browser wears, saved; `worn` is what the page shows, which differs only while the editor
// previews a draft. Everything is CSS variables and data-* switches on <html> (style.css), set before the first paint.

export let theme: Theme | null = (() => {
  const th = cleanTheme(read('quilcast:theme', null))
  return Object.keys(th).length ? th : null
})()
export let worn = theme
let vars: string[] = []
let face: { url: string; f?: FontFace } | undefined
/** Show `th` on the page (null: the plain app); `keep` also makes it this browser's theme. */
export function wear(th: Theme | null, keep = false) {
  const root = document.documentElement
  for (const k of vars) root.style.removeProperty(k)
  const v = th ? themeVars(th) : {}
  for (const [k, val] of Object.entries(v)) root.style.setProperty(k, val)
  vars = Object.keys(v)
  const d = root.dataset
  const flag = (k: string, on: unknown, val = '') => (on ? (d[k] = val) : delete d[k])
  flag('th', th), flag('thImg', th?.bgImg), flag('thFx', th?.fx), flag('thBar', th?.barImg), flag('thBtn', th?.btnImg), flag('thGlow', th?.glow), flag('thName', th?.nameFx, th?.nameFx), flag('thZoom', th?.size)
  // light or dark: a theme brings its own, else Settings decides
  th?.base ? (d.theme = th.base) : settings.theme === 'system' ? delete d.theme : (d.theme = settings.theme)
  // a Quorum theme's own font, from our media
  if (face?.url !== th?.fontUrl) {
    face?.f && document.fonts.delete(face.f)
    const now: typeof face = (face = th?.fontUrl ? { url: th.fontUrl } : undefined)
    if (now) new FontFace('quilcast-theme', `url("${ownMedia(now.url)}")`).load().then((f) => face === now && document.fonts.add((now.f = f)), () => {})
  }
  if (keep) (theme = th), th ? save('quilcast:theme', th) : localStorage.removeItem('quilcast:theme')
  worn = th
  dispatchEvent(new Event('theme'))
}

/** Themes this browser has tried, newest first (Settings > Theme lists them); a shared one keeps its link id. */
export type Saved = { theme: Theme; id?: string; quorum?: string }
export const library = () => read<Saved[]>('quilcast:themes', []).map((x) => ({ ...x, theme: cleanTheme(x?.theme) })).filter((x) => Object.keys(x.theme).length)
export const remember = (x: Saved) => {
  const same = (y: Saved) => JSON.stringify(y.theme) === JSON.stringify(x.theme)
  save('quilcast:themes', [x, ...library().filter((y) => !same(y))].slice(0, 40))
}

// a theme's stickers are placed on the screen, a bit smaller than a share of it on wide ones
export const screenUnit = (w: number) => `calc(min(1vw, 6px) * ${w})`

/** The worn theme's background, effect and stickers, behind and over the page. */
export function ThemeLayers({ stickers = true }: { stickers?: boolean }) {
  const [th, setTh] = useState(worn)
  const fx = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const f = () => setTh(worn)
    addEventListener('theme', f)
    return () => removeEventListener('theme', f)
  }, [])
  useEffect(() => {
    if (!th?.fx) return
    let stop: (() => void) | undefined
    let live = true
    import('./fx.ts').then((m) => live && fx.current && (stop = m.start(fx.current, th.fx!)))
    return () => ((live = false), stop?.())
  }, [th?.fx])
  if (!th) return null
  return (
    <>
      {th.bgImg && <div class={`th-bg ${th.bgMode || 'tile'}`} aria-hidden="true" />}
      {th.fx && <canvas class="lk-fx th-fx" ref={fx} aria-hidden="true" />}
      {stickers && th.stickers?.map((s) => (
        <img class="lk-stk th-stk" src={s.src} alt="" loading="lazy" referrerpolicy="no-referrer" style={{ left: `${s.x}%`, top: `${s.y}%`, width: screenUnit(s.w), rotate: s.r ? `${s.r}deg` : undefined }} />
      ))}
    </>
  )
}

const shared = new Map<string, Promise<Theme | null>>()
export const themeOf = (id: string) => {
  if (!shared.has(id)) shared.set(id, fetch(`/api/theme/${id}`).then((r) => (r.ok ? r.json() : null)).then((j) => j && cleanTheme(j), () => null))
  return shared.get(id)!
}

/** Wear a theme and keep it in the list; the one it replaced comes back with undo(). */
export function useApply(th: Theme | null | undefined, meta: Omit<Saved, 'theme'> = {}) {
  const [before, setBefore] = useState<Theme | null | false>(false)
  const on = !!th && JSON.stringify(theme) === JSON.stringify(th)
  return {
    on, undo: before !== false && on ? () => (wear(before, true), setBefore(false)) : undefined,
    apply: () => th && (setBefore(theme), remember({ ...meta, theme: th }), wear(th, true), toast('Theme applied')),
  }
}

// what a theme leaves out is the plain app's, not whatever theme the page around the card wears
export const CARD = { '--rs': '1', '--bw': '1px', '--bs': 'solid', '--th-font': FONTS.system, '--th-img': 'none', '--th-scrim': 'transparent', '--th-sheer': '88%', '--th-bar': 'none', '--th-btn': 'none' }
/** A shared theme (quilcast.com/theme/<id>): a small Quilcast in its colors, background and corners, with its name,
 *  who shared it (`by`) and a button that puts it on. */
export function ThemeCard({ id, by, big }: { id: string; by?: User; big?: boolean }) {
  const [th, setTh] = useState<Theme | null>()
  useEffect(() => void themeOf(id).then(setTh), [id])
  const [, force] = useState(0)
  useEffect(() => {
    const f = () => force((x) => x + 1)
    addEventListener('theme', f)
    return () => removeEventListener('theme', f)
  }, [])
  const a = useApply(th, { id })
  if (th === null) return <div class="quote muted">{t('This theme is unavailable.')}</div>
  if (!th) return <div class="quote skeleton" />
  // the card shows the theme whole, so whatever it leaves out comes from the app's own colors for its base
  const c: Theme = { ...DEFAULTS[th.base || 'dark'], ...th }
  const cls = (k: string, on: unknown) => (on ? ` ${k}` : '')
  return (
    <div class={`thc${big ? ' big' : ''}${cls('thc-img', th.bgImg)}${cls('thc-bar-img', th.barImg)}${cls('thc-btn', th.btnImg)}${cls('thc-glow', th.glow)}`} style={{ ...CARD, '--bar': c.bg, '--lk-name': c.accent, ...themeVars(c), colorScheme: c.base || 'dark' }} onClick={stop}>
      {th.bgImg && <div class={`th-bg ${th.bgMode || 'tile'}`} aria-hidden="true" />}
      <div class="thc-app" aria-hidden="true">
        <div class="thc-bar"><b>{t('Home')}</b></div>
        {[c.accent, c.like, c.recast].map((col, i) => (
          <div class="thc-cast">
            <i style={{ background: col as string }} />
            <span><b class={`name${th.nameFx ? ` lk-name ${th.nameFx}` : ''}`}>{['Quilcast', 'Ada', 'Satoshi'][i]}</b><em /><em /></span>
          </div>
        ))}
      </div>
      <div class="thc-info">
        <small>{by ? t('Theme by {name}', { name: nameOf(by) }) : t('Quilcast theme')}</small>
        <b class={th.nameFx ? `lk-name ${th.nameFx}` : undefined}>{th.name || t('Untitled theme')}</b>
        <span class="thc-dots">{(['bg', 'card', 'ink', 'accent', 'like', 'recast'] as const).map((k) => <i style={{ background: c[k] as string }} />)}</span>
        <span class="btns">
          <button class="btn small" disabled={a.on} onClick={a.apply}>{a.on ? t('Applied') : t('Apply theme')}</button>
          {a.undo && <button class="btn ghost small" onClick={a.undo}>{t('Undo')}</button>}
          {big && <button class="btn ghost small" onClick={() => shell.editTheme(th)}>{t('Customize')}</button>}
        </span>
      </div>
    </div>
  )
}

// Open Graph preview, fetched through our server; a plain domain row until (or unless) it arrives.
// In a cast (`c`), a mini app's card opens the app.
export function LinkCard({ u: given, c }: { u: string; c?: Cast }) {
  const u = safeUrl(given)
  const path = ownPath(u)
  const design = /^\/design\//.test(path) ? designId(path) : undefined
  const themeLink = /^\/theme\//.test(path) ? themeId(path) : undefined
  const cast = castOf(path)
  const [d, setD] = useState<Unfurl | undefined>(() => (u ? (got.get(`u:${u}`) as Unfurl) : undefined))
  useEffect(() => void (u && !d && !design && !themeLink && !cast && unfurl(u).then(setD)), [u])
  if (!u) return null
  if (design) return <DesignCard id={design} by={c?.author} />
  if (themeLink) return <ThemeCard id={themeLink} by={c?.author} />
  if (cast) return <QuoteCard hash={cast} />
  if (d?.tweet) return <TweetCard u={u} t={d.tweet} />
  const image = safeUrl(d?.image)
  // a link straight to an image renders as the image
  if (image && d?.image === d?.url) return <Media urls={[image]} images />
  const icon = safeUrl(d?.icon)
  const app = c && d?.app
  return (
    <a class={`linkcard${image ? ' big' : ''}`} href={u} target="_blank" rel="noopener noreferrer nofollow"
      onClick={(e) => (e.stopPropagation(), app && !e.metaKey && !e.ctrlKey && !e.shiftKey && (e.preventDefault(), launchApp({ ...app, icon }, { cast: c, embed: u })))}>
      {image && <Img class="lc-img" src={sized(image, 'w=1200')} low />}
      <span class="lc-text">
        <span class="lc-site">{icon && <Img src={icon} low />}{new URL(u).hostname.replace(/^www\./, '')}</span>
        {d?.title && <b class="lc-title">{d.title}</b>}
        {d?.description && <span class="lc-desc">{d.description}</span>}
      </span>
      {d?.button && <span class="lc-btn">{d.button}</span>}
    </a>
  )
}

// our own links (quilcast.com, or wherever this copy runs) show natively: casts as quotes, designs as cards
const ownPath = (u?: string) => {
  const x = u && new URL(u)
  return x && (x.host === 'quilcast.com' || x.host === location.host) ? x.pathname : ''
}

const designs = new Map<string, Promise<Look | null>>()
export const designOf = (id: string) => {
  if (!designs.has(id)) designs.set(id, fetch(`/api/design/${id}`).then((r) => (r.ok ? r.json() : null)).then((j) => j && cleanDesign(j), () => null))
  return designs.get(id)!
}

/** A shared profile design (quilcast.com/design/<id>): one box in its colors, border, font and name effect, on its
 *  background, naming whoever shared it (`by`), with a button that opens it in the viewer's editor. */
export function DesignCard({ id, by }: { id: string; by?: User }) {
  const [d, setD] = useState<Look | null>()
  useEffect(() => void designOf(id).then(setD), [id])
  if (d === null) return <div class="quote muted">{t('This design is unavailable.')}</div>
  if (!d) return <div class="quote skeleton" />
  const use = (e: Event) => {
    e.stopPropagation()
    const me = myUser()
    requireAccount() && go(`${me ? userPath(me) : `/u/${account!.fid}`}?design=${id}`)
  }
  return (
    <div class="design look on" style={lookVars(d)} onClick={stop}>
      <div class={`lk-bg ${d.bgMode || 'tile'}`} aria-hidden="true"
        style={{ backgroundColor: d.bg, backgroundImage: d.bgImg ? `url("${d.bgImg}")` : undefined, '--lk-dim': d.bgDim ? String(d.bgDim / 100) : undefined }} />
      <div class="lk-box">
        <span class="design-who">
          {by ? <Avatar u={by} size={36} link={false} /> : <Logo size={36} />}
          <span>
            <b class={d.nameFx && d.nameFx !== 'none' ? `lk-name ${d.nameFx}` : undefined}>{by ? nameOf(by) : 'Quilcast'}</b>
            <small>{t('Profile design')}</small>
          </span>
        </span>
        <button class="btn small" style={{ color: d.box }} onClick={use}>{t('Use this design')}</button>
      </div>
    </div>
  )
}

/** Casts last pressed in a list, so the cast page can draw one before the node answers. */
export const cards = new Map<string, Cast>()
const castCache = new Map<string, Promise<Cast | null>>()
export const fetchCast = (hash: string) => {
  hash = hash.replace(/^0x/, '').toLowerCase()
  if (!castCache.has(hash)) castCache.set(hash, get('/v2/farcaster/cast', { identifier: hash, type: 'hash', viewer_fid: account?.fid }).then((r) => r.cast, () => null).then((c) => (got.set(`c:${hash}`, c), c)))
  return castCache.get(hash)!
}

export function QuoteCard({ hash, c: given }: { hash?: string; c?: Cast }) {
  const [c, setC] = useState<Cast | null | undefined>(() => given ?? (hash ? (got.get(`c:${hash.replace(/^0x/, '').toLowerCase()}`) as Cast | null | undefined) : undefined))
  useEffect(() => void (hash && c === undefined && fetchCast(hash).then(setC)), [hash])
  if (c === null) return <div class="quote muted">{t('This cast is unavailable.')}</div>
  if (!c) return <div class="quote skeleton" />
  if (hides(c)) return <div class="quote muted">{t('Hidden by your mutes.')}</div>
  const img = thumbOf(c)
  const text = castText(c).trim()
  return (
    <a class="quote" href={`/c/${c.hash}`} onClick={stop}>
      <div class="meta"><Avatar u={c.author} size={18} link={false} /><b>{nameOf(c.author)}</b><span>@{handle(c.author)} · {ago(c.timestamp)}</span></div>
      {/* text gets a thumbnail beside it; a cast that is only media shows it at size */}
      <div class={`qbody${text ? '' : ' bare'}`}>
        {text && <RichText text={text} class="text clamp" />}
        {img && <Img class="qimg" src={sized(img, 'w=1200')} />}
      </div>
    </a>
  )
}


/** A Space linked in a cast. Its details need a farcaster.xyz token, so they load only for accounts that turned Spaces on. */
function SpaceEmbed({ id }: { id: string }) {
  const [Card, setCard] = useState<((p: { id: string }) => any) | null>(null)
  useEffect(() => void (account?.fcx && import('./spaces.tsx').then((m) => setCard(() => m.SpaceCard))), [])
  if (Card) return <Card id={id} />
  return (
    <a class="space-card" href={`/spaces/${id}`} onClick={stop}>
      <span class="space-card-top"><Icon d={P.mic} /><small>{tr('Space')}</small></span>
      <b>{tr('Live audio Space')}</b>
      <small>{tr('Listen on Quilcast')}</small>
    </a>
  )
}

function Embeds({ c }: { c: Cast }) {
  const urls = urlsOf(c)
  // a link to a cast on Quilcast is shown as a quote, like a quoted cast
  const linked = (u: string) => castOf(ownPath(safeUrl(u)))
  const spaces = [...new Set(urls.flatMap((u) => spaceOf(u) || []))]
  const links = urls.filter((u) => !isImg(u) && !isVid(u) && !linked(u) && !spaceOf(u))
  const quotes = [...new Set([...c.embeds.flatMap((e) => (/^(0x)?[0-9a-f]{40}$/i.test(e.cast_id?.hash || '') ? [e.cast_id!.hash.replace(/^0x/, '').toLowerCase()] : [])), ...urls.flatMap((u) => linked(u) || [])])]
  const cards = [...spaces.map((id) => <SpaceEmbed id={id} />), ...links.map((u) => <LinkCard u={u} c={c} />)]
  const { strip, compact } = embedLayout(urls, cards.length)
  // quoted casts are text, so they stay full width below
  return (
    <>
      {strip ? <div class="strip"><Media urls={urls} /></div> : <Media urls={urls} />}
      {compact ? <div class="cards">{cards}</div> : cards}
      {quotes.map((h) => <QuoteCard hash={h} />)}
    </>
  )
}

// how long a mute or block lasts
export const spans = (): [string, number | undefined][] => [[t('For a day'), 864e5], [t('For a week'), 7 * 864e5], [t('For a month'), 30 * 864e5], [t('Until I lift it'), undefined]]
export const untilText = (until?: number) =>
  until ? t('until {date}', { date: new Date(until).toLocaleString(lang, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) }) : ''

const report = (u: User, c?: Cast) => {
  const link = c ? `https://quilcast.com/c/${c.hash}` : `https://quilcast.com${userPath(u)}`
  const what = c ? `cast ${c.hash} by @${handle(u)} (fid ${u.fid})` : `@${handle(u)} (fid ${u.fid})`
  return `mailto:support@borodutch.com?subject=${encodeURIComponent(`Quilcast report: ${what}`)}&body=${encodeURIComponent(`${link}\n\nWhat's wrong with it:\n`)}`
}

/** Menu items that mute or block someone, or lift it; picking one asks how long, in the same menu. Report emails us
 *  the person (or cast `c`), for everyone, signed in or not (App Store guideline 1.2). */
export function SilenceItems({ u, c, done }: { u: User; c?: Cast; done: () => void }) {
  const [kind, setKind] = useState<'users' | 'blocks' | null>(null)
  const set = (k: 'users' | 'blocks', until?: number | false) => {
    done()
    const name = handle(u)
    setMute(k, u.fid, until).then(
      () => toast(until === false ? (k === 'blocks' ? t('Unblocked @{name}', { name }) : t('Unmuted @{name}', { name })) : k === 'blocks' ? t('Blocked @{name}', { name }) : t('Muted @{name}', { name })),
      (e) => toast(e.message),
    )
  }
  const ask = (k: 'users' | 'blocks', on: unknown) => requireAccount() && (on ? set(k, false) : setKind(k))
  if (kind)
    return (
      <>
        <div class="menu-label muted">{kind === 'blocks' ? t('Block @{name} for…', { name: handle(u) }) : t('Mute @{name} for…', { name: handle(u) })}</div>
        {spans().map(([label, ms]) => <button role="menuitem" onClick={() => set(kind, ms && Date.now() + ms)}>{label}</button>)}
        <p class="menu-label hint">{kind === 'blocks' ? t('Their casts, replies and notifications vanish everywhere on Quilcast. Farcaster has no blocking, so they can still see your casts.') : t('Their casts and notifications stay out of sight, except on their profile.')}</p>
      </>
    )
  const m = muteOf(u.fid)
  const b = blockOf(u.fid)
  return (
    <>
      <button role="menuitem" onClick={() => ask('users', m)}><Icon d={P.mute} />{m ? t('Unmute @{name}', { name: handle(u) }) : t('Mute @{name}', { name: handle(u) })}</button>
      <button role="menuitem" class="danger" onClick={() => ask('blocks', b)}><Icon d={P.block} />{b ? t('Unblock @{name}', { name: handle(u) }) : t('Block @{name}', { name: handle(u) })}</button>
      <a role="menuitem" class="danger" href={report(u, c)} onClick={done}><Icon d={P.flag} />{c ? t('Report this cast') : t('Report @{name}', { name: handle(u) })}</a>
    </>
  )
}

/** A cast row. `focus` is the thread's main cast; `line` draws the thread connector down to the next row; `owner` is
 *  the profile it's shown on (see hides()). */
export function CastCard({ c, focus, line, inThread, quotes = 0, owner }: { c: Cast; focus?: boolean; line?: boolean; inThread?: boolean; quotes?: number; owner?: number }) {
  // what the node counted already includes our earlier reactions; local taps adjust from there
  const was = useMemo(() => [mine.likes.has(c.hash), mine.recasts.has(c.hash)], [c.hash, mineVersion])
  const [likedTap, setLiked] = useState<boolean | null>(null)
  const [recastTap, setRecast] = useState<boolean | null>(null)
  const liked = likedTap ?? was[0]
  const recast = recastTap ?? was[1]
  const [menu, setMenu] = useState(false)
  const [more, setMore] = useState(false)
  const [sure, setSure] = useState(false)
  const [gone, setGone] = useState(false)
  const toggle = (type: 1 | 2, on: boolean, set: (v: boolean) => void, bag: Set<string>) => {
    if (!requireAccount()) return
    set(on)
    on ? bag.add(c.hash) : bag.delete(c.hash)
    w().then((m) => m.react(type, on, c)).catch((e) => (set(!on), on ? bag.delete(c.hash) : bag.add(c.hash), toast(e.message)))
  }
  const share = () => {
    const url = `${location.origin}/c/${c.hash}`
    navigator.share ? navigator.share({ url }).catch(() => {}) : navigator.clipboard.writeText(url).then(() => toast('Link copied'))
  }
  // the delete button asks once more in the same spot
  const del = () => {
    if (!sure) return setSure(true)
    setMore(false)
    w().then((m) => m.deleteCast(c.hash)).then(() => (setGone(true), toast('Deleted')), (e) => toast(e.message))
  }
  // a cast opened on its own page shows whatever mutes say
  if (gone || (!focus && hides(c, owner))) return null
  const sending = posting.get(c.hash) === c
  const ch = channelOf(c.parent_url)
  const parentUser = c.parent_author?.fid ? users.get(c.parent_author.fid) : undefined
  const likes = c.reactions.likes_count + +liked - +was[0]
  const recasts = c.reactions.recasts_count + +recast - +was[1]
  const like = <button class={`act lk${liked ? ' on' : ''}`} aria-label={t('Like')} onClick={() => toggle(1, !liked, setLiked, mine.likes)}><Icon d={P.like} fill={liked} /><span>{likes ? n(likes) : ''}</span></button>
  const actions = (
    <footer onClick={stop}>
      {/* Quorum mode's order is Like, Reply, Recast */}
      {settings.quorum && like}
      <button class="act" aria-label={t('Reply')} onClick={() => requireAccount() && shell.compose({ parent: c })}><Icon d={P.reply} /><span>{c.replies.count ? n(c.replies.count) : ''}</span></button>
      <span class="wrap-menu">
        <button class={`act rc${recast ? ' on' : ''}`} aria-label={t('Recast or quote')} aria-haspopup="menu" onClick={() => setMenu(!menu)}><Icon d={P.recast} /><span>{recasts ? n(recasts) : ''}</span></button>
        {menu && (
          <Menu close={() => setMenu(false)}>
            <button role="menuitem" onClick={() => (setMenu(false), toggle(2, !recast, setRecast, mine.recasts))}><Icon d={P.recast} />{recast ? t('Undo recast') : t('Recast')}</button>
            <button role="menuitem" onClick={() => (setMenu(false), requireAccount() && shell.compose({ quote: c }))}><Icon d={P.quote} />{t('Quote')}</button>
          </Menu>
        )}
      </span>
      {!settings.quorum && like}
      <button class="act" aria-label={t('Share')} onClick={share}><Icon d={P.share} /></button>
      <span class="wrap-menu">
        <button class="act" aria-label={t('More')} aria-haspopup="menu" onClick={() => (setMore(!more), setSure(false))}><Icon d={P.more} /></button>
        {more && (
          <Menu class="right" close={() => setMore(false)}>
            {account?.done && account.fid === c.author.fid
              ? <button role="menuitem" class="danger" onClick={del}><Icon d={P.trash} />{sure ? t('Delete this cast?') : t('Delete')}</button>
              : <SilenceItems u={c.author} c={c} done={() => setMore(false)} />}
          </Menu>
        )}
      </span>
    </footer>
  )
  const name = (
    <>
      <a class="name" href={userPath(c.author)} onClick={stop}>{nameOf(c.author)}</a>
      <span class="handle">@{handle(c.author)}</span>
    </>
  )
  if (focus) {
    const stats = ([['recasts', recasts, tn(recasts, 'recast', 'recasts')], ['quotes', quotes, tn(quotes, 'quote', 'quotes')], ['likes', likes, tn(likes, 'like', 'likes')]] as const).filter(([, x]) => x > 0)
    return (
      <article class="cast focus">
        <header><Avatar u={c.author} size={44} /><div class="who">{name}</div>{ch && <span class="chan">/{ch}</span>}</header>
        <Said c={c} full />
        <Embeds c={c} />
        <div class="when">{sending ? <span class="posting"><span class="pulse" /> {t('Posting…')}</span> : new Date(c.timestamp).toLocaleString(lang, { hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric', year: 'numeric' })}</div>
        {stats.length > 0 && <div class="stats">{stats.map(([k, x, word]) => <a href={`/c/${c.hash}/${k}`}><b>{n(x)}</b> {word}</a>)}</div>}
        {actions}
      </article>
    )
  }
  return (
    <article class={`cast${line ? ' line' : ''}`} data-href={`/c/${c.hash}`} onPointerDown={() => cards.set(c.hash, c)} onClick={() => go(`/c/${c.hash}`)}>
      <div class="rail"><Avatar u={c.author} /></div>
      <div class="body">
        <header>
          {name}
          <span class="dot">·</span>
          {sending ? <span class="posting">{t('Posting…')}</span> : <time dateTime={c.timestamp} title={new Date(c.timestamp).toLocaleString(lang)}>{ago(c.timestamp)}</time>}
          {ch && <span class="chan">/{ch}</span>}
        </header>
        {c.parent_hash && !inThread && <div class="replying">{parentUser ? <>{t('Replying to')} <a href={userPath(parentUser)} onClick={stop}>@{handle(parentUser)}</a></> : t('Replying to a cast')}</div>}
        <Said c={c} />
        <Embeds c={c} />
        {actions}
      </div>
    </article>
  )
}

export const UserRow = ({ u }: { u: User }) => (
  <a class="row" href={userPath(u)}>
    <Avatar u={u} link={false} />
    <span class="row-main">
      <span class="row-top"><b>{nameOf(u)}</b><span class="handle">@{handle(u)}</span></span>
      {u.profile?.bio?.text && <span class="row-sub">{u.profile.bio.text}</span>}
    </span>
    <span class="row-meta">{n(u.follower_count)}<small>{tn(u.follower_count || 0, 'follower', 'followers')}</small></span>
  </a>
)
