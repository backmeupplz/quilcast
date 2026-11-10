// Mini app notifications. When someone turns them on for an app, their browser gets a token here (tied to a
// random inbox secret only that browser knows, stored hashed) and hands it to the app in a signed webhook
// event, which this server delivers to the webhook in the app's manifest. Apps then POST /api/notify with
// tokens; each notification lands in that inbox and goes out as a Web Push if the browser subscribed.
// Nothing here knows who anyone is: an inbox is a hash, a token is random.
import { ed25519 } from '@noble/curves/ed25519.js'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fail, keep, readJson, safeGet } from './net.mjs'
import { push, validSubscription } from './push.mjs'
import { proxied } from '../src/shared.ts'

// ponytail: one JSON file rewritten on change; a database when there are more than tens of thousands of tokens
const MAX_TOKENS = 100e3
const MAX_ITEMS = 100
const DAY = 86400e3

let dir = ''
let db = { inboxes: {}, tokens: {} }
let timer
const persist = () => {
  clearTimeout(timer)
  timer = setTimeout(async () => {
    const file = join(dir, 'notify.json')
    await writeFile(file + '.tmp', JSON.stringify(db), { mode: 0o600 })
    await rename(file + '.tmp', file)
  }, 1000)
}
export function load(dataDir) {
  dir = dataDir
  try {
    db = JSON.parse(readFileSync(join(dir, 'notify.json'), 'utf8'))
  } catch {}
}

const hash = (secret) => {
  if (typeof secret !== 'string' || !/^[0-9a-f]{64}$/.test(secret)) throw fail(400, 'bad inbox')
  return createHash('sha256').update(secret).digest('hex')
}
const origin = (o) => {
  try {
    const u = new URL(o)
    if (u.protocol === 'https:' && u.origin === o) return o
  } catch {}
  throw fail(400, 'bad origin')
}
const str = (v, n) => (typeof v === 'string' && v.length <= n ? v : undefined)
const tokensOf = (inbox) => Object.entries(db.tokens).filter(([, t]) => t.inbox === inbox)

/** POST /api/notify/token {inbox, origin, name, icon}: this browser's token for an app (one per app). */
async function token(req, site) {
  const b = await readJson(req)
  const inbox = hash(b.inbox)
  const o = origin(b.origin)
  const had = tokensOf(inbox).find(([, t]) => t.origin === o)
  if (had) return { token: had[0], url: `${site}/api/notify` }
  if (tokensOf(inbox).length >= 200 || Object.keys(db.tokens).length >= MAX_TOKENS) throw fail(429, 'too many')
  const t = randomBytes(24).toString('base64url')
  db.tokens[t] = { inbox, origin: o, name: str(b.name, 60) || new URL(o).host, icon: str(b.icon, 1024)?.startsWith('https://') ? b.icon : undefined, at: Date.now(), sent: [], ids: {} }
  db.inboxes[inbox] ||= { items: [] }
  persist()
  return { token: t, url: `${site}/api/notify` }
}

/** POST /api/notify/forget {inbox, origin}: that app's token stops working. */
async function forget(req) {
  const b = await readJson(req)
  const inbox = hash(b.inbox)
  for (const [t, v] of tokensOf(inbox)) if (v.origin === b.origin) delete db.tokens[t]
  persist()
  return { ok: true }
}

/** POST /api/notify/drop {inbox}: sign-out; the inbox, its tokens and its push subscription go. */
async function drop(req) {
  const inbox = hash((await readJson(req)).inbox)
  for (const [t] of tokensOf(inbox)) delete db.tokens[t]
  delete db.inboxes[inbox]
  persist()
  return { ok: true }
}

/** POST /api/notify/push {inbox, subscription}: where this inbox's pushes go (null stops them). */
async function subscribe(req) {
  const b = await readJson(req, 4000)
  const id = hash(b.inbox)
  // push can be turned on before any app has a token, so this may be the inbox's first call
  if (!db.inboxes[id] && Object.keys(db.inboxes).length >= MAX_TOKENS) throw fail(429, 'too many')
  const box = (db.inboxes[id] ||= { items: [] })
  if (b.subscription !== null && !validSubscription(b.subscription)) throw fail(400, 'bad subscription')
  const fresh = b.subscription && box.push?.endpoint !== b.subscription.endpoint
  box.push = b.subscription ? { endpoint: b.subscription.endpoint, keys: { p256dh: b.subscription.keys.p256dh, auth: b.subscription.keys.auth } } : undefined
  // a new subscription gets one push straight away: the person sees it works, and a push service that refuses us says so now
  if (fresh) {
    const status = await push(dir, box.push, { title: 'Quilcast', body: 'Push notifications are on. Mini apps you allow can now reach you here.', url: '/apps' }).catch(() => 0)
    if (status < 200 || status >= 300) {
      box.push = undefined
      persist()
      throw fail(502, `The browser's push service refused the test notification${status ? ` (${status})` : ''}.`)
    }
  }
  persist()
  return { ok: true }
}

/** GET /api/notify/inbox (x-inbox header): the latest notifications, newest first. */
const inbox = (req) => ({ items: db.inboxes[hash(req.headers['x-inbox'])]?.items || [] })

