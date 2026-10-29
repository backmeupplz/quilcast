// Signed writes: everything here needs the account's keys.
import { ed25519 } from '@noble/curves/ed25519.js'
import { account, accounts, askUser, byName, forget, get, idOf, LINK_RE, myUser, posting, setAccount, settings, toUrl, updateAccount, users, type Account, type Cast } from './api.ts'
import { dm } from './dms.ts'
import { t } from './i18n.ts'
import { balance, sendTx } from './eth.ts'
import { castBody, castRemoveBody, custodyKey, envelope, followBody, hex, KEY_GATEWAY, KEY_REGISTRY, keyAdd, keyCustody, keyGatewayAdd, keyRegistryRemove, keyRemoveSelf, mentions, MT, rawEd, reactionBody, SCOPES_VERSION, unhex, userDataBody, type CastRef, type Custody } from './fc.ts'
import { dropEd, edKey, kv, newEd, type Ed } from './keys.ts'
import { MAX_EMBEDS } from './shared.ts'

/** The custody key of a phrase account: from the phrase in the vault, or, when this browser doesn't keep it (Settings
 *  can remove it), from one the person types in for this one action, which isn't kept, not even in memory. */
async function custody(a: Account) {
  if (a.phrase) return custodyKey(a.phrase)
  const phrase = await askUser.phrase(a)
  if (!phrase) throw new Error("This needs the account's recovery phrase.")
  return custodyKey(phrase, false)
}

/** Who signs for an account's custody address: the key from its phrase, or the wallet it was connected with. */
export const custodyOf = async (a: Account): Promise<Custody> =>
  a.wallet ? (await import('./wallet.ts')).walletCustody(a.wallet) : keyCustody(await custody(a))

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

/** A transaction on Optimism from the account's custody: its wallet, or the phrase key (which needs a little ETH there).
 *  `data` is built with the same custody, so a phrase that has to be typed in is asked for once. */
async function custodyTx(a: Account, to: string, data: (c: Custody) => Promise<string>) {
  if (a.wallet) return (await import('./wallet.ts')).sendTx(a.wallet, to, await data(await custodyOf(a)))
  const key = await custody(a)
  const { address } = keyCustody(key)
  if ((await balance(settings.rpc, address)) === 0n) throw new Error(t("Your account address {address} needs a little ETH on Optimism (a cent's worth) to pay for this.", { address }))
  return sendTx(settings.rpc, key, to, await data(keyCustody(key)))
}

const onChain = async (fid: number, key: Uint8Array) =>
  ((await get('/v1/onChainSignersByFid', { fid }, true).catch(() => ({ events: [] }))).events as { signerEventBody?: { key?: string } }[])
    .some((e) => e.signerEventBody?.key?.toLowerCase() === '0x' + hex(key))

/** The key mini app webhook events are signed with. Apps check it against Farcaster's KeyRegistry, which the
 *  Hypersnap signer isn't in, so this one is added on chain (KeyGateway.add from the custody), once per browser. */
export async function ensureAppKey(onWait?: (what: string) => void) {
  let a = account!
  let key = a.appPub || a.appKey ? await keyOf(a.appPub, a.appKey).catch(() => undefined) : undefined
  if (!key) {
    const [k, raw] = await newKey()
    onWait?.(a.wallet ? t('Confirm the key in your wallet (Optimism)') : t('Adding a notification key on Optimism…'))
    await custodyTx(a, KEY_GATEWAY, (c) => keyGatewayAdd(a.fid!, c, k.pub, Math.floor(Date.now() / 1000) + 3600))
    // kept as soon as the transaction is out, so a reload doesn't add a second key
    setAccount((a = { ...account!, appPub: hex(k.pub), appKey: raw }))
    key = k
  }
  onWait?.(t('Waiting for the network to see the key…'))
  for (let i = 0; !(await onChain(a.fid!, key.pub)); i++) {
    if (i >= 40) throw new Error('The notification key is still being confirmed. Try again in a minute.')
    await new Promise((r) => setTimeout(r, 3000))
  }
  return key
}

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
/** A JSON Farcaster Signature over `payload`, signed with the app key: what mini app webhooks receive. */
export async function signEvent(payload: object, onWait?: (what: string) => void) {
  const key = await ensureAppKey(onWait)
  const enc = new TextEncoder()
  const header = b64url(enc.encode(JSON.stringify({ fid: account!.fid, type: 'app_key', key: '0x' + hex(key.pub) })))
  const body = b64url(enc.encode(JSON.stringify(payload)))
  return { header, payload: body, signature: b64url(await key.sign(enc.encode(`${header}.${body}`))) }
}

/** Sign out, step one: the on-chain app key is removed (KeyRegistry.remove from the custody), and the
 *  notification inbox on our server is dropped. */
