// Push notifications for an account's own activity (Settings → Notifications, src/alerts.ts): replies, mentions,
// quotes, likes, recasts and follows, even with Quilcast closed. A browser signs one of its accounts up with that
// account's key, handing over its Web Push subscription and what it wants. Every minute the server reads each
// signed-up account's notifications from the node and pushes what's new through server/push.mjs: likes and recasts
// grouped per cast and follows together ("@a and 4 others liked your cast"), past the account's mutes, blocks and
// muted words (server/mutes.mjs), casts taken down for everyone, and spam when that browser hides it.
//   PUT  /api/alerts/<fid>        sign up, signed "quilcast-alerts:<fid>:<ts>:<body>", body {subscription, kinds, lang, spam}
//   POST /api/alerts/<fid>/state  {endpoint}: what that browser gets for the account ({kinds, lang, spam}), or null
//   POST /api/alerts/<fid>/off    {endpoint}: that browser stops getting them (signing out; the endpoint is the browser's secret)
// Kept per FID in <data>/alerts/<fid>.json: its browsers' subscriptions with the kinds, language and spam settings
// each picked. Every change reads that file and writes it back at once, so during a deploy, while the old and the new
// server run side by side, a change either one answered (a sign-out too) stays, and each re-reads it before looking
// or pushing. <data>/alerts.json keeps, per FID, when it was last looked at and for WINDOW the ids of the
// notifications already handled, so none goes out twice; losing that only risks a push twice. Bursts being counted
// up (below) are kept in memory only.
import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { castText, PLURALS, proxied, wordsRe } from '../src/shared.ts'
import removed from '../src/removed.json' with { type: 'json' }
import { keySigned } from './looks.mjs'
import { readMutes } from './mutes.mjs'
import { fail, keep, parseJson, readText } from './net.mjs'
import { push, validSubscription } from './push.mjs'

// the node's notification types, by the kind people turn on
const KINDS = { reply: 'replies', mention: 'mentions', quote: 'quotes', likes: 'likes', recasts: 'recasts', follows: 'follows' }
const ALL = Object.values(KINDS)
const kindOf = (type) => (Object.hasOwn(KINDS, type) ? KINDS[type] : undefined)
// ponytail: one JSON file and one node request per account a minute; an event stream and a database when thousands sign up
const MAX_FIDS = 5000
const MAX_SUBS = 10
const MAX_ACCOUNTS = 20
// a notification can reach the node a little after its time, so ids are kept this long; nothing older is pushed
const WINDOW = 15 * 60e3
// after the server was down, what happened longer ago than this isn't news any more
const STALE = 3600e3
// a new reply the spam service hasn't scored yet waits up to this long, for browsers that hide spam
const HOLD = 3 * 60e3
// one minute's pushes per account and browser; the rest become one "N more" that opens Notifications
const MAX_PUSHES = 4
// likes, recasts and follows within this long add up into one notification, which each new one replaces
const BURST = 30 * 60e3

let dir = ''
// per FID: its browsers (subs, as on disk when last read) and what the looks keep (since, checked, seen)
let db = { fids: {} }
let timer
let due = 0

// --- the browsers, one file per account ---

const subsFile = (fid) => join(dir, 'alerts', `${fid}.json`)
/** The account's browsers as on disk now: none when it has no file. A file that can't be read throws, so nothing is
 *  decided (or written over) from it. */
