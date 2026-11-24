import type { ComponentChildren } from 'preact'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import { account, ALERTS, articleNow, articleOf, back, follow, get, getJson, go, read, readArticle, save, mine, mineVersion, taps, tapped, myUser, got, posting, safeUrl, settings, users, type ArticleRead, type Cast, type User } from './api.ts'
import { ARTICLE, cardOpening, coverOf, headOf, isArticle, segments, type Embed, type Part } from './article.ts'
import { articleHtml, emojisOf, boxOf, castOf, pathOf, linkify, lookalike, markdown, castText, taggable, cleanDesign, cleanLibrary, cleanTheme, DEFAULTS, designId, embedLayout, FONTS, holidayOn, isImg, isVid, LOGO, lookPage, lookVars, n, ownMedia, P, peekOf, poster, quotedOf, type CastRef, proxied, sized, IMG_SIZES, spaceOf, srcsetOf, stickerPack, packLink, isTrain, themeId, themeVars, urlsOf, viaUs, vidBoxOf, playedOf, vidShape, X_LOGO, type Look, type Saved, type Theme } from './shared.ts'
export { spaceOf }
import type { AppMeta } from './miniapp.tsx'
import { legacy } from './channels.ts'
import { lang, t, t as tr, tn } from './i18n.ts'
import { blockOf, hides, muteOf, setMute } from './mutes.ts'
import { spamAccountOf, spamOf } from './spam.ts'
import { swoosh } from './swoosh.ts'
import { choochoo, runTrain } from './choochoo.ts'
import { trainOk, trainSheet, trainTold } from './trainask.ts'
import { holdTip, setHoldTip, tipOk, tipSheet, tipTold } from './tipask.ts'
import { pinKey, pinnedCast, setPinnedCast, usePinnedCast } from './castpin.ts'
import { noTranslate, offersTranslation, translatableFrom } from './lang.ts'
import { bound, FIT, TAP_ZOOM, zoomAt, type Zoom } from './zoom.ts'

// keys and crypto load only when someone signs in or writes
export const w = () => import('./write.ts')
// called apart from its .then: Vite folds `import(…).then(fn)` into its preload, and a failed tip (no USDC) inside it
// counts as a chunk that didn't load, which reloads the page (app.tsx reloadOnce)
const wm = () => import('./walletmove.tsx')

// module-level hooks the shell fills in, so any component can toast or open the composer
export const shell = {
  toast: (_: string) => {},
  // text, embeds and onDone come from mini apps; onDone gets the new cast's hash, or null if nothing was posted
  compose: (_: { parent?: Cast; quote?: Cast; channel?: string; text?: string; embeds?: string[]; onDone?: (hash: string | null) => void; scheduled?: boolean } = {}) => {},
  // opens the image viewer (Viewer)
  view: (urls: string[], index: number) => openViewer(urls, index),
  // a Markdown link's (`label`) or look-alike link's real address, asked about before it opens (LinkSheet);
  // `open` opens it some other way than a new tab (a mini app)
  link: (_url: string, _o: { label?: boolean; open?: () => void } = {}) => false,
  // the account indicator in page headers (app.tsx), for phones
  me: (): ComponentChildren => null,
  // the open mini apps (miniapp.tsx keeps these current and fires 'dock'); the dock shows them next to the pinned ones
  dock: { apps: [] as { id: number; url: string; name: string; icon?: string; asleep?: boolean }[], shown: null as number | null, show: (_id: number) => {} },
  // opens the theme editor (themes.tsx) on a theme, or on the one being worn
  editTheme: (_?: Theme | null) => {},
  // opens the Report sheet (ReportSheet) for a person, or one of their casts
  report: (_u: User, _c?: Cast) => {},
  // set by a mini app window's search button (Quorum mode): /apps focuses its directory search, then clears it
  findApp: false,
}
// errors thrown with English text (ours and the server's) are translated here too
export const toast = (m: string) => shell.toast(t(m))
/** Listens for window `events` while mounted; `deps` as for useEffect (the first render's `f` is kept until they change). */
export function useOn(events: string | string[], f: () => void, deps: unknown[] = []) {
  const l = [events].flat()
  useEffect(() => (l.forEach((e) => addEventListener(e, f)), () => l.forEach((e) => removeEventListener(e, f))), deps)
}
/** Draws the component again on any of these window events. */
export const useRerenderOn = (...events: string[]) => {
  const [, force] = useState(0)
  useOn(events, () => force((x) => x + 1))
}
/** Copies `text` (a promise, as Safari only lets a click write the clipboard at once) and toasts `done`, `fail` or its error. */
export const copyText = (text: Promise<string>, done: string, fail?: string) => {
  const write = typeof ClipboardItem !== 'undefined'
    ? navigator.clipboard.write([new ClipboardItem({ 'text/plain': text.then((s) => new Blob([s], { type: 'text/plain' })) })])
    : text.then((s) => navigator.clipboard.writeText(s))
  write.then(() => toast(done), () => text.then(() => (fail ? toast(fail) : toast("Couldn't copy it.")), (e) => toast(e.message)))
}
/** A segmented control: one button per [value, label] (labels come translated), the one equal to `on` lit. */
export const Seg = <V,>({ opts, on, set, disabled }: { opts: [V, string][]; on: V; set: (v: V) => void; disabled?: boolean }) => <div class="seg">{opts.map(([v, label]) => <button type="button" class={on === v ? 'on' : ''} disabled={disabled} onClick={() => set(v)}>{label}</button>)}</div>
/** A wallet address as 0x1234…abcd. */
export const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
export const requireAccount = () => (account?.done ? true : (go('/join'), false))
/** Ask the browser to show notifications. It has to run straight from a click: Firefox drops the prompt
 *  if anything (a lazy import) is awaited first. */
export const askPush = () => ('Notification' in window ? Notification.requestPermission().catch(() => 'denied' as const) : Promise.resolve('denied' as const))
/** Whether this browser already has a push subscription for Quilcast. */
export const pushOn = async () => !!(await (await navigator.serviceWorker?.getRegistration('/sw.js'))?.pushManager.getSubscription())
export const APP_PUSH = 'quilcast:apppush'
/** Whether mini apps' notifications are pushed here (Mini apps → Push notifications on this device). The subscription
 *  alone doesn't say: accounts' own notifications (src/alerts.ts) use it too. Before that flag, a subscription was this. */
export const appPushOn = async () => (await pushOn()) && (read<boolean | null>(APP_PUSH, null) ?? !Object.keys(read<{ on?: object } | null>(ALERTS, null)?.on || {}).length)
/** This browser's push subscription for Quilcast, made on first use; mini apps' notifications and the account's own
 *  (src/alerts.ts) share it. The permission is asked first (see askPush). */
export async function pushSubscription() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error("This browser can't show notifications.")
  if (Notification.permission !== 'granted' && (await askPush()) !== 'granted') throw new Error('Notifications are blocked for Quilcast in this browser. Allow them in the site settings (the icon left of the address).')
  const reg = await navigator.serviceWorker.register('/sw.js')
  await navigator.serviceWorker.ready
  const had = await reg.pushManager.getSubscription()
  if (had) return had
  const { key } = await (await fetch('/api/notify/vapid')).json()
  // a browser without a reachable push service never answers, so this gives up instead of spinning forever
  const timeout = new Promise<never>((_, no) => setTimeout(() => no(new Error("This browser's push service didn't answer. Try again in a minute.")), 20000))
  const raw = Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
  return Promise.race([reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: raw }), timeout])
}
/** Open a mini app (src/miniapp.tsx, loaded on first use). */
export const launchApp = (m: AppMeta, ctx?: { cast?: Cast; embed?: string; share?: boolean; draft?: Drafting }) => requireAccount() && import('./miniapp.tsx').then((x) => x.launch(m, ctx))
/** Cast actions (/actions, public/developers/cast-actions.html): mini apps with a castShareUrl, listed in every cast's
 *  ⋯ menu. `url` is the castShareUrl. A one-click action (`post`, added by its app with addCastAction in miniapp.tsx)
 *  instead gets a signed POST at `url`, after one line of text when it has a `placeholder`, and its answer is a toast. */
export type CastAction = AppMeta & { description?: string; post?: boolean; placeholder?: string }
export const castActions = () => read<CastAction[]>('quilcast:actions', [])
export const saveActions = (l: CastAction[]) => save('quilcast:actions', l.slice(0, 30))
/** Composer actions (/composer-actions, public/developers/composer-actions.html): mini apps with a composerActionUrl,
 *  listed under the composer's apps button. `url` is the composerActionUrl. */
export const composerActions = () => read<CastAction[]>('quilcast:composer-actions', [])
export const saveComposerActions = (l: CastAction[]) => save('quilcast:composer-actions', l.slice(0, 30))
/** The post a composer action was opened from (compose.tsx): `draft` is what the app's context.location shows, and `fill`
 *  puts what its composeCast sends into that post. The composer closes the app when it goes (miniapp.tsx dropDraft). */
export type Drafting = { draft: () => { text: string; embeds: string[]; parent?: { type: 'cast'; hash: string }; quote?: { type: 'cast'; hash: string }; channelKey?: string }; fill: (o: { text?: unknown; embeds?: unknown }) => void; open: (on: boolean) => void }
/** An installed mini app's cast action (its manifest's castShareUrl) joins the ⋯ menu with it, unless the menu has one
 *  from that origin already. quilcast:app-actions keeps, per origin, 0 once its action was offered (so one taken off
 *  the menu at /actions stays off), or when its manifest last had none (looked at again a day later). */
