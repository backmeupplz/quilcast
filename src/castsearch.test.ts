import assert from 'node:assert/strict'
import { test } from 'node:test'
import { matches, searchCasts, words } from './castsearch.ts'

// a fake node: `n` casts by `fid`, newest first, `per` a hub page; cast i's text is texts(i). Hub hashes carry 0x, the
// v2 casts endpoint answers bare hex (like haatz)
function node(fid: number, n: number, per: number, texts: (i: number) => string, opts: { gone?: Set<number>; removes?: boolean } = {}) {
  const hash = (i: number) => i.toString(16).padStart(40, '0')
  const asked: string[] = []
  const get = async (path: string, q: Record<string, any>, fresh?: boolean) => {
    asked.push(path)
    if (path === '/v1/castsByFid') {
      assert.equal(q.fid, fid)
      assert.equal(q.reverse, 'true')
      assert.equal(fresh, true, 'raw hub pages skip the memo')
      const from = q.pageToken ? +q.pageToken : 0
      const to = Math.min(n, from + per)
      const messages: any[] = []
      for (let i = from; i < to; i++) {
        // a remove sits among the adds on a real node
        if (opts.removes && i % 7 === 0) messages.push({ data: { type: 'MESSAGE_TYPE_CAST_REMOVE', fid, castRemoveBody: {} }, hash: '0x' + 'f'.repeat(40) })
        messages.push({ data: { type: 'MESSAGE_TYPE_CAST_ADD', fid, castAddBody: { text: texts(i) } }, hash: '0x' + hash(i) })
      }
      return { messages, nextPageToken: to < n ? String(to) : '' }
    }
    assert.equal(path, '/v2/farcaster/casts')
    const hs: string[] = q.casts.split(',')
    assert.ok(hs.length <= 50)
    // answered out of order, and without the ones that are gone
    return { casts: hs.filter((h) => !opts.gone?.has(parseInt(h, 16))).reverse().map((h) => ({ hash: h, text: texts(parseInt(h, 16)), author: { fid } })) }
  }
  return { get, asked, hash }
}

test('words and matches: every word, any order, case and accents ignored', () => {
  assert.deepEqual(words('  Café  Latte '), ['cafe', 'latte'])
  assert.equal(matches('I had a LATTE at the café', words('cafe latte')), true)
  assert.equal(matches('latte only', words('cafe latte')), false)
  assert.equal(matches('anything', words('   ')), false, 'an empty search matches nothing')
})

test("other scripts' marks are part of the letter: only Latin accents are ignored", () => {
  // Japanese dakuten, Hindi matras, Thai vowel and tone marks
  assert.equal(matches('かき', words('がき')), false)
  assert.equal(matches('がき', words('がき')), true)
  assert.equal(matches('का', words('कि')), false)
  assert.equal(matches('कि', words('कि')), true)
  assert.equal(matches('ไม', words('ไม่')), false)
  assert.equal(matches('ไม่', words('ไม่')), true)
  // ...in both directions: the bare letter doesn't find the marked one
  assert.equal(matches('が', words('か')), false)
  assert.equal(matches('ば', words('は')), false)
  // Korean syllables aren't broken into their parts
  assert.equal(matches('강', words('가')), false)
  assert.equal(matches('날', words('나')), false)
  assert.equal(matches('한국어', words('한국')), true)
  // Cyrillic й and ї are letters of their own
  assert.equal(matches('мои', words('мой')), false)
  assert.equal(matches('мой', words('мой')), true)
  assert.equal(matches('іі', words('її')), false)
  // Vietnamese tones are Latin accents, like French ones
  assert.equal(matches('Tiếng Việt', words('tieng viet')), true)
  assert.equal(matches('ＣＡＦÉ', words('cafe')), true, 'full-width letters are plain ones')
})

test('searchCasts keeps only matching casts, newest first, across hub pages, and goes on where it stopped', async () => {
  // every 3rd cast says "rad"; 100 casts, 10 a hub page
  const { get, asked, hash } = node(212233, 100, 10, (i) => (i % 3 === 0 ? `a RAD feature ${i}` : `nothing ${i}`), { removes: true })
  const want = Array.from({ length: 100 }, (_, i) => i).filter((i) => i % 3 === 0).map(hash)
  const r1 = await searchCasts(get, 212233, 'rad', undefined)
  assert.deepEqual(r1.casts.map((c) => c.hash), want.slice(0, 25), 'first 25 matches, in the node order')
  assert.ok(r1.next.cursor)
  const r2 = await searchCasts(get, 212233, 'rad', r1.next.cursor!)
  assert.deepEqual(r2.casts.map((c) => c.hash), want.slice(25), 'the rest, none twice')
  assert.equal(r2.next.cursor, null, 'the end of the casts ends the feed')
  // the page the first load stopped in was read once: the second load took it from the kept pages
  assert.equal(asked.filter((p) => p === '/v1/castsByFid').length, 10)
})

