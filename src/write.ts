// Signed writes: everything here needs the account's keys.
import { ed25519 } from '@noble/curves/ed25519.js'
import { account, accounts, askUser, byName, forget, get, idOf, myUser, posting, publishedArticle, setAccount, settings, updateAccount, users, type Account, type Cast } from './api.ts'
import { dm } from './dms.ts'
import { t } from './i18n.ts'
import { balance, keyState, reverted, sendTx } from './eth.ts'
import { castAt, castBody, castRemoveBody, custodyKey, envelope, followBody, hex, KEY_GATEWAY, KEY_REGISTRY, keyAdd, keyCustody, keyGatewayAdd, keyRegistryRemove, keyRemoveSelf, mentions, MT, nativeOnboard, powPrefix, rawEd, reactionBody, reactionUrlBody, SCOPES_VERSION, unhex, userDataBody, type CastRef, type Custody } from './fc.ts'
import { dropEd, edKey, kv, newEd, type Ed } from './keys.ts'
import { search } from './pow.worker.ts'
import { ARTICLE, type Outgoing, type Part } from './article.ts'
import { waitingToPost } from './signout.ts'
import { castEmbeds, queue } from './shared.ts'

/** The custody key of a phrase account: from the phrase in the vault, or, when this browser doesn't keep it (Settings
 *  can remove it), from one the person types in for this one action, which isn't kept, not even in memory. */
async function custody(a: Account) {
  if (a.phrase) return custodyKey(a.phrase)
  const phrase = await askUser.phrase(a)
  if (!phrase) throw new Error("This needs the account's recovery phrase.")
  return custodyKey(phrase, false)
}

/** Who signs for an account's custody address: the key from its phrase, or the wallet it was connected with (paired
 *  again first when it's a WalletConnect one whose session ended). */
export const custodyOf = async (a: Account): Promise<Custody> =>
  a.wallet ? (await import('./wallet.ts')).walletCustody(a.wallet, settings.rpc, repairer(a.wallet)) : keyCustody(await custody(a))
const repairer = (address: string) => () => askUser.pair(address)

/** An ed25519 key (`pub`, or raw in `raw`) as a signer; a key this browser doesn't have counts as one the network
 *  dropped, so send() and saveLook() add a new one. */
async function keyOf(pub?: string, raw?: string): Promise<Ed> {
  const k = raw ? rawEd(unhex(raw)) : pub && (await edKey(pub).catch(() => undefined))
  if (!k) throw new Error(`invalid signer: not in this browser`)
  return k
}
const signerOf = (a: Account) => keyOf(a.pub, a.signer)
/** A new key in the vault, where page code can use it but never read it; raw (as before) where the vault can't take it. */
async function newKey(): Promise<[Ed, string | undefined]> {
  try {
    return [await newEd(), undefined]
  } catch {
    const raw = ed25519.utils.randomSecretKey()
    return [rawEd(raw), hex(raw)]
  }
}

async function submit(m: { msg: Uint8Array; hash: string }) {
  const r = await fetch(`${settings.node}/v1/submitMessage`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: m.msg as BodyInit })
  if (!r.ok) {
    const t = await r.text()
    let j: { details?: string; message?: string } = {}
    try {
      j = JSON.parse(t)
    } catch {}
    throw new Error(j.details || j.message || t || `HTTP ${r.status}`)
  }
  forget()
  return m.hash
}

/** Make sure this browser holds a Hypersnap signer for the account, adding one when needed. Hypersnap keeps a key
 *  alive as long as it's used (90 days idle), so there's no renewing: a key the network stops taking is replaced when
 *  send() or saveLook() notice. Older signers are re-issued once with the narrower permissions (same key); `fresh`
 *  swaps in a new key. */
export async function ensureSigner(a = account!, fresh = false) {
  const now = Math.floor(Date.now() / 1000)
  if (!fresh && (a.pub || a.signer) && a.scopes === SCOPES_VERSION) return
  const old = !fresh && (await signerOf(a).catch(() => undefined))
  const [key, raw] = old ? [old, a.signer] : await newKey()
  const nonce = Math.max((a.nonce || 0) + 1, now)
  await submit(await keyAdd(a.fid!, await custodyOf(a), key, nonce))
  updateAccount({ ...a, pub: hex(key.pub), signer: raw, signerAt: now, nonce, scopes: SCOPES_VERSION })
  // a key that was replaced is no use to anyone
  if (a.pub && a.pub !== hex(key.pub)) dropEd(a.pub).catch(() => {})
}

const signerListed = (a = account!) =>
  signerOf(a).then((k) => get('/v1/signer', { fid: a.fid, signer: '0x' + hex(k.pub) }, true)).then(() => true, () => false)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The node can stop knowing this browser's key (revoked, dropped, or its KEY_ADD never landed), while the
 *  account still holds it: add a new key and wait until the node lists it. */
async function replaceSigner(a = account!) {
  await ensureSigner(a, true)
  for (let i = 0; !(await signerListed(fresh(a))); i++) {
    if (i >= 10) throw new Error("Your new key hasn't reached the network yet. Try again in a minute.")
    await sleep(3000)
  }
}

/** The native FID (from 2^32) that `addr` is the custody of, 0 when it has none. */
export async function nativeFid(addr: string) {
  const r = await fetch(`${settings.node}/v1/nativeAccount?custody=${addr}`)
  const j = await r.json().catch(() => ({}))
  if (r.ok) return Number(j.fid)
  if (/NotFound/.test(j.error_detail)) return 0
  throw new Error(j.error || `HTTP ${r.status}`)
}

/** Ask Hypersnap for a free native FID: proof of work, then the custody's signature. The FID shows up in nativeFid()
 *  once shard 0 takes it, usually within seconds. */
export async function registerNative(c: Custody) {
  const info = await (await fetch(`${settings.node}/v1/nativeRegistration`)).json()
  const bits = info.minDifficultyBits
  if (!info.active) throw new Error('Hypersnap is not taking new accounts right now. Try again later.')
  // 22 bits takes seconds; a node asking for far more would keep the phone busy forever
  if (!(bits >= 1 && bits <= 28)) throw new Error('The node asks for an unexpected amount of work. Check the node in settings.')
  const nonce = await mine(powPrefix(c.address, info.anchorBlockHash), bits)
  await submit(await nativeOnboard(c, info.anchorBlockHeight, info.anchorBlockHash, nonce, bits))
}

/** Every core searches its own share of the nonces; this thread does it alone where workers can't run (tests). */
async function mine(prefix: Uint8Array, bits: number): Promise<Uint8Array> {
  if (typeof Worker === 'undefined') return search(prefix, bits, 0, 1)
  const n = Math.min(navigator.hardwareConcurrency || 4, 8)
  const ws = Array.from({ length: n }, () => new Worker(new URL('./pow.worker.ts', import.meta.url), { type: 'module' }))
  try {
    return await new Promise((ok, fail) =>
      ws.forEach((w, i) => {
        w.onmessage = (e) => ok(e.data)
        w.onerror = () => fail(new Error("Couldn't start the proof of work in this browser."))
        w.postMessage([prefix, bits, i, n])
      }),
    )
  } finally {
    ws.forEach((w) => w.terminate())
  }
}