function readSubs(fid) {
  try {
    const subs = JSON.parse(readFileSync(subsFile(fid), 'utf8'))?.subs
    return Array.isArray(subs) ? subs : []
  } catch (e) {
    if (e.code === 'ENOENT') return []
    if (e instanceof SyntaxError) return console.error('alerts', fid, 'unreadable, dropped', e.message), []
    throw e
  }
}
/** Into memory: the account with these browsers (from disk by default), or gone when there are none. */
function sync(fid, subs = readSubs(fid)) {
  if (!subs.length) return void delete db.fids[fid]
  // an account new here (signed up on the other server during a deploy) gets what happens from now on
  const a = (db.fids[fid] ||= { since: Date.now(), seen: {} })
  a.subs = subs
  return a
}
// a file is written whole or not at all, through a temporary file of its own (both servers write here during a
// deploy, each as pid 1 in its container), which goes when the write fails
const tmpOf = (file) => `${file}.${randomUUID()}.tmp`
function putSync(file, json) {
  const tmp = tmpOf(file)
  try {
    writeFileSync(tmp, json, { mode: 0o600 })
    renameSync(tmp, file)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
}
async function put(file, json) {
  const tmp = tmpOf(file)
  try {
    await writeFile(tmp, json, { mode: 0o600 })
    await rename(tmp, file)
  } catch (e) {
    await rm(tmp, { force: true })
    throw e
  }
}
/** Change the account's browsers from what's on disk now and write them back before answering (no await between, so
 *  the other server's change to the same file isn't lost). */
function edit(fid, change) {
  const subs = change(readSubs(fid))
  if (subs.length) {
    mkdirSync(join(dir, 'alerts'), { recursive: true })
    putSync(subsFile(fid), JSON.stringify({ subs }))
  } else rmSync(subsFile(fid), { force: true })
  persist()
  return sync(fid, subs)
}
/** The FIDs with a file, or null when the folder can't be read. */
function fidsOnDisk() {
  try {
    return readdirSync(join(dir, 'alerts')).flatMap((f) => (/^[1-9]\d{0,9}\.json$/.test(f) ? [Number(f.slice(0, -5))] : []))
  } catch (e) {
    if (e.code === 'ENOENT') return []
    console.error('alerts', e.message)
    return null
  }
}

// --- what the looks keep, in alerts.json ---

const looks = () => ({ fids: Object.fromEntries(Object.entries(db.fids).map(([fid, a]) => [fid, { since: a.since, checked: a.checked, seen: a.seen }])) })
// the write under way, so the last one (flushAlerts) lands after it; one that failed doesn't stop the next
let writing = Promise.resolve()
const write = () => {
  timer = undefined
  const file = join(dir, 'alerts.json')
  const json = JSON.stringify(looks())
  writing = writing.catch(() => {}).then(() => put(file, json))
  return writing
}
// written a second after the last change, and at least every five seconds while changes keep coming
const persist = () => {
  if (!due) due = Date.now() + 5000
  clearTimeout(timer)
  timer = setTimeout(() => ((due = 0), write().catch((e) => console.error('alerts', e.message))), Math.max(0, Math.min(1000, due - Date.now())))
}
/** Write what's kept now, after any write under way, before the process stops (SIGTERM, a deploy). */
export async function flushAlerts() {
  if (!dir) return
  clearTimeout(timer)
  timer = undefined
  await writing.catch(() => {})
  putSync(join(dir, 'alerts.json'), JSON.stringify(looks()))
}
export function loadAlerts(dataDir) {
  dir = dataDir
  let kept = {}
  try {
    kept = JSON.parse(readFileSync(join(dir, 'alerts.json'), 'utf8'))?.fids || {}
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('alerts: alerts.json unreadable, looks start over', e.message)
  }
  db = { fids: {} }
  for (const fid of fidsOnDisk() || []) {
    const k = kept[fid]
    db.fids[fid] = { since: Number(k?.since) || Date.now(), checked: k?.checked, seen: k?.seen && typeof k.seen === 'object' ? k.seen : {} }
    try {
      sync(fid)
    } catch (e) {
      // left for the first round to read again
      console.error('alerts', fid, e.message)
      db.fids[fid].subs = []
    }
  }
}

// --- words ---

const LANGS = new Set(['ar', 'de', 'es', 'fr', 'hi', 'id', 'it', 'ja', 'ko', 'nl', 'pl', 'pt-BR', 'pt-PT', 'ru', 'sv', 'th', 'tr', 'uk', 'vi', 'zh-Hans', 'zh-Hant'])
const dicts = new Map()
const dict = (lang) => {
  if (!LANGS.has(lang)) return {}
  if (!dicts.has(lang)) {
    try {
      dicts.set(lang, JSON.parse(readFileSync(new URL(`../src/locales/${lang}.json`, import.meta.url), 'utf8')))
    } catch {
      dicts.set(lang, {})
    }
  }
  return dicts.get(lang)
}
const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (m, k) => (Object.hasOwn(vars, k) ? String(vars[k]) : m))
// the app's strings (src/i18n.ts), in the language the browser signed up with
export const say = (lang, s, vars = {}) => fill(dict(lang)[s] || s, vars)
const sayN = (lang, n, one, other, vars = {}) => {
  const got = dict(lang)[`${one}|${other}`]
  const forms = (got || `${one}|${other}`).split('|')
  const l = got ? lang : 'en'
  const i = PLURALS[l].indexOf(new Intl.PluralRules(l).select(n))
  return fill(forms[i < 0 ? forms.length - 1 : Math.min(i, forms.length - 1)], { n, ...vars })
}
// cut by characters, so an emoji isn't split in half
const cut = (s, n) => ([...s].length > n ? [...s].slice(0, n - 1).join('') + '…' : s)

