// Farcaster protocol bits: protobuf messages, signing, EIP-712.
// Field numbers follow hypersnap/proto/definitions/message.proto; the KEY_ADD
// layout is adapted from QuilibriumNetwork/quorum-shared (MIT).
import { ed25519 } from '@noble/curves/ed25519.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { blake3 } from '@noble/hashes/blake3.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { HDKey } from '@scure/bip32'
import type { Ed } from './keys.ts'

export const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
export const unhex = (s: string) => {
  s = s.replace(/^0x/, '')
  return Uint8Array.from(s.match(/../g) || [], (x) => parseInt(x, 16))
}
const utf8 = (s: string) => new TextEncoder().encode(s)
export const concat = (...a: Uint8Array[]) => {
  const out = new Uint8Array(a.reduce((n, x) => n + x.length, 0))
  let o = 0
  for (const x of a) out.set(x, (o += x.length) - x.length)
  return out
}

// --- protobuf writer: varints and length-delimited fields are all we need ---

const varint = (v: number | bigint) => {
  let n = BigInt(v)
  const out: number[] = []
  while (n >= 0x80n) out.push(Number((n & 0x7fn) | 0x80n)), (n >>= 7n)
  out.push(Number(n))
  return Uint8Array.from(out)
}
type Field = [number, number | bigint | string | Uint8Array | number[] | undefined]
// numbers → varint, strings/bytes → length-delimited, arrays → packed varints
export const pb = (...fields: Field[]) =>
  concat(
    ...fields.flatMap(([f, v]) => {
      if (v === undefined || v === '' || (Array.isArray(v) && !v.length)) return []
      if (typeof v === 'number' || typeof v === 'bigint') return [varint(f << 3), varint(v)]
      const b = typeof v === 'string' ? utf8(v) : Array.isArray(v) ? concat(...v.map(varint)) : v
      return [varint((f << 3) | 2), varint(b.length), b]
    }),
  )

export const MT = { CAST_ADD: 1, CAST_REMOVE: 2, REACTION_ADD: 3, REACTION_REMOVE: 4, LINK_ADD: 5, LINK_REMOVE: 6, USER_DATA_ADD: 11, KEY_ADD: 16, KEY_REMOVE: 17 }
// every message type a non-custody signer may sign (KEY_ADD/REMOVE excluded)
// the browser's signer may only do what the app does: casts, reactions, follows and profile edits
// (no verifications, username proofs, frame actions or storage lending)
export const SCOPES = [MT.CAST_ADD, MT.CAST_REMOVE, MT.REACTION_ADD, MT.REACTION_REMOVE, MT.LINK_ADD, MT.LINK_REMOVE, MT.USER_DATA_ADD]
export const SCOPES_VERSION = 2

const castId = (fid: number, hash: string) => pb([1, fid], [2, unhex(hash)])
const BODY_FIELD: Record<number, number> = { 1: 5, 2: 6, 3: 7, 4: 7, 5: 14, 6: 14, 11: 12, 16: 19, 17: 20 }
// message timestamps and key deadlines count seconds from the Farcaster epoch (2021-01-01)
const fcNow = () => Math.floor(Date.now() / 1000) - 1609459200

export type CastRef = { fid: number; hash: string }
// parent is a cast (reply) or a channel URL; embeds are URLs or a quoted cast
export const castBody = (c: { text: string; mentions?: number[]; positions?: number[]; embeds?: (string | CastRef)[]; parent?: CastRef | string }) =>
  pb(
    [2, c.mentions],
    [3, typeof c.parent === 'object' ? castId(c.parent.fid, c.parent.hash) : undefined],
    [7, typeof c.parent === 'string' ? c.parent : undefined], // same position as @farcaster/core's oneof
    [4, c.text],
    [5, c.positions],
    ...(c.embeds || []).map((e): Field => [6, typeof e === 'string' ? pb([1, e]) : pb([2, castId(e.fid, e.hash)])]),
    // over 320 bytes must be marked LONG_CAST (allowed up to 1024)
    [8, new TextEncoder().encode(c.text).length > 320 ? 1 : undefined],
  )
export const reactionBody = (type: 1 | 2, fid: number, hash: string) => pb([1, type], [2, castId(fid, hash)])
export const followBody = (fid: number) => pb([1, 'follow'], [3, fid])
export const userDataBody = (type: number, value: string) => pb([1, type], [2, value])
export const castRemoveBody = (hash: string) => pb([1, unhex(hash)])

