// Anonymous mode (#491): the device's follow list, its import and export, and the merged Following feed.
import assert from 'node:assert/strict'
import { test } from 'node:test'

const store = new Map<string, string>()
const events: string[] = []
const heard = new Map<string, ((e: Event) => void)[]>()
Object.assign(globalThis, {
  addEventListener: (type: string, f: (e: Event) => void) => heard.set(type, [...(heard.get(type) || []), f]),
  dispatchEvent: (e: Event) => (events.push(e.type), (heard.get(e.type) || []).forEach((f) => f(e)), true),
})
;(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) }
const L = await import('./local.ts')

test('the list keeps each account once, survives a reload and tells the app when it changes', () => {
  store.clear()
  events.length = 0
  L.setLocal({ fid: 3, username: 'dwr' }, true)
  L.setLocal({ fid: 2 }, true)
  L.setLocal({ fid: 3, username: 'dwr' }, true)
  assert.deepEqual(L.localFollows(), [{ fid: 2 }, { fid: 3, username: 'dwr' }])
  assert.ok(L.isLocal(3) && !L.isLocal(4))
  assert.ok(events.every((e) => e === 'follows') && events.length === 3)
  L.setLocal({ fid: 3 }, false)
  assert.deepEqual(L.localFollows(), [{ fid: 2 }])
  assert.deepEqual(L.addLocal([{ fid: 2 }, { fid: 9, username: 'x' }, { fid: -1 }, { fid: 1.5 } as any]), { n: 1, cut: 0 })
  L.removeLocal([2, 9])
  assert.deepEqual(L.localFollows(), [])
  assert.equal(store.has('quilcast:local-follows'), false, 'an empty list leaves nothing behind')
  store.set('quilcast:feed:local:following', '[]')
  L.setLocal({ fid: 4 }, true)
  assert.ok(store.has('quilcast:feed:local:following'), 'a follow keeps the cached page')
  L.setLocal({ fid: 4 }, false)
  assert.ok(!store.has('quilcast:feed:local:following'), "an unfollow drops it, so the person's casts don't paint again")
  store.set('quilcast:local-follows', '{not json')
  assert.deepEqual(L.localFollows(), [], 'a broken value reads as no list')
})

test('an export imports back as the same list, and plain lists of FIDs and usernames import too', () => {
  const list = [{ fid: 3, username: 'dwr' }, { fid: 602 }]
  assert.deepEqual(L.parseImport(L.exportLocal(list)), { follows: list, names: [] })
  assert.deepEqual(L.parseImport('[1, "2", "@Alice", {"fid": 5, "username": "e"}]'), { follows: [{ fid: 1 }, { fid: 2 }, { fid: 5, username: 'e' }], names: ['alice'] })
  assert.deepEqual(L.parseImport('3, @dwr\nhttps://quilcast.com/u/v?x=1 https://farcaster.xyz/Bob.eth\n\n3 !!! @'), { follows: [{ fid: 3 }], names: ['dwr', 'v', 'bob.eth'] })
  assert.deepEqual(L.parseImport('{"something": "else"}'), { follows: [], names: [] })
  // a single FID or name is JSON too, but means itself
  assert.deepEqual(L.parseImport('3'), { follows: [{ fid: 3 }], names: [] })
  assert.deepEqual(L.parseImport('dwr'), { follows: [], names: ['dwr'] })
  assert.deepEqual(L.parseImport('quilcast.com/u/dwr !1234 https://warpcast.com/~/profiles/602 farcaster.xyz/v'), { follows: [{ fid: 1234 }, { fid: 602 }], names: ['dwr', 'v'] })
  // "@" names a username, digits or not; "!" and bare digits a FID
  assert.deepEqual(L.parseImport('@1234 !77 88 ["@99"]'), { follows: [{ fid: 77 }, { fid: 88 }], names: ['1234'] })
  assert.deepEqual(L.parseImport('["@99", 5, "6", "!7"]'), { follows: [{ fid: 5 }, { fid: 6 }, { fid: 7 }], names: ['99'] })
  // a file's names are kept only when they can be usernames
  assert.deepEqual(L.parseImport(JSON.stringify([{ fid: 1, username: 'ok.eth' }, { fid: 2, username: 'x'.repeat(500) }, { fid: 3, username: '<b>hi</b>' }])), { follows: [{ fid: 1, username: 'ok.eth' }, { fid: 2 }, { fid: 3 }], names: [] })
  // usernames in a JSON list: as {username} without a FID, or a lone JSON string
  assert.deepEqual(L.parseImport('[{"username": "Alice"}, {"fid": "x", "username": "bob"}, {"username": "<b>"}, "carol"]'), { follows: [], names: ['alice', 'bob', 'carol'] })
  assert.deepEqual(L.parseImport('"dwr"'), { follows: [], names: ['dwr'] })
  assert.deepEqual(L.parseImport('"dwr", "v"'), { follows: [], names: ['dwr', 'v'] })
  // a cast's link names no one (not the username "c" or "dwr")
  assert.deepEqual(L.parseImport('quilcast.com/c/0xabc https://farcaster.xyz/dwr/0x1234 https://quilcast.com/u/v/ farcaster.xyz/~/channel/x https://quilcast.com/settings www.quilcast.com/following'), { follows: [], names: ['v'] })
  assert.deepEqual(L.parseImport('https://farcaster.xyz/w warpcast.com/~/profiles/7'), { follows: [{ fid: 7 }], names: ['w'] })
})

