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

test('Settings → Train casts → Hide takes other people\'s trains and their cars out, never your own', async () => {
  Object.assign(globalThis, { addEventListener: () => {}, dispatchEvent: () => true })
  ;(globalThis as any).localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} }
  const api = await import('./api.ts')
  const { hides, hidesTrain } = await import('./mutes.ts')
  const { TRAIN } = await import('./shared.ts')
  const cast = (fid: number, embeds: { url?: string }[] = []) => ({ hash: `0x${fid}`, text: 'all aboard', embeds, author: { fid } }) as any
  const train = cast(5, [{ url: TRAIN }]), car = cast(6, [{ url: 'https://example.com/x' }, { url: TRAIN }]), plain = cast(7, [{ url: 'https://quilcast.com/trainspotting' }])
  assert.equal(hides(train), false, 'Show is the default')
  api.settings.trains = 'hide'
  assert.equal(hidesTrain(train), true)
  assert.equal(hides(train), true)
  assert.equal(hides(car), true, 'a car is a train cast too')
  assert.equal(hides(plain), false, 'only the train embed itself counts')
  assert.equal(hides(train, 5), false, "on the train's author's own profile it still shows, as their spam does")
  // signed in as the train's author: your own trains always show
  await Promise.resolve(api.setAccount({ wallet: '0xabc', fid: 5, done: true } as any)).catch(() => {})
  assert.equal(api.account?.fid, 5)
  assert.equal(hides(train), false, "the account's own trains always show")
  assert.equal(hides(car), true)
  api.settings.trains = 'show'
  assert.equal(hides(car), false)
})
