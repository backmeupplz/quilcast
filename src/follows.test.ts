import assert from 'node:assert/strict'
import { test } from 'node:test'

test('followsMe asks whether they follow the viewer, not the other way round, and reads a failure as no', async () => {
  const store = new Map<string, string>()
  Object.assign(globalThis, { addEventListener: () => {}, dispatchEvent: () => true })
  ;(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) }
  const api = await import('./api.ts')
  // the node links 5 → 7 (5 follows the viewer) and 7 → 6 (the viewer follows 6); fid 8 makes the node fail
  const links = new Set(['5>7', '7>6'])
  const asked: string[] = []
  ;(globalThis as any).fetch = async (url: string) => {
    const u = new URL(url)
    assert.equal(u.pathname, '/v1/linkById')
    assert.equal(u.searchParams.get('link_type'), 'follow')
    const key = `${u.searchParams.get('fid')}>${u.searchParams.get('target_fid')}`
    asked.push(key)
    if (key.startsWith('8>')) throw new TypeError('fetch failed')
    return links.has(key) ? new Response('{}', { status: 200 }) : new Response('{"errCode":"not_found"}', { status: 404 })
  }

  assert.equal(await api.followsMe({ fid: 5 }), false, 'signed out: never asked')
  assert.deepEqual(asked, [])

  api.setAccount({ phrase: '', custody: '0x7', fid: 7, done: true })
  api.forget()
  assert.equal(await api.followsMe({ fid: 5 }), true, 'they follow the viewer')
  assert.equal(await api.followsMe({ fid: 6 }), false, 'the viewer follows them, which is not the same')
  assert.equal(await api.isFollowing(6), true, 'the existing check still goes viewer → them')
  assert.equal(await api.followsMe({ fid: 8 }), false, 'a network error reads as no')
  assert.equal(await api.followsMe({ fid: 7 }), false, 'your own profile: never asked')
  assert.deepEqual(asked, ['5>7', '6>7', '7>6', '8>7'])

  // a node that answers viewer_context.followed_by saves the request, whichever way it says
  assert.equal(await api.followsMe({ fid: 9, viewer_context: { followed_by: true } }), true)
  assert.equal(await api.followsMe({ fid: 5, viewer_context: { following: true, followed_by: false } }), false)
  assert.equal(asked.length, 4)
})