// --- signing up ---

const cleanKinds = (xs) => ALL.filter((k) => Array.isArray(xs) && xs.includes(k))
// how many accounts each browser gets notifications for
const sharing = () => {
  const n = new Map()
  for (const a of Object.values(db.fids)) for (const s of a.subs) n.set(s.endpoint, (n.get(s.endpoint) || 0) + 1)
  return n
}
const settingsOf = (s) => ({ kinds: s.kinds, lang: s.lang, spam: s.spam })

export async function putAlerts(req, fid, node) {
  const body = await readText(req, 8000)
  await keySigned(req, 'quilcast-alerts', fid, body, node, () => fail(401, 'Sign in again to turn notifications on.'))
  const b = parseJson(body)
  const s = b?.subscription
  if (!validSubscription(s)) throw fail(400, 'bad subscription')
  const kinds = cleanKinds(b.kinds)
  if (!kinds.length) throw fail(400, 'bad kinds')
  const had = sync(fid)
  const known = had?.subs.some((x) => x.endpoint === s.endpoint)
  if (!had && Object.keys(db.fids).length >= MAX_FIDS) throw fail(429, 'Too many accounts get notifications right now. Try again later.')
  if (!known && had?.subs.length >= MAX_SUBS) throw fail(429, 'This account gets notifications on too many devices. Turn them off on one of them first.')
  if (!known && (sharing().get(s.endpoint) || 0) >= MAX_ACCOUNTS) throw fail(429, 'This browser gets notifications for too many accounts.')
  const at = Number(b.spam?.at)
  const sub = {
    endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth }, kinds,
    lang: LANGS.has(b.lang) ? b.lang : 'en',
    // the browser's own spam settings (src/spam.ts), so spam it hides doesn't reach it either
    spam: { casts: b.spam?.casts === true, accounts: b.spam?.accounts === true, at: Number.isInteger(at) && at >= 50 && at <= 99 ? at : 70 },
  }
  // new settings (a kind ticked, spam shown) count from the account's last look: what was judged before stays as it
  // was, and what came after (or still waits for its spam score) goes by the new ones
  const prev = had?.subs.find((x) => x.endpoint === s.endpoint)
  sub.since = prev && JSON.stringify(settingsOf(prev)) === JSON.stringify(settingsOf(sub)) ? prev.since : (had?.checked ?? Date.now())
  edit(fid, (subs) => [...subs.filter((x) => x.endpoint !== s.endpoint), sub])
  return settingsOf(sub)
}