/** A raw ed25519 key as a signing key (tests, and accounts whose key the vault couldn't take). */
export const rawEd = (priv: Uint8Array): Ed => ({ pub: ed25519.getPublicKey(priv), sign: async (m) => ed25519.sign(m, priv) })

/** Sign MessageData with an ed25519 key, return the Message envelope and its hash. */
export async function envelope(type: number, fid: number, body: Uint8Array, key: Ed) {
  const data = pb([1, type], [2, fid], [3, fcNow()], [4, 1], [BODY_FIELD[type], body])
  const hash = blake3(data, { dkLen: 20 })
  // hypersnap merges read `data` while hashing uses `data_bytes`: send both
  const msg = pb([1, data], [2, hash], [3, 1], [4, await key.sign(hash)], [5, 1], [6, key.pub], [7, data])
  return { msg, hash: hex(hash) }
}

// --- Ethereum-style signing ---

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

const word = (v: number | bigint) => unhex(BigInt(v).toString(16).padStart(64, '0'))
const kstr = (s: string) => keccak_256(utf8(s))
export const address = (priv: Uint8Array) => '0x' + hex(keccak_256(secp256k1.getPublicKey(priv, false).slice(1)).slice(12))

export function ecSign(digest: Uint8Array, priv: Uint8Array) {
  const sig = secp256k1.Signature.fromBytes(secp256k1.sign(digest, priv, { prehash: false, format: 'recovered' }), 'recovered')
  return { rs: sig.toBytes('compact'), v: sig.recovery! }
}
const sign65 = (digest: Uint8Array, priv: Uint8Array) => {
  const { rs, v } = ecSign(digest, priv)
  return concat(rs, Uint8Array.of(v + 27))
}

// EIP-712 for the flat structs Farcaster signs (no nested structs), so a key here and an external wallet
// sign the very same object
type Member = { name: string; type: string }
export type Typed = { domain: { name: string; version: string; chainId: number; verifyingContract?: string }; types: Record<string, Member[]>; primaryType: string; message: Record<string, any> }
const DOMAIN: Member[] = [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }]
const enc = (type: string, v: any): Uint8Array =>
  type.endsWith('[]') ? keccak_256(concat(...v.map((x: unknown) => enc(type.slice(0, -2), x))))
    : type === 'string' ? kstr(v) : type === 'bytes' ? keccak_256(unhex(v)) : word(BigInt(v))
const struct = (name: string, fields: Member[], v: Record<string, any>) =>
  keccak_256(concat(kstr(`${name}(${fields.map((f) => `${f.type} ${f.name}`).join(',')})`), ...fields.map((f) => enc(f.type, v[f.name]))))
export const hashTyped = (t: Typed) =>
  keccak_256(concat(Uint8Array.of(0x19, 1), struct('EIP712Domain', DOMAIN.filter((f) => f.name in t.domain), t.domain), struct(t.primaryType, t.types[t.primaryType], t.message)))

/** Whoever signs for the custody address: a key in this browser, or an external wallet. Signatures are 65 bytes, v = 27/28. */
export type Custody = { address: string; typed: (t: Typed) => Promise<Uint8Array>; message: (m: Uint8Array) => Promise<Uint8Array> }
export const keyCustody = (priv: Uint8Array): Custody => ({
  address: address(priv),
  typed: async (t) => sign65(hashTyped(t), priv),
  message: async (m) => sign65(keccak_256(concat(utf8(`\x19Ethereum Signed Message:\n${m.length}`), m)), priv),
})

const KEY_ADD_DOMAIN = { name: 'Farcaster KeyAdd', version: '1', chainId: 1 }
const n = (name: string, type: string) => ({ name, type })

/** KEY_ADD that registers `signer` for `fid` without an on-chain tx (Hypersnap gasless signers). */
export async function keyAdd(fid: number, custody: Custody, signer: Ed, nonce: number) {
  const key = signer.pub
  // Hypersnap checks the deadline against the message timestamp, so it counts from the same epoch
  const deadline = fcNow() + 3600
  const ttl = 90 * 86400
  const skr = await custody.typed({
    domain: KEY_ADD_DOMAIN, primaryType: 'SignedKeyRequest',
    types: { SignedKeyRequest: [n('requestFid', 'uint256'), n('key', 'bytes'), n('deadline', 'uint256')] },
    message: { requestFid: fid, key: '0x' + hex(key), deadline },
  })
  // abi.encode((uint256 requestFid, address requestSigner, bytes signature, uint256 deadline))
  const metadata = concat(word(32), word(fid), word(BigInt(custody.address)), word(128), word(deadline), word(65), skr, new Uint8Array(31))
  const custodySig = await custody.typed({
    domain: KEY_ADD_DOMAIN, primaryType: 'KeyAdd',
    types: { KeyAdd: [n('fid', 'uint256'), n('key', 'bytes'), n('keyType', 'uint32'), n('scopes', 'uint32[]'), n('ttl', 'uint32'), n('nonce', 'uint32'), n('deadline', 'uint256')] },
    message: { fid, key: '0x' + hex(key), keyType: 1, scopes: SCOPES, ttl, nonce, deadline },
  })
  return envelope(MT.KEY_ADD, fid, pb([1, key], [2, 1], [3, custodySig], [4, deadline], [5, nonce], [6, metadata], [7, 1], [9, SCOPES], [10, ttl]), signer)
}

