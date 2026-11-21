// X crossposting (server/crosspost.mjs): what a post becomes, and how the rounds cast each one once.
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { before, test } from 'node:test'
import { ed25519 } from '@noble/curves/ed25519.js'
import { hex, keyAddAuth, keyCustody, MT } from '../src/fc.ts'
import { castParent, castText, getCrosspost, idAt, loadCrosspost, mediaUrl, newKey, PER_DAY, read, revoke, round, step, toCast, turnOff, turnOn } from './crosspost.mjs'
import { fields } from './scheduled.mjs'
import { signed } from './testkit.mjs'

const T0 = Date.parse('2026-11-19T12:00:00Z')
let n = 0
/** A post as fxtwitter's /2/profile/<handle>/statuses lists it, made `s` seconds after T0. */
const post = (s, o = {}) => {
  const id = String(BigInt(idAt(T0 + s * 1000)) + BigInt(++n))
  return { id, url: `https://x.com/me/status/${id}`, text: `post ${s}`, created_timestamp: T0 / 1000 + s, author: { screen_name: 'Me' }, replying_to: null, media: {}, ...o }
}
const priv = hex(ed25519.utils.randomSecretKey())
const account = (o = {}) => ({ fid: 7, handle: 'me', priv, pub: '', on: true, since: idAt(T0), casts: {}, day: '', n: 0, ...o })
/** An account that's on, as Turn on leaves it on disk. */
const stored = async (o = {}) => {
  const c = account(o)
  await writeFile(join(dir, `${c.fid}.json`), JSON.stringify(c))
  return c
}
// the cast's text and parent, read back from the signed bytes
const textOf = (b) => Buffer.from(fields(fields(fields(b).get(7)).get(5), [1, 2, 5, 6]).get(4) || []).toString()
const parentOf = (b) => {
  const p = fields(fields(fields(b).get(7)).get(5), [1, 2, 5, 6]).get(3)
  return p && Buffer.from(fields(p).get(2)).toString('hex')
}
const fake = () => {
  const sent = []
  return { sent, submit: async (b) => void sent.push(Buffer.from(b)), upload: async (c, url) => `https://quilcast.test/m/${url.split('/').pop()}` }
}

let dir
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'crosspost-'))
  await loadCrosspost(dir)
})

test("an X post's id says when it was made", () => {
  // a real one: 2123469478923321681, posted 1795109550 (fxtwitter's created_timestamp)
  assert.ok(BigInt(idAt(1795109550e3)) <= 2123469478923321681n && 2123469478923321681n < BigInt(idAt(1795109551e3)))
})

test('own posts, quotes and threads go over; replies to others and reposts stay on X', () => {
  const casts = { 100: 'aa'.repeat(20) }
  assert.equal(castParent(post(1), 'me', casts), '')
  assert.equal(castParent(post(1, { quote: { url: 'https://x.com/a/status/1' } }), 'ME', casts), '')
  assert.equal(castParent(post(1, { replying_to: { screen_name: 'me', status: '100' } }), 'me', casts), 'aa'.repeat(20))
  // a thread whose first post wasn't cast, a reply to someone else, a repost and someone else's post: nowhere
  assert.equal(castParent(post(1, { replying_to: { screen_name: 'me', status: '99' } }), 'me', casts), null)
  assert.equal(castParent(post(1, { replying_to: { screen_name: 'other', status: '100' } }), 'me', casts), null)
  assert.equal(castParent(post(1, { reposted_by: { screen_name: 'me' } }), 'me', casts), null)
  assert.equal(castParent(post(1, { author: { screen_name: 'other' } }), 'me', casts), null)
})

test("a cast's text: the quote's link, and at most 1024 bytes with a link back", () => {
  assert.equal(castText(post(1, { text: 'look', quote: { url: 'https://x.com/a/status/1' } })), 'look\n\nhttps://x.com/a/status/1')
  const long = post(1, { text: 'ж'.repeat(700) })
  const t = castText(long)
  assert.ok(Buffer.byteLength(t) <= 1024 && t.endsWith(`… ${long.url}`) && t.startsWith('жжж'), t.slice(-80))
  assert.equal(castText(post(1, { text: 'x'.repeat(1024) })), 'x'.repeat(1024))
})

