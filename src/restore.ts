// Back and Forward put you where you were (#502): each page's loaded lists, its tab, its refresh count and its scroll
// position are kept per history entry, and an entry reached by Back or Forward starts from them. A link, a tap on the
// tab you're on or a reload starts with a fresh list, as before. Entries are told apart by an id in history.state
// (app.tsx), so a page visited twice keeps each visit's place.

const MAX = 30
/** A small map that forgets the entry used longest ago once it holds more than `max`. */
export function lru<V>(max = MAX) {
  const m = new Map<string, V>()
  return {
    get: (k: string) => m.get(k),
    set(k: string, v: V) {
      m.delete(k)
      m.set(k, v)
      if (m.size > max) m.delete(m.keys().next().value!)
    },
    entries: () => [...m],
  }
}

/** The pages a Pager (app.tsx) loaded for its key, and the cursor after them; null until its first page has loaded. */
type List = { items: unknown[]; cursor: string | null } | null
// the Pagers on screen now, by key, each read when its page is left; and what each entry had on screen when it was left
const live = new Map<string, () => List>()
const left = lru<Map<string, List>>()
// the history entry on screen (app.tsx sets it), whether it came from Back or Forward (the browser's own popstate)
// rather than from a link (go() in api.ts sends one of its own), the lists it had when it was left, and the ones
// handed back to it so far
let cur = ''
let popped = false
let wanted = new Map<string, List>()
const taken = new Set<string>()

/** The id of the history entry on screen. */
export const entry = () => cur
/** The app starts on entry `id` (a reload keeps the id, though nothing kept in memory survives it). */
export const start = (id: string) => void (cur = id)
/** A Pager shows key `k`, whose list `get` reads (until the function it returns is called). */
export function showing(k: string, get: () => List) {
  live.set(k, get)
  return () => void (live.get(k) === get && live.delete(k))
}
/** The entry on screen is left for entry `to`, by a link or by Back/Forward (`pop`). */
export function navigated(to: string, pop: boolean) {
  left.set(cur, new Map([...live].map(([k, get]) => [k, get()])))
  for (const [key, get] of held) states.set(`${cur} ${key}`, get())
  cur = to
  popped = pop
  wanted = (pop && left.get(to)) || new Map()
  taken.clear()
}
/** The list kept for `k`, when this entry came from Back or Forward, showed `k` when it was left, and hasn't had it
 *  back yet: a list switched to on it (another tab, a search typed) loads afresh, and so does one switched away from
 *  and back to. */
export function takeList<T>(k: string): { items: T[]; cursor: string | null } | null {
  const l = wanted.get(k)
  if (!popped || taken.has(k) || !l?.items.length) return null
  taken.add(k)
  return l as { items: T[]; cursor: string | null }
}
/** Whether this page can go back to where it was scrolled: it had no lists, or one of them came back. Otherwise
 *  (a list loading afresh, a tab not kept) the spot would be somewhere else in other posts, so it starts at the top. */
export const placeKept = () => !wanted.size || [...wanted.keys()].some((k) => taken.has(k))

/** Small things an entry has again when Back or Forward comes to it, like its tab or its refresh count: kept as they
 *  change, or read as the entry is left (`holding`). */
const states = lru<unknown>(300)
const held = new Map<string, () => unknown>()
/** The page on screen has `key`, which `get` reads as it's left (until the function it returns is called). */
export function holding(key: string, get: () => unknown) {
  held.set(key, get)
  return () => void (held.get(key) === get && held.delete(key))
}
export const keepState = (key: string, v: unknown) => states.set(`${cur} ${key}`, v)
export const stateOf = <T>(key: string): T | undefined => states.get(`${cur} ${key}`) as T | undefined

/** Where each entry was scrolled to when it was left (app.tsx keeps them in sessionStorage across a reload). */
const spots = lru<number>(100)
export const keepSpot = (id: string, y: number) => spots.set(id, y)
export const spotOf = (id: string) => spots.get(id) || 0
export const allSpots = () => spots.entries()
