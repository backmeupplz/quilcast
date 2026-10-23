// Hypersnap reads plus the locally stored accounts. Writes live in write.ts,
// loaded on demand so readers never download the crypto.
import { dropEd, hex, keep, newEd, SECRETS, secretsOf, type Secrets } from './keys.ts'

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

// a phrase account is known by its custody address and keeps its recovery phrase in the vault (keys.ts); a wallet
// account has phrase '' and signs with `wallet` (its custody address). Secrets (phrase, dm, fcx, inbox) live in memory
// and the vault, never in localStorage
// `dm` is a farcaster.xyz token that opens the account's direct casts and nothing else
// `pub` is this browser's signing key and `appPub` the on-chain key mini app webhooks are signed with: their private
// halves are in the vault (`signer`/`appKey` hold them raw only where the vault couldn't take them); `inbox` is the
// secret for this browser's mini app notifications on our server, and `notify` lists the app origins that may send them
export type Account = { phrase: string; custody?: string; wallet?: string; fid?: number; username?: string; display?: string; pub?: string; signer?: string; signerAt?: number; nonce?: number; scopes?: number; done?: boolean; dm?: string; appPub?: string; appKey?: string; inbox?: string; notify?: string[]; fcx?: { secret: string; exp: number } }
// every account this browser holds; `account` is the selected one, keyed by its wallet or custody address
export const idOf = (a: Account) => a.wallet || a.custody || ''

// --- where accounts are kept ---
// localStorage has the list. A secret leaves it only once the vault has read it back, so a vault that fails leaves
// everything as it was. `known` is what this tab knows the vault holds.
const known = new Map<string, Secrets>()
const isSecret = (f: string) => (SECRETS as readonly string[]).includes(f)
const same = (a: unknown, b: unknown) => JSON.stringify(a || undefined) === JSON.stringify(b || undefined)
const strip = (a: Account) => Object.fromEntries(Object.entries(a).filter(([f, v]) => !isSecret(f) || !same(v, known.get(idOf(a))?.[f as keyof Secrets]))) as Account
// an account read from localStorage, with the secrets this tab holds for it
const withSecrets = (x: Account): Account => ({ ...known.get(idOf(x)), ...x, phrase: x.phrase || known.get(idOf(x))?.phrase || '' })
// one write per secret at a time, in order; a secret the account doesn't carry at all is one this tab never loaded,
// so it's left alone (clearing one means setting it to undefined)
const lines = new Map<string, Promise<unknown>>()
function sync(id: string, f: keyof Secrets, v: unknown) {
  const run = (lines.get(`${id}:${f}`) || Promise.resolve()).then(async () => {
    if (same(v, known.get(id)?.[f])) return
    await keep(id, f, v || undefined)
    known.set(id, { ...known.get(id), [f]: v || undefined })
  })
  lines.set(`${id}:${f}`, run.catch(() => {}))
  return run
}
/** Save the list, put its secrets in the vault, then take out of localStorage what the vault now has. `gone` are
 *  accounts removed from this browser, whose secrets and keys go too. */
function persist(gone: Account[] = []) {
  save('quilcast:accounts', accounts.map(strip))
  const writes: Promise<unknown>[] = accounts.flatMap((a) => SECRETS.filter((f) => f in a).map((f) => sync(idOf(a), f, a[f])))
  for (const a of gone) writes.push(...SECRETS.map((f) => sync(idOf(a), f, undefined)), ...[a.pub, a.appPub].flatMap((k) => (k ? [dropEd(k)] : [])))
  // another tab may have saved the list meanwhile, so this only takes secrets out of what's there now
  return Promise.all(writes).then(() => save('quilcast:accounts', read<Account[]>('quilcast:accounts', []).map(strip)), (e) => console.error('vault', e))
}

export let accounts = read<Account[]>('quilcast:accounts', [])
const legacy = read<Account | null>('quilcast:account', null)
if (legacy && !accounts.length) accounts = [{ ...legacy, phrase: legacy.phrase || '' }]

/** Startup: an account from before 0.22 gets its custody address as its id and its keys moved into the vault, then
 *  every account's secrets come out of the vault. When the vault fails, everything stays where it was. */