test('media: photos at the large size, videos at the best quality under the upload cap', () => {
  assert.deepEqual(mediaUrl({ type: 'photo', url: 'https://pbs.twimg.com/media/A.png?name=orig' }), { url: 'https://pbs.twimg.com/media/A.png?name=large', max: 10e6 })
  const formats = [{ url: 'https://v/a.m3u8', container: 'm3u8' }, { url: 'https://v/low.mp4', bitrate: 832000, container: 'mp4' }, { url: 'https://v/high.mp4', bitrate: 10368000, container: 'mp4' }]
  assert.equal(mediaUrl({ type: 'video', duration: 15, formats }).url, 'https://v/high.mp4')
  // ten minutes at 10 Mbit/s is ~780 MB: the smaller one
  assert.equal(mediaUrl({ type: 'video', duration: 600, formats }).url, 'https://v/low.mp4')
  assert.equal(mediaUrl({ type: 'gif', url: 'https://v/g.mp4' }).url, 'https://v/g.mp4')
  // a photo fxtwitter gave no address for is lost (the post goes over with a link to it), rather than stalling the account
  assert.equal(mediaUrl({ type: 'photo' }), null)
})

test('the same post always makes the same cast, signed with its own time', async () => {
  const s = post(5, { media: { all: [{ type: 'photo', url: 'https://pbs.twimg.com/media/A.jpg?name=orig' }] } })
  const { upload } = fake()
  const a = await toCast(s, account(), '', (u) => upload(null, u))
  const b = await toCast(s, account(), '', (u) => upload(null, u))
  assert.equal(a.hash, b.hash)
  assert.equal(fields(fields(a.msg).get(7)).get(3), BigInt(s.created_timestamp - 1609459200))
  // a photo that can't be uploaded is a link to the post instead
  const lost = await toCast(s, account(), '', async () => null)
  assert.equal(textOf(lost.msg), `post 5\n\n${s.url}`)
  const noUrl = await toCast(post(6, { media: { all: [{ type: 'photo' }] } }), account(), '', (u) => upload(null, u))
  assert.match(textOf(noUrl.msg), /^post 6\n\nhttps:\/\/x\.com\/me\/status\/\d+$/)
})

test('off by default: nothing is cast for an account that never turned it on', async () => {
  const { sent, submit, upload } = fake()
  let asked = 0
  await writeFile(join(dir, '8.json'), JSON.stringify(account({ fid: 8, on: false, at: Date.now() })))
  await round({ posts: async () => (asked++, [post(10)]), upload, submit })
  assert.equal(asked, 0)
  assert.equal(sent.length, 0)
})

test('only posts after turning on go over, each once, threads under their first cast', async () => {
  const { sent, submit, upload } = fake()
  const c = await stored()
  const old = post(-60)
  const first = post(10)
  const reply = post(20, { replying_to: { screen_name: 'me', status: first.id } })
  const other = post(30, { replying_to: { screen_name: 'someone', status: '1' } })
  const list = [reply, old, other, first]
  await step(c, { posts: async () => list, upload, submit, now: T0 })
  assert.deepEqual(sent.map(textOf), ['post 10', 'post 20'])
  assert.equal(parentOf(sent[1]), c.casts[first.id])
  assert.equal(c.since, other.id)
  // the next round finds nothing new, and neither does a restart (the state on disk)
  await step(await read(7), { posts: async () => list, upload, submit, now: T0 })
  assert.equal(sent.length, 2)
})

test('a cast signed before a restart goes again as the same bytes, not as a second cast', async () => {
  const s = post(40)
  const c = await stored({ since: idAt(T0 + 30e3) })
  let crash = true
  const { sent, upload } = fake()
  // the node took it, then the service died before it could write that down
  const submit = async (b) => {
    sent.push(Buffer.from(b))
    if (crash) throw Object.assign(new Error('socket hang up'), { retry: true })
  }
  await step(c, { posts: async () => [s], upload, submit, now: T0 })
  const kept = await read(7)
  assert.equal(kept.pending.id, s.id)
  // still being tried: Settings doesn't call it failed
  assert.equal(kept.error, undefined)
  crash = false
  await step(kept, { posts: async () => [s], upload: async () => assert.fail('nothing to upload again'), submit, now: T0 })
  assert.equal(sent.length, 2)
  assert.deepEqual(sent[0], sent[1])
  assert.equal((await read(7)).since, s.id)
})