/** A transaction on Optimism from the account's custody: its wallet, or the phrase key (which needs a little ETH there).
 *  `data` is built with the same custody, so a phrase that has to be typed in is asked for once. */
async function custodyTx(a: Account, to: string, data: (c: Custody) => Promise<string>) {
  if (a.wallet) return (await import('./wallet.ts')).sendTx(a.wallet, to, await data(await custodyOf(a)), 0n, 10, repairer(a.wallet))
  const key = await custody(a)
  const { address } = keyCustody(key)
  if ((await balance(settings.rpc, address)) === 0n) throw new Error(t("Your account address {address} needs a little ETH on Optimism (a cent's worth) to pay for this.", { address }))
  return sendTx(settings.rpc, key, to, await data(keyCustody(key)))
}

// The app key's state in Farcaster's KeyRegistry on Optimism (0 never added, 1 added, 2 removed), read straight from
// the chain: Hypersnap stopped indexing new KeyRegistry adds, so its /v1/onChainSignersByFid never lists keys added
// since. Throws when the RPC can't be asked.
const appKeyState = (fid: number, key: Uint8Array) => keyState(settings.rpc, fid, key)

// forget an account's app key (and its copy in the vault)
const dropAppKey = (a: Account, pub: Uint8Array) => {
  updateAccount({ ...fresh(a), appPub: undefined, appKey: undefined, appUntil: undefined })
  dropEd(hex(pub)).catch(() => {})
}
const now = () => Math.floor(Date.now() / 1000)
// how long after its add's deadline a key still not on chain is given up on: the chain compares the deadline with its
// own clock, which this browser's may run behind
const GRACE = 600

/** The key mini app webhook events are signed with, for account `as` (the selected one). Apps check it against
 *  Farcaster's KeyRegistry, which the Hypersnap signer isn't in, so this one is added on chain (KeyGateway.add from
 *  the custody), once per browser. A kept key that can't be on chain any more is replaced with a new one: removed
 *  since (from another app), or never added and past its add's deadline (the add reverted or was dropped, maybe while
 *  this page was closed). `pause` is the wait between checks for the key on chain (tests shorten it). */
export async function ensureAppKey(onWait?: (what: string) => void, pause = 3000, as = account!) {
  let a = fresh(as)
  let key = a.appPub || a.appKey ? await keyOf(a.appPub, a.appKey).catch(() => undefined) : undefined
  // an RPC that can't be asked keeps the key: the wait below tries again
  const state = key && (await appKeyState(a.fid!, key.pub).catch(() => undefined))
  if (key && (state === 2 || (state === 0 && a.appUntil && now() > a.appUntil + GRACE))) {
    dropAppKey(a, key.pub)
    a = fresh(a)
    key = undefined
  } else if (key && state === 0 && !a.appUntil) {
    // kept from before deadlines were: its add went out at the latest now, so its deadline is within the hour
    updateAccount({ ...fresh(a), appUntil: now() + 3600 })
    a = fresh(a)
  }
  let tx: string | undefined
  if (!key) {
    const [k, raw] = await newKey()
    // KeyGateway refuses the add after this, so a key still not on chain by then never will be
    const until = now() + 3600
    onWait?.(a.wallet ? t('Confirm the key in your wallet (Optimism)') : t('Adding a notification key on Optimism…'))
    tx = await custodyTx(a, KEY_GATEWAY, (c) => keyGatewayAdd(a.fid!, c, k.pub, until))
    // kept as soon as the transaction is out, so a reload doesn't add a second key
    updateAccount({ ...fresh(a), appPub: hex(k.pub), appKey: raw, appUntil: until })
    a = fresh(a)
    key = k
  }
  onWait?.(t('Waiting for the network to see the key…'))
  for (let i = 0, answered = false; ; i++) {
    const s = await appKeyState(a.fid!, key.pub).catch(() => undefined)
    if (s === 1) return key
    // removed meanwhile (from another app): a new key is added in its place
    if (s === 2) {
      dropAppKey(a, key.pub)
      return ensureAppKey(onWait, pause, a)
    }
    answered ||= s !== undefined
    // the add reverted: the key will never be on chain, so the next try adds a new one
    if (tx && (await reverted(settings.rpc, tx).catch(() => undefined))) {
      dropAppKey(a, key.pub)
      throw new Error('The transaction failed on chain.')
    }
    if (i >= 40)
      throw answered
        ? new Error('The notification key is still being confirmed. Try again in a minute.')
        : new Error("Couldn't reach the Optimism RPC to check the notification key. Check the RPC in settings.")
    await new Promise((r) => setTimeout(r, pause))
  }
}

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
/** A JSON Farcaster Signature over `payload`, signed with the app key: what mini app webhooks receive. */
export async function signEvent(payload: object, onWait?: (what: string) => void) {
  // the account selected now: another one may get selected while the key is being added
  const a = account!
  const key = await ensureAppKey(onWait, undefined, a)
  const enc = new TextEncoder()
  const header = b64url(enc.encode(JSON.stringify({ fid: a.fid, type: 'app_key', key: '0x' + hex(key.pub) })))
  const body = b64url(enc.encode(JSON.stringify(payload)))
  return { header, payload: body, signature: b64url(await key.sign(enc.encode(`${header}.${body}`))) }
}

/** Sign out, step one: the on-chain app key is removed (KeyRegistry.remove from the custody), and the
 *  notification inbox on our server is dropped. Once the key is off chain the account forgets it, so trying again
 *  (the signer's revoke failed after this) doesn't send a remove that can only revert; one the KeyRegistry doesn't
 *  hold as added (never landed, or removed already) is forgotten without a transaction. */
