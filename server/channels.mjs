// farcaster.xyz's channel directory (its CORS doesn't allow us, and it's 8 MB), trimmed and kept an hour. Hypersnap's
// own channel list is made up from casts' parent URLs, so it has no names, images or real member counts, and its ids
// for the oldest channels (/memes is chain://eip155:1/erc721:0xfd84…) point at empty buckets. If farcaster.xyz fails,
// the last good list stays.
import { fetchJson } from './net.mjs'

const https_ = (u) => (typeof u === 'string' && /^https:\/\//.test(u) && u.length < 1024 ? u : undefined)
const text = (v, n) => (typeof v === 'string' && v ? v.slice(0, n) : undefined)
const STANDARD = /^https:\/\/(?:warpcast\.com|farcaster\.xyz)\/~\/channel\/([^/?#]+)$/

export function trim(raw) {
  return (raw || []).flatMap((c) => {
    if (typeof c?.id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(c.id) || typeof c.url !== 'string' || c.url.length > 512) return []
    return [{
      id: c.id, url: c.url, name: text(c.name, 80) || c.id, desc: text(c.description, 300), image: https_(c.imageUrl), header: https_(c.headerImageUrl),
      followers: +c.followerCount || 0, members: +c.memberCount || 0, open: c.publicCasting !== false,
    }]
  }).sort((a, b) => b.followers - a.followers)
}

/** Channels matching `q` by id or name: exact id first, then ids starting with it, then the rest, each by followers. */
export function search(list, q, n) {
  q = q.toLowerCase().replace(/^\//, '')
  const rank = (c) => (c.id === q ? 0 : c.id.startsWith(q) ? 1 : c.id.includes(q) || c.name.toLowerCase().includes(q) ? 2 : 3)
  const hits = []
  for (const c of list) rank(c) < 3 && hits.push(c)
  return hits.sort((a, b) => rank(a) - rank(b)).slice(0, n)
}

/** The parent URL → id map for channels whose URL isn't …/~/channel/<id>, which casts can't be read for their channel. */
export const legacy = (list) => Object.fromEntries(list.flatMap((c) => (STANDARD.test(c.url) ? [] : [[c.url, c.id]])))

let dir = { at: 0, list: [], byId: new Map(), legacy: {} }
let loading = null
/** A cast's channel id from its parent URL, once the directory is loaded for the old-style URLs. */
export const channelOf = (u) => (u && Object.hasOwn(dir.legacy, u) && dir.legacy[u]) || u?.match(/(?:warpcast\.com|farcaster\.xyz)\/~\/channel\/([^/?#]+)/)?.[1]
export async function channels() {
  if (dir.list.length && dir.at > Date.now() - 3600e3) return dir
  loading ??= fetchJson('https://api.farcaster.xyz/v2/all-channels', 30000).catch(() => null).then((r) => {
    const list = trim(r?.result?.channels)
    if (list.length) dir = { at: Date.now(), list, byId: new Map(list.map((c) => [c.id, c])), legacy: legacy(list) }
    loading = null
    return dir
  })
  // a stale list answers at once while the fresh one loads
  return dir.list.length ? dir : loading
}
