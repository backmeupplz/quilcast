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
// Each cast is signed with its post's own time, so the same post always makes the same message: a restart, or two
// copies of this service during a deploy, can send it again, and the node keeps one.
// One JSON file per account in <data>/<fid>.json (0600, it holds the key).
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { castAt, castBody, hex, keyAddMsg, keyRemoveSelf, MT, rawEd, unhex } from '../src/fc.ts'
import { keySigned } from './looks.mjs'
import { fail, parseJson, readText, safeGet } from './net.mjs'
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
export const read = (fid) => readFile(fileOf(fid), 'utf8').then(JSON.parse, () => null)
async function save(c) {
  const f = fileOf(c.fid)
  const tmp = `${f}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(tmp, JSON.stringify(c), { mode: 0o600 })
  await rename(tmp, f)
}
// keys turned off (or replaced) while this process runs: a round still working with one stops and writes nothing more
const gone = new Set()
/** save() for the rounds: never brings back an account turned off meanwhile. */
async function keep(c) {
  if (gone.has(c.pub)) throw new Error('turned off')
  await save(c)
}
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
  if (m.type === 'photo') return { url: m.url.replace(/([?&]name=)\w+/, '$1large'), max: MEDIA_MAX.photo }
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
  return c?.on || c?.off || c?.error ? { handle: c.handle, on: !!c.on, off: c.off, error: c.error } : {}
}

/** The key revokes itself; only a node that can't be asked throws (any other refusal leaves nothing to revoke). */
async function revoke(c, submit) {
  await submit((await keyRemoveSelf(c.fid, rawEd(unhex(c.priv)), Math.floor(Date.now() / 1000))).msg).catch((e) => {
    if (e.retry) throw e
  })
}

/** POST: a fresh key for `handle`, kept here until PUT adds it (or a new POST replaces it). */
export async function newKey(req, fid, node, { profile = xProfile, submit = (b) => submitTo(node, b) } = {}) {
  const body = await readText(req, 1e3)
  await keySigned(req, 'quilcast-crosspost-key', fid, body, node)
  const handle = String(parseJson(body)?.handle || '').replace(/^@/, '')
  if (!HANDLE.test(handle)) throw fail(400, 'bad handle')
  if (denied(handle)) throw fail(400, 'not allowed')
  const old = await read(fid)
  // one being turned off still holds its key until the revoke lands
  if (old?.on || old?.off) throw fail(409, 'already on')
  if (!old && (await readdir(dir)).filter((f) => f.endsWith('.json')).length >= MAX_ACCOUNTS) throw fail(503, 'full')
  if (old) {
    gone.add(old.pub)
    // a KEY_ADD whose answer was lost may have landed after all
    if (old.tried)
      await revoke(old, submit).catch((e) => {
        throw fail(502, e.message)
      })
  }
  // the account has to exist (and not be protected) for there to be anything to copy
  const p = await profile(handle)
  if (!p) throw fail(404, 'no such account')
  const priv = hex(randomBytes(32))
  const key = rawEd(unhex(priv))
  await save({ fid, handle: p.screen_name || handle, priv, pub: hex(key.pub), on: false, made: Date.now() })
  return { pub: '0x' + hex(key.pub) }
}

/** PUT: the custody's signatures for the key POST made; the KEY_ADD goes to the node, and from now on posts go over. */
export async function turnOn(req, fid, node, { submit = (b) => submitTo(node, b), now = Date.now() } = {}) {
  const body = await readText(req, 4e3)
  await keySigned(req, 'quilcast-crosspost', fid, body, node)
  const a = parseJson(body) || {}
  const c = await read(fid)
  if (!c?.priv || c.on) throw fail(409, 'no key')
  const n = (v) => Number.isSafeInteger(v) && v > 0
  if (!n(a.nonce) || !n(a.deadline) || !n(a.ttl) || !/^(0x)?[0-9a-f]{2,2000}$/i.test(a.metadata) || !/^(0x)?[0-9a-f]{130}$/i.test(a.custodySig)) throw fail(400, 'bad key request')
  const m = await keyAddMsg(fid, rawEd(unhex(c.priv)), { nonce: a.nonce, deadline: a.deadline, ttl: a.ttl, scopes: [MT.CAST_ADD], metadata: unhex(a.metadata), custodySig: unhex(a.custodySig) })
  // from here the key may be on the account, so whatever replaces or sweeps it revokes it first
  await save({ ...c, tried: true })
  try {
    await submit(m.msg)
  } catch (e) {
    throw fail(e.retry ? 502 : 400, e.message)
  }
  // turned off (or deleted) while the KEY_ADD was on its way
  if (gone.has(c.pub)) {
    await revoke(c, submit).catch(() => {})
    throw fail(409, 'no key')
  }
  await save({ ...c, on: true, since: idAt(now), casts: {}, day: '', n: 0, error: undefined, pending: undefined })
  return { handle: c.handle, on: true }
}

/** DELETE: the key revokes itself (if it was ever added) and everything about the account goes. */
export async function turnOff(req, fid, node, { submit = (b) => submitTo(node, b) } = {}) {
  // either the setting's own Turn off, or Delete account (both need the node to vouch for the key right now)
  await keySigned(req, 'quilcast-crosspost-off', fid, '', node, undefined, false).catch(() => keySigned(req, 'quilcast-delete', fid, '', node, undefined, false))
  const c = await read(fid)
  if (!c) return { was: null }
  gone.add(c.pub)
  // stops posting at once; the key stays until its revoke lands, so one the node couldn't be asked about is tried again
  if (c.on) await save({ ...c, on: false, off: true })
  // also for a key never known to be added (its KEY_ADD's answer may have been lost on the way); a refusal (revoked
  // already, expired, never added) leaves nothing to revoke, and the key goes with the file
  await revoke(c, submit).catch((e) => {
    throw fail(502, e.message)
  })
  await rm(fileOf(fid), { force: true })
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
  const { j } = await fx(`/2/profile/${handle}/statuses`)
  if (!Array.isArray(j?.results)) throw new Error(`no posts list for ${handle}`)
  return j.results.filter((s) => s?.id && /^\d+$/.test(s.id))
}

// --- Quilcast uploads, as the account (its crossposting key) ---

const SITE = process.env.QUILCAST_URL || 'http://quilcast-quilcast:3000'
/** Puts the file at `url` on Quilcast's server and gives its address there. */
// ponytail: every upload comes from this service's one IP, so past the server's 30 uploads per 10 minutes per IP the
// rest become links to the post; exempt this service there if many accounts post media
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
    else if (e.retry && ++p.tries < TRIES) c.error = e.message
    // one the node won't take, or still can't after an hour, is skipped
    else Object.assign(c, { since: p.id, pending: undefined, error: e.message })
    return false
  } finally {
    await keep(c)
  }
}

/** Sends what's waiting for one account and casts its new posts, saving `c` as it goes. */
export async function step(c, { posts, upload, submit, now = Date.now() }) {
  const day = new Date(now).toISOString().slice(0, 10)
  if (c.day !== day) Object.assign(c, { day, n: 0 })
  // a cast signed before a restart (or a node error) goes again: the same bytes, so the node keeps one
  if (c.pending && !(await send(c, submit))) return
  // oldest first, so a thread's start is cast before the rest of it
  for (const s of (await posts(c.handle)).sort((a, b) => (newer(a.id, b.id) ? 1 : -1))) {
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

let resume = ''
/** One round over every account that's on. Stops at an fxtwitter rate limit: the next round starts from there. */
export async function round(deps) {
  const files = (await readdir(dir).catch(() => [])).filter((f) => /^[1-9]\d{0,19}\.json$/.test(f)).sort()
  const at = Math.max(0, files.indexOf(resume))
  resume = ''
  for (const f of [...files.slice(at), ...files.slice(0, at)]) {
    const c = await read(f.slice(0, -5))
    // a key made for Turn on that never went on (a day on)
    if (c && !c.on && !c.off && c.since === undefined && Date.now() - (c.made || 0) > 86400e3) {
      gone.add(c.pub)
      if (!c.tried || (await revoke(c, deps.submit).then(() => true, () => false))) await rm(fileOf(c.fid), { force: true })
      continue
    }
    if (!c?.on || denied(c.handle)) continue
    try {
      await step(c, deps)
    } catch (e) {
      console.error('crosspost', c.fid, e.message)
      if (e.busy) return void (resume = f)
    }
  }
}

export function watch({ node, every = 300e3 }) {
  const go = async () => {
    await round({ posts: xPosts, upload: uploadAs, submit: (b) => submitTo(node, b) }).catch((e) => console.error('crosspost', e.message))
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
