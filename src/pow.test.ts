import assert from 'node:assert/strict'
import { test } from 'node:test'

test('native registration: the proof of work counts leading zero bits, and native FIDs come back as numbers', async () => {
  const { met, search } = await import('./pow.worker.ts')
  const { sha256 } = await import('@noble/hashes/sha2.js')
  assert.ok(met(Uint8Array.of(0, 0, 3, 255), 22))
  assert.ok(!met(Uint8Array.of(0, 0, 4, 0), 22))
  assert.ok(met(Uint8Array.of(0, 0, 255), 16))
  const prefix = new TextEncoder().encode('hyper.onboard.pow:')
  assert.ok(met(sha256(new Uint8Array([...prefix, ...search(prefix, 12, 3, 4)])), 12))

  Object.assign(globalThis, { addEventListener: () => {}, dispatchEvent: () => true })
  ;(globalThis as any).localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} }
  const { fids } = await import('./api.ts')
  const j = JSON.parse('{"user":{"fid":"4294967296","username":"4294967296"},"parent_author":{"fid":"4294967297"},"fids":["4294967298",3],"mentions":["4294967299"]}', fids)
  assert.deepEqual(j, { user: { fid: 4294967296, username: '4294967296' }, parent_author: { fid: 4294967297 }, fids: [4294967298, 3], mentions: [4294967299] })
})
