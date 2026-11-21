// X crossposting (Settings → X crossposting, src/write.ts): copies an X account's new posts to a Farcaster account as
// casts. It runs as its own service (`node server/crosspost.mjs`, Tugport quilcast.crosspost, data in its own volume),
// because it's the one place Quilcast holds a key that can post for someone: one per account that turned it on, made
// here and never sent anywhere. The account's custody adds it with a Hypersnap gasless KEY_ADD: the browser makes the
// custody's two signatures (fc.ts keyAddAuth) and this service signs and sends the KEY_ADD, which Hypersnap only takes
// from the key it adds. Its only scope is CAST_ADD, so it can post casts and nothing else (no likes, follows, profile
// or deletes). Turning it off, or deleting the account, revokes it (a KEY_REMOVE the key signs itself) and forgets it.
// The main server forwards /api/crosspost/<fid> here (CROSSPOST_URL) as it came; the signatures are checked here.
//   GET    /api/crosspost/<fid>  signed "quilcast-crosspost-read:<fid>:<ts>:" → { handle, on, error } ({} when off)
//   POST   /api/crosspost/<fid>  { handle }, signed "quilcast-crosspost-key:<fid>:<ts>:<body>" → { pub }: a new key
//                                for the account, not added yet
//   PUT    /api/crosspost/<fid>  { nonce, deadline, ttl, metadata, custodySig } (metadata and custodySig in hex), signed
//                                "quilcast-crosspost:<fid>:<ts>:<body>": adds that key and turns crossposting on
//   DELETE /api/crosspost/<fid>  signed "quilcast-crosspost-off:<fid>:<ts>:" or "quilcast-delete:<fid>:<ts>:" (deleting
//                                the account, forwarded by server/account.mjs) → { was }: revokes the key, forgets all
// What goes over, as in Nikita's own crossposter: the account's own posts that start a conversation, quotes too (the
// quoted post's link goes in the text, which Quilcast shows as a card), and the rest of a thread it started under the
// cast of the post before. Replies to others and reposts stay on X. Photos and videos are put on Quilcast's server
// (/api/upload, signed with the same key) and embedded; one that can't be is replaced by a link to the post. Text past
// 1024 bytes is cut with a link to the post. Only posts after it's turned on go over, never older ones.
// Each cast is signed with its post's own time, and kept before it's sent, so a restart sends the same message again
// and the node keeps one.
// One JSON file per account in <data>/<fid>.json (0600, it holds the key). Only one copy of the service may run at a time
// (Tugport deploys it stop-first): the locks are per process, and two copies would each upload a post's media to a new
// address, so the same post would make two different casts.
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { castAt, castBody, hex, keyAddMsg, keyRemoveSelf, MT, rawEd, unhex } from '../src/fc.ts'
import { keysOf, keySigned } from './looks.mjs'
import { fail, parseJson, readJsonFile, readText, safeGet, writeAtomic } from './net.mjs'
import { submitTo } from './scheduled.mjs'

const HANDLE = /^[A-Za-z0-9_]{1,15}$/
// at most this many casts a day for one account, so a mirrored firehose can't flood anyone's followers
// ponytail: a flat cap, and an operator deny-list (CROSSPOST_DENY) for an account mirrored without its owner's say
export const PER_DAY = 50
export const MAX_ACCOUNTS = Number(process.env.CROSSPOST_MAX || 2000)
// a node that's down is tried again each round, for about an hour, before that post is skipped
const TRIES = 12
const TWITTER_EPOCH = 1288834974657n
const MEDIA_MAX = { photo: 10e6, video: 100e6 }