export async function removeAppKey(a: Account) {
  a = fresh(a)
  if (a.inbox) await fetch('/api/notify/drop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inbox: a.inbox }) }).catch(() => {})
  const pub = a.appPub ? unhex(a.appPub) : a.appKey && ed25519.getPublicKey(unhex(a.appKey))
  if (!pub || !a.fid) return
  // an RPC that can't be asked: send the remove, as before
  if ((await appKeyState(a.fid, pub).catch(() => 1)) === 1) await custodyTx(a, KEY_REGISTRY, async () => keyRegistryRemove(pub))
  await updateAccount({ ...fresh(a), appPub: undefined, appKey: undefined, appUntil: undefined })
  dropEd(hex(pub)).catch(() => {})
}

/** Sign out: this browser's signer revokes itself, so a copy of the key stops working too. It uses the key the account
 *  holds now: one replaced while deleting the account is the one that's still valid. */
export async function revokeSigner(a: Account) {
  a = fresh(a)
  // a key this browser doesn't have can't be used by anyone, so there's nothing to revoke
  const key = a.fid && (await signerOf(a).catch(() => undefined))
  if (!key) return
  await submit(await keyRemoveSelf(a.fid!, key, Math.floor(Date.now() / 1000))).catch(async (e) => {
    // revoked already (an earlier try landed, its answer didn't): the node no longer lists the key
    if (/invalid signer|unknown signer/i.test(e.message) && !(await signerListed(a))) return
    throw e
  })
}

// the stored copy of an account, which ensureSigner may have just updated
const fresh = (a: Account) => accounts.find((x) => idOf(x) === idOf(a)) || a
/** Sign and submit a message as `as` (the selected account unless a reply is sent as another one). */
const send = async (type: number, body: Uint8Array, as = account!) => {
  await ensureSigner(fresh(as))
  const go = async () => {
    const a = fresh(as)
    return submit(await envelope(type, a.fid!, body, await signerOf(a)))
  }
  return go().catch(async (e) => {
    // a key the node doesn't know, or one that went 90 days unused
    if (!/invalid signer|last_used_at expired/.test(e.message)) throw e
    await replaceSigner(fresh(as))
    return go()
  })
}

// only a 404 means "no such user"; any other failure rejects, so mentions() doesn't fall back to a shorter name
const fidByName = (name: string) =>
  byName(name).then(
    (u) => u.fid,
    (e) => {
      if (e?.status === 404) return undefined
      throw e
    },
  )

/** A cast can carry MAX_EMBEDS embeds: uploads and a quoted cast first, then links from the text (castEmbeds). */
export async function post(text: string, o: { parent?: CastRef; channel?: string; quote?: CastRef; media?: string[]; as?: Account } = {}) {
  const m = await mentions(text, fidByName)
  const embeds = castEmbeds(m.text, o.media || [], o.quote)
  const as = o.as || account!
  const hash = await send(MT.CAST_ADD, castBody({ ...m, parent: o.parent || o.channel, embeds }), as)
  // shown as the node will serve it: the text without its mentions, which go back in at their places (castText), so its
  // tags are the ones Hypersnap indexes (ui.tsx RichText)
  const c: Cast = {
    hash, text: m.text, mentioned_profiles: m.mentions.map((fid, i) => users.get(fid) || { fid, username: m.names[i] }),
    mentioned_profiles_ranges: m.positions.map((at) => ({ start: at, end: at })), timestamp: new Date().toISOString(), author: idOf(as) === idOf(account!) ? myUser()! : users.get(as.fid!) || { fid: as.fid!, username: as.username },
    parent_hash: o.parent?.hash ?? null, parent_url: o.channel ?? null, parent_author: { fid: o.parent?.fid ?? null },
    embeds: embeds.map((e) => (typeof e === 'string' ? { url: e } : { cast_id: e })),
    reactions: { likes_count: 0, recasts_count: 0 }, replies: { count: 0 },
  }
  posting.set(hash, c)
  // the next casts of a thread show under the first one too
  const up = o.parent && posting.get(o.parent.hash)
  if (up) up.direct_replies = [...(up.direct_replies || []), c]
  return hash
}

/** Where a thread goes out: its first post replies to `parent` (or goes into `channel`) and quotes `quote`. */
export type ThreadStart = { parent?: CastRef; channel?: string; quote?: CastRef; as?: Account }

/** Post a thread as `o.as`: the first post from `o`, each next one replying to the one before it. `onSent` hears each
 *  cast as it goes out, with where the rest of the thread goes on from: a reply to that cast, by the same account, its
 *  channel and quote already out with the first post. A send that fails partway throws; sending the posts left from the
 *  last `next` heard goes on with the same thread instead of starting a fork from `o.parent` (compose.tsx send). */
export async function postThread(posts: { text: string; media: string[] }[], o: ThreadStart, onSent: (hash: string, next: ThreadStart, i: number) => void = () => {}) {
  const as = o.as || account!
  const hashes: string[] = []
  let at: ThreadStart = o
  for (const [i, p] of posts.entries()) {
    const hash = await post(p.text, { ...at, media: p.media, as })
    hashes.push(hash)
    at = { parent: { fid: as.fid!, hash }, as }
    onSent(hash, at, i)
  }
  return hashes
}

/** Publish an article (article.ts splitArticle) as its chain of casts: the first with the title and cover, then each part
 *  replying to the one before it, all in article Markdown and placed in the chain. `sent` are the hashes of the casts an
 *  earlier try already sent (it stopped partway): those aren't sent again. `onSent` hears each cast's hash as it goes,
 *  so a try that fails partway can go on later. Returns every hash, the first cast's first. */
export async function postArticle(parts: Outgoing[], sent: string[] = [], onSent: (hashes: string[]) => void = () => {}) {
  const as = account!
  const fid = as.fid!
  const count = parts.length
  const hashes = [...sent]
  const shown: Part[] = []
  for (let i = 0; i < count; i++) {
    if (i >= hashes.length) {
      // a node takes 10 mentions a cast: the rest stay as text
      const m = await mentions(parts[i].text, fidByName, 10)
      const root = i ? { fid, hash: hashes[0] } : undefined
      const body = castBody({ ...m, embeds: parts[i].embeds, parent: i ? { fid, hash: hashes[i - 1] } : undefined, format: ARTICLE, chain: { root, index: i, count } })
      hashes.push(await send(MT.CAST_ADD, body, as))
      onSent([...hashes])
    }
    // as the node will have it, with the text as written, mentions in (no positions needed)
    shown.push({ fid, hash: hashes[i], at: Math.floor(Date.now() / 1000) - 1609459200 - 600, text: parts[i].text, mentions: [], positions: [], embeds: parts[i].embeds.map((url) => ({ url })), format: ARTICLE, chain: { ...(i && { root: { fid, hash: hashes[0] } }), index: i, count } })
  }
  publishedArticle(shown)
  // the first cast shows as "Posting…" until the node has it, like any other
  posting.set(hashes[0], {
    hash: hashes[0], text: parts[0].text, timestamp: new Date().toISOString(), author: myUser()!, parent_hash: null, parent_url: null, parent_author: { fid: null },
    embeds: parts[0].embeds.map((url) => ({ url })), reactions: { likes_count: 0, recasts_count: 0 }, replies: { count: count > 1 ? 1 : 0 }, article: shown[0],
  })
  return hashes
}

const json = async (r: Response) => {
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error || t('Upload failed ({status})', { status: r.status }))
  return j
}
// XHR rather than fetch, for upload progress events
const put = (url: string, body: Blob, onSent: (n: number) => void) =>
  new Promise<{ received: number }>((resolve, reject) => {
    const x = new XMLHttpRequest()
    x.open('PUT', url)
    x.upload.onprogress = (e) => onSent(e.loaded)
    x.onload = () => (x.status < 300 ? resolve(JSON.parse(x.responseText)) : reject(new Error(JSON.parse(x.responseText || '{}').error || t('Upload failed ({status})', { status: x.status }))))
    x.onerror = () => reject(new Error('Network error'))
    x.send(body)
  })

