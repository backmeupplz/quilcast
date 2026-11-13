import assert from 'node:assert/strict'
import { test } from 'node:test'
import { score, searchPage, sortOf, sortParam, TOP } from './searchsort.ts'

// a fake node: `n` matches, newest first (cast i is newer than i+1); its search answers bare casts with every count 0
// (like haatz), and only /v2/farcaster/casts has the counts, likes(i) of them. The cursor is an offset.
function node(n: number, likes: (i: number) => number, opts: { failBulk?: boolean; missing?: Set<number>; failFrom?: number } = {}) {
  const hash = (i: number) => '0x' + i.toString(16).padStart(40, '0')
  const asked: { path: string; q: Record<string, any> }[] = []
  const bare = (i: number) => ({ hash: hash(i), text: `cast ${i}`, author: { fid: 1 }, reactions: { likes_count: 0, recasts_count: 0 }, replies: { count: 0 } })
  const get = async (path: string, q: Record<string, any>) => {
    asked.push({ path, q })
    if (path === '/v2/farcaster/cast/search') {
      const from = q.cursor ? +q.cursor : 0
      if (opts.failFrom != null && from >= opts.failFrom) throw new Error('HTTP 503')
      const to = Math.min(n, from + Math.min(q.limit, 100))
      const casts = []
      // relevance is some other order: oldest first here, so the test can tell
      for (let i = from; i < to; i++) casts.push(bare(q.sort_type === 'algorithmic' ? n - 1 - i : i))
      return { result: { casts, next: { cursor: to < n ? String(to) : null } } }
    }
    assert.equal(path, '/v2/farcaster/casts')
    if (opts.failBulk) throw new Error('HTTP 503')
    const hs: string[] = q.casts.split(',')
    assert.ok(hs.length <= 50)
    // answered out of order, bare hex, without the missing ones
    const is = hs.map((h) => parseInt(h, 16)).filter((i) => !opts.missing?.has(i)).reverse()
    return { casts: is.map((i) => ({ ...bare(i), hash: i.toString(16).padStart(40, '0'), embeds: [{ url: 'x' }], reactions: { likes_count: likes(i), recasts_count: 0 }, replies: { count: 0 } })) }
  }
  return { get, asked }
}
const idx = (cs: { hash: string }[]) => cs.map((c) => parseInt(c.hash, 16))

test('sortOf: the URL\'s sort, else Recent for a #hashtag (#431) and Top for other words', () => {
  assert.equal(sortOf(null, 'gm'), 'top')
  assert.equal(sortOf('nonsense', 'gm'), 'top')
  assert.equal(sortOf(null, '#gm'), 'recent')
  assert.equal(sortOf(undefined, 'gm #farcaster'), 'recent')
  assert.equal(sortOf('nonsense', '#gm'), 'recent')
  assert.equal(sortOf('recent', 'gm'), 'recent')
  assert.equal(sortOf('relevance', 'gm'), 'relevance')
  assert.equal(sortOf('top', '#gm'), 'top')
  assert.equal(sortOf('relevance', '#gm'), 'relevance')
})

test('sortParam: ?s= only when the sort is not the term\'s default', () => {
  assert.equal(sortParam(null, 'gm'), undefined)
  assert.equal(sortParam('top', 'gm'), undefined)
  assert.equal(sortParam('recent', 'gm'), 'recent')
  assert.equal(sortParam(null, '#gm'), undefined)
  assert.equal(sortParam('recent', '#gm'), undefined)
  assert.equal(sortParam('top', '#gm'), 'top')
  assert.equal(sortParam('relevance', '#gm'), 'relevance')
})

test('score: likes, recasts twice, replies', () => {
  assert.equal(score({ reactions: { likes_count: 3, recasts_count: 2 }, replies: { count: 1 } } as any), 8)
  assert.equal(score({} as any), 0)
})