test('searchCasts with no match reads to the end and says so; a narrower search reads only the newest page again', async () => {
  const { get, asked } = node(3, 30, 10, (i) => `cast number ${i}`)
  const r = await searchCasts(get, 3, 'zebra')
  assert.deepEqual(r, { casts: [], next: { cursor: null } })
  assert.equal(asked.filter((p) => p === '/v1/castsByFid').length, 3)
  const r2 = await searchCasts(get, 3, 'number 2')
  assert.deepEqual(r2.casts.map((c) => c.text), ['cast number 2', 'cast number 12', 'cast number 20', 'cast number 21', 'cast number 22', 'cast number 23', 'cast number 24', 'cast number 25', 'cast number 26', 'cast number 27', 'cast number 28', 'cast number 29'])
  assert.equal(asked.filter((p) => p === '/v1/castsByFid').length, 4, 'the older pages came from the cache')
})

test('a new search finds a cast posted since the last one', async () => {
  // a hub whose page token is the last cast's id (like a real one), 2 a page; casts are [id, text], newest first
  let list: [number, string][] = [[6, 'hello world'], [5, 'old one'], [4, 'hello again'], [3, 'older'], [2, 'hello there'], [1, 'oldest']]
  const get = async (path: string, q: Record<string, any>) => {
    if (path === '/v1/castsByFid') {
      const from = q.pageToken ? list.findIndex(([id]) => id === +q.pageToken) + 1 : 0
      const pg = list.slice(from, from + 2)
      const more = from + 2 < list.length
      return { messages: pg.map(([id, text]) => ({ data: { type: 'MESSAGE_TYPE_CAST_ADD', castAddBody: { text } }, hash: '0x' + String(id).padStart(40, '0') })), nextPageToken: more ? String(pg.at(-1)![0]) : '' }
    }
    const texts = new Map(list.map(([id, t]) => [String(id).padStart(40, '0'), t]))
    return { casts: q.casts.split(',').map((h: string) => ({ hash: h, text: texts.get(h) })) }
  }
  assert.deepEqual((await searchCasts(get, 12, 'hello')).casts.map((c) => c.text), ['hello world', 'hello again', 'hello there'])
  list = [[7, 'hello new'], ...list]
  assert.deepEqual((await searchCasts(get, 12, 'hello')).casts.map((c) => c.text), ['hello new', 'hello world', 'hello again', 'hello there'])
})

test('a load that stopped mid-page goes on after the last cast it read', async () => {
  // 60 casts, all matching, one hub page: the first load stops after 25
  const { get, hash } = node(5, 60, 100, (i) => `match ${i}`)
  const r1 = await searchCasts(get, 5, 'match')
  assert.equal(r1.next.cursor, `${hash(24)}:`)
  const r2 = await searchCasts(get, 5, 'match', r1.next.cursor!)
  assert.deepEqual(r2.casts.map((c) => c.hash), Array.from({ length: 25 }, (_, i) => hash(25 + i)))
  // a cursor whose cast isn't on the page (the page was read again and changed) starts at the page's top
  const r3 = await searchCasts(get, 5, 'match', `${'e'.repeat(40)}:`)
  assert.equal(r3.casts[0].hash, hash(0))
})

test('at most 60 hub pages are kept', async () => {
  const hubOf = (asked: string[]) => asked.filter((p) => p === '/v1/castsByFid').length
  // 55 pages fit: searching again reads only the newest one
  const a = node(6, 55, 1, () => 'nope')
  await searchCasts(a.get, 6, 'x').then((r) => searchCasts(a.get, 6, 'x', r.next.cursor!))
  assert.equal(hubOf(a.asked), 55)
  await searchCasts(a.get, 6, 'x').then((r) => searchCasts(a.get, 6, 'x', r.next.cursor!))
  assert.equal(hubOf(a.asked), 56)
  // 70 don't: the oldest kept go, so a search of all 70 again reads pages again
  const b = node(8, 70, 1, () => 'nope')
  await searchCasts(b.get, 8, 'x').then((r) => searchCasts(b.get, 8, 'x', r.next.cursor!))
  assert.equal(hubOf(b.asked), 70)
  await searchCasts(b.get, 8, 'x')
  assert.ok(hubOf(b.asked) > 71)
})

