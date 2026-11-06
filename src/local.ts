// Anonymous mode (#491): without an account, Follow keeps the person in a list on this device. Nothing is published,
// and clearing the site's data loses it (Settings exports it). Home's Following tab then merges those accounts' casts
// and recasts here, newest first.
//
// Why the merge runs here and not on the node: Hypersnap has /v2/farcaster/feed?feed_type=filter&fids=…, but it reads
// only each account's newest `limit` casts and pages by timestamp, so older pages lose casts; it takes at most 100
// accounts; and it has no recasts. Asking per account (feed/user/casts, and their recasts from reactionsByFid) pages
// exactly and carries recasts. It isn't more private: the node sees the same accounts asked for together, one request
// each. ponytail: the first page costs two or three requests per account, so a list of hundreds is slow to open, and
// the list holds at most IMPORT_MAX: imports stop there, and a Follow tap past it is refused.
//
// This module touches nothing but localStorage, so api.ts can import it.

export type Local = { fid: number; username?: string }
const KEY = 'quilcast:local-follows'
// a username as plain text may spell it (lowercase fname or ENS-style name)
export const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/

const clean = (xs: unknown): Local[] => {
  const seen = new Set<number>()
  const out: Local[] = []
  for (const x of Array.isArray(xs) ? xs : []) {
    const fid = Number(x?.fid)
    if (!Number.isSafeInteger(fid) || fid <= 0 || seen.has(fid)) continue
    seen.add(fid)
    // an imported file can carry anything as a name: one that can't be a username isn't kept (the node's lookup names it)
    out.push(typeof x.username === 'string' && NAME.test(x.username) ? { fid, username: x.username } : { fid })
  }
  return out
}

/** The accounts followed on this device, oldest first. */
export function localFollows(): Local[] {
  try {
    return clean(JSON.parse(localStorage.getItem(KEY)!))
  } catch {
    return []
  }
}
/** Runs a localStorage write; when the browser refuses it (storage full or blocked) it fires "follows-unsaved", which
 *  the app toasts, and returns false. */
const saved = (f: () => void) => {
  try {
    f()
    return true
  } catch {
    dispatchEvent(new Event('follows-unsaved'))
    return false
  }
}
const write = (list: Local[]) => {
  const ok = saved(() => {
    // someone unfollowed leaves the cached page too, so it doesn't paint their casts again
    if (localFollows().some((x) => !list.some((y) => y.fid === x.fid))) localStorage.removeItem(FEED_CACHE)
    list.length ? localStorage.setItem(KEY, JSON.stringify(list)) : localStorage.removeItem(KEY)
  })
  if (ok) dispatchEvent(new Event('follows'))
  return ok
}
export const isLocal = (fid: number) => localFollows().some((x) => x.fid === fid)
/** Follow (`on`) or unfollow someone on this device; false when it couldn't be saved, or when following someone new
 *  with the list full ("follows-full", which the app toasts: an export then always imports back whole). */
export function setLocal(u: Local, on: boolean) {
  const list = localFollows()
  const rest = list.filter((x) => x.fid !== u.fid)
  if (on && rest.length === list.length && list.length >= IMPORT_MAX) {
    dispatchEvent(new Event('follows-full'))
    return false
  }
  return write(on ? [...rest, ...clean([u])] : rest)
}
/** How many more accounts an import may add. */
export const room = () => Math.max(0, IMPORT_MAX - localFollows().length)
/** Imports these into the list, until it holds IMPORT_MAX: `n` were added, `cut` new ones didn't fit. Null when it
 *  couldn't be saved. */
export function addLocal(us: Local[]): { n: number; cut: number } | null {
  const list = localFollows()
  const fresh = clean(us).filter((u) => !list.some((x) => x.fid === u.fid))
  const keep = fresh.slice(0, room())
  if (keep.length && !write([...list, ...keep])) return null
  return { n: keep.length, cut: fresh.length - keep.length }
}
export const removeLocal = (fids: number[]) => write(localFollows().filter((x) => !fids.includes(x.fid)))
// the Following tab's first page as last drawn (app.tsx Feed cacheKey "local:following")
export const FEED_CACHE = 'quilcast:feed:local:following'
export const IMPORT_MAX = 300
/** A first page about to be saved under FEED_CACHE, minus casts and recasts from accounts no longer on the list: a load
 *  that started before an unfollow can end after it, and would otherwise paint that person's casts again. */
