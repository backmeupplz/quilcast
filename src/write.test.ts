import assert from 'node:assert/strict'
import { test } from 'node:test'

test('saving a look with a key the node dropped adds a new key and saves with it', async () => {
  const store = new Map<string, string>()
  Object.assign(globalThis, { addEventListener: () => {}, dispatchEvent: () => true })
  ;(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) }
  const { ed25519 } = await import('@noble/curves/ed25519.js')
  const { hex } = await import('./fc.ts')
  const api = await import('./api.ts')
  const { saveLook } = await import('./write.ts')
  const old = hex(new Uint8Array(32).fill(1))
  // no IndexedDB here, so keys stay raw in the account, as they do in a browser whose vault fails
  api.setAccount({ phrase: 'test test test test test test test test test test test junk', custody: '0x7', fid: 7, signer: old, signerAt: Math.floor(Date.now() / 1000), scopes: 2, done: true })
  // the node doesn't list the old key, only one added through submitMessage; our server answers 403 for a key it doesn't list
  const oldKey = '0x' + hex(ed25519.getPublicKey(Uint8Array.from(Buffer.from(old, 'hex'))))
  let submits = 0
  const known = (key: string | null) => submits > 0 && key !== oldKey
  ;(globalThis as any).fetch = async (url: string, o: any = {}) => {
    const u = new URL(url, 'https://quilcast.test')
    const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
    if (u.pathname === '/v1/submitMessage') {
      submits++
      return res(200, {})
    }
    if (u.pathname === '/v1/signer') return known(u.searchParams.get('signer')) ? res(200, {}) : res(400, {})
    if (u.pathname === '/api/look/7') return known(o.headers['x-key']) ? res(200, { ok: true }) : res(403, { error: "That key doesn't belong to this account." })
    throw new Error(`unexpected ${url}`)
  }
  assert.deepEqual(await saveLook({ bg: '#000' }), { ok: true })
  assert.equal(submits, 1)
  assert.notEqual(api.account!.signer, old)
})

test('signing into an account this browser doesn\'t hold yet saves and selects it with its new key', async () => {
  // runs after the test above: account fid 7 is selected and the fake node takes any submitMessage
  const api = await import('./api.ts')
  const { ensureSigner } = await import('./write.ts')
  const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
  await ensureSigner({ phrase, custody: '0x9', fid: 9, done: true })
  assert.equal(api.account!.fid, 9)
  assert.ok(api.account!.signer)
  assert.deepEqual(api.accounts.map((a) => a.fid), [7, 9])
  // a new key for an account that isn't selected (replying as another one) leaves the selection alone
  await ensureSigner({ ...api.accounts[0], signer: undefined })
  assert.equal(api.account!.fid, 9)
  assert.ok(api.accounts[0].signer)
})

test('an account whose phrase this browser doesn\'t keep asks for it once per action and keeps nothing', async () => {
  const api = await import('./api.ts')
  const { ensureSigner } = await import('./write.ts')
  const { address, custodyKey } = await import('./fc.ts')
  const phrase = 'legal winner thank year wave sausage worth useful legal winner thank yellow'
  await api.setAccount({ phrase: '', custody: address(await custodyKey(phrase)), fid: 11, done: true })
  let asked = 0
  api.askUser.phrase = async () => (asked++, phrase)
  await ensureSigner(api.account!, true)
  assert.equal(asked, 1)
  assert.equal(api.account!.phrase, '')
  assert.ok(api.account!.pub)
  // no phrase given, nothing signed
  api.askUser.phrase = async () => null
  await assert.rejects(ensureSigner(api.account!, true), /recovery phrase/)
})