const endpointOf = async (req) => {
  const e = parseJson(await readText(req, 2000))?.endpoint
  if (typeof e !== 'string' || !e) throw fail(400, 'bad endpoint')
  return e
}

export async function alertState(req, fid) {
  const e = await endpointOf(req)
  const s = sync(fid)?.subs.find((x) => x.endpoint === e)
  return s ? settingsOf(s) : null
}

export async function offAlerts(req, fid) {
  forget(fid, await endpointOf(req))
  return { ok: true }
}

const forget = (fid, endpoint) => edit(fid, (subs) => subs.filter((s) => s.endpoint !== endpoint))

/** The account is deleted (server/account.mjs): its browsers stop getting its notifications, a look already under way included. */
export function dropAlerts(fid) {
  const had = readSubs(fid).length > 0
  edit(fid, () => [])
  return had
}

/** One push to each browser that gets the account's notifications, whatever kinds it picked: `make(lang)` words it
 *  (a scheduled cast that failed, server/scheduled.mjs). A tap opens it as the account. */
export async function pushTo(fid, make, send = (sub, data) => push(dir, sub, data)) {
  if (!dir) return
  await Promise.all(readSubs(fid).map(async (sub) => {
    const m = make(sub.lang)
    const status = await send(sub, { ...m, fid, ...(m.tag && { tag: `${fid}:${m.tag}` }) }).catch(() => 0)
    if (status === 404 || status === 410) forget(fid, sub.endpoint)
  }))
}

// --- watching ---

const idOf = (n) => `${n.type}:${n.cast?.hash || ''}:${n.user.fid}`
const ofCast = (n) => n.type === 'reply' || n.type === 'mention' || n.type === 'quote'
const timeOf = (n) => Date.parse(n.timestamp) || 0

/** Whether a notification stays out: taken down for everyone, from someone muted or blocked, or a cast with a muted word. */
export function hidden(n, mutes, words = wordsRe(mutes.words.map((w) => w.v))) {
  const fid = n.user.fid
  if (removed.fids.includes(fid) || (n.cast && removed.casts.includes(n.cast.hash))) return true
  if (mutes.users.some((m) => m.v === fid) || mutes.blocks.some((m) => m.v === fid)) return true
  return ofCast(n) && !!n.cast && !!words?.test(castText(n.cast))
}

/** Scores (0-1) from the spam service for these cast hashes and FIDs; what it can't answer in time stays unknown. */
// scores already given, for WINDOW, so what stays out isn't asked about every minute
const scored = new Map()
/** Scores (0-1) from the spam service for these cast hashes and FIDs. One it hasn't scored yet is missing; when it
 *  can't answer, that half is null and everything it would judge counts as spam this time. */
async function spamScores(spamUrl, hashes, fids, now = Date.now()) {
  const ask = async (path, pre, keys) => {
    const out = {}
    const want = []
    for (const k of new Set(keys)) {
      const hit = scored.get(pre + k)
      if (hit && hit.at > now - WINDOW) out[k] = hit.v
      else want.push(k)
    }
    if (!want.length) return out
    try {
      const r = await fetch(`${spamUrl}/${path}${want.slice(0, 100).join(',')}`, { signal: AbortSignal.timeout(3000) })
      if (!r.ok) return null
      const j = await r.json()
      for (const k of want) if (typeof j?.[k] === 'number') (out[k] = j[k]), keep(scored, 50e3, pre + k, { v: j[k], at: now })
      return out
    } catch {
      return null
    }
  }
  const [casts, users] = await Promise.all([ask('scores?h=', 'c', hashes), ask('users?fid=', 'u', fids)])
  return { casts, users }
}
const NONE = { casts: {}, users: {} }
const spammy = (n, spam, scores) =>
  (spam.accounts && (!scores.users || scores.users[n.user.fid] * 100 >= spam.at)) ||
  (spam.casts && ofCast(n) && !!n.cast && (!scores.casts || scores.casts[n.cast.hash] * 100 >= spam.at))
