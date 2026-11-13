import assert from 'node:assert/strict'
import { test } from 'node:test'
import { blake3 } from '@noble/hashes/blake3.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hashTypedData, recoverTypedDataAddress } from 'viem'

Object.assign(globalThis, { addEventListener: () => {}, dispatchEvent: () => true })
const store = new Map<string, string>()
;(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) }

const { concat, hashTyped, hex, keyCustody, unhex } = await import('./fc.ts')
const { nonceBytes, powWords, search } = await import('./pow.ts')
const { commitment, onboardMessage, onboardTyped, registerNative } = await import('./native.ts')
const { fids } = await import('./api.ts')

// what Hypersnap's pow_hash computes, the slow way
const slow = (custody: Uint8Array, anchor: Uint8Array, nonce: Uint8Array) => sha256(concat(new TextEncoder().encode('hyper.onboard.pow:'), custody, anchor, nonce))
const words = (h: Uint8Array) => Array.from({ length: 8 }, (_, i) => new DataView(h.buffer, h.byteOffset).getUint32(i * 4))
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n))

test('the one-block SHA-256 matches a plain SHA-256 of the whole message, for any nonce', () => {
  for (const [hi, lo] of [[0, 0], [0, 1], [1, 0], [0xffffffff, 0xffffffff], [0x80000000, 0x7fffffff], [0x1234, 0xabcdef01]]) {
    const custody = random(20), anchor = random(32)
    assert.deepEqual(powWords(custody, anchor, hi, lo).length, 8)
    assert.deepEqual(Array.from(powWords(custody, anchor, hi, lo)), words(slow(custody, anchor, nonceBytes(hi, lo))), `${hi}:${lo}`)
  }
})

test('the nonce found has the asked number of leading zero bits, and none before it does', () => {
  const custody = random(20), anchor = random(32)
  for (const bits of [1, 8, 13]) {
    const lo = search(custody, anchor, bits, 3, 0, 2 ** 20)
    assert.ok(lo >= 0)
    const h = slow(custody, anchor, nonceBytes(3, lo))
    // Hypersnap's pow_target_met: whole zero bytes, then the next byte below 2^(8 - rest)
    const full = bits >> 3, rest = bits % 8
    assert.ok(h.slice(0, full).every((b) => b === 0) && (rest === 0 || h[full] < 1 << (8 - rest)), `bits ${bits}`)
    for (let x = 0; x < lo; x++) assert.ok(words(slow(custody, anchor, nonceBytes(3, x)))[0] >>> (32 - bits) !== 0)
  }
  assert.throws(() => search(custody, anchor, 33, 0, 0, 1))
  assert.throws(() => search(custody, anchor, 0, 0, 0, 1))
})

test('the commitment is sha256 of the domain tag, the nonce and the difficulty as 4 big-endian bytes', () => {
  const nonce = nonceBytes(1, 2)
  assert.equal(hex(commitment(nonce, 22)), hex(sha256(concat(new TextEncoder().encode('hyper.onboard.pow.commitment:'), nonce, Uint8Array.of(0, 0, 0, 22)))))
})

test('the custody signs the same EIP-712 hash a standard implementation computes, and it recovers to the custody', async () => {
  const key = random(32)
  const c = keyCustody(key)
  const anchor = '0x' + hex(random(32))
  const typed = onboardTyped(c.address, 50485360, anchor, commitment(nonceBytes(0, 7), 22))
  const viemTyped = { domain: { name: 'HypersnapNativeOnboard', version: '1', chainId: 10 }, types: typed.types, primaryType: 'HyperNativeOnboard', message: { ...typed.message, anchor_block_height: 50485360n } } as const
  assert.equal('0x' + hex(hashTyped(typed)), hashTypedData(viemTyped as any))
  const sig = await c.typed(typed)
  assert.equal(sig.length, 65)
  assert.ok(sig[64] === 27 || sig[64] === 28)
  assert.equal((await recoverTypedDataAddress({ ...(viemTyped as any), signature: ('0x' + hex(sig)) as `0x${string}` })).toLowerCase(), c.address)
})

// a protobuf reader just for the test: field number → values (varints as bigint, bytes as Uint8Array)
function read(b: Uint8Array) {
  const out = new Map<number, (bigint | Uint8Array)[]>()
  let i = 0
  const varint = () => {
    let v = 0n, s = 0n
    for (;;) {
      const x = b[i++]
      v |= BigInt(x & 0x7f) << s
      s += 7n
      if (x < 0x80) return v
    }
  }
  while (i < b.length) {
    const tag = varint(), f = Number(tag >> 3n), w = Number(tag & 7n)
    const v = w === 0 ? varint() : w === 2 ? ((n) => b.slice(i, (i += n)))(Number(varint())) : assert.fail(`wire type ${w}`)
    out.set(f, [...(out.get(f) || []), v])
  }
  return out
}
const one = (m: Map<number, (bigint | Uint8Array)[]>, f: number) => (assert.equal(m.get(f)?.length, 1, `field ${f}`), m.get(f)![0])