export function stillFollowed<C extends { author?: { fid?: number }; recaster?: { fid?: number } | null }>(casts: C[]) {
  const fids = new Set(localFollows().map((x) => x.fid))
  return casts.filter((c) => fids.has(Number(c.recaster ? c.recaster.fid : c.author?.fid)))
}

// Signed in, CarryFollows offers to follow the device's list with the account. It remembers, per account, which
// accounts were on the list when it last answered, so a later sign-in offers again once the list holds someone new.
const askedKey = (account: number) => `quilcast:local-follows:asked:${account}`
/** Whether to offer `account` to follow the list: it holds someone not on it when that account last answered. */
export function toOffer(account: number) {
  let asked: unknown
  try {
    asked = JSON.parse(localStorage.getItem(askedKey(account))!)
  } catch {}
  const seen = new Set(Array.isArray(asked) ? asked : [])
  return localFollows().some((x) => !seen.has(x.fid))
}
/** `account` answered the offer: whoever is on the list now (after any follows went out) isn't offered again. */
export const answered = (account: number) => saved(() => localStorage.setItem(askedKey(account), JSON.stringify(localFollows().map((x) => x.fid))))
// another tab followed or unfollowed someone
try {
  addEventListener('storage', (e) => e.key === KEY && dispatchEvent(new Event('follows')))
} catch {}

/** The list as a file another device can import. */
export const exportLocal = (list = localFollows()) => JSON.stringify({ type: 'quilcast-local-follows', version: 1, follows: list }, null, 2)

/** What an import holds: an export, a JSON list (of FIDs, usernames or {fid, username}), or plain text with FIDs and
 *  @usernames (also profile links) separated by spaces, commas or lines. `names` are usernames still to look up. */