test('matches the node can no longer find don\'t end the search early: the load reads on for others', async () => {
  // the first 30 matches are gone, then 10 more are there, on one hub page
  const { get, hash } = node(16, 40, 100, () => 'hello', { gone: new Set(Array.from({ length: 30 }, (_, i) => i)) })
  const r = await searchCasts(get, 16, 'hello')
  assert.deepEqual(r.casts.map((c) => c.hash), Array.from({ length: 10 }, (_, i) => hash(30 + i)))
  assert.equal(r.next.cursor, null)
})

test('searchCasts leaves out a match the node can no longer find', async () => {
  const { get, hash } = node(7, 5, 10, () => 'hello', { gone: new Set([2]) })
  const r = await searchCasts(get, 7, 'hello')
  assert.deepEqual(r.casts.map((c) => c.hash), [0, 1, 3, 4].map(hash))
})

test('searchCasts stops after 50 hub pages in one load and hands back a cursor', async () => {
  const { get, asked } = node(9, 60 * 2, 2, (i) => (i === 119 ? 'needle' : 'hay'))
  const r = await searchCasts(get, 9, 'needle')
  assert.equal(r.casts.length, 0)
  assert.equal(r.capped, true, 'it says it stopped at the cap with nothing found')
  assert.equal(r.next.cursor, '100', 'the next load starts at the next hub page')
  assert.equal(asked.filter((p) => p === '/v1/castsByFid').length, 50)
  const r2 = await searchCasts(get, 9, 'needle', r.next.cursor!)
  assert.equal(r2.casts.length, 1)
  assert.equal(r2.next.cursor, null)
  assert.equal(r2.capped, undefined)
})

test('a load that finds something before the cap is not capped', async () => {
  const { get } = node(13, 60 * 2, 2, (i) => (i === 3 ? 'needle' : 'hay'))
  const r = await searchCasts(get, 13, 'needle')
  assert.equal(r.casts.length, 1)
  assert.equal(r.capped, undefined)
  assert.equal(r.next.cursor, '100', 'it goes on past the cap on the next load')
})

test('a search no longer wanted stops reading pages', async () => {
  const { get, asked } = node(14, 100, 2, () => 'hay')
  let wanted = true
  const hub = () => asked.filter((p) => p === '/v1/castsByFid').length
  const superseding = async (path: string, q: Record<string, any>, fresh?: boolean) => {
    const r = await get(path, q, fresh)
    // superseded (another word typed, the profile left) while its 3rd page loaded
    if (hub() === 3) wanted = false
    return r
  }
  const r = await searchCasts(superseding, 14, 'needle', undefined, () => wanted)
  assert.equal(hub(), 3, 'no page after it was superseded')
  assert.deepEqual(r, { casts: [], next: { cursor: null } })
  // and one superseded before it starts reads nothing
  const before = hub()
  await searchCasts(get, 14, 'x', undefined, () => false)
  assert.equal(hub(), before)
})

test('a superseded search does not read its matches in full', async () => {
  const { get, asked } = node(15, 4, 10, () => 'needle')
  // still wanted until its hub page has been asked for
  const r = await searchCasts(get, 15, 'needle', undefined, () => !asked.includes('/v1/castsByFid'))
  assert.equal(asked.includes('/v2/farcaster/casts'), false)
  assert.equal(r.casts.length, 0)
})

test('a failed hub page is not kept, so trying again asks the node again', async () => {
  let fail = true
  const get = async (path: string) => {
    if (path === '/v1/castsByFid') {
      if (fail) throw new Error('node answered 502')
      return { messages: [{ data: { type: 'MESSAGE_TYPE_CAST_ADD', castAddBody: { text: 'hi' } }, hash: '0x' + 'a'.repeat(40) }], nextPageToken: '' }
    }
    return { casts: [{ hash: 'a'.repeat(40), text: 'hi' }] }
  }
  await assert.rejects(searchCasts(get, 11, 'hi'), /502/)
  fail = false
  assert.equal((await searchCasts(get, 11, 'hi')).casts.length, 1)
})