export function addAppAction(origin: string, m: { castShareUrl?: string; name?: string; iconUrl?: string; description?: string } | null, app: AppMeta) {
  save('quilcast:app-actions', { ...appActions(), [origin]: m?.castShareUrl ? 0 : Date.now() })
  if (!m?.castShareUrl || castActions().some((a) => !a.post && safeOrigin(a.url) === origin)) return
  saveActions([...castActions(), { url: m.castShareUrl, name: m.name || app.name, icon: m.iconUrl || app.icon, description: m.description }])
}
const appActions = () => read<Record<string, number>>('quilcast:app-actions', {})
/** Removing an installed app takes its cast action off the ⋯ menu too. */
export const dropAppAction = (origin: string) => saveActions(castActions().filter((a) => safeOrigin(a.url) !== origin))
const safeOrigin = (u: string) => {
  try {
    return new URL(u).origin
  } catch {
    return ''
  }
}
/** Installed apps whose manifests have (or since got) a castShareUrl: their actions join the ⋯ menu (addAppAction). */
export async function syncAppActions() {
  const seen = appActions()
  const apps = read<AppMeta[]>('quilcast:apps', [])
  for (const o of new Set(apps.map((a) => safeOrigin(a.url)))) {
    if (!o.startsWith('https://') || (Object.hasOwn(seen, o) && (seen[o] === 0 || seen[o] > Date.now() - 86400e3))) continue
    // a failure is tried again next time
    const r = await fetch(`/api/manifest?origin=${encodeURIComponent(o)}`).catch(() => null)
    if (!r?.ok) continue
    addAppAction(o, await r.json().catch(() => null), apps.find((a) => safeOrigin(a.url) === o)!)
  }
}
/** Run an action on a cast: its castShareUrl with the share extension's query, and location cast_share in its context;
 *  a one-click one is a signed POST (miniapp.tsx runOneClick), with what was typed when it asks for text. */
export function runAction(a: CastAction, c: Cast, input?: string) {
  if (a.post) return requireAccount() && import('./miniapp.tsx').then((x) => x.runOneClick(a, c, input))
  const u = new URL(a.url)
  u.searchParams.set('castHash', '0x' + c.hash.replace(/^0x/, ''))
  u.searchParams.set('castFid', String(c.author.fid))
  if (account?.fid) u.searchParams.set('viewerFid', String(account.fid))
  launchApp({ ...a, url: u.href }, { cast: c, share: true })
}
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

