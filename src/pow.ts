// The proof of work Hypersnap's free sign-up asks for (native.ts): a nonce whose
// SHA-256("hyper.onboard.pow:" || custody || anchor block hash || nonce) starts with `bits` zero bits.
// The first 64 of those 78 bytes never change, so their state is worked out once and each try is one SHA-256 block.
// No imports: the workers (pow.worker.ts) run this file alone.

const K = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])
const IV = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
const PREFIX = new TextEncoder().encode('hyper.onboard.pow:')

/** One SHA-256 compression of the 16 words at the start of `w` (which it fills to 64) into `h`. */
function compress(h: Uint32Array, w: Uint32Array) {
  for (let i = 16; i < 64; i++) {
    const a = w[i - 15], b = w[i - 2]
    w[i] = (((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3)) + w[i - 7] + (((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10)) + w[i - 16]
  }
  let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], k = h[7]
  for (let i = 0; i < 64; i++) {
    const t1 = (k + (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0
    const t2 = ((((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) + ((a & b) ^ (a & c) ^ (b & c))) | 0
    k = g, g = f, f = e, e = (d + t1) | 0, d = c, c = b, b = a, a = (t1 + t2) | 0
  }
  h[0] += a, h[1] += b, h[2] += c, h[3] += d, h[4] += e, h[5] += f, h[6] += g, h[7] += k
}

/** The nonce as Hypersnap reads it: 8 bytes, big-endian. */
export const nonceBytes = (hi: number, lo: number) => {
  const b = new Uint8Array(8)
  new DataView(b.buffer).setUint32(0, hi), new DataView(b.buffer).setUint32(4, lo)
  return b
}

/** The work's hash for one nonce (`hi`, `lo` its two halves), as 8 big-endian words. */
export function powWords(custody: Uint8Array, anchor: Uint8Array, hi = 0, lo = 0) {
  return tries(custody, anchor)(hi, lo).slice()
}

/** A function from a nonce to its hash, reusing the state of the first block (custody and anchor fixed). */
function tries(custody: Uint8Array, anchor: Uint8Array) {
  if (custody.length !== 20 || anchor.length !== 32) throw new RangeError('bad custody or anchor')
  const msg = new Uint8Array(70)
  msg.set(PREFIX), msg.set(custody, 18), msg.set(anchor, 38)
  const view = new DataView(msg.buffer)
  const mid = Uint32Array.from(IV)
  const w = new Uint32Array(64)
  for (let i = 0; i < 16; i++) w[i] = view.getUint32(i * 4)
  compress(mid, w)
  // the second block: the anchor's last 6 bytes, the 8-byte nonce, the 0x80 end mark, zeros, and the length (78 bytes)
  const w0 = view.getUint32(64), w1 = view.getUint16(68) << 16
  const h = new Uint32Array(8)
  return (hi: number, lo: number) => {
    w.fill(0, 4, 15)
    w[0] = w0, w[1] = w1 | (hi >>> 16), w[2] = (hi << 16) | (lo >>> 16), w[3] = (lo << 16) | 0x8000, w[15] = 78 * 8
    h.set(mid)
    compress(h, w)
    return h
  }
}

/** Whether a hash (its first word) starts with `bits` zero bits; up to 32. */
const meets = (first: number, bits: number) => bits >= 32 ? first === 0 : first >>> (32 - bits) === 0

/** Tries nonces `hi`:`from` … `hi`:`from + count - 1`; returns the low half of the first that meets `bits`, or -1. */
export function search(custody: Uint8Array, anchor: Uint8Array, bits: number, hi: number, from: number, count: number) {
  if (!(bits >= 1 && bits <= 32)) throw new RangeError('bad difficulty')
  const hash = tries(custody, anchor)
  const end = Math.min(from + count, 2 ** 32)
  for (let lo = from; lo < end; lo++) if (meets(hash(hi, lo)[0], bits)) return lo
  return -1
}
