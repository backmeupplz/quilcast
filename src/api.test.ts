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
