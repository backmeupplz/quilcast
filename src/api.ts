// Hypersnap reads plus the locally stored account. Writes live in write.ts,
// loaded on demand so readers never download the crypto.

export const read = <T,>(k: string, d: T): T => {
  try {
    return JSON.parse(localStorage.getItem(k)!) ?? d
  } catch {
    return d
  }
}
export const save = (k: string, v: unknown) => localStorage.setItem(k, JSON.stringify(v))

export const settings: { node: string; rpc: string; theme: string; looks?: boolean; lang?: string; jp?: boolean } = { node: 'https://haatz.quilibrium.com', rpc: 'https://mainnet.optimism.io', theme: 'system', ...read('quilcast:settings', {}) }
export const saveSettings = () => save('quilcast:settings', settings)

// a phrase account keeps its recovery phrase; a wallet account has phrase '' and signs with `wallet` (its custody address)
// `dm` is a farcaster.xyz token that opens the account's direct casts and nothing else
// `appKey` is the on-chain key mini app webhooks are signed with; `inbox` is the secret for this browser's mini app
// notifications on our server, and `notify` lists the app origins that may send them
export type Account = { phrase: string; wallet?: string; fid?: number; username?: string; display?: string; signer?: string; signerAt?: number; nonce?: number; scopes?: number; done?: boolean; dm?: string; appKey?: string; inbox?: string; notify?: string[]; fcx?: { secret: string; exp: number } }
// every account this browser holds; `account` is the selected one, keyed by its wallet or its phrase
export const idOf = (a: Account) => a.wallet || a.phrase
export let accounts = read<Account[]>('quilcast:accounts', [])
const legacy = read<Account | null>('quilcast:account', null)
if (legacy && !accounts.length) accounts = [{ ...legacy, phrase: legacy.phrase || '' }]
export let account: Account | null = accounts.find((a) => idOf(a) === localStorage.getItem('quilcast:current')) || accounts[0] || null

/** Save `a` (added or updated, matched by idOf) and select it; `null` removes the selected account. */
export const setAccount = (a: Account | null) => {
  // re-read first: another tab may have added or removed accounts since this one loaded
  const fresh = read<Account[]>('quilcast:accounts', [])
  if (fresh.length || !legacy) accounts = fresh
  if (a) {
    const i = accounts.findIndex((x) => idOf(x) === idOf(a))
    i < 0 ? accounts.push(a) : (accounts[i] = a)
  } else accounts = accounts.filter((x) => !account || idOf(x) !== idOf(account))
  account = a || accounts.find((x) => x.done) || accounts[0] || null
  save('quilcast:accounts', accounts)
  account ? localStorage.setItem('quilcast:current', idOf(account)) : localStorage.removeItem('quilcast:current')
  localStorage.removeItem('quilcast:account')
  dispatchEvent(new Event('account'))
}
// another tab changed the accounts: take its list, and start over if it signed this account out
addEventListener('storage', (e) => {
  if (e.key !== 'quilcast:accounts') return
  accounts = read<Account[]>('quilcast:accounts', [])
  const mine = account && accounts.find((x) => idOf(x) === idOf(account!))
  if (account && !mine) return location.assign('/')
  account = mine || null
  dispatchEvent(new Event('account'))
})
// a full reload is the simplest way to drop the previous account's feeds and likes
/** Save changes to an account without selecting it (posting as another account renews that account's key). */
export const updateAccount = (a: Account) => {
  if (account && idOf(a) === idOf(account)) return setAccount(a)
  accounts = read<Account[]>('quilcast:accounts', accounts).map((x) => (idOf(x) === idOf(a) ? a : x))
  save('quilcast:accounts', accounts)
}
// a full reload drops the previous account's feeds and likes; it stays on this page (a conversation is the account's
// own, so that one goes back to the inbox)
export const switchAccount = (a: Account) => (localStorage.setItem('quilcast:current', idOf(a)), location.assign(location.pathname.startsWith('/messages/') ? '/messages' : location.pathname + location.search))

let depth = 0
export const go = (path: string) => {
  depth++
  history.pushState(null, '', path)
  dispatchEvent(new Event('popstate'))
}
// leave the app only if we arrived on this page from outside it
export const back = () => (depth > 0 ? (depth--, history.back()) : go('/'))

// links as people write them: with a scheme, or a bare domain on a common TLD ("quilcast.com/x")
const TLDS = 'com|org|net|xyz|io|app|dev|ai|co|me|gg|so|sh|fm|tv|art|fun|lol|wtf|info|page|site|tech|link|to|us|uk|de|fr|eu|ca|ly|cc|club|blog|news|social|world|live|studio|games|finance|money|cash|network|systems|build|tools'
export const LINK_RE = new RegExp(`https?:\\/\\/[^\\s<>"]+[^\\s<>".,;:!?)\\]'"]|(?<![@\\w.\\/-])(?:[a-z0-9-]+\\.)+(?:${TLDS})\\b(?:\\/[^\\s<>"]*[^\\s<>".,;:!?)\\]'"])?`, 'gi')
export const toUrl = (s: string) => (/^https?:\/\//i.test(s) ? s : `https://${s}`)

// URLs from casts, profiles and link previews are untrusted: Snapchain only checks their length, so
// a "link" can be javascript:… or point at the viewer's own network. Only public http(s) gets through.
const LOCAL = /^(localhost|.*\.localhost|.*\.local|0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|\[)/i
export function safeUrl(u?: string | null) {
  if (typeof u !== 'string') return
  try {
    const x = new URL(u)
    if (/^https?:$/.test(x.protocol) && !x.username && !x.password && !LOCAL.test(x.hostname)) return x.href
  } catch {}
}

export const USER_DATA = { PFP: 1, DISPLAY: 2, BIO: 3, URL: 5, USERNAME: 6 }

export async function get<T = any>(path: string, q: Record<string, string | number | undefined> = {}): Promise<T> {
  const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined) as [string, string][])
  const r = await fetch(`${settings.node}${path}?${qs}`)
  if (!r.ok) throw new Error((await r.text().catch(() => '')) || `HTTP ${r.status}`)
  return r.json()
}