let dir = ''
export const loadCrosspost = (d) => mkdir((dir = d), { recursive: true, mode: 0o700 })
const fileOf = (fid) => join(dir, `${fid}.json`)
export const read = (fid) => readJsonFile(fileOf(fid))
const save = (c) => writeAtomic(fileOf(c.fid), JSON.stringify(c), { mode: 0o600 })
// one account's file is changed by one thing at a time here (a round, Turn on, Turn off), so a round that read it before
// a Turn off can't write it back afterwards
const locks = new Map()
function locked(fid, f) {
  const run = (locks.get(fid) || Promise.resolve()).then(f)
  const tail = run.catch(() => {})
  locks.set(fid, tail)
  tail.then(() => locks.get(fid) === tail && locks.delete(fid))
  return run
}
/** Saves a round's copy of the account, unless it was turned off (or turned on again with a new key) meanwhile. */
const keep = (c) =>
  locked(c.fid, async () => {
    const now = await read(c.fid)
    if (!now?.on || now.priv !== c.priv) throw Object.assign(new Error('turned off meanwhile'), { stopped: true })
    await save(c)
  })
/** An account that turned it on (or is being turned off, or stopped on an error), as against a Turn on never finished. */
const shown = (c) => !!(c?.on || c?.off || c?.error)
/** Whether all MAX_ACCOUNTS places are taken by others; unfinished Turn ons take none, so cheap fids can't fill them. */
const full = async (fid) =>
  (await Promise.all((await readdir(dir)).filter((f) => /^\d+\.json$/.test(f) && f !== `${fid}.json`).map((f) => read(f.slice(0, -5))))).filter(shown).length >= MAX_ACCOUNTS
const denied = (handle) => (process.env.CROSSPOST_DENY || '').toLowerCase().split(',').map((s) => s.trim()).includes(handle.toLowerCase())

/** The X id of a post made at `ms` (a snowflake): everything after it is new. */
export const idAt = (ms) => String((BigInt(Math.floor(ms)) - TWITTER_EPOCH) << 22n)
const newer = (a, b) => BigInt(a) > BigInt(b)

// --- what a post becomes ---

const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase()
/** Where a post goes: '' for a new cast, the parent cast's hash for the next post of a thread already cast, null for
 *  nowhere (replies to others, threads whose start wasn't cast, reposts, someone else's posts). */
export function castParent(s, handle, casts) {
  if (!same(s.author?.screen_name, handle) || s.reposted_by) return null
  if (!s.replying_to) return ''
  return (same(s.replying_to.screen_name, handle) && casts[s.replying_to.status]) || null
}

const bytes = (s) => Buffer.byteLength(s)
/** The cast's text: the post, its quoted post's link, cut to 1024 bytes with a link back to the post. */
export function castText(s, tail = '') {
  const text = [s.text || '', s.quote?.url, tail].filter(Boolean).join('\n\n')
  if (bytes(text) <= 1024) return text
  const end = `… ${s.url}`
  let cut = [...text]
  while (bytes(cut.join('')) > 1024 - bytes(end)) cut = cut.slice(0, -Math.max(1, Math.floor((bytes(cut.join('')) - 1024 + bytes(end)) / 4)))
  return cut.join('').trimEnd() + end
}

/** The file to copy for one photo, video or GIF: photos at X's "large" size, videos at the best quality that fits. */
export function mediaUrl(m) {
  // one with no address (fxtwitter left it out) is lost, and the post goes over with a link to it
  if (m.type === 'photo') return typeof m.url === 'string' && m.url ? { url: m.url.replace(/([?&]name=)\w+/, '$1large'), max: MEDIA_MAX.photo } : null
  const mp4 = (m.formats || m.variants || []).filter((f) => f.container === 'mp4' || /\.mp4(\?|$)/.test(f.url || ''))
  // a bitrate times the length is roughly the size; 10% to spare
  const fits = mp4.filter((f) => !m.duration || !f.bitrate || (f.bitrate * m.duration) / 8 < MEDIA_MAX.video * 0.9).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))
  const url = fits[0]?.url || (!mp4.length && m.url)
  return url ? { url, max: MEDIA_MAX.video } : null
}

