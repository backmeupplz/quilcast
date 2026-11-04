// Channels: farcaster.xyz's directory through our server (server/channels.mjs).
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