test('the registration message is a NATIVE_ONBOARD with fid 0, BLAKE3 hash, no signer, and the body in field 1160', () => {
  const custody = '0x' + hex(random(20)), anchor = '0x' + hex(random(32)), signature = random(65), nonce = nonceBytes(0, 99)
  const { msg, hash } = onboardMessage({ custody, signature, height: 50485360, anchor, nonce, bits: 22 })
  const m = read(msg)
  const data = one(m, 1) as Uint8Array
  assert.deepEqual(one(m, 7), data)
  assert.equal(hex(one(m, 2) as Uint8Array), hex(blake3(data, { dkLen: 20 })))
  assert.equal(hash, hex(blake3(data, { dkLen: 20 })))
  assert.equal(one(m, 3), 1n)
  assert.deepEqual([...m.keys()].sort(), [1, 2, 3, 7])
  const d = read(data)
  assert.equal(one(d, 1), 160n)
  assert.equal(d.get(2), undefined)
  assert.equal(one(d, 4), 1n)
  assert.ok(Math.abs(Number(one(d, 3)) - (Date.now() / 1000 - 1609459200)) < 5)
  const body = read(one(d, 1160) as Uint8Array)
  assert.equal(hex(one(body, 1) as Uint8Array), custody.slice(2))
  assert.deepEqual(one(body, 2), signature)
  assert.equal(one(body, 3), 50485360n)
  assert.equal('0x' + hex(one(body, 4) as Uint8Array), anchor)
  const pow = read(one(body, 5) as Uint8Array)
  assert.deepEqual(one(pow, 1), nonce)
  assert.equal(one(pow, 2), 22n)
})

test('native FIDs, which Hypersnap writes as strings, read as numbers; other strings stay as they are', () => {
  const j = JSON.parse('{"user":{"fid":"4294967296","username":"123"},"fids":["4294967297",5],"castAddBody":{"mentions":["4294967298"]},"parent_author":{"fid":null},"targetFid":"4294967299","hash":"0x12","fid_x":"abc","big":{"fid":"99999999999999999999"}}', fids)
  assert.deepEqual(j, { user: { fid: 4294967296, username: '123' }, fids: [4294967297, 5], castAddBody: { mentions: [4294967298] }, parent_author: { fid: null }, targetFid: 4294967299, hash: '0x12', fid_x: 'abc', big: { fid: '99999999999999999999' } })
})

test('registering mines the node\'s difficulty over its anchor, submits once, and returns the FID the node then lists', async () => {
  const key = random(32)
  const c = keyCustody(key)
  const anchor = '0x' + hex(random(32))
  let sent: Uint8Array | undefined
  const asked: string[] = []
  ;(globalThis as any).fetch = async (url: string, o: any = {}) => {
    const u = new URL(url)
    asked.push(u.pathname)
    const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
    if (u.pathname === '/v1/nativeRegistration') return res(200, { active: true, nextBlock: 101, anchorBlockHeight: 100, anchorBlockHash: anchor, minDifficultyBits: 12, anchorWindow: 1024, firstNativeFid: '4294967296' })
    if (u.pathname === '/v1/info') return res(200, { shardInfos: [{ shardId: 0, blockDelay: 1 }] })
    if (u.pathname === '/v1/nativeAccount') {
      assert.equal(u.searchParams.get('custody'), c.address)
      return sent ? res(200, { fid: '4294967300', custodyAddress: c.address }) : res(404, { error: 'Native registration lookup failed' })
    }
    if (u.pathname === '/v1/submitMessage') {
      assert.equal(sent, undefined)
      sent = new Uint8Array(o.body)
      return res(200, {})
    }
    throw new Error(`unexpected ${url}`)
  }
  const steps: string[] = []
  assert.equal(await registerNative(c, (s) => steps.push(s)), 4294967300)
  assert.deepEqual(steps, ['work', 'sign', 'wait'])
  const body = read(one(read(one(read(sent!), 1) as Uint8Array), 1160) as Uint8Array)
  const pow = read(one(body, 5) as Uint8Array)
  const nonce = one(pow, 1) as Uint8Array
  assert.equal(one(pow, 2), 12n)
  assert.ok(words(slow(unhex(c.address), unhex(anchor), nonce))[0] >>> 20 === 0)
  const typed = onboardTyped(c.address, 100, anchor, commitment(nonce, 12))
  assert.equal((await recoverTypedDataAddress({ ...(typed as any), message: { ...typed.message, anchor_block_height: 100n }, signature: ('0x' + hex(one(body, 2) as Uint8Array)) as `0x${string}` })).toLowerCase(), c.address)
  // registered already: nothing is mined or sent again
  const before = asked.length
  assert.equal(await registerNative(c, () => assert.fail('no work')), 4294967300)
  assert.deepEqual(asked.slice(before), ['/v1/nativeAccount'])
})

test('a node whose shard 0 has stalled, or that doesn\'t take registrations, says so instead of sending one', async () => {
  const c = keyCustody(random(32))
  let delay = 900, active = true
  ;(globalThis as any).fetch = async (url: string) => {
    const u = new URL(url)
    const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
    if (u.pathname === '/v1/nativeAccount') return res(404, {})
    if (u.pathname === '/v1/nativeRegistration') return res(200, { active, anchorBlockHeight: 1, anchorBlockHash: '0x' + '11'.repeat(32), minDifficultyBits: 22, anchorWindow: 1024 })
    if (u.pathname === '/v1/info') return res(200, { shardInfos: [{ shardId: 0, blockDelay: delay }] })
    throw new Error(`unexpected ${url}`)
  }
  await assert.rejects(registerNative(c, () => assert.fail('no work')), /isn't confirming new accounts/)
  active = false
  await assert.rejects(registerNative(c, () => assert.fail('no work')), /doesn't take new accounts/)
})