test('a node whose queue is full is asked again with the same message; still full, it says so plainly', async () => {
  // fid 7 is still selected from the first test, with its new key
  const { follow } = await import('./write.ts')
  const bodies: string[] = []
  let full = 2
  ;(globalThis as any).fetch = async (url: string, o: any = {}) => {
    if (!String(url).endsWith('/v1/submitMessage')) throw new Error(`unexpected ${url}`)
    bodies.push(Buffer.from(o.body).toString('hex'))
    return full-- > 0
      ? new Response(JSON.stringify({ error: 'Failed to submit message', error_detail: 'status: Unavailable, message: "unavailable/mempool channel is full"' }), { status: 400 })
      : new Response('{}', { status: 200 })
  }
  // the waits between tries pass at once here
  const later = globalThis.setTimeout
  ;(globalThis as any).setTimeout = (f: () => void) => later(f, 0)
  try {
    await follow(3, true)
    assert.equal(bodies.length, 3)
    assert.equal(new Set(bodies).size, 1)
    full = 99
    await assert.rejects(follow(3, true), /Couldn't reach the Farcaster node/)
  } finally {
    globalThis.setTimeout = later
  }
})

test('a FID Hypersnap never heard of (registered on Optimism after the split) says why instead of the raw node error', async () => {
  const { follow } = await import('./write.ts')
  ;(globalThis as any).fetch = async () =>
    new Response(JSON.stringify({ error: 'Failed to submit message', error_detail: 'status: InvalidArgument, message: "bad_request.validation_failure/unknown fid", details: []' }), { status: 400 })
  await assert.rejects(follow(3, true), /can't accept anything from it/)
})

test('a train car keeps the cast\'s own text and mentions, and readers never see the train embed', async () => {
  Object.assign(globalThis, { addEventListener: () => {}, dispatchEvent: () => true })
  ;(globalThis as any).localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} }
  const { saidOf } = await import('./write.ts')
  const { mentions } = await import('./fc.ts')
  const { castText, isTrain, TRAIN, urlsOf } = await import('./shared.ts')
  // Hypersnap's shape: names out of the text, their byte offsets as empty ranges; a non-empty range isn't a mention
  const c = { text: 'gm  and ✨ ', mentioned_profiles: [{ fid: 2, username: 'v' }, { fid: 3, username: 'dwr' }, { fid: 4, username: 'x' }], mentioned_profiles_ranges: [{ start: 3, end: 3 }, { start: 12, end: 12 }, { start: 0, end: 2 }] }
  const said = saidOf(c)
  assert.deepEqual(said, { text: 'gm  and ✨ ', mentions: [2, 3], positions: [3, 12], names: ['v', 'dwr'] })
  // the same as typing the cast again and looking each name up
  const ids: Record<string, number> = { v: 2, dwr: 3 }
  assert.deepEqual(await mentions(castText(c), async (n) => ids[n]), said)
  const car = { text: 'gm', embeds: [{ cast_id: { fid: 1, hash: '0x' + 'a'.repeat(40) } }, { url: TRAIN }, { url: 'https://example.com/' }] }
  assert.ok(isTrain(car))
  assert.ok(!isTrain({ embeds: [{ url: 'https://quilcast.com/trains' }] }))
  assert.deepEqual(urlsOf(car), ['https://example.com/'])
})

test('a train car carries the cast\'s uploads and links, within the embed cap', async () => {
  const { carMedia, castEmbeds, MAX_EMBEDS, TRAIN } = await import('./shared.ts')
  const q = { fid: 1, hash: '0x' + 'a'.repeat(40) }, other = { cast_id: { fid: 9, hash: '0x' + 'b'.repeat(40) } }
  const pic = 'https://imagedelivery.net/x/pic/original', vid = 'https://stream.example/v.m3u8', app = 'https://app.example/'
  const car = (c: { text: string; embeds: object[] }) => castEmbeds(c.text, carMedia(c), q)
  // an upload and a link added in the composer follow; the cast's own quote and TRAIN don't come twice
  assert.deepEqual(car({ text: 'gm', embeds: [{ url: app }, other, { url: pic }, { url: TRAIN }] }), [pic, app, TRAIN, q])
  // a car of a car: its quote of the cast before is skipped, its picture follows, and a link typed in the text comes
  // once, after the quote, as castEmbeds puts text links
  assert.deepEqual(car({ text: 'see youtube.com/watch?v=1', embeds: [{ cast_id: q }, { url: TRAIN }, { url: pic }, { url: 'https://youtube.com/watch?v=1' }] }), [pic, TRAIN, q, 'https://youtube.com/watch?v=1'])
  // too many: TRAIN and the quote stay, then as many media as fit, then links
  const full = car({ text: 'a.com', embeds: [{ url: app }, { url: vid }, { url: pic }, { url: TRAIN }] })
  assert.deepEqual(full, [vid, pic, TRAIN, q])
  assert.equal(full.length, MAX_EMBEDS)
  // unsafe URLs aren't copied
  assert.deepEqual(carMedia({ embeds: [{ url: 'javascript:alert(1)' }, { url: 'http://127.0.0.1/x.png' }, { url: TRAIN }] }), [TRAIN])
  // a URL goes out as the cast had it: percent-encoded, this one would be far past the hub's 256 bytes
  const wiki = 'https://ru.wikipedia.org/wiki/' + 'Железная_дорога_'.repeat(5)
  assert.ok(new TextEncoder().encode(wiki).length <= 256 && new TextEncoder().encode(new URL(wiki).href).length > 256)
  assert.deepEqual(carMedia({ embeds: [{ url: wiki }, { url: 'https://a.example/' + 'x'.repeat(250) }] }), [wiki, TRAIN])
  // pictures and links the text shows with Markdown are hidden embeds, so they don't take the car's slots
  assert.deepEqual(carMedia({ text: `![](${pic}) [app](${app})`, embeds: [{ url: pic }, { url: app }, { url: vid }] }), [vid, TRAIN])
})
