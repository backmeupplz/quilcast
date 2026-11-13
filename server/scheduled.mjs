// Scheduled casts (the composer's Schedule, src/write.ts schedule): the browser signs each cast with the account's key
// and the time it should go out as the cast's own timestamp, and hands over the finished Farcaster messages. This
// server keeps those bytes and submits them to the node once that time comes. It holds no key: it can't change a
// cast's text, embeds, reply target or time, nor post anything else as anyone. The most it could do is send one up to
// ten minutes early (a node takes nothing further ahead) or not at all.
//   GET    /api/scheduled/<fid>   the account's list, signed "quilcast-scheduled-read:<fid>:<ts>:" (empty body)
//   PUT    /api/scheduled/<fid>   { id, msgs: [base64 Message…], draft }, signed "quilcast-scheduled:<fid>:<ts>:<body>"
//   DELETE /api/scheduled/<fid>   { id }, signed "quilcast-scheduled-cancel:<fid>:<ts>:<body>": cancels a cast still
//                                 waiting (or takes a posted or failed one off the list); answers what it was
// msgs are one cast, or a thread: each next cast replying to the one before it, a second or so later. `draft` is what
// the composer had (its text with @names as typed, attachments, channel), so the list can show it and Edit can open it
// again. Unlike drafts (server/drafts.mjs), none of this is sealed: the server has to read the messages to send them,
// and they're public once posted anyway. Anyone who got the bytes could submit them too, which only posts what the
// account asked for, at its time; a CastRemove takes it down like any cast.
// Kept as one JSON file per item in <data>/scheduled/<fid>/<id>.json. Each round re-reads them from disk, so during a
// deploy both servers see the same list; if both send the same message, the node keeps one (the same hash).
import { ed25519 } from '@noble/curves/ed25519.js'
import { blake3 } from '@noble/hashes/blake3.js'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fail, parseJson, readText } from './net.mjs'
import { keySigned, keysOf } from './looks.mjs'
import { pushTo, say } from './alerts.mjs'

const MAX = 50
export const MAX_PARTS = 25
// a cast goes out at least a minute from now (this server's clock: the browser's may be off), at most 30 days on (a
// key unused for longer may lapse)
export const SOONEST = 60e3
export const LATEST = 30 * 86400e3
// a thread's casts go out together, so they must all fit in the node's ten minutes ahead
const SPREAD = 300
const EPOCH = 1609459200
// what's done stays on the list for a while: posted ones 3 days, failed ones until the account takes them off (or 30 days)
const KEEP_POSTED = 3 * 86400e3
const KEEP_FAILED = 30 * 86400e3
// a node that's down or busy is tried again, every minute or so, for up to an hour past the time
const RETRY = 60e3
const GIVE_UP = 3600e3

let dir = ''
// items this server is sending right now ("<fid>/<id>"): they can't be cancelled or replaced meanwhile
const sending = new Set()
export const loadScheduled = (dataDir) => mkdir((dir = join(dataDir, 'scheduled')), { recursive: true })
const ID = /^[0-9a-f-]{36}$/
const fileOf = (fid, id) => join(dir, String(fid), `${id}.json`)

// --- reading Farcaster messages: the protobuf fields we need, and nothing ambiguous ---

/** Top-level fields of a protobuf message as [field, value] (varints as BigInt, length-delimited as bytes). Throws on
 *  anything malformed, and on a field number seen twice (protobuf would let the last one win: no guessing here). */
export function fields(b, repeated = []) {
  const out = new Map()
  let i = 0
  const varint = () => {
    let x = 0n
    for (let s = 0n; s < 64n; s += 7n) {
      if (i >= b.length) throw new Error('truncated')
      const c = b[i++]
      x |= BigInt(c & 0x7f) << s
      if (!(c & 0x80)) return x
    }
    throw new Error('varint too long')
  }
  while (i < b.length) {
    const tag = varint()
    const f = Number(tag >> 3n)
    const wire = Number(tag & 7n)
    let v
    if (wire === 0) v = varint()
    else if (wire === 2) {
      const n = Number(varint())
      if (i + n > b.length) throw new Error('truncated')
      v = b.subarray(i, (i += n))
    } else throw new Error('unexpected wire type')
    if (repeated.includes(f)) out.set(f, [...(out.get(f) || []), v])
    else if (out.has(f)) throw new Error('field twice')
    else out.set(f, v)
  }
  return out
}
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])
const hexOf = (b) => Buffer.from(b).toString('hex')

