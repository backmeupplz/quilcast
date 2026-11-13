// A reply draft whose cast to reply to can't be loaded (the node doesn't have it yet, or the network failed): it still
// goes out as that reply, or, when the author of that cast isn't known, it's kept as a reply the composer won't send
// (write.ts draftParent and draftTarget, compose.tsx open and send). It never goes out as a new cast.
import assert from 'node:assert/strict'
import { test } from 'node:test'

const store = new Map<string, string>()
Object.assign(globalThis, { addEventListener: () => {}, dispatchEvent: () => true })
;(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) }

const PARENT = `0x${'ab'.repeat(20)}`

/** The app with account 7 signed in; the node serves no cast, and every message submitted is kept. */
async function app() {
  const { hex } = await import('./fc.ts')
  const api = await import('./api.ts')
  api.setAccount({ phrase: 'test test test test test test test test test test test junk', custody: '0x7', fid: 7, signer: hex(new Uint8Array(32).fill(1)), signerAt: Math.floor(Date.now() / 1000), scopes: 2, done: true })
  const sent: Uint8Array[] = []
  const asked: string[] = []
  ;(globalThis as any).fetch = async (url: string, o: any = {}) => {
    const u = new URL(url, 'https://quilcast.test')
    if (u.pathname === '/v1/submitMessage') return sent.push(o.body), new Response('{}')
    if (u.pathname === '/v1/signer') return new Response('{}')
    if (u.pathname === '/v2/farcaster/cast') return asked.push(`${u.searchParams.get('identifier')}@${u.searchParams.get('fid')}`), new Response('not found', { status: 404 })
    throw new Error(`unexpected ${url}`)
  }
  return { api, sent, asked, write: await import('./write.ts') }
}
const bytes = (h: string) => Buffer.from(h.replace(/^0x/, ''), 'hex')

test('a reply draft whose cast to reply to fails to load still sends as a reply to that hash, by the author it kept', async () => {
  const { sent, asked, write } = await app()
  const to = await write.draftParent({ parent: PARENT, pfid: 99, as: 7 })
  // asked for again by its author, then as a cast of ours, before a stand-in is made
  assert.deepEqual(asked, [`${PARENT.slice(2)}@99`, `${PARENT.slice(2)}@7`])
  assert.ok(to)
  assert.equal(to.hash, PARENT)
  assert.equal(to.author.fid, 99)
  // compose.tsx send: the first post replies to the cast the composer has, and goes into no channel
  await write.post('still a reply', { parent: { fid: to.author.fid, hash: to.hash } })
  assert.equal(sent.length, 1)
  const msg = Buffer.from(sent[0])
  assert.ok(msg.includes(bytes(PARENT)), 'the signed cast replies to the draft\'s parent hash')
  // saved again, it keeps both
  assert.deepEqual(write.draftTarget(to, undefined, 'memes'), { parent: PARENT, pfid: 99 })
})

test('found on the second try, by author, the real cast is replied to', async () => {
  const { write } = await app()
  const real = { hash: PARENT, text: 'gm', timestamp: new Date().toISOString(), author: { fid: 7, username: 'me' }, embeds: [], reactions: { likes_count: 0, recasts_count: 0 }, replies: { count: 0 } }
  const tries: number[] = []
  // an older draft without `pfid`, replying to a cast of ours that hadn't landed: asked for as the draft's account's
  const to = await write.draftParent({ parent: PARENT, as: 7 }, async (_, fid) => (tries.push(fid), fid === 7 ? real : null))
  assert.deepEqual(tries, [7])
  assert.equal(to, real)
})

test("a reply draft whose author isn't known and can't be loaded is refused, and saving it keeps it a reply", async () => {
  const { sent, write } = await app()
  const to = await write.draftParent({ parent: PARENT, as: 7 })
  // compose.tsx: null makes it `lost`, whose send only warns
  assert.equal(to, null)
  assert.equal(sent.length, 0)
  // kept as a draft it still replies to that hash, and doesn't go into the channel picked before
  assert.deepEqual(write.draftTarget(undefined, PARENT, 'memes'), { parent: PARENT })
  // a draft that isn't a reply has nothing to look for
  assert.equal(await write.draftParent({ as: 7 }), null)
  assert.deepEqual(write.draftTarget(undefined, undefined, 'memes'), { channel: 'memes' })
})