// Farcaster's key contracts on Optimism, for the one on-chain key mini app webhooks are signed with
export const KEY_GATEWAY = '0x00000000fc56947c7e7183f8ca4b62398caadf0b'
export const KEY_REGISTRY = '0x00000000fc1237824fb747abde0ff18990e59b7e'
const selector = (sig: string) => keccak_256(utf8(sig)).slice(0, 4)

/** KeyGateway.add calldata registering `key` for the custody's own fid, with a SignedKeyRequest the custody
 *  signs for itself (requestFid = fid). `deadline` is in Unix seconds. */
export async function keyGatewayAdd(fid: number, custody: Custody, key: Uint8Array, deadline: number) {
  const sig = await custody.typed({
    domain: { name: 'Farcaster SignedKeyRequestValidator', version: '1', chainId: 10, verifyingContract: '0x00000000fc700472606ed4fa22623acf62c60553' },
    primaryType: 'SignedKeyRequest',
    types: { SignedKeyRequest: [n('requestFid', 'uint256'), n('key', 'bytes'), n('deadline', 'uint256')] },
    message: { requestFid: fid, key: '0x' + hex(key), deadline },
  })
  const metadata = concat(word(32), word(fid), word(BigInt(custody.address)), word(128), word(deadline), word(65), sig, new Uint8Array(31))
  // add(uint32 keyType = 1, bytes key, uint8 metadataType = 1, bytes metadata)
  return '0x' + hex(concat(selector('add(uint32,bytes,uint8,bytes)'), word(1), word(128), word(1), word(192), word(32), key, word(metadata.length), metadata))
}
/** KeyRegistry.remove calldata for a 32-byte key. */
export const keyRegistryRemove = (key: Uint8Array) => '0x' + hex(concat(selector('remove(bytes)'), word(32), word(32), key))

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
/** Base58 (Bitcoin alphabet), as Solana writes keys and signatures. */
export function base58(b: Uint8Array) {
  let s = ''
  for (let x = BigInt('0x0' + hex(b)); x > 0n; x /= 58n) s = B58[Number(x % 58n)] + s
  for (const byte of b) {
    if (byte) break
    s = '1' + s
  }
  return s
}

/** KEY_REMOVE signed by the signer itself (Hypersnap self-revocation): no custody signature needed. */
export const keyRemoveSelf = (fid: number, signer: Ed, nonce: number) =>
  envelope(MT.KEY_REMOVE, fid, pb([1, signer.pub], [3, 2], [4, fcNow() + 3600], [5, nonce]), signer)

/** Signature the fname server wants to assign `name` to the custody address. */
export async function fnameProof(name: string, timestamp: number, custody: Custody) {
  const sig = await custody.typed({
    domain: { name: 'Farcaster name verification', version: '1', chainId: 1, verifyingContract: '0xe3be01d99baa8db9905b33a3ca391238234b79d1' },
    primaryType: 'UserNameProof',
    types: { UserNameProof: [n('name', 'string'), n('timestamp', 'uint256'), n('owner', 'address')] },
    message: { name, timestamp, owner: custody.address },
  })
  return { owner: custody.address, signature: '0x' + hex(sig) }
}

/** Turn "@alice hi" into mention-free text plus byte positions, resolving names via `lookup`. */
export async function mentions(text: string, lookup: (name: string) => Promise<number | undefined>) {
  const out = { text: '', mentions: [] as number[], positions: [] as number[] }
  let last = 0
  for (const m of text.matchAll(/(^|\s)@([a-z0-9][a-z0-9.-]*[a-z0-9])/gi)) {
    const fid = await lookup(m[2].toLowerCase())
    if (!fid) continue
    const at = m.index! + m[1].length
    out.text += text.slice(last, at)
    out.mentions.push(fid)
    out.positions.push(utf8(out.text).length)
    last = at + m[2].length + 1
  }
  out.text += text.slice(last)
  return out
}