/** The signed cast(s) for post `s`: its media uploaded through `upload(url, max)` (a url, or null when it can't be). */
export async function toCast(s, c, parent, upload) {
  const embeds = []
  let lost = false
  for (const m of (s.media?.all || []).slice(0, 4)) {
    const src = mediaUrl(m)
    const url = src && (await upload(src.url, src.max).catch((e) => (console.error('crosspost', c.fid, 'media', e.message), null)))
    if (url) embeds.push(url)
    else lost = true
  }
  const body = castBody({ text: castText(s, lost ? s.url : ''), embeds, parent: parent ? { fid: c.fid, hash: parent } : undefined })
  return castAt(c.fid, body, rawEd(unhex(c.priv)), Number(s.created_timestamp) * 1000)
}

// --- the account's settings ---

export async function getCrosspost(req, fid, node) {
  await keySigned(req, 'quilcast-crosspost-read', fid, '', node)
  const c = await read(fid)
  return shown(c) ? { handle: c.handle, on: !!c.on, off: c.off, error: c.error } : {}
}

/** POST: a fresh key for `handle`, kept here until PUT adds it (or a new POST replaces it). */
export async function newKey(req, fid, node, { profile = xProfile, submit = (b) => submitTo(node, b), listed = listedOn(node) } = {}) {
  const body = await readText(req, 1e3)
  await keySigned(req, 'quilcast-crosspost-key', fid, body, node)
  const handle = String(parseJson(body)?.handle || '').replace(/^@/, '')
  if (!HANDLE.test(handle)) throw fail(400, 'bad handle')
  if (denied(handle)) throw fail(400, 'not allowed')
  // the account has to exist (and not be protected) for there to be anything to copy
  const p = await profile(handle)
  if (!p) throw fail(404, 'no such account')
  return locked(fid, async () => {
    const old = await read(fid)
    // one being turned off still holds its key until the revoke lands
    if (old?.on || old?.off) throw fail(409, 'already on')
    if (await full(fid)) throw fail(503, 'full')
    // a key replaced here may have been added after all (a Turn on whose answer was lost, or one stopped by a node
    // error): it's revoked first, so no key that can post is left without anyone holding it
    if (old?.priv) await revoke(old, submit, listed)
    const priv = hex(randomBytes(32))
    const key = rawEd(unhex(priv))
    await save({ fid, handle: p.screen_name || handle, priv, pub: hex(key.pub), on: false, at: Date.now() })
    return { pub: '0x' + hex(key.pub) }
  })
}

/** Whether the node lists `pub` as one of `fid`'s keys that haven't expired (throws when it can't be asked). */
const listedOn = (node) => (fid, pub) => keysOf(node, fid, 0).then((keys) => keys.includes('0x' + pub))
/** The account's key revokes itself. A KEY_REMOVE the node refuses is fine when the node doesn't list the key (revoked
 *  already, expired, or never added), looked at twice since a KEY_ADD sent just now can take a moment to show. */
export async function revoke(c, submit, listed, wait = 3e3) {
  const key = rawEd(unhex(c.priv))
  try {
    await submit((await keyRemoveSelf(c.fid, key, Math.floor(Date.now() / 1000))).msg)
  } catch (e) {
    for (let i = 0; i < 2; i++) {
      if (i) await new Promise((ok) => setTimeout(ok, wait))
      if (await listed(c.fid, hex(key.pub))) {
        console.error('crosspost', c.fid, 'revoke', e.message)
        throw fail(502, 'unavailable')
      }
    }
  }
}

