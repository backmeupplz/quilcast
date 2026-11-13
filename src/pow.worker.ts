// Hypersnap native registration's proof of work: sha256(prefix ‖ nonce) with `bits` leading zero bits,
// the nonce 8 bytes big-endian (hypersnap/src/native_registration.rs pow_hash / pow_target_met).
import { sha256 } from '@noble/hashes/sha2.js'

export function met(h: Uint8Array, bits: number) {
  const full = bits >> 3
  for (let i = 0; i < full; i++) if (h[i]) return false
  return !(bits & 7) || h[full] < 1 << (8 - (bits & 7))
}

/** Nonces start, start + step, … until one meets `bits`. */
export function search(prefix: Uint8Array, bits: number, start: number, step: number) {
  const buf = new Uint8Array(prefix.length + 8)
  buf.set(prefix)
  const v = new DataView(buf.buffer)
  for (let n = start; ; n += step) {
    v.setUint32(prefix.length, Math.floor(n / 2 ** 32))
    v.setUint32(prefix.length + 4, n >>> 0)
    if (met(sha256(buf), bits)) return buf.slice(prefix.length)
  }
}

if ((globalThis as any).WorkerGlobalScope) onmessage = (e: MessageEvent) => postMessage(search(...(e.data as [Uint8Array, number, number, number])))