/** One signed CastAdd for `fid`, read and checked on its own: the hash is blake3 of the data, the signature is the
 *  signer's over it, and `data` (what a node stores) is byte for byte `data_bytes` (what it hashes). */
export function readCast(bytes, fid) {
  const bad = (why) => fail(400, `bad message: ${why}`)
  let m, d, body
  try {
    m = fields(bytes)
    d = fields(m.get(7) || new Uint8Array())
    body = fields(d.get(5) || new Uint8Array(), [1, 2, 5, 6])
  } catch (e) {
    throw bad(e.message)
  }
  const data = m.get(7)
  if (!(data instanceof Uint8Array) || !data.length) throw bad('no data')
  if (m.has(1) && !(m.get(1) instanceof Uint8Array && same(m.get(1), data))) throw bad('data differs')
  if (d.get(1) !== 1n) throw bad('not a cast')
  if (m.get(3) !== 1n || m.get(5) !== 1n) throw bad('scheme')
  for (const f of m.keys()) if (f < 1 || f > 7) throw bad('unknown field')
  for (const f of d.keys()) if (f < 1 || f > 5) throw bad('unknown field')
  const hash = m.get(2), sig = m.get(4), signer = m.get(6)
  if (!(hash instanceof Uint8Array) || !same(hash, blake3(data, { dkLen: 20 }))) throw bad('hash')
  if (!(signer instanceof Uint8Array) || signer.length !== 32 || !(sig instanceof Uint8Array) || sig.length !== 64) throw bad('signer')
  let ok = false
  try {
    ok = ed25519.verify(sig, hash, signer)
  } catch {}
  if (!ok) throw bad('signature')
  if (d.get(2) !== BigInt(fid)) throw bad('fid')
  if (d.get(4) !== 1n) throw bad('network')
  const ts = d.get(3)
  if (typeof ts !== 'bigint' || ts >= 2n ** 32n) throw bad('timestamp')
  // a reply or a channel post, never both (protobuf's oneof would quietly keep the last)
  if (body.has(3) && body.has(7)) throw bad('parent')
  let parent
  const p = body.get(3)
  if (p instanceof Uint8Array) {
    let c
    try {
      c = fields(p)
    } catch {
      throw bad('parent')
    }
    if (typeof c.get(1) === 'bigint' && c.get(2) instanceof Uint8Array) parent = { fid: Number(c.get(1)), hash: hexOf(c.get(2)) }
  }
  const text = body.get(4) instanceof Uint8Array ? Buffer.from(body.get(4)).toString('utf8') : ''
  return { at: (Number(ts) + EPOCH) * 1000, hash: hexOf(hash), signer: '0x' + hexOf(signer), parent, text }
}

/** The casts of one scheduled item, checked together: all signed by one of the account's keys, the first at least
 *  SOONEST and at most LATEST from `now`, and each next one a reply to the one before, at the same time or later. */
export function readItem(msgs, fid, keys, now = Date.now()) {
  if (!Array.isArray(msgs) || !msgs.length || msgs.length > MAX_PARTS || !msgs.every((s) => typeof s === 'string' && s.length <= 8000 && /^[\w+/]+=*$/.test(s))) throw fail(400, 'bad messages')
  const casts = msgs.map((s) => readCast(new Uint8Array(Buffer.from(s, 'base64')), fid))
  for (const [i, c] of casts.entries()) {
    if (!keys.includes(c.signer)) throw fail(403, "That key doesn't belong to this account.")
    if (i && !(c.parent?.fid === fid && c.parent.hash === casts[i - 1].hash)) throw fail(400, 'bad thread')
    if (i && !(c.at >= casts[i - 1].at && c.at - casts[0].at <= SPREAD * 1000)) throw fail(400, 'bad thread')
  }
  if (casts[0].at < now + SOONEST) throw fail(400, 'Pick a time at least a minute from now.')
  if (casts[0].at > now + LATEST) throw fail(400, 'Pick a time within the next 30 days.')
  return casts
}

// --- the account's list ---

