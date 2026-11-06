// Counts, never people (#480): how many accounts used our server's signed endpoints each UTC day, and how many first
// sign-ins each campaign link brought. Both are public at GET /api/stats, the last 90 days with today so far.
//   <data>/stats/counts.json  { since, signedIn: { day: n }, campaigns: { day: { campaign: n } } }: all that stays
//   <data>/stats/today.json   { day, salt, seen }: today's accounts as hashes salted for the day, so a restart doesn't
//                             count them twice; the next day replaces the file, salt and all
// Nothing ties a campaign to an account: which accounts brought a sign-up today is kept in memory only, never written.
import { createHmac, randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const CAMPAIGN = /^[A-Za-z0-9_-]{1,64}$/
const DAY = /^\d{4}-\d{2}-\d{2}$/
const DAYS = 90
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10)

// maps with no prototype, so a campaign called "toString" or "__proto__" is a key like any other
const map = () => Object.create(null)
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const isCount = (v) => Number.isSafeInteger(v) && v >= 0
// what's read back keeps only well-formed days, campaigns and counts
function counted(v, key = DAY) {
  const m = map()
  if (isObj(v)) for (const k of Object.keys(v)) if (key.test(k) && isCount(v[k])) m[k] = v[k]
  return m
}

let dir = ''
let counts = { since: '', signedIn: map(), campaigns: map() }
let today = null

async function put(name, v) {
  await writeFile(join(dir, name + '.tmp'), JSON.stringify(v))
  await rename(join(dir, name + '.tmp'), join(dir, name))
}

// a kept file that's missing reads as nothing; one that won't parse (torn by a crash) is set aside and counting goes on.
// The counts file (numbers only) is moved aside, so the next save doesn't write over what's left of it; today's file
// (the day's salt beside its accounts' hashes) is deleted, so no account outlives its day.
async function from(d, name, keep) {
  const text = await readFile(join(d, name), 'utf8').catch(() => null)
  if (text === null) return null
  try {
    const v = JSON.parse(text)
    if (v && typeof v === 'object') return v
  } catch {}
  const bad = `${name}.bad-${Date.now()}`
  console.error('stats: unreadable', name, keep ? `moved to ${bad}` : 'deleted')
  await (keep ? rename(join(d, name), join(d, bad)) : unlink(join(d, name))).catch((e) => console.error('stats', e))
  return null
}

let loaded
/** Resolves once loadStats has read what's kept (whether or not that worked). */
export const ready = new Promise((r) => (loaded = r))

// counting starts once what's kept is read, so a request during start-up can't be overwritten by it
export async function loadStats(dataDir) {
  try {
    const d = join(dataDir, 'stats')
    await mkdir(d, { recursive: true })
    const [c, t] = [await from(d, 'counts.json', true), await from(d, 'today.json', false)]
    // anything else of today's file left behind (an unfinished write, one set aside before) goes too
    for (const f of await readdir(d)) if (f.startsWith('today.json') && f !== 'today.json') await unlink(join(d, f)).catch(() => {})
    const campaigns = map()
    if (isObj(c?.campaigns)) for (const day of Object.keys(c.campaigns)) if (DAY.test(day)) campaigns[day] = counted(c.campaigns[day], CAMPAIGN)
    counts = { since: typeof c?.since === 'string' && DAY.test(c.since) ? c.since : '', signedIn: counted(c?.signedIn), campaigns }
    today =
      typeof t?.day === 'string' && DAY.test(t.day) && typeof t.salt === 'string' && t.salt && Array.isArray(t.seen)
        ? { day: t.day, salt: t.salt, seen: new Set(t.seen.filter((h) => typeof h === 'string')), joined: new Set() }
        : null
    counts.since ||= today?.day || ''
    // a lost or torn counts file: that day's count is at least its accounts kept
    if (today) counts.signedIn[today.day] = Math.max(counts.signedIn[today.day] || 0, today.seen.size)
    dir = d
    roll()
    midnight()
  } catch (e) {
    console.error('stats: not counting', e)
  } finally {
    loaded()
  }
}