/** PUT: the custody's signatures for the key POST made; the KEY_ADD goes to the node, and from now on posts go over. */
export async function turnOn(req, fid, node, { submit = (b) => submitTo(node, b), now = Date.now() } = {}) {
  const body = await readText(req, 4e3)
  await keySigned(req, 'quilcast-crosspost', fid, body, node)
  const a = parseJson(body) || {}
  const n = (v) => Number.isSafeInteger(v) && v > 0
  if (!n(a.nonce) || !n(a.deadline) || !n(a.ttl) || !/^(0x)?[0-9a-f]{2,2000}$/i.test(a.metadata) || !/^(0x)?[0-9a-f]{130}$/i.test(a.custodySig)) throw fail(400, 'bad key request')
  return locked(fid, async () => {
    const c = await read(fid)
    if (!c?.priv || c.on || c.off) throw fail(409, 'no key')
    if (await full(fid)) throw fail(503, 'full')
    const m = await keyAddMsg(fid, rawEd(unhex(c.priv)), { nonce: a.nonce, deadline: a.deadline, ttl: a.ttl, scopes: [MT.CAST_ADD], metadata: unhex(a.metadata), custodySig: unhex(a.custodySig) })
    try {
      await submit(m.msg)
    } catch (e) {
      console.error('crosspost', fid, 'key add', e.message)
      throw fail(e.retry ? 502 : 400, 'unavailable')
    }
    await save({ ...c, on: true, since: idAt(now), casts: {}, day: '', n: 0, error: undefined, pending: undefined, fails: 0 })
    return { handle: c.handle, on: true }
  })
}

/** DELETE: the key revokes itself (if it was ever added) and everything about the account goes. */
export async function turnOff(req, fid, node, { submit = (b) => submitTo(node, b), listed = listedOn(node) } = {}) {
  // either the setting's own Turn off, or Delete account (both need the node to vouch for the key right now)
  await keySigned(req, 'quilcast-crosspost-off', fid, '', node, undefined, false).catch((e) =>
    // only a signature for something else (a 403 means it was this one, by a key the node doesn't list: the browser
    // replaces its key on a 403 and tries again)
    e.status === 401 ? keySigned(req, 'quilcast-delete', fid, '', node, undefined, false) : Promise.reject(e))
  // stops posting at once (a round under way sees it before its next save); the key stays until its revoke lands, so
  // a failed one can be tried again
  const c = await locked(fid, async () => {
    const c = await read(fid)
    if (c) await save({ ...c, on: false, off: true })
    return c
  })
  if (!c) return { was: null }
  // every key this service made is revoked, whatever its state here: one whose KEY_ADD answer was lost may be live
  await revoke(c, submit, listed)
  await locked(fid, async () => (await read(fid))?.priv === c.priv && rm(fileOf(fid), { force: true }))
  return { was: c.handle }
}

// --- X ---

const FX = process.env.FXTWITTER_URL || 'https://api.fxtwitter.com'
const fx = async (path) => {
  const r = await fetch(`${FX}${path}`, { headers: { 'user-agent': 'QuilcastCrosspost/1.0 (+https://quilcast.com)' }, signal: AbortSignal.timeout(20e3) })
  if (r.status === 429) throw Object.assign(new Error('fxtwitter rate limit'), { busy: true })
  const j = await r.json().catch(() => null)
  return { status: r.status, j }
}
/** The X account, or null when there's none (or it's protected). */
export async function xProfile(handle) {
  const { status, j } = await fx(`/2/profile/${handle}`)
  if (status === 404 || j?.code === 404) return null
  if (!j?.user) throw fail(502, 'x unreachable')
  return j.user.protected ? null : j.user
}
/** The account's latest posts; throws when it can't tell (an empty answer is never taken as "nothing new"). */
export async function xPosts(handle) {
  const { status, j } = await fx(`/2/profile/${handle}/statuses`)
  // gone from X (renamed, protected or suspended), as against fxtwitter having a bad moment
  if (status === 404 || j?.code === 404) throw Object.assign(new Error(`no X account ${handle}`), { gone: true })
  if (!Array.isArray(j?.results)) throw new Error(`no posts list for ${handle}`)
  return j.results.filter((s) => s?.id && /^\d+$/.test(s.id))
}

// --- Quilcast uploads, as the account (its crossposting key) ---