export type Progress = (stage: 'uploading' | 'processing', fraction?: number, secondsLeft?: number) => void

/** Headers that prove this browser's key signed "<what>:<fid>:<ts>:<body>" for the account just now; our server checks the
 *  key against the node (server/looks.mjs keySigned). */
// only background work meets it, and that work gives up quietly: never shown, so not translated
const NO_KEY = 'no key in this browser'
async function keySigned(what: string, body = '', as = account!, add = true) {
  // `add` false: only with the key this browser has now (background work), never a new one
  if (!add && !hasKey(fresh(as))) throw new Error(NO_KEY)
  if (add) await ensureSigner(fresh(as))
  const key = await (add ? signerOf(fresh(as)).catch(() => replaceSigner(fresh(as)).then(() => signerOf(fresh(as)))) : signerOf(fresh(as)))
  const ts = Date.now()
  const sig = await key.sign(new TextEncoder().encode(`${what}:${as.fid}:${ts}:${body}`))
  return { 'x-key': '0x' + hex(key.pub), 'x-ts': String(ts), 'x-sig': hex(sig) }
}

// a farcaster.xyz login request signed with the custody key, valid for 10 minutes: the server swaps it for the CDN
// token. Timestamps never repeat, because each one works only once.
let lastLogin = 0
async function login() {
  const ts = (lastLogin = Math.max(Date.now(), lastLogin + 1))
  const exp = ts + 600e3
  const authRequest = { method: 'generateToken', params: { timestamp: ts, expiresAt: exp } }
  const msg = new TextEncoder().encode(`{"method":"generateToken","params":{"expiresAt":${exp},"timestamp":${ts}}}`)
  // a bearer token: checked on this device only, never sent to the RPC
  const sig = await (await custodyOf(account!)).message(msg, { local: true })
  return { authorization: `Bearer eip191:${btoa(String.fromCharCode(...sig))}`, 'x-auth-request': JSON.stringify(authRequest) }
}

// the server takes at most 3 uploads at a time from an account (server/upload.mjs MAX_ACTIVE_PER_FID), so the rest wait
// here for their turn (several pictures picked at once, say, or attachments too) instead of failing
const slot = queue(3)

/** Upload a file in chunks through our server, which passes it to Farcaster's CDN (or keeps it). Returns the embed URL.
 *  It waits its turn while 3 others are uploading; its progress starts once it's on its way. */
export const upload = (original: Blob, progress: Progress = () => {}) => slot(() => uploadNow(original, progress))

async function uploadNow(original: Blob, progress: Progress) {
  const file = await scrub(original)
  // the browser's key says who's uploading. A recovery phrase kept here also signs a farcaster.xyz login without asking
  // anyone, which gets the file onto Farcaster's CDN for accounts farcaster.xyz serves; nothing else asks the custody
  // (a wallet, or a phrase this browser doesn't keep), and those files stay on our server
  const cdn = !!account!.phrase
  const begin = async (tries = 2): Promise<{ id: string; chunk: number }> => {
    const auth = cdn ? await login() : await keySigned('quilcast-upload')
    const r = await fetch('/api/upload', { method: 'POST', headers: { 'content-type': file.type, ...auth, 'x-fid': String(account!.fid), 'x-size': String(file.size) } })
    // a key the node doesn't list any more is replaced, as in saveLook
    if (r.status === 403 && !cdn && tries > 1) return replaceSigner().then(() => begin(tries - 1))
    return json(r)
  }
  const { id, chunk: max } = await begin()
  try {
    return await sendFile(file, id, max, cdn, progress)
  } catch (e) {
    // giving up frees its place on the server at once, so the next upload waiting here isn't turned away (with the
    // network down this can't arrive, and the server lets the place go after a couple of idle minutes instead)
    await fetch(`/api/upload/${id}`, { method: 'DELETE', signal: AbortSignal.timeout(5000) }).catch(() => {})
    throw e
  }
}

async function sendFile(file: Blob, id: string, max: number, cdn: boolean, progress: Progress) {
  progress('uploading', 0)
  // each request must finish well inside the proxy's 60 s, so chunks grow on fast links and shrink on slow ones
  let size = 512 * 1024
  const began = Date.now()
  for (let off = 0, tries = 0; off < file.size; ) {
    const t = Date.now()
    try {
      off = (await put(`/api/upload/${id}?offset=${off}`, file.slice(off, off + size), (n) => {
        const done = off + n
        const rate = done / Math.max(1, (Date.now() - began) / 1000)
        progress('uploading', Math.min(1, done / file.size), (file.size - done) / rate)
      })).received
      const took = (Date.now() - t) / 1000
      size = took < 5 ? Math.min(max, size * 2) : took > 20 ? Math.max(128 * 1024, size / 2) : size
      tries = 0
    } catch (e) {
      size = Math.max(128 * 1024, size / 2)
      if (++tries > 4) throw e
      await new Promise((r) => setTimeout(r, 1000 * tries))
    }
  }
  progress('processing')
  let st = await json(await fetch(`/api/upload/${id}/done`, { method: 'POST', headers: cdn ? await login() : {} }))
  while (st.state === 'sending' || st.state === 'processing') {
    await new Promise((r) => setTimeout(r, 1500))
    st = await json(await fetch(`/api/upload/${id}`))
  }
  if (st.state !== 'ready' || !st.url) throw new Error(st.error || 'Upload failed')
  return st.url as string
}

// --- nothing private leaves the device inside a file ---

/** Photos are re-encoded (≤2048px, JPEG or PNG when transparent) so EXIF/GPS is dropped; MP4/MOV lose their metadata boxes; GIFs and WebM go as-is. */
async function scrub(file: Blob): Promise<Blob> {
  if (/^image\/(jpeg|png|webp)$/.test(file.type)) return shrink(file)
  if (/^video\/(mp4|quicktime)$/.test(file.type)) return stripVideoMeta(file)
  return file
}

async function shrink(file: Blob): Promise<Blob> {
  const img = await createImageBitmap(file)
  const k = Math.min(1, 2048 / Math.max(img.width, img.height))
  const c = Object.assign(document.createElement('canvas'), { width: Math.round(img.width * k), height: Math.round(img.height * k) })
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(img, 0, 0, c.width, c.height)
  // anything with a see-through pixel (stickers) stays PNG so it keeps its transparency; opaque photos go JPEG
  const px = file.type === 'image/jpeg' ? null : ctx.getImageData(0, 0, c.width, c.height).data
  let alpha = false
  for (let i = 3; px && i < px.length && !alpha; i += 4) alpha = px[i] < 255
  const type = alpha ? 'image/png' : 'image/jpeg'
  return new Promise((r, e) => c.toBlob((b) => (b ? r(b) : e(new Error("Couldn't read that image"))), type, 0.88))
}