export function parseImport(text: string): { follows: Local[]; names: string[] } {
  let items: unknown[] | null = null
  try {
    const j = JSON.parse(text)
    items = Array.isArray(j) ? j : Array.isArray(j?.follows) ? j.follows : null
  } catch {}
  // anything else (a single FID or name parses as JSON too) is plain text
  items ??= text.split(/[\s,;]+/)
  const follows: Local[] = []
  const names = new Set<string>()
  for (let x of items) {
    if (x && typeof x === 'object') {
      const [l] = clean([x])
      if (l) follows.push(l)
      // one with a username and no FID is looked up by it
      else if (typeof (x as Local).username === 'string') x = '@' + (x as Local).username
      else continue
    }
    // quoted ("alice", as a lone JSON string parses) is the same as bare
    let s = String(x ?? '').trim().replace(/^["']+|["']+$/g, '')
    // a profile link (quilcast.com/u/name, farcaster.xyz/name, warpcast.com/~/profiles/123, with or without https://)
    // counts by its name or FID; any other link (a cast's, quilcast.com/c/0x…, quilcast.com/settings) names no one
    const link = s.match(/^(?:https?:\/\/)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)\/([^?#]*)/i)
    if (link) {
      // Quilcast's own profile links are always /u/<name>
      const ours = /(^|\.)quilcast\.com$/i.test(link[1])
      const who = link[2].replace(/\/$/, '').match(ours ? /^u\/([^/]+)$/ : /^(?:u\/|~\/profiles\/)?([^/]+)$/)
      if (!who) continue
      s = who[1]
    }
    // "!123" is how the app writes a nameless account, while "@123" is a username of digits
    s = s.replace(/[/?#].*$/, '').replace(/^!/, '').toLowerCase()
    const name = s.replace(/^@/, '')
    if (s === name && /^\d{1,10}$/.test(s)) follows.push(...clean([{ fid: +s }]))
    else if (NAME.test(name)) names.add(name)
  }
  return { follows: clean(follows), names: [...names] }
}

// --- the merged feed ---

export type Entry<T> = { ts: number; v: T }
/** One account's stream, newest first: a page of entries after `cursor`, and the cursor for the next (null at the end). */
export type Source<T> = (cursor?: string) => Promise<{ items: Entry<T>[]; cursor: string | null }>

/** Merges streams that each run newest first into one, a page at a time. An entry goes out only once every stream that
 *  isn't finished has one buffered (so nothing newer can still come), which asks each stream for its first page before
 *  the first entry and for another whenever its buffer runs dry. `progress(done, all)` says how many streams have
 *  answered at least once, while the first page waits for them.
 *  A failed request is asked again once, `retryMs` later. A stream that fails twice running while other streams
 *  answered in the meantime is left out (`skipped` lists their indexes), so one account the node can't serve doesn't
 *  hold up the feed; to know, a retry that only failing streams need also reads ahead one stream that's doing fine.
 *  `account(i)` says whose stream `i` is: that read-ahead comes from another account than the failing ones (their other
 *  stream likely fails too), and at the end of the feed an account whose streams are all that's left counts as one.
 *  Answered means any reply from the node, an HTTP error too (a 500 for another account proves the node is up), but not
 *  the failing stream's own, nor a 408, 429 or gateway error (502, 503, 504, 52x), which can come from in front of the
 *  node for every request alike. When nothing answered meanwhile (the node or the network is down: no reply, a timeout
 *  or one of those) none is left out: the page stops at what's certain, or throws when that's nothing, for Retry. A 400 or 404 means the
 *  node has nothing for a stream: it simply ends, keeping what it holds. */
export function merger<T>(sources: Source<T>[], progress?: (done: number, all: number) => void, retryMs = 1500, account: (i: number) => unknown = (i) => i) {
  const st = sources.map((f, i) => ({ i, who: account(i), f, buf: [] as Entry<T>[], cursor: undefined as string | undefined, done: false, empty: 0, fails: 0, since: 0, seen: false, err: undefined as unknown, probed: 0, shy: false, ok: 0 }))
  const skipped: number[] = []
  // rounds of requests; each stream's `ok` is the last one in which the node replied to it
  let round = 0
  const replied = (s: (typeof st)[number]) => st.some((x) => x !== s && x.ok >= s.since)
  const reply = (e: any) => Number.isInteger(e?.status) && ![408, 429, 502, 503, 504].includes(e.status) && e.status < 520
  const page = async (n: number): Promise<{ items: T[]; more: boolean; skipped: number[] }> => {
    const out: T[] = []
    while (out.length < n) {
      const need = st.filter((s) => !s.done && !s.buf.length)
      const r0 = ++round
      // its next page is older than what it holds, so reading it early changes no order. Best from an account other
      // than the failing ones, then one whose last read-ahead didn't fail, then the one read ahead longest ago
      let probe: (typeof st)[number] | undefined
      if (need.length && need.every((s) => s.fails)) {
        const bad = new Set(need.map((s) => s.who))
        const rank = (s: (typeof st)[number]) => (bad.has(s.who) ? 2 : 0) + (s.shy ? 1 : 0)
        for (const s of st) if (!s.done && s.buf.length && (!probe || rank(s) < rank(probe) || (rank(s) === rank(probe) && s.probed < probe.probed))) probe = s
      }
      if (probe) {
        const p = probe
        p.probed = r0
        await p.f(p.cursor).then((r) => {
          p.buf.push(...r.items)
          p.cursor = r.cursor ?? undefined
          p.done = !r.cursor
          p.shy = false
          p.ok = r0
        }, (e) => {
          if (reply(e)) p.ok = r0
          if (e?.status === 400 || e?.status === 404) p.done = p.seen = true
          else p.shy = true
        })
      }
      await Promise.all(need.map((s) => s.f(s.cursor).then((r) => {
        s.buf.push(...r.items)
        s.cursor = r.cursor ?? undefined
        // a page can come back empty and still go on (recasts of deleted casts); five in a row end it
        s.empty = r.items.length ? 0 : s.empty + 1
        s.done = !r.cursor || s.empty >= 5
        s.fails = 0
        s.shy = false
        s.seen = true
        s.ok = r0
      }, (e) => {
        if (e?.status === 400 || e?.status === 404) return void ((s.done = s.seen = true), (s.ok = r0))
        if (!s.fails++) s.since = r0
        // its own error proves the node up only for the others
        if (reply(e)) s.ok = r0
        s.err = e ?? new Error('Network error')
      }).finally(() => progress?.(st.filter((x) => x.seen).length, st.length))))
      const failed = need.filter((s) => !s.done && !s.buf.length && s.fails)
      // with every other account at its end, nothing tells a broken account from a dropped network: it gets one more
      // page (a Retry) before the rest of the feed goes out without it
      for (const s of failed) if (s.fails >= 2 && (replied(s) || (s.fails >= 3 && st.every((x) => x.who === s.who || x.done)))) (s.done = true), skipped.push(s.i)
      const stuck = failed.filter((s) => !s.done)
      if (stuck.some((s) => s.fails < 2)) {
        await new Promise((r) => setTimeout(r, retryMs))
        continue
      }
      if (stuck.length) {
        if (out.length) break
        throw stuck[0].err
      }
      // one that sent an empty page and goes on is asked again before anything goes out
      if (st.some((s) => !s.done && !s.buf.length)) continue
      let best: (typeof st)[number] | null = null
      for (const s of st) if (s.buf.length && (!best || s.buf[0].ts > best.buf[0].ts)) best = s
      if (!best) break
      out.push(best.buf.shift()!.v)
    }
    return { items: out, more: st.some((s) => s.buf.length || !s.done), skipped: [...skipped] }
  }
  return page
}

/** Gives up on `p` after `ms` (the node can stall; fetch itself never times out). */
export function within<R>(p: Promise<R>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([p, new Promise<never>((_, no) => void (timer = setTimeout(() => no(Object.assign(new Error('Network error'), { timeout: true })), ms)))]).finally(() => clearTimeout(timer))
}

/** Runs at most `n` of the calls at a time. */
export function pool(n: number) {
  let active = 0
  const waiting: (() => void)[] = []
  return async <R,>(f: () => Promise<R>) => {
    while (active >= n) await new Promise<void>((r) => waiting.push(r))
    active++
    try {
      return await f()
    } finally {
      active--
      waiting.shift()?.()
    }
  }
}

// Farcaster message timestamps count seconds from 2021-01-01
export const FC_EPOCH = 1609459200
const bare = (h: unknown) => String(h || '').replace(/^0x/i, '').toLowerCase()

type Get = (path: string, q: Record<string, string | number | undefined>) => Promise<any>
/** Two streams per account: their casts (replies too; Home keeps a reply only when it answers someone followed), and
 *  their recasts, each read with the cast it recasts. `recaster` is who a recast shows as recast by. */
export function localSources<C extends { hash: string; timestamp: string }>(list: Local[], get: Get, recaster: (l: Local) => unknown, per = 10): Source<C>[] {
  return list.flatMap((l): Source<C>[] => [
    async (cursor) => {
      // 25 a page, like a profile reads them, so opening one from the feed needs no new request
      const r = await get('/v2/farcaster/feed/user/casts', { fid: l.fid, limit: 25, cursor })
      return { items: ((r.casts || []) as C[]).map((c) => ({ ts: Date.parse(c.timestamp) || 0, v: c })), cursor: r.next?.cursor || null }
    },
    async (cursor) => {
      const r = await get('/v1/reactionsByFid', { fid: l.fid, reaction_type: 'Recast', pageSize: per, reverse: 'true', pageToken: cursor })
      const ms = ((r.messages || []) as any[]).flatMap((m) => {
        const h = bare(m?.data?.reactionBody?.targetCastId?.hash)
        return h && Number.isFinite(m.data.timestamp) ? [{ ts: (m.data.timestamp + FC_EPOCH) * 1000, h }] : []
      })
      const casts: C[] = ms.length ? (await get('/v2/farcaster/casts', { casts: [...new Set(ms.map((m) => m.h))].join(',') })).casts || [] : []
      const by = new Map(casts.map((c) => [bare(c.hash), c]))
      // a recast of a cast that's gone is left out
      return { items: ms.flatMap((m) => (by.has(m.h) ? [{ ts: m.ts, v: { ...by.get(m.h)!, recaster: recaster(l) } }] : [])), cursor: r.nextPageToken || null }
    },
  ])
}
/** Whose stream `i` of localSources is: its account's place in the list. */
export const ofAccount = (i: number) => i >> 1