/** POST /api/notify: what mini apps call, as the Farcaster spec has it. */
async function deliver(req) {
  const b = await readJson(req, 64e3)
  const id = str(b.notificationId, 128)
  const title = str(b.title, 32)
  const body = str(b.body, 128)
  const target = str(b.targetUrl, 1024)
  if (!id || !title || !body || !target || !Array.isArray(b.tokens) || b.tokens.length > 100) throw fail(400, 'bad notification')
  let host
  try {
    host = new URL(target).protocol === 'https:' && new URL(target).hostname
  } catch {}
  const result = { successfulTokens: [], invalidTokens: [], rateLimitedTokens: [] }
  const now = Date.now()
  const pushes = []
  for (const tk of new Set(b.tokens.filter((x) => typeof x === 'string'))) {
    const t = Object.hasOwn(db.tokens, tk) ? db.tokens[tk] : undefined
    const box = t && db.inboxes[t.inbox]
    // the target has to be on the app's own domain
    if (!box || new URL(t.origin).hostname !== host) {
      result.invalidTokens.push(tk)
      continue
    }
    // the same notification id within a day counts as sent and isn't shown twice
    for (const [k, at] of Object.entries(t.ids)) at < now - DAY && delete t.ids[k]
    if (Object.hasOwn(t.ids, id)) {
      result.successfulTokens.push(tk)
      continue
    }
    t.sent = t.sent.filter((at) => at > now - DAY)
    if (t.sent.length >= 100 || (t.sent.length && t.sent.at(-1) > now - 30e3)) {
      result.rateLimitedTokens.push(tk)
      continue
    }
    t.sent.push(now)
    t.ids[id] = now
    const item = { id: randomBytes(9).toString('base64url'), app: t.origin, name: t.name, icon: t.icon, notificationId: id, title, body, targetUrl: target, at: now }
    box.items = [item, ...box.items].slice(0, MAX_ITEMS)
    // the icon through /api/img, so the app's host doesn't see who got its notification (shared.ts proxied)
    if (box.push) pushes.push([box, { title: `${t.name}: ${title}`, body, icon: t.icon && proxied(t.icon), url: `/apps?n=${item.id}` }])
    result.successfulTokens.push(tk)
  }
  persist()
  // pushes go out after the answer; a subscription the browser dropped is forgotten
  for (const [box, data] of pushes) push(dir, box.push, data).then((s) => (s === 404 || s === 410) && ((box.push = undefined), persist()), () => {})
  return { result }
}

// --- manifests and webhook events ---

const manifests = new Map()
/** The app's /.well-known/farcaster.json (miniapp or frame part), cached for ten minutes. */
export function manifest(o) {
  o = origin(o)
  const hit = manifests.get(o)
  if (hit && hit.at > Date.now() - 600e3) return hit.m
  const m = safeGet(`${o}/.well-known/farcaster.json`, { max: 64e3, headers: { accept: 'application/json' } }).then((r) => {
    if (r.status !== 200 || r.truncated) return null
    const j = JSON.parse(r.body.toString('utf8'))
    const a = j?.miniapp || j?.frame
    if (!a || typeof a !== 'object') return null
    const url = (u) => (typeof u === 'string' && /^https:\/\//.test(u) && u.length < 1024 ? u : undefined)
    return { name: str(a.name, 60), iconUrl: url(a.iconUrl), homeUrl: url(a.homeUrl), splashImageUrl: url(a.splashImageUrl), splashBackgroundColor: str(a.splashBackgroundColor, 9), webhookUrl: url(a.webhookUrl) }
  }).catch(() => null)
  keep(manifests, 2000, o, { at: Date.now(), m })
  return m
}

const EVENTS = new Set(['miniapp_added', 'miniapp_removed', 'notifications_enabled', 'notifications_disabled'])
/** POST /api/notify/event {origin, event}: pass a signed webhook event on to the app's webhook. */
async function event(req, site) {
  const b = await readJson(req, 8000)
  const o = origin(b.origin)
  const e = b.event
  let header, payload
  try {
    header = JSON.parse(Buffer.from(e.header, 'base64url'))
    payload = JSON.parse(Buffer.from(e.payload, 'base64url'))
  } catch {
    throw fail(400, 'bad event')
  }
  const sig = Buffer.from(String(e.signature), 'base64url')
  // only well-formed events signed by the key they name, about our own notification URL
  if (!Number.isSafeInteger(header?.fid) || header.type !== 'app_key' || !/^0x[0-9a-f]{64}$/.test(header.key) || sig.length !== 64 || !EVENTS.has(payload?.event)) throw fail(400, 'bad event')
  if (!ed25519.verify(sig, Buffer.from(`${e.header}.${e.payload}`), Buffer.from(header.key.slice(2), 'hex'))) throw fail(400, 'bad signature')
  const d = payload.notificationDetails
  if (d && (d.url !== `${site}/api/notify` || db.tokens[d.token]?.origin !== o)) throw fail(400, 'bad notification details')
  const m = await manifest(o)
  if (!m) throw fail(404, 'This app has no manifest.')
  if (!m.webhookUrl) return { status: 0 }
  const r = await safeGet(m.webhookUrl, { method: 'POST', body: JSON.stringify({ header: e.header, payload: e.payload, signature: e.signature }), headers: { 'content-type': 'application/json' }, max: 4000 }).catch(() => ({ status: 502 }))
  return { status: r.status }
}

/** The /api/notify… and /api/manifest routes; null when the path isn't one of them. */
export function route(req, path, url, site, vapid) {
  if (path === '/api/manifest') return manifest(url.searchParams.get('origin') || '').then((m) => m && { ...m, webhookUrl: undefined, webhook: !!m.webhookUrl })
  if (path === '/api/notify/vapid') return Promise.resolve({ key: vapid() })
  if (path === '/api/notify/inbox' && req.method === 'GET') return Promise.resolve().then(() => inbox(req))
  if (req.method !== 'POST') return null
  const f = { '/api/notify': deliver, '/api/notify/token': token, '/api/notify/forget': forget, '/api/notify/drop': drop, '/api/notify/push': subscribe, '/api/notify/event': event }[path]
  return f ? f(req, site) : null
}
