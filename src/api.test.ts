import assert from 'node:assert/strict'
import { test } from 'node:test'

test('once shares an answer, drops failures, and forgets on demand', async () => {
  Object.assign(globalThis, { addEventListener: () => {}, dispatchEvent: () => true })
  ;(globalThis as any).localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} }
  const { once, forget } = await import('./api.ts')
  let calls = 0
  const ok = () => Promise.resolve(++calls)
  assert.equal(await once('a', ok), 1)
  assert.equal(await once('a', ok), 1)
  assert.equal(await once('a', ok, true), 2)
  assert.equal(await once('a', ok), 1, 'a fresh read leaves the kept answer alone')
  await once('b', () => Promise.reject(new Error('down'))).catch(() => {})
  assert.equal(await once('b', ok), 3, 'a failure is not kept')
  forget('a')
  assert.equal(await once('a', ok), 4)
  forget()
  assert.equal(await once('b', ok), 5)
})

test('a tapped like or recast counts once, whatever count the cast comes back with', async () => {
  Object.assign(globalThis, { addEventListener: () => {}, dispatchEvent: () => true })
  ;(globalThis as any).localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} }
  const { taps, tapped } = await import('./api.ts')
  assert.deepEqual(tapped(1, 'a', false, 0), [false, 0])
  taps.set('1a', { on: true, count: 0 })
  assert.deepEqual(tapped(1, 'a', false, 0), [true, 1]) // the cached cast, from before the like
  assert.deepEqual(tapped(1, 'a', false, 1), [true, 1]) // fetched again, the like in its count
  taps.set('1a', { on: false, count: 0 })
  assert.deepEqual(tapped(1, 'a', false, 0), [false, 0]) // undone on a card that still had the old count: never -1
  taps.set('1b', { on: false, count: 3 })
  assert.deepEqual(tapped(1, 'b', true, 3), [false, 2]) // a like the node counted, undone
  assert.deepEqual(tapped(1, 'b', false, 0), [false, 0]) // the node said it was liked, its count lagged: never -1
})

test('a node that is down is not a user who is missing', async () => {
  Object.assign(globalThis, { addEventListener: () => {}, dispatchEvent: () => true })
  ;(globalThis as any).localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} }
  const { getUser, forget } = await import('./api.ts')
  const real = globalThis.fetch
  const answer = (status: number, body: string) => (globalThis.fetch = (async () => new Response(body, { status })) as typeof fetch)
  try {
    answer(502, 'error code: 502')
    await assert.rejects(getUser('alice'), { status: 502, message: 'error code: 502' })
    forget()
    let n = 0
    globalThis.fetch = (async () => (n++ ? new Response('{"users":[]}') : new Response('{"message":"User not found"}', { status: 404 }))) as typeof fetch
    await assert.rejects(getUser('alice'), { status: 404 })
  } finally {
    globalThis.fetch = real
    forget()
  }
})

test('"Add account" sets a stuck setup aside: the join pages show their choices until it is resumed (#669)', async () => {
  Object.assign(globalThis, { addEventListener: () => {}, dispatchEvent: () => true })
  ;(globalThis as any).localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} }
  const { resumesSetup, setAside } = await import('./api.ts')
  const stuck = { phrase: '', wallet: '0xaa', display: 'Stuck' }
  const other = { phrase: '', custody: '0xbb' }
  const done = { phrase: '', custody: '0xcc', fid: 9, done: true }
  assert.equal(resumesSetup(stuck), true, 'an unfinished account resumes')
  assert.equal(resumesSetup(done), false)
  assert.equal(resumesSetup(null), false)
  setAside(stuck)
  assert.equal(resumesSetup(stuck), false, 'set aside, it shows the choices')
  assert.equal(resumesSetup(other), true, 'a new account started meanwhile still sets up')
  setAside(null)
  assert.equal(resumesSetup(stuck), true, 'back to it')
  setAside(done)
  assert.equal(resumesSetup(stuck), true, 'a finished account sets nothing aside')
})