const FREE = new Uint8Array([0x66, 0x72, 0x65, 0x65])
const box = (b: Uint8Array, v: DataView, o: number, end: number) => {
  let size = v.getUint32(o)
  let hdr = 8
  if (size === 1) (size = Number(v.getBigUint64(o + 8))), (hdr = 16)
  else if (size === 0) size = end - o
  return { size, hdr, type: String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]) }
}
// turn 'udta' (location, device) and 'meta' (iPhone keys/ilst) boxes into zeroed 'free' boxes inside moov and its tracks
function scrubBoxes(b: Uint8Array, start: number, end: number) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  for (let o = start; o + 8 <= end; ) {
    const { size, hdr, type } = box(b, v, o, end)
    if (size < hdr || o + size > end) return
    if (type === 'udta' || type === 'meta') b.set(FREE, o + 4), b.fill(0, o + hdr, o + size)
    else if (type === 'trak' || type === 'mdia' || type === 'minf') scrubBoxes(b, o + hdr, o + size)
    o += size
  }
}
/** Sizes and offsets stay the same, so the file plays exactly as before; the metadata bytes are gone, not just hidden. */
export async function stripVideoMeta(file: Blob): Promise<Blob> {
  const parts: BlobPart[] = []
  let pos = 0
  for (let off = 0; off + 8 <= file.size; ) {
    const head = new Uint8Array(await file.slice(off, off + 16).arrayBuffer())
    const { size, hdr, type } = box(head, new DataView(head.buffer), 0, file.size - off)
    if (size < hdr) break
    if (type === 'moov' && size < 64e6) {
      const moov = new Uint8Array(await file.slice(off, off + size).arrayBuffer())
      scrubBoxes(moov, hdr, moov.length)
      parts.push(file.slice(pos, off), moov)
      pos = off + size
    } else if ((type === 'udta' || type === 'meta') && size < 64e6) {
      parts.push(file.slice(pos, off + 4), FREE, new Uint8Array(size - 8))
      pos = off + size
    }
    off += size
  }
  parts.push(file.slice(pos))
  return new Blob(parts, { type: file.type })
}

/** Ask farcaster.xyz for a token that reads and sends this account's direct casts (and does nothing else),
 *  signed by the custody address. The wording is farcaster.xyz's own, as Comm signs it. */
export async function connectMessages() {
  const a = account!
  const { result } = await dm('nonce')
  const message = `This signature grants access to read and write your Farcaster Direct Casts.

In most cases, this message should get signed invisibly, without your interaction.

If you are seeing this text from a signing prompt in your wallet, tread very carefully.

Direct cast authorization for Farcaster FID ${a.fid}

URI: https://client.farcaster.xyz/v2/get-dc-auth-token
Version: 1
Chain ID: 1
Nonce: ${result.nonce}
Issued At: ${new Date().toISOString()}`
  const signature = '0x' + hex(await (await custodyOf(a)).message(new TextEncoder().encode(message), { local: true }))
  const t = await dm('token', { method: 'POST', body: { message, signature } })
  if (!t.result?.token) throw new Error("farcaster.xyz didn't open your messages.")
  setAccount({ ...account!, dm: t.result.token })
}

/** A farcaster.xyz session token for Spaces, from a login request the custody address signs (as farcaster.xyz's
 *  own apps do). It's kept with the account for 30 days, so a wallet account isn't asked to sign every visit. */
let minting: Promise<string> | undefined
export function spaceToken(fresh = false): Promise<string> {
  const a = account!
  if (!fresh && a.fcx && a.fcx.exp > Date.now() + 60e3) return Promise.resolve(a.fcx.secret)
  // calls made at once share one login, so a wallet account is asked to sign once
  return (minting ||= mintSpaceToken(a).finally(() => (minting = undefined)))
}
async function mintSpaceToken(a: Account) {
  const ts = Date.now()
  const exp = ts + 30 * 864e5
  const authRequest = { method: 'generateToken', params: { timestamp: ts, expiresAt: exp } }
  // a 30-day bearer token: checked on this device only, never sent to the RPC
  const sig = await (await custodyOf(a)).message(new TextEncoder().encode(`{"method":"generateToken","params":{"expiresAt":${exp},"timestamp":${ts}}}`), { local: true })
  const r = await fetch('/api/space/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ authRequest, bearer: `eip191:${btoa(String.fromCharCode(...sig))}` }) })
  const j = await r.json().catch(() => ({}))
  if (!j.secret) throw new Error("farcaster.xyz didn't let this account into Spaces.")
  if (account && idOf(account) === idOf(a)) setAccount({ ...account, fcx: { secret: j.secret, exp: j.expiresAt || exp } })
  return j.secret as string
}

export const deleteCast = (hash: string) => send(MT.CAST_REMOVE, castRemoveBody(hash))
export const react = (type: 1 | 2, on: boolean, c: { author: { fid: number }; hash: string }) =>
  send(on ? MT.REACTION_ADD : MT.REACTION_REMOVE, reactionBody(type, c.author.fid, c.hash))
export const follow = (fid: number, on: boolean) => send(on ? MT.LINK_ADD : MT.LINK_REMOVE, followBody(fid))
export const setUserData = (type: number, value: string) => send(MT.USER_DATA_ADD, userDataBody(type, value))


/** A request to our server signed with the account's Farcaster key. A key ensureSigner just added takes the node a
 *  few seconds to list; one the node doesn't list at all is replaced (`tries` > 1). */
async function keyFetch(url: string, what: string, method: string, body = '', tries = 3, as = account!, extra: Record<string, string> = {}, add = true): Promise<any> {
  const r = await fetch(url, { method, headers: { ...(method !== 'GET' && { 'content-type': 'application/json' }), ...extra, ...(await keySigned(what, body, as, add)) }, body: method === 'GET' ? undefined : body })
  const j = await r.json().catch(() => null)
  if (r.status === 403 && tries > 1) return ((await signerListed(fresh(as))) ? sleep(3000) : replaceSigner(fresh(as))).then(() => keyFetch(url, what, method, body, tries - 1, as, extra))
  if (!r.ok) throw new Error(j?.error || t('Saving failed ({status})', { status: r.status }))
  return j
}

// --- deleting the account (Settings → Delete account) ---

/** Our server forgets the account (server/account.mjs): look, mutes, drafts, uploads. It works in the background there,
 *  reading the account's casts from the node, so this asks again until it's done. Run it before the casts go. It signs
 *  as `a` (the account being deleted), whichever account is selected meanwhile. */
export async function deleteServerData(a = account!): Promise<{ media: number; kept: number; look: boolean; mutes: boolean; drafts: number; translations: number }> {
  // one id for this deletion: asking again (a reply lost on the way) gets the same answer, a later deletion a new one
  const run = crypto.randomUUID()
  for (let i = 0; i < 60; i++) {
    const r = await patient(() => keyFetch(`/api/account/${a.fid}?run=${run}`, 'quilcast-delete', 'DELETE', '', 3, a))
    if (r?.state === 'done') return r
  }
  throw new Error("Quilcast's server is still deleting your data. Try again in a few minutes.")
}

export type EraseStep = 'casts' | 'reactions' | 'follows' | 'profile'
export type Erased = Record<EraseStep, number> & { failed: number; error?: string }
// profile fields the node takes empty, by the names it lists them under (GitHub can't be emptied; the username stays
// with the ID, whose fname is still registered to it)
const CLEAR: Record<string, number> = {
  USER_DATA_TYPE_PFP: 1, USER_DATA_TYPE_DISPLAY: 2, USER_DATA_TYPE_BIO: 3, USER_DATA_TYPE_URL: 5, USER_DATA_TYPE_LOCATION: 7,
  USER_DATA_TYPE_TWITTER: 8, USER_DATA_TYPE_BANNER: 10, USER_DATA_PRIMARY_ADDRESS_ETHEREUM: 11, USER_DATA_PRIMARY_ADDRESS_SOLANA: 12,
}
// a busy node, a rate limit or a dropped connection is worth waiting out; a cast removed already is done (whatever the
// node says, eraseFarcaster checks its lists again at the end)
const passing = (e: any) => /rate.?limit|too many|\b(429|50[0-4])\b|timed? ?out|unavailable|busy|network|fetch|load failed|try again/i.test(String(e?.message))
const already = (e: any) => /conflict|duplicate|already/i.test(String(e?.message))
// about a minute and a half of waiting, at most
async function patient<T>(f: () => Promise<T>, tries = 8): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await f()
    } catch (e) {
      if (i >= tries - 1 || !passing(e)) throw e
      await sleep(Math.min(30e3, 1000 * 2 ** i))
    }
  }
}
/** Every message on a node list (`/v1/castsByFid` and the like), all pages. */
async function everything(path: string, q: Record<string, string | number>) {
  const all: any[] = []
  for (let token: string | undefined, i = 0; ; i++) {
    if (i >= 1000) throw new Error('This account has too many casts to delete here. Write to support@borodutch.com.')
    const r = await patient(() => get(path, { ...q, pageSize: 1000, pageToken: token }, true))
    all.push(...(r.messages || []))
    if (!r.nextPageToken || !r.messages?.length) return all
    token = r.nextPageToken
  }
}
/** What the node lists for the account: its casts, likes, recasts, follows and the profile fields that can be emptied. */
async function listed(fid: number) {
  const [casts, likes, recasts, follows, profile] = await Promise.all([
    everything('/v1/castsByFid', { fid }),
    everything('/v1/reactionsByFid', { fid, reaction_type: 'Like' }),
    everything('/v1/reactionsByFid', { fid, reaction_type: 'Recast' }),
    everything('/v1/linksByFid', { fid, link_type: 'follow' }),
    patient(() => get('/v1/userDataByFid', { fid }, true)).then((r) => r.messages || []),
  ])
  return {
    casts: casts.map((m) => m.hash as string),
    reactions: [...likes, ...recasts].filter((m) => m.data?.reactionBody),
    follows: follows.filter((m) => m.data?.linkBody?.targetFid),
    profile: profile.filter((m: any) => m.data?.userDataBody?.value && CLEAR[m.data.userDataBody.type]),
  }
}