const SITE = process.env.QUILCAST_URL || 'http://quilcast:3000'
/** Puts the file at `url` on Quilcast's server and gives its address there. */
// ponytail: every account's uploads come from this one address, which /api/upload allows 30 starts per 10 minutes;
// past that a post's media becomes a link to the post. Exempt the service there if many accounts post media.
export async function uploadAs(c, url, max, site = SITE) {
  const r = await safeGet(url, { max: max + 1, timeout: 120e3 })
  if (r.status !== 200 || r.truncated) throw new Error(`media ${r.status}${r.truncated ? ' too big' : ''}`)
  const type = r.type.split(';')[0].trim()
  const key = rawEd(unhex(c.priv))
  const ts = Date.now()
  const sig = hex(await key.sign(Buffer.from(`quilcast-upload:${c.fid}:${ts}:`)))
  const call = async (path, init) => {
    const res = await fetch(`${site}${path}`, { ...init, signal: AbortSignal.timeout(60e3) })
    const j = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(j.error || `upload ${res.status}`)
    return j
  }
  const { id, chunk } = await call('/api/upload', { method: 'POST', headers: { 'content-type': type, 'x-size': String(r.body.length), 'x-fid': String(c.fid), 'x-key': '0x' + hex(key.pub), 'x-ts': String(ts), 'x-sig': sig } })
  for (let at = 0; at < r.body.length; at += chunk) await call(`/api/upload/${id}?offset=${at}`, { method: 'PUT', body: r.body.subarray(at, at + chunk) })
  let s = await call(`/api/upload/${id}/done`, { method: 'POST' })
  for (let i = 0; s.state === 'sending' || s.state === 'processing'; i++) {
    if (i > 120) throw new Error('upload took too long')
    await new Promise((ok) => setTimeout(ok, 1000))
    s = await call(`/api/upload/${id}`, { method: 'GET' })
  }
  if (s.state !== 'ready' || !s.url) throw new Error(s.error || 'upload failed')
  return s.url
}

// --- the rounds ---

// a gasless key also expires 90 days after it was last used (as src/write.ts reads it)
const KEY_GONE = /invalid signer|unknown signer|not in the scope|signer.*(revoked|expired|not found)|last_used_at expired|unknown fid/i

/** Submits the cast signed last (c.pending); false when it couldn't be, and the account waits for the next round. */
async function send(c, submit) {
  const p = c.pending
  try {
    await submit(new Uint8Array(Buffer.from(p.msg, 'base64')))
    c.casts = Object.fromEntries([...Object.entries(c.casts || {}), [p.id, p.hash]].slice(-100))
    Object.assign(c, { since: p.id, n: c.n + 1, error: undefined, pending: undefined })
    return true
  } catch (e) {
    if (KEY_GONE.test(e.message)) Object.assign(c, { on: false, error: 'key', pending: undefined })
    // one the node won't take, or still can't after an hour, is skipped (and only then shows in Settings)
    else if (!(e.retry && ++p.tries < TRIES)) {
      console.error('crosspost', c.fid, 'skipped', p.id, e.message)
      Object.assign(c, { since: p.id, pending: undefined, error: 'skipped' })
    }
    return false
  } finally {
    await keep(c)
  }
}