test('imports stop once the list holds IMPORT_MAX, so an export always imports back whole', () => {
  store.clear()
  const many = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ fid: from + i }))
  assert.deepEqual(L.addLocal(many(1, 3000)), { n: L.IMPORT_MAX, cut: 3000 - L.IMPORT_MAX })
  assert.equal(L.localFollows().length, L.IMPORT_MAX)
  assert.equal(L.room(), 0)
  // a second run adds nothing more; accounts already on the list don't count as cut
  assert.deepEqual(L.addLocal(many(1, 400)), { n: 0, cut: 100 })
  L.removeLocal([1, 2])
  assert.deepEqual(L.addLocal(many(5000, 5)), { n: 2, cut: 3 })
  assert.equal(L.localFollows().length, L.IMPORT_MAX)
  // a Follow tap can't grow it past the cap either; an unfollow or a tap on someone already on it still works
  events.length = 0
  assert.equal(L.setLocal({ fid: 99999 }, true), false)
  assert.deepEqual(events, ['follows-full'])
  assert.equal(L.setLocal({ fid: 3 }, true), true)
  assert.equal(L.setLocal({ fid: 3 }, false), true)
  assert.equal(L.setLocal({ fid: 99999 }, true), true)
  assert.equal(L.localFollows().length, L.IMPORT_MAX)
  const out = L.exportLocal()
  store.clear()
  assert.deepEqual(L.addLocal(L.parseImport(out).follows), { n: L.IMPORT_MAX, cut: 0 })
  store.clear()
})

test("a change the browser won't store says so, and leaves the list as it was", () => {
  store.clear()
  events.length = 0
  L.setLocal({ fid: 1 }, true)
  const set = (globalThis as any).localStorage.setItem
  ;(globalThis as any).localStorage.setItem = () => {
    throw new Error('QuotaExceededError')
  }
  try {
    assert.equal(L.setLocal({ fid: 2 }, true), false)
    assert.equal(L.addLocal([{ fid: 3 }]), null)
    assert.equal(L.answered(9), false)
    assert.deepEqual(L.localFollows(), [{ fid: 1 }])
    assert.deepEqual(events, ['follows', 'follows-unsaved', 'follows-unsaved', 'follows-unsaved'])
  } finally {
    ;(globalThis as any).localStorage.setItem = set
  }
  assert.equal(L.setLocal({ fid: 2 }, true), true)
  store.clear()
})

// a stream of entries with the given timestamps, `per` a page, counting its calls
const stream = (ts: number[], per: number, calls: string[] = [], name = '') => async (cursor?: string) => {
  calls.push(`${name}${cursor ?? ''}`)
  const at = Number(cursor || 0)
  const items = ts.slice(at, at + per).map((t) => ({ ts: t, v: `${name}${t}` }))
  return { items, cursor: at + per < ts.length ? String(at + per) : null }
}