export async function removeAppKey(a: Account) {
  if (a.inbox) await fetch('/api/notify/drop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inbox: a.inbox }) }).catch(() => {})
  const pub = a.appPub ? unhex(a.appPub) : a.appKey && ed25519.getPublicKey(unhex(a.appKey))
  if (pub && a.fid) await custodyTx(a, KEY_REGISTRY, async () => keyRegistryRemove(pub))
}

/** Sign out: this browser's signer revokes itself, so a copy of the key stops working too. */
export async function revokeSigner(a: Account) {
  // a key this browser doesn't have can't be used by anyone, so there's nothing to revoke
  const key = a.fid && (await signerOf(a).catch(() => undefined))
  if (key) await submit(await keyRemoveSelf(a.fid!, key, Math.floor(Date.now() / 1000)))
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

const fidByName = (name: string) => byName(name).then((u) => u.fid, () => undefined)

/** A cast can carry MAX_EMBEDS embeds: uploads and a quoted cast first, then links from the text. */
export async function post(text: string, o: { parent?: CastRef; channel?: string; quote?: CastRef; media?: string[]; as?: Account } = {}) {
  const m = await mentions(text, fidByName)
  const embeds: (string | CastRef)[] = [...(o.media || []), ...(o.quote ? [o.quote] : [])]
  for (const u of new Set((m.text.match(LINK_RE) || []).map(toUrl))) embeds.length < MAX_EMBEDS && embeds.push(u)
  const as = o.as || account!
  const hash = await send(MT.CAST_ADD, castBody({ ...m, parent: o.parent || o.channel, embeds: embeds.slice(0, MAX_EMBEDS) }), as)
  const c: Cast = {
    hash, text, timestamp: new Date().toISOString(), author: idOf(as) === idOf(account!) ? myUser()! : users.get(as.fid!) || { fid: as.fid!, username: as.username },
    parent_hash: o.parent?.hash ?? null, parent_url: o.channel ?? null, parent_author: { fid: o.parent?.fid ?? null },
    embeds: embeds.slice(0, MAX_EMBEDS).map((e) => (typeof e === 'string' ? { url: e } : { cast_id: e })),
    reactions: { likes_count: 0, recasts_count: 0 }, replies: { count: 0 },
  }
  posting.set(hash, c)
  // the next casts of a thread show under the first one too
  const up = o.parent && posting.get(o.parent.hash)
  if (up) up.direct_replies = [...(up.direct_replies || []), c]
  return hash
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
async function keySigned(what: string, body = '') {
  await ensureSigner()
  const key = await signerOf(account!).catch(() => replaceSigner().then(() => signerOf(account!)))
  const ts = Date.now()
  const sig = await key.sign(new TextEncoder().encode(`${what}:${account!.fid}:${ts}:${body}`))
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
  const sig = await (await custodyOf(account!)).message(msg)
  return { authorization: `Bearer eip191:${btoa(String.fromCharCode(...sig))}`, 'x-auth-request': JSON.stringify(authRequest) }
}

/** Upload a file in chunks through our server, which passes it to Farcaster's CDN (or keeps it). Returns the embed URL. */
export async function upload(original: Blob, progress: Progress = () => {}) {
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
  const signature = '0x' + hex(await (await custodyOf(a)).message(new TextEncoder().encode(message)))
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
  const sig = await (await custodyOf(a)).message(new TextEncoder().encode(`{"method":"generateToken","params":{"expiresAt":${exp},"timestamp":${ts}}}`))
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
async function keyFetch(url: string, what: string, method: string, body = '', tries = 3): Promise<any> {
  const r = await fetch(url, { method, headers: { ...(method !== 'GET' && { 'content-type': 'application/json' }), ...(await keySigned(what, body)) }, body: method === 'GET' ? undefined : body })
  const j = await r.json().catch(() => null)
  if (r.status === 403 && tries > 1) return ((await signerListed()) ? sleep(3000) : replaceSigner()).then(() => keyFetch(url, what, method, body, tries - 1))
  if (!r.ok) throw new Error(j?.error || t('Saving failed ({status})', { status: r.status }))
  return j
}

/** Save the account's profile look on our server (null goes back to plain), signed with its Farcaster key. */
export const saveLook = (look: object | null) => keyFetch(`/api/look/${account!.fid}`, 'quilcast-look', 'PUT', JSON.stringify(look))

/** The account's mutes and blocks from our server, or null when this browser has no working key yet (reading them
 *  never adds one, so it can't ask for the recovery phrase). */
export const fetchMutes = (a = account!) =>
  (a.pub || a.signer) && a.scopes === SCOPES_VERSION ? keyFetch(`/api/mutes/${a.fid}`, 'quilcast-mutes-read', 'GET', '', 1) : Promise.resolve(null)
export const saveMutes = (m: object) => keyFetch(`/api/mutes/${account!.fid}`, 'quilcast-mutes', 'PUT', JSON.stringify(m))

// --- drafts ---
// Kept on our server (server/drafts.mjs), each sealed with AES-GCM under a key only the account's custody can make: the
// SHA-256 of its signature of a fixed message. The phrase and Ethereum wallets sign deterministically, so every device
// makes the same key and the server only ever holds ciphertext. A browser keeps the key in the vault (non-extractable),
// so the custody signs once per browser.
// ponytail: a smart-contract wallet may sign differently each time; its drafts then open only in the browser that saved them
export type Draft = { id: string; at: number; parts: { text: string; media: string[] }[]; channel?: string; parent?: string; quote?: string; as?: number }
const draftKeys = new Map<number, Promise<CryptoKey>>()
const draftKey = (a = account!) => {
  const fid = a.fid!
  if (!draftKeys.has(fid))
    draftKeys.set(fid, (async () => {
      const kept = await kv<CryptoKey | undefined>('readonly', (s) => s.get(`drafts:${fid}`)).catch(() => undefined)
      if (kept) return kept
      // the message never changes (not even its language): a different one would make a different key
      const msg = new TextEncoder().encode(`Quilcast drafts key for FID ${fid}\n\nSigning this lets Quilcast encrypt your drafts so only you can read them. It sends nothing and costs nothing.`)
      const sig = await (await custodyOf(a)).message(msg)
      const key = await crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', sig.slice(0, 64)), 'AES-GCM', false, ['encrypt', 'decrypt'])
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
