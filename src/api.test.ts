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
