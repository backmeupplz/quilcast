import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isSaved, shareHome } from './appsaved.ts'

const action = (hash: string) => `https://tip.quilcast.com/?castHash=${hash}&castFid=3&viewerFid=7`

test("a cast action is saved at the manifest's home, not at the cast it was opened on", () => {
  assert.equal(shareHome(action('0xaa'), 'https://tip.quilcast.com/home'), 'https://tip.quilcast.com/home')
})

test('without a usable homeUrl, the castShareUrl is saved without the cast', () => {
  assert.equal(shareHome(action('0xaa')), 'https://tip.quilcast.com/')
  assert.equal(shareHome('https://a.xyz/share?x=1&castHash=0xaa&castFid=3', 'https://evil.xyz/'), 'https://a.xyz/share?x=1')
  assert.equal(shareHome(action('0xaa'), 'http://tip.quilcast.com/'), 'https://tip.quilcast.com/')
  assert.equal(shareHome(action('0xaa'), 'not a url'), 'https://tip.quilcast.com/')
})

test('the same cast action on another cast is already saved, so it gets one entry', () => {
  const saved = [{ url: shareHome(action('0xaa')) }]
  assert.ok(isSaved(saved, { url: action('0xbb'), origin: 'https://tip.quilcast.com', share: true }))
  assert.ok(!isSaved(saved, { url: 'https://spamcheck.quilcast.com/?castHash=0xbb', origin: 'https://spamcheck.quilcast.com', share: true }))
})

test('a cast action added from its home before counts as saved; other apps still match by address', () => {
  const saved = [{ url: 'https://tip.quilcast.com/home' }, { url: 'bad' }]
  assert.ok(isSaved(saved, { url: action('0xcc'), origin: 'https://tip.quilcast.com', share: true }))
  assert.ok(isSaved(saved, { url: 'https://tip.quilcast.com/home', origin: 'https://tip.quilcast.com' }))
  assert.ok(!isSaved(saved, { url: 'https://tip.quilcast.com/other', origin: 'https://tip.quilcast.com' }))
})

test('a composer action is saved once, at its home, and known by its origin', () => {
  const saved = [{ url: shareHome('https://poll.example.com/compose', 'https://poll.example.com/') }]
  assert.ok(isSaved(saved, { url: 'https://poll.example.com/compose', origin: 'https://poll.example.com', draft: {} }))
  assert.ok(!isSaved(saved, { url: 'https://poll.example.com/compose', origin: 'https://poll.example.com' }))
})

test('a one-click action is https on the asking app\'s own origin, with a short name and placeholder', async () => {
  const { oneClick, oneClickPayload } = await import('./appsaved.ts')
  const o = 'https://remind.example.com'
  assert.deepEqual(oneClick({ name: '  Remind me   in 1 day ', url: `${o}/api/action?in=1d` }, o), { url: `${o}/api/action?in=1d`, name: 'Remind me in 1 day' })
  assert.deepEqual(oneClick({ name: 'Remind me in…', url: `${o}/a`, placeholder: '1 week' }, o), { url: `${o}/a`, name: 'Remind me in…', placeholder: '1 week' })
  for (const bad of [
    { name: 'x', url: 'https://evil.example.com/a' }, { name: 'x', url: 'http://remind.example.com/a' }, { name: 'x', url: '/a' },
    { name: '', url: `${o}/a` }, { name: 'x'.repeat(31), url: `${o}/a` }, { name: 'x', url: `${o}/a`, placeholder: 'y'.repeat(41) },
    { name: 'x', url: `${o}/a`, placeholder: 5 }, { name: 5, url: `${o}/a` }, null,
  ]) assert.equal(oneClick(bad, o), null, JSON.stringify(bad))
  assert.deepEqual(oneClickPayload(`${o}/a`, { hash: 'ab'.repeat(20), fid: 3 }, '1 week', undefined, 7), { type: 'cast_action', url: `${o}/a`, cast: { hash: '0x' + 'ab'.repeat(20), fid: 3 }, input: '1 week', timestamp: 7 })
})
