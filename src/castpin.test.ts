// A profile's pinned cast (castpin.ts): read once from our server, and a pin or unpin made here wins over a read that
// was already on its way.
import assert from 'node:assert/strict'
import { test } from 'node:test'

test('a pinned cast is read once, and a local pin or unpin beats a read that lands after it', async () => {
  Object.assign(globalThis, { addEventListener: () => {}, dispatchEvent: () => true })
  ;(globalThis as any).localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} }
  const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40)
  const answers: Record<string, () => Promise<Response>> = {}
  const asked: string[] = []
  globalThis.fetch = (async (url: string) => (asked.push(url), answers[url]())) as typeof fetch
  const { listSkip, pinKey, pinnedCast, readPin, setPinnedCast } = await import('./castpin.ts')
  const { forget } = await import('./api.ts')
  // the profile list leaves the pin out only once it's drawn on top or known gone, never while it's loading or failed
  assert.equal(listSkip(A, A), A)
  for (const [pin, settled] of [[A, null], [A, B], [null, A], [undefined, null]] as const) assert.equal(listSkip(pin, settled), null)
  // the node's feeds give bare hex, pins keep 0x…
  for (const h of ['a'.repeat(40), A, '0X' + 'A'.repeat(40)]) assert.equal(pinKey(h), A)
  const json = (j: unknown) => Promise.resolve(new Response(JSON.stringify(j)))

  answers['/api/pin/7'] = () => json({ hash: A })
  assert.equal(pinnedCast(7), undefined)
  assert.equal(await readPin(7), A)
  assert.equal(await readPin(7), A)
  assert.deepEqual(asked, ['/api/pin/7'], 'kept, not asked again')
  assert.equal(pinnedCast(7), A)

  // no pin, or an answer that isn't a hash: none
  answers['/api/pin/8'] = () => json(null)
  answers['/api/pin/12'] = () => json({ hash: 5 })
  for (const fid of [8, 12]) assert.equal(await readPin(fid), null, String(fid)), assert.equal(pinnedCast(fid), null)

  // a server that fails or rate-limits, or no connection: still unknown, not "none", and not kept, so the next read asks
  // again and gets it
  answers['/api/pin/9'] = () => Promise.resolve(new Response('{}', { status: 502 }))
  answers['/api/pin/13'] = () => Promise.resolve(new Response('{}', { status: 429 }))
  answers['/api/pin/10'] = () => Promise.reject(new Error('offline'))
  for (const fid of [9, 13, 10]) {
    assert.equal(await readPin(fid), undefined, String(fid))
    assert.equal(pinnedCast(fid), undefined, String(fid))
    answers[`/api/pin/${fid}`] = () => json({ hash: A })
    assert.equal(await readPin(fid), A, String(fid))
    assert.equal(pinnedCast(fid), A, String(fid))
    assert.equal(asked.filter((u) => u === `/api/pin/${fid}`).length, 2, String(fid))
  }
  // a pin read before stays when a later read fails
  forget('/api/pin/9')
  answers['/api/pin/9'] = () => Promise.reject(new Error('offline'))
  assert.equal(await readPin(9), A)
  assert.equal(pinnedCast(9), A)

  // a read that's slow, then an unpin here: the unpin stays
  let land!: (r: Response) => void
  answers['/api/pin/11'] = () => new Promise((ok) => (land = ok))
  const slow = readPin(11)
  await new Promise((ok) => setTimeout(ok))
  setPinnedCast(11, null)
  land(new Response(JSON.stringify({ hash: B })))
  assert.equal(await slow, null)
  assert.equal(pinnedCast(11), null)

  // a pin here is read back without asking the server, and a later read asks again
  setPinnedCast(7, B)
  assert.equal(pinnedCast(7), B)
  answers['/api/pin/7'] = () => json({ hash: B })
  assert.equal(await readPin(7), B)
  assert.equal(asked.filter((u) => u === '/api/pin/7').length, 2)
})