/** Whether `sub` gets `n`: a kind it asked for, after its settings last changed, past its spam settings. */
const gets = (sub, n, scores) => sub.kinds.includes(kindOf(n.type)) && timeOf(n) > (sub.since || 0) && !spammy(n, sub.spam, scores)

/** Likes and recasts per cast and follows together; replies, mentions and quotes one by one. Newest first. */
export function group(notes) {
  const out = new Map()
  for (const n of notes) {
    const k = n.type === 'likes' || n.type === 'recasts' ? `${n.type}:${n.cast?.hash}` : n.type === 'follows' ? 'follows' : idOf(n)
    const g = out.get(k)
    if (g) !g.users.some((u) => u.fid === n.user.fid) && g.users.push(n.user)
    else out.set(k, { key: k, type: n.type, cast: n.cast, users: [n.user] })
  }
  return [...out.values()]
}

// likes, recasts and follows still adding up, per browser, account and cast: who so far (their FIDs, to count them,
// and the newest three, to name them) and when the last came
const bursts = new Map()
const counted = (g) => g.type === 'likes' || g.type === 'recasts' || g.type === 'follows'
/** The group with the newest people from its burst so far and how many there are; the burst keeps them for the next one. */
function addUp(endpoint, fid, g, now) {
  if (!counted(g)) return g
  const k = `${endpoint}|${fid}|${g.key}`
  const had = bursts.get(k)
  const live = had && had.at > now - BURST ? had : null
  const mine = new Set(g.users.map((u) => u.fid))
  const fids = [...mine, ...(live?.fids || []).filter((f) => !mine.has(f))].slice(0, 1000)
  const users = [...g.users, ...(live?.users || []).filter((u) => !mine.has(u.fid))].slice(0, 3)
  bursts.delete(k)
  keep(bursts, 20e3, k, { at: now, fids, users: users.map((u) => ({ fid: u.fid, username: u.username, display_name: u.display_name, pfp_url: u.pfp_url })) })
  return { ...g, users, count: fids.length }
}
// bursts that ended go, at the start of each round
const sweep = (now) => {
  for (const [k, b] of bursts) b.at <= now - BURST && bursts.delete(k)
}

const nameOf = (u) => cut(String(u.display_name || (u.username && !u.username.startsWith('fid:') ? `@${u.username}` : `!${u.fid}`)), 60)
const pathOf = (u) => `/u/${u.username && !u.username.startsWith('fid:') ? u.username : u.fid}`
const excerpt = (c, lang) => cut(castText(c || {}).replace(/\s+/g, ' ').trim(), 140) || say(lang, 'Your cast')

/** One push for a group, in `lang`. A `tag` makes the next one for the same cast (or the follows) replace it. */
export function message(g, lang) {
  const first = g.users[0]
  const others = (g.count ?? g.users.length) - 1
  const name = nameOf(first)
  // the avatar through /api/img, so its host doesn't see who got the notification (shared.ts proxied)
  const icon = typeof first.pfp_url === 'string' && /^https:\/\//.test(first.pfp_url) && first.pfp_url.length < 1024 ? proxied(first.pfp_url) : undefined
  const cast = g.cast ? `/c/${g.cast.hash}` : '/notifications'
  if (g.type === 'likes') return { title: others ? sayN(lang, others, '{name} and {n} other liked your cast', '{name} and {n} others liked your cast', { name }) : say(lang, '{name} liked your cast', { name }), body: excerpt(g.cast, lang), icon, url: cast, tag: g.key }
  if (g.type === 'recasts') return { title: others ? sayN(lang, others, '{name} and {n} other recast your cast', '{name} and {n} others recast your cast', { name }) : say(lang, '{name} recast your cast', { name }), body: excerpt(g.cast, lang), icon, url: cast, tag: g.key }
  if (g.type === 'follows') return { title: others ? sayN(lang, others, '{name} and {n} other followed you', '{name} and {n} others followed you', { name }) : say(lang, '{name} followed you', { name }), body: g.users.slice(0, 3).map(nameOf).join(', '), icon, url: others ? '/notifications' : pathOf(first), tag: g.key }
  const title = g.type === 'reply' ? say(lang, '{name} replied', { name }) : g.type === 'mention' ? say(lang, '{name} mentioned you', { name }) : say(lang, '{name} quoted your cast', { name })
  return { title, body: excerpt(g.cast, lang), icon, url: cast }
}

