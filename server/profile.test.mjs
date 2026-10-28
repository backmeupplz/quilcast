import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clip, describe } from './profile.mjs'

test('descriptions stay within 160 characters and end on a whole word', () => {
  assert.equal(clip('one two three', 9), 'one two…')
  assert.equal(clip('short', 9), 'short')
  const bio = 'Building things on Farcaster and elsewhere, mostly small tools that people actually use every single day of the week '.repeat(2)
  const d = describe({ fid: 3, username: 'dwr', follower_count: 1221570, profile: { bio: { text: bio } } })
  assert.ok(d.length <= 160, d)
  assert.match(d, /\w… 1\.2M followers on Farcaster\. Read @dwr's latest casts on Quilcast\.$/)
  assert.equal(describe({ fid: 9, username: 'ann', display_name: 'Ann', follower_count: 1 }), "Ann has 1 follower on Farcaster. Read @ann's latest casts on Quilcast.")
})