test('the merge goes newest first across streams, page by page, and asks each stream only as far as it needs', async () => {
  const calls: string[] = []
  const next = L.merger([stream([90, 70, 50, 10], 2, calls, 'a'), stream([80, 60, 20], 2, calls, 'b'), stream([], 2, calls, 'c')])
  assert.deepEqual(await next(3), { items: ['a90', 'b80', 'a70'], more: true, skipped: [] })
  assert.deepEqual(calls, ['a', 'b', 'c'], 'every stream once, before the first entry')
  assert.deepEqual(await next(3), { items: ['b60', 'a50', 'b20'], more: true, skipped: [] })
  assert.deepEqual(calls, ['a', 'b', 'c', 'a2', 'b2'])
  assert.deepEqual(await next(3), { items: ['a10'], more: false, skipped: [] })
  assert.deepEqual(await next(3), { items: [], more: false, skipped: [] })
})

test('a request that fails once is asked again; an account that keeps failing is left out while the rest go on', async () => {
  let fails = 1
  const blip = async (cursor?: string) => {
    if (cursor && fails-- > 0) throw new TypeError('fetch failed')
    return cursor ? { items: [{ ts: 40, v: 'b40' }], cursor: null } : { items: [{ ts: 95, v: 'b95' }], cursor: '1' }
  }
  assert.deepEqual(await L.merger([stream([90, 50, 30], 3), blip], undefined, 0)(10), { items: ['b95', '90', '50', 'b40', '30'], more: false, skipped: [] })
  const broken = async (cursor?: string) => {
    if (cursor) throw Object.assign(new Error('Failed to get user casts'), { status: 500 })
    return { items: [{ ts: 95, v: 'b95' }], cursor: '1' }
  }
  // a rate limit is a failure like any other, not "nothing there"
  const limited = async () => {
    throw Object.assign(new Error('slow down'), { status: 429 })
  }
  assert.deepEqual(await L.merger([stream([90, 50, 30], 1), broken, limited], undefined, 0)(10), { items: ['b95', '90', '50', '30'], more: false, skipped: [2, 1] })
})

// one entry, then HTTP 500 for good
const breaks = (v: string, ts: number) => async (cursor?: string) => {
  if (cursor) throw Object.assign(new Error('Failed'), { status: 500 })
  return { items: [{ ts, v }], cursor: '1' }
}
// reads every page; `retries` is how many may fail (a Retry), as the last account still failing at the feed's end does
const pages = async (next: (n: number) => Promise<{ items: string[]; more: boolean; skipped: number[] }>, n: number, retries = 0) => {
  const got: string[] = []
  for (let k = 0; k < 20; k++) {
    const r = await next(n).catch((e) => {
      if (retries-- <= 0) throw e
      return { items: [] as string[], more: true, skipped: [] as number[] }
    })
    got.push(...r.items)
    if (!r.more) return { got, skipped: r.skipped }
  }
  throw new Error('no end')
}

test('an account that keeps failing is left out wherever it is in the list, whichever of its streams fails first', async () => {
  const xs = Array.from({ length: 30 }, (_, i) => 1000 - i * 10)
  const want = ['x1000', 'Y-c', 'Y-r', ...xs.slice(1).map((t) => `x${t}`)]
  const by = (i: number) => i >> 1
  // its casts and recasts both stop answering; its other stream can't tell whether the network is up
  for (const first of [true, false]) {
    const y = [breaks('Y-c', 995), breaks('Y-r', 993)]
    const x = [stream(xs, 5, [], 'x'), stream([], 5, [], 'xr')]
    const r = await pages(L.merger(first ? [...y, ...x] : [...x, ...y], undefined, 0, by), 4)
    assert.deepEqual(r.got, want)
    assert.deepEqual(r.skipped.sort(), first ? [0, 1] : [2, 3])
  }
})

test('at the end of the feed an account whose streams all fail is left out after one more page, listed first or last', async () => {
  const by = (i: number) => i >> 1
  for (const first of [true, false]) {
    const y = [breaks('Y-c', 5), breaks('Y-r', 4)]
    const x = [stream([90, 50], 5, [], 'x'), stream([], 5, [], 'xr')]
    const next = L.merger(first ? [...y, ...x] : [...x, ...y], undefined, 0, by)
    const r = await pages(next, 10)
    assert.deepEqual(r.got, ['x90', 'x50', 'Y-c', 'Y-r'])
    assert.deepEqual(r.skipped.sort(), first ? [0, 1] : [2, 3])
  }
})