export const WalletIcon = ({ w }: { w?: { icon: string } }) => (w?.icon ? <img class="wallet-icon" src={proxied(w.icon)} alt="" /> : <Icon d={P.wallet} size={16} />)
/** A list to choose a wallet from: the mini app connect prompts and "Use a wallet" both show it. */
export function Choose<W extends { name: string; icon: string }>({ list, value, set }: { list: W[]; value?: W; set: (w: W) => void }) {
  // the mini app prompts don't re-render on a pick, so the pick is kept here too; `value` alone would stay stale
  const [picked, setPicked] = useState<W>()
  const cur = picked ?? value
  return (
    <div class="accounts">
      {list.map((w) => (
        <button class={`acct${w === cur ? ' on' : ''}`} aria-pressed={w === cur} onClick={() => (set(w), setPicked(w))}>
          <WalletIcon w={w} /><span><b>{w.name}</b></span>{w === cur && list.length > 1 && <Icon d={P.check} />}
        </button>
      ))}
    </div>
  )
}

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
export const channelOf = (u?: string | null) => (u && Object.hasOwn(legacy, u) ? legacy[u] : u?.match(/(?:warpcast\.com|farcaster\.xyz)\/~\/channel\/([^/?#]+)/)?.[1])
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
export const Img = ({ low, ...p }: { src?: string; class?: string; style?: string; srcset?: string; sizes?: string; low?: boolean; onError?: () => void }) => (
  <img alt="" loading="lazy" fetchpriority={low ? 'low' : undefined} referrerpolicy="no-referrer" onError={(e) => (e.currentTarget.style.display = 'none')} {...p} src={p.src && proxied(p.src).replace(/^http:\/\//i, 'https://')} />
)

/** A mini app's icon, or the first letter of its name when there's none or it won't load. */
export function AppIcon({ src, name }: { src?: string; name?: string }) {
  const [bad, setBad] = useState(false)
  return src && !bad ? <img class="app-icon" alt="" loading="lazy" referrerpolicy="no-referrer" src={proxied(src)} onError={() => setBad(true)} /> : <span class="app-icon">{[...(name || '?')][0]}</span>
}

/** A popup that closes on Escape (just it, not a composer or dialog it's in) and on any click outside it and its button: its parent (each caller's wrapper) holds just that
 *  button and the popup, and the button toggles it itself. Closing on a click on the button too would
 *  open it again: Preact draws the closed menu before the button's handler runs, which then sees it closed (#764). */
export function Menu({ close, class: cls, style, children }: { close: () => void; class?: string; style?: Record<string, string>; children: ComponentChildren }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // capturing, so clicks that other handlers stop still count
    const f = (e: Event) => !ref.current?.parentElement?.contains(e.target as Node) && close()
    addEventListener('click', f, true)
    return () => removeEventListener('click', f, true)
  }, [])
  return <div ref={ref} class={`menu ${cls || ''}`} style={style} role="menu" onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), close())}>{children}</div>
}

export const Avatar = ({ u, size = 40, link = true, onClick }: { u: User; size?: number; link?: boolean; onClick?: (e: MouseEvent) => void }) => {
  const style = { width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.42)}px` }
  const pfp = safeUrl(u.pfp_url)
  const inner = pfp ? <Img src={sized(pfp, 'anim=false,w=144')} /> : <span>{[...(u.display_name || u.username || '?')][0]}</span>
  return link ? <a class="avatar" href={userPath(u)} style={style} onClick={stop} aria-label={nameOf(u)}>{inner}</a> : <span class="avatar" style={style} onClick={onClick}>{inner}</span>
}

/** Text with Markdown (shared.ts markdown), or `plain`: only its links, mentions and channels made live. A cast's text
 *  passes `tags`, the tags Hypersnap indexed from its own text (taggable(c.text)): the text shown has its mentions put
 *  back in, or is a translation, and a tag that reads differently there would find nothing. */
export function RichText({ text, class: cls = 'text', plain, tags, article, emojis }: { text: string; class?: string; plain?: boolean; tags?: Set<string>; article?: boolean | 'preview'; emojis?: Map<string, string> }) {
  // dir=auto: an English cast reads left to right in the Arabic UI too, and the other way round. A link's click is
  // the link's, not the card's around it.
  // a Markdown picture opens in the image viewer, with the text's other pictures a swipe away, like a cast's embeds
  const click = (e: MouseEvent) => {
    const el = e.target as Element
    if (el.closest('a')) return stop(e)
    if (!el.classList.contains('md-img')) return
    stop(e)
    const pics = [...(e.currentTarget as Element).querySelectorAll<HTMLImageElement>('img.md-img')]
    shell.view(pics.map((p) => p.src), pics.indexOf(el as HTMLImageElement))
  }
  // a [label](url) link to another site, or any link to a look-alike host, first shows where it really goes. Asked
  // while the click comes down, before the link's own listeners (inapp.ts opens links out from there); a middle
  // click too.
  const ask = (e: MouseEvent) => {
    const a = (e.target as Element).closest('a')
    if (!a || (e.type === 'auxclick' && e.button !== 1)) return
    const label = a.classList.contains('md-link')
    if ((label || lookalike(a.href)) && a.host !== location.host && shell.link(a.href, { label })) e.preventDefault()
  }
  return <div class={cls} dir="auto" onClick={click} onClickCapture={ask} onAuxClickCapture={ask} dangerouslySetInnerHTML={{ __html: plain ? linkify(text, tags) : article ? articleHtml(text, tags, article === 'preview') : markdown(text, tags, emojis) }} />
}

// long text in feeds folds at 10 lines; the button shows only when something is cut
function Folded({ text, tags, emojis }: { text: string; tags?: Set<string>; emojis?: Map<string, string> }) {
  const ref = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [over, setOver] = useState(false)
  const measure = () => {
    const p = ref.current?.firstElementChild
    p && setOver(p.scrollHeight > p.clientHeight + 1)
  }
  useLayoutEffect(measure, [text])
  return (
    // and again as each Markdown picture arrives and takes its height
    <div ref={ref} onLoadCapture={measure}>
      <RichText text={text} class={open ? 'text' : 'text fold'} tags={tags} emojis={emojis} />
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
/** A language's name in the app's language (Spanish, Español…). */
export const langName = (code: string) => {
  try {
    return new Intl.DisplayNames([lang], { type: 'language' }).of(code) || code
  } catch {
    return code
  }
}

/** A cast's words, translated when it's in another language and the reader asked (or someone did before). */
function Said({ c, full }: { c: Cast; full?: boolean }) {
  const text = castText(c)
  // the languages the reader reads (Settings → Don't translate from, and the app's own) get no translation at all
  const reads = noTranslate(lang, settings.noTranslate)
  const from = useMemo(() => translatableFrom(text, reads), [text, [...reads].join()])
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
  // (the model can find it's in a language the reader reads after all)
  const shown = offersTranslation(from, tr?.from, reads)
  const words = tr && shown && !orig ? tr.text : castText(c, true)
  const tags = taggable(c.text || '')
  const emojis = emojisOf(c)
  const fromName = langName(tr && tr.from !== 'und' ? tr.from : from || 'und')
  return (
    <>
      {full ? <RichText text={words} tags={tags} emojis={emojis} /> : <Folded text={words} tags={tags} emojis={emojis} />}
      {shown && (tr || on) && (
        <div class="tr-note" onClick={stop}>
          {tr && !orig ? <>{t('Auto-translated from {language}', { language: fromName })} · <button class="link-btn" onClick={() => setOrig(true)}>{t('View original')}</button></>
            : tr ? <button class="link-btn" onClick={() => setOrig(false)}>{t('View translation')}</button>
              : <button class="link-btn" disabled={busy} onClick={ask}>{busy ? t('Translating…') : t('Translate from {language}', { language: fromName })}</button>}
        </div>
      )}
    </>
  )
}

export { urlsOf }
/** A video in a quote or a notification that has no poster to show: a dark box with a play button. */
export const VidPeek = ({ small }: { small?: boolean }) => (
  <span class={`qvid${small ? ' small' : ''}`} role="img" aria-label={t('Play video')}><Icon d={P.play} fill size={small ? 16 : 28} /></span>
)

// HLS goes through hls.js (loaded on first play) wherever MediaSource exists. canPlayType can't decide it: Chrome
// answers "maybe" and plays nothing. iPhone Safari has no MediaSource and plays HLS natively
export function Video({ src }: { src: string }) {
  const ref = useRef<HTMLVideoElement>(null)
  const hls = src.includes('.m3u8') && typeof MediaSource !== 'undefined'
  const player = useRef<{ destroy(): void } | null>(null)
  useEffect(() => () => { player.current?.destroy(); player.current = null }, [src])
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
    setReady(true)
    // the full build: Farcaster's streams carry audio as a separate rendition, which hls.js/light drops
    const { default: Hls } = await import('hls.js')
    if (player.current || !ref.current) return
    const h = (player.current = new Hls())
    // play once the manifest is in; before that there's nothing to play
    h.on(Hls.Events.MANIFEST_PARSED, () => ref.current?.play().catch(() => {}))
    h.loadSource(src)
    h.attachMedia(ref.current)
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
/** A sticker (src/stickers.tsx) as it is, with no frame, opening its pack; served by whichever server this app is on. */
export const Sticker = ({ u }: { u: string }) => (
  <a class="sticker" href={`/stickers/${stickerPack(u)}`} onClick={stop} aria-label={t('Sticker')}><img src={new URL(u).pathname} alt="" /></a>
)

/** A picture that couldn't be shown, as a link to it: its host and file name. */
function ImgLink({ u }: { u: string }) {
  const click = (e: MouseEvent) => {
    e.stopPropagation()
    // a look-alike host first shows where it really goes
    if (lookalike(u) && shell.link(u)) e.preventDefault()
  }
  return (
    <a class="linkcard img-link" href={u} target="_blank" rel="noopener noreferrer nofollow" onClick={click}>
      <span class="lc-text">
        <span class="lc-site"><Icon d={P.image} size={14} />{new URL(u).hostname.replace(/^www\./, '')}</span>
        {pathOf(u) && <span class="lc-desc">{pathOf(u)}</span>}
      </span>
    </a>
  )
}

export function Media({ urls: given, images }: { urls: string[]; images?: boolean }) {
  const all = given.flatMap((u) => safeUrl(u) ?? [])
  const stickers = all.filter(stickerPack)
  const urls = all.filter((u) => !stickerPack(u))
  const imgs = images ? urls : urls.filter(isImg)
  // a picture that won't load (gone, or too big for /api/img) becomes a link to it instead of leaving nothing
  const [bad, setBad] = useState<string[]>([])
  const first = imgs.slice(0, 4)
  const shown = first.filter((u) => !bad.includes(u))
  // the "+N" goes on the last one still shown
  const last = first.length - 1 - [...first].reverse().findIndex((u) => !bad.includes(u))
  // a lone image keeps its own shape; when warm() learned its size, its box has that shape before it loads
  const box = boxOf(shown.length === 1 ? shapes.get(sized(shown[0], 'w=1200')) : null)
  return (
    <>
      {stickers.map((u) => <Sticker u={u} />)}
      {shown.length > 0 && (
        <div class={`imgs n${shown.length}`} onClick={stop}>
          {first.map((u, i) => !bad.includes(u) && (
            <button key={i} class="img" aria-label={t('Open image {n} of {total}', { n: i + 1, total: imgs.length })} onClick={() => shell.view(imgs, i)}>
              <Img src={our(sized(u, 'w=1200'))} style={box} onError={() => setBad((b) => (b.includes(u) ? b : [...b, u]))} {...((box || shown.length > 1) && srcsetOf(u) ? { srcset: our(srcsetOf(u)!), sizes: IMG_SIZES } : {})} />
              {i === last && imgs.length > 4 && <span class="more-imgs">+{imgs.length - 4}</span>}
            </button>
          ))}
        </div>
      )}
      {bad.filter((u) => imgs.includes(u)).map((u) => <ImgLink key={u} u={u} />)}
      {/* keyed: a Media handed another cast's videos (a tapped reply) starts each one fresh, its shape and player too */}
      {urls.filter(isVid).map((u) => <Video key={u} src={u} />)}
    </>
  )
}

// The open viewer has a history entry of its own (the page's address, its pictures in the entry's state), so Back (the
// browser's, Android's, an iOS edge swipe) pops that entry and closes the viewer, leaving the page under it where it
// was. ✕, Escape and the backdrop go back too, so closing leaves no entry behind; Forward opens it again. This listener
// is added as the app loads, before any page's, so a pop that only closes or reopens the viewer never reaches the
// router (app.tsx useRoute), which would scroll the page to the top.
type Viewing = { urls: string[]; index: number }
const VIEWING = 'quilcast:viewing'
const viewingIn = (s: unknown): Viewing | null => (s as Record<string, Viewing> | null)?.[VIEWING] ?? null
// the one on screen: a page reloaded on the viewer's entry opens it again
let viewing = viewingIn(history.state)
// the address under the open viewer while its entry is the current one, and the last one it was open on (Forward)
let under = viewing ? location.href : ''
let last = under
// closeViewer's Back is on its way: the viewer neither opens nor reopens until it lands
let closing = false
let unstick: ReturnType<typeof setTimeout> | undefined
const show = (v: Viewing | null) => ((viewing = v), dispatchEvent(new Event('lightbox')))
function openViewer(urls: string[], index: number) {
  if (viewing || closing) return
  under = last = location.href
  history.pushState({ [VIEWING]: { urls, index } }, '')
  show({ urls, index })
}
// gone at once; its entry is popped right after, and the listener lets that pop go
function closeViewer() {
  if (!viewing) return
  show(null)
  if (!viewingIn(history.state)) return void (under = '')
  closing = true
  history.back()
  // (in case that Back leaves this page, and Forward brings it back from the cache)
  clearTimeout(unstick)
  unstick = setTimeout(() => (closing = false), 1000)
}
addEventListener('popstate', (e) => {
  const v = viewingIn(history.state), was = closing
  // (not the app's own, which go() sends right away)
  if (e.isTrusted) (closing = false), clearTimeout(unstick)
  if (under && !v && location.href === under) {
    // its entry popped, by Back or closeViewer
    under = ''
    e.stopImmediatePropagation()
    if (viewing) show(null)
  } else if (v && !viewing && !was && location.href === last) {
    // onto its entry again by Forward, right after Back
    under = location.href
    e.stopImmediatePropagation()
    show(v)
  } else {
    // anywhere else, which the page routes to: the viewer goes, and an entry of its reached from elsewhere is a plain
    // page now
    if (v) history.replaceState(null, '')
    under = last = ''
    if (viewing) show(null)
  }
})

/** The image viewer, while one is open (shell.view). */
export function Viewer() {
  const [v, setV] = useState(viewing)
  const sync = () => setV(viewing)
  // one may have opened between the render and the listener
  useEffect(sync, [])
  useOn('lightbox', sync)
  return v && <Lightbox {...v} close={closeViewer} />
}

type Pt = { x: number; y: number }
const middle = (p: Pt[]) => ({ x: p.reduce((s, q) => s + q.x, 0) / p.length, y: p.reduce((s, q) => s + q.y, 0) / p.length })
const spread = (p: Pt[]) => (p.length > 1 ? Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) : 0)

/** Full-screen image viewer: arrows, keyboard and swipe move between images. A double tap (or click) zooms in on its
 *  spot and back out, two fingers pinch, and a zoomed picture pans under a finger or the mouse (zoom.ts). */
export function Lightbox({ urls, index, close }: { urls: string[]; index: number; close: () => void }) {
  const [i, setI] = useState(index)
  const [z, setZ] = useState(FIT)
  // kept current between renders, for the gesture's handlers
  const zoom = useRef(z)
  const zoomTo = (v: Zoom) => ((zoom.current = v), setZ(v))
  const many = urls.length > 1
  // each picture starts fitted
  const step = (d: number) => many && (setI((x) => (x + d + urls.length) % urls.length), zoomTo(FIT))
  const box = useRef<HTMLDivElement>(null)
  const pic = useRef<HTMLImageElement>(null)
  // the fingers (or the mouse) down on it now
  const pts = useRef(new Map<number, Pt>())
  // the gesture under way: where it began (a swipe's start); the zoom, and the fingers' middle and spread, when it, its
  // latest finger or a pan began; whether it has moved, and whether two fingers ever pinched in it
  const g = useRef<{ from: Pt; z: Zoom; at: Pt; d: number; moved: boolean; pinched: boolean } | null>(null)
  const [held, setHeld] = useState(false)
  // the click that ends a drag, a pinch or a double tap isn't a tap on the backdrop
  const noClick = useRef(false)
  const lastTap = useRef({ t: -1e9, x: 0, y: 0 })
  // keys are the viewer's while it's open, before the page's (Quorum's / would go to Search under it); added as it's
  // drawn, so Escape right after it opens closes it
  useLayoutEffect(() => {
    const key = (e: KeyboardEvent) => {
      e.stopPropagation()
      const k = e.key, v = zoom.current
      // (Ctrl/⌘ with + − 0 zoom the browser)
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (k === 'Escape') shut()
      else if (k === 'ArrowRight' || k === 'ArrowLeft') step(k === 'ArrowRight' ? 1 : -1)
      // + and − zoom about the middle, 0 fits it again
      else if (k === '+' || k === '=' || k === '-') zoomTo(fit(zoomAt(v, k === '-' ? v.z / 1.5 : v.z * 1.5, { x: 0, y: 0 })))
      else if (k === '0') zoomTo(FIT)
    }
    addEventListener('keydown', key, true)
    document.body.style.overflow = 'hidden'
    return () => (removeEventListener('keydown', key, true), (document.body.style.overflow = ''))
  }, [])
  // Forward, or a reload, opens it on the picture it was left on; once the pictures settle, as WebKit throws past 100
  // replaceStates in 10 s (a held arrow key)
  // (and at once when ✕, Escape or the backdrop close it first: shut)
  const kept = useRef({ shown: i, saved: index })
  kept.current.shown = i
  const keep = () => {
    const k = kept.current
    if (k.shown === k.saved) return
    try {
      if (viewingIn(history.state)) history.replaceState({ [VIEWING]: { urls, index: k.shown } }, ''), (k.saved = k.shown)
    } catch {}
  }
  useEffect(() => {
    const t = setTimeout(keep, 500)
    return () => clearTimeout(t)
  }, [i])
  const shut = () => (keep(), close())
  // a point from the screen's middle, where the fitted picture sits
  const rel = (p: Pt) => {
    const r = box.current!.getBoundingClientRect()
    return { x: p.x - r.left - r.width / 2, y: p.y - r.top - r.height / 2 }
  }
  const fit = (v: Zoom) => bound(v, pic.current!.offsetWidth, pic.current!.offsetHeight, box.current!.clientWidth, box.current!.clientHeight)
  const begin = () => {
    const p = [...pts.current.values()], s = g.current
    g.current = { from: s?.from ?? middle(p), z: zoom.current, at: middle(p), d: spread(p), moved: s?.moved ?? false, pinched: (s?.pinched ?? false) || p.length > 1 }
  }
  // `cancel`: the browser took the pointer, or a mouse button came up where the page didn't see it
  const up = (e: PointerEvent, cancel = e.type === 'pointercancel') => {
    const s = g.current
    if (!s || !pts.current.delete(e.pointerId)) return
    if (pts.current.size) return begin()
    g.current = null
    setHeld(false)
    if (cancel) return
    if (s.moved || s.pinched) {
      // a swipe at 1× moves between the pictures (a finger's: a mouse drag doesn't)
      const dx = e.clientX - s.from.x
      if (!s.pinched && s.z.z === 1 && e.pointerType !== 'mouse' && Math.abs(dx) > 50) step(dx < 0 ? 1 : -1)
      return
    }
    // a second tap soon after the first and near it zooms in on that spot of the picture, or anywhere back out
    const t = lastTap.current
    const twice = e.timeStamp - t.t < 300 && Math.hypot(e.clientX - t.x, e.clientY - t.y) < 30
    lastTap.current = twice ? { t: -1e9, x: 0, y: 0 } : { t: e.timeStamp, x: e.clientX, y: e.clientY }
    if (!twice) return
    if (zoom.current.z > 1) zoomTo(FIT), (noClick.current = true)
    else if (e.target === pic.current) zoomTo(fit(zoomAt(FIT, TAP_ZOOM, rel({ x: e.clientX, y: e.clientY })))), (noClick.current = true)
  }
  const src = safeUrl(urls[i])
  return (
    <div ref={box} class={`lightbox${held ? ' held' : ''}`} role="dialog" aria-modal="true" aria-label={t('Image viewer')}
      // a tap on the backdrop closes it, unless the picture is zoomed in
      onClick={() => !noClick.current && zoom.current.z === 1 && shut()}
      onPointerDown={(e) => {
        if ((e.target as Element).closest('button, a') || e.button) return
        // (a mouse's, left over from a button that came up outside the page)
        pts.current.delete(e.pointerId)
        if (!pts.current.size) (g.current = null), (noClick.current = false)
        pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
        begin()
        setHeld(true)
      }}
      onPointerMove={(e) => {
        const s = g.current
        if (!s || !pts.current.has(e.pointerId)) return
        if (e.pointerType === 'mouse' && !e.buttons) return up(e, true)
        pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
        const p = [...pts.current.values()], m = middle(p)
        if (!s.moved && (p.length > 1 || Math.hypot(m.x - s.at.x, m.y - s.at.y) > 10)) {
          s.moved = noClick.current = true
          // a pan starts from here, not with a jump of the 10 px it took to tell it from a tap
          if (p.length === 1) s.at = m
        }
        // two fingers scale it about the spot they began on, which follows their middle; one pans it once zoomed
        if (p.length > 1 && s.d) zoomTo(fit(zoomAt(s.z, (s.z.z * spread(p)) / s.d, rel(s.at), rel(m))))
        else if (p.length === 1 && s.z.z > 1 && s.moved) zoomTo(fit({ ...s.z, x: s.z.x + m.x - s.at.x, y: s.z.y + m.y - s.at.y }))
      }}
      onPointerUp={(e) => up(e)} onPointerCancel={(e) => up(e)}>
      {/* keyed: the next picture comes in fitted, not shrinking from the last one's zoom */}
      <img key={i} ref={pic} src={src && proxied(src)} alt="" referrerpolicy="no-referrer" draggable={false} onClick={stop}
        style={{ transform: `translate(${z.x}px, ${z.y}px) scale(${z.z})` }} />
      <button class="lb-btn lb-close" aria-label={t('Close')} onClick={shut}><Icon d={P.x} size={22} /></button>
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

type Tweet = { text: string; author: { name?: string; handle?: string; avatar?: string }; at?: number; photos: string[]; video?: string; likes?: number; replies?: number; reposts?: number; quote?: { name?: string; handle?: string; text?: string }; article?: { title: string; text?: string; cover?: string } }
type Unfurl = { url: string; title?: string; description?: string; image?: string; button?: string; icon?: string; tweet?: Tweet; app?: AppMeta; inline?: { url: string; height: number } } | null

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
      {t.text && <RichText text={t.text.replace(/\s*https:\/\/t\.co\/\S+$/, '')} class="text tw-text" plain />}
      {t.photos.length > 0 && <Media urls={t.photos} />}
      {!t.photos.length && video && <div class="tw-video"><Img src={video} low /><span class="play"><Icon d={P.play} fill size={24} /></span></div>}
      {t.article && (
        <div class="tw-article">
          {safeUrl(t.article.cover) && <Img class="lc-img" src={safeUrl(t.article.cover)} />}
          <div class="lc-text"><span class="lc-title">{t.article.title}</span>{t.article.text && <span class="lc-desc">{t.article.text}</span>}</div>
        </div>
      )}
      {t.quote && <div class="tw-quote"><b>{t.quote.name}</b> <span class="handle">@{t.quote.handle}</span><p>{t.quote.text}</p></div>}
      <div class="tw-stats"><span>{tn(t.replies || 0, '{n} reply', '{n} replies', { n: n(t.replies) })}</span><span>{tn(t.reposts || 0, '{n} repost', '{n} reposts', { n: n(t.reposts) })}</span><span>{tn(t.likes || 0, '{n} like', '{n} likes', { n: n(t.likes) })}</span></div>
    </div>
  )
}
// a preview is asked for again after an hour, as long as the server keeps one (server/unfurl.mjs): a page left open
// for days doesn't keep a stale one, such as a mini app's launch url that was wrong for a while
const unfurls = new Map<string, { at: number; p: Promise<Unfurl> }>()
const fresh = (u: string) => Date.now() - (unfurls.get(u)?.at ?? -Infinity) < 3600e3
// v=2: browsers kept previews for a day under the old address, so a mini app that moved kept opening the old one
export const unfurl = (u: string) => {
  const old = unfurls.get(u)
  if (old && fresh(u)) return old.p
  // not answered (offline, or a proxy's error page): the one it had stays, and a tap still launches it
  const p: Promise<Unfurl> = fetch(`/api/unfurl?v=2&url=${encodeURIComponent(u)}`).then((r) => r.json()).catch(() => null).then((d) => d || old?.p || null).then((d) => (got.set(`u:${u}`, d), d))
  unfurls.set(u, { at: Date.now(), p })
  return p
}

// image sizes the server read: a card drawn after warm() starts from them (and from `got`), at its final size
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
    if (k.startsWith('u:')) unfurls.set(k.slice(2), { at: Date.now(), p: Promise.resolve(v as Unfurl) })
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
      else if (!isImg(u) && !isVid(u) && !spaceOf(u) && !packLink(u) && !/^\/(design|theme)\//.test(path)) jobs.push(unfurl(u))
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
/** What the page wears when no draft is open: this browser's theme, else the holiday's if one is on and Settings allow it. */
export const dressed = () => theme ?? (settings.holidays === false ? null : holidayOn(new Date()) ?? null)
export let worn = dressed()
let vars: string[] = []
let face: { url: string; f?: FontFace } | undefined
/** Show `th` on the page (null: the plain app); `keep` also makes it this browser's theme (and, unless `synced` says it
 *  came from there, sends it to the account when Settings sync themes). */
export function wear(th: Theme | null, keep = false, synced = false) {
  if (keep) (theme = th), th ? save('quilcast:theme', th) : localStorage.removeItem('quilcast:theme')
  if (keep && !synced) themeChanged()
  // taking a theme off leaves the holiday's on
  if (keep && !th) th = dressed()
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
  worn = th
  dispatchEvent(new Event('theme'))
}

/** The theme, light or dark, or holiday themes changed here: stamp it, and send it up when Settings sync themes (prefs.ts). */
let sending = false
export function themeChanged() {
  save('quilcast:themeAt', Date.now())
  // a theme applied from the library changes both at once: one request
  if (!settings.syncThemes || !account?.done || sending) return
  sending = true
  queueMicrotask(() => ((sending = false), import('./prefs.ts').then((m) => m.push())))
}

/** Themes this browser has tried, newest first (Settings > Theme lists them); a shared one keeps its link id. */
export type { Saved }
export const library = () => cleanLibrary(read<Saved[]>('quilcast:themes', []))
/** Keep the library as `xs` (`synced`: it came from the account, so it doesn't go back up). */
export const keepLibrary = (xs: Saved[], synced = false) => (save('quilcast:themes', cleanLibrary(xs)), synced || themeChanged())
export const remember = (x: Saved) => keepLibrary([x, ...library()])

// a theme's stickers are placed on the screen, a bit smaller than a share of it on wide ones
export const screenUnit = (w: number) => `calc(min(1vw, 6px) * ${w})`

/** The worn theme's background, effect and stickers, behind and over the page. */
export function ThemeLayers({ stickers = true }: { stickers?: boolean }) {
  const [th, setTh] = useState(worn)
  const fx = useRef<HTMLCanvasElement>(null)
  useOn('theme', () => setTh(worn))
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
        <img class="lk-stk th-stk" src={proxied(s.src)} alt="" loading="lazy" referrerpolicy="no-referrer" style={{ left: `${s.x}%`, top: `${s.y}%`, width: screenUnit(s.w), rotate: s.r ? `${s.r}deg` : undefined }} />
      ))}
    </>
  )
}

/** A shared theme's or design's loader: each id is asked once, and one that's gone stays null (no TTL, unlike once()). */
export const sharedOf = <T,>(kind: 'theme' | 'design', clean: (j: unknown) => T) => {
  const m = new Map<string, Promise<T | null>>()
  return (id: string) => m.get(id) || (m.set(id, getJson(`/api/${kind}/${id}`).then((j) => j && clean(j))), m.get(id)!)
}
export const themeOf = sharedOf('theme', cleanTheme)

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
  useRerenderOn('theme')
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
/** A sticker pack's link: src/stickers.tsx draws it (loaded the first time one shows), with a box of its size till then. */
let packMod: typeof import('./stickers.tsx') | null = null
function PackCard({ id }: { id: string }) {
  const [m, setM] = useState(packMod)
  useEffect(() => void (!m && import('./stickers.tsx').then((x) => setM((packMod = x)), () => {})), [])
  return m ? <m.PackEmbed id={id} /> : <div class="stk-embed" aria-busy="true" />
}

/** A link's card: a sticker pack's own, or the page's preview. */
export const LinkCard = ({ u, c }: { u: string; c?: Cast }) => {
  const pack = packLink(u)
  return pack ? <PackCard key={pack} id={pack} /> : <PageCard key={u} u={u} c={c} />
}

function PageCard({ u: given, c }: { u: string; c?: Cast }) {
  const u = safeUrl(given)
  const path = ownPath(u)
  const design = /^\/design\//.test(path) ? designId(path) : undefined
  const themeLink = /^\/theme\//.test(path) ? themeId(path) : undefined
  const cast = castOf(path)
  // read by url on every render: the same card can be handed another link (the cast page reuses it after posting a reply)
  const d = u ? (got.get(`u:${u}`) as Unfurl | undefined) : undefined
  const [, loaded] = useState(0)
  const [bad, setBad] = useState<string>()
  // one drawn over an hour ago is asked for again, and redrawn when the answer comes
  useEffect(() => void (u && (!d || !fresh(u)) && !design && !themeLink && !cast && unfurl(u).then(() => loaded((x) => x + 1))), [u])
  if (!u) return null
  if (design) return <DesignCard id={design} by={c?.author} />
  if (themeLink) return <ThemeCard id={themeLink} by={c?.author} />
  if (cast) return <QuoteCard hash={cast} />
  if (d?.tweet) return <TweetCard u={u} t={d.tweet} />
  // an image that won't load drops the card's image column too
  const image = d?.image === bad ? undefined : safeUrl(d?.image)
  // a link straight to an image renders as the image
  if (image && d?.image === d?.url) return <Media urls={[image]} images />
  const icon = safeUrl(d?.icon)
  const app = c && d?.app
  const click = (e: MouseEvent) => {
    e.stopPropagation()
    // the preview as it is now: one drawn hours ago may launch an address the app has since corrected
    const launch = app && !e.metaKey && !e.ctrlKey && !e.shiftKey ? () => void unfurl(u).then((f) => void launchApp({ ...(f?.app || app), icon: safeUrl(f?.icon) || icon }, { cast: c, embed: u })) : undefined
    // a look-alike host first shows where it really goes, a mini app's too
    if (lookalike(u) && shell.link(u, { open: launch })) e.preventDefault()
    else if (launch) e.preventDefault(), launch()
  }
  // a middle click on a look-alike asks too
  const aux = (e: MouseEvent) => e.button === 1 && lookalike(u) && (e.stopPropagation(), shell.link(u)) && e.preventDefault()
  // a mini app's inline view (inline.ts) takes the picture's place, with the rest of the card under it
  // never one on this app's own origin: Quilcast itself in the card, signed in, is a page to trick a tap out of
  const inline = d?.app && d.inline && [safeUrl(d.inline.url)].find((x) => x && new URL(x).origin !== location.origin)
  const card = (
    // a mini app's or frame's embed image (the one with a button) is 3:2, so its card is too
    <a class={`linkcard${image && !inline ? ' big' : ''}${image && d?.button && !inline ? ' lc-app' : ''}`} href={u} target="_blank" rel="noopener noreferrer nofollow" onClick={click} onAuxClick={aux}>
      {image && !inline && <Img class="lc-img" src={sized(image, 'w=1200')} low onError={() => setBad(d?.image)} />}
      <span class="lc-text">
        <span class="lc-site">{icon && <Img src={icon} low />}{new URL(u).hostname.replace(/^www\./, '')}</span>
        {d?.title ? <b class="lc-title">{d.title}</b> : !d?.description && pathOf(u) && <span class="lc-desc">{pathOf(u)}</span>}
        {d?.description && <span class="lc-desc">{d.description}</span>}
      </span>
      {d?.button && <span class="lc-btn">{inline ? t('Open') : d.button}</span>}
    </a>
  )
  return inline ? <div class="lc-inline"><InlineApp u={u} src={inline} height={d!.inline!.height} app={{ ...d!.app!, icon: icon || d!.app!.icon }} c={c} image={image} />{card}</div> : card
}

// our own hosts' inline views load as they scroll in, like quilcast.com's own pictures; another host's only once
// tapped, as loading its page would tell it who is reading, which its picture (through /api/img) doesn't
const OWN_HOST = /^https:\/\/(?:[\w-]+\.)+quilcast\.com$/
/** A mini app embed's inline view (fc:miniapp:inline): its page in a frame `height` px tall, answered by inline.ts.
 *  In the composer (no `c`) it's a preview the composer's styles keep from being used. */
function InlineApp({ u, src, height, app, c, image }: { u: string; src: string; height: number; app: AppMeta; c?: Cast; image?: string }) {
  const { origin, host } = new URL(src)
  const [run, setRun] = useState(OWN_HOST.test(origin))
  const [mod, setMod] = useState<typeof import('./inline.ts')>()
  const [say, setSay] = useState<import('./inline.ts').Say>(null)
  const ref = useRef<HTMLIFrameElement>(null)
  useEffect(() => void (run && !mod && import('./inline.ts').then(setMod, () => {})), [run])
  // answering before the frame's page can ask anything: it loads only once the frame is in
  useLayoutEffect(() => (mod && ref.current ? mod.attach({ frame: ref.current, origin, host, name: app.name || host, cast: c, embed: u, app, say: setSay }) : undefined), [mod, src, c?.hash])
  return (
    <div class="lc-frame" style={{ height: `${height}px` }} onClick={stop}>
      {mod ? <iframe ref={ref} src={src} title={app.name || host} loading="lazy" referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox" />
        : !run && <>
          {image && <Img class="lc-img" src={sized(image, 'w=1200')} low />}
          <button class="btn small lc-run" onClick={() => setRun(true)}>{t('Load {host} here', { host })}</button>
        </>}
      {say && (
        <div class="lc-say" role="dialog" aria-label={say.title}>
          <b>{say.title}</b>
          {say.body && <span>{say.body}</span>}
          <span class="btns">
            <button class="btn ghost small" onClick={() => say.done?.(false)}>{t('Cancel')}</button>
            {/* it ignores clicks for its first second, as a whole app's does: the prompt comes up where the person was
                just tapping the view, and a second tap mustn't land on it */}
            {say.yes && <button class="btn small arm" onClick={() => Date.now() - (say.at || 0) > 1000 && say.done?.(true)}>{say.yes}</button>}
          </span>
        </div>
      )}
    </div>
  )
}

// our own links (quilcast.com, or wherever this copy runs) show natively: casts as quotes, designs as cards
const ownPath = (u?: string) => {
  const x = u && new URL(u)
  return x && (x.host === 'quilcast.com' || x.host === location.host) ? x.pathname : ''
}

export const designOf = sharedOf('design', cleanDesign)

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
        style={{ backgroundColor: lookPage(d), backgroundImage: d.bgImg ? `url("${proxied(d.bgImg)}")` : undefined, '--lk-dim': d.bgDim ? String(d.bgDim / 100) : undefined }} />
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
  // one this tab just sent is asked for with its author: asked by hash alone before it lands, the node remembers it
  // as missing for 10 minutes (Hypersnap's missing_casts), and so would we
  const fid = posting.get(hash)?.author.fid
  if (!castCache.has(hash)) castCache.set(hash, get('/v2/farcaster/cast', { identifier: hash, type: 'hash', fid, viewer_fid: account?.fid }).then((r) => r.cast, () => null).then((c) => (got.set(`c:${hash}`, c), c || (fid && castCache.delete(hash)), c)))
  return castCache.get(hash)!
}

/** A quote of a quote with no words of its own (#664): "Quoted a cast", by whom when we already have that cast or its
 *  author, and they're not someone this reader mutes or blocks, nor taken down (server/home.mjs says it the same way). */
export const quotedLine = (q: CastRef) => {
  const inner = got.get(`c:${q.hash}`) as Cast | null | undefined
  const by = inner?.author ?? (q.fid ? users.get(q.fid) : undefined)
  return by && !hides(inner ?? ({ hash: q.hash, text: '', author: by } as Cast)) ? t('Quoted a cast by @{name}', { name: handle(by) }) : t('Quoted a cast')
}

export function QuoteCard({ hash, c: given }: { hash?: string; c?: Cast }) {
  // like LinkCard, read by hash on every render so a reused card never keeps the cast it showed before
  const c = given ?? (hash ? (got.get(`c:${hash.replace(/^0x/, '').toLowerCase()}`) as Cast | null | undefined) : undefined)
  const [, loaded] = useState(0)
  // a quote that arrives with a muted word hides the cast quoting it too (hides): 'mutes' redraws the app, so it goes now
  useEffect(() => void (hash && c === undefined && fetchCast(hash).then((q) => (loaded((x) => x + 1), q && hides(q) && dispatchEvent(new Event('mutes'))))), [hash])
  if (c === null) return <div class="quote muted">{t('This cast is unavailable.')}</div>
  if (!c) return <div class="quote skeleton" />
  if (hides(c)) return <div class="quote muted">{t('Hidden by your mutes.')}</div>
  const { img, video, link, quote } = peekOf(urlsOf(c), quotedOf(c))
  const text = castText(c, true).trim()
  return (
    <a class="quote" href={`/c/${c.hash}`} onClick={stop}>
      <div class="meta"><Avatar u={c.author} size={18} link={false} /><b>{nameOf(c.author)}</b><span>@{handle(c.author)} · {ago(c.timestamp)}</span></div>
      {/* text gets a thumbnail beside it; a cast that is only media shows it at size, one that is only a link its address */}
      <div class={`qbody${text ? '' : ' bare'}`}>
        {text && <RichText text={text} class="text clamp" tags={taggable(c.text || '')} emojis={emojisOf(c)} />}
        {img && <Img class="qimg" src={sized(img, 'w=1200')} />}
        {video && <VidPeek />}
        {!text && link && <span class="qlink"><Icon d={P.link} size={14} /><span>{link}</span></span>}
        {!text && quote && <span class="qlink"><Icon d={P.quote} size={14} /><span>{quotedLine(quote)}</span></span>}
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


const REASONS = (): [string, string][] => [['spam', t('Spam')], ['abuse', t('Harassment or hate')], ['sexual', t('Sexual content')], ['violence', t('Violence or threats')], ['illegal', t('Something illegal')], ['other', t('Something else')]]

/** The ⋯ menu's Report: why, an optional note, and blocking them too. It goes to our server, which sends it to us
 *  (server/report.mjs), so reporting works without leaving the app or having email set up. */
/** "Open this link?": a Markdown link's text can say anything ([google.com](https://not-google.example)), so before
 *  one opens it shows the address it really goes to, its host first (as punycode, so look-alike letters show).
 *  Any link to a look-alike host (shared.ts lookalike) asks too, with a warning and the host as it reads in Unicode. */
export function LinkSheet() {
  const [q, setQ] = useState<{ u: URL; label?: boolean; open?: () => void } | null>(null)
  shell.link = (href, o = {}) => (setQ({ u: new URL(href), ...o }), true)
  useEffect(() => {
    if (!q) return
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setQ(null)
    addEventListener('keydown', key)
    return () => removeEventListener('keydown', key)
  }, [q])
  if (!q) return null
  const { u, label, open } = q
  const uni = lookalike(u.href)
  const close = () => setQ(null)
  return (
    <div class="modal" onClick={(e) => e.target === e.currentTarget && close()}>
      <div class="sheet wallet-form link-sheet" role="alertdialog" aria-modal="true" aria-labelledby="link-sheet-h">
        <h2 id="link-sheet-h">{t('Open this link?')}</h2>
        {uni && <p class="link-warn">{t('This address contains Unicode characters that can look like normal letters. It might be a phishing link.')}</p>}
        <p>{label ? t("A link's text can say anything. This one goes to:") : t('This link goes to:')}</p>
        <p class="link-dest"><b>{u.host}</b>{u.href.slice(u.origin.length) === '/' ? '' : u.href.slice(u.origin.length)}</p>
        {uni && <p>{t('With those characters, the address reads:')} <b class="link-uni" dir="ltr">{uni}</b></p>}
        <p class="muted">{t('Only open it if you trust this site.')}</p>
        <div class="link-actions">
          <button class="btn ghost" onClick={close}>{t('Cancel')}</button>
          <a class="btn" href={u.href} target="_blank" rel="noopener noreferrer nofollow" onClick={(e) => (open && (e.preventDefault(), open()), close())}>{t('Open link')}</a>
        </div>
      </div>
    </div>
  )
}

/** An ask sheet's keys: Escape cancels; Tab goes round its buttons and never into the page under it. */
const askKeys = (close: (ok: boolean) => void) => (e: KeyboardEvent) => {
  if (e.key === 'Escape') return e.stopPropagation(), close(false)
  if (e.key !== 'Tab') return
  e.preventDefault()
  const b = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
  b[(b.indexOf(document.activeElement as HTMLButtonElement) + (e.shiftKey ? b.length - 1 : 1)) % b.length]?.focus()
}

/** How trains work, the first time someone joins one or switches on the composer's train toggle (trainask.ts):
 *  Continue goes on, Cancel (or Escape, or a tap outside) posts nothing. */
export function TrainSheet() {
  const [q, setQ] = useState<{ kind: 'join' | 'start'; from: Element | null } | null>(null)
  // the open ask's answer; a second ask while it's open answers the first with Cancel
  const done = useRef<((ok: boolean) => void) | undefined>(undefined)
  const button = useRef<HTMLButtonElement>(null)
  trainSheet.ask = (kind) => new Promise((d) => (done.current?.(false), (done.current = d), setQ({ kind, from: document.activeElement })))
  // it takes the focus, so Escape and Enter reach it and not the composer under it
  useEffect(() => void (q && button.current?.focus()), [q])
  if (!q) return null
  const close = (ok: boolean) => {
    const d = done.current
    done.current = undefined
    setQ(null)
    ;(q.from as HTMLElement | null)?.focus?.()
    d?.(ok)
  }
  const join = q.kind === 'join'
  return (
    <div class="modal" onClick={(e) => e.target === e.currentTarget && close(false)} onKeyDown={askKeys(close)}>
      <div class="sheet wallet-form link-sheet" role="alertdialog" aria-modal="true" aria-labelledby="train-sheet-h" tabIndex={-1}>
        <h2 id="train-sheet-h">{join ? t('Join the train?') : t('Start a train?')}</h2>
        <p>{join ? t('Joining posts a quote of this cast, with the same text, from your account right away.') : t('Your cast gets a train button. Anyone who taps it posts a quote of your cast, with the same text, from their own account right away.')}</p>
        <p>{t('Every quote in the train carries the train button too, so anyone can join the same way.')}</p>
        <p class="muted">{t('Quotes in the train are casts like any other, so you can delete yours.')}</p>
        <div class="link-actions">
          <button class="btn ghost" onClick={() => close(false)}>{t('Cancel')}</button>
          <button class="btn" ref={button} onClick={() => close(true)}>{t('Continue')}</button>
        </div>
      </div>
    </div>
  )
}

/** What holding Like does, the first time someone holds it long enough (tipask.ts): Tip sends the $1, Cancel (or Escape,
 *  or a tap outside) sends nothing. Its switch is Settings → Wallets' one, saved as it's flipped; off, Tip can't go. */
export function TipSheet() {
  const [q, setQ] = useState<{ from: string; to: string; el: Element | null } | null>(null)
  const [on, setOn] = useState(true)
  const done = useRef<((ok: boolean) => void) | undefined>(undefined)
  // it's money, so the focus starts on Cancel and Enter alone never tips
  const cancel = useRef<HTMLButtonElement>(null)
  // it opens under a finger still on Like; a pointer's click on Tip counts only after a press that began inside it
  const armed = useRef(false)
  tipSheet.ask = (o) => new Promise((d) => (done.current?.(false), (done.current = d), (armed.current = false), setOn(holdTip()), setQ({ ...o, el: document.activeElement })))
  useEffect(() => void (q && cancel.current?.focus()), [q])
  if (!q) return null
  const close = (ok: boolean) => {
    const d = done.current
    done.current = undefined
    setQ(null)
    ;(q.el as HTMLElement | null)?.focus?.()
    d?.(ok)
  }
  return (
    <div class="modal" onClick={(e) => e.target === e.currentTarget && close(false)} onKeyDown={askKeys(close)} onPointerDown={() => (armed.current = true)}>
      <div class="sheet wallet-form link-sheet" role="alertdialog" aria-modal="true" aria-labelledby="tip-sheet-h" tabIndex={-1}>
        <h2 id="tip-sheet-h">{t('Tip @{name} $1?', { name: q.to })}</h2>
        <p>{t("Holding Like on someone's cast tips its author $1: 1 USDC on Base from {wallet}, straight to their wallet. Sendclap keeps 1%, and gas costs a little ETH on Base.", { wallet: q.from })}</p>
        <div class="setting"><b>{t('Hold Like to tip')}</b><Seg opts={[[true, t('On')], [false, t('Off')]]} on={on} set={(v) => (setHoldTip(v), setOn(v))} /></div>
        <p class="muted">{t('A tap still just likes. You can change this any time in Settings → Wallets.')}</p>
        <div class="link-actions">
          <button class="btn ghost" ref={cancel} onClick={() => close(false)}>{t('Cancel')}</button>
          <button class="btn" disabled={!on} onClick={(e) => (!e.detail || armed.current) && close(true)}>{t('Tip $1')}</button>
        </div>
      </div>
    </div>
  )
}

export function ReportSheet() {
  const [q, setQ] = useState<{ u: User; c?: Cast } | null>(null)
  const [reason, setReason] = useState('')
  const [text, setText] = useState('')
  const [block, setBlock] = useState(false)
  const [busy, setBusy] = useState(false)
  shell.report = (u, c) => (setReason(''), setText(''), setBlock(false), setQ({ u, c }))
  if (!q) return null
  const close = () => (setQ(null), setBusy(false))
  const send = async (e: Event) => {
    e.preventDefault()
    setBusy(true)
    try {
      await (await w()).sendReport({ fid: q.u.fid, hash: q.c?.hash, reason, text })
      if (block && account?.done) await setMute('blocks', q.u.fid, undefined)
      toast(block ? t('Report sent, and @{name} is blocked. We look at every report within 24 hours.', { name: handle(q.u) }) : t('Report sent. We look at every report within 24 hours.'))
      close()
    } catch (err: any) {
      toast(err.message)
      setBusy(false)
    }
  }
  return (
    <div class="modal" onClick={(e) => e.target === e.currentTarget && close()}>
      <form class="sheet wallet-form report-form" onSubmit={send}>
        <div class="move-top"><h2>{q.c ? t('Report this cast') : t('Report @{name}', { name: handle(q.u) })}</h2></div>
        <p class="hint">{t("What's wrong with it?")}</p>
        <div class="reasons" role="radiogroup">
          {REASONS().map(([k, label]) => <label class="check"><input type="radio" name="reason" checked={reason === k} onChange={() => setReason(k)} /> {label}</label>)}
        </div>
        <textarea rows={3} maxLength={1000} value={text} onInput={(e) => setText(e.currentTarget.value)} placeholder={t('Anything we should know? (optional)')} aria-label={t('Details')} />
        {account?.done && !blockOf(q.u.fid) && <label class="check"><input type="checkbox" checked={block} onChange={(e) => setBlock(e.currentTarget.checked)} /> {t('Also block @{name}', { name: handle(q.u) })}</label>}
        <p class="hint">{t('We look at every report within 24 hours and take down what breaks the Terms of Use for everyone on Quilcast.')}</p>
        <div class="sheet-btns"><button type="button" class="btn ghost" onClick={close}>{t('Cancel')}</button><button class="btn danger" disabled={!reason || busy}>{busy ? t('Sending…') : t('Send report')}</button></div>
      </form>
    </div>
  )
}

/** A one-click action's line of text, asked inside the ⋯ menu: Enter or the button runs it, Escape gives up. */
function ActionPrompt({ a, done }: { a: CastAction; done: (input?: string) => void }) {
  const [v, setV] = useState('')
  const send = () => v.trim() && done(v.trim().slice(0, 256))
  return (
    <form class="menu-prompt" onSubmit={(e) => (e.preventDefault(), send())}>
      <div class="menu-label muted">{a.name}</div>
      <input autoFocus value={v} onInput={(e) => setV(e.currentTarget.value)} onKeyDown={(e) => e.key === 'Escape' && done()} placeholder={a.placeholder} aria-label={a.name || ''} enterKeyHint="go" maxLength={256} />
      <button type="submit" class="btn small" disabled={!v.trim()}>{t('Send')}</button>
    </form>
  )
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
  // without an account they're kept in this browser (mutes.ts)
  const ask = (k: 'users' | 'blocks', on: unknown) => (on ? set(k, false) : setKind(k))
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
  // on a cast or an account spam.quilcast.com labelled: one tap tells us the label is wrong (server/report.mjs)
  const labelled = (c && spamOf(c) != null) || spamAccountOf(u.fid) != null
  const notSpam = () => (done(), w().then((x) => x.sendReport({ fid: u.fid, hash: c?.hash, reason: 'not_spam', text: '' })).then(() => toast(t("Thanks! We'll check that label.")), (e) => toast(e.message)))
  return (
    <>
      {labelled && <button role="menuitem" onClick={notSpam}><Icon d={P.check} />{t('Not spam')}</button>}
      <button role="menuitem" onClick={() => ask('users', m)}><Icon d={P.mute} />{m ? t('Unmute @{name}', { name: handle(u) }) : t('Mute @{name}', { name: handle(u) })}</button>
      <button role="menuitem" class="danger" onClick={() => ask('blocks', b)}><Icon d={P.block} />{b ? t('Unblock @{name}', { name: handle(u) }) : t('Block @{name}', { name: handle(u) })}</button>
      <button role="menuitem" class="danger" onClick={() => (done(), shell.report(u, c))}><Icon d={P.flag} />{c ? t('Report this cast') : t('Report @{name}', { name: handle(u) })}</button>
    </>
  )
}

// Quilcast Collect: the cast as a free 1/1 NFT on Base, or who owns it (backmeupplz/quilcast-collect)
// The gem's burst (style.css .act.cl.go), from the start on every press; taken off by time, since with reduced motion
// there's no animation to end.
export const sparkle = (b: HTMLElement) => {
  b.classList.remove('go')
  void b.offsetWidth
  b.classList.add('go')
  setTimeout(() => b.classList.remove('go'), 600)
}
// how long Like is held to tip; the swoosh (swoosh.ts) starts SOUND ms in, so a plain tap stays silent
const HOLD = 2000, SOUND = 250
const COLLECT = (hash: string): AppMeta => ({ url: `https://collect.quilcast.com/c/${hash}`, name: 'Quilcast Collect', icon: 'https://collect.quilcast.com/icon.png', splash: 'https://collect.quilcast.com/splash.png', bg: '#0d0c11' })

/** A cast row. `focus` is the thread's main cast; `line` draws the thread connector down to the next row; `owner` is
 *  the profile it's shown on (see hides()). */
// --- Farcaster Articles (article.ts) ---
/** `c` as an article's first cast or a later part, once known (api.ts articleOf), else null. */
export function useArticle(c: Cast) {
  const [a, setA] = useState(() => articleNow(c))
  useEffect(() => {
    let live = true
    const now = articleNow(c)
    setA(now)
    if (now === undefined) articleOf(c).then((p) => live && setA(p))
    return () => void (live = false)
  }, [c.hash])
  return a || null
}
/** A part's text and embeds as the article shows them: text in article Markdown, embeds where [$N] puts them or after
 *  the text, and links alone on a line as previews. `skip`: embeds shown elsewhere (the cover). */
function ArticleBlocks({ c, text, raw, embeds, skip, format = ARTICLE }: { c: Cast; text: string; raw: string; embeds: Embed[]; skip?: number[]; format?: number }) {
  // the tags Hypersnap indexed are each part's own (taggable of its text as the node has it)
  const tags = taggable(raw)
  // a part in another format (the FIP only says parts SHOULD be article Markdown) reads as plain text, as any cast in a
  // format we don't know
  if (format !== ARTICLE) return <><RichText text={text} tags={tags} plain /><Embeds c={{ ...c, text: '', embeds }} /></>
  return (
    <>
      {segments(text, embeds, skip).map((s, i) => ('text' in s ? <RichText key={i} text={s.text} class="text article-text" tags={tags} article /> : <Embeds key={i} c={{ ...c, text: '', embeds: s.embeds }} />))}
    </>
  )
}
/** An article in a feed: its cover, title and opening, a tap away from the whole of it. */
function ArticleCard({ c }: { c: Cast }) {
  const { title, opening: all } = headOf(castText(c, true))
  const cover = coverOf(c.embeds)
  const opening = cardOpening(all, c.embeds)
  return (
    <div class="fc-article">
      {cover && <Img class="fa-cover" src={sized(cover, 'w=1200')} srcset={srcsetOf(cover)} sizes={IMG_SIZES} />}
      <div class="fa-text">
        <b class="fa-title" dir="auto">{title}</b>
        {opening && <RichText text={opening} class="text article-text fa-open" tags={taggable(c.text || '')} article="preview" />}
        <span class="fa-more">{t('Read article')}</span>
      </div>
    </div>
  )
}
/** A whole article on its cast's page: the cover, the title, the opening and every part after it, read from the node.
 *  `onParts` hears the parts' hashes, so the page can leave them out of the replies. */
export function ArticleView({ c, root, onParts, given }: { c: Cast; root: Part; onParts?: (hashes: string[]) => void; given?: ArticleRead }) {
  const [got, setA] = useState<ArticleRead | null>(null)
  const [failed, setFailed] = useState(false)
  // `given`: the article as it's being written (articles.tsx's preview); an article of one cast is all here
  const one = root.chain?.count === 1
  const a = given || got || (one ? { parts: [root], complete: true, texts: [] } : null)
  useEffect(() => {
    let live = true
    setA(null)
    setFailed(false)
    if (!given && !one) readArticle(root).then((x) => live && (setA(x), onParts?.(x.parts.flatMap((p) => p?.hash || []))), () => live && setFailed(true))
    return () => void (live = false)
  }, [root.hash, !given])
  const { title, opening } = headOf(castText(c, true))
  const cover = coverOf(c.embeds)
  return (
    <div class="fc-article full">
      {cover && <Img class="fa-cover" src={sized(cover, 'w=1200')} srcset={srcsetOf(cover)} sizes={IMG_SIZES} />}
      <h1 class="fa-title" dir="auto">{title}</h1>
      <ArticleBlocks c={c} text={opening} raw={c.text || ''} embeds={c.embeds} skip={cover ? [0] : []} />
      {a ? a.parts.slice(1).map((p, i) => (p ? <ArticleBlocks key={p.hash} c={c} text={a.texts[i + 1]!} raw={p.text} embeds={p.embeds} format={p.format} /> : <div key={i} class="note">{t('A part of this article is missing.')}</div>))
        : failed ? <div class="note">{t("The rest of this article couldn't be loaded.")}</div> : <div class="spinner" />}
    </div>
  )
}
/** A later part of an article, on its own: its text, and the way to the whole article. */
function ArticlePart({ c, part, full }: { c: Cast; part: Part; full?: boolean }) {
  const link = <a class="fa-more" href={`/c/${part.chain!.root!.hash}`} onClick={stop}>{t('Part {n} of an article', { n: part.chain!.index + 1 })} · {t('Read article')}</a>
  return full ? (
    <div class="fc-article full">
      {link}
      <ArticleBlocks c={c} text={castText(c, true)} raw={c.text || ''} embeds={c.embeds} format={part.format} />
    </div>
  ) : <div class="fc-article part">{link}</div>
}

export function CastCard({ c, focus, line, inThread, quotes = 0, owner, onTop, onArticle }: { c: Cast; focus?: boolean; line?: boolean; inThread?: boolean; quotes?: number; owner?: number; onTop?: boolean; onArticle?: (hashes: string[]) => void }) {
  const art = useArticle(c)
  // `mine` is what the node said at sign-in, and its counts include those; taps since then adjust from there
  const was = useMemo(() => [c.viewer_context?.liked ?? mine.likes.has(c.hash), c.viewer_context?.recasted ?? mine.recasts.has(c.hash)], [c.hash, mineVersion])
  const [, redraw] = useState(0)
  const [liked, likes] = tapped(1, c.hash, was[0], c.reactions.likes_count)
  const [recast, recasts] = tapped(2, c.hash, was[1], c.reactions.recasts_count)
  const [menu, setMenu] = useState(false)
  const [more, setMore] = useState(false)
  const [asking, setAsking] = useState<CastAction | null>(null)
  const [sure, setSure] = useState(false)
  const [gone, setGone] = useState(false)
  const toggle = (type: 1 | 2, on: boolean, count: number) => {
    if (!requireAccount()) return
    const k = type + c.hash, before = taps.get(k)
    taps.set(k, { on, count })
    redraw((x) => x + 1)
    w().then((m) => m.react(type, on, c)).catch((e) => (before ? taps.set(k, before) : taps.delete(k), redraw((x) => x + 1), toast(e.message)))
  }
  // holding Like for HOLD ms tips the author $1 (walletmove.tsx tip) and likes the cast, unless Settings turned that off
  // (tipask.ts); the first time, TipSheet explains it and nothing goes out unless they tap Tip. `charge` draws it
  // (style.css .act.lk.hold/.tip) as state, since Preact rewrites the button's class when `liked` flips
  const [charge, setCharge] = useState<'' | ' hold' | ' tip'>('')
  const timer = useRef(0), fired = useRef(false), down = useRef(false), sound = useRef<ReturnType<typeof swoosh> | undefined>(undefined)
  const press = (e: PointerEvent) => {
    fired.current = false
    if (e.button || !account?.done || account.fid === c.author.fid || !holdTip()) return
    setCharge(' hold')
    // whether the pointer is still down anywhere (the sheet may have opened over the button)
    down.current = true
    const up = () => ((down.current = false), removeEventListener('pointerup', up), removeEventListener('pointercancel', up))
    addEventListener('pointerup', up)
    addEventListener('pointercancel', up)
    timer.current = window.setTimeout(() => {
      sound.current = swoosh(HOLD - SOUND)
      timer.current = window.setTimeout(fire, HOLD - SOUND)
    }, SOUND)
    const fire = () => {
      // the release after a hold is never a tap, whatever the sheet says
      fired.current = true
      const s = sound.current
      sound.current = undefined
      const name = c.author.username || String(c.author.fid)
      const send = () => {
        setCharge(' tip')
        navigator.vibrate?.(30)
        if (!liked) toggle(1, true, c.reactions.likes_count)
        wm().then((m) => m.tip(c.author)).then(() => shell.toast(t('Tipped @{name} $1', { name })), (e) => toast(e.message))
      }
      if (tipTold() && holdTip()) return s?.done(), send()
      s?.stop()
      setCharge('')
      // asked only when a tip could go out (an address to tip, a wallet to pay from); else it likes, as a told hold would,
      // and toasts what's missing. Once answered with the pointer up, the hold is over: Enter on the refocused button is a
      // tap again; while it's still down, its release's click is the hold's and clears `fired` itself
      const over = () => void (down.current || (fired.current = false))
      wm().then((m) => tipOk({ from: m.tipFrom(c.author), to: name })).then((ok) => (over(), ok && send()), (e) => {
        over()
        if (!liked) toggle(1, true, c.reactions.likes_count)
        toast(e.message)
      })
    }
  }
  // let go (or scrolled away) early: just a tap
  const release = () => (clearTimeout(timer.current), sound.current?.stop(), (sound.current = undefined), charge === ' hold' && setCharge(''))
  // a train cast's button quotes it at once with its own text (write.ts trainCar); one car per tap until it went out.
  // The tap blows the whistle and sends a train across the screen (choochoo.ts) right away, not waiting on the cast.
  // The first time in this browser, TrainSheet explains first that the car goes out from your account (trainask.ts).
  const [boarding, setBoarding] = useState(false)
  const board = async () => {
    if (!requireAccount()) return
    if (!trainTold() && !(await trainOk('join'))) return
    choochoo()
    runTrain(t('Choo choo!'))
    navigator.vibrate?.([40, 60, 40])
    setBoarding(true)
    w().then((m) => m.trainCar(c)).then(() => toast('Joined the train'), (e) => toast(e.message)).finally(() => setBoarding(false))
  }
  const share = () => {
    const url = `${location.origin}/c/${c.hash}`
    navigator.share ? navigator.share({ url }).catch(() => {}) : navigator.clipboard.writeText(url).then(() => toast('Link copied'))
  }
  // the delete button asks once more in the same spot
  const own = !!account?.done && account.fid === c.author.fid
  // the signed-in FID on your own casts, else 0
  const me = (own && account?.fid) || 0
  const del = () => {
    if (!sure) return setSure(true)
    setMore(false)
    const hash = pinKey(c.hash), a = account!
    w().then((m) => m.deleteCast(c.hash).then(() => {
      setGone(true)
      toast('Deleted')
      // a deleted pinned cast would only be skipped on the profile; it's unpinned too, quietly
      if (me && pinnedCast(me) === hash) m.savePin(null, a).then(() => setPinnedCast(me, null), () => {})
    })).catch((e) => toast(e.message))
  }
  // the profile's pinned cast (castpin.ts), for the ⋯ menu's Pin or Unpin on your own top-level casts
  const pin = usePinnedCast(me)
  const isPin = pin === pinKey(c.hash)
  const pinIt = () => {
    setMore(false)
    const a = account!
    w().then((m) => m.savePin(isPin ? null : pinKey(c.hash), a)).then((h) => (setPinnedCast(me, h), h ? toast('Pinned to your profile') : toast('Unpinned from your profile')), (e) => toast(e.message))
  }
  // a cast opened on its own page shows whatever mutes say
  if (gone || (!focus && hides(c, owner))) return null
  const sending = posting.get(c.hash) === c
  const ch = channelOf(c.parent_url)
  const parentUser = c.parent_author?.fid ? users.get(c.parent_author.fid) : undefined
  const like = <button class={`act lk${liked ? ' on' : ''}${charge}`} aria-label={t('Like')} title={account?.done && account.fid !== c.author.fid && holdTip() ? t('Like (hold to tip $1)') : t('Like')} onPointerDown={press} onPointerUp={release} onPointerLeave={release} onPointerCancel={release} onContextMenu={(e) => e.preventDefault()} onClick={() => (fired.current ? (fired.current = false) : toggle(1, !liked, c.reactions.likes_count))}><Icon d={P.like} fill={liked} /><span>{likes ? n(likes) : ''}</span></button>
  const actions = (
    <footer onClick={stop}>
      {/* Quorum mode's order is Like, Reply, Recast */}
      {settings.quorum && like}
      <button class="act" aria-label={t('Reply')} onClick={() => requireAccount() && shell.compose({ parent: c })}><Icon d={P.reply} /><span>{c.replies.count ? n(c.replies.count) : ''}</span></button>
      <span class="wrap-menu">
        <button class={`act rc${recast ? ' on' : ''}`} aria-label={t('Recast or quote')} aria-haspopup="menu" onClick={() => setMenu(!menu)}><Icon d={P.recast} /><span>{recasts ? n(recasts) : ''}</span></button>
        {menu && (
          <Menu close={() => setMenu(false)}>
            <button role="menuitem" onClick={() => (setMenu(false), toggle(2, !recast, c.reactions.recasts_count))}><Icon d={P.recast} />{recast ? t('Undo recast') : t('Recast')}</button>
            <button role="menuitem" onClick={() => (setMenu(false), requireAccount() && shell.compose({ quote: c }))}><Icon d={P.quote} />{t('Quote')}</button>
          </Menu>
        )}
      </span>
      {!settings.quorum && like}
      {isTrain(c) && <button class="act" aria-label={t('Join the train')} title={t('Join the train')} disabled={boarding} onClick={board}><Icon d={P.train} /></button>}
      <button class="act cl" aria-label={t('Collect')} title={t('Collect')} onClick={(e) => (sparkle(e.currentTarget), launchApp(COLLECT(c.hash)))}><Icon d={P.collect} /></button>
      <button class="act" aria-label={t('Share')} onClick={share}><Icon d={P.share} /></button>
      <span class="wrap-menu">
        <button class="act" aria-label={t('More')} aria-haspopup="menu" onClick={() => (setMore(!more), setSure(false), setAsking(null))}><Icon d={P.more} /></button>
        {more && (
          <Menu class="right" close={() => setMore(false)}>
            {/* a one-click action that asks for a line of text asks right here */}
            {asking ? <ActionPrompt a={asking} done={(input) => (setMore(false), input != null && runAction(asking, c, input))} /> : <>{own
              ? <>
                  {!sending && (!c.parent_hash || isPin) && <button role="menuitem" onClick={pinIt} disabled={pin === undefined}><Icon d={P.pin} />{isPin ? t('Unpin from profile') : t('Pin to profile')}</button>}
                  <button role="menuitem" class="danger" onClick={del}><Icon d={P.trash} />{sure ? t('Delete this cast?') : t('Delete')}</button>
                </>
              : <SilenceItems u={c.author} c={c} done={() => setMore(false)} />}
            {castActions().map((a) => <button role="menuitem" onClick={() => (a.post && a.placeholder ? setAsking(a) : (setMore(false), runAction(a, c)))}><AppIcon src={a.icon} name={a.name} />{a.name}</button>)}
            <button role="menuitem" onClick={() => (setMore(false), go('/actions'))}><Icon d={P.plus} />{t('Cast actions…')}</button>
            </>}
          </Menu>
        )}
      </span>
    </footer>
  )
  const spam = spamOf(c), spamAccount = spam == null ? spamAccountOf(c.author.fid) : null
  const name = (
    <>
      <a class="name" href={userPath(c.author)} onClick={stop}>{nameOf(c.author)}</a>
      <span class="handle">@{handle(c.author)}</span>
      {spam != null && <span class="spam-tag" title={t('How likely spam.quilcast.com thinks this cast is spam')}>{t('Spam {n}%', { n: spam })}</span>}
      {spamAccount != null && <span class="spam-tag" title={t('How likely spam.quilcast.com thinks this is a spam account')}>{t('Spam account {n}%', { n: spamAccount })}</span>}
    </>
  )
  if (focus) {
    const stats = ([['recasts', recasts, tn(recasts, 'recast', 'recasts')], ['quotes', quotes, tn(quotes, 'quote', 'quotes')], ['likes', likes, tn(likes, 'like', 'likes')]] as const).filter(([, x]) => x > 0)
    return (
      <article class="cast focus">
        <header><Avatar u={c.author} size={44} /><div class="who">{name}</div>{ch && <a class="chan" href={`/channel/${ch}`} onClick={stop}>/{ch}</a>}</header>
        {isArticle(art) ? <ArticleView c={c} root={art} onParts={onArticle} /> : art ? <ArticlePart c={c} part={art} full /> : <><Said c={c} full /><Embeds c={c} /></>}
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
        {onTop && <div class="replying"><Icon d={P.pin} size={14} /> {t('Pinned')}</div>}
        {c.recaster && <div class="replying"><Icon d={P.recast} size={14} /> {t('Recast by')} <a href={userPath(c.recaster)} onClick={stop}>{nameOf(c.recaster)}</a></div>}
        <header>
          {name}
          <span class="dot">·</span>
          {sending ? <span class="posting">{t('Posting…')}</span> : <time dateTime={c.timestamp} title={new Date(c.timestamp).toLocaleString(lang)}>{ago(c.timestamp)}</time>}
          {ch && <a class="chan" href={`/channel/${ch}`} onClick={stop}>/{ch}</a>}
        </header>
        {c.parent_hash && !inThread && <div class="replying">{parentUser ? <>{t('Replying to')} <a href={userPath(parentUser)} onClick={stop}>@{handle(parentUser)}</a></> : t('Replying to a cast')}</div>}
        {isArticle(art) ? <ArticleCard c={c} /> : art ? <ArticlePart c={c} part={art} /> : <><Said c={c} /><Embeds c={c} /></>}
        {actions}
      </div>
    </article>
  )
}

const rowInner = (u: User) => (
  <>
    <Avatar u={u} link={false} />
    <span class="row-main">
      <span class="row-top"><b>{nameOf(u)}</b><span class="handle">@{handle(u)}</span></span>
      {u.profile?.bio?.text && <span class="row-sub">{u.profile.bio.text}</span>}
    </span>
    <span class="row-meta">{n(u.follower_count)}<small>{tn(u.follower_count || 0, 'follower', 'followers')}</small></span>
  </>
)
/** `action`: a button at the row's end (Follow on this device, in anonymous mode), beside the link rather than in it */
export const UserRow = ({ u, action, href = userPath(u) }: { u: User; action?: ComponentChildren; href?: string }) =>
  action ? (
    <div class="row has-action"><a class="row-link" href={href}>{rowInner(u)}</a>{action}</div>
  ) : (
    <a class="row" href={href}>{rowInner(u)}</a>
  )