async function readOne(fid, id) {
  try {
    return JSON.parse(await readFile(fileOf(fid, id), 'utf8'))
  } catch (e) {
    if (e.code === 'ENOENT' || e instanceof SyntaxError) return null
    throw e
  }
}
// a file is written whole or not at all, through a temporary file of its own (both servers write here during a deploy)
async function write(item) {
  const file = fileOf(item.fid, item.id)
  const tmp = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(tmp, JSON.stringify(item))
    await rename(tmp, file)
  } catch (e) {
    await rm(tmp, { force: true })
    throw e
  }
}
const idsOf = async (fid) => (await readdir(join(dir, String(fid))).catch(() => [])).filter((f) => f.endsWith('.json') && ID.test(f.slice(0, -5))).map((f) => f.slice(0, -5))
const listOf = async (fid) => (await Promise.all((await idsOf(fid)).map((id) => readOne(fid, id)))).filter(Boolean)
// what the app is told: everything but the bytes
const shown = ({ id, at, hashes, status, posted, error, draft, done }) => ({ id, at, hash: hashes[0], hashes, status, posted, error, draft, done })

export async function getScheduled(req, fid, node) {
  await keySigned(req, 'quilcast-scheduled-read', fid, '', node)
  return (await listOf(fid)).sort((a, b) => a.at - b.at).map(shown)
}

export async function putScheduled(req, fid, node, now = Date.now()) {
  const body = await readText(req, 300e3)
  await keySigned(req, 'quilcast-scheduled', fid, body, node)
  const { id, msgs, draft } = parseJson(body) || {}
  if (!ID.test(id) || (draft !== undefined && (typeof draft !== 'object' || !draft || JSON.stringify(draft).length > 40e3))) throw fail(400, 'bad item')
  // the keys as the node lists them now: a key revoked a moment ago can't schedule
  const casts = readItem(msgs, fid, await keysOf(node, fid, 3e3), now)
  await mkdir(join(dir, String(fid)), { recursive: true })
  const k = `${fid}/${id}`
  const old = await readOne(fid, id)
  // the same id again replaces it (Edit), only while none of it went out yet (a thread's first posts may have, before a
  // node error it's being retried for)
  if (sending.has(k) || (old && (old.status !== 'scheduled' || old.posted > 0))) throw fail(409, 'That cast was already sent.')
  if (!old && (await idsOf(fid)).length >= MAX) throw fail(400, 'Too many scheduled casts. Cancel some first.')
  const item = { id, fid, at: casts[0].at, msgs, hashes: casts.map((c) => c.hash), text: casts[0].text.slice(0, 300), draft, status: 'scheduled', posted: 0, created: now }
  // claimed while it's written, so a round coming due now doesn't send the old one over it
  sending.add(k)
  try {
    await write(item)
  } finally {
    sending.delete(k)
  }
  return shown(item)
}

export async function cancelScheduled(req, fid, node) {
  const body = await readText(req, 1e3)
  await keySigned(req, 'quilcast-scheduled-cancel', fid, body, node)
  const { id } = parseJson(body) || {}
  if (!ID.test(id)) throw fail(400, 'bad item')
  const k = `${fid}/${id}`
  const item = await readOne(fid, id)
  if (!item) return { id, was: null }
  // one going out right now can't be called back
  if (item.status === 'posting' || sending.has(k)) throw fail(409, 'That cast is being sent right now.')
  sending.add(k)
  try {
    await rm(fileOf(fid, id), { force: true })
  } finally {
    sending.delete(k)
  }
  // a thread whose first posts went out before a node error: the rest is stopped, and the app hears part was sent
  return { id, was: item.status === 'scheduled' && item.posted > 0 ? 'posted' : item.status }
}

/** Every scheduled cast of the account goes (deleting the account); how many there were. */
export async function dropScheduled(fid) {
  const n = (await idsOf(fid)).length
  await rm(join(dir, String(fid)), { recursive: true, force: true })
  return n
}

// --- sending ---

