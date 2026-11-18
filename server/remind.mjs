// Remind me (remind.quilcast.com, actions/remindme/): Quilcast's own cast action that brings a cast back later as a
// mini app notification, the standard Farcaster way. The action gets a notification token from its host (addMiniApp,
// or context.client.notificationDetails when they're already on) and hands it over with the cast and the time. When
// that time comes, this server POSTs the notification to the token's URL: Quilcast's own /api/notify (called
// in-process, server/notify.mjs send) or any other Farcaster client's. It knows no one: a reminder is a token, a URL,
// a cast and a time.
//   POST /api/remind  { token, url, hash, fid, at, author?, text? } -> { id, at }; errors are short codes the page
//                     words itself (it's English only, unlike the app's toasts)
//   POST /webhook     the manifest's webhookUrl: mini app events, acknowledged and not kept. A token that's been turned
//                     off comes back from its URL as invalid, and that reminder is dropped then.
// One small JSON file per reminder in <data>/remind/, named <due ms>-<id>-<q|r><token key>.json (q: Quilcast's own
// /api/notify, r: another client's), so each round finds what's due, and each new reminder counts what its token and
// remote hosts already hold, from the names alone. Each round reads the folder again, so during a deploy both servers
// see the same reminders; a reminder sent twice keeps its notificationId, which a host shows once (Quilcast's only
// within one server process).
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fail, safeGet } from './net.mjs'
import { known, send } from './notify.mjs'

// from a minute to a year away (this server's clock; the browser's may be a little off)
export const SOONEST = 60e3
export const LATEST = 365 * 86400e3
const SLACK = 10e3
// at most this many kept, of which this many for other clients (Quilcast's own tokens have to exist, so the rest
// can't be filled with made-up ones), and this many per token
const MAX = 50e3
const MAX_REMOTE = 10e3
export const PER_TOKEN = 50
// a host that's down, or that rate-limits the token (Quilcast takes one every 30 s per token), is tried again every
// minute, up to 30 times and for up to a day past the time
const RETRY = 60e3
const TRIES = 30
const GIVE_UP = 86400e3
// other clients are sent to a few at a time, briefly, and only so many per round, so a slow one holds up nothing
const AT_ONCE = 8
const TIMEOUT = 4e3
const PER_ROUND = 200
const NAME = /^(\d{13})-([\w-]{12})-([qr])([\w-]{10})\.json$/

let dir = ''
let site = ''
export const loadRemind = (dataDir, siteUrl) => ((site = siteUrl), mkdir((dir = join(dataDir, 'remind')), { recursive: true }))

const ours = (url) => url === `${site}/api/notify`
const keyOf = (url, token) => (ours(url) ? 'q' : 'r') + createHash('sha256').update(`${url}\n${token}`).digest('base64url').slice(0, 10)

/** `s` in at most `n` UTF-16 units (what the notification spec counts), cut at a whole character with an ellipsis. */
export function cut(s, n) {
  if (s.length <= n) return s
  let out = ''
  for (const ch of s) {
    if (out.length + ch.length > n - 1) break
    out += ch
  }
  return out + '…'
}

/** POST /api/remind: keeps a reminder about cast `hash` by `fid`, due at `at` (ms), for token `token` at `url`. */
export async function addReminder(b, host, now = Date.now()) {
  if (!b || typeof b !== 'object') throw fail(400, 'bad reminder')
  const token = typeof b.token === 'string' && b.token.length > 0 && b.token.length <= 256 ? b.token : null
  let url
  try {
    url = typeof b.url === 'string' && b.url.length <= 1024 && new URL(b.url)
  } catch {}
  if (!token || !url || url.protocol !== 'https:') throw fail(400, 'bad notification details')
  // Quilcast's own: a token it gave this action
  if (ours(url.href) && !known(token, `https://${host}`)) throw fail(400, 'bad notification details')
  const hash = typeof b.hash === 'string' && /^0x[0-9a-f]{40}$/i.test(b.hash) ? b.hash.toLowerCase() : null
  const fid = Number.isSafeInteger(b.fid) && b.fid > 0 ? b.fid : null
  if (!hash || !fid) throw fail(400, 'bad cast')
  if (!Number.isSafeInteger(b.at) || b.at < now + SOONEST - SLACK || b.at > now + LATEST) throw fail(400, 'bad time')
  const key = keyOf(url.href, token)
  let all = 0, remote = 0, mine = 0
  for (const name of await readdir(dir)) {
    const m = name.match(NAME)
    if (!m) continue
    all++
    if (m[3] === 'r') remote++
    if (m[3] + m[4] === key) mine++
  }
  if (mine >= PER_TOKEN) throw fail(429, 'too many reminders')
  if (all >= MAX || (key[0] === 'r' && remote >= MAX_REMOTE)) throw fail(503, 'too many reminders')
  const id = randomBytes(9).toString('base64url')
  const who = typeof b.author === 'string' && /^[\w.-]{1,40}$/.test(b.author) ? `@${b.author}` : `fid ${fid}`
  const text = typeof b.text === 'string' ? b.text.slice(0, 1024).replace(/\s+/g, ' ').trim() : ''
  const r = {
    id, key, url: url.href, at: b.at, tries: 0,
    notification: {
      notificationId: `remind-${id}`, title: 'Reminder', body: cut(text ? `${who}: ${text}` : `The cast by ${who}`, 128),
      // on the action's own domain, as the spec has it: a tap opens Remind me with the cast
      targetUrl: `https://${host}/?castHash=${hash}&castFid=${fid}&reminder=1`, tokens: [token],
    },
  }
  await put(r, b.at)
  return { id, at: b.at }
}