test('an account still failing, on a second page, once all the others have ended is left out, so what they hold goes out', async () => {
  const broken = async (cursor?: string) => {
    if (cursor) throw new TypeError('fetch failed')
    return { items: [{ ts: 99, v: 'b99' }], cursor: '1' }
  }
  const next = L.merger([stream([90, 50], 2), broken], undefined, 0)
  // first it could be the network: the page stops, for one more try
  assert.deepEqual(await next(10), { items: ['b99'], more: true, skipped: [] })
  assert.deepEqual(await next(10), { items: ['90', '50'], more: false, skipped: [1] })
})

test("two broken accounts, one listed first and one last, are both left out: each one's errors prove the node up for the other", async () => {
  const by = (i: number) => i >> 1
  const xs = Array.from({ length: 12 }, (_, i) => 100 - i * 8)
  const r = await pages(L.merger([breaks('Y-c', 99), breaks('Y-r', 97), stream(xs, 3, [], 'x'), stream([], 3, [], 'xr'), breaks('Z-c', 95), breaks('Z-r', 6)], undefined, 0, by), 4, 1)
  assert.deepEqual(r.got, ['x100', 'Y-c', 'Y-r', 'Z-c', 'x92', 'x84', 'x76', 'x68', 'x60', 'x52', 'x44', 'x36', 'x28', 'x20', 'x12', 'Z-r'])
  assert.deepEqual(r.skipped.sort(), [0, 1, 4, 5])
  // the same with only broken accounts and one that has ended: what they hold still goes out
  const ended = [stream([99, 1], 5, [], 'c'), stream([], 5, [], 'cr')]
  const s = await pages(L.merger([breaks('A', 100), breaks('Ar', 95), breaks('B', 90), breaks('Br', 85), ...ended], undefined, 0, by), 10, 1)
  assert.deepEqual(s.got, ['A', 'c99', 'Ar', 'B', 'Br', 'c1'])
  assert.deepEqual(s.skipped.sort(), [0, 1, 2, 3])
})

test('a node that answers everything with a gateway error or a rate limit is down, not up: no one is left out', async () => {
  for (const status of [429, 502, 503, 504, 522]) {
    let down = true
    const s = (v: string, ts: number) => async (cursor?: string) => {
      if (cursor && down) throw Object.assign(new Error(String(status)), { status })
      return { items: cursor ? [] : [{ ts, v }], cursor: cursor ? null : '1' }
    }
    const next = L.merger([s('a', 100), s('ar', 90), s('b', 95), s('br', 85)], undefined, 0, (i) => i >> 1)
    assert.deepEqual(await next(1), { items: ['a'], more: true, skipped: [] })
    for (let k = 0; k < 3; k++) await assert.rejects(next(10), new RegExp(String(status)))
    down = false
    assert.deepEqual(await next(10), { items: ['b', 'ar', 'br'], more: false, skipped: [] })
  }
})

test('a read-ahead the node has nothing for (404) ends that stream and keeps what it holds', async () => {
  const gone = async (cursor?: string) => {
    if (cursor) throw Object.assign(new Error('Not found'), { status: 404 })
    return { items: [{ ts: 100, v: 'a100' }, { ts: 1, v: 'a1' }], cursor: '1' }
  }
  const r = await pages(L.merger([gone, stream([], 5), breaks('b50', 50), stream([], 5)], undefined, 0, (i) => i >> 1), 10)
  assert.deepEqual(r.got, ['a100', 'b50', 'a1'])
  assert.deepEqual(r.skipped, [2])
})

test('when no account answers (the node is down) the page fails, and Retry carries on once it is back', async () => {
  let down = true
  const s = (ts: number) => async () => {
    if (down) throw new TypeError('fetch failed')
    return { items: [{ ts, v: String(ts) }], cursor: null }
  }
  const next = L.merger([s(1), s(2)], undefined, 0)
  await assert.rejects(next(10), /fetch failed/)
  await assert.rejects(next(10), /fetch failed/)
  down = false
  assert.deepEqual(await next(10), { items: ['2', '1'], more: false, skipped: [] })
})

