import { render, type ComponentChildren } from 'preact'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import { crashed, started } from './crash.ts'
import { account, accounts, amFollowing, isMe, askUser, byName, findUsers, follow, followsMe, forget, forgetFollows, get, urlOf, getUser, once, go, hydrateParents, idOf, isFollowing, loadMine, loadUsers, myUser, posting, read, removeAccount, save, saveSettings, setAccount, settings, switchAccount, updateAccount, users, USER_DATA, type Account, type Cast, type User } from './api.ts'
import { Composer } from './compose.tsx'
import { kv, vaultOpened } from './keys.ts'
import { OGRE_FID, ogreTap } from './ogre.ts'
import { castText, hasTag, n, newOnTop, oncePerFeed, shownFor, sized, type Look, type Theme } from './shared.ts'
import { ago, AppIcon, Avatar, cards, sparkle, isPinned, pinned, sameApp, togglePin, CastCard, DesignCard, designOf, dressed, theme, ThemeCard, ThemeLayers, themeChanged, wear, worn, fetchCast, warm, seed, handle, Header, Icon, Img, launchApp, launchUrl, LinkSheet, loadListed, type Listed, Logo, Menu, nameOf, P, ReportSheet, requireAccount, RichText, shell, SilenceItems, spans, Tabs, toast, thumbOf, untilText, urlsOf, UserRow, userPath, Viewer, w, askPush, appPushOn } from './ui.tsx'
import removedList from './removed.json' with { type: 'json' }
import type { AppMeta } from './miniapp.tsx'
import { lang, LANGS, loadLang, t, tn } from './i18n.ts'
import { blockOf, hides, muteOf, mutes, setMute, silenced, syncMutes } from './mutes.ts'
import { checkAccounts, spamAccountOf, spamAt } from './spam.ts'
import { alertsOn, canPush, KINDS, refreshAlerts, setAlerts, setKinds, spamChanged, type Kind } from './alerts.ts'
import { listSkip, pinKey, usePinnedCast } from './castpin.ts'
import { MOST, searchCasts } from './castsearch.ts'
import { findChannels, getChannel, type Channel } from './channels.ts'
import { LightDark, QuorumAside, QuorumCompose, setWalletOpen, useWalletOpen } from './quorum.tsx'
import './style.css'
import { keepCampaign } from './campaign.ts'
import { addLocal, answered, exportLocal, IMPORT_MAX, localFollows, localSources, merger, ofAccount, parseImport, pool, removeLocal, room, setLocal, stillFollowed, toOffer, within, type Local } from './local.ts'
import { asOf, browsePath, recentsOf, remember, repliesFit } from './browse.ts'
import { allSpots, entry, holding, keepSpot, keepState, navigated, placeKept, showing, spotOf, start, stateOf, takeList } from './restore.ts'

// views most visits never open load when first needed
const lazy = <P extends object>(load: () => Promise<(p: P) => any>) => (p: P) => {
  const [C, setC] = useState<((p: any) => any) | null>(null)
  useEffect(() => void load().then((c) => setC(() => c)), [])
  return C ? <C {...p} /> : <div class="spinner" />
}
const Join = lazy<{ step?: string }>(() => import('./join.tsx').then((m) => m.Join))
const Messages = lazy<{ id?: string }>(() => import('./messages.tsx').then((m) => m.Messages))
const Spaces = lazy<{}>(() => import('./spaces.tsx').then((m) => m.Spaces))
const WalletPage = lazy<{}>(() => import('./walletui.tsx').then((m) => m.WalletPage))
const WalletSettings = lazy<{}>(() => import('./walletui.tsx').then((m) => m.WalletSettings))
const WalletPanel = lazy<{ close: () => void }>(() => import('./walletui.tsx').then((m) => m.WalletPanel))
const SpaceRoom = lazy<{ id: string }>(() => import('./spaces.tsx').then((m) => m.SpaceRoom))
const ArticleEditor = lazy<{}>(() => import('./articles.tsx').then((m) => m.ArticleEditor))
const ThemeSettings = lazy<{}>(() => import('./themes.tsx').then((m) => m.ThemeSettings))
const ThemeEditor = lazy<{ start: Theme | null; close: () => void }>(() => import('./themes.tsx').then((m) => m.Editor))

// --- bits ---

function Toast() {
  const [m, setM] = useState('')
  const t = useRef(0)
  shell.toast = (x) => (setM(x), clearTimeout(t.current), (t.current = window.setTimeout(() => setM(''), 3500)))
  return m ? <div class="toast" role="status">{m}</div> : null
}

/** The recovery phrase of an account this browser doesn't keep it for, asked when the account itself has to sign
 *  (write.ts custody). It's checked against the account's custody address, used for that one action and dropped,
 *  unless "keep it here" is ticked. */
function PhraseAsk() {
  const [q, setQ] = useState<{ a: Account; done: (p: string | null) => void } | null>(null)
  const [text, setText] = useState('')
  const [keep, setKeep] = useState(false)
  const [err, setErr] = useState('')
  askUser.phrase = (a, k = false) => new Promise((done) => (setText(''), setErr(''), setKeep(k), setQ({ a, done })))
  if (!q) return null
  const close = (p: string | null) => (setQ(null), setText(''), q.done(p))
  const check = async (e: Event) => {
    e.preventDefault()
    const { address, custodyKey } = await import('./fc.ts')
    const p = text.trim().toLowerCase().split(/\s+/).join(' ')
    if (address(await custodyKey(p, false)) !== q.a.custody) return setErr(t("That's not this account's recovery phrase."))
    if (keep) await updateAccount({ ...(accounts.find((x) => idOf(x) === idOf(q.a)) || q.a), phrase: p })
    close(p)
  }
  return (
    <div class="modal" onClick={(e) => e.target === e.currentTarget && close(null)}>
      <form class="sheet wallet-form" onSubmit={check}>
        <div class="move-top"><h2>{t('Enter your recovery phrase')}</h2></div>
        <p class="hint">{t("@{name}'s recovery phrase isn't kept in this browser. Enter it to sign this; Quilcast uses it once and doesn't keep it.", { name: q.a.username || String(q.a.fid) })}</p>
        <textarea rows={3} value={text} onInput={(e) => (setText(e.currentTarget.value), setErr(''))} placeholder={t('apple banana cherry …')} aria-label={t('Recovery phrase')} autocapitalize="none" autocomplete="off" spellcheck={false} data-gramm="false" data-lt-active="false" />
        {err && <p class="hint warn">{err}</p>}
        <label class="check"><input type="checkbox" checked={keep} onChange={(e) => setKeep(e.currentTarget.checked)} /> {t('Keep it in this browser')}</label>
        <div class="sheet-btns"><button type="button" class="btn ghost" onClick={() => close(null)}>{t('Cancel')}</button><button class="btn" disabled={!text.trim()}>{t('Continue')}</button></div>
      </form>
    </div>
  )
}

// whether an address connected through WalletConnect: wallet.ts keeps which wallet each one used (spelled out here, since
// wallet.ts only loads for a connect), under the key vault.ts may not have moved it from yet
const viaWalletConnect = (address: string) => ['quilcast:connectedWith', 'quilcast:wallets'].some((k) => read<any>(k, {})?.[address.toLowerCase()] === 'walletconnect')

/** The QR code that pairs a WalletConnect account's wallet again, asked when its session ended and the account has to
 *  sign (wallet.ts), or from Settings. wallet.ts repair() checks the wallet came back with the account's address; the
 *  action then goes on by itself. Everything asked for while it's open waits for the same pairing. */
function PairAsk() {
  const [address, setAddress] = useState('')
  const [code, setCode] = useState<{ uri: string; img: string }>()
  const [err, setErr] = useState('')
  const waiting = useRef<{ done: () => void; fail: (e: unknown) => void }[]>([])
  // each attempt's number; a cancelled or replaced one finishing late changes nothing
  const run = useRef(0)
  const settle = (e?: unknown) => {
    const l = waiting.current
    waiting.current = []
    run.current++
    setAddress('')
    setCode(undefined)
    setErr('')
    l.forEach((x) => (e ? x.fail(e) : x.done()))
  }
  const start = async (a: string) => {
    const me = ++run.current
    setErr('')
    setCode(undefined)
    // a chunk that didn't load is a failure like any other, with Try again
    const w = await import('./wallet.ts').catch((e) => void (me === run.current && setErr(e?.message || 'The wallet refused.')))
    w?.repair(a, async (uri) => {
      const img = uri && (await w.qr(uri))
      if (me === run.current) setCode(uri ? { uri, img } : undefined)
    }).then(() => me === run.current && settle(), (e) => me === run.current && setErr(e?.message || 'The wallet refused.'))
  }
  askUser.pair = (a) =>
    new Promise((done, fail) => {
      waiting.current.push({ done, fail })
      if (waiting.current.length === 1) {
        setAddress(a)
        start(a)
      }
    })
  if (!address) return null
  const cancel = () => settle(Object.assign(new Error('You declined.'), { code: 4001 }))
  return (
    <div class="modal" onClick={(e) => e.target === e.currentTarget && cancel()}>
      <div class="sheet wallet-form pair" role="dialog" aria-label={t('Reconnect your wallet')}>
        <div class="move-top"><h2>{t('Reconnect your wallet')}</h2></div>
        <p class="hint">{t('Your WalletConnect connection to {address} has to be renewed. Scan this with the wallet on your phone, or open it in a wallet app on this device.', { address: `${address.slice(0, 6)}…${address.slice(-4)}` })}</p>
        {code ? <img src={code.img} alt={t('WalletConnect QR code')} /> : !err && <div class="spinner" />}
        {err && <p class="hint warn">{t(err)}</p>}
        <div class="sheet-btns">
          <button type="button" class="btn ghost" onClick={cancel}>{t('Cancel')}</button>
          {err ? <button class="btn" onClick={() => start(address)}>{t('Try again')}</button> : code && <a class="btn" href={code.uri}>{t('Open in a wallet app')}</a>}
        </div>
      </div>
    </div>
  )
}

// the iOS and Android apps put their own version in the user agent
const app = navigator.userAgent.match(/QuilcastApp\/(\S+) \((\w+)\)/)
const PLAY = 'https://play.google.com/store/apps/details?id=com.borodutch.quilcast'
// Google's own badge (public/google-play.png); not shown inside our apps
const android = !app && /Android/.test(navigator.userAgent)
const PlayBadge = () => <a class="play-badge" href={PLAY} target="_blank" rel="noopener"><img src="/google-play.png" alt="Get it on Google Play" width={646} height={250} /></a>
/** On an Android browser, signed in: the app on Google Play, at the top of Home until it's closed. */
function PlayBanner() {
  const [hidden, setHidden] = useState(() => read('quilcast:play-hidden', false))
  if (!android || hidden) return null
  return (
    <div class="play-card">
      <img class="play-icon" src="/icon.png" alt="" width={56} height={56} />
      <div class="play-text"><b>{t('Quilcast for Android')}</b><span>{t('Free on Google Play')}</span></div>
      <PlayBadge />
      <button class="icon-btn play-x" aria-label={t('Close')} onClick={() => (save('quilcast:play-hidden', true), setHidden(true))}><Icon d={P.x} size={16} /></button>
    </div>
  )
}
const Version = () => <>v{__VERSION__} · <a href="https://github.com/backmeupplz/quilcast" target="_blank" rel="noopener">{t('Source')}</a>{!app && <> · <a href={PLAY} target="_blank" rel="noopener">{t('Android app')}</a></>}</>
const feedback = `mailto:support@borodutch.com?subject=${encodeURIComponent('Quilcast feedback')}&body=${encodeURIComponent(`\n\nQuilcast v${__VERSION__}${app ? `, ${app[2]} app ${app[1]}` : ''}`)}`

/** A translated sentence with one {key} placeholder filled by an element, so translators can move it. */
const With = ({ s, k, children }: { s: string; k: string; children: ComponentChildren }) => {
  const [a, b] = s.split(`{${k}}`)
  return <>{a}{children}{b}</>
}

// every saved account with a way to switch, plus "Add account"
function AccountList({ onDone }: { onDone?: () => void }) {
  const [, force] = useState(0)
  useEffect(() => void loadUsers(accounts.map((a) => a.fid)).then(() => force((x) => x + 1)), [])
  return (
    <div class="accounts">
      {accounts.map((a) => {
        const u = (a.fid && users.get(a.fid)) || { fid: a.fid || 0, username: a.username }
        const on = !!account && idOf(a) === idOf(account)
        return (
          <button class={`acct${on ? ' on' : ''}`} onClick={() => (on ? onDone?.() : switchAccount(a))}>
            <Avatar u={u} size={32} link={false} />
            <span><b>{u.display_name || a.display || (a.username ? `@${a.username}` : t('New account'))}</b><small>{a.done ? `@${handle(u)}` : t('Setting up')}</small></span>
            {on && <Icon d={P.check} />}
          </button>
        )
      })}
      <button class="acct add" onClick={() => (onDone?.(), go('/join'))}><span class="plus"><Icon d={P.plus} /></span><span><b>{t('Add account')}</b></span></button>
    </div>
  )
}

/** On phones, the account you're using sits in every page's header; tapping it switches. */
function HeaderMe({ me }: { me: User }) {
  const [open, setOpen] = useState(false)
  return (
    <span class="wrap-menu only-mobile header-me">
      <button class="icon-btn" aria-haspopup="menu" aria-expanded={open} aria-label={t('Using @{name}. Switch account', { name: handle(me) })} onClick={() => setOpen(!open)}>
        <Avatar u={me} size={28} link={false} />
      </button>
      {open && <Menu class="right" close={() => setOpen(false)}><AccountList onDone={() => setOpen(false)} /></Menu>}
    </span>
  )
}

// Quorum mode's user card also leads to your profile, which has no place in its sidebar
function AccountMenu({ me, quorum }: { me: User; quorum?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <div class="me-wrap">
      {open && (
        <Menu class="up" close={() => setOpen(false)}>
          {quorum && <a class="acct" href={userPath(me)} onClick={() => setOpen(false)}><Icon d={P.user} /><span><b>{t('Profile')}</b></span></a>}
          <AccountList onDone={() => setOpen(false)} />
        </Menu>
      )}
      <button class="me" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Avatar u={me} size={34} link={false} />
        <span><b>{nameOf(me)}</b><small>@{handle(me)}</small></span>
        <Icon d={quorum ? 'M6 9l6 6 6-6' : P.more} />
      </button>
    </div>
  )
}

// --- paginated list of casts ---

type Page = { casts: Cast[]; next?: { cursor?: string | null } }
type Chunk<T> = { items: T[]; cursor: string | null }
/** What a feed found above its list (#640): `items` go on top, or take the list's place with `cursor` after them when
 *  it's set; `news` are the ones the pill counts (not the viewer's own, nor the hidden ones). */
type News<T> = { items: T[]; news: T[]; cursor?: string | null }
// how often a feed on screen looks for new posts, while the page is visible
const EVERY = 60e3
// at the top of the page, and not on its way back to a spot (scrollBack): new posts go straight on top there
const atTop = () => scrollY < 4 && !pending

/** Cursor pagination with infinite scroll. `id` dedupes items across pages. `fresh`: loads again on Back too.
 *  `restored`: told of a list Back brought back for `k`, or one new posts went on top of (`added`: those), before its
 *  next page loads.
 *  `poll`: asked every minute what's new above the list (#640), which `pill` offers while the page is scrolled down
 *  and which goes straight on top at the top of the page. */
function Pager<T>({ load, k, empty, id, row, initial, fresh, restored, poll, pill }: { load: (cursor?: string) => Promise<Chunk<T>>; k: string; empty?: string; id: (t: T) => string; row: (items: T[]) => ComponentChildren; initial?: () => T[]; fresh?: boolean; restored?: (k: string, items: T[], added?: T[]) => void; poll?: (have: T[]) => Promise<News<T> | null>; pill?: (news: T[], show: () => void) => ComponentChildren }) {
  // Back or Forward onto this page shows the pages loaded before, and goes on from there (restore.ts)
  const [kept] = useState(() => (fresh ? null : takeList<T>(k)))
  const [items, setItems] = useState<T[]>(() => kept?.items || initial?.() || [])
  const [cursor, setCursor] = useState<string | null | undefined>(kept?.cursor)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const sentinel = useRef<HTMLDivElement>(null)
  // `run` is new each time `k` changes, so a load from an earlier run is dropped and leaves the spinner alone, even when
  // `k` has come back to the same key meanwhile (a search typed, changed and typed again)
  const state = useRef({ busy: false, run: {}, mounted: false })
  // the list loaded for `k` so far, which Back finds on this entry when it's left (restore.ts)
  const got = useRef<{ k: string; items: T[]; cursor: string | null } | null>(kept && { k, ...kept })
  // new posts found above the list, held until they're shown: by a tap on the pill, or by the page being at the top
  const held = useRef<(News<T> & { k: string }) | null>(null)
  const [, redraw] = useState(0)
  const asks = useRef(poll)
  asks.current = poll
  const show = (to: boolean) => {
    const h = held.current
    held.current = null
    redraw((x) => x + 1)
    if (!h || h.k !== k || got.current?.k !== k) return
    const whole = h.cursor !== undefined
    const ids = new Set(h.items.map(id))
    const next = whole ? h.items : [...h.items, ...got.current.items.filter((x) => !ids.has(id(x)))]
    if (whole) {
      // a page still loading for the list before is dropped
      state.current.run = {}
      state.current.busy = false
      setBusy(false)
      setCursor(h.cursor)
    }
    got.current = { k, items: next, cursor: whole ? h.cursor ?? null : got.current.cursor }
    // what went on top joins what the list showed; a page that takes the list's place starts it over
    restored?.(k, next, whole ? undefined : h.items)
    up.current = to
    setItems(next)
  }
  // a tap on the pill goes up once the new posts are in the page, so that keeping the reader's place as they go in
  // (scroll anchoring) doesn't stop it half way
  const up = useRef(false)
  useLayoutEffect(() => {
    if (!up.current) return
    up.current = false
    scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }, [items])
  const more = async (reset = false) => {
    if ((state.current.busy && !reset) || (!reset && cursor === null)) return
    const run = state.current.run
    state.current.busy = true
    setBusy(true)
    setErr('')
    try {
      const r = await load(reset ? undefined : cursor || undefined)
      if (state.current.run !== run) return
      setItems((prev) => {
        const seen = new Set(reset ? [] : prev.map(id))
        const next = [...(reset ? [] : prev), ...r.items.filter((t) => !seen.has(id(t)))]
        got.current = { k, items: next, cursor: r.cursor }
        return next
      })
      setCursor(r.cursor)
    } catch (e: any) {
      if (state.current.run === run) setErr(e.message)
    } finally {
      if (state.current.run === run) {
        state.current.busy = false
        setBusy(false)
      }
    }
  }
  useEffect(() => showing(k, () => (got.current?.k === k ? got.current : null)), [k])
  useEffect(() => {
    state.current.run = {}
    // (the kept list is taken once, when this list first draws, or here when `k` changes under it)
    const l = !state.current.mounted ? kept : fresh ? null : takeList<T>(k)
    state.current.mounted = true
    if (l) {
      got.current = { k, ...l }
      restored?.(k, l.items)
      setItems(l.items)
      setCursor(l.cursor)
      state.current.busy = false
      setBusy(false)
      setErr('')
      return
    }
    // a cached first page shows instantly and is replaced when the fresh one arrives
    setItems(initial?.() || [])
    setCursor(undefined)
    more(true)
  }, [k])
  useEffect(() => {
    if (!asks.current) return
    held.current = null
    let on = true
    let asking = false
    let last = Date.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    const hidden = () => document.visibilityState === 'hidden'
    const wait = (ms: number) => (clearTimeout(timer), (timer = setTimeout(tick, ms)))
    // not while the page is hidden: coming back asks at once if a minute has gone by
    const tick = async () => {
      if (!on || asking || hidden()) return
      asking = true
      last = Date.now()
      const run = state.current.run
      // only once the list's first page is in, and not while another page loads
      const list = got.current?.k === k && !state.current.busy ? got.current.items : null
      const h = held.current?.k === k ? held.current : null
      try {
        const r = list && (await asks.current?.([...(h?.items || []), ...list]))
        if (on && r?.items.length && state.current.run === run && got.current?.k === k) {
          held.current = r.cursor !== undefined || !h ? { k, ...r } : { k, items: [...r.items, ...h.items], news: [...r.news, ...h.news], cursor: h.cursor }
          atTop() ? show(false) : redraw((x) => x + 1)
        }
      } catch {}
      asking = false
      if (on && !hidden()) wait(EVERY)
    }
    const seen = () => (hidden() ? clearTimeout(timer) : wait(Math.max(0, last + EVERY - Date.now())))
    // scrolled up to the top on their own: what's held goes on top
    const scrolled = () => held.current?.k === k && atTop() && show(false)
    wait(EVERY)
    document.addEventListener('visibilitychange', seen)
    addEventListener('scroll', scrolled, { passive: true })
    return () => {
      on = false
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', seen)
      removeEventListener('scroll', scrolled)
    }
  }, [k])
  useEffect(() => {
    // re-armed after every render, so pages that filter down to nothing keep loading
    const o = new IntersectionObserver((e) => e[0].isIntersecting && cursor && more(), { rootMargin: '800px' })
    sentinel.current && o.observe(sentinel.current)
    return () => o.disconnect()
  })
  const news = held.current?.k === k ? held.current.news : []
  return (
    <>
      {news.length > 0 && pill?.(news, () => show(true))}
      {row(items)}
      {err && <div class="note">{t('Couldn\'t load: {error}', { error: err })} <button class="link-btn" onClick={() => more()}>{t('Retry')}</button></div>}
      {busy && (items.length ? <div class="spinner" aria-label={t('Loading')} /> : <div aria-label={t('Loading')}>{[0, 1, 2, 3].map(() => <div class="skel"><i /><span><b /><b /><b /></span></div>)}</div>)}
      {cursor === null && !items.length && !err && !busy && <div class="note">{empty || t('Nothing here yet.')}</div>}
      <div ref={sentinel} />
    </>
  )
}

