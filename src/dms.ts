// Direct casts (farcaster.xyz's DMs). Calls go through our relay (server/dm.mjs), since farcaster.xyz only
// answers its own site; live updates come straight from farcaster.xyz's websocket, so nothing polls.
// The Messages pages and the nav dot share the state kept here. Loaded only for accounts that opened messages.
import { account, getUser, setAccount } from './api.ts'
import { t } from './i18n.ts'

export type Person = { fid: number; username?: string; displayName?: string; pfp?: { url?: string } }
export type Msg = {
  conversationId: string; messageId: string; senderFid: number; serverTimestamp: number; type: string; message: string; isDeleted?: boolean
  senderContext?: Person; actionTargetUserContext?: Person; state?: 'sending' | 'failed'
}
export type Convo = {
  conversationId: string; name?: string; photoUrl?: string; isGroup: boolean; lastMessage?: Msg; participants?: Person[]; messageTTLDays?: number | 'Infinity'
  viewerContext: { category?: string; unreadCount?: number; muted?: boolean; counterParty?: Person }
}

/** One relayed call. A 401 means the token is gone, so it's dropped and asked for again. */
export async function dm<T = any>(op: string, o: { query?: Record<string, string | number | undefined>; method?: string; body?: unknown } = {}): Promise<T> {
  const qs = new URLSearchParams(Object.entries(o.query || {}).filter(([, v]) => v !== undefined) as [string, string][])
  const headers: Record<string, string> = account?.dm ? { authorization: `Bearer ${account.dm}` } : {}
  if (o.body) headers['content-type'] = 'application/json'
  const r = await fetch(`/api/dm/${op}?${qs}`, { method: o.method || 'GET', headers, body: o.body ? JSON.stringify(o.body) : undefined })
  const j = await r.json().catch(() => ({}))
  if (r.status === 401 && account?.dm) setAccount({ ...account, dm: undefined })
  if (!r.ok) throw new Error(j.errors?.[0]?.message || j.error || t('farcaster.xyz said {status}', { status: r.status }))
  return j
}

// --- state ---

// the inbox (muted ones too, the pages filter), what farcaster.xyz says is unread in it, and requests; newest first
export type Box = 'default' | 'unread' | 'request'
// `used` holds the cursors already asked for: one coming round again means the list has looped, so it's the end
type List = { items: Convo[] | null; more: string; pages: number; used: Set<string> }
const empty = (): List => ({ items: null, more: '', pages: 0, used: new Set() })
export const store = {
  lists: { default: empty(), unread: empty(), request: empty() } as Record<Box, List>,
  requestsCount: 0,
  convos: new Map<string, Convo>(),
  chats: new Map<string, { msgs: Msg[]; older: string }>(),
  open: '', // the conversation on screen, which reads what arrives
}
export const unread = (c: Convo) => (c.viewerContext.unreadCount || 0) > 0
const subs = new Set<() => void>()
export const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f))
let dot: boolean | undefined
function changed() {
  subs.forEach((f) => f())
  // the nav dot: unread conversations in the inbox that aren't muted (requests are mostly strangers, so they don't count)
  const now = [store.lists.default, store.lists.unread].some((l) => l.items?.some((c) => unread(c) && !c.viewerContext.muted))
  if (now !== dot) dispatchEvent(new CustomEvent('dms', { detail: (dot = now) }))
}

/** `a` plus whatever in `b` is new or changed, oldest first; `a` itself when nothing is. */
export function merge(a: Msg[], b: Msg[]) {
  const have = new Map(a.map((m) => [m.messageId, m]))
  const fresh = b.filter((m) => {
    const x = have.get(m.messageId)
    return !x || x.message !== m.message || x.isDeleted !== m.isDeleted
  })
  if (!fresh.length) return a
  for (const m of fresh) have.set(m.messageId, m)
  return [...have.values()].sort((x, y) => x.serverTimestamp - y.serverTimestamp)
}

