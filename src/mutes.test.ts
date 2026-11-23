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

test("muted words hide a cast that links a muted site or quotes a cast with one, not one quoting the account's own (#832)", async () => {
  Object.assign(globalThis, { addEventListener: () => {}, dispatchEvent: () => true })
  ;(globalThis as any).localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} }
  const api = await import('./api.ts')
  const { hides, setMute } = await import('./mutes.ts')
  // signed in (fid 5) without a finished account, so the mute stays on this device
  await Promise.resolve(api.setAccount({ wallet: '0xabc', fid: 5 } as any)).catch(() => {})
  await setMute('words', 'spam.site')
  await setMute('words', 'bees')
  const h = (x: string) => x.repeat(20)
  const cast = (fid: number, hash: string, embeds: any[] = [], text = 'look') => ({ hash: `0x${hash}`, text, embeds, author: { fid } }) as any
  api.got.set(`c:${h('d1')}`, cast(60, h('d1'), [], 'all about bees'))
  api.got.set(`c:${h('d2')}`, cast(61, h('d2'), [{ url: 'https://www.spam.site/x' }]))
  api.got.set(`c:${h('d4')}`, cast(5, h('d4'), [], 'my bees'))
  assert.equal(hides(cast(50, h('e1'), [{ url: 'https://spam.site/win?ref=1' }])), true, "a link embed's site")
  assert.equal(hides(cast(51, h('e2'), [{ cast_id: { fid: 60, hash: `0x${h('D1')}` } }])), true, "a quoted cast's text")
  assert.equal(hides(cast(52, h('e3'), [{ cast_id: { fid: 61, hash: h('d2') } }])), true, "a quoted cast's link")
  assert.equal(hides(cast(53, h('e4'), [{ cast_id: { fid: 5, hash: h('d4') } }])), false, "the account's own cast, quoted")
  assert.equal(hides(cast(54, h('e5'), [{ url: 'https://spam.site/pic.png' }, { cast_id: { fid: 62, hash: h('d3') } }])), false, "a picture's address, a quote not loaded")
  assert.equal(hides(cast(55, h('e6'), [{ url: 'https://example.com/spam.site' }])), false, "only the site, not the rest of the address")
  await setMute('words', 'spam.site', false)
  await setMute('words', 'bees', false)
})