// Home's replies come with their conversation, like the thread page draws it: the root, "Show full thread" when
// posts were skipped, the parent and the reply, never more than 3 posts. A reply shows when the cast it answers is
// the viewer's or by someone they follow. A post shows once per feed: `shown` lasts across its pages, a reply whose
// parent is already up is left out, and one whose root is already up shows without it.
const ask = (() => {
  // ponytail: one queue for every feed's lookups, 6 at a time, because haatz stalls under ~100 parallel requests
  let active = 0
  const waiting: (() => void)[] = []
  return async <T,>(f: () => Promise<T>) => {
    while (active >= 6) await new Promise<void>((r) => waiting.push(r))
    active++
    try {
      return await f()
    } finally {
      active--
      waiting.shift()?.()
    }
  }
})()
// `viewer` is whose Following feed it is: the signed-in user, or the account browsed as (browse.ts); `local`: the
// device's own list without a finished account (anonymous mode, local.ts)
async function threads(casts: Cast[], shown: Set<string>, viewer = account?.fid, local = false) {
  const units = await Promise.all(casts.map(async (c): Promise<Cast | null> => {
    // a recast shows on its own, whoever the cast replies to
    if (!c.parent_hash || c.recaster) return c
    const parent = await ask(() => fetchCast(c.parent_hash!))
    if (!parent) return null
    const to = parent.author.fid
    // the device's list decides, not a half-made account's viewer_context (nor its on-chain follows when browsed as)
    if (local) {
      if (to !== account?.fid && !(await amFollowing(to))) return null
    }
    // nodes with Hypersnap PR #43 say whether the signed-in user follows the author; others are asked
    else if (!(await repliesFit(to, viewer, account?.fid, parent.author.viewer_context?.following, (to, v) => ask(() => amFollowing(to, v))))) return null
    if (!parent.parent_hash) return { ...c, up: [parent], gap: false }
    // the root: straight from thread_hash (PR #43), else up to five more steps up, like the thread page
    let root: Cast | null = null
    let skipped = false
    if (parent.thread_hash) {
      root = await ask(() => fetchCast(parent.thread_hash!))
      skipped = !!root && parent.parent_hash !== root.hash
    } else {
      let up: Cast | null = parent
      for (let i = 0; up?.parent_hash && i < 5; i++) up = await ask(() => fetchCast(up!.parent_hash!))
      if (up && !up.parent_hash) (root = up), (skipped = parent.parent_hash !== root.hash)
    }
    return root ? { ...c, up: [root, parent], gap: skipped } : { ...c, up: [parent], gap: true }
  }))
  return oncePerFeed(units, shown)
}

function Unit({ c, owner }: { c: Cast; owner?: number }) {
  if (!c.up?.length) return <CastCard c={c} owner={owner} />
  const parent = c.up[c.up.length - 1]
  return (
    <div class="unit">
      {c.up.slice(0, -1).map((p) => <CastCard key={p.hash} c={p} line inThread />)}
      {c.gap && <a class="thread-gap" href={`/c/${c.hash}`}>{t('Show full thread')}</a>}
      <CastCard c={parent} line inThread />
      <CastCard c={c} inThread />
    </div>
  )
}

/** "↑ 3 new posts" over a feed scrolled down (#640), with the faces of up to 3 of who posted them; a tap shows them.
 *  It floats under the page's header, in the middle of the column. */
function NewPosts({ cs, show }: { cs: Cast[]; show: () => void }) {
  const [at, setAt] = useState<{ top: number; left: number } | null>(null)
  useLayoutEffect(() => {
    const place = () => {
      const col = document.querySelector('main.col')
      const head = col?.querySelector('.phead')?.getBoundingClientRect()
      const box = col?.getBoundingClientRect()
      setAt({ top: Math.max(0, head?.bottom ?? 0) + 10, left: box ? box.left + box.width / 2 : innerWidth / 2 })
    }
    place()
    addEventListener('resize', place)
    return () => removeEventListener('resize', place)
  }, [])
  const faces = [...new Map(cs.map((c) => [(c.recaster || c.author).fid, c.recaster || c.author])).values()].slice(0, 3)
  return (
    <button class="new-posts" style={at ? { top: `${at.top}px`, left: `${at.left}px` } : { visibility: 'hidden' }} onClick={show}>
      <Icon d={P.up} size={16} />
      <span class="faces" aria-hidden="true">{faces.map((u) => <Avatar key={u.fid} u={u} size={22} link={false} />)}</span>
      {tn(cs.length, '{n} new post', '{n} new posts')}
    </button>
  )
}

// the signed-out home feed the server's page shows (server/home.mjs), until the feed loads its first page
let boot: Cast[] | null = null
// `cacheKey` keeps a feed's first page in this browser, so a reload paints it immediately; `owner` is the profile
// it's on. A conversation with a muted post in it is left out whole.
// `skip`: a cast shown above the feed already (a profile's pinned cast), left out of it
// `viewer`: a threaded feed's owner when it isn't the signed-in user's (threads()); `local`: Home's Following from the
// device's list (anonymous mode, local.ts)
// `live`: the feed looks for new posts above it every minute (#640), reading its first page again past the cache
// (`load`'s `fresh`): the ones above its top casts ('top', a feed newest first), or the ones posted after its newest
// cast ('time', Trending)
function Feed({ load, k, empty, keep, cacheKey, thread, owner, skip, viewer, local, live }: { load: (cursor?: string, fresh?: boolean) => Promise<Page>; k: string; empty?: string; keep?: (c: Cast) => boolean; cacheKey?: string; thread?: boolean; owner?: number; skip?: string | null; viewer?: number; local?: boolean; live?: 'top' | 'time' }) {
  // the posts this feed shows so far, for threads(), and the key they're for; a first page starts over (shownFor)
  const shown = useRef({ k, set: new Set<string>() })
  const shows = (c: Cast) => !silenced(c.recaster?.fid) && (!skip || pinKey(c.hash) !== skip) && ![c, ...(c.up || [])].some((x) => hides(x, owner))
  const hashes = (cs: Cast[]) => cs.flatMap((c) => [c.hash, ...(c.up || []).map((p) => p.hash)])
  const poll = live && (async (have: Cast[]): Promise<News<Cast> | null> => {
    const r = await load(undefined, true)
    const top = newOnTop(have, r.casts, live === 'time')
    if (!top.items.length || shown.current.k !== k) return null
    // with a gap, the page takes the list's place, so it's made like a first page
    const page = top.gap ? r.casts : top.items
    const casts = thread ? await threads(page, new Set(top.gap ? [] : [...shown.current.set, ...hashes(have)]), viewer ?? account?.fid, local) : keep ? page.filter(keep) : page
    await hydrateParents(casts)
    const had = new Set(have.map((c) => c.hash))
    const news = casts.filter((c) => !had.has(c.hash) && shows(c) && (c.recaster || c.author).fid !== account?.fid)
    return top.gap ? { items: casts, news, cursor: r.casts.length ? r.next?.cursor || null : null } : { items: casts, news }
  })
  return <Pager<Cast> k={k} empty={empty} id={(c) => c.hash} row={(cs) => cs.filter(shows).map((c) => <Unit key={c.hash} c={c} owner={owner} />)}
    poll={poll || undefined} pill={(cs, show) => <NewPosts cs={cs} show={show} />}
    initial={() => (cacheKey === '0:trending' && boot) || (cacheKey ? read<Cast[]>(`quilcast:feed:${cacheKey}`, []) : [])}
    // a list Back brought back (restore.ts) goes on without repeats: what it showed is what's in it (oncePerFeed). New
    // posts put on top join the same set, which a page still loading adds its own to; and a feed that's not threaded
    // keeps its key too, which its poll checks
    restored={(k, cs, added) => void (added && shown.current.k === k ? hashes(added).forEach((x) => shown.current.set.add(x)) : (shown.current = { k, set: new Set(hashes(cs)) }))}
    load={async (cursor) => {
      // taken now, not after the request: one Feed is reused when `k` changes, and an older key's load can end later
      const seen = shownFor(shown.current, k, !cursor)
      let r = await load(cursor)
      // a tab that keeps only some casts (a profile's Casts or Replies) can get whole pages with none to keep, like a bot
      // that only ever replies: read on within this one load, so the skeleton stays put instead of flashing page after
      // page. ponytail: after 10 such pages it stops and shows the empty note; anything older is out of reach here
      const filtered = keep && !thread
      for (let i = 0; filtered && i < 10 && r.casts.length && !r.casts.some(keep) && r.next?.cursor; i++) r = await load(r.next.cursor)
      const nothing = filtered && !r.casts.some(keep)
      let casts = thread ? await threads(r.casts, seen, viewer ?? account?.fid, local) : keep ? r.casts.filter(keep) : r.casts
      // the server's page (at most a minute old) keeps its order on top, with fresh counts, and the rest goes under
      // it, so nothing on screen moves
      const kept = !cursor && cacheKey === '0:trending' && boot
      if (!cursor) boot = null
      if (kept) casts = [...kept.map((b) => casts.find((c) => c.hash === b.hash) || b), ...casts.filter((c) => !kept.some((b) => b.hash === c.hash))]
      await hydrateParents(casts)
      if (!cursor) await warm(casts.slice(0, 6))
      if (!cursor && cacheKey) {
        try {
          // the device's list may have lost someone while this page loaded (stillFollowed)
          save(`quilcast:feed:${cacheKey}`, (local ? stillFollowed(casts) : casts).slice(0, 20))
        } catch {}
      }
      return { items: casts, cursor: r.casts.length && !nothing ? r.next?.cursor || null : null }
    }} />
}

/** Tapping the tab or nav item you're already on reloads the list from the top. */
// each history entry's count of reloads, part of its lists' keys, so Back to an entry reloaded before finds the list
// it last had (restore.ts). Read on every draw: one page can be reused for another entry (/channel/a to /channel/b).
function useReload(): [number, () => void] {
  const [, redraw] = useState(0)
  const round = stateOf<number>('round') || 0
  const reload = () => (forget(), scrollTo(0, 0), keepState('round', (stateOf<number>('round') || 0) + 1), redraw((n) => n + 1))
  useEffect(() => {
    addEventListener('refresh', reload)
    return () => removeEventListener('refresh', reload)
  }, [])
  return [round, reload]
}

// --- views ---

