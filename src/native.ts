// Free sign-up on Hypersnap (its PR #63), with no Optimism transaction: the custody address does a little proof of work
// over a recent shard-0 block (pow.ts), signs it (EIP-712), and the network gives it an FID from 2^32 up. A custody
// gets one such FID, so sending the registration again after a lost answer is safe.
import { blake3 } from '@noble/hashes/blake3.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { get } from './api.ts'
import { concat, fcNow, hex, pb, unhex, type Custody, type Typed } from './fc.ts'
import { nonceBytes, search } from './pow.ts'
import { submit } from './write.ts'

export const NATIVE_ONBOARD = 160
/** FIDs from here up are Hypersnap's own: no Optimism IdRegistry entry, so no fname or on-chain keys. */
export const FIRST_NATIVE_FID = 2 ** 32
export const isNative = (fid?: number) => !!fid && fid >= FIRST_NATIVE_FID

type Info = { active: boolean; nextBlock: number; anchorBlockHeight: number; anchorBlockHash: string; minDifficultyBits: number; anchorWindow: number }
const info = () => get<Info>('/v1/nativeRegistration', {}, true)

/** The native FID of a custody address, or 0 when it has none (yet). */
export const nativeFid = (custody: string) =>
  get('/v1/nativeAccount', { custody }, true).then((r) => (Number.isSafeInteger(Number(r?.fid)) ? Number(r.fid) : 0), (e) => (e.status === 404 ? 0 : Promise.reject(e)))

/** sha256("hyper.onboard.pow.commitment:" || nonce || bits as 4 big-endian bytes): what the custody signs for the work. */
export const commitment = (nonce: Uint8Array, bits: number) => {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, bits)
  return sha256(concat(new TextEncoder().encode('hyper.onboard.pow.commitment:'), nonce, b))
}

export const onboardTyped = (custody: string, height: number, anchor: string, commit: Uint8Array): Typed => ({
  domain: { name: 'HypersnapNativeOnboard', version: '1', chainId: 10 },
  types: { HyperNativeOnboard: [{ name: 'custody', type: 'address' }, { name: 'anchor_block_height', type: 'uint64' }, { name: 'anchor_block_hash', type: 'bytes32' }, { name: 'gate_commitment', type: 'bytes32' }] },
  primaryType: 'HyperNativeOnboard',
  message: { custody: custody.toLowerCase(), anchor_block_height: height, anchor_block_hash: anchor, gate_commitment: '0x' + hex(commit) },
})

/** The NATIVE_ONBOARD message: fid 0, no signer, the custody's signature inside its body (MessageData field 1160). */
export function onboardMessage(o: { custody: string; signature: Uint8Array; height: number; anchor: string; nonce: Uint8Array; bits: number }) {
  const body = pb([1, unhex(o.custody)], [2, o.signature], [3, o.height], [4, unhex(o.anchor)], [5, pb([1, o.nonce], [2, o.bits])])
  const data = pb([1, NATIVE_ONBOARD], [3, fcNow()], [4, 1], [1160, body])
  const hash = blake3(data, { dkLen: 20 })
  // hash scheme BLAKE3; no signature, signature scheme or signer
  return { msg: pb([1, data], [2, hash], [3, 1], [7, data]), hash: hex(hash) }
}

// shown through t() (scripts/i18n-keys.mjs LABELS)
const CANT = "The node asked for sign-up work this app can't do. Check the node in settings."
const tick = () => new Promise((r) => setTimeout(r))
/** The work on this page, a slice at a time so it stays responsive (no workers, or they failed to start). */
async function mineHere(custody: Uint8Array, anchor: Uint8Array, bits: number, signal?: AbortSignal) {
  for (let hi = 0; hi < 2 ** 32; hi++)
    for (let from = 0; from < 2 ** 32; from += 2 ** 16) {
      signal?.throwIfAborted()
      const lo = search(custody, anchor, bits, hi, from, 2 ** 16)
      if (lo >= 0) return nonceBytes(hi, lo)
      await tick()
    }
  throw new Error(CANT)
}

/** A nonce meeting `bits` for this custody and anchor, mined on up to 4 cores. */
export function mine(custody: string, anchor: string, bits: number, signal?: AbortSignal): Promise<Uint8Array> {
  const c = unhex(custody), a = unhex(anchor)
  if (typeof Worker === 'undefined') return mineHere(c, a, bits, signal)
  const n = Math.max(1, Math.min(4, navigator.hardwareConcurrency || 2))
  return new Promise((resolve, reject) => {
    const workers: Worker[] = []
    let done = false
    const end = () => ((done = true), workers.forEach((w) => w.terminate()))
    signal?.addEventListener('abort', () => (end(), reject(signal.reason)))
    for (let i = 0; i < n && !done; i++) {
      const w = new Worker(new URL('./pow.worker.ts', import.meta.url), { type: 'module' })
      w.onmessage = ({ data }) => !done && (end(), data.error ? reject(new Error(CANT)) : resolve(nonceBytes(data.hi, data.lo)))
      // a browser that won't start the worker mines on the page
      w.onerror = () => !done && (end(), mineHere(c, a, bits, signal).then(resolve, reject))
      w.postMessage({ custody: c, anchor: a, bits, hi: i, step: n })
      workers.push(w)
    }
  })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Register `custody` on Hypersnap and wait until the node knows its new FID. `say` tells which part is running:
 *  the work on this device, the custody's signature (a wallet asks its owner), or the network confirming it. */
export async function registerNative(custody: Custody, say: (s: 'work' | 'sign' | 'wait') => void, signal?: AbortSignal) {
  const addr = custody.address.toLowerCase()
  const known = await nativeFid(addr)
  if (known) return known
  const i = await info()
  if (!i?.active) throw new Error("This node doesn't take new accounts yet. Pick another node in settings or try again later.")
  const bits = i.minDifficultyBits
  // 22 bits (a few seconds) today; past 32 a phone would work for hours
  if (!(Number.isInteger(bits) && bits >= 1 && bits <= 32) || !/^0x[0-9a-f]{64}$/i.test(i.anchorBlockHash)) throw new Error(CANT)
  // a node whose shard 0 stopped moving hands out a block the network has left behind, and the registration never lands
  const shard0 = (await get('/v1/info', {}, true).catch(() => null))?.shardInfos?.find((s: { shardId: number }) => s.shardId === 0)
  if (shard0?.blockDelay > 300) throw new Error("The network isn't confirming new accounts right now. Try again in a few minutes or pick another node in settings.")
  say('work')
  const nonce = await mine(addr, i.anchorBlockHash, bits, signal)
  say('sign')
  const signature = await custody.typed(onboardTyped(addr, i.anchorBlockHeight, i.anchorBlockHash, commitment(nonce, bits)))
  signal?.throwIfAborted()
  say('wait')
  await submit(onboardMessage({ custody: addr, signature, height: i.anchorBlockHeight, anchor: i.anchorBlockHash, nonce, bits })).catch(async (e) => {
    // already registered (an earlier try that looked lost) is fine
    if (!(await nativeFid(addr).catch(() => 0))) throw e
  })
  for (let n = 0; n < 45; n++) {
    const fid = await nativeFid(addr).catch(() => 0)
    if (fid) return fid
    signal?.throwIfAborted()
    await sleep(2000)
  }
  throw new Error("The network hasn't confirmed your account yet. Try again in a minute.")
}
