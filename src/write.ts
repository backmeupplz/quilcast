// Signed writes: everything here needs the account's keys.
import { ed25519 } from '@noble/curves/ed25519.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { HDKey } from '@scure/bip32'
import { account, byName, get, LINK_RE, myUser, posting, setAccount, settings, toUrl, type Account, type Cast } from './api.ts'
import { dm } from './dms.ts'
import { balance, sendTx } from './eth.ts'
import { castBody, castRemoveBody, envelope, followBody, hex, KEY_GATEWAY, KEY_REGISTRY, keyAdd, keyCustody, keyGatewayAdd, keyRegistryRemove, keyRemoveSelf, mentions, MT, reactionBody, SCOPES_VERSION, unhex, userDataBody, type CastRef, type Custody } from './fc.ts'

const keys = new Map<string, Promise<Uint8Array>>()
/** Custody key derived the way Warpcast and Quorum do it (BIP-39 seed, m/44'/60'/0'/0/0), so phrases
 *  move between apps. The seed's PBKDF2 runs in WebCrypto: native, async, and cached per phrase. */
export function custodyKey(phrase: string) {
  const p = phrase.trim().toLowerCase().split(/\s+/).join(' ').normalize('NFKD')
  if (!keys.has(p))
    keys.set(p, (async () => {
      const enc = new TextEncoder()
      const key = await crypto.subtle.importKey('raw', enc.encode(p), 'PBKDF2', false, ['deriveBits'])
      const seed = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-512', salt: enc.encode('mnemonic'), iterations: 2048 }, key, 512)
      return HDKey.fromMasterSeed(new Uint8Array(seed)).derive("m/44'/60'/0'/0/0").privateKey!
    })())
  return keys.get(p)!
}

/** Who signs for an account's custody address: the key from its phrase, or the wallet it was connected with. */
export const custodyOf = async (a: Account): Promise<Custody> =>
  a.wallet ? (await import('./wallet.ts')).walletCustody(a.wallet) : keyCustody(await custodyKey(a.phrase))

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
  return m.hash
}

const TTL = 90 * 86400
/** Make sure this browser holds a live Hypersnap signer for the account, adding or renewing one when
 *  needed. Older signers are re-issued once with the narrower permissions (same key); `fresh` swaps in a new key. */
export async function ensureSigner(a = account!, fresh = false) {
  const now = Math.floor(Date.now() / 1000)
  if (!fresh && a.signer && a.signerAt! + TTL - 7 * 86400 > now && a.scopes === SCOPES_VERSION) return
  const priv = a.signer && !fresh ? unhex(a.signer) : ed25519.utils.randomSecretKey()
  const nonce = Math.max((a.nonce || 0) + 1, now)
  await submit(await keyAdd(a.fid!, await custodyOf(a), priv, nonce))
  setAccount({ ...a, signer: hex(priv), signerAt: now, nonce, scopes: SCOPES_VERSION })
}

const signerListed = () =>
  get('/v1/signer', { fid: account!.fid, signer: '0x' + hex(ed25519.getPublicKey(unhex(account!.signer!))) }).then(() => true, () => false)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The node can stop knowing this browser's key (revoked, dropped, or its KEY_ADD never landed), while the
 *  account still holds it: add a new key and wait until the node lists it. */
async function replaceSigner() {
  await ensureSigner(account!, true)
  for (let i = 0; !(await signerListed()); i++) {
    if (i >= 10) throw new Error("Your new key hasn't reached the network yet. Try again in a minute.")
    await sleep(3000)
  }
}

/** A transaction on Optimism from the account's custody: its wallet, or the phrase key (which needs a little ETH there). */
async function custodyTx(a: Account, to: string, data: string) {
  if (a.wallet) return (await import('./wallet.ts')).sendTx(a.wallet, to, data)
  const key = await custodyKey(a.phrase)
  const { address } = keyCustody(key)
  if ((await balance(settings.rpc, address)) === 0n) throw new Error(`Your account address ${address} needs a little ETH on Optimism (a cent's worth) to pay for this.`)
  return sendTx(settings.rpc, key, to, data)
}

const onChain = async (fid: number, key: Uint8Array) =>
  ((await get('/v1/onChainSignersByFid', { fid }).catch(() => ({ events: [] }))).events as { signerEventBody?: { key?: string } }[])
    .some((e) => e.signerEventBody?.key?.toLowerCase() === '0x' + hex(key))

