// Outages, from status.quilcast.com's snapshot (its /api/status): the banner on top of every page says so and opens
// the status page as a mini app.
export const STATUS = 'https://status.quilcast.com'

type Snapshot = { networks?: { hypersnap?: { status?: string; nodes?: { url?: string | null; state?: string }[] } } }
const origin = (u: string) => URL.parse(u)?.origin

/** 'node' when the node Quilcast reads from is offline (every entry the status page has for it), else 'network' when
 *  the network itself is in trouble, else null. A node the status page doesn't know only goes by the network. */
export function outage(s: Snapshot | null | undefined, node: string): 'node' | 'network' | null {
  const net = s?.networks?.hypersnap
  if (!net) return null
  const mine = net.nodes?.filter((n) => n.url && origin(n.url) === origin(node)) ?? []
  if (mine.length && mine.every((n) => n.state === 'offline')) return 'node'
  return net.status && net.status !== 'operational' ? 'network' : null
}