async function put(r, due) {
  const file = join(dir, `${due}-${r.id}-${r.key}.json`)
  await writeFile(file + '.tmp', JSON.stringify(r), { mode: 0o600 })
  await rename(file + '.tmp', file)
}

// what no retry will fix: an address that isn't allowed or doesn't exist
const PERMANENT = new Set(['bad url', 'url not allowed'])
const permanent = (e) => PERMANENT.has(e?.message) || e?.code === 'EBLOCKED' || e?.code === 'ENOTFOUND'

/** Sends notification `n` to its token's `url`: 'sent', 'invalid' (the token is off or gone: drop it) or 'retry'. */
export async function deliver(url, n) {
  let result
  if (ours(url)) result = send(n).result
  else {
    let r
    try {
      r = await safeGet(url, { method: 'POST', body: JSON.stringify(n), headers: { 'content-type': 'application/json' }, max: 64e3, timeout: TIMEOUT })
    } catch (e) {
      return permanent(e) ? 'invalid' : 'retry'
    }
    if (r.status === 429 || r.status >= 500) return 'retry'
    if (r.status !== 200) return 'invalid'
    try {
      result = JSON.parse(r.body.toString('utf8'))?.result
    } catch {
      return 'invalid'
    }
  }
  const has = (k) => Array.isArray(result?.[k]) && result[k].includes(n.tokens[0])
  return has('successfulTokens') ? 'sent' : has('rateLimitedTokens') ? 'retry' : 'invalid'
}

async function one(name, now, post) {
  const file = join(dir, name)
  // the other server may have just sent it (deploys)
  const raw = await readFile(file, 'utf8').catch(() => null)
  if (raw === null) return
  let r
  try {
    r = JSON.parse(raw)
  } catch {
    return rm(file, { force: true })
  }
  // a request the host calls bad (400) won't get better
  const out = await post(r.url, r.notification).catch((e) => (e?.status === 400 ? 'invalid' : 'retry'))
  const tries = (r.tries || 0) + 1
  if (out === 'retry' && tries < TRIES && now - r.at < GIVE_UP) await put({ ...r, tries }, now + RETRY).catch(() => {})
  await rm(file, { force: true })
}

let running = false
/** One round: every reminder due by `now` goes out, Quilcast's own first; one that can't yet is put a minute on. */
export async function remindRound(now = Date.now(), post = deliver) {
  if (running) return
  running = true
  try {
    const due = { q: [], r: [] }
    for (const name of await readdir(dir)) {
      const m = name.match(NAME)
      if (m && Number(m[1]) <= now) due[m[3]].push([Number(m[1]), name])
    }
    const oldest = (list) => list.sort((a, b) => a[0] - b[0]).map(([, name]) => name)
    // in-process, so quick: one by one
    for (const name of oldest(due.q)) await one(name, now, post)
    const remote = oldest(due.r).slice(0, PER_ROUND)
    for (let i = 0; i < remote.length; i += AT_ONCE) await Promise.all(remote.slice(i, i + AT_ONCE).map((name) => one(name, now, post)))
  } finally {
    running = false
  }
}

export const watchRemind = (every) => setInterval(() => remindRound().catch((e) => console.error('remind', e)), every).unref()