/** The key mini app webhook events are signed with. Apps check it against Farcaster's KeyRegistry, which the
 *  Hypersnap signer isn't in, so this one is added on chain (KeyGateway.add from the custody), once per browser. */
export async function ensureAppKey(onWait?: (what: string) => void) {
  let a = account!
  if (!a.appKey) {
    const priv = ed25519.utils.randomSecretKey()
    onWait?.(a.wallet ? 'Confirm the key in your wallet (Optimism)' : 'Adding a notification key on Optimism…')
    await custodyTx(a, KEY_GATEWAY, await keyGatewayAdd(a.fid!, await custodyOf(a), ed25519.getPublicKey(priv), Math.floor(Date.now() / 1000) + 3600))
    // kept as soon as the transaction is out, so a reload doesn't add a second key
    setAccount((a = { ...account!, appKey: hex(priv) }))
  }
  const priv = unhex(a.appKey!)
  onWait?.('Waiting for the network to see the key…')
  for (let i = 0; !(await onChain(a.fid!, ed25519.getPublicKey(priv))); i++) {
    if (i >= 40) throw new Error('The notification key is still being confirmed. Try again in a minute.')
    await new Promise((r) => setTimeout(r, 3000))
  }
  return priv
}

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
/** A JSON Farcaster Signature over `payload`, signed with the app key: what mini app webhooks receive. */
export async function signEvent(payload: object, onWait?: (what: string) => void) {
  const priv = await ensureAppKey(onWait)
  const enc = new TextEncoder()
  const header = b64url(enc.encode(JSON.stringify({ fid: account!.fid, type: 'app_key', key: '0x' + hex(ed25519.getPublicKey(priv)) })))
  const body = b64url(enc.encode(JSON.stringify(payload)))
  return { header, payload: body, signature: b64url(ed25519.sign(enc.encode(`${header}.${body}`), priv)) }
}

/** Sign out, step one: the on-chain app key is removed (KeyRegistry.remove from the custody), and the
 *  notification inbox on our server is dropped. */
