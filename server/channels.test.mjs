import assert from 'node:assert/strict'
import test from 'node:test'
import { legacy, search, trim } from './channels.mjs'

test('the channel directory: bad entries dropped, search ranks the exact id first, old-style URLs mapped', () => {
  const list = trim([
    { id: 'memes', url: 'chain://eip155:1/erc721:0xfd8427165df67df6d7fd689ae67c8ebf56d9ca61', name: 'Memes', followerCount: 900, publicCasting: true },
    { id: 'memesters', url: 'https://warpcast.com/~/channel/memesters', name: 'Memesters', followerCount: 5000 },
    { id: 'art', url: 'https://farcaster.xyz/~/channel/art', name: 'Dank memes art', followerCount: 10, publicCasting: false, imageUrl: 'javascript:alert(1)' },
    { id: '../x', url: 'https://warpcast.com/~/channel/x', name: 'x' },
    { id: 'nourl' },
  ])
  assert.deepEqual(list.map((c) => c.id), ['memesters', 'memes', 'art'])
  assert.equal(list[2].open, false)
  assert.equal(list[2].image, undefined)
  assert.deepEqual(search(list, '/Memes', 10).map((c) => c.id), ['memes', 'memesters', 'art'])
  const map = legacy(list)
  assert.deepEqual(map, { 'chain://eip155:1/erc721:0xfd8427165df67df6d7fd689ae67c8ebf56d9ca61': 'memes' })
  assert.equal(Object.hasOwn(map, 'constructor'), false)
})