// Trending keeps top-level casts, minus farcaster.xyz Spaces: their replies are the room's chat, not interest, and
// the post itself is often empty
const isSpace = (c: Cast) => (c.embeds || []).some((e: any) => /^https:\/\/(farcaster\.xyz|warpcast\.com)\/~\/spaces\//.test(e?.url || ''))
const trendy = (c: Cast) => !c.parent_hash && !isSpace(c)

// Anonymous mode (#491): the Following feed of the accounts followed on this device, merged here (local.ts says why)
const localGet = (() => {
  const run = pool(6)
  // a request that hung is dropped from the memo, so asking again (or opening that profile) starts a new one
  return (path: string, q: Record<string, string | number | undefined>) =>
    run(() => within(get(path, q), 15000).catch((e) => {
      if (e?.timeout) forget(urlOf(path, q))
      throw e
    }))
})()
// the browser refused to store a change to the list (local.ts)
addEventListener('follows-unsaved', () => toast(t("Couldn't save that on this device. Its storage may be full or blocked.")))
addEventListener('follows-full', () => toast(t('You follow {max} accounts on this device, as many as it holds. Unfollow someone to follow someone new.', { max: IMPORT_MAX })))
function useLocalFollows() {
  const [list, setList] = useState(localFollows)
  useEffect(() => {
    const f = () => setList(localFollows())
    addEventListener('follows', f)
    return () => removeEventListener('follows', f)
  }, [])
  return list
}
// `status` hears how many accounts have answered while the first page waits for them all (null once it's in), and
// which ones the node couldn't serve (local.ts merger)
type LocalStatus = { loading: [number, number] | null; skipped: number[] }
const localFeed = (list: Local[], status: (s: LocalStatus) => void) => {
  let next: ReturnType<typeof merger<Cast>> | null = null
  let page = 0
  // each start over has its number: what an earlier one says late is ignored
  let run = 0
  return async (cursor?: string): Promise<Page> => {
    const fresh = !cursor || !next
    const me = fresh ? ++run : run
    const say = (s: LocalStatus) => me === run && status(s)
    // a first page starts the merge over, with the accounts' names for "Recast by" (100 a request; without them a
    // recast shows the username it was followed by)
    if (fresh) {
      page = 0
      say({ loading: null, skipped: [] })
      for (let i = 0; i < list.length; i += 100) await within(loadUsers(list.slice(i, i + 100).map((l) => l.fid)), 15000).catch(() => {})
      next = merger(localSources<Cast>(list, localGet, (l) => users.get(l.fid) || { fid: l.fid, username: l.username }), (d, all) => !page && say({ loading: [Math.floor(d / 2), all / 2], skipped: [] }), undefined, ofAccount)
    }
    try {
      const r = await next!(25)
      say({ loading: null, skipped: [...new Set(r.skipped.map((i) => list[ofAccount(i)]?.fid))] })
      return { casts: r.items, next: { cursor: r.more ? String(++page) : null } }
    } catch (e) {
      say({ loading: null, skipped: [] })
      throw e
    }
  }
}

// the accounts this browser browsed as lately (browse.ts), newest first
const RECENT_KEY = 'quilcast:browsed'
/** Home's `?as=`, kept current as the page changes. */
function useAs() {
  const [as, setAs] = useState(() => asOf(location.search))
  useEffect(() => {
    const f = () => setAs(asOf(location.search))
    addEventListener('popstate', f)
    return () => removeEventListener('popstate', f)
  }, [])
  return as
}
const Recents = ({ skip }: { skip?: number }) => {
  const list = recentsOf(read(RECENT_KEY, [])).filter((r) => r.fid !== skip)
  return list.length ? <p class="recents">{t('Browse as')} {list.map((r) => <a key={r.fid} href={browsePath(r)}>@{handle(r)}</a>)}</p> : null
}

function Home() {
  // browsing as someone (browse.ts): their Following feed, read-only, whoever is signed in
  const as = useAs()
  // who `as` turned out to be, with the `as` asked: a name can resolve to someone whose username is spelled otherwise
  // (an fname whose account goes by an ENS name, a FID with leading zeros)
  const [who, setWho] = useState<{ as: string; u: User } | null>(() => (as && known(as) ? { as, u: known(as)! } : null))
  const [err, setErr] = useState<(Error & { status?: number }) | null>(null)
  const [tries, setTries] = useState(0)
  // without an account, the accounts followed on this device (anonymous mode, local.ts)
  const anon = !account?.done
  const local = useLocalFollows()
  type Tab = 'following' | 'trending'
  // Back comes back to the tab it was on (restore.ts)
  const tabOf = (as: string | null | undefined) => stateOf<Tab>(`home:${as || ''}`) || (account?.done || as || local.length ? 'following' : 'trending')
  const [tab, setTab] = useState<Tab>(() => tabOf(as))
  // the tab on screen when the page is left, picked or not, is the one Back comes back to
  const tabNow = useRef(tab)
  tabNow.current = tab
  useEffect(() => holding(`home:${as || ''}`, () => tabNow.current), [as])
  const [round, reload] = useReload()
  useEffect(() => {
    setErr(null)
    setTab(tabOf(as))
    if (!as) return setWho(null)
    const k = known(as)
    setWho(k && { as, u: k })
    let live = true
    getUser(as).then((u) => {
      if (!live) return
      setWho({ as, u })
      try {
        save(RECENT_KEY, remember(read(RECENT_KEY, []), u))
      } catch {}
    }, (e) => live && setErr(e))
    return () => void (live = false)
  }, [as, tries])
  // only once it's the one `as` names, so a feed never loads for the account browsed before
  const target = as && who?.as === as ? who.u : null
  const name = target ? handle(target) : as
  const following = tab === 'following'
  // signed out (or half-made), not browsing as anyone: Following is the device's list, merged here (local.ts)
  const localMode = following && !as && anon
  const pick = (t: typeof tab) => (t === tab ? reload() : ((tabNow.current = t), setTab(t)))
  // the device's list, as it is now: a follow or unfollow elsewhere starts the feed over
  const fids = local.map((l) => l.fid).join()
  const [status, setStatus] = useState<LocalStatus>({ loading: null, skipped: [] })
  // only the feed on screen speaks: one replaced by a reload or a follow may still be finishing its requests
  const current = useRef<unknown>(null)
  const loadLocal = useMemo(() => {
    const f = localFeed(local, (s) => current.current === f && setStatus(s))
    current.current = f
    return f
  }, [fids, round])
  return (
    <>
      {settings.quorum ? (
        // Quorum's feed: Discover first, a refresh button, the composer, and a line saying what the feed holds
        <>
          <Header title={t('Home')} back={false} action={<button class="icon-btn" aria-label={t('Refresh')} title={t('Refresh')} onClick={reload}><Icon d={P.refresh} /></button>}>
            <Tabs tabs={[['trending', `${t('Discover')} 🌐`], ['following', t('Following')]]} value={tab} set={pick} />
          </Header>
          {!as && <QuorumCompose />}
          <div class="q-sub">{!following ? <><span>🌐 {t('Public posts')}</span><span class="muted">{t('Trending on the network')}</span></> : <><span>{t('Following')}</span><span class="muted">{as ? t('From people @{name} follows', { name: name! }) : t('From people you follow')}</span></>}</div>
        </>
      ) : (
        <Header title={t('Home')} back={false}>
          <Tabs tabs={[['following', t('Following')], ['trending', t('Trending')]]} value={tab} set={pick} />
        </Header>
      )}
      {as ? (
        <div class="banner browsing" role="status">
          {target && <Avatar u={target} size={40} link={false} />}
          <div><b>{t('Browsing as @{name}', { name: name! })}</b><p>{t('Casts from the people @{name} follows. Nothing you do here acts as them.', { name: name! })}</p><Recents skip={target?.fid} /></div>
          <span class="btns">
            {!account?.done && <a class="btn ghost small" href="/join">{t('Join')}</a>}
            <a class="btn small" href="/">{t('Exit')}</a>
          </span>
        </div>
      ) : !account?.done && (
        <div class="banner">
          <div><b>{t('Farcaster without the middlemen')}</b><p>{app ? t('Quilcast talks straight to the Hypersnap network, and your keys never leave this device.') : t('Quilcast talks straight to the Hypersnap network, and your keys never leave this browser.')}</p>
            <Recents />
            {android && <PlayBadge />}</div>
          <a class="btn small" href="/join">{t('Join')}</a>
        </div>
      )}
      {account?.done && !as && <PlayBanner />}
      {localMode && (
        <div class="note local-note">
          {t('You follow these people on this device only. Nothing is published, and clearing this site\'s data erases the list.')} <a href="/settings#follows">{t('Export or import')}</a>
          {/* a long list takes a while: say how far it got */}
          {status.loading && status.loading[1] > 10 && <p>{t('Loading casts from {n} of {all} accounts…', { n: status.loading[0], all: status.loading[1] })}</p>}
          {status.skipped.length > 0 && <p>{t("Couldn't load {names} right now.", { names: status.skipped.map((f) => `@${handle(users.get(f) || { fid: f })}`).join(', ') })}</p>}
        </div>
      )}
      {/* replies show in Following with their conversation (threads()); Trending keeps top-level casts */}
      {as && !target && following ? (
        err ? <div class="note">{err.status === 404 ? t('No one goes by that name.') : <>{t('Couldn\'t load: {error}', { error: err.message })} <button class="link-btn" onClick={() => setTries((x) => x + 1)}>{t('Retry')}</button></>}</div> : <div class="spinner" />
      ) : localMode ? (
        <Feed k={`local:${round}:${fids}`} cacheKey="local:following" local empty={t('Follow people from their profiles and their casts will show up here.')} thread load={loadLocal} />
      ) : (
        // someone else's Following isn't kept in this browser: only your own feeds paint from the cache
        <Feed k={`${target ? `as${target.fid}:` : ''}${following ? 'following' : 'trending'}:${round}`} cacheKey={target && following ? undefined : `${account?.fid || 0}:${following ? 'following' : 'trending'}`} keep={trendy} thread={following} viewer={target?.fid} live={following ? 'top' : 'time'}
          empty={target && following ? t('Nothing yet from the people @{name} follows.', { name: name! }) : t('Follow a few people and their casts will show up here.')}
          load={(cursor, fresh) => (following ? get('/v2/farcaster/feed/following', { fid: target?.fid ?? account!.fid, limit: 50, cursor, with_recasts: 'true' }, fresh) : get('/v2/farcaster/feed/trending', { limit: 50, cursor }, fresh))} />
      )}
    </>
  )
}

type Note = { type: string; cast?: Cast | null; user: User; timestamp: string }
type Group = { key: string; type: string; cast?: Cast | null; users: User[]; timestamp: string }
const seenKey = () => `quilcast:seen:${account?.fid}`
const ACTS: Record<string, [string, string, string]> = {
  likes: ['liked your cast', P.like, 'lk'],
  recasts: ['recast your cast', P.recast, 'rc'],
  follows: ['followed you', P.user, 'fo'],
}
// `type` comes from the node, so only own keys count (no `__proto__` surprises)
const ACT = (t: string) => (Object.hasOwn(ACTS, t) ? ACTS[t] : undefined)

function NoteRow({ g }: { g: Group }) {
  if (g.cast && !ACT(g.type)) return <CastCard c={g.cast} />
  const [verb, icon, cls] = ACT(g.type) || [String(g.type), P.user, 'fo']
  const first = g.users[0]
  const others = g.users.length - 1
  const line = g.type === 'likes' ? (others ? tn(others, '{name} and {n} other liked your cast', '{name} and {n} others liked your cast') : t('{name} liked your cast'))
    : g.type === 'recasts' ? (others ? tn(others, '{name} and {n} other recast your cast', '{name} and {n} others recast your cast') : t('{name} recast your cast'))
    : g.type === 'follows' ? (others ? tn(others, '{name} and {n} other followed you', '{name} and {n} others followed you') : t('{name} followed you'))
    : `{name} ${verb}`
  return (
    <a class="note-row" href={g.cast ? `/c/${g.cast.hash}` : userPath(first)}>
      <span class={`note-icon ${cls}`}><Icon d={icon} fill={g.type === 'likes'} size={20} /></span>
      <span class="note-body">
        {/* the row opens the cast; each face opens that person's profile instead */}
        <span class="note-avatars">{g.users.slice(0, 7).map((u) => <Avatar u={u} size={30} link={false} onClick={(e) => (e.preventDefault(), e.stopPropagation(), go(userPath(u)))} />)}</span>
        <span><With s={line} k="name"><b>{nameOf(first)}</b></With> <span class="muted">· {ago(g.timestamp)}</span></span>
        {g.cast && <NotePeek c={g.cast} />}
      </span>
    </a>
  )
}

// a cast that is only media shows a thumbnail; one that is only a link shows the link
function NotePeek({ c }: { c: Cast }) {
  const text = castText(c).trim()
  const img = !text && thumbOf(c)
  return img ? <Img class="qimg" src={sized(img, 'w=240')} /> : <span class="note-cast">{text || urlsOf(c)[0] || t('Your cast')}</span>
}

// group likes/recasts per cast and follows per day; replies and mentions stay one per cast
const group = (notes: Note[]) => {
  const out = new Map<string, Group>()
  for (const n of notes) {
    const key = ACT(n.type) ? `${n.type}:${n.cast?.hash || String(n.timestamp).slice(0, 10)}` : `${n.type}:${n.cast?.hash}:${n.user.fid}`
    const g = out.get(key)
    if (g) !g.users.some((u) => u.fid === n.user.fid) && g.users.push(n.user)
    else out.set(key, { key, type: n.type, cast: n.cast, users: [n.user], timestamp: n.timestamp })
  }
  return [...out.values()]
}

// ponytail: the node returns at most 100 reactions or quotes per cast and can't page them, so lists stop there
const quotesOf = async (hash: string, limit = 100) => (await get('/v2/farcaster/cast/quotes', { identifier: hash, type: 'hash', limit })).casts as Cast[]

type AppNote = { id: string; app: string; name: string; icon?: string; notificationId: string; title: string; body: string; targetUrl: string; at: number }
/** This browser's mini app notifications, kept by our server under the account's inbox secret. */
const appNotes = (): Promise<AppNote[]> =>
  account?.inbox ? fetch('/api/notify/inbox', { headers: { 'x-inbox': account.inbox } }).then((r) => (r.ok ? r.json() : { items: [] })).then((j) => j.items, () => []) : Promise.resolve([])
const openNote = (n: AppNote) => requireAccount() && import('./miniapp.tsx').then((m) => m.launch({ url: n.targetUrl, name: n.name, icon: n.icon }, { notification: { notificationId: n.notificationId, title: n.title, body: n.body } }))

function AppNotes() {
  const [list, setList] = useState<AppNote[] | null>(null)
  useEffect(() => void appNotes().then(setList), [])
  if (!list) return <div class="spinner" />
  if (!list.length) return <div class="note">{t('Mini apps you turned notifications on for will show up here.')}</div>
  return (
    <>
      {list.map((n) => (
        <button class="note-row app-note" onClick={() => openNote(n)}>
          <AppIcon src={n.icon} name={n.name} />
          <span class="note-body">
            <span><b>{n.name}</b> <span class="muted">· {ago(n.at)}</span></span>
            <b>{n.title}</b>
            <span class="note-cast">{n.body}</span>
          </span>
        </button>
      ))}
    </>
  )
}

function Notifications() {
  const [tab, setTab] = useState<'all' | 'replies' | 'apps'>('all')
  const [round, reload] = useReload()
  useEffect(() => {
    // opening or refreshing the page marks everything up to now as seen
    localStorage.setItem(seenKey(), String(Date.now()))
    dispatchEvent(new Event('seen'))
  }, [round])
  if (!account?.done) return <><Header title={t('Notifications')} /><div class="note">{t('Sign in to see who replied, liked and followed.')}</div></>
  return (
    <>
      <Header title={t('Notifications')}>
        <Tabs tabs={[['all', t('All')], ['replies', t('Replies & mentions')], ...(account.inbox ? [['apps', t('Mini apps')] as ['apps', string]] : [])]} value={tab} set={(t) => (t === tab ? reload() : setTab(t))} />
      </Header>
      {/* fresh: opening the page marks everything as seen, so it shows what's new, Back or not */}
      {tab === 'apps' ? <AppNotes key={round} /> : <Pager<Note> fresh k={`${tab}:${round}`} empty={t('Nothing yet. When people reply, like or follow you, it shows up here.')}
        id={(n) => `${n.type}:${n.cast?.hash}:${n.user.fid}:${n.timestamp}`}
        row={(ns) => group(ns.filter((n) => !silenced(n.user.fid) && !(n.cast && !ACT(n.type) && hides(n.cast)))).map((g) => <NoteRow key={g.key} g={g} />)}
        load={async (cursor) => {
          // quotes, replies deeper in our threads and recasts come with Hypersnap PR #42's flag
          const r = await get('/v2/farcaster/notifications', { fid: account!.fid, limit: 50, cursor, include_quotes_and_deep_replies: 'true' }, true)
          const notes = r.notifications as Note[]
          const next = notes.length ? r.next?.cursor || null : null
          const items = notes.filter((n) => n.user && (tab === 'all' || (n.cast && !ACT(n.type))))
          // the node sends notification casts with zero counts (unliking one showed -1), so casts shown with their
          // counts get them from one bulk lookup
          const shown = items.flatMap((n) => (n.cast && !ACT(n.type) ? [n.cast] : []))
          await Promise.all([
            hydrateParents(items.flatMap((n) => (n.cast ? [n.cast] : []))),
            shown.length &&
              get('/v2/farcaster/casts', { casts: shown.map((c) => c.hash).join(',') }).then((r) => {
                const fresh = new Map((r.casts as Cast[]).map((c) => [c.hash, c]))
                for (const c of shown) if (fresh.has(c.hash)) Object.assign(c, { reactions: fresh.get(c.hash)!.reactions, replies: fresh.get(c.hash)!.replies })
              }, () => {}),
          ])
          return { items, cursor: next }
        }} />}
    </>
  )
}

/** Dots for the nav: a notification newer than the last visit to /notifications, and unread messages. */
function useUnread() {
  const [unread, setUnread] = useState({ notifications: false, messages: false })
  useEffect(() => {
    if (!account?.done) return
    // unchanged values keep the same object, so nothing re-renders
    const set = (k: keyof typeof unread, v: boolean) => setUnread((u) => (u[k] === v ? u : { ...u, [k]: v }))
    const check = () =>
      Promise.all([get('/v2/farcaster/notifications', { fid: account!.fid, limit: 1, include_quotes_and_deep_replies: 'true' }, true).catch(() => null), appNotes()]).then(([r, notes]) => {
        const t = Math.max((r?.notifications[0] && Date.parse(r.notifications[0].timestamp)) || 0, notes[0]?.at || 0)
        set('notifications', !!t && t > Number(localStorage.getItem(seenKey()) || 0))
      })
    check()
    const i = setInterval(check, 60000)
    const seen = () => set('notifications', false)
    // messages report their own dot, live (dms.ts)
    const dms = (e: Event) => set('messages', !!account?.dm && (e as CustomEvent<boolean>).detail)
    if (!account.dm) set('messages', false)
    addEventListener('seen', seen)
    addEventListener('dms', dms)
    return () => (clearInterval(i), removeEventListener('seen', seen), removeEventListener('dms', dms))
  }, [account?.fid, account?.dm])
  return unread
}

const WHO = { likes: () => t('Liked by'), recasts: () => t('Recast by'), quotes: () => t('Quotes') }

/** Who liked or recast a cast, or the casts quoting it. */
function Who({ hash, kind }: { hash: string; kind: keyof typeof WHO }) {
  return (
    <>
      <Header title={WHO[kind]()} />
      <Pager<Cast | User> k={`${hash}:${kind}`} empty={kind === 'quotes' ? t('No quotes yet.') : t('Nobody yet.')}
        id={(x) => ('hash' in x ? x.hash : String(x.fid))}
        row={(xs) => xs.map((x) => ('hash' in x ? <CastCard key={x.hash} c={x} /> : <UserRow key={x.fid} u={x} />))}
        load={async () => ({
          items: kind === 'quotes' ? await hydrateParents(await quotesOf(hash)) : (await get('/v2/farcaster/reactions/cast', { hash, types: kind, limit: 100 })).reactions.map((r: { user: User }) => r.user),
          cursor: null,
        })} />
    </>
  )
}

const FOLLOWS = { followers: () => t('Followers'), following: () => t('Following') }

/** Follow or unfollow `u` on this device (anonymous mode, local.ts), saying what that means; returns `on`. */
function followLocally(u: User, on: boolean) {
  // not saved: local.ts said so, and nothing changed
  if (!setLocal({ fid: u.fid, username: u.username }, on)) return !on
  toast(on ? t('Following @{name} on this device only. Nothing is published.', { name: handle(u) }) : t('Unfollowed @{name}', { name: handle(u) }))
  return on
}
/** A list row's Follow button in anonymous mode. */
function LocalFollow({ u }: { u: User }) {
  const local = useLocalFollows()
  const on = local.some((l) => l.fid === u.fid)
  return <button class={`btn small${on ? ' ghost' : ''}`} aria-pressed={on} title={t('On this device only')} onClick={() => followLocally(u, !on)}>{on ? t('Following') : t('Follow')}</button>
}

/** Who follows someone, or whom they follow. */
function Follows({ id, kind }: { id: string; kind: keyof typeof FOLLOWS }) {
  const fid = useMemo(() => getUser(id).then((u) => u.fid), [id])
  return (
    <>
      <Header title={FOLLOWS[kind]()} />
      <Pager<User> k={`${id}:${kind}`} empty={t('Nobody yet.')} id={(u) => String(u.fid)} row={(us) => us.map((u) => <UserRow key={u.fid} u={u} action={!account?.done && <LocalFollow u={u} />} />)}
        load={async (cursor) => {
          const r = await get(`/v2/farcaster/${kind}`, { fid: await fid, limit: 100, cursor })
          return { items: r.users, cursor: r.next?.cursor || null }
        }} />
    </>
  )
}

// what the cast and profile pages load first, shared with prefetch()
const conversation = (hash: string) => get('/v2/farcaster/cast/conversation', { identifier: hash.replace(/^0x/, ''), type: 'hash', reply_depth: 2 })
const userCasts = (fid: number, tab: 'casts' | 'replies', cursor?: string) =>
  get(tab === 'casts' ? '/v2/farcaster/feed/user/casts' : '/v2/farcaster/feed/user/replies_and_recasts', { fid, limit: 25, cursor })
const lookOf = (fid: number) => once<Look | null>(`/api/look/${fid}`, () => fetch(`/api/look/${fid}`).then((r) => (r.ok ? r.json() : null)).then(async (j) => j && (await looksMod()).clean(j)).catch(() => null))
// a user we already have from a feed, so their profile draws before the node answers
const known = (id: string) => (/^\d+$/.test(id) ? users.get(+id) : [...users.values()].find((u) => u.username?.toLowerCase() === id.toLowerCase())) || null

/** Starts loading what a cast or profile link opens, when a pointer rests on it or a finger touches it. */
function prefetch(path: string) {
  const [, kind, id] = path.match(/^\/(c|u)\/([^/?#]+)$/) || []
  if (kind === 'c') conversation(id).catch(() => {}), quotesOf(id).catch(() => {})
  if (kind !== 'u') return
  const more = (u: User) => {
    userCasts(u.fid, 'casts').catch(() => {})
    isFollowing(u.fid)
    if (settings.looks !== false || account?.fid === u.fid) lookOf(u.fid).then((l) => l && looksMod())
  }
  // someone from a feed needs no lookup first
  const u = known(decodeURIComponent(id))
  u ? (more(u), getUser(u.fid).catch(() => {})) : getUser(decodeURIComponent(id)).then(more, () => {})
}
{
  // a cast card is a link by data-href; hovering waits a beat so sweeping over a feed doesn't load every cast
  let timer: ReturnType<typeof setTimeout>
  const link = (e: Event) => (e.target as Element).closest?.('a[href^="/"], [data-href]')
  const href = (el: Element) => el.getAttribute('data-href') || el.getAttribute('href')!
  addEventListener('pointerdown', (e) => { const el = link(e); el && prefetch(href(el)) }, true)
  addEventListener('pointerover', (e) => { clearTimeout(timer); const el = link(e); if (el) timer = setTimeout(() => prefetch(href(el)), 80) })
}

function Thread({ hash }: { hash: string }) {
  const [c, setC] = useState<Cast | null>(null)
  const [up, setUp] = useState<Cast[]>([])
  // the top parent was deleted (or the node lost it), so the reply doesn't pose as a root cast
  const [lost, setLost] = useState(false)
  const [err, setErr] = useState('')
  const [quotes, setQuotes] = useState(0)
  // an article's later parts reply to the part before them: the article shows them, so the replies leave them out
  const [parts, setParts] = useState<string[]>([])
  useEffect(() => {
    let live = true
    setC(null)
    setUp([])
    setLost(false)
    setErr('')
    setQuotes(0)
    setParts([])
    quotesOf(hash).then((q) => live && setQuotes(q.length), () => {})
    // walk up to five parents so the reply reads in context
    let walked = false
    const parents = async (cast: Cast) => {
      if (walked) return
      walked = true
      const chain: Cast[] = []
      for (let p = cast.parent_hash; p && chain.length < 5; ) {
        const pc = await fetchCast(p)
        if (!live) break
        if (!pc) {
          setLost(true)
          break
        }
        chain.unshift(pc)
        setUp([...chain])
        p = pc.parent_hash
      }
    }
    // a cast we just posted shows right away and takes a moment to be indexed, so retry until it is
    // so does one tapped in a feed, its replies following
    const sent = posting.get(hash)
    const seen = sent || cards.get(hash)
    if (seen) setC(seen), parents(seen)
    // until a cast we sent has landed it's asked for with its author, so the node never remembers it as missing (fetchCast)
    const load = (tries: number): unknown =>
      (sent ? get('/v2/farcaster/cast', { identifier: hash, type: 'hash', fid: sent.author.fid }, true) : Promise.resolve()).then(() => conversation(hash)).then(
        async (r) => {
          const cast: Cast = r.conversation.cast
          await hydrateParents([cast, ...(cast.direct_replies || [])])
          if (!live) return
          posting.delete(hash)
          setC(cast)
          parents(cast)
        },
        (e) => live && (tries ? setTimeout(() => load(tries - 1), 1500) : !sent && setErr(e.message)),
      )
    load(sent ? 40 : 5)
    return () => void (live = false)
  }, [hash])
  return (
    <>
      <Header title={t('Cast')} />
      {err && <div class="note">{t('This cast couldn\'t be found. It may have been deleted.')}</div>}
      {!c && !err && <div class="spinner" />}
      {c && (
        <>
          {lost && <div class="note">{t('This cast is unavailable.')}</div>}
          {up.map((p) => <CastCard key={p.hash} c={p} line inThread />)}
          <CastCard c={c} focus quotes={quotes} onArticle={setParts} />
          <button class="reply-prompt" onClick={() => (account?.done ? shell.compose({ parent: c }) : go('/join'))}>
            {account?.done && <Avatar u={myUser()!} size={32} link={false} />}
            <span>{t('Post your reply')}</span>
          </button>
          {(c.direct_replies || []).filter((r) => !hides(r) && !parts.includes(r.hash)).map((r) => {
            const kids = (r.direct_replies || []).filter((k) => !hides(k))
            return (
              <div class="reply-group" key={r.hash}>
                <CastCard c={r} line={kids.length > 0} inThread />
                {kids[0] && <CastCard c={kids[0]} inThread />}
                {kids.length > 1 && <a class="more-replies" href={`/c/${r.hash}`}>{tn(kids.length - 1, 'Show {n} more reply', 'Show {n} more replies')}</a>}
              </div>
            )
          })}
          {!c.direct_replies ? c.replies?.count > 0 && <div class="spinner" /> : !c.direct_replies.some((r) => !parts.includes(r.hash)) && <div class="note">{t('No replies yet.')}</div>}
        </>
      )}
    </>
  )
}

type Looks = typeof import('./looks.tsx')
const looksMod = () => import('./looks.tsx')

function Profile({ id }: { id: string }) {
  const [u, setU] = useState<User | null>(() => known(id))
  const [err, setErr] = useState<(Error & { status?: number }) | null>(null)
  const [tries, setTries] = useState(0)
  // Back comes back to the tab it was on (restore.ts)
  const [tab, setTab] = useState<'casts' | 'replies'>(() => stateOf(`profile:${id}`) || 'casts')
  const tabNow = useRef(tab)
  tabNow.current = tab
  useEffect(() => holding(`profile:${id}`, () => tabNow.current), [id])
  const [following, setFollowing] = useState<boolean | null>(null)
  // they follow the viewer; shown only once known, so nothing jumps while it's asked
  const [followsYou, setFollowsYou] = useState(false)
  const [, setSpamChecked] = useState(0)
  const [menu, setMenu] = useState(false)
  // the profile's look (src/looks.tsx), and the owner's unsaved version while they edit it
  const [L, setL] = useState<Looks | null>(null)
  const [look, setLook] = useState<Look | null>(null)
  const [draft, setDraft] = useState<Look | null>(null)
  const was = useRef(false)
  // the saved look once it has loaded, so the editor never opens on a blank one
  const loaded = useRef<Promise<Look | null>>(Promise.resolve(null))
  // a search of only this account's casts (castsearch.ts); ?q= on the profile's link opens with it
  const askedQ = () => new URLSearchParams(location.search).get('q') || ''
  const [q, setQ] = useState(askedQ)
  const [term, setTerm] = useState(() => q.trim())
  const [searching, setSearching] = useState(() => !!q)
  const box = useRef<HTMLInputElement>(null)
  const searchBtn = useRef<HTMLButtonElement>(null)
  // the box takes focus only when the button opened it: a ?q= link or Back shows it without popping a phone's keyboard
  const focusBox = useRef(false)
  // the search the feed shows now, a new object each time it changes: a load for an older one (another word, another
  // profile, a page left) reads no more, even when the same words come back while it's still reading
  const current = useRef({ key: '' })
  // the search whose first load gave up at castsearch's cap with nothing found
  const [capped, setCapped] = useState('')
  // ended from the box (Escape), focus goes back to the button rather than to the page
  const stopSearch = () => (setSearching(false), setQ(''), setTerm(''), searchBtn.current?.focus())
  const fromQ = () => {
    const sq = askedQ()
    setQ(sq)
    setTerm(sq.trim())
    setSearching(!!sq)
  }
  // still on a profile's own page (not its followers, a cast, another page this one is being left for)
  const onProfile = () => /^\/u\/[^/]+\/?$/.test(location.pathname)
  useEffect(() => {
    const k = known(id)
    setU(k)
    setErr(null)
    setTab(stateOf(`profile:${id}`) || 'casts')
    fromQ()
    setLook(null)
    setDraft(null)
    setFollowsYou(false)
    let live = true
    getUser(k?.fid ?? id).then((u) => {
      setU(u)
      checkAccounts([u.fid]).then(() => live && setSpamChecked((x) => x + 1))
      Promise.resolve((account?.done ? u.viewer_context?.following : undefined) ?? isFollowing(u.fid)).then((f) => ((was.current = f), setFollowing(f)))
      followsMe(u).then((f) => live && setFollowsYou(f))
    }, (e) => {
      if (!live) return
      setErr(e)
      // the node is down: the signed-in user is still who this browser says they are
      if (e.status !== 404) setU((x) => x || (isMe(id) ? myUser() : null))
    })
    return () => void (live = false)
  }, [id, tries])
  useEffect(() => {
    const t = setTimeout(() => setTerm(q.trim()), 300)
    return () => clearTimeout(t)
  }, [q])
  // Back and Forward between this profile's addresses, or its own link tapped mid-search, take the search they have
  useEffect(() => {
    const f = () => onProfile() && fromQ()
    addEventListener('popstate', f)
    return () => removeEventListener('popstate', f)
  }, [])
  // the search goes in the address (other parameters stay), so it's a link and Back from a found cast comes back to it
  useEffect(() => {
    if (!onProfile()) return
    const p = new URLSearchParams(location.search)
    if ((p.get('q') || '') === term) return
    term ? p.set('q', term) : p.delete('q')
    const s = p.toString()
    history.replaceState(null, '', location.pathname + (s ? `?${s}` : '') + location.hash)
  }, [term])
  useEffect(() => {
    if (searching && focusBox.current) box.current?.focus()
    focusBox.current = false
  }, [searching])
  useEffect(() => () => void (current.current = { key: '' }), [])
  const searchKey = u && term ? `${u.fid}?${term}` : ''
  if (current.current.key !== searchKey) current.current = { key: searchKey }
  const self = account?.fid === u?.fid
  // the cast they pinned (castpin.ts), shown first on Casts and left out of the list under it
  const pin = usePinnedCast(u?.fid ?? 0)
  // the pin PinnedCast drew on top or found gone; the list leaves it out only then (listSkip)
  const [settled, setSettled] = useState<string | null>(null)
  // a shared design (`design`, an id) is put on top of the look being edited
  const edit = (design?: string) =>
    Promise.all([looksMod(), loaded.current, design ? designOf(design) : null]).then(([m, l, des]) => {
      setL(m)
      setDraft((d) => (des ? m.withDesign(d || l || {}, des) : d || l || {}))
      if (design) toast(des ? t('Design loaded. Save to keep it.') : t('That design link doesn\'t work.'))
    })
  useEffect(() => {
    if (!u) return
    let live = true
    loaded.current = settings.looks !== false || self
      ? lookOf(u.fid)
      : Promise.resolve(null)
    loaded.current.then((l) => l && looksMod().then((m) => live && (setL(m), setLook(l))))
    if (!self) return () => void (live = false)
    // Settings links here with ?customize, and "Use this design" on a shared design with ?design=<id>
    const fromUrl = () => {
      const q = new URLSearchParams(location.search)
      if (!q.has('customize') && !q.has('design')) return
      edit(q.get('design') || undefined)
      // a search (?q=) stays
      q.delete('customize'), q.delete('design')
      const rest = q.toString()
      history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : ''))
    }
    fromUrl()
    addEventListener('popstate', fromUrl)
    return () => ((live = false), removeEventListener('popstate', fromUrl))
  }, [u?.fid])
  // someone who turned looks off still sees their own while editing it
  const shown = L && (draft || (settings.looks !== false ? look : null))
  useEffect(() => {
    if (!shown) return
    document.documentElement.dataset.look = ''
    return () => void delete document.documentElement.dataset.look
  }, [!!shown])
  const editLook = (f: (d: Look) => Look) => setDraft((d) => f(d || {}))
  // a follow on this device (anonymous mode) isn't on the network, so the count stays
  const followers = (u?.follower_count || 0) + (account?.done ? +!!following - +was.current : 0)
  const toggle = () => {
    if (!account?.done) return setFollowing(followLocally(u!, !following))
    const on = !following
    setFollowing(on)
    w().then((m) => m.follow(u!.fid, on)).catch((e) => (setFollowing(!on), toast(e.message)))
  }
  // the header is a box stickers can sit on, like the look's sections
  // the account's casts as RSS (server/feed.mjs), which nameless and taken-down accounts don't have
  const rssItem = u?.username && !u.username.startsWith('fid:') && !(removedList.fids as number[]).includes(u.fid) && (
    <button role="menuitem" onClick={() => (setMenu(false), navigator.clipboard.writeText(`${location.origin}/u/${u.username}/rss`).then(() => toast('Link copied'), () => toast("Couldn't copy the link.")))}>{t('Copy RSS link')}</button>
  )
  const searchButton = u && (
    <button ref={searchBtn} class="btn ghost small icon" aria-label={t('Search @{name}\'s casts', { name: handle(u) })} title={t('Search @{name}\'s casts', { name: handle(u) })} aria-pressed={searching} onClick={() => (searching ? stopSearch() : ((focusBox.current = true), setSearching(true)))}><Icon d={P.search} /></button>
  )
  const wrapHead = (el: ComponentChildren) => (shown ? <L.At l={shown} at="head" edit={draft ? editLook : undefined}>{el}</L.At> : el)
  return (
    <>
      <div class={`look${shown ? ' on' : ''}`} style={shown ? L.vars(shown) : undefined}>
        {shown && <L.Bg l={shown} />}
        {shown && <L.Fx fx={shown.fx} />}
        <Header title={u ? nameOf(u) : t('Profile')} />
        {err && !u && (
          <div class="note">
            {err.status === 404 ? t('No one goes by that name.') : <>{t('Couldn\'t load: {error}', { error: err.message })} <button class="link-btn" onClick={() => setTries((x) => x + 1)}>{t('Retry')}</button></>}
          </div>
        )}
        {!u && !err && <div class="spinner" />}
        {u && (
          <>
            {wrapHead(<section class="profile lk-box">
              {shown && <L.Banner l={shown} />}
              <div class="row-top">
                <Avatar u={u} size={72} link={false} onClick={u.fid === OGRE_FID ? (e) => ogreTap(e.currentTarget as Element) : undefined} />
                {self ? (
                  <span class="btns">
                    {cardButton(u.fid)}
                    {searchButton}
                    <button class="btn ghost small" onClick={() => edit()} disabled={!!draft}>{t('Customize')}</button>
                    <a class="btn ghost small" href="/settings">{t('Edit profile')}</a>
                    {rssItem && (
                      <span class="wrap-menu">
                        <button class="btn ghost small icon" aria-label={t('More')} aria-haspopup="menu" onClick={() => setMenu(!menu)}><Icon d={P.more} /></button>
                        {menu && <Menu class="right" close={() => setMenu(false)}>{rssItem}</Menu>}
                      </span>
                    )}
                  </span>
                ) : (
                  <span class="btns">
                    {/* a 1:1 conversation's id is both FIDs, sorted (as strings, like farcaster.xyz does) */}
                    {cardButton(u.fid)}
                    {searchButton}
                    {account?.done && <a class="btn ghost small" href={`/messages/${[account.fid, u.fid].sort().join('-')}`}>{t('Message')}</a>}
                    <button class={`btn small${following ? ' ghost' : ''}`} onClick={toggle} disabled={following === null && !!account?.done} aria-pressed={!!following} title={account?.done ? undefined : t('On this device only')}>{following ? t('Following') : t('Follow')}</button>
                    <span class="wrap-menu">
                      <button class="btn ghost small icon" aria-label={t('More')} aria-haspopup="menu" onClick={() => setMenu(!menu)}><Icon d={P.more} /></button>
                      {menu && (
                        <Menu class="right" close={() => setMenu(false)}>
                          <button role="menuitem" onClick={() => (setMenu(false), go(browsePath(u)))}>{t('Browse as @{name}', { name: handle(u) })}</button>
                          {rssItem}
                          <SilenceItems u={u} done={() => setMenu(false)} />
                        </Menu>
                      )}
                    </span>
                  </span>
                )}
              </div>
              <h2><span class={shown ? L.nameClass(shown) : undefined}>{nameOf(u)}</span></h2>
              <div class="handle">@{handle(u)} <span class="pill">fid {u.fid}</span>{!self && followsYou && <span class="pill">{t('Follows you')}</span>}{spamAccountOf(u.fid) != null && <span class="spam-tag" title={t('How likely spam.quilcast.com thinks this is a spam account')}>{t('Spam account {n}%', { n: spamAccountOf(u.fid)! })}</span>}{!self && (blockOf(u.fid) || muteOf(u.fid)) && <span class="pill">{blockOf(u.fid) ? t('Blocked') : t('Muted')} {untilText((blockOf(u.fid) || muteOf(u.fid))!.until)}</span>}</div>
              {shown && <L.Mood l={shown} />}
              {u.profile?.bio?.text && <RichText text={u.profile.bio.text} />}
              {u.follower_count !== undefined && <div class="counts"><a href={`${userPath(u)}/following`}><b>{n(u.following_count)}</b> {t('following')}</a><a href={`${userPath(u)}/followers`}><b>{n(followers)}</b> {tn(followers, 'follower', 'followers')}</a></div>}
            </section>)}
            {shown && <L.Sections l={shown} u={u} edit={draft ? editLook : undefined} />}
            <div class="lk-box lk-feed">
              {searching && (
                <div class="searchbox profile-search">
                  <Icon d={P.search} size={16} />
                  <input ref={box} type="search" value={q} onInput={(e) => setQ(e.currentTarget.value)} onKeyDown={(e) => e.key === 'Escape' && stopSearch()}
                    placeholder={t('Search @{name}\'s casts', { name: handle(u) })} aria-label={t('Search @{name}\'s casts', { name: handle(u) })} />
                </div>
              )}
              {!term && <Tabs tabs={[['casts', t('Casts')], ['replies', t('Replies')]]} value={tab} set={(t) => ((tabNow.current = t), setTab(t))} />}
              {!self && blockOf(u.fid) ? (
                <div class="note">{t('You blocked @{name}, so their casts are hidden.', { name: handle(u) })} <button class="link-btn" onClick={() => setMute('blocks', u.fid, false).catch((e) => toast(e.message))}>{t('Unblock')}</button></div>
              ) : term ? (
                // casts and replies alike, newest first
                <Feed k={searchKey} owner={u.fid} empty={capped === searchKey
                  ? t('None of the newest {n} casts by @{name} match “{term}”.', { n: MOST.toLocaleString(lang), name: handle(u), term })
                  : t('No casts by @{name} match “{term}”.', { name: handle(u), term })}
                  load={(cursor) => {
                    const s = current.current
                    return searchCasts(get, u.fid, term, cursor, () => current.current === s).then((r) => (!cursor && current.current === s && setCapped(r.capped ? s.key : ''), r))
                  }} />
              ) : (
                <>
                  {tab === 'casts' && pin && <PinnedCast key={pin} hash={pin} owner={u.fid} settle={setSettled} />}
                  <Feed k={`${u.fid}${tab}`} owner={u.fid} skip={tab === 'casts' ? listSkip(pin, settled) : null} empty={tab === 'casts' ? t('No casts yet.') : t('No replies yet.')} keep={tab === 'casts' ? (c) => !c.parent_hash : (c) => !!c.parent_hash}
                    load={(cursor) => userCasts(u.fid, tab, cursor)} />
                </>
              )}
            </div>
          </>
        )}
      </div>
      {L && draft && self && (
        <L.Editor draft={draft} set={editLook} close={() => setDraft(null)} saved={(l) => (forget(`/api/look/${u!.fid}`), setLook(l), setDraft(null))} />
      )}
    </>
  )
}

/** A profile's pinned cast, labelled. One that's gone (deleted, or never theirs) quietly shows nothing. It's read fresh
 *  (fetchCast keeps a miss for good) and drawn at once from a list it was just in. `settle(hash)` once it's drawn or
 *  known gone (null once it's off the page), so the list under it leaves it out only then: a read that fails (offline,
 *  a 5xx) leaves it in the list. */
function PinnedCast({ hash, owner, settle }: { hash: string; owner: number; settle: (hash: string | null) => void }) {
  const mine = (x?: Cast | null) => (x && x.author.fid === owner ? x : null)
  // pins keep 0x…, lists the node's bare hex
  const bare = hash.slice(2)
  // a card kept from a tapped recast would say "Recast by" above "Pinned"
  const [c, setC] = useState<Cast | null>(() => {
    const x = mine(cards.get(bare) || cards.get(hash))
    return x && { ...x, recaster: undefined }
  })
  useEffect(() => {
    let live = true
    const gone = () => (setC(null), settle(hash))
    get('/v2/farcaster/cast', { identifier: bare, type: 'hash', fid: owner }, true).then(
      (r) => live && (mine(r?.cast) ? setC(mine(r?.cast)) : gone()),
      (e) => live && e?.status === 404 && gone(),
    )
    return () => void (live = false)
  }, [hash, owner])
  useEffect(() => void (c && settle(hash)), [c, hash])
  // gone from the page (another tab or profile): what it settled goes too, so coming back the list keeps the pin until
  // this mount has drawn it again
  useEffect(() => () => settle(null), [hash])
  return c && <CastCard c={c} owner={owner} onTop />
}

// Quilcast Collect: the profile's trading card, a free 1/1 NFT on Base (collect/, contracts/src/QuilcastCards.sol)
const cardButton = (fid: number) => (
  <button class="btn ghost small icon cl" aria-label={t('Collect')} title={t('Collect')}
    onClick={(e) => (sparkle(e.currentTarget), launchApp({ url: `https://collect.quilcast.com/p/${fid}`, name: 'Quilcast Collect', icon: 'https://collect.quilcast.com/icon.png', splash: 'https://collect.quilcast.com/splash.png', bg: '#0d0c11' }))}><Icon d={P.collect} /></button>
)

function Search() {
  const params = new URLSearchParams(location.search)
  const [q, setQ] = useState(params.get('q') || '')
  const [tab, setTab] = useState<'people' | 'casts' | 'channels'>(params.get('t') === 'casts' ? 'casts' : params.get('t') === 'channels' ? 'channels' : 'people')
  const [people, setPeople] = useState<User[] | null>(null)
  const [term, setTerm] = useState(q.trim())
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => input.current?.focus(), [])
  // a #hashtag tapped in a cast here, or Back to an earlier search, is still this page: it takes the search from the URL
  useEffect(() => {
    const f = () => {
      if (location.pathname !== '/search') return
      const p = new URLSearchParams(location.search)
      const q = p.get('q') || '', tb = p.get('t')
      setQ(q)
      setTerm(q.trim())
      setTab(tb === 'casts' ? 'casts' : tb === 'channels' ? 'channels' : 'people')
    }
    addEventListener('popstate', f)
    return () => removeEventListener('popstate', f)
  }, [])
  useEffect(() => {
    const t = setTimeout(() => setTerm(q.trim()), 300)
    return () => clearTimeout(t)
  }, [q])
  useEffect(() => {
    history.replaceState(null, '', term || tab === 'channels' ? `/search?${new URLSearchParams({ ...(term && { q: term }), ...(tab !== 'people' && { t: tab }) })}` : '/search')
    setPeople(null)
    if (tab === 'people' && term) findUsers(term).then((us) => setPeople(us.slice(0, 25)), () => setPeople([]))
  }, [term, tab])
  return (
    <>
      <Header title={t('Search')}>
        <div class="searchbox">
          <Icon d={P.search} size={16} />
          <input ref={input} type="search" value={q} onInput={(e) => setQ(e.currentTarget.value)} placeholder={t('Search people and casts')} aria-label={t('Search')} />
        </div>
        <Tabs tabs={[['people', t('People')], ['casts', t('Casts')], ['channels', t('Channels')]]} value={tab} set={setTab} />
      </Header>
      {!term && tab !== 'channels' && <div class="note">{t('Find people by name or username, or search the text of casts.')}</div>}
      {tab === 'channels' && <ChannelList q={term} />}
      {!term && tab === 'people' && <Customized />}
      {term && tab === 'people' && (people === null ? <div class="spinner" /> : people.length ? people.map((u) => <UserRow u={u} />) : <div class="note">{t('No one matches “{term}”.', { term })}</div>)}
      {term && tab === 'casts' && <Feed k={`s${term}`} empty={t('No casts match “{term}”.', { term })} load={(cursor) => get('/v2/farcaster/cast/search', { q: term, limit: 25, cursor, ...(hasTag(term) && { sort_type: 'desc_chronological' }) }).then((r) => r.result || r)} />}
    </>
  )
}

// a channel's picture where a profile picture would be
const face = (c: Channel) => ({ fid: 0, pfp_url: c.image, display_name: c.name }) as User
const ChannelRow = ({ c }: { c: Channel }) => (
  <a class="row" href={`/channel/${c.id}`}>
    <Avatar u={face(c)} link={false} />
    <span class="row-main">
      <span class="row-top"><b>{c.name}</b><span class="handle">/{c.id}{!c.open && ' 🔒'}</span></span>
      {c.desc && <span class="row-sub">{c.desc}</span>}
    </span>
    <span class="row-meta">{n(c.followers)}<small>{tn(c.followers, 'follower', 'followers')}</small></span>
  </a>
)

/** The top channels by followers, or the ones matching `q`, from farcaster.xyz's directory (server/channels.mjs). */
function ChannelList({ q }: { q: string }) {
  const [list, setList] = useState<Channel[] | null>(null)
  useEffect(() => (setList(null), void findChannels(q, 50).then(setList)), [q])
  if (!list) return <div class="spinner" />
  if (!list.length) return <div class="note">{q ? t('No channels match “{term}”.', { term: q }) : t('The channel list couldn\'t be loaded. Try again in a bit.')}</div>
  return <>{list.map((c) => <ChannelRow c={c} />)}</>
}

function Channels() {
  const [q, setQ] = useState('')
  const [term, setTerm] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setTerm(q.trim()), 300)
    return () => clearTimeout(t)
  }, [q])
  return (
    <>
      <Header title={t('Channels')}>
        <div class="searchbox">
          <Icon d={P.search} size={16} />
          <input type="search" value={q} onInput={(e) => setQ(e.currentTarget.value)} placeholder={t('Search channels')} aria-label={t('Search channels')} />
        </div>
      </Header>
      <ChannelList q={term} />
    </>
  )
}

