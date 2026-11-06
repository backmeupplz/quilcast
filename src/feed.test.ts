// Home shows each post once, across pages too (issue #9: a post came back when a second friend replied).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { oncePerFeed, shownFor } from './shared.ts'

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