// one write at a time; a change made during one is written by the next
let writing = Promise.resolve()
let queued = false
function save() {
  if (queued) return writing
  queued = true
  return (writing = writing
    .then(() => {
      queued = false
      return Promise.all([put('counts.json', counts), put('today.json', { day: today.day, salt: today.salt, seen: [...today.seen] })])
    })
    .catch((e) => console.error('stats', e)))
}

// a new UTC day: yesterday's count is already in counts, so its accounts and salt go, and so do days older than any
// /api/stats answer shows
function roll(now = Date.now()) {
  const day = dayOf(now)
  if (today?.day === day) return
  today = { day, salt: randomBytes(16).toString('hex'), seen: new Set(), joined: new Set() }
  counts.since ||= day
  const oldest = dayOf(Date.parse(day) - (DAYS - 1) * 864e5)
  for (const kept of [counts.signedIn, counts.campaigns]) for (const d of Object.keys(kept)) if (d < oldest) delete kept[d]
  if (dir) save()
}

// the day rolls at UTC midnight even when no request comes, so yesterday's salt and hashes don't wait on disk for one
let timer
function midnight() {
  clearTimeout(timer)
  const next = Date.parse(dayOf(Date.now())) + 864e5 + 1e3
  timer = setTimeout(() => (roll(), midnight()), Math.min(Math.max(next - Date.now(), 1e3), 864e5))
  timer.unref?.()
}

const valid = (fid) => Number.isSafeInteger(fid) && fid > 0
const hash = (what, fid) => createHmac('sha256', today.salt).update(`${what}:${fid}`).digest('hex').slice(0, 32)

/** An account's signed request got through (looks.mjs keySigned): it counts once toward today. */
export function seen(fid) {
  fid = Number(fid)
  if (!valid(fid)) return
  if (!dir) return void ready.then(() => dir && seen(fid))
  roll()
  const h = hash('seen', fid)
  if (today.seen.has(h)) return
  today.seen.add(h)
  // never below what was counted already, should today's file have gone missing
  counts.signedIn[today.day] = Math.max(counts.signedIn[today.day] || 0, today.seen.size)
  save()
}

/** A first sign-in in a browser that arrived through `campaign`'s link, from the account `fid` (already checked by its
 *  signature); whether it counted. An account counts once a day, whatever the campaign (in memory only: after a
 *  restart it could count once more that day). Await `ready` first, or a sign-up during start-up isn't counted. */
export function joined(fid, campaign) {
  fid = Number(fid)
  if (!dir || !valid(fid) || typeof campaign !== 'string' || !CAMPAIGN.test(campaign)) return false
  roll()
  const h = hash('joined', fid)
  if (today.joined.has(h)) return false
  today.joined.add(h)
  const day = (counts.campaigns[today.day] ||= map())
  day[campaign] = (day[campaign] || 0) + 1
  save()
  return true
}

/** What GET /api/stats answers: every day from the first counted one (at most 90 back) to today, and each day's
 *  campaigns that brought a sign-up. */
export function stats(now = Date.now()) {
  roll(now)
  const signedIn = []
  const campaigns = []
  const from = Math.max(Date.parse(counts.since) || 0, Date.parse(dayOf(now)) - (DAYS - 1) * 864e5)
  for (let t = from; t <= now; t += 864e5) {
    const day = dayOf(t)
    signedIn.push({ day, count: counts.signedIn[day] || 0 })
    for (const campaign of Object.keys(counts.campaigns[day] || {}).sort()) campaigns.push({ day, campaign, count: counts.campaigns[day][campaign] })
  }
  return { signedIn, campaigns }
}

/** Waits for the files to be written (tests). */
export const flushStats = () => writing