/** A page of conversations added to `list`: new ones only, and a page with nothing new is the end, whatever the cursor says. */
export function page(list: List, got: Convo[], next: string | undefined, older: boolean) {
  const old = list.items || []
  if (older) {
    const have = new Set(old.map((c) => c.conversationId))
    const added = got.filter((c) => !have.has(c.conversationId))
    list.items = [...old, ...added]
    list.more = added.length && next && !list.used.has(next) ? next : ''
    list.pages++
  } else {
    // the newest page on top; older pages already loaded stay under it, and so does their cursor
    const ids = new Set(got.map((c) => c.conversationId))
    list.items = [...got, ...(list.pages > 1 ? old.filter((c) => !ids.has(c.conversationId)) : [])]
    if (list.pages <= 1) list.more = next || ''
    list.pages ||= 1
  }
}

const busy = new Map<string, Promise<void>>()
/** A list's newest page, or with `older` the next one down; calls that overlap share one request. */
export function load(box: Box, older = false): Promise<void> {
  const k = `${box}${older}`
  if (!busy.has(k)) busy.set(k, fetchPage(box, older).finally(() => busy.delete(k)))
  return busy.get(k)!
}
async function fetchPage(box: Box, older: boolean) {
  const list = store.lists[box]
  if (older) list.used.add(list.more)
  // 100 is the most farcaster.xyz gives at once
  const r = await dm('inbox', { query: { category: box === 'request' ? 'request' : 'default', filter: box === 'unread' ? 'unread' : undefined, limit: 100, cursor: older ? list.more : undefined } })
  // the same conversation in two lists is one object, so a change shows in both
  const got = (r.result.conversations as Convo[]).map((c) => (store.convos.has(c.conversationId) ? Object.assign(store.convos.get(c.conversationId)!, c) : (store.convos.set(c.conversationId, c), c)))
  page(list, got, r.next?.cursor, older)
  if (box !== 'request') store.requestsCount = r.result.requestsCount || 0
  changed()
}

/** A conversation's latest messages (20 when some are already here, which is all a refresh needs), or earlier ones. */
export async function loadChat(id: string, earlier = false) {
  const chat = store.chats.get(id) || { msgs: [], older: '' }
  const limit = earlier || !chat.msgs.length ? 50 : 20
  const r = await dm('messages', { query: { conversationId: id, limit, cursor: earlier ? chat.older : undefined } })
  const got: Msg[] = r.result.messages
  // a full page that doesn't reach what we have leaves a gap: start over from it
  const gap = !earlier && chat.msgs.length > 0 && got.length === limit && !got.some((m) => chat.msgs.some((x) => x.messageId === m.messageId))
  const msgs = merge(gap ? [] : chat.msgs, got)
  const older = earlier || gap || !chat.msgs.length ? r.next?.cursor || '' : chat.older
  if (msgs === chat.msgs && older === chat.older && store.chats.has(id)) return
  store.chats.set(id, { msgs, older })
  changed()
}

/** The conversation `id`, from the inbox or the network; a 1:1 nobody has written in yet is made up from its id (the two FIDs, sorted). */
export async function lookup(id: string) {
  if (store.convos.has(id)) return store.convos.get(id)!
  const me = account!.fid!
  let c: Convo
  try {
    c = (await dm('conversation', { query: { conversationId: id } })).result.conversation
  } catch (e) {
    const fid = /^\d+-\d+$/.test(id) && id.split('-').includes(String(me)) ? Number(id.split('-').find((f) => f !== String(me))) : 0
    if (!fid) throw e
    const u = await getUser(fid).catch(() => ({ fid }) as { fid: number; username?: string; display_name?: string; pfp_url?: string })
    c = { conversationId: id, isGroup: false, viewerContext: { category: 'default', counterParty: { fid, username: u.username, displayName: u.display_name, pfp: { url: u.pfp_url } } } }
  }
  store.convos.set(id, c)
  changed()
  return c
}

