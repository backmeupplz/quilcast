// Muted words match whole words in any case (issue #11: mute $based for a week), and mutes run out.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cleanMutes, wordsRe } from './shared.ts'

test('muted words match whole words, any case', () => {
  const re = wordsRe(['$based', 'gm', 'c++', '比特币'])!
  for (const s of ['$BASED is trending', 'so $based.', 'GM frens', 'learning c++ today', '我买了比特币']) assert.ok(re.test(s), s)
  for (const s of ['$basedgod', 'based', 'gmail', 'dogma', 'c+']) assert.ok(!re.test(s), s)
  assert.equal(wordsRe([]), null)
})

test('mutes are cleaned, deduped and expire', () => {
  const now = 1000
  const m = cleanMutes({ words: [{ v: ' GM ' }, { v: 'gm', until: 5000 }, { v: 'old', until: 999 }, { v: 7 }], users: [{ v: 3, until: 2000 }, { v: -1 }, { v: 'x' }], blocks: [{ v: 9, until: 'soon' }], extra: 1 }, now)
  assert.deepEqual(m, { words: [{ v: 'gm', until: 5000 }], users: [{ v: 3, until: 2000 }], blocks: [{ v: 9 }] })
  assert.deepEqual(cleanMutes(null), { words: [], users: [], blocks: [] })
})
