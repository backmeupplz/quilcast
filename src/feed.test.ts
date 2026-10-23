// Home shows each post once, across pages too (issue #9: a post came back when a second friend replied).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { oncePerFeed } from './shared.ts'

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
