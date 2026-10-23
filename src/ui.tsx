import type { ComponentChildren } from 'preact'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import { account, back, get, go, LINK_RE, read, save, mine, mineVersion, myUser, posting, safeUrl, toUrl, users, type Cast, type User } from './api.ts'
import { castText, cleanDesign, designId, isImg, isVid, LOGO, lookVars, n, sized, X_LOGO, type Look } from './shared.ts'
import type { AppMeta } from './miniapp.tsx'
import { lang, t, t as tr, tn } from './i18n.ts'

// keys and crypto load only when someone signs in or writes
export const w = () => import('./write.ts')

// module-level hooks the shell fills in, so any component can toast or open the composer
export const shell = {
  toast: (_: string) => {},
  // text, embeds and onDone come from mini apps; onDone gets the new cast's hash, or null if nothing was posted
  compose: (_: { parent?: Cast; quote?: Cast; channel?: string; text?: string; embeds?: string[]; onDone?: (hash: string | null) => void } = {}) => {},
  view: (_urls: string[], _index: number) => {},
  // the open mini apps (miniapp.tsx keeps these current and fires 'dock'); the dock shows them next to the pinned ones
  dock: { apps: [] as { id: number; url: string; name: string; icon?: string }[], shown: null as number | null, show: (_id: number) => {} },
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
export const launchUrl = (url: string) => requireAccount() && import('./miniapp.tsx').then((x) => x.launchUrl(url))

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
  image: 'M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM3 16l5-5 5 5M14 14l2-2 5 5M15.5 8.5h.01',
  hash: 'M4 9h16M4 15h16M10 3 8 21M16 3l-2 18',
  x: 'M18 6 6 18M6 6l12 12',
  play: 'M7 4v16l13-8z',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  bell: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0',
  mail: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM3 7l9 6 9-6',
  plus: 'M12 5v14M5 12h14',
  check: 'M20 6 9 17l-5-5',
  min: 'M6 12h12',
  wallet: 'M19 7V5a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H5a2 2 0 0 1-2-2V6M16.5 13.5h.01',
  apps: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  mic: 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v3',
  micOff: 'M2 2l20 20M19 10v2a7 7 0 0 1-.1 1M5 10v2a7 7 0 0 0 12 5M15 9.3V5a3 3 0 0 0-5.7-1.3M9 9v3a3 3 0 0 0 5.1 2.1M12 19v3',
  pin: 'M12 17v5M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2v.8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.8a2 2 0 0 0-1.1-1.8l-1.8-.9a2 2 0 0 1-1.1-1.8V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z',
}
export const Icon = ({ d, fill, size = 18 }: { d: string; fill?: boolean; size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill={fill ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
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
export const stop = (e: Event) => e.stopPropagation()

export const Header = ({ title, back: showBack = true, action, children }: { title?: ComponentChildren; back?: boolean; action?: ComponentChildren; children?: ComponentChildren }) => (
  <div class="phead">
    <div class="phead-row">
      {showBack ? <button class="icon-btn" aria-label={t('Back')} onClick={back}><Icon d={P.back} /></button> : <a class="brand only-mobile" href="/" aria-label={t('Quilcast home')}><Logo size={26} /></a>}
      <h1>{title}</h1>
      {action}
    </div>
    {children}
  </div>
)

export const Tabs = <T extends string>({ tabs, value, set }: { tabs: [T, string][]; value: T; set: (t: T) => void }) => (
  <nav class="tabs" role="tablist">
    {/* a list under tabs in the sticky header starts at its top, not wherever the previous one was scrolled to */}
    {tabs.map(([k, label]) => <button role="tab" aria-selected={value === k} class={value === k ? 'on' : ''} onClick={(e) => (e.currentTarget.closest('.phead') && scrollTo(0, 0), set(k))}>{label}</button>)}
  </nav>
)

/** Someone else's image: lazy, sent without a referrer, and hidden rather than broken when it fails. */
export const Img = (p: { src?: string; class?: string }) => (
  <img alt="" loading="lazy" referrerpolicy="no-referrer" onError={(e) => (e.currentTarget.style.display = 'none')} {...p} />
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

// links, @mentions and /channels inside cast text
const TOKENS = new RegExp(`(${LINK_RE.source}|(?<![\\w/])@[a-z0-9][a-z0-9.-]*[a-z0-9]|(?<![\\w/:])\\/[a-z0-9-]{2,}(?![\\w/]))`, 'gi')
const shortUrl = (s: string) => ((s = s.replace(/^https?:\/\/(www\.)?/, '')), s.length > 40 ? s.slice(0, 40) + '…' : s)
export function RichText({ text, class: cls = 'text' }: { text: string; class?: string }) {
  return (
    <p class={cls}>
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

export const urlsOf = (c: Cast) => c.embeds.flatMap((e) => safeUrl(e.url) ?? [])
// Farcaster's streams get a first-frame poster from our server
const poster = (src?: string) => (src && /^https:\/\/stream\.farcaster\.xyz\//.test(src) ? `/api/poster?url=${encodeURIComponent(src)}` : undefined)
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
    <div class="vid" onClick={stop}>
      <video ref={ref} src={hls ? undefined : src} poster={poster(src)} controls={ready} preload="metadata" playsInline />
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
  return (
    <>
      {imgs.length > 0 && (
        <div class={`imgs n${shown.length}`} onClick={stop}>
          {shown.map((u, i) => (
            <button class="img" aria-label={t('Open image {n} of {total}', { n: i + 1, total: imgs.length })} onClick={() => shell.view(imgs, i)}>
              <Img src={sized(u, 'w=1200')} />
              {i === 3 && imgs.length > 4 && <span class="more-imgs">+{imgs.length - 4}</span>}
            </button>
          ))}
        </div>
      )}
      {urls.filter(isVid).map((u) => <Video src={u} />)}
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
        {safeUrl(t.author.avatar) && <Img class="tw-av" src={safeUrl(t.author.avatar)} />}
        <b>{t.author.name}</b><span class="handle">@{t.author.handle}</span>
        {t.at && <span class="handle">· {ago(new Date(t.at * 1000).toISOString())}</span>}
        <svg class="tw-x" viewBox="0 0 24 24" width="16" height="16" aria-label="X"><path d={X_LOGO} fill="currentColor" /></svg>
      </div>
      {t.text && <RichText text={t.text.replace(/\s*https:\/\/t\.co\/\S+$/, '')} class="text tw-text" />}
      {t.photos.length > 0 && <Media urls={t.photos} />}
      {!t.photos.length && video && <div class="tw-video"><Img src={video} /><span class="play"><Icon d={P.play} fill size={24} /></span></div>}
      {t.quote && <div class="tw-quote"><b>{t.quote.name}</b> <span class="handle">@{t.quote.handle}</span><p>{t.quote.text}</p></div>}
      <div class="tw-stats"><span>{tn(t.replies || 0, '{n} reply', '{n} replies', { n: n(t.replies) })}</span><span>{tn(t.reposts || 0, '{n} repost', '{n} reposts', { n: n(t.reposts) })}</span><span>{tn(t.likes || 0, '{n} like', '{n} likes', { n: n(t.likes) })}</span></div>
    </div>
  )
}
const unfurls = new Map<string, Promise<Unfurl>>()
export const unfurl = (u: string) => {
  if (!unfurls.has(u)) unfurls.set(u, fetch(`/api/unfurl?url=${encodeURIComponent(u)}`).then((r) => r.json(), () => null))
  return unfurls.get(u)!
}

// Open Graph preview, fetched through our server; a plain domain row until (or unless) it arrives.
// In a cast (`c`), a mini app's card opens the app.
export function LinkCard({ u: given, c }: { u: string; c?: Cast }) {
  const u = safeUrl(given)
  const path = ownPath(u)
  const design = /^\/design\//.test(path) ? designId(path) : undefined
  const cast = castOf(path)
  const [d, setD] = useState<Unfurl>()
  useEffect(() => void (u && !design && !cast && unfurl(u).then(setD)), [u])
  if (!u) return null
  if (design) return <DesignCard id={design} by={c?.author} />
  if (cast) return <QuoteCard hash={cast} />
  if (d?.tweet) return <TweetCard u={u} t={d.tweet} />
  const image = safeUrl(d?.image)
  // a link straight to an image renders as the image
  if (image && d?.image === d?.url) return <Media urls={[image]} images />
  const icon = safeUrl(d?.icon)
  const app = c && d?.app
  return (
    <a class={`linkcard${image ? ' big' : ''}`} href={u} target="_blank" rel="noopener noreferrer nofollow"
      onClick={(e) => (stop(e), app && !e.metaKey && !e.ctrlKey && !e.shiftKey && (e.preventDefault(), launchApp({ ...app, icon }, { cast: c, embed: u })))}>
      {image && <Img class="lc-img" src={sized(image, 'w=1200')} />}
      <span class="lc-text">
        <span class="lc-site">{icon && <Img src={icon} />}{new URL(u).hostname.replace(/^www\./, '')}</span>
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
const castOf = (path: string) => path.match(/^\/c\/(?:0x)?([0-9a-f]{40})$/i)?.[1].toLowerCase()

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
    stop(e)
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

const castCache = new Map<string, Promise<Cast | null>>()
export const fetchCast = (hash: string) => {
  hash = hash.replace(/^0x/, '')
  if (!castCache.has(hash)) castCache.set(hash, get('/v2/farcaster/cast', { identifier: hash, type: 'hash', viewer_fid: account?.fid }).then((r) => r.cast, () => null))
  return castCache.get(hash)!
}

export function QuoteCard({ hash, c: given }: { hash?: string; c?: Cast }) {
  const [c, setC] = useState<Cast | null | undefined>(given)
  useEffect(() => void (hash && !given && fetchCast(hash).then(setC)), [hash])
  if (c === null) return <div class="quote muted">{t('This cast is unavailable.')}</div>
  if (!c) return <div class="quote skeleton" />
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

/** The room id in a farcaster.xyz Space link. */
export const spaceOf = (u: string) => u.match(/^https?:\/\/(?:www\.)?(?:warpcast\.com|farcaster\.xyz)\/~\/spaces\/([\w-]{1,64})\/?(?:[?#].*)?$/)?.[1]

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
  const all = (
    <>
      <Media urls={urls} />
      {spaces.map((id) => <SpaceEmbed id={id} />)}
      {links.map((u) => <LinkCard u={u} c={c} />)}
    </>
  )
  // several embeds (the images count as one) sit side by side and scroll, instead of stacking into a tall cast;
  // quoted casts are text, so they stay full width below (squeezed into a tile they stretched into an empty box)
  return (
    <>
      {+urls.some(isImg) + urls.filter(isVid).length + links.length + spaces.length > 1 ? <div class="strip">{all}</div> : all}
      {quotes.map((h) => <QuoteCard hash={h} />)}
    </>
  )
}

/** A cast row. `focus` is the thread's main cast; `line` draws the thread connector down to the next row. */
export function CastCard({ c, focus, line, inThread, quotes = 0 }: { c: Cast; focus?: boolean; line?: boolean; inThread?: boolean; quotes?: number }) {
  // what the node counted already includes our earlier reactions; local taps adjust from there
  const was = useMemo(() => [mine.likes.has(c.hash), mine.recasts.has(c.hash)], [c.hash, mineVersion])
  const [likedTap, setLiked] = useState<boolean | null>(null)
  const [recastTap, setRecast] = useState<boolean | null>(null)
  const liked = likedTap ?? was[0]
  const recast = recastTap ?? was[1]
  const [menu, setMenu] = useState(false)
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
  if (gone) return null
  const sending = posting.get(c.hash) === c
  const ch = channelOf(c.parent_url)
  const parentUser = c.parent_author?.fid ? users.get(c.parent_author.fid) : undefined
  const likes = c.reactions.likes_count + +liked - +was[0]
  const recasts = c.reactions.recasts_count + +recast - +was[1]
  const actions = (
    <footer onClick={stop}>
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
      <button class={`act lk${liked ? ' on' : ''}`} aria-label={t('Like')} onClick={() => toggle(1, !liked, setLiked, mine.likes)}><Icon d={P.like} fill={liked} /><span>{likes ? n(likes) : ''}</span></button>
      <button class="act" aria-label={t('Share')} onClick={share}><Icon d={P.share} /></button>
      {focus && account?.fid === c.author.fid && <button class="act" aria-label={t('Delete')} onClick={() => w().then((m) => m.deleteCast(c.hash)).then(() => (setGone(true), toast('Deleted')), (e) => toast(e.message))}><Icon d={P.trash} /></button>}
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
        <RichText text={castText(c)} />
        <Embeds c={c} />
        <div class="when">{sending ? <span class="posting"><span class="pulse" /> {t('Posting…')}</span> : new Date(c.timestamp).toLocaleString(lang, { hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric', year: 'numeric' })}</div>
        {stats.length > 0 && <div class="stats">{stats.map(([k, x, word]) => <a href={`/c/${c.hash}/${k}`}><b>{n(x)}</b> {word}</a>)}</div>}
        {actions}
      </article>
    )
  }
  return (
    <article class={`cast${line ? ' line' : ''}`} onClick={() => go(`/c/${c.hash}`)}>
      <div class="rail"><Avatar u={c.author} /></div>
      <div class="body">
        <header>
          {name}
          <span class="dot">·</span>
          {sending ? <span class="posting">{t('Posting…')}</span> : <time dateTime={c.timestamp} title={new Date(c.timestamp).toLocaleString(lang)}>{ago(c.timestamp)}</time>}
          {ch && <span class="chan">/{ch}</span>}
        </header>
        {c.parent_hash && !inThread && <div class="replying">{parentUser ? <>{t('Replying to')} <a href={userPath(parentUser)} onClick={stop}>@{handle(parentUser)}</a></> : t('Replying to a cast')}</div>}
        <Folded text={castText(c)} />
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