test('a removed key stops it; a post the node refuses is skipped; a daily cap', async () => {
  const { upload } = fake()
  const gone = await stored({ since: idAt(T0) })
  await step(gone, { posts: async () => [post(50)], upload, submit: async () => { throw new Error('invalid signer') }, now: T0 })
  assert.deepEqual([gone.on, gone.error, gone.pending], [false, 'key', undefined])
  // a gasless key unused for 90 days, as the node words it
  const quiet = await stored({ fid: 8 })
  await step(quiet, { posts: async () => [post(55)], upload, submit: async () => { throw new Error('bad_request.validation_failure/key last_used_at expired') }, now: T0 })
  assert.deepEqual([quiet.on, quiet.error], [false, 'key'])
  const bad = await stored()
  const s = post(60)
  await step(bad, { posts: async () => [s], upload, submit: async () => { throw new Error('embed url too long') }, now: T0 })
  // the node's own words stay in the log; Settings says the post wasn't cast
  assert.deepEqual([bad.on, bad.since, bad.error], [true, s.id, 'skipped'])
  const { sent, submit } = fake()
  const busy = await stored()
  await step(busy, { posts: async () => Array.from({ length: PER_DAY + 5 }, (_, i) => post(100 + i)), upload, submit, now: T0 })
  assert.equal(sent.length, PER_DAY)
})

test('a refused KEY_REMOVE counts as revoked only when the node no longer lists the key', async () => {
  const c = account()
  const refuse = async () => { throw new Error('signer is expired') }
  // expired, revoked or never added: the node doesn't list it
  await revoke(c, refuse, async () => false, 0)
  // still listed: tried again later, and the reason stays out of Settings
  await assert.rejects(revoke(c, refuse, async () => true, 0), (e) => e.status === 502 && e.message === 'unavailable')
  // a KEY_ADD sent just now that the node lists a moment later is no reason to forget the key
  let looks = 0
  await assert.rejects(revoke(c, refuse, async () => ++looks > 1, 0), /unavailable/)
  // the node can't be asked: not revoked
  await assert.rejects(revoke(c, refuse, async () => { throw Object.assign(new Error('node down'), { status: 502 }) }, 0), /node down/)
})

test("a round that read the account before it was turned off doesn't bring it back", async () => {
  const c = await stored({ fid: 21 })
  const { upload, submit } = fake()
  let release
  const slow = new Promise((ok) => (release = ok))
  const going = step(c, { posts: () => slow.then(() => [post(70)]), upload, submit, now: T0 })
  // Turn off (or Delete account) lands while the round waits on X
  await rm(join(dir, '21.json'))
  release()
  await assert.rejects(going, (e) => e.stopped)
  assert.equal(await read(21), null)
})

test("an X account that can't be read shows in Settings after a few rounds, and clears once it can", async () => {
  const c = await stored({ fid: 22 })
  const { upload, submit } = fake()
  // fxtwitter having a bad moment doesn't count; the account being gone from X does
  await step(c, { posts: async () => { throw new Error('no posts list for me') }, upload, submit, now: T0 }).catch(() => {})
  assert.equal((await read(22)).fails, 0)
  const down = async () => { throw Object.assign(new Error('no X account me'), { gone: true }) }
  for (let i = 0; i < 3; i++) await step(c, { posts: down, upload, submit, now: T0 }).catch(() => {})
  assert.deepEqual([(await read(22)).error, (await read(22)).on], ['gone', true])
  await step(await read(22), { posts: async () => [], upload, submit, now: T0 })
  assert.equal((await read(22)).error, undefined)
})