/** The account's casts, likes, recasts and follows go from Farcaster, and its profile is emptied: a remove message for
 *  each (an empty value for a profile field), four at a time, waiting out a busy node. Then the node's lists are read
 *  again, and whatever they still hold is `failed`; running it again only goes after that. */
export async function eraseFarcaster(progress: (step: EraseStep | 'find', done: number, total: number) => void, settle = 3000, me = account!): Promise<Erased> {
  const fid = me.fid!
  await ensureSigner(fresh(me))
  progress('find', 0, 0)
  const { casts, reactions, follows, profile } = await listed(fid)
  // several at once may all find the key gone: one replaces it (a wallet is asked once), the others wait for it
  let replacing: Promise<void> | null = null
  // a like, follow or profile field is whatever its newest message says, so each remove is newer than what it removes
  const remove = (type: number, body: Uint8Array, after = 0) => {
    const go = async () => submit(await envelope(type, fid, body, await signerOf(fresh(me)), after))
    return patient(() => go().catch(async (e) => {
      if (!/invalid signer|last_used_at expired/.test(e.message)) throw e
      await (replacing ||= replaceSigner(fresh(me)).finally(() => (replacing = null)))
      return go()
    }))
  }
  const out: Erased = { casts: 0, reactions: 0, follows: 0, profile: 0, failed: 0 }
  const run = async <T,>(step: EraseStep, items: T[], f: (x: T) => Promise<unknown>) => {
    let done = 0
    progress(step, 0, items.length)
    const next = items.values()
    await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
      for (const x of next) {
        await f(x).then(() => out[step]++, (e) => (step === 'casts' && already(e) ? out[step]++ : (out.error ||= e.message)))
        progress(step, ++done, items.length)
      }
    }))
  }
  await run('casts', casts, (h) => remove(MT.CAST_REMOVE, castRemoveBody(h)))
  await run('reactions', reactions, (m) => {
    const b = m.data.reactionBody
    const type = b.type === 'REACTION_TYPE_RECAST' ? 2 : 1
    return remove(MT.REACTION_REMOVE, b.targetCastId ? reactionBody(type, b.targetCastId.fid, b.targetCastId.hash) : reactionUrlBody(type, b.targetUrl), m.data.timestamp)
  })
  await run('follows', follows, (m) => remove(MT.LINK_REMOVE, followBody(m.data.linkBody.targetFid), m.data.timestamp))
  await run('profile', profile, (m: any) => remove(MT.USER_DATA_ADD, userDataBody(CLEAR[m.data.userDataBody.type], ''), m.data.timestamp))
  // the node takes a message before it lands, so what's still listed is asked again a few times before it counts
  for (let i = 0; i < 4; i++) {
    if (i) await sleep(settle)
    const left = await listed(fid)
    out.failed = left.casts.length + left.reactions.length + left.follows.length + left.profile.length
    if (!out.failed) return delete out.error, out
  }
  out.error ||= t('The Farcaster node still lists them.')
  return out
}

/** A change to the account's sticker packs (server/stickers.mjs postStickers), signed with its Farcaster key. */
export const stickerOp = (body: object) => keyFetch(`/api/stickers/${account!.fid}`, 'quilcast-stickers', 'POST', JSON.stringify(body))

/** Save the account's profile look on our server (null goes back to plain), signed with its Farcaster key. */
export const saveLook = (look: object | null) => keyFetch(`/api/look/${account!.fid}`, 'quilcast-look', 'PUT', JSON.stringify(look))

/** Pin one of account `a`'s casts to the top of its profile on our server (null unpins), signed with its Farcaster key,
 *  whichever account is selected meanwhile. Answers the pinned hash, or null. */
export const savePin = (hash: string | null, a = account!) =>
  keyFetch(`/api/pin/${a.fid}`, 'quilcast-pin', 'PUT', JSON.stringify(hash && { hash }), 3, a).then((j) => (j?.hash as string | undefined) || null)

