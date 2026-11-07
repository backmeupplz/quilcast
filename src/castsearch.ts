// Searching one account's casts (#495). The node's cast search can't be narrowed to an author (its index has no
// author field: `fid:3` answers "not declared as indexed"), so this reads the account's own casts from the node's hub
// API instead, newest first, 1000 a page, and keeps the ones whose text has every word searched for, top-level casts
// and replies alike. The matches are then read in full, like any feed's casts.
// ponytail: a hub cast's text has its @mentions cut out (they're FIDs beside it), so a mentioned name isn't found
import type { Cast } from './api.ts'

type Get = (path: string, q: Record<string, string | number | undefined>, fresh?: boolean) => Promise<any>
type Page = { items: { h: string; text: string }[]; next: string | null }

// a feed's page of matches
const WANT = 25
// ponytail: one load reads at most 50 pages (50,000 casts) before it hands back what it found; when that's nothing,
// the feed ends there (`capped` says so, for the empty note), so a word only in a very busy account's older casts
// isn't found
const PAGES = 50
/** The most casts one load reads (1000 a hub page). */
export const MOST = PAGES * 1000
// pages kept as hashes and text, so a narrower search or "load more" reads no older page twice; the raw pages are
// ~750 KB and are never kept. A search's first load reads the newest page again, so a new cast is found.
const KEEP = 60

/** Lowercase, without Latin accents, so "cafe" finds "Café". Only accents on a Latin letter go, and the rest is put back
 *  together: other scripts' marks are part of the letter (Japanese dakuten, Hindi matras, Thai vowels and tones,
 *  Cyrillic й and ё, Korean syllables' parts), so "か" doesn't find "が", nor "мой" "мои". */
const fold = (s: string) => s.normalize('NFKD').replace(/(\p{Script=Latin})[̀-ͯ]+/gu, '$1').normalize('NFC').toLowerCase()
/** The words of a search. */
export const words = (q: string) => fold(q).split(/\s+/).filter(Boolean)
/** Whether a cast's text has every word in it. */
export const matches = (text: string, ws: string[]) => {
  const f = fold(text)
  return ws.length > 0 && ws.every((w) => f.includes(w))
}

const pages = new Map<string, Promise<Page>>()
function page(get: Get, fid: number, token: string, fresh = false): Promise<Page> {
  const k = `${fid}:${token}`
  const hit = pages.get(k)
  pages.delete(k)
  if (hit && !fresh) return pages.set(k, hit), hit
  const p = get('/v1/castsByFid', { fid, pageSize: 1000, reverse: 'true', pageToken: token || undefined }, true).then((r) => ({
    items: ((r?.messages || []) as any[]).flatMap((m) => (m?.data?.type === 'MESSAGE_TYPE_CAST_ADD' && typeof m.hash === 'string' ? [{ h: m.hash.replace(/^0x/i, '').toLowerCase(), text: String(m.data.castAddBody?.text || '') }] : [])),
    next: r?.nextPageToken || null,
  }))
  pages.set(k, p)
  p.catch(() => pages.get(k) === p && pages.delete(k))
  for (const old of pages.keys()) if (pages.size > KEEP) pages.delete(old); else break
  return p
}

/** The casts with these hashes, in this order; one the node can't find is left out. */
async function full(get: Get, hs: string[]): Promise<Cast[]> {
  const by = new Map<string, Cast>()
  for (let i = 0; i < hs.length; i += 50) {
    const r = await get('/v2/farcaster/casts', { casts: hs.slice(i, i + 50).join(',') })
    for (const c of (r?.casts || r?.result?.casts || []) as Cast[]) by.set(c.hash.replace(/^0x/i, '').toLowerCase(), c)
  }
  return hs.flatMap((h) => by.get(h) || [])
}

/** A page of `fid`'s casts matching `q`, newest first, as a feed reads them. The cursor is where the reading stopped:
 *  `<hub page token>` to start at a page, `<last hash read>:<hub page token>` to go on in it. `capped` is set when the
 *  load stopped at PAGES with nothing found. `live` says whether the search is still wanted: once it isn't (another
 *  search, another page), no more pages are read and the load ends with what it has. */
export async function searchCasts(get: Get, fid: number, q: string, cursor?: string, live: () => boolean = () => true): Promise<{ casts: Cast[]; next: { cursor: string | null }; capped?: true }> {
  const ws = words(q)
  const m = cursor?.match(/^([0-9a-f]{40}):(.*)$/)
  let token = m ? m[2] : cursor || ''
  let after = m?.[1]
  const casts: Cast[] = []
  for (let read = 0; ; ) {
    if (!live()) return { casts, next: { cursor: null } }
    const p = await page(get, fid, token, !cursor && !read)
    // where the last load stopped; a page read again since (it was dropped from the kept ones) may have moved, and
    // then it starts over at its top: the feed leaves out what it already shows
    const at = after ? p.items.findIndex((x) => x.h === after) + 1 : 0
    after = undefined
    let i = at
    // matches the node can't find in full (gone, or not there yet) are left out, and the page read on for others
    while (i < p.items.length && casts.length < WANT) {
      const hits: string[] = []
      for (; i < p.items.length && casts.length + hits.length < WANT; i++) if (matches(p.items[i].text, ws)) hits.push(p.items[i].h)
      if (hits.length && !live()) return { casts, next: { cursor: null } }
      casts.push(...(await full(get, hits)))
    }
    // a full page of matches stops mid-page; the next load goes on from there
    if (i < p.items.length) return { casts, next: { cursor: `${p.items[i - 1].h}:${token}` } }
    if (!p.next) return { casts, next: { cursor: null } }
    token = p.next
    if (casts.length >= WANT) return { casts, next: { cursor: token } }
    if (++read >= PAGES) return casts.length ? { casts, next: { cursor: token } } : { casts, next: { cursor: token }, capped: true }
  }
}