test('a round that stops at a rate limit goes on from the next account', async () => {
  const keepDir = dir
  await loadCrosspost((dir = await mkdtemp(join(tmpdir(), 'crosspost-round-'))))
  try {
    for (const fid of [31, 32, 33]) await stored({ fid, handle: `h${fid}` })
    const seen = []
    const { upload, submit } = fake()
    const posts = (limit) => async (h) => {
      seen.push(h)
      if (seen.length === limit) throw Object.assign(new Error('rate limit'), { busy: true })
      return []
    }
    await round({ posts: posts(2), upload, submit, now: T0 })
    await round({ posts: posts(99), upload, submit, now: T0 })
    // stopped at h32: the next round starts with h33, not h31 again
    assert.deepEqual(seen, ['h31', 'h32', 'h33', 'h31', 'h32'])
  } finally {
    await loadCrosspost((dir = keepDir))
  }
})

test("a Turn off whose revoke failed is tried again each round, and the account goes once it lands", async () => {
  const keepDir = dir
  await loadCrosspost((dir = await mkdtemp(join(tmpdir(), 'crosspost-off-'))))
  try {
    await stored({ fid: 41, on: false, off: true })
    const { sent, submit, upload } = fake()
    const posts = async () => assert.fail('an account being turned off is never read')
    await round({ posts, upload, submit: async () => { throw new Error('node down') }, listed: async () => true, now: T0 })
    assert.equal((await read(41)).off, true)
    await round({ posts, upload, submit, listed: async () => true, now: T0 })
    assert.equal(fields(fields(sent[0]).get(7)).get(1), BigInt(MT.KEY_REMOVE))
    assert.equal(await read(41), null)
  } finally {
    await loadCrosspost((dir = keepDir))
  }
})

test('only accounts that turned it on take one of the places, not unfinished Turn ons', async () => {
  const keepDir = dir
  await loadCrosspost((dir = await mkdtemp(join(tmpdir(), 'crosspost-cap-'))))
  process.env.CROSSPOST_MAX = '2'
  const { MAX_ACCOUNTS: max, newKey: fresh, loadCrosspost: load } = await import('./crosspost.mjs?cap')
  await load(dir)
  try {
    assert.equal(max, 2)
    await stored({ fid: 51 })
    await stored({ fid: 52, on: false, off: undefined, at: Date.now() })
    await stored({ fid: 53, on: false, off: undefined, at: Date.now() })
    const signer = ed25519.utils.randomSecretKey()
    const signerHex = '0x' + hex(ed25519.getPublicKey(signer))
    const node = createServer((q, r) => r.end(JSON.stringify({ signers: [{ key: signerHex }] })))
    await new Promise((ok) => node.listen(0, ok))
    const ask = (fid) => {
      const body = '{"handle":"me"}'
      const r = Object.assign(Readable.from([Buffer.from(body)]), { headers: signed(signer, 'quilcast-crosspost-key', fid, body) })
      return fresh(r, fid, `http://127.0.0.1:${node.address().port}`, { profile: async () => ({ screen_name: 'me' }) })
    }
    try {
      // one on and two unfinished: a place is still free
      assert.match((await ask(54)).pub, /^0x[0-9a-f]{64}$/)
      await stored({ fid: 55, on: false, off: true })
      await assert.rejects(ask(56), (e) => e.status === 503 && e.message === 'full')
      // an account whose key expired keeps its own place when it turns it on again
      await stored({ fid: 51, on: false, error: 'key' })
      assert.match((await ask(51)).pub, /^0x[0-9a-f]{64}$/)
    } finally {
      node.close()
    }
  } finally {
    delete process.env.CROSSPOST_MAX
    await loadCrosspost((dir = keepDir))
  }
})

// --- the account's settings, against a stand-in node ---