/** Tells our server this browser's first sign-in came through `campaign`'s link (src/campaign.ts); it counts sign-ups
 *  per campaign and keeps nothing about the account. A new key can take a moment to reach the node, so it asks again a
 *  few times, never adding a key for it. */
export async function sendSignup(campaign: string, a = account!) {
  const body = JSON.stringify({ campaign })
  for (let i = 1; ; i++) {
    try {
      // the account goes in a header, not the URL, so no request log ties it to the campaign
      return await keyFetch('/api/signup', 'quilcast-signup', 'POST', body, 1, a, { 'x-fid': String(a.fid) })
    } catch (e) {
      if (i === 4) throw e
      await sleep(5000 * i)
    }
  }
}

/** The account's mutes and blocks from our server, or null when this browser has no working key yet (reading them
 *  never adds one, so it can't ask for the recovery phrase). */
export const fetchMutes = (a = account!) =>
  (a.pub || a.signer) && a.scopes === SCOPES_VERSION ? keyFetch(`/api/mutes/${a.fid}`, 'quilcast-mutes-read', 'GET', '', 1) : Promise.resolve(null)
/** Sends a report to us (server/report.mjs). Signed in, the account's key signs it, so we know who reported. */
export async function sendReport(r: { fid: number; hash?: string; reason: string; text: string }) {
  const body = JSON.stringify(r)
  const who = account?.done ? await keySigned('quilcast-report', body).then((h) => ({ ...h, 'x-fid': String(account!.fid) }), () => ({})) : {}
  const res = await fetch('/api/report', { method: 'POST', body, headers: { 'content-type': 'application/json', ...who } })
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || "The report couldn't be sent. Try again.")
}
/** Whether `a` has a key that works now in this browser, so signing with it never has to add one. */
export const hasKey = (a: Account) => !!(a.pub || a.signer) && a.scopes === SCOPES_VERSION
/** Signs `a` up for push notifications of its activity on this browser (src/alerts.ts, server/alerts.mjs). In the
 *  `background` (not a click for this account) it signs only with the key there is: never a new one, nor a retry that replaces it. */
export const saveAlerts = (a: Account, body: string, background = false) =>
  keyFetch(`/api/alerts/${a.fid}`, 'quilcast-alerts', 'PUT', body, background ? 1 : 3, a, {}, !background)
export const saveMutes = (m: object) => keyFetch(`/api/mutes/${account!.fid}`, 'quilcast-mutes', 'PUT', JSON.stringify(m))
/** The account's synced theme settings (src/prefs.ts). `ask` lets it add a key (Settings turning sync on); without it,
 *  like fetchMutes, it answers null when this browser has no working key. */
export const fetchPrefs = (ask = false, a = account!) =>
  ask || ((a.pub || a.signer) && a.scopes === SCOPES_VERSION) ? keyFetch(`/api/prefs/${a.fid}`, 'quilcast-prefs-read', 'GET', '', ask ? 3 : 1) : Promise.resolve(null)
export const savePrefs = (p: object) => keyFetch(`/api/prefs/${account!.fid}`, 'quilcast-prefs', 'PUT', JSON.stringify(p))

// --- drafts ---
// Kept on our server (server/drafts.mjs), each sealed with AES-GCM under a key only the account's custody can make: the
// SHA-256 of its signature of a fixed message. The phrase and Ethereum wallets sign deterministically, so every device
// makes the same key and the server only ever holds ciphertext. A browser keeps the key in the vault (non-extractable),
// so the custody signs once per browser.
// ponytail: a smart-contract wallet may sign differently each time; its drafts then open only in the browser that saved them
// `pfid` is the fid of the author of the cast it replies to, so the draft can still go out as that reply when the node
// can't serve the cast (draftParent)
export type Draft = { id: string; at: number; parts: { text: string; media: string[] }[]; channel?: string; parent?: string; pfid?: number; quote?: string; as?: number }

/** Where a draft goes: a reply to `parent` (or, with `lost`, to a cast that couldn't be loaded), else into `channel`. */
export const draftTarget = (parent: Cast | undefined, lost: string | undefined, channel: string | undefined): Pick<Draft, 'channel' | 'parent' | 'pfid'> =>
  parent ? { parent: parent.hash, pfid: parent.author.fid || undefined } : lost ? { parent: lost } : { channel }

// a cast asked for by its hash (as ui.tsx fetchCast asks) and author, not from the cache; null when the node doesn't
// serve it within a few seconds, so a dead network doesn't hold up opening a draft
const castBy = (hash: string, fid: number) =>
  Promise.race([
    get('/v2/farcaster/cast', { identifier: hash.replace(/^0x/, '').toLowerCase(), type: 'hash', fid }, true).then((r) => (r.cast as Cast) || null, () => null),
    new Promise<null>((ok) => setTimeout(ok, 5000, null)),
  ])

/** The cast a reply draft goes on replying to when the node didn't serve `d.parent` (it may not have it yet, or the
 *  network failed). It's asked for again by author: the one the draft kept (`pfid`), then the draft's own account (a
 *  thread of ours that failed partway, still landing). Not found, a known `pfid` makes a stand-in by that author, which
 *  is all a reply needs. null when its author isn't known: the composer then warns and won't send it, rather than post
 *  it as a new cast. */
export async function draftParent(d: Pick<Draft, 'parent' | 'pfid' | 'as'>, ask = castBy): Promise<Cast | null> {
  if (!d.parent) return null
  for (const fid of new Set([d.pfid, d.as].filter((f): f is number => !!f))) {
    const c = await ask(d.parent, fid)
    if (c) return c
  }
  if (!d.pfid) return null
  const author = users.get(d.pfid) || { fid: d.pfid }
  return { hash: d.parent, text: '', timestamp: new Date().toISOString(), author, embeds: [], reactions: { likes_count: 0, recasts_count: 0 }, replies: { count: 0 } }
}
const draftKeys = new Map<number, Promise<CryptoKey>>()
const draftKey = (a = account!) => {
  const fid = a.fid!
  if (!draftKeys.has(fid))
    draftKeys.set(fid, (async () => {
      const kept = await kv<CryptoKey | undefined>('readonly', (s) => s.get(`drafts:${fid}`)).catch(() => undefined)
      if (kept) return kept
      // the message never changes (not even its language): a different one would make a different key
      const msg = new TextEncoder().encode(`Quilcast drafts key for FID ${fid}\n\nSigning this lets Quilcast encrypt your drafts so only you can read them. It sends nothing and costs nothing.`)
      // the signature is the key's secret, so it's never sent to the RPC to be checked
      const sig = await (await custodyOf(a)).message(msg, { local: true })
      // r and s of a plain signature; all of a smart wallet's, whose first bytes are the same public ABI headers for everyone
      const secret = sig.slice(0, sig.length === 65 ? 64 : sig.length)
      const key = await crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', secret), 'AES-GCM', false, ['encrypt', 'decrypt'])
      await kv('readwrite', (s) => s.put(key, `drafts:${fid}`)).catch(() => {})
      return key
    })().catch((e) => (draftKeys.delete(fid), Promise.reject(e))))
  return draftKeys.get(fid)!
}
const b64 = (b: Uint8Array) => btoa(Array.from(b, (x) => String.fromCharCode(x)).join(''))
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