async function settle() {
  const old = accounts.some((a) => SECRETS.some((f) => a[f]) || a.signer || a.appKey)
  try {
    if (accounts.some((a) => a.phrase && !a.custody)) {
      const { address, custodyKey } = await import('./fc.ts')
      const current = localStorage.getItem('quilcast:current')
      for (const a of accounts) if (a.phrase && !a.custody) {
        a.custody = address(await custodyKey(a.phrase))
        if (current === a.phrase) localStorage.setItem('quilcast:current', a.custody)
      }
    }
    // a tab still on an older version can add an account twice: one copy stays, with the later copy's values
    const byId = new Map<string, Account>()
    for (const a of accounts) byId.set(idOf(a), { ...byId.get(idOf(a)), ...a })
    accounts = [...byId.values()]
    for (const a of accounts) {
      const s = await secretsOf(idOf(a))
      known.set(idOf(a), s)
      // a copy still in localStorage is newer than the vault's
      for (const f of SECRETS) a[f] ||= s[f] as any
      a.phrase ||= ''
      // newEd reads a moved key back and makes it sign before the raw one goes
      if (a.signer) await newEd(a.signer).then((k) => ((a.pub = hex(k.pub)), delete a.signer), () => {})
      if (a.appKey) await newEd(a.appKey).then((k) => ((a.appPub = hex(k.pub)), delete a.appKey), () => {})
    }
    if (old) await persist().then(() => localStorage.removeItem('quilcast:account'))
  } catch (e) {
    // the app opens whatever happens here; what couldn't move stays where it was
    console.error('vault', e)
  }
}
await settle()
// 0.19.2–0.20.3 lost accounts signed into with a phrase or wallet and marked the selected one done without an FID:
// one with no keys at all goes, one still being set up goes back to its setup
accounts = accounts.filter((a) => a.custody || a.wallet).map((a) => (a.done && !a.fid ? { ...a, done: false } : a))
export let account: Account | null = accounts.find((a) => idOf(a) === localStorage.getItem('quilcast:current')) || accounts[0] || null

/** Save `a` (added or updated, matched by idOf) and select it; `null` removes the selected account. Resolves once its
 *  secrets are in the vault (or failed to get there and stayed in localStorage). */
export const setAccount = (a: Account | null) => {
  // re-read first: another tab may have added or removed accounts since this one loaded
  const fresh = read<Account[]>('quilcast:accounts', [])
  if (fresh.length || !legacy) accounts = fresh.map(withSecrets)
  const gone = a ? [] : accounts.filter((x) => account && idOf(x) === idOf(account))
  if (a) {
    const i = accounts.findIndex((x) => idOf(x) === idOf(a))
    i < 0 ? accounts.push(a) : (accounts[i] = a)
  } else accounts = accounts.filter((x) => !account || idOf(x) !== idOf(account))
  account = a || accounts.find((x) => x.done) || accounts[0] || null
  const saved = persist(gone)
  account ? localStorage.setItem('quilcast:current', idOf(account)) : localStorage.removeItem('quilcast:current')
  localStorage.removeItem('quilcast:account')
  dispatchEvent(new Event('account'))
  return saved
}
// another tab changed the accounts: take its list, and start over if it signed this account out
addEventListener('storage', (e) => {
  if (e.key !== 'quilcast:accounts') return
  accounts = read<Account[]>('quilcast:accounts', []).map(withSecrets)
  const mine = account && accounts.find((x) => idOf(x) === idOf(account!))
  if (account && !mine) return location.assign('/')
  account = mine || null
  dispatchEvent(new Event('account'))
  // an account another tab added brings its secrets from the vault
  for (const a of accounts)
    if (!known.has(idOf(a))) secretsOf(idOf(a)).then((s) => (known.set(idOf(a), s), Object.assign(a, withSecrets(a)), dispatchEvent(new Event('account'))), () => {})
})
// a full reload is the simplest way to drop the previous account's feeds and likes
/** Save changes to an account without selecting it (posting as another account renews that account's key). */
export const updateAccount = (a: Account) => {
  const saved = read<Account[]>('quilcast:accounts', accounts)
  // the selected account, or one this browser doesn't hold yet (signing in), is saved and selected
  if ((account && idOf(a) === idOf(account)) || !saved.some((x) => idOf(x) === idOf(a))) return setAccount(a)
  accounts = saved.map((x) => (idOf(x) === idOf(a) ? a : withSecrets(x)))
  return persist()
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