/** Sends what's waiting for one account and casts its new posts, saving `c` as it goes. */
export async function step(c, { posts, upload, submit, now = Date.now() }) {
  const day = new Date(now).toISOString().slice(0, 10)
  c.fails ||= 0
  if (c.day !== day) Object.assign(c, { day, n: 0 })
  // a cast signed before a restart (or a node error) goes again: the same bytes, so the node keeps one
  if (c.pending && !(await send(c, submit))) return
  let list
  try {
    list = await posts(c.handle)
  } catch (e) {
    // an X account that can't be read for a few rounds in a row (renamed, protected, suspended) shows in Settings
    if (e.gone && ++c.fails >= 3) c.error = 'gone'
    await keep(c)
    throw e
  }
  if (c.fails || c.error === 'gone') Object.assign(c, { fails: 0, error: c.error === 'gone' ? undefined : c.error })
  // oldest first, so a thread's first post is cast before the rest
  for (const s of list.sort((a, b) => (newer(a.id, b.id) ? 1 : -1))) {
    if (!newer(s.id, c.since)) continue
    const parent = castParent(s, c.handle, c.casts || {})
    if (parent === null || c.n >= PER_DAY) {
      c.since = s.id
      continue
    }
    const m = await toCast(s, c, parent, (url, max) => upload(c, url, max))
    // kept before it's sent, so a restart now sends these bytes rather than signing another
    c.pending = { id: s.id, hash: m.hash, msg: Buffer.from(m.msg).toString('base64'), tries: 0 }
    await keep(c)
    if (!(await send(c, submit))) return
  }
  await keep(c)
}

// the account a round stopped after, so a rate limit hit every round doesn't leave the ones after it never looked at
let cursor = ''
const STALE = 86400e3
/** One round over every account that's on. Stops at an fxtwitter rate limit: the next round goes on from there. */
export async function round(deps) {
  const files = (await readdir(dir).catch(() => [])).filter((f) => /^[1-9]\d{0,19}\.json$/.test(f)).sort()
  const at = Math.max(0, files.findIndex((f) => f > cursor))
  for (const f of [...files.slice(at), ...files.slice(0, at)]) {
    cursor = f
    const c = await read(f.slice(0, -5))
    // a Turn off (or Delete account) whose revoke failed is tried again; a key made for a Turn on that never finished
    // is revoked (its KEY_ADD may have landed after all) and gone after a day
    if (c?.off || (c && !shown(c) && Date.now() - (c.at || 0) > STALE)) {
      const revoked = await revoke(c, deps.submit, deps.listed).then(() => true, () => false)
      if (revoked) await locked(c.fid, async () => (await read(c.fid))?.priv === c.priv && rm(fileOf(c.fid), { force: true }))
    }
    if (!c?.on || denied(c.handle)) continue
    try {
      await step(c, deps)
    } catch (e) {
      if (e.stopped) continue
      console.error('crosspost', c.fid, e.message)
      if (e.busy) return
    }
  }
}

export function watch({ node, every = 300e3 }) {
  const go = async () => {
    await round({ posts: xPosts, upload: uploadAs, submit: (b) => submitTo(node, b), listed: listedOn(node) }).catch((e) => console.error('crosspost', e.message))
    setTimeout(go, every).unref()
  }
  setTimeout(go, 5e3).unref()
}

// --- the service ---

if (process.argv[1] === import.meta.filename) {
  const NODE = process.env.NODE_URL || 'https://haatz.quilibrium.com'
  await loadCrosspost(process.env.DATA_DIR || '/data')
  watch({ node: NODE, every: Number(process.env.CROSSPOST_EVERY_MS) || 300e3 })
  const json = (res, code, body) => res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body))
  const server = createServer(async (req, res) => {
    const m = req.url.match(/^\/api\/crosspost\/([1-9]\d{0,19})$/)
    if (!m) return req.url === '/' ? json(res, 200, { ok: true }) : json(res, 404, { error: 'not found' })
    const f = { GET: getCrosspost, POST: newKey, PUT: turnOn, DELETE: turnOff }[req.method]
    if (!f) return json(res, 405, { error: 'use GET, POST, PUT or DELETE' })
    const r = await f(req, Number(m[1]), NODE).catch((e) => e)
    const err = r instanceof Error
    if (err && !r.status) console.error('crosspost', r)
    json(res, err ? r.status || 500 : 200, err ? { error: r.status ? r.message : 'failed' } : r)
  })
  server.listen(Number(process.env.PORT) || 3000)
  process.once('SIGTERM', () => server.close(() => process.exit(0)))
}