/** The settings the inbox doesn't carry (auto-delete), read into the conversation we have. */
export async function details(c: Convo) {
  const d: Convo = (await dm('conversation', { query: { conversationId: c.conversationId } })).result.conversation
  c.messageTTLDays = d.messageTTLDays
  c.participants ||= d.participants
  changed()
}

// --- actions ---

export function read(id: string) {
  const c = store.convos.get(id)
  if (!c || !unread(c)) return
  c.viewerContext.unreadCount = 0
  changed()
  dm('read', { method: 'POST', body: { conversationId: id } }).catch(() => {})
}

// set a field optimistically, and put it back if farcaster.xyz says no
async function setting<K extends 'muted' | 'messageTTLDays'>(c: Convo, k: K, v: any, op: string, body: object) {
  const target = k === 'muted' ? c.viewerContext : c
  const was = (target as any)[k]
  ;(target as any)[k] = v
  changed()
  try {
    await dm(op, { method: 'POST', body: { conversationId: c.conversationId, ...body } })
  } catch (e) {
    ;(target as any)[k] = was
    changed()
    throw e
  }
}
export const mute = (c: Convo, muted: boolean) => setting(c, 'muted', muted, 'mute', { muted })
/** Auto-delete messages after `days` (1, 7, 30 or 365), or never ('Infinity'). */
export const autoDelete = (c: Convo, days: number | 'Infinity') => setting(c, 'messageTTLDays', days, 'ttl', { ttl: days })

// one conversation fresh from farcaster.xyz, merged into the copy everyone holds and filed in the right list;
// what arrives in quick succession for the same conversation waits for one request
const soon = new Set<string>()
function refresh(id: string) {
  if (soon.has(id)) return
  soon.add(id)
  setTimeout(() => {
    soon.delete(id)
    dm('conversation', { query: { conversationId: id } }).then((r) => file(r.result.conversation), () => {})
  }, 1500)
}
function file(d: Convo) {
  const c = store.convos.get(d.conversationId)
  if (c) {
    Object.assign(c.viewerContext, d.viewerContext)
    c.lastMessage = d.lastMessage || c.lastMessage
    c.name = d.name ?? c.name
    c.photoUrl = d.photoUrl ?? c.photoUrl
    c.participants ||= d.participants
  } else store.convos.set(d.conversationId, d)
  place(store.convos.get(d.conversationId)!)
  changed()
}

// file a conversation where it belongs now: the inbox or requests by category, and unread when it is; `top` moves it up
function place(c: Convo, top = false) {
  const inbox = (c.viewerContext.category || 'default') === 'default'
  const fits: Record<Box, boolean> = { default: inbox, unread: inbox && unread(c), request: c.viewerContext.category === 'request' }
  for (const box of Object.keys(fits) as Box[]) {
    const list = store.lists[box]
    if (!list.items) continue
    const here = list.items.includes(c)
    // the unread list only gains: what's been read since is left out when it's shown
    if (fits[box] && (!here || top)) list.items = [c, ...list.items.filter((x) => x !== c)]
    else if (!fits[box] && here && box !== 'unread') list.items = list.items.filter((x) => x !== c)
  }
}

// a new message: newest conversation on top
function bump(c: Convo, m: Msg) {
  c.lastMessage = m
  place(c, true)
}