/** Submit one message; resolves 'ok', or throws with `retry` set when trying again later may help. */
export async function submitTo(node, bytes) {
  let r
  try {
    r = await fetch(`${node}/v1/submitMessage`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: bytes, signal: AbortSignal.timeout(15e3) })
  } catch (e) {
    throw Object.assign(new Error(e.message || 'network error'), { retry: true })
  }
  if (r.ok) return 'ok'
  const t = await r.text().catch(() => '')
  let j = {}
  try {
    j = JSON.parse(t)
  } catch {}
  // the node has it already (this server, or the other one during a deploy, sent it a moment ago; or a timed-out try
  // that went through): "message has already been merged", "message already in the mempool", errCode bad_request.duplicate
  if (/duplicate/i.test(String(j.errCode || '')) || /duplicate|already (been )?merged|already in the mempool|already exists/i.test(t)) return 'ok'
  const why = String(j.details || j.error_detail || j.message || j.error || t || `HTTP ${r.status}`).slice(0, 300)
  throw Object.assign(new Error(why), { retry: r.status >= 500 || r.status === 429 || /rate.?limit|too many|busy|timed? ?out|unavailable/i.test(why) })
}

/** Send what's due now and tidy the finished: one round over every account's list. `submit(bytes)` sends one message,
 *  `notify(item)` tells the account one failed. */
export async function tick({ submit, notify, now: fixed }) {
  // a slow node can make a round long: each item reads the clock again (tests fix it)
  const clock = () => fixed ?? Date.now()
  const fids = (await readdir(dir).catch(() => [])).filter((f) => /^[1-9]\d{0,9}$/.test(f))
  for (const f of fids) {
    const fid = Number(f)
    for (const id of await idsOf(fid)) {
      const item = await readOne(fid, id)
      if (!item) continue
      const now = clock()
      if (item.status === 'posted' && now - item.done > KEEP_POSTED) await rm(fileOf(fid, id), { force: true })
      else if (item.status === 'failed' && now - item.done > KEEP_FAILED) await rm(fileOf(fid, id), { force: true })
      // a round that stopped partway (a restart) left it 'posting': it goes on from where it was
      else if ((item.status === 'scheduled' || item.status === 'posting') && item.at <= now && (item.next || 0) <= now) await send(fid, id, submit, notify, clock)
    }
  }
}

async function send(fid, id, submit, notify, clock) {
  const key = `${fid}/${id}`
  // claimed before anything is awaited, so a cancel or an edit arriving now is refused rather than lost
  if (sending.has(key)) return
  sending.add(key)
  try {
    // read again: it may have been cancelled or edited since the round read it
    const item = await readOne(fid, id)
    if (!item || (item.status !== 'scheduled' && item.status !== 'posting') || item.at > clock() || (item.next || 0) > clock()) return
    await write({ ...item, status: 'posting' })
    try {
      for (; item.posted < item.msgs.length; item.posted++) await submit(new Uint8Array(Buffer.from(item.msgs[item.posted], 'base64')))
      Object.assign(item, { status: 'posted', done: clock(), error: undefined, next: undefined })
    } catch (e) {
      const now = clock()
      if (e.retry && now - item.at < GIVE_UP) Object.assign(item, { status: 'scheduled', next: now + RETRY, error: e.message })
      else Object.assign(item, { status: 'failed', done: now, error: e.message })
    }
    // removed meanwhile (by the other server during a deploy, which can't see this one's claim): gone
    if (!(await readOne(fid, id))) return
    await write(item)
    if (item.status === 'failed') await notify(item).catch((e) => console.error('scheduled', fid, 'notify', e.message))
  } finally {
    sending.delete(key)
  }
}

/** A push to the account's browsers that signed up for notifications (server/alerts.mjs), in each one's language. */
export const failedPush = (item) =>
  pushTo(item.fid, (lang) => ({
    title: say(lang, "Your scheduled cast couldn't be posted"),
    body: [item.text.replace(/\s+/g, ' ').trim().slice(0, 100), item.error].filter(Boolean).join(' · '),
    url: '/?scheduled',
    tag: `scheduled:${item.id}`,
  }))

/** Look for due casts every `every` ms. */
export function watchScheduled({ node, every = 15e3 }) {
  const round = async () => {
    await tick({ submit: (b) => submitTo(node, b), notify: failedPush }).catch((e) => console.error('scheduled', e.message))
    setTimeout(round, every).unref()
  }
  setTimeout(round, Math.min(every, 5e3)).unref()
}