/** A channel's page: farcaster.xyz's details for it and the casts under its URL, newest first. */
function ChannelPage({ id }: { id: string }) {
  const [c, setC] = useState<Channel | null>(null)
  const [round, reload] = useReload()
  // when the directory can't be had, the casts under the usual URL still show
  useEffect(() => void getChannel(id).then((x) => setC(x || { id, url: `https://warpcast.com/~/channel/${id}`, name: id, followers: 0, members: 0, open: true })), [id])
  const load = useMemo(() => c && ((cursor?: string, fresh?: boolean) => get('/v2/farcaster/feed/parent_urls', { parent_urls: c.url, limit: 25, cursor }, fresh)), [c, round])
  return (
    <>
      <Header title={c?.name || `/${id}`} action={<button class="icon-btn" aria-label={t('Refresh')} title={t('Refresh')} onClick={reload}><Icon d={P.refresh} /></button>} />
      {!c || !load ? <div class="spinner" /> : (
        <>
          <section class="profile channel">
            {c.header && <Img class="channel-header" src={c.header} />}
            <div class="row-top">
              <Avatar u={face(c)} size={72} link={false} />
              {account?.done && <span class="btns"><button class="btn small" onClick={() => shell.compose({ channel: c.id })}>{t('Cast here')}</button></span>}
            </div>
            <h2>{c.name}</h2>
            <div class="handle">/{c.id}{!c.open && <> <span class="pill">{t('Members only')}</span></>}</div>
            {c.desc && <RichText text={c.desc} plain />}
            {c.followers > 0 && <div class="counts"><span><b>{n(c.followers)}</b> {tn(c.followers, 'follower', 'followers')}</span><span><b>{n(c.members)}</b> {tn(c.members, 'member', 'members')}</span></div>}
          </section>
          <Feed k={`channel:${c.url}:${round}`} empty={t('No casts in this channel yet.')} load={load} live="top" />
        </>
      )}
    </>
  )
}