/** Send `text`, shown right away as "Sending…" and replaced in place by farcaster.xyz's copy once it's through. */
export async function send(c: Convo, text: string) {
  const me = account!.fid!
  const id = c.conversationId
  const chat = store.chats.get(id) || { msgs: [], older: '' }
  store.chats.set(id, chat)
  const temp: Msg = { conversationId: id, messageId: crypto.randomUUID(), senderFid: me, serverTimestamp: Date.now(), type: 'text', message: text, state: 'sending' }
  chat.msgs = [...chat.msgs, temp]
  changed()
  try {
    // replying to a request (or an archived conversation) moves it to the inbox, as farcaster.xyz does
    if (c.viewerContext.category && c.viewerContext.category !== 'default') {
      await dm('category', { method: 'POST', body: { conversationId: id, category: 'default' } })
      c.viewerContext.category = 'default'
      store.requestsCount = Math.max(0, store.requestsCount - 1)
    }
    const to = c.isGroup ? { groupId: id } : { recipientFid: c.viewerContext.counterParty?.fid || c.participants?.find((p) => p.fid !== me)?.fid }
    const r = await dm('send', { method: 'PUT', body: { ...to, message: text } })
    // the websocket may already have swapped in farcaster.xyz's copy; otherwise ours takes its id
    if (chat.msgs.includes(temp)) chat.msgs = chat.msgs.map((x) => (x === temp ? { ...temp, messageId: r.result?.messageId || temp.messageId, state: undefined } : x))
    bump(c, chat.msgs.find((x) => x.messageId === r.result?.messageId) || temp)
    changed()
  } catch (e) {
    chat.msgs = chat.msgs.map((x) => (x === temp ? { ...temp, state: 'failed' } : x))
    changed()
    throw e
  }
}

// --- live updates ---

type Event = { messageType: string; payload?: { conversationId?: string; message?: Msg } }
export function handle({ messageType, payload }: Event) {
  const id = payload?.conversationId
  if (!id) return
  const c = store.convos.get(id)
  if (messageType === 'refresh-direct-cast-conversation' && payload!.message) {
    const m = payload!.message
    const mine = m.senderFid === account?.fid
    const chat = store.chats.get(id)
    if (chat) {
      // our own message coming back takes the place of the one still sending, so nothing doubles or jumps
      const temp = mine && chat.msgs.find((x) => x.state === 'sending' && x.message === m.message)
      chat.msgs = temp ? chat.msgs.map((x) => (x === temp ? m : x)) : merge(chat.msgs, [m])
    }
    // a conversation we haven't seen yet (a new one, a request, or one further down) is looked up alone
    if (!c) return refresh(id)
    if (!mine) {
      // on screen it's read as it arrives; otherwise it counts
      if (store.open === id && document.visibilityState === 'visible') dm('read', { method: 'POST', body: { conversationId: id } }).catch(() => {})
      else c.viewerContext.unreadCount = (c.viewerContext.unreadCount || 0) + 1
    }
    bump(c, m)
    changed()
  } else if (messageType === 'direct-cast-read' && c) {
    c.viewerContext.unreadCount = 0
    changed()
  } else if (messageType === 'refresh-self-direct-casts-inbox') refresh(id)
}

let ws: WebSocket | undefined
let wsToken = ''
let wait = 1000
let dropped = false
export const stop = () => ((wsToken = ''), ws?.close())
/** Load the inbox and listen for changes; reconnects with backoff, and a 4001 means the token was revoked. */
export function start() {
  if (!account?.dm || (ws && wsToken === account.dm)) return
  ws?.close()
  const token = (wsToken = account.dm)
  // the nav dot needs the inbox before anyone opens Messages
  if (!store.lists.default.items) load('default').catch(() => {})
  const socket = (ws = new WebSocket('wss://ws.farcaster.xyz/stream'))
  socket.onopen = () => {
    socket.send(JSON.stringify({ messageType: 'dc_authenticate', data: token }))
    wait = 1000
    // back after a drop: catch up on what happened while we weren't listening
    if (dropped) (dropped = false), load('default').catch(() => {}), store.open && loadChat(store.open).catch(() => {})
  }
  socket.onmessage = (e) => {
    if (wsToken !== token) return socket.close()
    try {
      handle(JSON.parse(e.data))
    } catch {}
  }
  socket.onclose = (e) => {
    if (ws === socket) ws = undefined
    if (wsToken !== token || account?.dm !== token) return
    if (e.code === 4001) return setAccount({ ...account, dm: undefined })
    dropped = true
    setTimeout(start, (wait = Math.min(wait * 2, 60e3)))
  }
}
