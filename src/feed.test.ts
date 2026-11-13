// Home shows each post once, across pages too (issue #9: a post came back when a second friend replied).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { newOnTop, oncePerFeed, shownFor } from './shared.ts'

test('a post shows once per feed, across pages', () => {
  const shown = new Set<string>()
  // page 1: Nounish Prof's reply to justin's reply to justin's egg post
  const page1 = oncePerFeed([{ hash: 'prof', up: [{ hash: 'egg' }, { hash: 'eat' }], gap: false }], shown)
  assert.deepEqual(page1.map((c) => c.hash), ['prof'])
  // page 2: the egg post itself, another reply to "eat", and a reply to the egg post's other branch
  const page2 = oncePerFeed([
    { hash: 'egg' },
    { hash: 'kyle', up: [{ hash: 'egg' }, { hash: 'eat' }], gap: false },
    { hash: 'wake', up: [{ hash: 'egg' }, { hash: 'omelet' }], gap: false },
    null,
    { hash: 'new' },
  ], shown)
  assert.deepEqual(page2, [{ hash: 'wake', up: [{ hash: 'omelet' }], gap: true }, { hash: 'new' }])
})

test("a slow load for the feed's previous key never resets or fills the current key's set (#490)", () => {
  const held = { k: 'a', set: new Set<string>() }
  // key a's first page starts, then the feed moves to key b and its first page starts and ends
  const oldFirst = shownFor(held, 'a', true)
  const b1 = shownFor(held, 'b', true)
  oncePerFeed([{ hash: 'x' }], b1)
  // a's first page ends late, and a page 2 for a that was in flight too
  oncePerFeed([{ hash: 'y' }, { hash: 'z' }], oldFirst)
  oncePerFeed([{ hash: 'w' }], shownFor(held, 'a', false))
  // b's page 2 still has b's set: x stays out, the old feed's posts come through
  const b2 = shownFor(held, 'b', false)
  assert.equal(b2, b1)
  assert.deepEqual(oncePerFeed([{ hash: 'x' }, { hash: 'y' }, { hash: 'w' }], b2).map((c) => c.hash), ['y', 'w'])
  // a reload of the same key starts over
  assert.notEqual(shownFor(held, 'b', true), b1)
})

// #640: a feed read again in the background says what's new on top of it
const c = (hash: string, timestamp = '2026-11-12T00:00:00Z', up?: { hash: string }[]) => ({ hash, timestamp, up })
test('the casts above the top of the list are new, without the ones it shows already', () => {
  const have = [c('d'), c('e', undefined, [c('root')]), c('g'), c('h'), c('i'), c('f')]
  // a new cast, a recast of one shown further down and a reply's root from the list, then the list's top
  const r = newOnTop(have, [c('a'), c('f'), c('root'), c('b'), c('d'), c('e')])
  assert.deepEqual(r, { items: [c('a'), c('b')], gap: false })
  // nothing new
  assert.deepEqual(newOnTop(have, [c('d'), c('e'), c('f')]), { items: [], gap: false })
  // the top cast was deleted: the next one still marks where the new ones end
  assert.deepEqual(newOnTop(have, [c('x'), c('e'), c('f')]).items.map((x) => x.hash), ['x'])
})

test('a fresh recast of one of the top casts does not hide the new casts below it', () => {
  const have = [c('a'), c('b'), c('d')]
  const r = newOnTop(have, [{ ...c('b'), recaster: { fid: 9 } }, c('c'), c('a'), c('b'), c('d')])
  assert.deepEqual(r.items.map((x) => x.hash), ['c'])
  assert.equal(r.gap, false)
  // a recast already at the top of the list still marks where the new ones end
  const rt = { ...c('b'), recaster: { fid: 9 } }
  assert.deepEqual(newOnTop([rt, c('a')], [c('x'), rt, c('a')]), { items: [c('x')], gap: false })
})

test("a page that has none of the list's top casts takes its place", () => {
  assert.deepEqual(newOnTop([c('d')], [c('a'), c('b')]), { items: [c('a'), c('b')], gap: true })
  assert.deepEqual(newOnTop([], [c('a')]), { items: [c('a')], gap: true })
  assert.deepEqual(newOnTop([c('d')], []), { items: [], gap: true })
})

test("Trending's new casts are the ones posted after the newest it shows, wherever they rank", () => {
  const have = [c('old', '2026-11-12T10:00:00Z'), c('newest', '2026-11-12T11:00:00Z')]
  const page = [c('old', '2026-11-12T10:00:00Z'), c('risen', '2026-11-12T09:00:00Z'), c('fresh', '2026-11-12T12:00:00Z'), c('newest', '2026-11-12T11:00:00Z')]
  assert.deepEqual(newOnTop(have, page, true), { items: [c('fresh', '2026-11-12T12:00:00Z')], gap: false })
})