test('a blip after the first page leaves no account out: the page stops, and the next one carries on', async () => {
  let offline = false
  const net = (f: L.Source<string>): L.Source<string> => async (c) => {
    if (offline) throw new TypeError('fetch failed')
    return f(c)
  }
  const ts = (k: number) => Array.from({ length: 10 }, (_, i) => 100 - i * 3 - k)
  const next = L.merger([net(stream(ts(0), 2, [], 'a')), net(stream(ts(1), 2, [], 'b')), net(stream(ts(2), 2, [], 'c'))], undefined, 0)
  const first = await next(4)
  assert.equal(first.items.length, 4)
  offline = true
  // what's buffered goes out until a refill is due; then nothing more is certain, and the page fails for Retry
  const cut = await next(30).catch(() => ({ items: [] as string[], more: true, skipped: [] as number[] }))
  assert.deepEqual(cut.skipped, [], 'nobody answered meanwhile, so nobody is left out')
  offline = false
  const rest = await next(30)
  assert.deepEqual(rest.skipped, [])
  assert.equal(new Set([...first.items, ...cut.items, ...rest.items]).size, 30, 'every entry, once')
  assert.equal(first.items.length + cut.items.length + rest.items.length, 30)
  assert.equal(rest.more, false)
})

test('progress counts the streams that have answered while the first page waits', async () => {
  const seen: string[] = []
  const later = (f: L.Source<string>, ms: number): L.Source<string> => async (c) => (await new Promise((r) => setTimeout(r, ms)), f(c))
  await L.merger([later(stream([3], 1), 30), later(stream([2], 1), 1), later(stream([], 1), 15)], (d, all) => seen.push(`${d}/${all}`))(5)
  assert.deepEqual(seen, ['1/3', '2/3', '3/3'])
})

test('within gives up on a request that hangs', async () => {
  await assert.rejects(L.within(new Promise(() => {}), 20), (e: any) => e.message === 'Network error' && e.timeout === true)
  assert.equal(await L.within(Promise.resolve(7), 1000), 7)
})

test('an account the node has nothing for (400) just ends; empty pages that go on are read past, five at most', async () => {
  const gone = async () => {
    throw Object.assign(new Error('no such fid'), { status: 400 })
  }
  let asked = 0
  const empties = async (cursor?: string) => (asked++, { items: Number(cursor || 0) === 2 ? [{ ts: 5, v: 'late' }] : [], cursor: String(Number(cursor || 0) + 1) })
  assert.deepEqual(await L.merger([stream([9], 1), gone])(5), { items: ['9'], more: false, skipped: [] })
  // two empty pages, then an entry, then empties until five in a row end it
  assert.deepEqual(await L.merger([empties])(5), { items: ['late'], more: false, skipped: [] })
  assert.equal(asked, 3 + 5)
})

test('each account gives its casts and its recasts, read with the casts they recast, by recast time', async () => {
  const asked: string[] = []
  const T = (iso: string) => Date.parse(iso)
  const get = async (path: string, q: Record<string, any>) => {
    asked.push(`${path}?${new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined))}`)
    if (path === '/v2/farcaster/feed/user/casts') return { casts: [{ hash: 'c1', timestamp: '2026-11-06T10:00:00.000Z' }], next: { cursor: null } }
    if (path === '/v1/reactionsByFid')
      return {
        messages: [
          { data: { timestamp: (T('2026-11-06T12:00:00Z') / 1000) - L.FC_EPOCH, reactionBody: { targetCastId: { fid: 9, hash: '0xAB' } } } },
          { data: { timestamp: (T('2026-11-06T11:00:00Z') / 1000) - L.FC_EPOCH, reactionBody: { targetCastId: { fid: 9, hash: '0xdead' } } } },
        ],
        nextPageToken: '',
      }
    if (path === '/v2/farcaster/casts') return { casts: [{ hash: 'ab', timestamp: '2026-11-01T00:00:00.000Z' }] }
    throw new Error(path)
  }
  const next = L.merger(L.localSources<{ hash: string; timestamp: string; recaster?: unknown }>([{ fid: 7, username: 'seven' }], get, (l) => ({ fid: l.fid, username: l.username }), 10))
  const r = await next(10)
  assert.deepEqual(r.items.map((c) => c.hash), ['ab', 'c1'], 'the recast by when it was recast; one of a deleted cast is left out')
  assert.deepEqual(r.items[0].recaster, { fid: 7, username: 'seven' })
  assert.equal(r.items[1].recaster, undefined)
  assert.equal(r.more, false)
  assert.deepEqual(asked, ['/v2/farcaster/feed/user/casts?fid=7&limit=25', '/v1/reactionsByFid?fid=7&reaction_type=Recast&pageSize=10&reverse=true', '/v2/farcaster/casts?casts=ab%2Cdead'])
})

