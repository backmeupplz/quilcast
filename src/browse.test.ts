// "Browse as" (#490): the ?as= link, the recently browsed list, and whose follows decide a Following feed's replies.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { asOf, browsePath, recentsOf, remember, repliesFit, RECENTS } from './browse.ts'

test('?as= takes a FID or a username, and nothing else', () => {
  assert.equal(asOf('?as=dwr'), 'dwr')
  assert.equal(asOf('?as=%40Vitalik.eth'), 'vitalik.eth')
  assert.equal(asOf('?x=1&as=3'), '3')
  for (const s of ['', '?as=', '?as=a%20b', '?as=../x', '?as=<b>', '?as=' + 'a'.repeat(65)]) assert.equal(asOf(s), null, s)
})

test('a browse link goes by username, or by FID for a nameless account', () => {
  assert.equal(browsePath({ fid: 3, username: 'DWR' }), '/?as=dwr')
  assert.equal(browsePath({ fid: 9, username: 'fid:9' }), '/?as=9')
  assert.equal(browsePath({ fid: 9 }), '/?as=9')
  // an all-digit fname would read back as a FID, so it goes by its own FID
  assert.equal(browsePath({ fid: 77, username: '12345' }), '/?as=77')
  assert.equal(browsePath({ fid: 78, username: 'a1' }), '/?as=a1')
  for (const u of [{ fid: 3, username: 'dwr' }, { fid: 9 }]) assert.ok(asOf(browsePath(u).slice(1)))
})

test('the recently browsed list puts the newest first, once each, and stays short', () => {
  let list = remember(null, { fid: 1, username: 'a', follower_count: 5 })
  assert.deepEqual(list, [{ fid: 1, username: 'a', display_name: undefined, pfp_url: undefined }])
  for (let f = 2; f <= 8; f++) list = remember(list, { fid: f })
  list = remember(list, { fid: 5, username: 'e' })
  assert.deepEqual(list.map((r) => r.fid), [5, 8, 7, 6, 4])
  assert.equal(list.length, RECENTS)
  assert.deepEqual(recentsOf('junk'), [])
  assert.deepEqual(recentsOf([null, { fid: 'x' }, { fid: 0 }, { fid: 2 }]), [{ fid: 2 }])
})

test("a reply shows in a Following feed when that feed's owner follows who it replies to", async () => {
  const asked: [number, number][] = []
  const follows = async (to: number, viewer: number) => (asked.push([to, viewer]), viewer === 7 && to === 20)
  // your own feed: the node's word (viewer_context, about you) is enough
  assert.equal(await repliesFit(20, 1, 1, true, follows), true)
  assert.equal(await repliesFit(20, 1, 1, false, follows), false)
  assert.deepEqual(asked, [])
  // a reply to yourself
  assert.equal(await repliesFit(1, 1, 1, undefined, follows), true)
  // browsing as 7: the node's word is about the signed-in user (1), so 7's follows are asked instead
  assert.equal(await repliesFit(20, 7, 1, false, follows), true)
  assert.equal(await repliesFit(21, 7, 1, true, follows), false)
  assert.equal(await repliesFit(7, 7, 1, false, follows), true)
  // signed out, browsing as 7
  assert.equal(await repliesFit(20, 7, undefined, undefined, follows), true)
  assert.deepEqual(asked, [[20, 7], [21, 7], [20, 7]])
  // no one's feed
  assert.equal(await repliesFit(20, undefined, undefined, true, follows), false)
})