/** The account's drafts, newest first; asks its custody to sign the first time in this browser. */
export async function listDrafts(): Promise<Draft[]> {
  const key = await draftKey()
  const got: { id: string; box: string }[] = await keyFetch(`/api/drafts/${account!.fid}`, 'quilcast-drafts-read', 'GET')
  const open = async ({ id, box }: { id: string; box: string }) => {
    const [iv, data] = box.split('.').map(unb64)
    return { ...JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data))), id } as Draft
  }
  // one sealed under another key (see ponytail above) is skipped
  return (await Promise.all(got.map((d) => open(d).catch(() => null)))).filter((d) => !!d).sort((a, b) => b.at - a.at)
}
export async function saveDraft(d: Draft) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await draftKey(), new TextEncoder().encode(JSON.stringify(d))))
  await keyFetch(`/api/drafts/${account!.fid}`, 'quilcast-drafts', 'PUT', JSON.stringify({ id: d.id, box: `${b64(iv)}.${b64(data)}` }))
}
export const dropDraft = (id: string) => keyFetch(`/api/drafts/${account!.fid}`, 'quilcast-drafts', 'PUT', JSON.stringify({ id, box: null }))

// --- scheduled casts ---
// Signed here, each with the time it should go out as its own timestamp, and handed to our server, which holds the
// finished messages and submits them then (server/scheduled.mjs). The server holds no key: it can't change them or
// post anything else. Not sealed like drafts: the server reads them to send them, and they're public once out.
export type ScheduledPost = { text: string; media: string[] }
export type Scheduled = { id: string; at: number; hash: string; hashes: string[]; status: 'scheduled' | 'posting' | 'posted' | 'failed'; posted: number; error?: string; draft?: Omit<Draft, 'id' | 'at'>; done?: number }
/** The most posts one scheduled thread holds (server/scheduled.mjs MAX_PARTS). */
export const MAX_SCHEDULED_PARTS = 25

/** What's left of a failed thread whose first posts went out: its draft's posts that didn't, to go out as replies to
 *  the last one that did (`parent`, its hash; `last`, its text). null when none went out, or when its draft doesn't line up with what was
 *  signed (then the composer warns before it's all posted again). The composer leaves out an empty post past the
 *  first, so the draft's posts are matched to the signed ones the same way. */
export function unsent(s: Scheduled): { parts: Draft['parts']; parent: string; last: string } | null {
  if (!s.draft || !(s.posted > 0) || s.posted >= s.hashes.length) return null
  const signed = s.draft.parts.filter((p, i) => i === 0 || p.text.trim() || p.media.length)
  if (signed.length !== s.hashes.length) return null
  return { parts: signed.slice(s.posted), parent: s.hashes[s.posted - 1], last: signed[s.posted - 1].text }
}

/** Schedule a cast, or a thread (each next post replying to the one before, a second later), as `as` for `at` (Unix
 *  ms). `draft` is what the composer had, for the list and Edit. Returns the item, its first cast's hash included. */
export async function schedule(posts: ScheduledPost[], o: { parent?: CastRef; channel?: string; quote?: CastRef; as?: Account; draft: Omit<Draft, 'id' | 'at'> }, at: number, id: string = crypto.randomUUID()): Promise<Scheduled> {
  if (posts.length > MAX_SCHEDULED_PARTS) throw new Error(t('A scheduled thread can have up to {n} posts.', { n: MAX_SCHEDULED_PARTS }))
  const as = o.as || account!
  const url = `/api/scheduled/${as.fid}`
  // asked first so a key the node doesn't list yet is waited for (or replaced) before anything is signed with it
  await keyFetch(url, 'quilcast-scheduled-read', 'GET', '', 3, as)
  const key = await signerOf(fresh(as))
  const fid = as.fid!
  const msgs: string[] = []
  let prev: CastRef | undefined
  for (const [i, p] of posts.entries()) {
    const m = await mentions(p.text, fidByName)
    const embeds = castEmbeds(m.text, p.media, i === 0 ? o.quote : undefined)
    const body = castBody({ ...m, parent: i === 0 ? o.parent || o.channel : prev, embeds })
    const signed = await castAt(fid, body, key, Math.floor(at / 1000) * 1000 + i * 1000)
    msgs.push(b64(signed.msg))
    prev = { fid, hash: signed.hash }
  }
  return keyFetch(url, 'quilcast-scheduled', 'PUT', JSON.stringify({ id, msgs, draft: o.draft }), 1, as)
}
/** The account's scheduled casts, soonest first: waiting, being sent, posted (for a few days) and failed. */
export const listScheduled = (as = account!): Promise<Scheduled[]> => keyFetch(`/api/scheduled/${as.fid}`, 'quilcast-scheduled-read', 'GET', '', 3, as)
/** Cancel one still waiting, or take a posted or failed one off the list. Answers what it was (null: gone already). */
export const cancelScheduled = (id: string, as = account!): Promise<{ id: string; was: Scheduled['status'] | null }> =>
  keyFetch(`/api/scheduled/${as.fid}`, 'quilcast-scheduled-cancel', 'DELETE', JSON.stringify({ id }), 3, as)
/** The ids of the account's scheduled casts still waiting to go out, quietly: only with the key it has, never asking
 *  for a new one (Settings → Sign out, which revokes that key, warns about them and cancels them first). */
// with no key in this browser, nothing here was signed with the key signing out revokes: none waiting on it. A key
// whose scopes are out of date is still revoked, so its list is read (and not being able to says so in the prompt).
export const waitingScheduled = async (as = account!): Promise<string[]> =>
  !(fresh(as).pub || fresh(as).signer) ? [] : waitingToPost(await keyFetch(`/api/scheduled/${as.fid}`, 'quilcast-scheduled-read', 'GET', '', 1, as, {}, false) as Scheduled[]).map((s) => s.id)
/** Scheduled casts of the account that failed and this browser hasn't told about yet (once each), quietly: only with
 *  the key it has, never asking for a new one. */
export async function failedScheduled(as = account!): Promise<Scheduled[]> {
  const list: Scheduled[] = await keyFetch(`/api/scheduled/${as.fid}`, 'quilcast-scheduled-read', 'GET', '', 1, as, {}, false)
  const told = new Set<string>(JSON.parse(localStorage.getItem('quilcast:scheduled-told') || '[]'))
  const news = list.filter((s) => s.status === 'failed' && !told.has(s.id))
  if (news.length) localStorage.setItem('quilcast:scheduled-told', JSON.stringify([...told, ...news.map((s) => s.id)].slice(-200)))
  return news
}
