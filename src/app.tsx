import { render, type ComponentChildren } from 'preact'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { account, accounts, amFollowing, findUsers, get, getUser, go, hydrateParents, idOf, isFollowing, loadMine, loadUsers, myUser, posting, read, save, saveSettings, setAccount, settings, switchAccount, users, USER_DATA, type Cast, type User } from './api.ts'
import { Composer } from './compose.tsx'
import { OGRE_FID, ogreTap } from './ogre.ts'
import { castText, n, sized, type Look } from './shared.ts'
import { ago, AppIcon, Avatar, CastCard, DesignCard, designOf, fetchCast, handle, Header, Icon, Img, launchApp, launchUrl, Lightbox, Logo, Menu, nameOf, P, requireAccount, RichText, shell, Tabs, toast, thumbOf, urlsOf, UserRow, userPath, w, askPush, pushOn } from './ui.tsx'
import type { AppMeta } from './miniapp.tsx'
import { lang, LANGS, loadLang, t, tn } from './i18n.ts'
import './style.css'

// views most visits never open load when first needed
const lazy = <P extends object>(load: () => Promise<(p: P) => any>) => (p: P) => {
  const [C, setC] = useState<((p: any) => any) | null>(null)
  useEffect(() => void load().then((c) => setC(() => c)), [])
  return C ? <C {...p} /> : <div class="spinner" />
}
const Join = lazy<{ step?: string }>(() => import('./join.tsx').then((m) => m.Join))
const Messages = lazy<{ id?: string }>(() => import('./messages.tsx').then((m) => m.Messages))

// --- bits ---

function Toast() {
  const [m, setM] = useState('')
  const t = useRef(0)
  shell.toast = (x) => (setM(x), clearTimeout(t.current), (t.current = window.setTimeout(() => setM(''), 3500)))
  return m ? <div class="toast" role="status">{m}</div> : null
}

const Version = () => <>v{__VERSION__} · <a href="https://github.com/backmeupplz/quilcast" target="_blank" rel="noopener">{t('Source')}</a></>

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

function AccountMenu({ me }: { me: User }) {
  const [open, setOpen] = useState(false)
  return (
    <div class="me-wrap">
      {open && <Menu class="up" close={() => setOpen(false)}><AccountList onDone={() => setOpen(false)} /></Menu>}
      <button class="me" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Avatar u={me} size={34} link={false} />
        <span><b>{nameOf(me)}</b><small>@{handle(me)}</small></span>
        <Icon d={P.more} />
      </button>
    </div>
  )
}

// --- paginated list of casts ---

type Page = { casts: Cast[]; next?: { cursor?: string | null } }
type Chunk<T> = { items: T[]; cursor: string | null }

