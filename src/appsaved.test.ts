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