test('signed out, isFollowing and amFollowing read the device list, and mutes stay on the device', async () => {
  store.clear()
  let fetched = 0
  ;(globalThis as any).fetch = async () => (fetched++, new Response('{}'))
  const api = await import('./api.ts')
  const mutes = await import('./mutes.ts')
  L.setLocal({ fid: 11 }, true)
  assert.equal(await api.isFollowing(11), true)
  assert.equal(await api.isFollowing(12), false)
  assert.equal(await api.amFollowing(12), false)
  L.setLocal({ fid: 12 }, true)
  assert.equal(await api.amFollowing(12), true, 'a follow just tapped counts at once')
  await mutes.setMute('blocks', 12)
  assert.ok(mutes.blockOf(12))
  assert.ok(store.has('quilcast:mutes:local'))
  assert.equal(fetched, 0, 'nothing asked the node or our server')
})

test("signing in switches to the account's own mutes, and signing out back to the device's", async () => {
  const api = await import('./api.ts')
  const mutes = await import('./mutes.ts')
  assert.ok(mutes.blockOf(12), 'the anonymous block from before')
  store.set('quilcast:mutes:7', JSON.stringify({ words: [], users: [{ v: 5 }], blocks: [] }))
  await api.setAccount({ phrase: '', custody: '0x7', fid: 7, done: true })
  assert.ok(!mutes.blockOf(12), "the device's list stays behind")
  assert.ok(mutes.muteOf(5), "the account's own list is in use")
  await api.setAccount(null)
  assert.ok(mutes.blockOf(12) && !mutes.muteOf(5))
})

test('signed in, the offer to follow the list comes back once the list holds someone it was not answered for', () => {
  store.clear()
  L.setLocal({ fid: 2 }, true)
  L.setLocal({ fid: 3 }, true)
  assert.ok(L.toOffer(1), 'first sign-in: offered')
  L.answered(1)
  assert.ok(!L.toOffer(1), '"Not now": not offered again for the same list')
  assert.ok(L.toOffer(5), 'another account is offered on its own')
  L.setLocal({ fid: 3 }, false)
  assert.ok(!L.toOffer(1), 'an unfollow adds no one new')
  L.setLocal({ fid: 4 }, true)
  assert.ok(L.toOffer(1), 'signed out and followed someone new: offered again')
  // accepted: the follows went out and left the list, except 4, which failed
  L.removeLocal([2])
  L.answered(1)
  assert.ok(!L.toOffer(1), 'a failure stays on the list without being offered again')
  L.removeLocal([4])
  L.setLocal({ fid: 2 }, true)
  assert.ok(L.toOffer(1), 'someone followed on-chain earlier and then on the device again is offered again')
  store.set('quilcast:local-follows:asked:1', '1')
  assert.ok(L.toOffer(1), 'an older "1" answer reads as nothing answered')
})

test('a first page saved after an unfollow drops the casts and recasts of whoever left the list', () => {
  store.clear()
  L.setLocal({ fid: 2 }, true)
  L.setLocal({ fid: 3 }, true)
  const page = [
    { hash: 'a', author: { fid: 2 } },
    { hash: 'b', author: { fid: 3 } },
    { hash: 'c', author: { fid: 9 }, recaster: { fid: 3 } },
    { hash: 'd', author: { fid: 3 }, recaster: { fid: 2 } },
  ]
  // the load started with both on the list; 3 was unfollowed before it ended
  L.setLocal({ fid: 3 }, false)
  assert.deepEqual(L.stillFollowed(page).map((c) => c.hash), ['a', 'd'])
})
