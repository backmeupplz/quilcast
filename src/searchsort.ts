// The order of Search's casts (#654): Top, Recent or Relevance. The node's cast search (Hypersnap PR #59) ranks by how
// well the text matches (`algorithmic`, its default), newest first (`desc_chronological`) or oldest first, never by likes; and its
// results are bare (hash, author, text and time, every count 0). So each page is read again in full
// (/v2/farcaster/casts), and Top reads the newest TOP matches, then puts the most liked, recast and replied first.
// ponytail: Top is the best of the newest TOP matches, not of all time; a busy word's TOP newest go back hours
import type { Cast } from './api.ts'
import { hasTag } from './shared.ts'

type Get = (path: string, q: Record<string, string | number | undefined>) => Promise<any>
type Page = { casts: Cast[]; next: { cursor: string | null } }

export type Sort = 'top' | 'recent' | 'relevance'
const SORTS: readonly string[] = ['top', 'recent', 'relevance']
/** The sort a `?s=` asks for in a search for `term`; when it says none (or one there isn't), a #hashtag's casts newest
 *  first (#431) and any other words' Top. */
export const sortOf = (s: string | null | undefined, term: string): Sort =>
  s && SORTS.includes(s) ? (s as Sort) : hasTag(term) ? 'recent' : 'top'
/** The `?s=` for a search for `term` in this order: none when it's that term's default. */
export const sortParam = (s: string | null | undefined, term: string) =>
  sortOf(s, term) === sortOf(null, term) ? undefined : sortOf(s, term)

// a feed's page
const WANT = 25
// what one search request reads for Top (the node's most)
const BATCH = 100
/** How many of the newest matches Top ranks. */
export const TOP = 300

const body = (r: any) => r?.result || r
const key = (h: string) => h.replace(/^0x/i, '').toLowerCase()

/** These casts in full, in this order; one the node can't read in full (or a read that failed) stays as the search
 *  gave it. */
async function full(get: Get, cs: Cast[]): Promise<Cast[]> {
  const by = new Map<string, Cast>()
  const parts: Cast[][] = []
  for (let i = 0; i < cs.length; i += 50) parts.push(cs.slice(i, i + 50))
  await Promise.all(parts.map(async (p) => {
    const r = await get('/v2/farcaster/casts', { casts: p.map((c) => c.hash).join(',') }).catch(() => null)
    for (const c of (body(r)?.casts || []) as Cast[]) if (c?.hash) by.set(key(c.hash), c)
  }))
  return cs.map((c) => by.get(key(c.hash)) || c)
}

/** How much a cast was liked, recast and replied to. */
export const score = (c: Cast) => (c.reactions?.likes_count || 0) + 2 * (c.reactions?.recasts_count || 0) + (c.replies?.count || 0)

/** The newest TOP matches, read in full, the highest score first (the newer first between equals). */
async function ranked(get: Get, q: string): Promise<Cast[]> {
  const found: Cast[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  while (found.length < TOP) {
    // a later page that fails leaves Top with the matches it has
    const r = body(await get('/v2/farcaster/cast/search', { q, limit: BATCH, cursor, sort_type: 'desc_chronological' }).catch((e) => {
      if (!found.length) throw e
      return null
    }))
    if (!r) break
    for (const c of (r?.casts || []) as Cast[]) if (c?.hash && !seen.has(key(c.hash)) && found.length < TOP) seen.add(key(c.hash)), found.push(c)
    cursor = r?.next?.cursor || undefined
    if (!cursor || !r?.casts?.length) break
  }
  return (await full(get, found)).map((c, i) => ({ c, i, s: score(c) })).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.c)
}

// Top's ranked lists, so "load more" pages the list the first page came from; a first page ranks again.
// ponytail: kept by the words only, the last KEEP; Back to an older list (or after switching accounts) ranks again
const lists = new Map<string, Promise<Cast[]>>()
const KEEP = 10

/** A page of the casts matching `q`, in this order, as a feed reads them. */
export async function searchPage(get: Get, q: string, sort: Sort, cursor?: string | null): Promise<Page> {
  if (sort !== 'top') {
    const r = body(await get('/v2/farcaster/cast/search', { q, limit: WANT, cursor: cursor || undefined, sort_type: sort === 'recent' ? 'desc_chronological' : 'algorithmic' }))
    return { casts: await full(get, (r?.casts || []) as Cast[]), next: { cursor: r?.next?.cursor || null } }
  }
  const at = Number(cursor) || 0
  let list = cursor ? lists.get(q) : undefined
  if (!list) {
    const p = ranked(get, q)
    lists.delete(q)
    lists.set(q, p)
    p.catch(() => lists.get(q) === p && lists.delete(q))
    for (const old of lists.keys()) if (lists.size > KEEP) lists.delete(old); else break
    list = p
  }
  const all = await list
  const casts = all.slice(at, at + WANT)
  return { casts, next: { cursor: at + WANT < all.length ? String(at + WANT) : null } }
}
