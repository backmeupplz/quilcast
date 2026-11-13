// A thread whose send fails partway (write.ts postThread, compose.tsx send): the posts that went out stay out, and a
// retry goes on from the last of them instead of replying to the thread's parent again, which would fork it.
import assert from 'node:assert/strict'
import { test } from 'node:test'

const store = new Map<string, string>()
Object.assign(globalThis, { addEventListener: () => {}, dispatchEvent: () => true })
;(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) }

const strip = (h: string) => h.replace(/^0x/, '')

test('a 3-post thread whose 2nd post fails goes on, retried, from the 1st: the 2nd replies to it and the 3rd to the 2nd', async () => {
  const { hex } = await import('./fc.ts')
  const api = await import('./api.ts')
  const { readCast } = await import('../server/scheduled.mjs')
  api.setAccount({ phrase: 'test test test test test test test test test test test junk', custody: '0x7', fid: 7, signer: hex(new Uint8Array(32).fill(1)), signerAt: Math.floor(Date.now() / 1000), scopes: 2, done: true })
  // the node takes every cast but the first try at "two"
  const casts: any[] = []
  let refused = 0
  ;(globalThis as any).fetch = async (url: string, o: any = {}) => {
    const u = new URL(url, 'https://quilcast.test')
    if (u.pathname === '/v1/signer') return new Response('{}')
    if (u.pathname === '/v1/submitMessage') {
      const c = readCast(new Uint8Array(o.body), 7)
      if (c.text === 'two' && !refused++) return new Response(JSON.stringify({ details: 'node is busy' }), { status: 503 })
      return casts.push(c), new Response('{}')
    }
    throw new Error(`unexpected ${o.method} ${url}`)
  }
  const write = await import('./write.ts')
  const posts = ['one', 'two', 'three'].map((text) => ({ text, media: [] as string[] }))
  const parent = { fid: 99, hash: '0x' + '9'.repeat(40) }
  const quote = { fid: 98, hash: '0x' + '8'.repeat(40) }
  // as the composer does: the posts that went out leave it, and the last `next` is where a retry goes on from
  let left = posts
  let next: import('./write.ts').ThreadStart | undefined
  const first = { parent, quote, as: api.account! }
  await assert.rejects(write.postThread(left, first, (h, at, i) => ((next = at), (left = left.filter((p) => p.text !== posts[i].text)))), /node is busy/)
  assert.deepEqual(casts.map((c) => c.text), ['one'])
  assert.deepEqual(left.map((p) => p.text), ['two', 'three'])
  assert.deepEqual(next, { parent: { fid: 7, hash: casts[0].hash }, as: api.account })
  // the retry
  const hashes = await write.postThread(left, next ?? first)
  assert.deepEqual(casts.map((c) => c.text), ['one', 'two', 'three'])
  assert.deepEqual(casts[0].parent, { fid: 99, hash: strip(parent.hash) })
  assert.deepEqual(casts[1].parent, { fid: 7, hash: casts[0].hash })
  assert.deepEqual(casts[2].parent, { fid: 7, hash: casts[1].hash })
  assert.deepEqual(hashes.map(strip), [casts[1].hash, casts[2].hash])
  // the quote went out with the first post only, not again with the post the retry starts with
  assert.equal(api.posting.get(casts[0].hash)!.embeds.length, 1)
  assert.equal(api.posting.get(casts[1].hash)!.embeds.length, 0)
})

test('a thread into a channel: only its first post goes into the channel, a retry\'s posts are replies', async () => {
  const api = await import('./api.ts')
  const write = await import('./write.ts')
  let fail = true
  ;(globalThis as any).fetch = async (url: string) => {
    const u = new URL(url, 'https://quilcast.test')
    if (u.pathname === '/v1/signer') return new Response('{}')
    if (u.pathname === '/v1/submitMessage') return fail ? ((fail = false), new Response('{}')) : new Response('nope', { status: 500 })
    throw new Error(`unexpected ${url}`)
  }
  const channel = 'https://farcaster.xyz/~/channel/memes'
  let next: import('./write.ts').ThreadStart | undefined
  await assert.rejects(write.postThread([{ text: 'a', media: [] }, { text: 'b', media: [] }], { channel, as: api.account! }, (h, at) => (next = at)), /nope/)
  const [a] = [...api.posting.values()].filter((c) => c.text === 'a')
  assert.equal(a.parent_url, channel)
  assert.equal(next!.channel, undefined)
  assert.deepEqual(next!.parent, { fid: 7, hash: a.hash })
  ;(globalThis as any).fetch = async () => new Response('{}')
  const [b] = await write.postThread([{ text: 'b', media: [] }], next!)
  assert.equal(api.posting.get(b)!.parent_url, null)
  assert.equal(api.posting.get(b)!.parent_hash, a.hash)
})