/** The pushes for one browser: what it asked for, past its spam settings, at most MAX_PUSHES. `name` ("@name" or
 *  "!<fid>") marks them as the account's when the browser gets several accounts' notifications. */
export function pushesFor(sub, fid, notes, scores, name, now = Date.now()) {
  const list = group(notes.filter((n) => gets(sub, n, scores))).map((g) => message(addUp(sub.endpoint, fid, g, now), sub.lang))
  const out = list.length > MAX_PUSHES ? [...list.slice(0, MAX_PUSHES - 1), { title: sayN(sub.lang, list.length - MAX_PUSHES + 1, '{n} more notification', '{n} more notifications'), body: '', url: '/notifications', tag: 'more' }] : list
  // the account goes along, so a tap opens the page as that account (src/app.tsx)
  return out.map((m) => ({ ...m, fid, ...(m.tag && { tag: `${fid}:${m.tag}` }), ...(name && { title: `${m.title} · ${name}` }) }))
}

// usernames for "· @name", from the node, kept in memory for an hour
const names = new Map()
/** "@name", or the app's "!<fid>" when the account has no username or the node didn't answer (that isn't kept). */
const usernameOf = (node, fid) => {
  const hit = names.get(fid)
  if (hit && hit.at > Date.now() - 3600e3) return hit.name
  const fail = () => (names.delete(fid), `!${fid}`)
  const name = fetch(`${node}/v2/farcaster/user/bulk?fids=${fid}`, { signal: AbortSignal.timeout(5000) })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      const u = j?.users?.[0]?.username
      return !j ? fail() : typeof u === 'string' && !u.startsWith('fid:') ? `@${u}` : `!${fid}`
    }, fail)
  keep(names, 20e3, fid, { at: Date.now(), name })
  return name
}

/** Look for news for one account and push it. `send` resolves the push service's status; `shared` counts each
 *  browser's accounts. */
