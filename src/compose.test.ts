// The composer's attachments (compose.tsx): a GIF picked from Tenor (src/gifs.tsx) is attached like an uploaded photo,
// counts against MAX_EMBEDS with the first post's quote and fixed embeds, and goes out as the cast's embed as it is.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { embedRoom, isImg, isLookImg, MAX_EMBEDS, postMedia, withGif } from './shared.ts'

const GIF = 'https://media1.tenor.com/m/gotOLnyvy4YAAAAd/bubu-dancing-dance.gif'
const att = (url: string) => ({ id: Math.random(), preview: url, video: false, url })
const photo = (i: number) => att(`https://imagedelivery.net/a/p${i}/original`)

test('a picked GIF is attached and becomes the post\'s embed, shown as an animated picture', () => {
  const files = withGif([photo(1)], 0, att(GIF))
  assert.deepEqual(files.map((f) => f.url), ['https://imagedelivery.net/a/p1/original', GIF])
  // the first post's fixed embeds (a mini app's links) go first, then the attachments
  assert.deepEqual(postMedia(['https://app.example/'], files), ['https://app.example/', 'https://imagedelivery.net/a/p1/original', GIF])
  // the feed shows it as a picture (ui.tsx Media), not a link card, and the picker accepts it
  assert.ok(isImg(GIF))
  assert.ok(isLookImg(GIF))
})

test('the photo and GIF buttons go off once a post has no room, a quote counting in the first post', () => {
  assert.equal(MAX_EMBEDS, 4)
  assert.equal(embedRoom(0, 0), 4)
  // a quote leaves three
  assert.equal(embedRoom(2, 1), 1)
  assert.equal(embedRoom(3, 1), 0)
  // a full post takes no GIF
  const full = [1, 2, 3, 4].map(photo)
  assert.equal(embedRoom(full.length, 0), 0)
  assert.equal(withGif(full, 0, att(GIF)), full)
  // nor does one whose quote and mini app links fill it
  assert.equal(withGif([photo(1)], 3, att(GIF)).length, 1)
  assert.equal(embedRoom(5, 1), 0)
})

test('posting a GIF signs a cast whose embed is the Tenor URL', async () => {
  const store = new Map<string, string>()
  Object.assign(globalThis, { addEventListener: () => {}, dispatchEvent: () => true })
  ;(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) }
  const { hex } = await import('./fc.ts')
  const api = await import('./api.ts')
  const { post } = await import('./write.ts')
  api.setAccount({ phrase: 'test test test test test test test test test test test junk', custody: '0x7', fid: 7, signer: hex(new Uint8Array(32).fill(1)), signerAt: Math.floor(Date.now() / 1000), scopes: 2, done: true })
  const sent: Uint8Array[] = []
  ;(globalThis as any).fetch = async (url: string, o: any = {}) => {
    const u = new URL(url, 'https://quilcast.test')
    if (u.pathname === '/v1/submitMessage') return sent.push(o.body), new Response('{}')
    if (u.pathname === '/v1/signer') return new Response('{}')
    throw new Error(`unexpected ${url}`)
  }
  const hash = await post('look', { media: postMedia([], [att(GIF)]) })
  assert.equal(sent.length, 1)
  assert.ok(Buffer.from(sent[0]).includes(GIF), 'the signed message embeds the GIF URL')
  assert.deepEqual(api.posting.get(hash)?.embeds, [{ url: GIF }])
})