test('turning it on adds a cast-only key; turning it off revokes it and forgets the account', async () => {
  const signer = ed25519.utils.randomSecretKey()
  const signerHex = '0x' + hex(ed25519.getPublicKey(signer))
  const submitted = []
  const node = createServer((q, r) => {
    if (q.url.startsWith('/v1/signersByFid')) return r.end(JSON.stringify({ signers: [{ key: signerHex }] }))
    r.statusCode = 404
    r.end('{}')
  })
  await new Promise((ok) => node.listen(0, ok))
  const NODE = `http://127.0.0.1:${node.address().port}`
  const req = (what, body = '') => Object.assign(Readable.from(body ? [Buffer.from(body)] : []), { headers: signed(signer, what, 11, body) })
  const submit = async (b) => void submitted.push(Buffer.from(b))
  try {
    assert.deepEqual(await getCrosspost(req('quilcast-crosspost-read'), 11, NODE), {})
    // the browser's key can't ask for someone else's settings
    await assert.rejects(getCrosspost(req('quilcast-crosspost-read'), 12, NODE), /Bad signature/)
    await assert.rejects(newKey(req('quilcast-crosspost-key', '{"handle":"bad handle!"}'), 11, NODE), /bad handle/)
    await assert.rejects(newKey(req('quilcast-crosspost-key', '{"handle":"nobody"}'), 11, NODE, { profile: async () => null }), /no such account/)
    const { pub } = await newKey(req('quilcast-crosspost-key', '{"handle":"@Me"}'), 11, NODE, { profile: async () => ({ screen_name: 'Me' }) })
    // the key never leaves this service, and only the service may read its file
    assert.equal((await stat(join(dir, '11.json'))).mode & 0o777, 0o600)
    assert.deepEqual(await getCrosspost(req('quilcast-crosspost-read'), 11, NODE), {})
    const custody = keyCustody(ed25519.utils.randomSecretKey().slice(0, 32))
    const a = await keyAddAuth(11, custody, Buffer.from(pub.slice(2), 'hex'), 5, [MT.CAST_ADD])
    const body = JSON.stringify({ nonce: a.nonce, deadline: a.deadline, ttl: a.ttl, metadata: hex(a.metadata), custodySig: hex(a.custodySig) })
    assert.deepEqual(await turnOn(req('quilcast-crosspost', body), 11, NODE, { submit, now: T0 }), { handle: 'Me', on: true })
    // a KEY_ADD for the service's key, signed by it, for casts only
    const m = fields(submitted[0])
    const data = fields(m.get(7))
    assert.equal(data.get(1), BigInt(MT.KEY_ADD))
    assert.equal('0x' + hex(m.get(6)), pub)
    const keyAdd = fields(data.get(19), [9])
    // scopes, packed: CAST_ADD alone
    assert.deepEqual([...keyAdd.get(9)[0]], [MT.CAST_ADD])
    assert.deepEqual(await getCrosspost(req('quilcast-crosspost-read'), 11, NODE), { handle: 'Me', on: true, off: undefined, error: undefined })
    assert.equal((await read(11)).since, idAt(T0))
    // turned off: the key revokes itself and the file goes
    assert.deepEqual(await turnOff(req('quilcast-crosspost-off'), 11, NODE, { submit }), { was: 'Me' })
    const rm = fields(fields(submitted[1]).get(7))
    assert.equal(rm.get(1), BigInt(MT.KEY_REMOVE))
    assert.ok(!(await readdir(dir)).includes('11.json'))
    // deleting the account turns it off too, with the deletion's own signature
    await newKey(req('quilcast-crosspost-key', '{"handle":"me"}'), 11, NODE, { profile: async () => ({ screen_name: 'me' }) })
    assert.deepEqual(await turnOff(req('quilcast-delete'), 11, NODE, { submit }), { was: 'me' })
    // a key never added is revoked all the same (one whose Turn on lost its answer may be live): the node says it has none
    assert.equal(submitted.length, 3)
    await assert.rejects(turnOff(req('quilcast-look'), 11, NODE, { submit }), /Bad signature/)
    // a KEY_REMOVE the node refuses while it still lists the key: the account stays, off, for Turn off to try again
    await newKey(req('quilcast-crosspost-key', '{"handle":"me"}'), 11, NODE, { profile: async () => ({ screen_name: 'me' }) })
    const refuse = async () => { throw new Error('signer is expired') }
    await assert.rejects(turnOff(req('quilcast-crosspost-off'), 11, NODE, { submit: refuse, listed: async () => true }), /unavailable/)
    assert.equal((await read(11)).off, true)
    assert.deepEqual(await turnOff(req('quilcast-crosspost-off'), 11, NODE, { submit: refuse, listed: async () => false }), { was: 'me' })
    assert.equal(await read(11), null)
  } finally {
    node.close()
  }
})