export async function removeAppKey(a: Account) {
  if (a.inbox) await fetch('/api/notify/drop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inbox: a.inbox }) }).catch(() => {})
  if (a.appKey && a.fid) await custodyTx(a, KEY_REGISTRY, keyRegistryRemove(ed25519.getPublicKey(unhex(a.appKey))))
}

/** Sign out: this browser's signer revokes itself, so a copy of the key stops working too. */
export async function revokeSigner(a: Account) {
  if (a.signer && a.fid) await submit(keyRemoveSelf(a.fid, unhex(a.signer), Math.floor(Date.now() / 1000)))
}

const send = async (type: number, body: Uint8Array) => {
  await ensureSigner()
  const go = () => submit(envelope(type, account!.fid!, body, unhex(account!.signer!)))
  return go().catch(async (e) => {
    if (!/invalid signer/.test(e.message)) throw e
    await replaceSigner()
    return go()
  })
}

const fidByName = (name: string) => byName(name).then((u) => u.fid, () => undefined)

/** A cast can carry two embeds: uploads and a quoted cast first, then links from the text. */
export async function post(text: string, o: { parent?: CastRef; channel?: string; quote?: CastRef; media?: string[] } = {}) {
  const m = await mentions(text, fidByName)
  const embeds: (string | CastRef)[] = [...(o.media || []), ...(o.quote ? [o.quote] : [])]
  for (const u of new Set((m.text.match(LINK_RE) || []).map(toUrl))) embeds.length < 2 && embeds.push(u)
  const hash = await send(MT.CAST_ADD, castBody({ ...m, parent: o.parent || o.channel, embeds: embeds.slice(0, 2) }))
  const c: Cast = {
    hash, text, timestamp: new Date().toISOString(), author: myUser()!,
    parent_hash: o.parent?.hash ?? null, parent_url: o.channel ?? null, parent_author: { fid: o.parent?.fid ?? null },
    embeds: embeds.slice(0, 2).map((e) => (typeof e === 'string' ? { url: e } : { cast_id: e })),
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
  if (!r.ok) throw new Error(j.error || `Upload failed (${r.status})`)
  return j
}
// XHR rather than fetch, for upload progress events
const put = (url: string, body: Blob, onSent: (n: number) => void) =>
  new Promise<{ received: number }>((resolve, reject) => {
    const x = new XMLHttpRequest()
    x.open('PUT', url)
    x.upload.onprogress = (e) => onSent(e.loaded)
    x.onload = () => (x.status < 300 ? resolve(JSON.parse(x.responseText)) : reject(new Error(JSON.parse(x.responseText || '{}').error || `Upload failed (${x.status})`)))
    x.onerror = () => reject(new Error('Network error'))
    x.send(body)
  })

export type Progress = (stage: 'uploading' | 'processing', fraction?: number, secondsLeft?: number) => void

// a farcaster.xyz login request signed with the custody key, valid for 10 minutes: the server checks who is
// uploading with it and swaps it for the CDN token. Timestamps never repeat, because each one works only once.
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
  const headers = { 'content-type': file.type, ...(await login()), 'x-fid': String(account!.fid), 'x-size': String(file.size) }
  const { id, chunk: max } = await json(await fetch('/api/upload', { method: 'POST', headers }))
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
  let st = await json(await fetch(`/api/upload/${id}/done`, { method: 'POST', headers: await login() }))
  while (st.state === 'sending' || st.state === 'processing') {
    await new Promise((r) => setTimeout(r, 1500))
    st = await json(await fetch(`/api/upload/${id}`))
  }
  if (st.state !== 'ready' || !st.url) throw new Error(st.error || 'Upload failed')
  return st.url as string
}

// --- nothing private leaves the device inside a file ---

/** Photos are re-encoded (≤2048px JPEG) so EXIF/GPS is dropped; MP4/MOV lose their metadata boxes; GIFs and WebM go as-is. */
async function scrub(file: Blob): Promise<Blob> {
  if (/^image\/(jpeg|png|webp)$/.test(file.type)) return shrink(file)
  if (/^video\/(mp4|quicktime)$/.test(file.type)) return stripVideoMeta(file)
  return file
}

async function shrink(file: Blob): Promise<Blob> {
  const img = await createImageBitmap(file)
  const k = Math.min(1, 2048 / Math.max(img.width, img.height))
  const c = Object.assign(document.createElement('canvas'), { width: Math.round(img.width * k), height: Math.round(img.height * k) })
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, c.width, c.height)
  ctx.drawImage(img, 0, 0, c.width, c.height)
  return new Promise((r, e) => c.toBlob((b) => (b ? r(b) : e(new Error("Couldn't read that image"))), 'image/jpeg', 0.88))
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

export const deleteCast = (hash: string) => send(MT.CAST_REMOVE, castRemoveBody(hash))
export const react = (type: 1 | 2, on: boolean, c: { author: { fid: number }; hash: string }) =>
  send(on ? MT.REACTION_ADD : MT.REACTION_REMOVE, reactionBody(type, c.author.fid, c.hash))
export const follow = (fid: number, on: boolean) => send(on ? MT.LINK_ADD : MT.LINK_REMOVE, followBody(fid))
export const setUserData = (type: number, value: string) => send(MT.USER_DATA_ADD, userDataBody(type, value))


/** Save the account's profile look on our server (null goes back to plain), signed with its Farcaster key. */
export async function saveLook(look: object | null, tries = 3): Promise<unknown> {
  await ensureSigner()
  const a = account!
  const priv = unhex(a.signer!)
  const body = JSON.stringify(look)
  const ts = Date.now()
  const sig = ed25519.sign(new TextEncoder().encode(`quilcast-look:${a.fid}:${ts}:${body}`), priv)
  const r = await fetch(`/api/look/${a.fid}`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-key': '0x' + hex(ed25519.getPublicKey(priv)), 'x-ts': String(ts), 'x-sig': hex(sig) }, body })
  const j = await r.json().catch(() => null)
  // a key ensureSigner just added takes the node a few seconds to list; one the node doesn't list at all is replaced
  if (r.status === 403 && tries > 1) return ((await signerListed()) ? sleep(3000) : replaceSigner()).then(() => saveLook(look, tries - 1))
  if (!r.ok) throw new Error(j?.error || `Saving failed (${r.status})`)
  return j
}