/** Everyone who customized their profile (src/looks.tsx), the latest saved first. */
function Customized() {
  const [list, setList] = useState<{ fid: number; amp: boolean }[] | null>(null)
  const [n, setN] = useState(30)
  const [, force] = useState(0)
  useEffect(() => void fetch('/api/looks').then((r) => r.json()).then((l) => setList(Array.isArray(l) ? l : []), () => setList([])), [])
  useEffect(() => void (list && loadUsers(list.slice(0, n).map((x) => x.fid)).then(() => force((x) => x + 1))), [list, n])
  if (!list) return <div class="spinner" />
  if (!list.length) return null
  const shown = list.slice(0, n).flatMap((x) => users.get(x.fid) || [])
  return (
    <section class="customized">
      <h2 class="apps-h">{t('Customized profiles')}</h2>
      {shown.map((u) => <UserRow u={u} />)}
      {n < list.length && <button type="button" class="btn ghost small wide" onClick={() => setN(n + 30)}>{t('Show more')}</button>}
    </section>
  )
}

const CATEGORY = (c: string) => c.replace(/-/g, ' & ').replace(/^./, (x) => x.toUpperCase())

/** The directory: categories, a search over names and taglines, and a row per app that opens it. */
function Discover() {
  const [list, setList] = useState<Listed[] | null>(null)
  const [cat, setCat] = useState('')
  const [q, setQ] = useState('')
  useDock()
  const box = useRef<HTMLInputElement>(null)
  useEffect(() => void loadListed().then(setList), [])
  useEffect(() => {
    const find = () => list && shell.findApp && ((shell.findApp = false), box.current?.focus())
    find()
    addEventListener('findapp', find)
    return () => removeEventListener('findapp', find)
  }, [list])
  if (!list) return <div class="spinner" />
  if (!list.length) return <p class="hint">{t('The directory couldn\'t be loaded. Try again in a bit.')}</p>
  const cats = [...new Set(list.flatMap((a) => a.category ?? []))]
  const term = q.trim().toLowerCase()
  const shown = list.filter((a) => (!cat || a.category === cat) && (!term || `${a.name} ${a.tagline || ''}`.toLowerCase().includes(term)))
  return (
    <>
      <div class="searchbox">
        <Icon d={P.search} size={16} />
        {/* a mini app window's search button (Quorum mode) lands here to find another app */}
        <input type="search" value={q} onInput={(e) => setQ(e.currentTarget.value)} placeholder={t('Search mini apps')} aria-label={t('Search mini apps')} ref={box} />
      </div>
      <div class="chips">
        {['', ...cats].map((c) => <button class={`chip${cat === c ? ' on' : ''}`} aria-pressed={cat === c} onClick={() => setCat(c)}>{c ? CATEGORY(c) : t('All')}</button>)}
      </div>
      {appGrid(shown.map((a) => (
        <div class="app-row listed">
          <button class="app-main" onClick={() => launchApp(a)}>
            <AppIcon src={a.icon} name={a.name} />
            <span><b>{a.name}</b><small>{a.tagline || new URL(a.url).host}</small></span>
          </button>
          {account?.done && <PinButton m={a} />}
        </div>
      )))}
      {!shown.length && <p class="hint">{t('Nothing matches.')}</p>}
      <p class="hint">{t('The top mini apps on Farcaster, as farcaster.xyz ranks them. Quilcast doesn\'t review them, so treat them like any website.')}</p>
    </>
  )
}

/** Quorum mode lays mini apps out as quorum-mobile's launcher does, a grid of cards; elsewhere they're rows. */
const appGrid = (rows: ComponentChildren[]) => (settings.quorum ? <div class="q-app-grid">{rows}</div> : rows)

/** Re-render when pins change or mini apps open and close. */
function useDock() {
  const [, force] = useState(0)
  useEffect(() => {
    const f = () => force((x) => x + 1)
    addEventListener('dock', f)
    return () => removeEventListener('dock', f)
  }, [])
}

function PinButton({ m }: { m: AppMeta }) {
  const on = isPinned(m.url)
  return <button class={`icon-btn${on ? ' on' : ''}`} aria-pressed={on} aria-label={on ? t('Unpin {app} from the dock', { app: String(m.name) }) : t('Pin {app} to the dock', { app: String(m.name) })} title={on ? t('Pinned to the dock') : t('Pin to the dock')} onClick={() => togglePin(m)}><Icon d={P.pin} fill={on} /></button>
}

