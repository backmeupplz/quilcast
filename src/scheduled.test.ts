// A scheduled thread that failed partway (write.ts unsent, compose.tsx edit): signed again, only the posts that didn't
// go out are signed and handed to the server, the first of them replying to the last one that did.
import assert from 'node:assert/strict'
import { test } from 'node:test'

const store = new Map<string, string>()
Object.assign(globalThis, { addEventListener: () => {}, dispatchEvent: () => true })
;(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) }

const h = (i: number) => String(i).repeat(40)
const failed = (texts: string[], posted: number, hashes = texts.filter((x, i) => i === 0 || x.trim()).map((_, i) => h(i + 1))) => ({
  id: crypto.randomUUID(), at: Date.now() - 600e3, hash: hashes[0], hashes, status: 'failed' as const, posted, error: 'invalid signer',
  draft: { parts: texts.map((text) => ({ text, media: [] as string[] })), channel: 'memes', as: 7 },
})

/** The app with account 7 signed in and a server that takes any PUT, keeping what it was sent. */
async function app() {
  const { hex } = await import('./fc.ts')
  const api = await import('./api.ts')
  api.setAccount({ phrase: 'test test test test test test test test test test test junk', custody: '0x7', fid: 7, signer: hex(new Uint8Array(32).fill(1)), signerAt: Math.floor(Date.now() / 1000), scopes: 2, done: true })
  const puts: { id: string; msgs: string[]; draft: any }[] = []
  ;(globalThis as any).fetch = async (url: string, o: any = {}) => {
    const u = new URL(url, 'https://quilcast.test')
    if (u.pathname === '/v1/signer' || u.pathname === '/v1/submitMessage') return new Response('{}')
    if (u.pathname === '/api/scheduled/7' && o.method === 'GET') return Response.json([])
    if (u.pathname === '/api/scheduled/7' && o.method === 'PUT') return puts.push(JSON.parse(o.body)), Response.json({})
    throw new Error(`unexpected ${o.method} ${url}`)
  }
  return { api, puts, write: await import('./write.ts') }
}

test('a failed thread with 2 of 4 posted is signed again as its posts 3 and 4, the 3rd replying to the 2nd', async () => {
  const { api, puts, write } = await app()
  const s = failed(['one', 'two', 'three', 'four'], 2)
  const rest = write.unsent(s)!
  assert.deepEqual(rest, { parts: [{ text: 'three', media: [] }, { text: 'four', media: [] }], parent: h(2), last: 'two' })
  // as the composer schedules what it opened: the rest, replying to the last cast that went out (compose.tsx later)
  const at = Date.now() + 3600e3
  await write.schedule(rest.parts.map((p) => ({ text: p.text, media: p.media })), { parent: { fid: 7, hash: `0x${rest.parent}` }, as: api.account!, draft: { parts: rest.parts, parent: `0x${rest.parent}`, as: 7 } }, at)
  assert.equal(puts.length, 1)
  const { readCast } = await import('../server/scheduled.mjs')
  const casts = puts[0].msgs.map((m) => readCast(new Uint8Array(Buffer.from(m, 'base64')), 7))
  assert.deepEqual(casts.map((c) => c.text), ['three', 'four'])
  assert.deepEqual(casts[0].parent, { fid: 7, hash: h(2) })
  assert.deepEqual(casts[1].parent, { fid: 7, hash: casts[0].hash })
  // a new item: the failed one is taken off the list once this one is in (compose.tsx unschedule)
  assert.notEqual(puts[0].id, s.id)
})

test('which posts went out is counted as the composer signed them: an empty post past the first was left out', async () => {
  const write = await import('./write.ts')
  // the composer sent 'one', 'two', 'three' ('  ' was left out); two of them went out
  assert.deepEqual(write.unsent(failed(['one', '  ', 'two', 'three'], 2)), { parts: [{ text: 'three', media: [] }], parent: h(2), last: 'two' })
  // a first post with only a quote or attachments is still a post
  assert.deepEqual(write.unsent({ ...failed(['', 'two'], 1), hashes: [h(1), h(2)] })?.parts, [{ text: 'two', media: [] }])
  // one with a picture and no text too
  const pic = failed(['one', '', 'three'], 1, [h(1), h(2), h(3)])
  pic.draft.parts[1].media = ['https://imagedelivery.net/a/p/original']
  assert.deepEqual(write.unsent(pic)?.parts.map((p) => p.media.length), [1, 0])
})

test('nothing went out, all of it did, or the draft does not line up: nothing to resume (the composer warns instead)', async () => {
  const write = await import('./write.ts')
  assert.equal(write.unsent(failed(['one', 'two'], 0)), null)
  assert.equal(write.unsent(failed(['one', 'two'], 2)), null)
  // three posts in the draft but four were signed: which went out can't be told
  assert.equal(write.unsent(failed(['one', 'two', 'three'], 1, [h(1), h(2), h(3), h(4)])), null)
  assert.equal(write.unsent({ ...failed(['one', 'two'], 1), draft: undefined }), null)
})

test('a scheduled thread over the server\'s limit says so before anything is signed or sent', async () => {
  const { puts, write } = await app()
  const { MAX_PARTS } = await import('../server/scheduled.mjs')
  assert.equal(write.MAX_SCHEDULED_PARTS, MAX_PARTS)
  const posts = Array.from({ length: MAX_PARTS + 1 }, (_, i) => ({ text: `post ${i}`, media: [] }))
  const sent = (globalThis as any).fetch
  let calls = 0
  ;(globalThis as any).fetch = (...a: any[]) => (calls++, sent(...a))
  await assert.rejects(write.schedule(posts, { draft: { parts: posts } }, Date.now() + 3600e3), { message: 'A scheduled thread can have up to 25 posts.' })
  assert.equal(calls, 0)
  assert.equal(puts.length, 0)
  // 25 is fine
  await write.schedule(posts.slice(0, MAX_PARTS), { draft: { parts: posts.slice(0, MAX_PARTS) } }, Date.now() + 3600e3)
  assert.equal(puts[0].msgs.length, MAX_PARTS)
})
