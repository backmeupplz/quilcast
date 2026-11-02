// Spam scores: asked for once per cast (parents too), labelled over the threshold, hidden only in Hide mode.
import assert from 'node:assert/strict'
import { test } from 'node:test'

test('scores are fetched once, labelled over the threshold, hidden only in Hide mode', async () => {
  Object.assign(globalThis, { addEventListener: () => {}, dispatchEvent: () => true })
  ;(globalThis as any).localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} }
  const { settings } = await import('./api.ts')
  const { checkSpam, spamOf, hidesSpam } = await import('./spam.ts')
  const asked: string[] = []
  globalThis.fetch = (async (url: string) => (asked.push(url), Response.json({ '0xa': 0.97, '0xb': 0.5, '0xc': null }))) as any
  const cast = (hash: string, up?: any[]) => ({ hash, up }) as any
  const a = cast('0xa', [cast('0xb')]), b = cast('0xb'), c = cast('0xc')
  await checkSpam([a, c])
  await checkSpam([a, b])
  assert.deepEqual(asked, ['https://spam.quilcast.com/scores?h=0xa,0xb,0xc'], 'a known score is not asked for again')
  assert.equal(spamOf(a), 97)
  assert.equal(spamOf(b), null, 'under the 70% default')
  settings.spamAt = 50
  assert.equal(spamOf(b), 50)
  assert.equal(spamOf(c), null, 'not scored')
  assert.equal(hidesSpam(a), false, 'Show is the default')
  settings.spam = 'hide'
  assert.equal(hidesSpam(a), true)
  globalThis.fetch = (async () => { throw new Error('down') }) as any
  await checkSpam([cast('0xd')]) // never throws
})