export async function check(fid, { node, spamUrl, send = (sub, data) => push(dir, sub, data), now = Date.now(), shared = sharing() }) {
  const a = sync(fid)
  if (!a) return
  const r = await fetch(`${node}/v2/farcaster/notifications?fid=${fid}&limit=50&include_quotes_and_deep_replies=true`, { signal: AbortSignal.timeout(8000) })
  if (!r.ok) throw new Error(`node answered ${r.status}`)
  const notes = ((await r.json())?.notifications || []).filter((n) => Number.isSafeInteger(n?.user?.fid) && kindOf(n.type) && (n.type === 'follows' || typeof n.cast?.hash === 'string'))
  const floor = Math.max(a.since || 0, now - STALE)
  const fresh = notes.filter((n) => timeOf(n) > floor && !Object.hasOwn(a.seen, idOf(n)))
  // what no browser could get anyway (the account's own, kinds turned off, from before a browser's settings changed)
  // is left out before asking anyone
  const wanted = fresh.filter((n) => n.user.fid !== fid && a.subs.some((s) => s.kinds.includes(kindOf(n.type)) && timeOf(n) > (s.since || 0)))
  // browsers that hide spam get a new reply once the spam service has scored it (or a few minutes have gone by)
  const careful = a.subs.some((s) => s.spam.casts || s.spam.accounts)
  const scores = careful && wanted.length ? await spamScores(spamUrl, wanted.filter(ofCast).map((n) => n.cast.hash), wanted.map((n) => n.user.fid), now) : NONE
  // (while the spam service is down, what it would judge waits for every browser: one sent to a browser that shows
  // spam would be marked seen, and the browser that hides it would never get it)
  const hideCasts = a.subs.some((s) => s.spam.casts)
  const usersDown = a.subs.some((s) => s.spam.accounts) && !scores.users
  const held = wanted.filter((n) => now - timeOf(n) < HOLD && (usersDown || (hideCasts && ofCast(n) && (!scores.casts || scores.casts[n.cast.hash] === undefined))))
  // only what's sent to some browser is kept (for WINDOW), so it isn't sent again: what nobody gets (from people the
  // account mutes, spam, or held while the spam service is down) is looked at again next time and never stored
  const news = wanted.filter((n) => !held.includes(n))
  // what this look judged: everything until now, but for what's still held
  a.checked = Math.min(now, ...held.map((n) => timeOf(n) - 1))
  const mutes = news.length ? await readMutes(fid) : null
  const words = mutes && wordsRe(mutes.words.map((w) => w.v))
  const kept = mutes ? news.filter((n) => !hidden(n, mutes, words)) : []
  const sent = kept.filter((n) => a.subs.some((s) => gets(s, n, scores)))
  const before = Object.keys(a.seen).length
  a.since = Math.max(a.since || 0, now - WINDOW)
  for (const n of sent) a.seen[idOf(n)] = timeOf(n)
  for (const [id, at] of Object.entries(a.seen)) at <= a.since && delete a.seen[id]
  if (sent.length || Object.keys(a.seen).length !== before) persist()
  if (!sent.length) return
  // the browsers as they are now: one signed out (or the account deleted) while the node answered gets nothing
  const live = sync(fid)
  if (!live) return
  await Promise.all([...live.subs].map(async (sub) => {
    const name = (shared.get(sub.endpoint) || 0) > 1 ? await usernameOf(node, fid) : undefined
    for (const m of pushesFor(sub, fid, sent, scores, name, now)) {
      const status = await send(sub, m).catch(() => 0)
      // a subscription the browser dropped is forgotten
      if (status === 404 || status === 410) return forget(fid, sub.endpoint)
    }
  }))
}

/** Check every signed-up account, four at a time, then again a minute after the round ends. A deploy that runs the old
 *  and the new server side by side for longer than the first round (10 s) can push something twice. */
export function watchAlerts({ node, spamUrl, every = 60e3 }) {
  const round = async () => {
    // the accounts on disk, those the other server signed up during a deploy too; each look reads its browsers again
    const fids = fidsOnDisk() ?? Object.keys(db.fids).map(Number)
    const disk = new Set(fids)
    for (const fid of Object.keys(db.fids)) disk.has(Number(fid)) || delete db.fids[fid]
    const shared = sharing()
    sweep(Date.now())
    let i = 0
    const next = async () => {
      while (i < fids.length) {
        const fid = fids[i++]
        await check(fid, { node, spamUrl, shared }).catch((e) => console.error('alerts', fid, e.message))
      }
    }
    await Promise.all([next(), next(), next(), next()])
    setTimeout(round, every).unref()
  }
  setTimeout(round, Math.min(every, 10e3)).unref()
}

/** Tests only: replace what's kept (each account's browsers written to its file), and forget the bursts. */
export const _db = (d) => {
  if (!d) return db
  for (const fid of fidsOnDisk() || []) rmSync(subsFile(fid), { force: true })
  db = { fids: {} }
  for (const [fid, { subs, ...looked }] of Object.entries(d.fids)) (db.fids[fid] = looked), edit(fid, () => subs)
  bursts.clear()
  scored.clear()
  return db
}
/** Tests only: write what the looks keep now. */
export const _write = write