/** Mini apps added from inside them (addMiniApp), their notifications, the directory, and a box to open any by its link. */
function Apps() {
  const [list, setList] = useState(() => read<AppMeta[]>('quilcast:apps', []))
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState('')
  const [push, setPush] = useState(false)
  const [pushErr, setPushErr] = useState('')
  const [, force] = useState(0)
  useDock()
  const m = () => import('./miniapp.tsx')
  useEffect(() => void appPushOn().then(setPush, () => {}), [])
  useEffect(() => {
    // a tapped push notification lands here as ?n=<id>
    const n = new URLSearchParams(location.search).get('n')
    if (!n) return
    history.replaceState(null, '', '/apps')
    appNotes().then((all) => {
      const hit = all.find((x) => x.id === n)
      hit && openNote(hit)
    })
  }, [])
  const origin = (a: AppMeta) => new URL(a.url).origin
  const on = (a: AppMeta) => !!account?.notify?.includes(origin(a))
  const run = async (key: string, f: () => Promise<unknown>) => {
    setBusy(key)
    try {
      await f()
    } catch (e: any) {
      toast(e.message)
    }
    setBusy('')
    force((x) => x + 1)
  }
  const bell = (a: AppMeta) => {
    // the browser only asks for permission from a click, so that comes first
    const asked = !on(a) && askPush()
    run(a.url, async () => {
      const x = await m()
      await x.setNotify(a, !on(a), undefined, setBusy)
      if (asked && (await asked) === 'granted') await x.enablePush().then(() => setPush(true), () => {})
    })
  }
  const remove = (a: AppMeta) =>
    run(a.url, async () => {
      if (on(a)) await (await m()).setNotify(a, false, 'miniapp_removed').catch(() => {})
      const next = read<AppMeta[]>('quilcast:apps', []).filter((x) => x.url !== a.url)
      save('quilcast:apps', next)
      setList(next)
      // Quorum mode's Apps card lists these too
      dispatchEvent(new Event('dock'))
    })
  const togglePush = async () => {
    const asked = !push && askPush()
    setBusy('push')
    setPushErr('')
    try {
      const x = await m()
      if (push) await x.disablePush(), setPush(false)
      else if ((await asked) === 'granted') await x.enablePush(), setPush(true)
      else throw new Error(t('Notifications are blocked for Quilcast in this browser. Allow them in the site settings (the icon left of the address).'))
    } catch (e: any) {
      setPushErr(e.message)
    }
    setBusy('')
  }
  const openTyped = () => url.trim() && launchUrl(/^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`)
  return (
    <>
      <Header title={t('Mini apps')} />
      <div class="settings">
        <div class="app-open">
          <input value={url} onInput={(e) => setUrl(e.currentTarget.value)} onKeyDown={(e) => e.key === 'Enter' && openTyped()} placeholder={t('Paste a mini app link')} aria-label={t('Mini app link')} inputMode="url" />
          <button class="btn small" onClick={openTyped} disabled={!url.trim()}>{t('Open')}</button>
        </div>
        {list.length > 0 && <h2 class="apps-h">{t('Your apps')}</h2>}
        {appGrid([...list].sort((a, b) => +isPinned(b.url) - +isPinned(a.url)).map((a) => (
          <div class="app-row">
            <button class="app-main" onClick={() => launchApp(a)}>
              <AppIcon src={a.icon} name={a.name} />
              <span><b>{a.name}</b><small>{busy === a.url ? t('Working…') : new URL(a.url).host}</small></span>
            </button>
            {account?.done && <button class={`icon-btn${on(a) ? ' on' : ''}`} disabled={!!busy} aria-pressed={on(a)} aria-label={t('Notifications from {app}', { app: String(a.name) })} title={on(a) ? t('Notifications on') : t('Notifications off')} onClick={() => bell(a)}><Icon d={P.bell} fill={on(a)} /></button>}
            <PinButton m={a} />
            <button class="icon-btn" disabled={!!busy} aria-label={t('Remove {app}', { app: String(a.name) })} onClick={() => remove(a)}><Icon d={P.trash} /></button>
          </div>
        )))}
        {busy && busy !== 'push' && !list.some((x) => x.url === busy) && <p class="hint">{busy}</p>}
        <h2 class="apps-h">{t('Discover')}</h2>
        <Discover />
        {account?.done && (
          <section>
            <div class="setting"><span>{t('Push notifications on this device')}</span><button class="btn ghost small" disabled={busy === 'push'} onClick={togglePush}>{busy === 'push' ? t('Working…') : push ? t('Turn off') : t('Turn on')}</button></div>
            {pushErr && <p class="hint warn">{pushErr}</p>}
            <p class="hint">{t('Turning notifications on for an app the first time adds a notification key to your account on Optimism, which costs a cent or less in gas. Apps check that key, and signing out removes it.')}</p>
          </section>
        )}
      </div>
    </>
  )
}

// iOS Safari has Web Push only for sites added to the Home Screen and opened from there
const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
const kindLabel = (k: Kind) => ({ replies: t('Replies'), mentions: t('Mentions'), quotes: t('Quotes'), likes: t('Likes'), recasts: t('Recasts'), follows: t('Follows') })[k]

/** Settings → Notifications: push notifications for each account's activity on this device, and the kinds each
 *  one gets (src/alerts.ts). */
function AlertSettings() {
  const mine = accounts.filter((a) => a.done && a.fid)
  const [on, setOn] = useState<Map<number, Kind[]> | null>(null)
  const [busy, setBusy] = useState<number | null>(null)
  useEffect(() => void (canPush() && alertsOn().then(setOn)), [])
  if (!canPush()) return <p class="hint">{ios ? t('On iPhone and iPad, add Quilcast to your Home Screen (Share, then Add to Home Screen) and open it from there to get notifications.') : t("This browser can't show notifications.")}</p>
  const run = async (a: Account, f: () => Promise<unknown>) => {
    setBusy(a.fid!)
    try {
      await f()
    } catch (e: any) {
      toast(e.message)
    }
    setOn(await alertsOn())
    setBusy(null)
  }
  const toggle = (a: Account) => {
    const turnOn = !on?.has(a.fid!)
    // the permission prompt has to come straight from the click
    const asked = turnOn && Notification.permission !== 'granted' && askPush()
    return run(a, async () => {
      if (asked && (await asked) !== 'granted') throw new Error('Notifications are blocked for Quilcast in this browser. Allow them in the site settings (the icon left of the address).')
      await setAlerts(a, turnOn)
    })
  }
  const pick = (a: Account, kinds: Kind[], k: Kind) => run(a, () => setKinds(a, KINDS.filter((x) => (x === k ? !kinds.includes(k) : kinds.includes(x)))))
  return (
    <>
      {mine.map((a) => {
        const kinds = on?.get(a.fid!)
        return (
          <div key={a.fid}>
            <div class="setting">
              <span>{t('Push notifications for @{username}', { username: a.username || String(a.fid) })}</span>
              <button class="btn ghost small" disabled={!on || busy === a.fid} onClick={() => toggle(a)}>{busy === a.fid ? t('Working…') : kinds ? t('Turn off') : t('Turn on')}</button>
            </div>
            {/* at least one kind stays on: turning the account off is the button above */}
            {kinds && KINDS.map((k) => <label class="check alert-kind" key={k}><input type="checkbox" checked={kinds.includes(k)} disabled={busy === a.fid || (kinds.length === 1 && kinds.includes(k))} onChange={() => pick(a, kinds, k)} /> {kindLabel(k)}</label>)}
          </div>
        )
      })}
      <p class="hint">{t('Replies, mentions, quotes, likes, recasts and follows reach this device even with Quilcast closed. Our server looks for them once a minute. It keeps your Farcaster ID with this browser\'s push subscription and these settings, and for a few minutes which notifications it already sent; signing out removes them. People you mute or block, muted words and spam you hide stay out.')}</p>
    </>
  )
}

/** Settings > Muted and blocked: words kept out of sight (for a while or for good), and the people muted or blocked. */
function MuteSettings() {
  const [word, setWord] = useState('')
  const [span, setSpan] = useState('')
  const [, force] = useState(0)
  const fids = [...mutes.users, ...mutes.blocks].map((x) => x.v)
  useEffect(() => void loadUsers(fids).then(() => force((x) => x + 1), () => {}), [fids.join()])
  const lift = (k: 'words' | 'users' | 'blocks', v: string | number) => setMute(k, v, false).catch((e) => toast(e.message))
  const add = (e: Event) => {
    e.preventDefault()
    setWord('')
    setMute('words', word, span ? Date.now() + Number(span) : undefined).catch((e) => toast(e.message))
  }
  const people = (k: 'users' | 'blocks', title: string) => mutes[k].length > 0 && (
    <>
      <h3>{title}</h3>
      {mutes[k].map((x) => {
        const u = users.get(x.v) || { fid: x.v }
        return (
          <div class="setting">
            <a class="mute-who" href={userPath(u)}><Avatar u={u} size={28} link={false} /><span>{nameOf(u)} <small class="muted">{untilText(x.until)}</small></span></a>
            <button class="btn ghost small" onClick={() => lift(k, x.v)}>{k === 'blocks' ? t('Unblock') : t('Unmute')}</button>
          </div>
        )
      })}
    </>
  )
  return (
    <>
      <p class="hint">{account?.done ? t('Casts with these words, or from these people, stay out of your feeds, threads and notifications. The list is kept with your account, so your other devices hide them too.') : t('Casts with these words, or from these people, stay out of your feeds and threads. Without an account, the list is kept on this device only.')}</p>
      <form class="mute-add" onSubmit={add}>
        <input value={word} onInput={(e) => setWord(e.currentTarget.value)} placeholder={t('A word, $ticker or #tag')} maxLength={60} aria-label={t('Word to mute')} />
        <select class="pick" value={span} onChange={(e) => setSpan(e.currentTarget.value)} aria-label={t('How long')}>
          {spans().map(([label, ms]) => <option value={ms ? String(ms) : ''}>{label}</option>)}
        </select>
        <button class="btn small" disabled={!word.trim()}>{t('Mute')}</button>
      </form>
      {mutes.words.length > 0 && (
        <div class="mute-words">
          {mutes.words.map((x) => <span class="chip">{x.v}{x.until && <small>{untilText(x.until)}</small>}<button type="button" aria-label={t('Unmute {word}', { word: x.v })} onClick={() => lift('words', x.v)}><Icon d={P.x} size={14} /></button></span>)}
        </div>
      )}
      {people('users', t('Muted accounts'))}
      {people('blocks', t('Blocked accounts'))}
    </>
  )
}

/** Follow, with the signed-in account, everyone this device's list holds (asked first: LocalFollowSettings and
 *  CarryFollows), then take them off the list. One already followed is skipped; a failure keeps the rest on the list. */
async function carryFollows(progress: (done: number, total: number) => void) {
  const m = await w()
  const list = localFollows()
  const done: number[] = []
  let sent = 0
  try {
    for (const l of list) {
      if (!(await isFollowing(l.fid))) await m.follow(l.fid, true), sent++
      done.push(l.fid)
      progress(done.length, list.length)
    }
  } finally {
    removeLocal(done)
    // Home's feed and the follow answers were read before these follows: read them again
    forget()
    forgetFollows()
    dispatchEvent(new Event('refresh'))
  }
  return sent
}
const carriedNote = (n: number) => void (n > 0 && toast(tn(n, 'Followed {n} account on Farcaster', 'Followed {n} accounts on Farcaster')))

/** The people followed on this device (anonymous mode, local.ts): the list, export and import, and once signed in,
 *  following them with the account. */
function LocalFollowSettings() {
  const list = useLocalFollows()
  const [, force] = useState(0)
  const [text, setText] = useState('')
  const [from, setFrom] = useState('')
  const [busy, setBusy] = useState('')
  const [out, setOut] = useState(false)
  const [clearing, setClearing] = useState(0)
  const fids = list.map((l) => l.fid)
  // armed for 5 seconds, then back to its first label
  useEffect(() => {
    if (!clearing) return
    const t = setTimeout(() => setClearing(0), 5000)
    return () => clearTimeout(t)
  }, [clearing])
  const clear = () => {
    if (!clearing) return setClearing(Date.now())
    if (Date.now() - clearing < 500) return
    removeLocal(fids)
    setClearing(0)
  }
  useEffect(() => {
    // 100 at a time, which is what the node's bulk lookup takes
    let live = true
    ;(async () => {
      for (let i = 0; i < fids.length && live; i += 100) await loadUsers(fids.slice(i, i + 100)).catch(() => {}), live && force((x) => x + 1)
    })()
    return () => void (live = false)
  }, [fids.join()])
  const run = (what: string, f: () => Promise<void>) => (setBusy(what), f().catch((e) => toast(e.message)).finally(() => setBusy('')))
  const added = (n: number, missed: string[] = []) =>
    toast(missed.length ? t('Added {n}. Not found: {names}', { n, names: missed.map((x) => `@${x}`).join(', ') }) : tn(n, 'Added {n} account', 'Added {n} accounts'))
  const notFound = (missed: string[]) => (missed.length ? ' ' + t('Not found: {names}', { names: missed.map((x) => `@${x}`).join(', ') }) : '')
  const full = (n: number, missed: string[] = []) => toast(t('Added {n}. The list on this device holds at most {max} accounts, so the feed stays quick.', { n, max: IMPORT_MAX }) + notFound(missed))
  // signed in, Settings has its own "Follow them" button: what an import adds doesn't pop up the offer too (CarryFollows)
  const seen = () => account?.done && account.fid && answered(account.fid)
  // only a 404 is "not found": a node that's down or slow fails the import, which keeps the text for another try
  const unfinished = (e: any) => {
    throw new Error(t("The import couldn't finish: {error}. Try again.", { error: e?.message || 'Network error' }))
  }
  const importText = () => run('import', async () => {
    const { follows, names } = parseImport(text)
    const now = localFollows()
    const have = new Set(now.map((l) => l.fid))
    // a name already on the list adds no one, so it isn't looked up
    const known = new Set(now.flatMap((l) => [l.username, users.get(l.fid)?.username]).filter((x): x is string => !!x).map((x) => x.toLowerCase()))
    const rest = names.filter((x) => !known.has(x))
    const found: Local[] = []
    const missed: string[] = []
    const fresh = () => new Set([...follows, ...found].map((l) => l.fid).filter((f) => !have.has(f))).size
    // only a 404 is "not found"; after any other failure the lookups still queued are skipped, and the import fails
    let failed: unknown
    const ask = pool(6)
    const lookup = (x: string) => ask(async () => {
      if (failed) return
      try {
        const u = await within(byName(x), 15000)
        found.push({ fid: u.fid, username: u.username })
      } catch (e: any) {
        if (e?.status === 404) return void missed.push(x)
        // a request that never came back would stay cached and fail the retry too (byName may have hung on either of
        // its two requests)
        if (e?.timeout) forget()
        failed ??= e
      }
    })
    // the list stops at IMPORT_MAX (addLocal): names are looked up only while there's room, a round at a time, so one
    // that turns out to be on the list already or not found leaves its place to the next
    for (let need: number; rest.length && (need = room() - fresh()) > 0; ) {
      await Promise.all(rest.splice(0, need).map(lookup))
      if (failed) unfinished(failed)
    }
    const r = addLocal([...follows, ...found])
    if (!r) return
    seen()
    if (r.cut || rest.length) full(r.n, missed)
    // nothing was added (nobody it names, or all already on the list): the text stays, to be fixed
    else if (!r.n) return void toast(t('Found no one new to add.') + notFound(missed))
    else added(r.n, missed)
    setText('')
  })
  // the accounts they follow, as many as the list still holds (and at most IMPORT_MAX): the feed asks the node about
  // each one (local.ts)
  const importFrom = () => run('from', async () => {
    // "@123" is a username of digits; "123" a FID
    const who = from.trim()
    const name = who.replace(/^@/, '')
    if (!name) throw new Error(t('No one goes by that name.'))
    const u = await within(who.startsWith('@') ? byName(name) : getUser(name), 15000).catch((e) => {
      if (e?.status === 404) throw new Error(t('No one goes by that name.'))
      if (e?.timeout) forget()
      return unfinished(e)
    })
    const have = new Set(localFollows().map((l) => l.fid))
    const got: Local[] = []
    let cursor: string | undefined
    do {
      const r = await localGet('/v2/farcaster/following', { fid: u.fid, limit: 100, cursor }).catch(unfinished)
      got.push(...((r.users || []) as User[]).map((x) => ({ fid: x.fid, username: x.username })))
      cursor = r.next?.cursor || undefined
    } while (cursor && got.filter((l) => !have.has(l.fid)).length < room())
    const r = addLocal(got)
    if (!r) return
    seen()
    if (r.cut || (cursor && !room())) full(r.n)
    // all of them already on the list (or they follow no one): the name stays
    else if (!r.n) return void toast(t('Found no one new to add.'))
    else added(r.n)
    setFrom('')
  })
  const copy = () => navigator.clipboard.writeText(exportLocal()).then(() => toast(t('Copied')), () => toast(t("Couldn't copy.")))
  const carry = () => run('carry', () => carryFollows((n, all) => setBusy(t('Following {n} of {all}…', { n, all }))).then(carriedNote))
  return (
    <>
      <p class="hint">{t('Without an account, Follow keeps people in a list on this device, and Home shows their casts. Nothing is published, and clearing this site\'s data erases the list, so export it to keep a copy or move it to another device.')}</p>
      {list.map((l) => {
        const u = users.get(l.fid) || { fid: l.fid, username: l.username }
        return (
          <div class="setting" key={l.fid}>
            <a class="mute-who" href={userPath(u)}><Avatar u={u} size={28} link={false} /><span>{nameOf(u)}</span></a>
            <button class="btn ghost small" onClick={() => setLocal(l, false)}>{t('Unfollow')}</button>
          </div>
        )
      })}
      {list.length > 0 && (
        <div class="sheet-btns">
          {/* the list is nowhere else, so clearing it takes a second tap */}
          <button class={`btn ghost small${clearing ? ' danger' : ''}`} disabled={!!busy} onClick={clear}>{clearing ? t('Tap again to clear the list') : t('Clear the list')}</button>
          {account?.done && <button class="btn small" disabled={!!busy} onClick={carry}>{busy && !['import', 'from', 'carry'].includes(busy) ? busy : t('Follow them with @{name}', { name: account.username || String(account.fid) })}</button>}
        </div>
      )}
      {list.length > 0 && <div class="sheet-btns"><button class="btn ghost small" onClick={() => setOut(!out)}>{t('Export')}</button><button class="btn ghost small" onClick={copy}>{t('Copy')}</button></div>}
      {out && <textarea class="local-export" readOnly rows={6} value={exportLocal(list)} aria-label={t('Export')} onFocus={(e) => e.currentTarget.select()} />}
      <textarea class="local-export" rows={3} value={text} onInput={(e) => setText(e.currentTarget.value)} placeholder={t('Paste an export, or FIDs and @usernames')} aria-label={t('Import')} autocapitalize="none" spellcheck={false} />
      <div class="sheet-btns"><button class="btn small" disabled={!text.trim() || !!busy} onClick={importText}>{t('Import')}</button></div>
      <form class="mute-add" onSubmit={(e) => (e.preventDefault(), from.trim() && importFrom())}>
        <input value={from} onInput={(e) => setFrom(e.currentTarget.value)} placeholder="@username" aria-label={t('Import the people @user follows')} autocapitalize="none" spellcheck={false} />
        <button class="btn small" disabled={!from.trim() || !!busy}>{t('Import their follows')}</button>
      </form>
    </>
  )
}

/** Once signed in, someone who followed people on this device is asked whether to follow them with the account, and
 *  asked again on a later sign-in once the list holds someone new (toOffer). Nothing is followed unless they say so;
 *  the list stays in Settings either way. */
function CarryFollows({ hidden }: { hidden: boolean }) {
  const list = useLocalFollows()
  const [busy, setBusy] = useState('')
  // answered for this account in this tab, even if the browser couldn't store the answer
  const [shut, setShut] = useState(0)
  const fid = account?.done ? account.fid : undefined
  if (hidden || !fid || !list.length || shut === fid || !toOffer(fid)) return null
  const close = () => (answered(fid), setShut(fid))
  const yes = () => {
    setBusy('…')
    carryFollows((d, all) => setBusy(t('Following {n} of {all}…', { n: d, all }))).then((sent) => (carriedNote(sent), close()), (e) => (toast(e.message), setBusy('')))
  }
  return (
    <div class="modal" onClick={(e) => e.target === e.currentTarget && !busy && close()}>
      <div class="sheet wallet-form" role="dialog" aria-label={t('Follow them on Farcaster?')}>
        <div class="move-top"><h2>{t('Follow them on Farcaster?')}</h2></div>
        <p class="hint">{tn(list.length, 'Before signing in, you followed {n} account on this device. Follow it with @{name} too? That publishes the follow on Farcaster.', 'Before signing in, you followed {n} accounts on this device. Follow them with @{name} too? That publishes the follows on Farcaster.', { name: account?.username || String(fid) })}</p>
        <p class="hint">{t('You can do this later in Settings.')}</p>
        <div class="sheet-btns"><button class="btn ghost" disabled={!!busy} onClick={close}>{t('Not now')}</button><button class="btn" disabled={!!busy} onClick={yes}>{busy || t('Follow them')}</button></div>
      </div>
    </div>
  )
}

// A deletion keeps going when Settings closes, so what it's doing and how it ended live here: Settings shows them again,
// and a toast tells the outcome to someone who went elsewhere.
// A finished one reloads the page (DeleteAccount), so its summary comes back once from sessionStorage.
const DELETED = 'quilcast:deleted'
const deletedSummary = () => {
  try {
    const s = sessionStorage.getItem(DELETED)
    sessionStorage.removeItem(DELETED)
    const v = s && JSON.parse(s)
    return Array.isArray(v) ? v.map(String) : null
  } catch {
    return null
  }
}
type Left = { fid: number; server: Awaited<ReturnType<typeof import('./write.ts').deleteServerData>>; fc: import('./write.ts').Erased }
const deletion: { fid?: number; busy: boolean; failed: boolean; note: string; gone: string[] | null; left?: Left | null; keys?: boolean } = { busy: false, failed: false, note: '', gone: deletedSummary() }
const setDeletion = (o: Partial<typeof deletion>) => (Object.assign(deletion, o), dispatchEvent(new Event('deletion')))
function useDeletion() {
  const [, force] = useState(0)
  useEffect(() => {
    const f = () => force((x) => x + 1)
    addEventListener('deletion', f)
    return () => removeEventListener('deletion', f)
  }, [])
  return deletion
}

/** Delete account, under Sign out: our server forgets the account, its casts, likes, recasts and follows go from
 *  Farcaster and its profile is emptied (write.ts), then it signs out like Sign out does. The Farcaster ID itself stays
 *  on Optimism, as the confirmation says. Anything that fails stops it before the keys go, so it can be run again; once
 *  only the keys are left, a new try starts there, and the keys can also just be erased from this device, like Sign
 *  out anyway. */
function DeleteAccount() {
  const d = useDeletion()
  const [ask, setAsk] = useState(false)
  const asked = useRef(0)
  const a = account!
  const busy = d.busy && d.fid === a.fid
  const failed = d.failed && d.fid === a.fid
  const doing = { find: (_d: number, _n: number) => t('Looking up your casts, likes and follows…'), casts: (d: number, n: number) => t('Removing casts: {done} of {total}', { done: d, total: n }), reactions: (d: number, n: number) => t('Removing likes and recasts: {done} of {total}', { done: d, total: n }), follows: (d: number, n: number) => t('Removing follows: {done} of {total}', { done: d, total: n }), profile: (d: number, n: number) => t('Emptying your profile: {done} of {total}', { done: d, total: n }) }
  const away = () => location.pathname !== '/settings'
  // the data steps already done for this account (an earlier try failed at the keys), so a new try only does the keys
  const left = d.left?.fid === a.fid ? d.left : null
  // `anyway`: the keys couldn't be revoked, and the person chose to erase them from this device all the same
  const run = async (anyway = false) => {
    if (d.busy) return
    // like Sign out, the confirm sits where the button was, so it ignores clicks for a moment
    if (!ask && !failed) return (asked.current = Date.now()), setAsk(true)
    if (Date.now() - asked.current < 1000) return
    setAsk(false)
    setDeletion({ fid: a.fid, busy: true, failed: false, note: t("Deleting what Quilcast's server keeps…") })
    // every step is for `a`, though another account may get selected meanwhile (Settings → Add account)
    let atKeys = false
    try {
      const m = await w()
      const erase = async () => {
        const fc = await m.eraseFarcaster((s, n, total) => setDeletion({ note: doing[s](n, total) }), undefined, a)
        if (fc.failed) throw new Error(t("{count} of your casts, likes, follows or profile fields couldn't be removed: {error}", { count: fc.failed, error: t(fc.error || '') }))
        return fc
      }
      let done = left
      if (!done) {
        const server = await m.deleteServerData(a)
        const fc = await erase()
        setDeletion({ left: (done = { fid: a.fid!, server, fc }) })
      }
      const { server, fc } = done
      if (!anyway) {
        if (left) {
          // a new try after a failure: anything cast, liked or followed since goes too
          const more = await erase()
          for (const k of ['casts', 'reactions', 'follows', 'profile'] as const) fc[k] += more[k]
        }
        // what was saved while the casts went (an upload, a draft) goes too, before the keys that could save more
        setDeletion({ note: t("Deleting what Quilcast's server keeps…") })
        const again = await m.deleteServerData(a)
        server.media += again.media
        // the first run took the account off every owner list, so these are files recorded since
        server.kept += again.kept
        setDeletion({ note: t('Removing the signing keys…') })
        atKeys = true
        // the account as it's stored now: a key replaced along the way is the one to revoke
        await m.removeAppKey(a)
        await m.revokeSigner(a)
      }
      const gone = [
        t('Casts removed: {n}', { n: fc.casts }), t('Likes and recasts removed: {n}', { n: fc.reactions }), t('Follows removed: {n}', { n: fc.follows }),
        t('Profile fields emptied: {n}', { n: fc.profile }), t('Photos and videos deleted from our server: {n}', { n: server.media }),
        ...(server.kept ? [t("{n} photos or videos you uploaded or linked were kept, because another account or a theme uses them or they were on our server before we started recording who uploaded what. Email support@borodutch.com to have them removed.", { n: server.kept })] : []),
        anyway
          ? t("Quilcast's server also deleted your profile look, mutes, drafts and kept translations. The signing keys couldn't be revoked, but this device no longer holds the account or its keys.")
          : t("Quilcast's server also deleted your profile look, mutes, drafts and kept translations, and this device no longer holds the account or its keys."),
        t('Your Farcaster ID stays registered on Optimism, along with its username and verified addresses. Other Farcaster apps may show copies of public messages for a while.'),
      ]
      // the keys are erased, then a reload drops everything the deleted account still had in memory (its feeds, likes
      // and message listeners); the summary waits for it in this tab's sessionStorage
      await removeAccount(a)
      try {
        sessionStorage.setItem(DELETED, JSON.stringify(gone))
      } catch {}
      location.assign('/settings')
    } catch (e: any) {
      asked.current = Date.now()
      // only the keys are left when the data steps are done and the keys failed (not a later data step)
      const keysLeft = atKeys && deletion.left?.fid === a.fid
      setDeletion({ busy: false, failed: true, keys: keysLeft, note: `${t(e.message)} ${keysLeft ? t("Your casts and Quilcast's data are gone; only removing the keys is left. Try again, or erase the account from this device anyway.") : t('Your keys are still here, so you can try again.')}` })
      if (away()) toast(deletion.note)
    }
  }
  return (
    <>
      <div class="setting"><span>{t('Delete account')}</span><button class="btn danger small" disabled={d.busy} onClick={() => run()}>{busy ? t('Deleting…') : ask ? t('Delete everything?') : failed ? t('Try again') : t('Delete')}</button></div>
      {failed && left && d.keys && <div class="setting"><span /><button class="btn danger small" disabled={d.busy} onClick={() => run(true)}>{t('Erase from this device anyway')}</button></div>}
      {ask && (
        <>
          <p class="hint">{t("This removes your casts, likes, recasts and follows from Farcaster, empties your profile and deletes what Quilcast's server keeps for this account (profile look, mutes, drafts, and the photos and videos only it uploaded there). Then it signs out and erases the account's keys from this device. It can't be undone.")}</p>
          <p class="hint">{a.wallet ? t('Your Farcaster ID itself stays registered on Optimism, since nobody can delete it, and your wallet still controls it.') : t('Your Farcaster ID itself stays registered on Optimism, since nobody can delete it, and whoever has the recovery phrase still controls it. Export your keys first if you want to keep it.')}</p>
          <p class="hint">{t("Its username, verified wallet addresses and GitHub name stay with it (the app that verified an address can remove it). Other Farcaster apps and indexers may keep copies of public messages, and files uploaded to Farcaster's own image service stay there.")}</p>
          <div class="actions"><button class="btn ghost small" onClick={() => setAsk(false)}>{t('Cancel')}</button></div>
        </>
      )}
      {busy && <p class="hint" role="status">{d.note} {t('Keep Quilcast open until this finishes.')}</p>}
      {failed && <p class="hint warn" role="alert">{d.note}</p>}
    </>
  )
}

function Settings() {
  const [, force] = useState(0)
  const local = useLocalFollows()
  const [prof, setProf] = useState<Record<number, string>>({})
  const [orig, setOrig] = useState<Record<number, string>>({})
  const [phrase, setPhrase] = useState(false)
  const [out, setOut] = useState<false | 'ask' | 'busy' | 'stuck'>(false)
  // what Delete account did, shown here once the account is gone, scrolled to (it starts from the Keys section)
  const { gone, busy: deleting } = useDeletion()
  const summary = useRef<HTMLElement>(null)
  useEffect(() => void (gone && summary.current?.scrollIntoView({ block: 'start' })), [gone])
  // a link to one section (/settings#follows from Home) opens there
  useEffect(() => void (location.hash && document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: 'start' })), [])
  const asked = useRef(0)
  const [forgetting, setForgetting] = useState(0)
  const [saving, setSaving] = useState(false)
  const photo = useRef<HTMLInputElement>(null)
  // theme sync (prefs.ts): turning it on signs with the account's key, and another device's settings may come in
  const [syncing, setSyncing] = useState(false)
  useEffect(() => {
    const f = () => force((x) => x + 1)
    addEventListener('prefs', f)
    return () => removeEventListener('prefs', f)
  }, [])
  const syncOn = () => {
    setSyncing(true)
    import('./prefs.ts').then((m) => m.turnOn()).then((r) => {
      settings.syncThemes = true, saveSettings()
      toast(r === 'took' ? t('Wearing the themes from your other devices') : t('Themes sync with this account'))
    }, (e) => toast(e.message)).finally(() => (setSyncing(false), force((x) => x + 1)))
  }
  useEffect(() => {
    if (!account?.fid) return
    get('/v1/userDataByFid', { fid: account.fid }).then((r) => {
      const v: Record<number, string> = {}
      for (const { data } of r.messages) {
        const k = String(data.userDataBody.type).replace('USER_DATA_TYPE_', '')
        if (Object.hasOwn(USER_DATA, k)) v[USER_DATA[k as keyof typeof USER_DATA]] = data.userDataBody.value
      }
      setProf(v)
      setOrig(v)
    }, () => {})
  }, [])
  const changed = Object.keys({ ...prof, ...orig }).map(Number).filter((k) => (prof[k] || '') !== (orig[k] || ''))
  const saveProfile = async () => {
    setSaving(true)
    try {
      const m = await w()
      for (const k of changed) await m.setUserData(k, prof[k] || '')
      setOrig(prof)
      toast('Profile saved')
    } catch (e: any) {
      toast(e.message)
    }
    setSaving(false)
  }
  const newPhoto = async (f?: File) => {
    if (!f) return
    toast('Uploading photo…')
    try {
      const url = await (await w()).upload(f)
      setProf((p) => ({ ...p, [USER_DATA.PFP]: url }))
    } catch (e: any) {
      toast(e.message)
    }
  }
  // the signer revokes itself first, so a copy of it (an export, a synced profile) stops working too
  const signOut = async () => {
    // the confirm button sits where Sign out was, so it ignores clicks for a moment (no double-click erase)
    if (!out) return (asked.current = Date.now()), setOut('ask')
    if (out === 'busy' || Date.now() - asked.current < 1000) return
    if (out === 'ask') {
      setOut('busy')
      try {
        const m = await w()
        await m.removeAppKey(account!)
        await m.revokeSigner(account!)
      } catch (e: any) {
        toast(t('The signing keys couldn\'t be revoked: {error}', { error: e.message }))
        asked.current = Date.now()
        return setOut('stuck')
      }
    }
    // the keys are erased before leaving, so nothing is left half-deleted
    await setAccount(null)
    location.assign('/')
  }
  // the signing key can't leave the browser (the vault won't give it out, and a new one is a sign-in away), so the
  // file holds what the account itself is: its recovery phrase and custody key
  // like signing out: the confirm sits where Remove was, so it ignores clicks for a moment
  const forget = async () => {
    if (!forgetting) return setForgetting(Date.now())
    if (Date.now() - forgetting < 1000) return
    await setAccount({ ...account!, phrase: '' })
    // a reload drops the copies still in memory, the derived custody key among them
    location.reload()
  }
  const exportKeys = async () => {
    const fc = await import('./fc.ts')
    const acc = account!
    const custody = await fc.custodyKey(acc.phrase)
    const data = { fid: acc.fid, username: acc.username, recoveryPhrase: acc.phrase, custodyAddress: fc.address(custody), custodyPrivateKey: '0x' + fc.hex(custody) }
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })), download: `quilcast-${acc.username || acc.fid}-keys.json` })
    a.click()
    URL.revokeObjectURL(a.href)
  }
  const field = (t: number, label: string, ph: string, area = false) => {
    const p = { value: prof[t] || '', placeholder: ph, maxLength: 256, onInput: (e: { currentTarget: { value: string } }) => setProf({ ...prof, [t]: e.currentTarget.value }) }
    return <label class="field"><span>{label}</span>{area ? <textarea rows={3} {...p} /> : <input {...p} />}</label>
  }
  const url = (k: 'node' | 'rpc', label: string) => (
    <label class="field"><span>{label}</span><input value={settings[k]} onChange={(e) => ((settings[k] = e.currentTarget.value.replace(/\/+$/, '')), saveSettings())} /></label>
  )
  return (
    <>
      <Header title={t('Settings')} />
      <div class="settings">
        {gone && (
          <section role="status" ref={summary}>
            <h2>{t('Account deleted')}</h2>
            {gone.map((line) => <p class="hint">{line}</p>)}
            <div class="actions"><button class="btn small" onClick={() => (setDeletion({ gone: null }), location.assign('/'))}>{t('Done')}</button></div>
          </section>
        )}
        {accounts.length > 0 && (
          <section>
            <h2>{t('Accounts')}</h2>
            <AccountList />
          </section>
        )}
        {account?.done && (
          <section id="wallets">
            <h2>{t('Wallets')}</h2>
            <WalletSettings />
          </section>
        )}
        {account?.done && (
          <section>
            <h2>{t('Profile')}</h2>
            <div class="photo-row">
              <Avatar u={{ fid: account.fid!, pfp_url: prof[USER_DATA.PFP], username: account.username }} size={48} link={false} />
              <button class="btn ghost small" onClick={() => photo.current?.click()}>{t('Change photo')}</button>
              <input ref={photo} type="file" accept="image/*" hidden onChange={(e) => newPhoto(e.currentTarget.files?.[0])} />
            </div>
            {field(USER_DATA.DISPLAY, t('Name'), t('Your name'))}
            {field(USER_DATA.BIO, t('Bio'), t('A line or two about you'), true)}
            {field(USER_DATA.URL, t('Website'), 'https://…')}
            {changed.length > 0 && <div class="actions"><button class="btn small" onClick={saveProfile} disabled={saving}>{saving ? t('Saving…') : t('Save changes')}</button></div>}
          </section>
        )}
        {account?.done && !app && (
          <section id="notifications">
            <h2>{t('Notifications')}</h2>
            <AlertSettings />
          </section>
        )}
        {(!account?.done || local.length > 0) && (
          <section id="follows">
            <h2>{t('Following on this device')}</h2>
            <LocalFollowSettings />
          </section>
        )}
        <section>
          <h2>{t('Muted and blocked')}</h2>
          <MuteSettings />
        </section>
        <section>
          <h2>{t('Theme')}</h2>
          <ThemeSettings />
        </section>
        <section>
          <div class="setting">
            <h2>{t('Light or dark')}</h2>
            <div class="seg">
              {[['system', t('System')], ['light', t('Light')], ['dark', t('Dark')]].map(([k, label]) => <button class={settings.theme === k ? 'on' : ''} onClick={() => ((settings.theme = k), saveSettings(), applyTheme(), themeChanged(), force((x) => x + 1))}>{label}</button>)}
            </div>
          </div>
          {theme?.base && <p class="hint">{t('Your theme picks its own; this counts when you wear none.')}</p>}
        </section>
        <section>
          <div class="setting">
            <h2>{t('Holiday themes')}</h2>
            <div class="seg">
              {[[true, t('On')], [false, t('Off')]].map(([v, label]) => <button class={(settings.holidays !== false) === v ? 'on' : ''} onClick={() => ((settings.holidays = v as boolean), saveSettings(), wear(dressed()), themeChanged(), force((x) => x + 1))}>{label}</button>)}
            </div>
          </div>
          <p class="hint">{t('Quilcast dresses up for Halloween and Christmas, unless you wear a theme of your own.')}</p>
        </section>
        {account?.done && (
          <section>
            <div class="setting">
              <h2>{t('Sync themes')}</h2>
              <div class="seg">
                {[[true, t('On')], [false, t('Off')]].map(([v, label]) => <button class={!!settings.syncThemes === v ? 'on' : ''} disabled={syncing} onClick={() => (v ? syncOn() : ((settings.syncThemes = false), saveSettings(), force((x) => x + 1)))}>{label}</button>)}
              </div>
            </div>
            <p class="hint">{t('Your theme, the themes you kept, light or dark, holiday themes and Quorum mode, the same on every device where this account syncs them. Your Farcaster key signs them, and Quilcast keeps them with your account.')}</p>
          </section>
        )}
        <section>
          <div class="setting">
            <h2>{t('Japanese mode')}</h2>
            <div class="seg">
              {[[true, t('On')], [false, t('Off')]].map(([v, label]) => <button class={!!settings.jp === v ? 'on' : ''} onClick={() => ((settings.jp = v as boolean), saveSettings(), applyTheme(), force((x) => x + 1))}>{label}</button>)}
            </div>
          </div>
          <p class="hint">{t('Dense pages, glossy buttons, a news ticker and rankings, the way Japanese websites look.')}</p>
        </section>
        <section>
          <div class="setting">
            <h2>{t('Quorum mode')}</h2>
            <div class="seg">
              {[[true, t('On')], [false, t('Off')]].map(([v, label]) => <button class={!!settings.quorum === v ? 'on' : ''} onClick={() => ((settings.quorum = v as boolean), saveSettings(), applyTheme(), dispatchEvent(new Event('quorum')), themeChanged(), force((x) => x + 1))}>{label}</button>)}
            </div>
          </div>
          <p class="hint">{t("Quilcast laid out like Quilibrium's Quorum app: its sidebar, apps on the right, and the wallet docked beside an open mini app.")}</p>
        </section>
        <section>
          <div class="setting">
            <h2>{t('Language')}</h2>
            {/* every string is picked when the page loads, so a switch reloads it */}
            <select class="pick" value={lang} onChange={(e) => ((settings.lang = e.currentTarget.value), saveSettings(), location.reload())}>
              {Object.entries(LANGS).map(([k, name]) => <option value={k}>{name}</option>)}
            </select>
          </div>
        </section>
        <section>
          <div class="setting">
            <h2>{t('Profile looks')}</h2>
            <div class="seg">
              {[[true, t('Show')], [false, t('Hide')]].map(([v, label]) => <button class={(settings.looks !== false) === v ? 'on' : ''} onClick={() => ((settings.looks = v as boolean), saveSettings(), force((x) => x + 1))}>{label}</button>)}
            </div>
          </div>
          <p class="hint">{t('Backgrounds, colors, songs and GIFs people add to their profile pages.')}{account?.done && myUser() && <> <a href={`${userPath(myUser()!)}?customize`}>{t('Customize yours')}</a></>}</p>
        </section>
        <section>
          <div class="setting">
            <h2>{t('Spam')}</h2>
            <div class="seg">
              {(['show', 'hide'] as const).map((v) => <button class={(settings.spam || 'show') === v ? 'on' : ''} onClick={() => ((settings.spam = v), saveSettings(), spamChanged(), force((x) => x + 1))}>{v === 'show' ? t('Show') : t('Hide')}</button>)}
            </div>
          </div>
          <div class="lk-row"><span>{t('Spam accounts')}</span>
            <div class="seg">
              {(['show', 'hide'] as const).map((v) => <button class={(settings.spamAccounts || 'show') === v ? 'on' : ''} onClick={() => ((settings.spamAccounts = v), saveSettings(), spamChanged(), force((x) => x + 1))}>{v === 'show' ? t('Show') : t('Hide')}</button>)}
            </div>
          </div>
          <label class="lk-row"><span>{t('Spam threshold')}</span><span class="lk-ctl"><input type="range" min={50} max={99} value={spamAt()} onInput={(e) => ((settings.spamAt = Number(e.currentTarget.value)), saveSettings(), spamChanged(), force((x) => x + 1))} /><output>{spamAt()}%</output></span></label>
          <p class="hint">{t('Casts at least this likely to be spam get a label with the odds, or are hidden. Our own Laya model reads every new cast.')} {t('Accounts are judged from their profile and recent casts; hiding a spam account takes its casts and replies out everywhere.')}</p>
        </section>
        {account && (
          <section>
            <h2>{t('Keys')}</h2>
            {account.wallet ? (
              <>
                <p class="hint"><With s={t('This account belongs to the wallet {wallet}, which keeps its own keys. Quilcast only holds a signing key for this browser.')} k="wallet"><code>{account.wallet}</code></With></p>
                {viaWalletConnect(account.wallet) && <div class="setting"><span>WalletConnect</span><button class="btn ghost small" onClick={() => askUser.pair(account!.wallet!).then(() => toast('Wallet connected'), (e) => e?.code !== 4001 && toast(e.message))}>{t('Reconnect')}</button></div>}
              </>
            ) : account.phrase ? (
              <>
                <p class="hint">{t('Your recovery phrase controls your account and also works in Quorum and Warpcast. It lives only in this browser, so keep a copy somewhere safe.')}</p>
                <div class="setting"><span>{t('Recovery phrase')}</span><span class="btns"><button class="btn ghost small" onClick={() => setPhrase(!phrase)}>{phrase ? t('Hide') : t('Show')}</button><button class="btn ghost small" onClick={() => navigator.clipboard.writeText(account!.phrase).then(() => toast('Copied'))}>{t('Copy')}</button></span></div>
                {phrase && <code class="phrase">{account.phrase}</code>}
                <div class="setting"><span>{t('Kept in this browser')}</span><button class="btn ghost small" onClick={forget}>{forgetting ? t('Remove it?') : t('Remove')}</button></div>
                {forgetting > 0 && <p class="hint">{t('Quilcast then asks for it when the account itself has to sign, like adding a key for this browser or signing in to a mini app. Have it written down first.')}</p>}
              </>
            ) : (
              <>
                <p class="hint">{t("Your recovery phrase isn't kept in this browser. Quilcast asks for it when the account itself has to sign, like adding a key for this browser or signing in to a mini app.")}</p>
                <div class="setting"><span>{t('Recovery phrase')}</span><button class="btn ghost small" onClick={() => askUser.phrase(account!, true).then(() => force((x) => x + 1))}>{t('Keep it here')}</button></div>
              </>
            )}
            {account.phrase && <div class="setting"><span>{t('All keys as a file')}</span><button class="btn ghost small" onClick={exportKeys}>{t('Export')}</button></div>}
            {account.dm && <div class="setting"><span>{t('Key to your messages on farcaster.xyz')}</span><button class="btn ghost small" onClick={() => (setAccount({ ...account!, dm: undefined }), import('./dms.ts').then((m) => m.stop()))}>{t('Forget')}</button></div>}
            <div class="setting"><span>{account.username ? t('Sign out of @{username}', { username: account.username }) : t('Sign out')}</span><button class="btn danger small" disabled={out === 'busy' || deleting} onClick={signOut}>{out === 'busy' ? t('Signing out…') : out === 'stuck' ? t('Sign out anyway') : out ? t('Erase keys?') : t('Sign out')}</button></div>
            {out && <p class="hint">{account.wallet ? t('This removes the account and its signing key from this browser. Your wallet is not affected.') : t('This erases the recovery phrase from this browser. Export your keys first if it\'s your only copy.')}</p>}
            {account.done && <DeleteAccount key={idOf(account)} />}
          </section>
        )}
        <section>
          <h2>{t('Network')}</h2>
          {url('node', t('Hypersnap node'))}
          {url('rpc', t('Optimism RPC'))}
        </section>
        <p class="foot">Quilcast <Version /> · <a href={feedback}>{t('Send feedback')}</a></p>
      </div>
    </>
  )
}

// --- shell ---

function applyTheme() {
  const d = document.documentElement.dataset
  // light or dark and everything else a theme sets (ui.tsx wear)
  wear(worn)
  // Japanese mode is all CSS under :root[data-jp]; Quorum mode is CSS under :root[data-quorum] and its own shell (App)
  settings.jp ? (d.jp = '') : delete d.jp
  settings.quorum ? (d.quorum = '') : delete d.quorum
}

addEventListener('click', follow)

// at most once every 30 s, so whatever made it reload can't loop
const reloadOnce = () => {
  const k = 'quilcast:reloaded'
  if (Date.now() - Number(sessionStorage.getItem(k) || 0) < 30e3) return
  sessionStorage.setItem(k, String(Date.now()))
  location.reload()
}
// a deploy replaces the lazy chunks (mini apps, messages, looks…), so a tab opened before it can't load them: reload
// into the new build
addEventListener('vite:preloadError', reloadOnce)
// iOS kills WebKit's storage process under apps left in the background, home screen apps above all. The page lives on
// but its IndexedDB doesn't, not even a new connection ("Connection to Indexed Database server lost. Refresh the
// page"), so the vault's keys and secrets look gone: coming back to a page whose vault stopped answering reloads it
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && vaultOpened) kv('readonly', (s) => s.count()).catch(reloadOnce)
})
// a theme picked on another device shows up when this one comes back (prefs.ts)
document.addEventListener('visibilitychange', () => void (document.visibilityState === 'visible' && settings.syncThemes && import('./prefs.ts').then((m) => m.pull())))

// Back and Forward put the page where it was (#502): the app scrolls, not the browser, which would try before the page
// has drawn its lists
if ('scrollRestoration' in history) history.scrollRestoration = 'manual'
// each history entry has an id in its state, so what's kept for it (restore.ts) is that visit's, not another visit's
// to the same address. A new address is a new entry; one pushed at the same address (the image viewer's, ui.tsx) is
// still the same page, and a replaceState (a search's words, the viewer's picture) keeps the entry's id.
const ENTRY = 'quilcast:entry'
const idIn = (s: unknown) => (s && typeof s === 'object' ? ((s as Record<string, unknown>)[ENTRY] as string | undefined) : undefined)
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
const tagged = (s: unknown, id: string) => (s == null || typeof s === 'object' ? { ...(s as object), [ENTRY]: id } : s)
const push = history.pushState.bind(history)
const replace = history.replaceState.bind(history)
history.pushState = (s, u, url) => push(tagged(s, (url == null && idIn(history.state)) || newId()), u, url)
history.replaceState = (s, u, url) => replace(tagged(s, idIn(history.state) || newId()), u, url)
if (!idIn(history.state)) history.replaceState(history.state, '')
start(idIn(history.state) || '')

// a page reached by Back or Forward scrolls back to where it was, as soon as it's tall enough: at once when its lists
// were kept (restore.ts), or within 3 s while they load. A list that loads afresh instead (or a page that waits for
// one past those 3 s) starts at the top. Until those 3 s are up it keeps the spot while things above it draw late
// (a profile's look), which would push the posts down. Scrolling, a tap or a key first leaves it where it is.
let restoring: (() => void) | null = null
// still on its way to the spot: until then, where the page is scrolled isn't a spot to keep
let pending = false
const INPUTS = ['wheel', 'touchstart', 'pointerdown', 'keydown']
function scrollBack(y: number, ms = 3000) {
  restoring?.()
  scrollTo(0, 0)
  if (!y) return
  pending = true
  const end = Date.now() + ms
  let frame = 0
  let height = -1
  let reached = false
  const stop = () => (cancelAnimationFrame(frame), INPUTS.forEach((ev) => removeEventListener(ev, stop, true)), restoring === stop && ((restoring = null), (pending = false)))
  const step = () => {
    const h = document.documentElement.scrollHeight
    const to = Math.min(y, Math.max(0, h - innerHeight))
    if (placeKept()) {
      // moved while nothing on the page did: the scroll bar, dragged (which sends none of INPUTS)
      if (reached && h === height && Math.abs(scrollY - to) > 1) return stop()
      scrollTo(0, to)
      reached ||= to === y
      if (reached && restoring === stop) pending = false
    }
    height = h
    if (Date.now() > end) stop()
    else frame = requestAnimationFrame(step)
  }
  INPUTS.forEach((ev) => addEventListener(ev, stop, { capture: true, passive: true }))
  restoring = stop
  frame = requestAnimationFrame(step)
}

// a reload, or a Back from another site that loads the page again, has nothing kept in memory: the spots are kept in
// this tab's sessionStorage when the page is hidden, and the page goes back to its spot within what it draws
const SPOTS = 'quilcast:spots'
const keepSpots = () => {
  if (!pending) keepSpot(entry(), scrollY)
  try {
    sessionStorage.setItem(SPOTS, JSON.stringify(allSpots()))
  } catch {}
}
addEventListener('pagehide', keepSpots)
document.addEventListener('visibilitychange', () => void (document.visibilityState === 'hidden' && keepSpots()))
try {
  for (const [id, y] of JSON.parse(sessionStorage.getItem(SPOTS) || '[]') as [string, number][]) keepSpot(id, y)
} catch {}
if (spotOf(entry())) scrollBack(spotOf(entry()), 5000)

const useRoute = () => {
  const [p, setP] = useState(location.pathname)
  useEffect(() => {
    const f = (e: Event) => {
      // go() (api.ts) sends a popstate of its own for a link; the browser's is Back or Forward. (The image viewer's
      // entries stop theirs before this, ui.tsx.)
      const pop = e.isTrusted
      // (an entry the browser added itself, for a #fragment, gets an id too)
      if (!idIn(history.state)) history.replaceState(history.state, '')
      const to = idIn(history.state) || ''
      if (pop && to === entry()) return
      // the page being left is still on screen: where it's scrolled to and its lists are what Back finds, unless it
      // was still on its way back to its spot
      if (!pending) keepSpot(entry(), scrollY)
      navigated(to, pop)
      setP(location.pathname)
      pop ? scrollBack(spotOf(to)) : (restoring?.(), scrollTo(0, 0))
    }
    addEventListener('popstate', f)
    return () => removeEventListener('popstate', f)
  }, [])
  return p.slice(1).split('/')
}

const decode = (s: string) => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** Pinned mini apps and the open ones: a pinned app opens on a tap, an open one shows or hides. */
function Dock() {
  useDock()
  const { apps, shown, show } = shell.dock
  const items = [...pinned().map((m) => ({ m, open: apps.find((a) => sameApp(a.url, m.url)) })), ...apps.filter((a) => !isPinned(a.url)).map((a) => ({ m: a, open: a }))]
  if (!items.length) return null
  return (
    <nav class={`dock${shown ? ' behind' : ''}`} aria-label={t('Mini apps dock')}>
      {/* the one on screen scrolls into view when there are more than fit */}
      {items.map(({ m, open }) => {
        // a sleeping app (miniapp.tsx unloaded its frame) says so; a tap loads it again
        const name = m.name || new URL(m.url).host
        const label = open?.asleep ? t('{app} (asleep)', { app: name }) : name
        return (
          <button class={`${open ? 'open' : ''}${open?.asleep ? ' asleep' : ''}${open && shown === open.id ? ' on' : ''}`} ref={(el) => void (el && open && shown === open.id && el.scrollIntoView({ block: 'nearest', inline: 'nearest' }))}
            aria-label={label} title={open?.asleep ? label : m.name} onClick={() => (open ? show(open.id) : launchApp(m))}><AppIcon src={m.icon} name={m.name} /></button>
        )
      })}
    </nav>
  )
}

// the phone tab bar's own tabs when signed in (the rest go under ⋮)
const MAIN_TABS = ['', 'search', 'notifications', 'messages', 'u']

function App() {
  const [, force] = useState(0)
  const [compose, setCompose] = useState<Parameters<typeof shell.compose>[0] | null>(null)
  const [r0, r1, r2] = useRoute()
  const unread = useUnread()
  // Quorum mode's ⋮ row on phones, folded again on every page change
  const [more, setMore] = useState(false)
  useEffect(() => setMore(false), [r0, r1])
  // and on Escape or a tap anywhere outside the bar
  useEffect(() => {
    if (!more) return
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setMore(false)
    const tap = (e: PointerEvent) => !(e.target as Element).closest?.('.tabbar') && setMore(false)
    addEventListener('keydown', key)
    addEventListener('pointerdown', tap)
    return () => (removeEventListener('keydown', key), removeEventListener('pointerdown', tap))
  }, [more])
  // a mini app can't replace a draft that's already open
  const composing = useRef(false)
  composing.current = !!compose
  shell.compose = (o = {}) => (o.onDone && composing.current ? o.onDone(null) : setCompose(o))
  // the theme editor sits over the whole app, so every page can be seen in the draft
  const [editing, setEditing] = useState<{ start: Theme | null } | null>(null)
  shell.editTheme = (th) => setEditing({ start: th === undefined ? theme : th })
  useEffect(() => {
    const f = () => force((x) => x + 1)
    addEventListener('account', f)
    addEventListener('mutes', f)
    addEventListener('quorum', f)
    // the old-style channel URLs (channels.ts legacy) arrived, so casts can say their channel
    addEventListener('channels', f)
    return () => (removeEventListener('account', f), removeEventListener('mutes', f), removeEventListener('quorum', f), removeEventListener('channels', f))
  }, [])
  // a tapped push notification (public/sw.js) opens its page here, in this window, as the account it was for
  useEffect(() => {
    const f = (e: MessageEvent) => {
      // asked whether the app is here: yes, unless the service worker stopped waiting
      if (e.data?.probe) return void (Date.now() <= e.data.until && e.ports[0]?.postMessage(1))
      const path = e.data?.open
      if (typeof path !== 'string' || !/^\/(?!\/)/.test(path)) return
      const as = accounts.find((a) => a.done && a.fid === e.data.fid)
      if (as && account?.fid !== as.fid) return localStorage.setItem('quilcast:current', idOf(as)), location.assign(path)
      go(path)
    }
    navigator.serviceWorker?.addEventListener('message', f)
    return () => navigator.serviceWorker?.removeEventListener('message', f)
  }, [])
  // a failed scheduled cast's push (server/scheduled.mjs) opens /?scheduled: the composer with the account's list
  useEffect(() => {
    const f = () => {
      if (!account?.done || !new URLSearchParams(location.search).has('scheduled')) return
      history.replaceState(null, '', location.pathname)
      setCompose({ scheduled: true })
    }
    f()
    addEventListener('popstate', f)
    return () => removeEventListener('popstate', f)
  }, [account?.fid])
  // a scheduled cast that failed since this browser last looked is told about once, also without push notifications
  useEffect(() => {
    if (!account?.done) return
    const timer = setTimeout(() => w().then((m) => m.failedScheduled()).then((l) => l.length && toast("A scheduled cast couldn't be posted. Open the composer's Scheduled list to see why."), () => {}), 4000)
    return () => clearTimeout(timer)
  }, [account?.fid])
  // accounts that opened messages listen for them from the start (dms.ts loads only for them)
  useEffect(() => void (account?.dm && import('./dms.ts').then((m) => m.start())), [account?.dm])
  useEffect(() => {
    const f = () => force((x) => x + 1)
    loadMine().then(f)
    account?.fid && getUser(account.fid).then(f, () => {})
    syncMutes()
    refreshAlerts().catch(() => {})
    settings.syncThemes && import('./prefs.ts').then((m) => m.pull())
  }, [account?.fid])
  const me = account?.done ? myUser() : null
  shell.me = () => me && <HeaderMe me={me} />
  const view =
    r0 === 'c' ? (Object.hasOwn(WHO, r2) ? <Who hash={r1} kind={r2 as keyof typeof WHO} /> : <Thread hash={r1} />)
      : r0 === 'u' ? (Object.hasOwn(FOLLOWS, r2) ? <Follows id={decode(r1)} kind={r2 as keyof typeof FOLLOWS} /> : <Profile id={decode(r1)} />)
        : r0 === 'search' ? <Search />
          : r0 === 'channel' ? (r1 ? <ChannelPage id={decode(r1).toLowerCase()} /> : <Channels />)
          : r0 === 'notifications' ? <Notifications />
          : r0 === 'messages' ? <Messages id={r1 && decode(r1)} />
          : r0 === 'settings' ? <Settings />
          : r0 === 'write' ? (me ? <ArticleEditor /> : <Join />)
          : r0 === 'apps' ? <Apps />
          : r0 === 'wallet' ? (me ? <WalletPage /> : <Join />)
          : r0 === 'spaces' ? (r1 && me ? <SpaceRoom id={decode(r1)} /> : me ? <Spaces /> : <Join />)
          : r0 === 'design' ? <><Header title={t('Profile design')} /><div class="design-page"><DesignCard id={r1} /></div></>
          : r0 === 'theme' ? <><Header title={t('Theme')} /><div class="design-page"><ThemeCard id={r1} big /></div></>
            : r0 === 'join' ? <><Header /><Join step={r1} /></>
              : <Home />
  const nav: [string, string, string][] = [['', t('Home'), P.home], ['search', t('Search'), P.search], ['channel', t('Channels'), P.hash], ...(me ? [['notifications', t('Notifications'), P.bell], ['messages', t('Messages'), P.mail], ['apps', t('Mini apps'), P.apps], ['spaces', t('Spaces'), P.mic], ['write', t('Articles'), P.article]] as [string, string, string][] : []), me ? ['u', t('Profile'), P.user] : ['join', t('Join'), P.user], ['settings', t('Settings'), P.gear], ...(me ? [['wallet', t('Wallet'), P.wallet]] as [string, string, string][] : [])]
  const href = (k: string) => (k === 'u' ? userPath(me!) : `/${k}`)
  const active = (k: string) => (k === 'u' ? r0 === 'u' && !!me && userPath(me) === `/u/${r1}` : r0 === k)
  const ico = (k: string, d: string) => <span class="ico"><Icon d={d} size={22} />{unread[k as keyof typeof unread] && <i class="badge" />}</span>
  const quorum = !!settings.quorum
  const wallet = useWalletOpen() && quorum && !!me
  if (quorum) {
    // Quorum's sidebar, in its order, with Quilcast's closest page for each. Governance, Saved posts and Status have
    // none here, so they're left out; Spaces are Quilcast's audio rooms. Profile is in the user card, and Wallet opens
    // the docked panel instead of a page.
    nav.splice(0, nav.length, ['', t('Home'), P.home], ['search', t('Explore'), P.explore], ['channel', t('Channels'), P.hash], ...(me ? [['notifications', t('Notifications'), P.bell], ['messages', t('Messages'), P.mail], ['spaces', t('Spaces'), P.mic], ['apps', t('Apps'), P.apps], ['write', t('Articles'), P.article], ['wallet', t('Wallet'), P.wallet]] as [string, string, string][] : []), ...(me ? [] : [['join', t('Join'), P.user]] as [string, string, string][]))
  }
  const toggleWallet = (e: Event) => (e.preventDefault(), setWalletOpen(!wallet))
  const navProps = (k: string) => (quorum && k === 'wallet' ? { href: '/wallet', onClick: toggleWallet, 'aria-expanded': wallet } : { href: href(k) })
  const on = (k: string) => (quorum && k === 'wallet' ? wallet : active(k))
  // a tab in Quorum mode's phone bar (the ones in its ⋮ row carry their name under the icon)
  const tab = (k: string, label: string, d: string, named?: boolean) => {
    const p = navProps(k)
    return <a class={on(k) ? 'on' : ''} {...p} aria-label={named ? undefined : label} onClick={(e) => (setMore(false), p.onClick?.(e))}>{ico(k, d)}{named && <small>{label}</small>}</a>
  }
  const setMode = (mode: 'light' | 'dark') => ((settings.theme = mode), saveSettings(), applyTheme(), themeChanged(), force((x) => x + 1))
  return (
    <>
    {/* outside .app, so a theme's size (zoom) leaves its background and stickers alone */}
    <ThemeLayers stickers={!editing} />
    {editing && <ThemeEditor start={editing.start} close={() => setEditing(null)} />}
    <div class="app">
      {quorum ? (
        <nav class="side q-side" aria-label={t('Main')}>
          <a class="brand" href="/"><Logo size={28} /><span>Quilcast</span></a>
          {nav.filter(([k]) => k !== 'join').map(([k, label, d]) => <a class={`navlink${on(k) ? ' on' : ''}`} {...navProps(k)}>{ico(k, d)}<span>{label}</span></a>)}
          {me ? <button class="btn cast-btn" onClick={() => setCompose({})}><Icon d={P.plus} /><span>{t('Create a post')}</span></button> : <a class="btn cast-btn" href="/join" aria-label={t('Join')}><Icon d={P.user} /><span>{t('Join')}</span></a>}
          <div class="q-bottom">
            <a class={`navlink${active('settings') ? ' on' : ''}`} href="/settings">{ico('settings', P.gear)}<span>{t('Settings')}</span></a>
            <LightDark set={setMode} />
            {me && <AccountMenu me={me} quorum />}
          </div>
        </nav>
      ) : (
        <nav class="side" aria-label={t('Main')}>
          <a class="brand" href="/"><Logo size={30} /><span>Quilcast</span></a>
          {nav.filter(([k]) => k !== 'join').map(([k, label, d]) => <a class={`navlink${active(k) ? ' on' : ''}`} href={href(k)}>{ico(k, d)}<span>{label}</span></a>)}
          {me ? <button class="btn cast-btn" onClick={() => setCompose({})}><Icon d={P.pen} /><span>{t('Cast')}</span></button> : <a class="btn cast-btn" href="/join" aria-label={t('Join')}><Icon d={P.user} /><span>{t('Join')}</span></a>}
          {me && <AccountMenu me={me} />}
        </nav>
      )}
      <main class="col">{view}</main>
      {/* Quorum's messages have no right column: the conversations and the open one take the room */}
      {quorum ? (wallet ? <WalletPanel close={() => setWalletOpen(false)} /> : r0 !== 'messages' && <QuorumAside search={r0 !== 'search'} />) : <aside class="extra">
        {r0 !== 'search' && <a class="searchbox" href="/search"><Icon d={P.search} size={16} /><span>{t('Search people and casts')}</span></a>}
        <div class="about">
          <b>{t('About Quilcast')}</b>
          <p>{t('A small, open Farcaster client that reads from and posts to Quilibrium\'s Hypersnap network, with your keys kept in your browser.')}</p>
          <p class="foot"><Version /></p>
          <p class="foot ogre-only"><a href="/shrek/credits.html" target="_blank">{t('Shrek credits')}</a></p>
        </div>
      </aside>}
      {quorum ? (
        // quorum-mobile's AppTabBar: your face, Messages, Spaces, the feed and Notifications, and ⋮ for a second row
        // with the rest
        <nav class="tabbar q-tabbar" aria-label={t('Main')}>
          <div class="q-tab-row">
            {me ? <a class={`q-tab-me${active('u') ? ' on' : ''}`} href={href('u')} aria-label={t('Profile')} onClick={() => setMore(false)}><Avatar u={me} size={32} link={false} /></a> : tab('join', t('Join'), P.user)}
            {(me ? ['messages', 'spaces', '', 'notifications'] : ['', 'search']).map((k) => {
              const [, label, d] = nav.find((x) => x[0] === k)!
              return tab(k, label, d)
            })}
            <button class={more ? 'on' : ''} aria-label={t('More')} aria-expanded={more} aria-controls={more ? 'q-more' : undefined} onClick={() => setMore(!more)}><Icon d={P.vmore} size={24} /></button>
          </div>
          {more && (
            <div class="q-tab-more" id="q-more">
              {[...nav.filter(([k]) => ['wallet', 'search', 'channel', 'apps', 'write'].includes(k) && !(!me && k === 'search')), ['settings', t('Settings'), P.gear] as [string, string, string]].map(([k, label, d]) => tab(k, label, d, true))}
            </div>
          )}
        </nav>
      ) : (
        // five tabs fit a phone; signed in, the rest are under ⋮
        <nav class="tabbar" aria-label={t('Main')}>
          {(me ? nav.filter(([k]) => MAIN_TABS.includes(k)) : nav).map(([k, label, d]) => <a class={on(k) ? 'on' : ''} {...navProps(k)} aria-label={label}>{ico(k, d)}</a>)}
          {me && (
            <span class="tab-more">
              <button class={nav.some(([k]) => !MAIN_TABS.includes(k) && on(k)) ? 'on' : ''} aria-label={t('More')} aria-haspopup="menu" aria-expanded={more} onClick={() => setMore(!more)}><span class="ico"><Icon d={P.vmore} size={22} /></span></button>
              {more && (
                <div class="menu up right" role="menu">
                  {nav.filter(([k]) => !MAIN_TABS.includes(k)).map(([k, label, d]) => <a role="menuitem" class={on(k) ? 'on' : ''} {...navProps(k)} onClick={() => setMore(false)}>{ico(k, d)}{label}</a>)}
                </div>
              )}
            </span>
          )}
        </nav>
      )}
      {/* not over the ⋮ menu */}
      {me && !more && !['join', 'settings', 'messages'].includes(r0) && <button class="fab" aria-label={t('New cast')} onClick={() => setCompose({})}><Icon d={quorum ? P.plus : P.pen} size={22} /></button>}
      {me && <Dock />}
      {compose && <Composer {...compose} onClose={() => setCompose(null)} />}
      <Viewer />
      <PhraseAsk />
      <PairAsk />
      <CarryFollows hidden={r0 === 'join'} />
      <ReportSheet />
      <LinkSheet />
      <Toast />
    </div>
    </>
  )
}

applyTheme()
loadLang().then(async () => {
  // index.html's head script starts the app once the page is parsed, but whatever else starts it early mustn't find
  // the page without its #app yet
  if (document.readyState === 'loading') await new Promise((ok) => document.addEventListener('DOMContentLoaded', ok, { once: true }))
  const root = document.getElementById('app')!
  // the server's page shows its first picture (server/home.mjs) before the app draws it again, so a phone's largest
  // paint doesn't wait for the app. The browser counts a picture as painted a frame or two after drawing it, and not
  // at all if it's gone by then, so the app waits for that (or 200 ms where the browser doesn't say). A browser with its
  // own account never shows that page (index.html data-own), nor loads the picture, so it doesn't wait
  const lead = !document.documentElement.hasAttribute('data-own') && root.querySelector<HTMLImageElement>('img[fetchpriority="high"]')
  if (lead) await new Promise((ok) => {
    setTimeout(ok, 3000)
    const shown = () => {
      setTimeout(ok, 200)
      try {
        new PerformanceObserver((l, o) => l.getEntries().some((e) => (e as PerformanceEntry & { element?: Element }).element === lead) && (o.disconnect(), ok(0))).observe({ type: 'largest-contentful-paint', buffered: true })
      } catch {}
    }
    if (lead.complete) shown()
    else lead.addEventListener('load', shown), lead.addEventListener('error', ok)
  })
  // the home page's feed as the server drew it, so the app's first frame draws the same
  try {
    const d = JSON.parse(document.getElementById('boot')?.textContent || 'null')
    if (d) seed(d), (boot = d.casts)
  } catch {}
  // a campaign link's campaign, kept here for this browser's first sign-in (src/campaign.ts)
  try {
    keepCampaign(location.search, accounts.some((a) => a.done))
  } catch {}
  // a profile's or the home page's plain HTML from the server (server/profile.mjs, home.mjs) makes way for the app, in the same frame
  root.replaceChildren()
  // an error drawing it throws here (nothing in the app catches one), and crash.ts shows it
  render(<App />, root)
  started()
  // in a Farcaster client's frame or webview, as a mini app (src/inapp.ts)
  if (window.parent !== window || 'ReactNativeWebView' in window) import('./inapp.ts')
  // a Winamp left open (src/amp.tsx) comes back, paused, until it's closed
  try {
    if (localStorage.getItem('quilcast:amp')) import('./amp.tsx')
  } catch {}
}).catch(crashed)
