// Quilcast as a mini app (#660): whom the client names, and when the join screen offers them.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fidOfContext, hostUser, inHost, offered } from './host.ts'

test('a mini app context names a FID only when it holds a positive whole number', () => {
  assert.equal(fidOfContext({ user: { fid: 3, username: 'dwr' } }), 3)
  assert.equal(fidOfContext({ user: { fid: 2 ** 32 + 5 } }), 2 ** 32 + 5)
  for (const c of [null, undefined, {}, { user: null }, { user: {} }, { user: { fid: 0 } }, { user: { fid: -1 } }, { user: { fid: 1.5 } }, { user: { fid: '3' } }, { user: { fid: NaN } }, { user: { fid: 2 ** 53 } }])
    assert.equal(fidOfContext(c), 0, JSON.stringify(c))
})

test("the client's account is offered unless it's signed in here already", () => {
  const u = { fid: 3, username: 'dwr' }
  assert.equal(offered(null, []), null)
  assert.equal(offered(u, []), u)
  assert.equal(offered(u, [{ fid: 3, done: true }]), null)
  // one still being set up, or another account, doesn't count
  assert.equal(offered(u, [{ fid: 3 }]), u)
  assert.equal(offered(u, [{ fid: 4, done: true }]), u)
})

test('outside a Farcaster client nobody is named, and the SDK is never loaded', async () => {
  assert.equal(inHost(), false)
  assert.equal(await hostUser(), null)
})

test("a client that didn't name anyone is asked again next time; nothing is kept from a failed try", async () => {
  // a frame: the SDK can't load here (no browser), which is a failed try like a slow client or a node that didn't answer
  ;(globalThis as any).window = { parent: {} }
  try {
    assert.equal(inHost(), true)
    const first = hostUser()
    assert.equal(hostUser(), first, 'one try at a time')
    assert.equal(await first, null)
    const again = hostUser()
    assert.notEqual(again, first)
    assert.equal(await again, null)
  } finally {
    delete (globalThis as any).window
  }
})