/** Cursor pagination with infinite scroll. `id` dedupes items across pages. */
function Pager<T>({ load, k, empty, id, row, initial }: { load: (cursor?: string) => Promise<Chunk<T>>; k: string; empty?: string; id: (t: T) => string; row: (items: T[]) => ComponentChildren; initial?: () => T[] }) {
  const [items, setItems] = useState<T[]>(() => initial?.() || [])
  const [cursor, setCursor] = useState<string | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const sentinel = useRef<HTMLDivElement>(null)
  const state = useRef({ busy: false, key: k })
  const more = async (reset = false) => {
    if ((state.current.busy && !reset) || (!reset && cursor === null)) return
    state.current.busy = true
    setBusy(true)
    setErr('')
    try {
      const r = await load(reset ? undefined : cursor || undefined)
      if (state.current.key !== k) return
      setItems((prev) => {
        const seen = new Set(reset ? [] : prev.map(id))
        return [...(reset ? [] : prev), ...r.items.filter((t) => !seen.has(id(t)))]
      })
      setCursor(r.cursor)
    } catch (e: any) {
      setErr(e.message)
    } finally {
      state.current.busy = false
      setBusy(false)
    }
  }
  useEffect(() => {
    state.current.key = k
    // a cached first page shows instantly and is replaced when the fresh one arrives
    setItems(initial?.() || [])
    setCursor(undefined)
    more(true)
  }, [k])
  useEffect(() => {
    // re-armed after every render, so pages that filter down to nothing keep loading
    const o = new IntersectionObserver((e) => e[0].isIntersecting && cursor && more(), { rootMargin: '800px' })
    sentinel.current && o.observe(sentinel.current)
    return () => o.disconnect()
  })
  return (
    <>
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
// the viewer's or by someone they follow; a conversation already shown above isn't shown again.
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
async function threads(casts: Cast[]) {
  const units = await Promise.all(casts.map(async (c): Promise<Cast | null> => {
    if (!c.parent_hash) return c
    const parent = await ask(() => fetchCast(c.parent_hash!))
    if (!parent) return null
    const to = parent.author.fid
    // nodes with Hypersnap PR #43 say whether the viewer follows the author; others are asked
    if (to !== account?.fid && !(parent.author.viewer_context?.following ?? (await ask(() => amFollowing(to))))) return null
    if (!parent.parent_hash) return { ...c, up: [parent], gap: false }
    // the root: straight from thread_hash (PR #43), else at most two more steps up
    let root: Cast | null = null
    let skipped = false
    if (parent.thread_hash) {
      root = await ask(() => fetchCast(parent.thread_hash!))
      skipped = !!root && parent.parent_hash !== root.hash
    } else {
      const g1 = await ask(() => fetchCast(parent.parent_hash!))
      if (g1 && !g1.parent_hash) root = g1
      else if (g1?.parent_hash) {
        const g2 = await ask(() => fetchCast(g1.parent_hash!))
        if (g2 && !g2.parent_hash) (root = g2), (skipped = true)
      }
    }
    return root ? { ...c, up: [root, parent], gap: skipped } : { ...c, up: [parent], gap: true }
  }))
  const shown = new Set<string>()
  const out: Cast[] = []
  for (const c of units) {
    // a cast already shown, or another reply to a parent already shown, would repeat that conversation
    if (!c || shown.has(c.hash) || (c.up && shown.has(c.up[c.up.length - 1].hash))) continue
    out.push(c)
    for (const p of [c, ...(c.up || [])]) shown.add(p.hash)
  }
  return out
}

function Unit({ c }: { c: Cast }) {
  if (!c.up?.length) return <CastCard c={c} />
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

// `cacheKey` keeps a feed's first page in this browser, so a reload paints it immediately
const Feed = ({ load, k, empty, keep, cacheKey, thread }: { load: (cursor?: string) => Promise<Page>; k: string; empty?: string; keep?: (c: Cast) => boolean; cacheKey?: string; thread?: boolean }) => (
  <Pager<Cast> k={k} empty={empty} id={(c) => c.hash} row={(cs) => cs.map((c) => <Unit key={c.hash} c={c} />)}
    initial={() => (cacheKey ? read<Cast[]>(`quilcast:feed:${cacheKey}`, []) : [])}
    load={async (cursor) => {
      const r = await load(cursor)
      const casts = thread ? await threads(r.casts) : keep ? r.casts.filter(keep) : r.casts
      await hydrateParents(casts)
      if (!cursor && cacheKey) {
        try {
          save(`quilcast:feed:${cacheKey}`, casts.slice(0, 20))
        } catch {}
      }
      return { items: casts, cursor: r.casts.length ? r.next?.cursor || null : null }
    }} />
)

/** Tapping the tab or nav item you're already on reloads the list from the top. */
function useReload(): [number, () => void] {
  const [round, setRound] = useState(0)
  const reload = () => (scrollTo(0, 0), setRound((r) => r + 1))
  useEffect(() => {
    addEventListener('refresh', reload)
    return () => removeEventListener('refresh', reload)
  }, [])
  return [round, reload]
}

// --- views ---

function Home() {
  const [tab, setTab] = useState<'following' | 'trending'>(account?.done ? 'following' : 'trending')
  const [round, reload] = useReload()
  return (
    <>
      <Header title={t('Home')} back={false}>
        {account?.done && <Tabs tabs={[['following', t('Following')], ['trending', t('Trending')]]} value={tab} set={(t) => (t === tab ? reload() : setTab(t))} />}
      </Header>
      {!account?.done && (
        <div class="banner">
          <div><b>{t('Farcaster without the middlemen')}</b><p>{t('Quilcast talks straight to the Hypersnap network, and your keys never leave this browser.')}</p></div>
          <a class="btn small" href="/join">{t('Join')}</a>
        </div>
      )}
      {/* replies show in Following with their conversation (threads()); Trending keeps top-level casts */}
      <Feed k={`${tab}:${round}`} cacheKey={`${account?.fid || 0}:${tab}`} empty={t('Follow a few people and their casts will show up here.')} keep={(c) => !c.parent_hash} thread={tab === 'following'}
        load={(cursor) => (tab === 'following' ? get('/v2/farcaster/feed/following', { fid: account!.fid, limit: 50, cursor }) : get('/v2/farcaster/feed/trending', { limit: 50, cursor }))} />
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
        <span class="note-avatars">{g.users.slice(0, 7).map((u) => <Avatar u={u} size={30} link={false} />)}</span>
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

// Hypersnap's notifications leave recasts out, so they're looked up for our casts that have some (one request each)
// ponytail: only our 25 newest casts are covered; recast notifications on the node would cover the rest
async function recastNotes(): Promise<Note[]> {
  const me = account!.fid
  const casts = (await get('/v2/farcaster/feed/user/casts', { fid: me, limit: 25 })).casts as Cast[]
  const lists = await Promise.all(
    casts.filter((c) => c.reactions.recasts_count > 0).map((c) =>
      get('/v2/farcaster/reactions/cast', { hash: c.hash, types: 'recasts', limit: 100 }).then(
        (r) => (r.reactions as { user: User; reaction_timestamp: string }[]).filter((x) => x.user.fid !== me).map((x): Note => ({ type: 'recasts', cast: c, user: x.user, timestamp: x.reaction_timestamp })),
        () => [],
      ),
    ),
  )
  return lists.flat()
}

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
  // one lookup per visit or reload: switching tabs reuses it
  const extra = useMemo(() => (account?.done ? recastNotes().catch(() => []) : Promise.resolve([])), [round])
  const held = useRef<Note[]>([])
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
      {tab === 'apps' ? <AppNotes key={round} /> : <Pager<Note> k={`${tab}:${round}`} empty={t('Nothing yet. When people reply, like or follow you, it shows up here.')}
        id={(n) => `${n.type}:${n.cast?.hash}:${n.user.fid}:${n.timestamp}`}
        row={(ns) => group(ns).map((g) => <NoteRow key={g.key} g={g} />)}
        load={async (cursor) => {
          const [r, qs] = await Promise.all([get('/v2/farcaster/notifications', { fid: account!.fid, limit: 50, cursor }), cursor ? held.current : extra])
          const notes = r.notifications as Note[]
          const next = notes.length ? r.next?.cursor || null : null
          // recasts slot in by time; ones older than this page wait for a later one
          const edge = next ? notes[notes.length - 1].timestamp : ''
          held.current = qs.filter((q) => q.timestamp < edge)
          const items = [...notes, ...qs.filter((q) => q.timestamp >= edge)]
            .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
            .filter((n) => n.user && (tab === 'all' || (n.cast && !ACT(n.type))))
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
      Promise.all([get('/v2/farcaster/notifications', { fid: account!.fid, limit: 1 }).catch(() => null), appNotes()]).then(([r, notes]) => {
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

/** Who follows someone, or whom they follow. */
function Follows({ id, kind }: { id: string; kind: keyof typeof FOLLOWS }) {
  const fid = useMemo(() => getUser(id).then((u) => u.fid), [id])
  return (
    <>
      <Header title={FOLLOWS[kind]()} />
      <Pager<User> k={`${id}:${kind}`} empty={t('Nobody yet.')} id={(u) => String(u.fid)} row={(us) => us.map((u) => <UserRow key={u.fid} u={u} />)}
        load={async (cursor) => {
          const r = await get(`/v2/farcaster/${kind}`, { fid: await fid, limit: 100, cursor })
          return { items: r.users, cursor: r.next?.cursor || null }
        }} />
    </>
  )
}

function Thread({ hash }: { hash: string }) {
  const [c, setC] = useState<Cast | null>(null)
  const [up, setUp] = useState<Cast[]>([])
  const [err, setErr] = useState('')
  const [quotes, setQuotes] = useState(0)
  useEffect(() => {
    let live = true
    setC(null)
    setUp([])
    setErr('')
    setQuotes(0)
    quotesOf(hash).then((q) => live && setQuotes(q.length), () => {})
    // walk up to five parents so the reply reads in context
    let walked = false
    const parents = async (cast: Cast) => {
      if (walked) return
      walked = true
      const chain: Cast[] = []
      for (let p = cast.parent_hash; p && chain.length < 5; ) {
        const pc = await fetchCast(p)
        if (!pc || !live) break
        chain.unshift(pc)
        setUp([...chain])
        p = pc.parent_hash
      }
    }
    // a cast we just posted shows right away and takes a moment to be indexed, so retry until it is
    const sent = posting.get(hash)
    if (sent) setC(sent), parents(sent)
    const load = (tries: number): unknown =>
      get('/v2/farcaster/cast/conversation', { identifier: hash.replace(/^0x/, ''), type: 'hash', reply_depth: 2 }).then(
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
          {up.map((p) => <CastCard key={p.hash} c={p} line inThread />)}
          <CastCard c={c} focus quotes={quotes} />
          <button class="reply-prompt" onClick={() => (account?.done ? shell.compose({ parent: c }) : go('/join'))}>
            {account?.done && <Avatar u={myUser()!} size={32} link={false} />}
            <span>{t('Post your reply')}</span>
          </button>
          {(c.direct_replies || []).map((r) => {
            const kids = r.direct_replies || []
            return (
              <div class="reply-group" key={r.hash}>
                <CastCard c={r} line={kids.length > 0} inThread />
                {kids[0] && <CastCard c={kids[0]} inThread />}
                {kids.length > 1 && <a class="more-replies" href={`/c/${r.hash}`}>{tn(kids.length - 1, 'Show {n} more reply', 'Show {n} more replies')}</a>}
              </div>
            )
          })}
          {!c.direct_replies?.length && <div class="note">{t('No replies yet.')}</div>}
        </>
      )}
    </>
  )
}

type Looks = typeof import('./looks.tsx')
const looksMod = () => import('./looks.tsx')

function Profile({ id }: { id: string }) {
  const [u, setU] = useState<User | null>(null)
  const [err, setErr] = useState('')
  const [tab, setTab] = useState<'casts' | 'replies'>('casts')
  const [following, setFollowing] = useState<boolean | null>(null)
  // the profile's look (src/looks.tsx), and the owner's unsaved version while they edit it
  const [L, setL] = useState<Looks | null>(null)
  const [look, setLook] = useState<Look | null>(null)
  const [draft, setDraft] = useState<Look | null>(null)
  const was = useRef(false)
  // the saved look once it has loaded, so the editor never opens on a blank one
  const loaded = useRef<Promise<Look | null>>(Promise.resolve(null))
  useEffect(() => {
    setU(null)
    setErr('')
    setTab('casts')
    setLook(null)
    setDraft(null)
    getUser(id).then((u) => (setU(u), isFollowing(u.fid).then((f) => ((was.current = f), setFollowing(f)))), () => setErr(t('No one goes by that name.')))
  }, [id])
  const self = account?.fid === u?.fid
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
      ? fetch(`/api/look/${u.fid}`).then((r) => (r.ok ? r.json() : null)).then(async (j) => j && (await looksMod()).clean(j)).catch(() => null)
      : Promise.resolve(null)
    loaded.current.then((l) => l && looksMod().then((m) => live && (setL(m), setLook(l))))
    if (!self) return () => void (live = false)
    // Settings links here with ?customize, and "Use this design" on a shared design with ?design=<id>
    const fromUrl = () => {
      const q = new URLSearchParams(location.search)
      if (q.has('customize') || q.has('design')) edit(q.get('design') || undefined), history.replaceState(null, '', location.pathname)
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
  const followers = (u?.follower_count || 0) + +!!following - +was.current
  const toggle = () => {
    if (!account?.done) return go('/join')
    const on = !following
    setFollowing(on)
    w().then((m) => m.follow(u!.fid, on)).catch((e) => (setFollowing(!on), toast(e.message)))
  }
  // the header is a box stickers can sit on, like the look's sections
  const wrapHead = (el: ComponentChildren) => (shown ? <L.At l={shown} at="head" edit={draft ? editLook : undefined}>{el}</L.At> : el)
  return (
    <>
      <div class={`look${shown ? ' on' : ''}`} style={shown ? L.vars(shown) : undefined}>
        {shown && <L.Bg l={shown} />}
        {shown && <L.Fx fx={shown.fx} />}
        <Header title={u ? nameOf(u) : t('Profile')} />
        {err && <div class="note">{err}</div>}
        {!u && !err && <div class="spinner" />}
        {u && (
          <>
            {wrapHead(<section class="profile lk-box">
              {shown && <L.Banner l={shown} />}
              <div class="row-top">
                <Avatar u={u} size={72} link={false} onClick={u.fid === OGRE_FID ? (e) => ogreTap(e.currentTarget as Element) : undefined} />
                {self ? (
                  <span class="btns">
                    <button class="btn ghost small" onClick={() => edit()} disabled={!!draft}>{t('Customize')}</button>
                    <a class="btn ghost small" href="/settings">{t('Edit profile')}</a>
                  </span>
                ) : (
                  <span class="btns">
                    {/* a 1:1 conversation's id is both FIDs, sorted (as strings, like farcaster.xyz does) */}
                    {account?.done && <a class="btn ghost small" href={`/messages/${[account.fid, u.fid].sort().join('-')}`}>{t('Message')}</a>}
                    <button class={`btn small${following ? ' ghost' : ''}`} onClick={toggle} disabled={following === null && !!account?.done}>{following ? t('Following') : t('Follow')}</button>
                  </span>
                )}
              </div>
              <h2><span class={shown ? L.nameClass(shown) : undefined}>{nameOf(u)}</span></h2>
              <div class="handle">@{handle(u)} <span class="pill">fid {u.fid}</span></div>
              {shown && <L.Mood l={shown} />}
              {u.profile?.bio?.text && <RichText text={u.profile.bio.text} />}
              <div class="counts"><a href={`${userPath(u)}/following`}><b>{n(u.following_count)}</b> {t('following')}</a><a href={`${userPath(u)}/followers`}><b>{n(followers)}</b> {tn(followers, 'follower', 'followers')}</a></div>
            </section>)}
            {shown && <L.Sections l={shown} u={u} edit={draft ? editLook : undefined} />}
            <div class="lk-box lk-feed">
              <Tabs tabs={[['casts', t('Casts')], ['replies', t('Replies')]]} value={tab} set={setTab} />
              <Feed k={`${u.fid}${tab}`} empty={tab === 'casts' ? t('No casts yet.') : t('No replies yet.')} keep={tab === 'casts' ? (c) => !c.parent_hash : (c) => !!c.parent_hash}
                load={(cursor) => get(tab === 'casts' ? '/v2/farcaster/feed/user/casts' : '/v2/farcaster/feed/user/replies_and_recasts', { fid: u.fid, limit: 25, cursor })} />
            </div>
          </>
        )}
      </div>
      {L && draft && self && (
        <L.Editor draft={draft} set={editLook} close={() => setDraft(null)} saved={(l) => (setLook(l), setDraft(null))} />
      )}
    </>
  )
}

function Search() {
  const params = new URLSearchParams(location.search)
  const [q, setQ] = useState(params.get('q') || '')
  const [tab, setTab] = useState<'people' | 'casts'>(params.get('t') === 'casts' ? 'casts' : 'people')
  const [people, setPeople] = useState<User[] | null>(null)
  const [term, setTerm] = useState(q.trim())
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => input.current?.focus(), [])
  useEffect(() => {
    const t = setTimeout(() => setTerm(q.trim()), 300)
    return () => clearTimeout(t)
  }, [q])
  useEffect(() => {
    history.replaceState(null, '', term ? `/search?${new URLSearchParams({ q: term, ...(tab === 'casts' && { t: 'casts' }) })}` : '/search')
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
        <Tabs tabs={[['people', t('People')], ['casts', t('Casts')]]} value={tab} set={setTab} />
      </Header>
      {!term && <div class="note">{t('Find people by name or username, or search the text of casts.')}</div>}
      {term && tab === 'people' && (people === null ? <div class="spinner" /> : people.length ? people.map((u) => <UserRow u={u} />) : <div class="note">{t('No one matches “{term}”.', { term })}</div>)}
      {term && tab === 'casts' && <Feed k={`s${term}`} empty={t('No casts match “{term}”.', { term })} load={(cursor) => get('/v2/farcaster/cast/search', { q: term, limit: 25, cursor }).then((r) => r.result || r)} />}
    </>
  )
}

type Listed = AppMeta & { tagline?: string; category?: string }
// farcaster.xyz's top mini apps, through our server (cached there); loaded once per visit
let listed: Promise<Listed[]> | undefined
const loadListed = () => (listed ||= fetch('/api/apps').then((r) => r.json(), () => []).then((l) => (Array.isArray(l) && l.length ? l : ((listed = undefined), []))))
const CATEGORY = (c: string) => c.replace(/-/g, ' & ').replace(/^./, (x) => x.toUpperCase())

/** The directory: categories, a search over names and taglines, and a row per app that opens it. */
function Discover() {
  const [list, setList] = useState<Listed[] | null>(null)
  const [cat, setCat] = useState('')
  const [q, setQ] = useState('')
  useEffect(() => void loadListed().then(setList), [])
  if (!list) return <div class="spinner" />
  if (!list.length) return <p class="hint">{t('The directory couldn\'t be loaded. Try again in a bit.')}</p>
  const cats = [...new Set(list.flatMap((a) => a.category ?? []))]
  const term = q.trim().toLowerCase()
  const shown = list.filter((a) => (!cat || a.category === cat) && (!term || `${a.name} ${a.tagline || ''}`.toLowerCase().includes(term)))
  return (
    <>
      <div class="searchbox">
        <Icon d={P.search} size={16} />
        <input type="search" value={q} onInput={(e) => setQ(e.currentTarget.value)} placeholder={t('Search mini apps')} aria-label={t('Search mini apps')} />
      </div>
      <div class="chips">
        {['', ...cats].map((c) => <button class={`chip${cat === c ? ' on' : ''}`} aria-pressed={cat === c} onClick={() => setCat(c)}>{c ? CATEGORY(c) : t('All')}</button>)}
      </div>
      {shown.map((a) => (
        <button class="app-row app-main listed" onClick={() => launchApp(a)}>
          <AppIcon src={a.icon} name={a.name} />
          <span><b>{a.name}</b><small>{a.tagline || new URL(a.url).host}</small></span>
        </button>
      ))}
      {!shown.length && <p class="hint">{t('Nothing matches.')}</p>}
      <p class="hint">{t('The top mini apps on Farcaster, as farcaster.xyz ranks them. Quilcast doesn\'t review them, so treat them like any website.')}</p>
    </>
  )
}

/** Mini apps added from inside them (addMiniApp), their notifications, the directory, and a box to open any by its link. */
function Apps() {
  const [list, setList] = useState(() => read<AppMeta[]>('quilcast:apps', []))
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState('')
  const [push, setPush] = useState(false)
  const [pushErr, setPushErr] = useState('')
  const [, force] = useState(0)
  const m = () => import('./miniapp.tsx')
  useEffect(() => void pushOn().then(setPush, () => {}), [])
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
        {list.map((a) => (
          <div class="app-row">
            <button class="app-main" onClick={() => launchApp(a)}>
              <AppIcon src={a.icon} name={a.name} />
              <span><b>{a.name}</b><small>{busy === a.url ? t('Working…') : new URL(a.url).host}</small></span>
            </button>
            {account?.done && <button class={`icon-btn${on(a) ? ' on' : ''}`} disabled={!!busy} aria-pressed={on(a)} aria-label={t('Notifications from {app}', { app: String(a.name) })} title={on(a) ? t('Notifications on') : t('Notifications off')} onClick={() => bell(a)}><Icon d={P.bell} fill={on(a)} /></button>}
            <button class="icon-btn" disabled={!!busy} aria-label={t('Remove {app}', { app: String(a.name) })} onClick={() => remove(a)}><Icon d={P.trash} /></button>
          </div>
        ))}
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

function Settings() {
  const [, force] = useState(0)
  const [prof, setProf] = useState<Record<number, string>>({})
  const [orig, setOrig] = useState<Record<number, string>>({})
  const [phrase, setPhrase] = useState(false)
  const [out, setOut] = useState<false | 'ask' | 'busy' | 'stuck'>(false)
  const asked = useRef(0)
  const [saving, setSaving] = useState(false)
  const photo = useRef<HTMLInputElement>(null)
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
    setAccount(null)
    location.assign('/')
  }
  const exportKeys = async () => {
    const [m, fc] = await Promise.all([w(), import('./fc.ts')])
    const acc = account!
    // a wallet account has no phrase or custody key here, only its signer
    const custody = acc.wallet ? undefined : await m.custodyKey(acc.phrase)
    const keys = custody ? { recoveryPhrase: acc.phrase, custodyAddress: fc.address(custody), custodyPrivateKey: '0x' + fc.hex(custody) } : { custodyAddress: acc.wallet }
    const data = { fid: acc.fid, username: acc.username, ...keys, signerPrivateKey: acc.signer && '0x' + acc.signer }
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
        {accounts.length > 0 && (
          <section>
            <h2>{t('Accounts')}</h2>
            <AccountList />
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
        <section>
          <div class="setting">
            <h2>{t('Theme')}</h2>
            <div class="seg">
              {[['system', t('System')], ['light', t('Light')], ['dark', t('Dark')]].map(([k, label]) => <button class={settings.theme === k ? 'on' : ''} onClick={() => ((settings.theme = k), saveSettings(), applyTheme(), force((x) => x + 1))}>{label}</button>)}
            </div>
          </div>
        </section>
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
        {account && (
          <section>
            <h2>{t('Keys')}</h2>
            {account.wallet ? (
              <p class="hint"><With s={t('This account belongs to the wallet {wallet}, which keeps its own keys. Quilcast only holds a signing key for this browser.')} k="wallet"><code>{account.wallet}</code></With></p>
            ) : (
              <>
                <p class="hint">{t('Your recovery phrase controls your account and also works in Quorum and Warpcast. It lives only in this browser, so keep a copy somewhere safe.')}</p>
                <div class="setting"><span>{t('Recovery phrase')}</span><span class="btns"><button class="btn ghost small" onClick={() => setPhrase(!phrase)}>{phrase ? t('Hide') : t('Show')}</button><button class="btn ghost small" onClick={() => navigator.clipboard.writeText(account!.phrase).then(() => toast('Copied'))}>{t('Copy')}</button></span></div>
                {phrase && <code class="phrase">{account.phrase}</code>}
              </>
            )}
            <div class="setting"><span>{account.wallet ? t('Signing key as a file') : t('All keys as a file')}</span><button class="btn ghost small" onClick={exportKeys}>{t('Export')}</button></div>
            {account.dm && <div class="setting"><span>{t('Key to your messages on farcaster.xyz')}</span><button class="btn ghost small" onClick={() => (setAccount({ ...account!, dm: undefined }), import('./dms.ts').then((m) => m.stop()))}>{t('Forget')}</button></div>}
            <div class="setting"><span>{account.username ? t('Sign out of @{username}', { username: account.username }) : t('Sign out')}</span><button class="btn danger small" disabled={out === 'busy'} onClick={signOut}>{out === 'busy' ? t('Signing out…') : out === 'stuck' ? t('Sign out anyway') : out ? t('Erase keys?') : t('Sign out')}</button></div>
            {out && <p class="hint">{account.wallet ? t('This removes the account and its signing key from this browser. Your wallet is not affected.') : t('This erases the recovery phrase from this browser. Export your keys first if it\'s your only copy.')}</p>}
          </section>
        )}
        <section>
          <h2>{t('Network')}</h2>
          {url('node', t('Hypersnap node'))}
          {url('rpc', t('Optimism RPC'))}
        </section>
        <p class="foot">Quilcast <Version /></p>
      </div>
    </>
  )
}

// --- shell ---

function applyTheme() {
  const d = document.documentElement.dataset
  settings.theme === 'system' ? delete d.theme : (d.theme = settings.theme)
  // Japanese mode is all CSS under :root[data-jp]
  settings.jp ? (d.jp = '') : delete d.jp
}

// same-origin links navigate in place instead of reloading the page
addEventListener('click', (e) => {
  const a = (e.target as Element).closest?.('a')
  if (!a || a.target || a.origin !== location.origin || e.metaKey || e.ctrlKey || e.shiftKey || e.button || e.defaultPrevented) return
  e.preventDefault()
  a.pathname + a.search !== location.pathname + location.search ? go(a.pathname + a.search) : dispatchEvent(new Event('refresh'))
})

// a deploy replaces the lazy chunks (mini apps, messages, looks…), so a tab opened before it can't load them:
// reload into the new build, at most once every 30 s so a chunk that's really missing can't loop
addEventListener('vite:preloadError', () => {
  const k = 'quilcast:reloaded'
  if (Date.now() - Number(sessionStorage.getItem(k) || 0) < 30e3) return
  sessionStorage.setItem(k, String(Date.now()))
  location.reload()
})

const useRoute = () => {
  const [p, setP] = useState(location.pathname)
  useEffect(() => {
    const f = () => (setP(location.pathname), scrollTo(0, 0))
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

function App() {
  const [, force] = useState(0)
  const [compose, setCompose] = useState<Parameters<typeof shell.compose>[0] | null>(null)
  const [r0, r1, r2] = useRoute()
  const unread = useUnread()
  const [viewer, setViewer] = useState<{ urls: string[]; index: number } | null>(null)
  // a mini app can't replace a draft that's already open
  const composing = useRef(false)
  composing.current = !!compose
  shell.compose = (o = {}) => (o.onDone && composing.current ? o.onDone(null) : setCompose(o))
  shell.view = (urls, index) => setViewer({ urls, index })
  useEffect(() => {
    const f = () => force((x) => x + 1)
    addEventListener('account', f)
    return () => removeEventListener('account', f)
  }, [])
  // accounts that opened messages listen for them from the start (dms.ts loads only for them)
  useEffect(() => void (account?.dm && import('./dms.ts').then((m) => m.start())), [account?.dm])
  useEffect(() => {
    const f = () => force((x) => x + 1)
    loadMine().then(f)
    account?.fid && getUser(account.fid).then(f, () => {})
  }, [account?.fid])
  const me = account?.done ? myUser() : null
  const view =
    r0 === 'c' ? (Object.hasOwn(WHO, r2) ? <Who hash={r1} kind={r2 as keyof typeof WHO} /> : <Thread hash={r1} />)
      : r0 === 'u' ? (Object.hasOwn(FOLLOWS, r2) ? <Follows id={decode(r1)} kind={r2 as keyof typeof FOLLOWS} /> : <Profile id={decode(r1)} />)
        : r0 === 'search' ? <Search />
          : r0 === 'notifications' ? <Notifications />
          : r0 === 'messages' ? <Messages id={r1 && decode(r1)} />
          : r0 === 'settings' ? <Settings />
          : r0 === 'apps' ? <Apps />
          : r0 === 'design' ? <><Header title={t('Profile design')} /><div class="design-page"><DesignCard id={r1} /></div></>
            : r0 === 'join' ? <><Header /><Join step={r1} /></>
              : <Home />
  const nav: [string, string, string][] = [['', t('Home'), P.home], ['search', t('Search'), P.search], ...(me ? [['notifications', t('Notifications'), P.bell], ['messages', t('Messages'), P.mail], ['apps', t('Mini apps'), P.apps]] as [string, string, string][] : []), me ? ['u', t('Profile'), P.user] : ['join', t('Join'), P.user], ['settings', t('Settings'), P.gear]]
  const href = (k: string) => (k === 'u' ? userPath(me!) : `/${k}`)
  const active = (k: string) => (k === 'u' ? r0 === 'u' && !!me && userPath(me) === `/u/${r1}` : r0 === k)
  const ico = (k: string, d: string) => <span class="ico"><Icon d={d} size={22} />{unread[k as keyof typeof unread] && <i class="badge" />}</span>
  return (
    <div class="app">
      <nav class="side" aria-label={t('Main')}>
        <a class="brand" href="/"><Logo size={30} /><span>Quilcast</span></a>
        {nav.filter(([k]) => k !== 'join').map(([k, label, d]) => <a class={`navlink${active(k) ? ' on' : ''}`} href={href(k)}>{ico(k, d)}<span>{label}</span></a>)}
        {me ? <button class="btn cast-btn" onClick={() => setCompose({})}><Icon d={P.pen} /><span>{t('Cast')}</span></button> : <a class="btn cast-btn" href="/join" aria-label={t('Join')}><Icon d={P.user} /><span>{t('Join')}</span></a>}
        {me && <AccountMenu me={me} />}
      </nav>
      <main class="col">{view}</main>
      <aside class="extra">
        {r0 !== 'search' && <a class="searchbox" href="/search"><Icon d={P.search} size={16} /><span>{t('Search people and casts')}</span></a>}
        <div class="about">
          <b>{t('About Quilcast')}</b>
          <p>{t('A small, open Farcaster client that reads from and posts to Quilibrium\'s Hypersnap network, with your keys kept in your browser.')}</p>
          <p class="foot"><Version /></p>
          <p class="foot ogre-only"><a href="/shrek/credits.html" target="_blank">{t('Shrek credits')}</a></p>
        </div>
      </aside>
      <nav class="tabbar" aria-label={t('Main')}>
        {nav.map(([k, label, d]) => <a class={active(k) ? 'on' : ''} href={href(k)} aria-label={label}>{ico(k, d)}</a>)}
      </nav>
      {me && !['join', 'settings', 'messages'].includes(r0) && <button class="fab" aria-label={t('New cast')} onClick={() => setCompose({})}><Icon d={P.pen} size={22} /></button>}
      {compose && <Composer {...compose} onClose={() => setCompose(null)} />}
      {viewer && <Lightbox {...viewer} close={() => setViewer(null)} />}
      <Toast />
    </div>
  )
}

applyTheme()
loadLang().then(() => render(<App />, document.getElementById('app')!))