test('Recent and Relevance ask the node for their order and read each page in full', async () => {
  const { get, asked } = node(60, (i) => i)
  const r = await searchPage(get, 'gm', 'recent')
  assert.deepEqual(idx(r.casts), [...Array(25).keys()])
  assert.equal(r.next.cursor, '25')
  assert.equal(asked[0].q.sort_type, 'desc_chronological')
  assert.equal(r.casts[0].reactions.likes_count, 0, 'cast 0 has 0 likes')
  assert.equal(r.casts[1].reactions.likes_count, 1, 'counts come from the full read')
  assert.ok(r.casts.every((c) => c.embeds?.length), 'every cast read in full')
  const last = await searchPage(get, 'gm', 'recent', '50')
  assert.equal(last.casts.length, 10)
  assert.equal(last.next.cursor, null)
  const rel = await searchPage(get, 'gm', 'relevance')
  assert.equal(asked.at(-2)!.q.sort_type, 'algorithmic')
  assert.deepEqual(idx(rel.casts).slice(0, 2), [59, 58])
})

test('Top ranks the newest TOP matches by score, newer first between equals, and pages that list', async () => {
  // likes: every 7th cast is popular, more so the older it is; the rest have none
  const { get, asked } = node(1000, (i) => (i % 7 ? 0 : i))
  const pages = []
  let cursor: string | null | undefined
  do {
    const r = await searchPage(get, 'gm', 'top', cursor)
    pages.push(...r.casts)
    cursor = r.next.cursor
  } while (cursor)
  assert.equal(pages.length, TOP, 'only the newest TOP matches')
  const searches = asked.filter((a) => a.path === '/v2/farcaster/cast/search')
  assert.equal(searches.length, TOP / 100, 'read 100 at a time, once: later pages page the same list')
  assert.ok(searches.every((a) => a.q.sort_type === 'desc_chronological' && a.q.limit === 100))
  const popular = [...Array(TOP).keys()].filter((i) => i > 0 && i % 7 === 0).reverse()
  assert.deepEqual(idx(pages).slice(0, popular.length), popular, 'most liked first')
  const rest = idx(pages).slice(popular.length)
  assert.deepEqual(rest, [...rest].sort((a, b) => a - b), 'the unliked ones newest first')
  assert.equal(new Set(idx(pages)).size, TOP, 'no repeats')
})

test('Top with few matches, missing full reads and a failed full read', async () => {
  const few = node(30, (i) => i, { missing: new Set([29]) })
  const r = await searchPage(few.get, 'rare', 'top')
  assert.equal(r.casts.length, 25)
  assert.equal(r.next.cursor, '25')
  assert.deepEqual(idx(r.casts).slice(0, 3), [28, 27, 26], 'cast 29 (not read in full) keeps the search answer, 0 likes')
  const more = await searchPage(few.get, 'rare', 'top', r.next.cursor)
  assert.equal(more.casts.length, 5)
  assert.equal(more.next.cursor, null)
  assert.ok(idx(more.casts).includes(29))
  const down = node(10, (i) => i, { failBulk: true })
  const d = await searchPage(down.get, 'down', 'top')
  assert.deepEqual(idx(d.casts), [...Array(10).keys()], 'without counts, newest first')
  const none = await searchPage(node(0, () => 0).get, 'nothing', 'top')
  assert.deepEqual(none, { casts: [], next: { cursor: null } })
})

test('a new first page ranks again', async () => {
  let n = 0
  const { get } = node(5, (i) => (i === 4 ? n : 0))
  assert.equal(idx((await searchPage(get, 'again', 'top')).casts)[0], 0)
  n = 9
  // the fake node is not memoized, so a first page sees the new count
  assert.equal(idx((await searchPage(get, 'again', 'top')).casts)[0], 4)
})

test('Top: a later search page that fails ranks what came; a failed first page fails', async () => {
  const half = node(1000, (i) => (i === 150 ? 5 : 0), { failFrom: 200 })
  const r = await searchPage(half.get, 'half', 'top')
  assert.equal(idx(r.casts)[0], 150)
  let all = r.casts.length, cursor = r.next.cursor
  while (cursor) {
    const p = await searchPage(half.get, 'half', 'top', cursor)
    all += p.casts.length
    cursor = p.next.cursor
  }
  assert.equal(all, 200)
  await assert.rejects(searchPage(node(10, () => 0, { failFrom: 0 }).get, 'fails', 'top'))
})
