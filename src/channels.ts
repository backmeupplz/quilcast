// Channels: farcaster.xyz's directory through our server (server/channels.mjs), and a channel's feed from the node.
import type { Cast } from './api.ts'

export type Channel = { id: string; url: string; name: string; desc?: string; image?: string; header?: string; followers: number; members: number; open: boolean }

const json = (u: string) => fetch(u).then((r) => (r.ok ? r.json() : null), () => null)
const known = new Map<string, Promise<Channel | null>>()
export const getChannel = (id: string) => known.get(id) || (known.set(id, json(`/api/channel/${encodeURIComponent(id)}`)), known.get(id)!)
/** The top channels by followers, or the ones matching `q`. */
export async function findChannels(q = '', n = 50): Promise<Channel[]> {
  const list: Channel[] = (await json(`/api/channels?${new URLSearchParams({ ...(q && { q }), n: String(n) })}`)) || []
  for (const c of list) known.has(c.id) || known.set(c.id, Promise.resolve(c))
  return list
}
/** The URL casts go under for channel `id`: farcaster.xyz's, which for the oldest channels isn't …/~/channel/<id>. */
export const urlOf = async (id: string) => (await getChannel(id))?.url || `https://warpcast.com/~/channel/${id}`
export const isMember = (id: string, fid: number) => json(`/api/channel/${encodeURIComponent(id)}/member/${fid}`).then((r) => r?.member !== false)

// the old-style parent URLs (chain://…, https://onchainsummer.xyz for /base) and their channel ids
export let legacy: Record<string, string> = {}
json('/api/channels/legacy').then((m) => m && ((legacy = m), dispatchEvent(new Event('channels'))))

// ponytail: the cursor tricks below work around haatz before farcasterorg/hypersnap#44. A channel's newest page comes
// back empty when another channel's URL starts with its URL (/build and /build-…), so the first page starts from a
// cursor we make; each page is every shard's next page one after another, so casts show only down to where every
// shard has reached; and a shard that ran out would start over, so it's pinned to time 0. Delete once haatz runs #44.
const EPOCH = 1609459200
const enc = new TextEncoder()
type Shards = (number[] | null)[]
const key = (url: string, ts: number, fill: number) => [31, ...enc.encode(url), (ts >>> 24) & 255, (ts >>> 16) & 255, (ts >>> 8) & 255, ts & 255, ...Array(24).fill(fill)]
export const pack = (s: Shards) => Array.from(enc.encode(JSON.stringify(s)), (b) => b.toString(16).padStart(2, '0')).join('')
export const unpack = (hex?: string | null): Shards => (hex ? JSON.parse(new TextDecoder().decode(Uint8Array.from(hex.match(/../g) || [], (h) => parseInt(h, 16)))) : [])
const tsOf = (k: number[], url: string) => {
  const i = 1 + enc.encode(url).length
  return ((k[i] << 24) >>> 0) + (k[i + 1] << 16) + (k[i + 2] << 8) + k[i + 3]
}
const secs = (c: Cast) => Math.floor(Date.parse(c.timestamp) / 1000) - EPOCH

/** A Feed loader for the casts under `url`, newest first; `fetch` asks the node's /v2/farcaster/feed/parent_urls. */
export function channelFeed(url: string, fetch: (cursor?: string) => Promise<{ casts: Cast[]; next?: { cursor?: string | null } }>) {
  let held: Cast[] = []
  return async (cursor?: string): Promise<{ casts: Cast[]; next: { cursor: string | null } }> => {
    let made = !cursor
    if (made) {
      held = []
      const now = Math.floor(Date.now() / 1000) - EPOCH + 60
      cursor = pack([key(url, now, 255), key(url, now, 255)])
    }
    for (;;) {
      let r = await fetch(cursor).catch((e) => (made ? { casts: [] as Cast[], next: undefined } : Promise.reject(e)))
      // a node that doesn't take our cursor (one running #44, say) is asked without it
      if (made && !r.casts.length) r = await fetch()
      made = false
      const shards = unpack(r.next?.cursor)
      const live = shards.filter((k): k is number[] => !!k)
      const edge = live.length ? Math.max(...live.map((k) => tsOf(k, url))) : -Infinity
      const seen = new Set(held.map((c) => c.hash))
      held = [...held, ...r.casts.filter((c: Cast) => !seen.has(c.hash))].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
      const show = held.filter((c) => secs(c) >= edge)
      held = held.filter((c) => secs(c) < edge)
      const next = live.length ? pack(shards.map((k) => k || key(url, 0, 0))) : null
      if (show.length || !next) return { casts: show, next: { cursor: next } }
      cursor = next
    }
  }
}
