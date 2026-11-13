import assert from 'node:assert/strict'
import { test } from 'node:test'
import { body, clip, describe } from './profile.mjs'

test('descriptions stay within 160 characters and end on a whole word', () => {
  assert.equal(clip('one two three', 9), 'one two…')
  assert.equal(clip('short', 9), 'short')
  const bio = 'Building things on Farcaster and elsewhere, mostly small tools that people actually use every single day of the week '.repeat(2)
  const d = describe({ fid: 3, username: 'dwr', follower_count: 1221570, profile: { bio: { text: bio } } })
  assert.ok(d.length <= 160, d)
  assert.match(d, /\w… 1\.2M followers on Farcaster\. Read @dwr's latest casts on Quilcast\.$/)
  assert.equal(describe({ fid: 9, username: 'ann', display_name: 'Ann', follower_count: 1 }), "Ann has 1 follower on Farcaster. Read @ann's latest casts on Quilcast.")
})

// #643: a Farcaster Article's first cast reads as its title and opening; its later parts aren't listed on their own
test("a profile's article shows its title and opening, and its parts stay in it", () => {
  const u = { fid: 3, username: 'ada', display_name: 'Ada', follower_count: 1 }
  const chain = (index) => ({ format: 1, chain: index ? { root: { fid: 3, hash: 'a1'.repeat(20) }, index, count: 2 } : { index: 0, count: 2 } })
  const html = body(u, [
    { hash: 'a1'.repeat(20), text: 'My <trip>\n\n## Day one\nWe **left**.', timestamp: '2026-11-13T00:00:00Z', article: chain(0) },
    { hash: 'a2'.repeat(20), parent_hash: 'a1'.repeat(20), text: 'the second part', timestamp: '2026-11-13T00:00:01Z', article: chain(1) },
    { hash: 'a3'.repeat(20), text: 'just a cast', timestamp: '2026-11-12T00:00:00Z', article: null },
  ])
  assert.match(html, /<p class="text"><b>My &#60;trip&#62;<\/b>\nDay one\nWe left\.<\/p>/)
  assert.ok(!html.includes('the second part'))
  assert.ok(html.includes('<p class="text">just a cast</p>'))
})