// what the signed-in user recently liked/recast, so buttons render filled; `mineVersion` bumps when it loads
export const mine = { likes: new Set<string>(), recasts: new Set<string>() }
export let mineVersion = 0
export async function loadMine() {
  const fid = account?.fid
  if (!fid) return
  await Promise.all(
    ([['Like', mine.likes], ['Recast', mine.recasts]] as const).map(async ([type, set]) => {
      const r = await get('/v1/reactionsByFid', { fid, reaction_type: type, pageSize: 200, reverse: 'true' }).catch(() => ({ messages: [] }))
      for (const m of r.messages) m.data?.reactionBody?.targetCastId && set.add(m.data.reactionBody.targetCastId.hash.replace(/^0x/, '').toLowerCase())
    }),
  )
  mineVersion++
}

export const isFollowing = async (target: number) =>
  !!account?.fid && (await get('/v1/linkById', { fid: account.fid, target_fid: target, link_type: 'follow' }).then(() => true, () => false))
// asked once per person per visit (Home asks about the author of every reply's parent)
const follows = new Map<number, Promise<boolean>>()
export const amFollowing = (fid: number) => follows.get(fid) || (follows.set(fid, isFollowing(fid)), follows.get(fid)!)

/** People matching `q`, best first: that exact handle, then handles starting with it, then the most followed. */
export async function findUsers(q: string) {
  q = q.replace(/^@/, '').toLowerCase()
  const r = await get('/v2/farcaster/user/search', { q, limit: 50 })
  const rank = (u: User) => (u.username === q || u.username === q + '.eth' ? 1e12 : u.username?.startsWith(q) ? 1e10 : 0) + (u.follower_count || 0)
  return ((r.users || r.result?.users || []) as User[]).sort((a, b) => rank(b) - rank(a))
}

// viewer_context comes from nodes with Hypersnap PR #43 when asked with viewer_fid
export type User = { fid: number; viewer_context?: { following?: boolean }; username?: string; display_name?: string; pfp_url?: string; profile?: { bio?: { text?: string } }; follower_count?: number; following_count?: number; custody_address?: string }
export type Cast = {
  hash: string; text: string; timestamp: string; author: User; parent_hash?: string | null; parent_url?: string | null; parent_author?: { fid: number | null }
  embeds: { url?: string; cast_id?: { fid: number; hash: string } }[]
  reactions: { likes_count: number; recasts_count: number }; replies: { count: number }; direct_replies?: Cast[]
  mentioned_profiles?: User[]; mentioned_profiles_ranges?: { start: number; end: number }[]
  // a reply in Home carries the casts shown above it (root first), and `gap` when some were skipped
  up?: Cast[]; gap?: boolean
  thread_hash?: string | null
}

// authors we've seen, so replies can say who they reply to
export const users = new Map<number, User>()
/** Look up the users we haven't seen yet. */
export async function loadUsers(fids: (number | null | undefined)[]) {
  const missing = [...new Set(fids.filter((f): f is number => !!f && !users.has(f)))]
  if (missing.length) for (const u of (await get('/v2/farcaster/user/bulk', { fids: missing.slice(0, 100).join(',') }).catch(() => ({ users: [] }))).users) users.set(u.fid, u)
}
export async function hydrateParents(casts: Cast[]) {
  for (const c of casts) users.set(c.author.fid, c.author)
  await loadUsers(casts.map((c) => c.parent_author?.fid))
  return casts
}
/** By username. The node's by-username only knows fnames, so ENS names like "shoni.eth" come from search (exact match only). */
export async function byName(name: string): Promise<User> {
  name = name.toLowerCase()
  const r = await get('/v2/farcaster/user/by-username', { username: name }).catch(() => null)
  if (r?.user) return r.user
  const u = (await findUsers(name)).find((x) => x.username?.toLowerCase() === name)
  if (!u) throw new Error('User not found')
  return u
}
/** A user fresh from the node (by FID, or by username for anything else); also remembered in `users`. */
export async function getUser(id: number | string) {
  const u: User = /^\d+$/.test(String(id)) ? (await get('/v2/farcaster/user', { fid: id })).user : await byName(String(id))
  users.set(u.fid, u)
  return u
}
/** The signed-in user as far as we know them. */
export const myUser = (): User | null => (account?.fid ? users.get(account.fid) || { fid: account.fid, username: account.username } : null)
/** Casts this tab just sent, shown as "Posting…" until the node has indexed them. */
export const posting = new Map<string, Cast>()
