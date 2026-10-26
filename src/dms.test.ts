import assert from 'node:assert/strict'
import { test } from 'node:test'

// dms.ts expects a browser with a signed-in account (fid 7); this is just enough of one
;(globalThis as any).addEventListener = () => {}
;(globalThis as any).dispatchEvent = () => true
;(globalThis as any).localStorage = { getItem: (k: string) => (k === 'quilcast:accounts' ? '[{"phrase":"x","fid":7,"done":true,"dm":"t"}]' : k === 'quilcast:current' ? 'x' : null), setItem() {}, removeItem() {} }

const m = (id: string, t: number, message = id, senderFid = 1) => ({ conversationId: 'c', messageId: id, senderFid, serverTimestamp: t, type: 'text', message })
const convo = (id: string) => ({ conversationId: id, isGroup: false, viewerContext: {} })

test('merge keeps messages in order, drops repeats, and hands back the same array when nothing changed', async () => {
  const { merge } = await import('./dms.ts')
  const a = [m('a', 1), m('b', 2)]
  assert.equal(merge(a, [m('b', 2)]), a)
  assert.deepEqual(merge(a, [m('c', 3), m('a', 1)]).map((x) => x.messageId), ['a', 'b', 'c'])
  assert.equal(merge(a, [m('b', 2, 'edited')])[1].message, 'edited')
  assert.deepEqual(merge([], [m('z', 9), m('y', 1)]).map((x) => x.messageId), ['y', 'z'])
})

test('Quorum mode groups a sender’s messages within 5 minutes on the same day, like quorum-shared', async () => {
  const { compact, sameDay } = await import('./dms.ts')
  const day = new Date(2026, 9, 26, 12).getTime()
  assert.equal(compact(m('b', day + 60e3), m('a', day), false), true)
  assert.equal(compact(m('b', day + 5 * 60e3), m('a', day), false), true)
  assert.equal(compact(m('b', day + 5 * 60e3 + 1), m('a', day), false), false)
  assert.equal(compact(m('b', day + 60e3, 'b', 2), m('a', day), false), false)
  assert.equal(compact(m('b', day + 60e3), m('a', day), true), false)
  assert.equal(compact(m('a', day), undefined, true), false)
  assert.equal(compact({ ...m('b', day + 60e3), type: 'pin_message' }, m('a', day), false), false)
  assert.equal(sameDay(day, day + 3600e3), true)
  assert.equal(sameDay(day, day + 864e5), false)
})

test('older pages add only new conversations, a page with nothing new ends the list, and a refresh keeps older pages', async () => {
  const { page } = await import('./dms.ts')
  const list = { items: null, more: '', pages: 0, used: new Set() } as any
  const ids = () => list.items.map((c: any) => c.conversationId)
  page(list, [convo('a'), convo('b')], 'p2', false)
  page(list, [convo('b'), convo('c')], 'p3', true)
  assert.deepEqual([ids(), list.more], [['a', 'b', 'c'], 'p3'])
  // the same page again (a cursor that doesn't move on) brings nothing new: that's the end
  page(list, [convo('c')], 'p3', true)
  assert.deepEqual([ids(), list.more], [['a', 'b', 'c'], ''])
  // a cursor that comes round again is the end too, even when its page looks new
  const loop = { items: null, more: '', pages: 0, used: new Set(['p2']) } as any
  page(loop, [convo('a')], 'p2', false)
  page(loop, [convo('z')], 'p2', true)
  assert.equal(loop.more, '')
  // a refresh puts the newest on top and keeps what older pages loaded
  page(list, [convo('c'), convo('a')], 'p2', false)
  assert.deepEqual([ids(), list.more], [['c', 'a', 'b'], ''])
})

test('our own message coming back over the websocket replaces the one still sending, in place', async () => {
  const { handle, store } = await import('./dms.ts')
  const sending = { ...m('temp', 5, 'hi', 7), state: 'sending' as const }
  store.chats.set('c', { msgs: [m('a', 1), sending], older: '' })
  store.convos.set('c', convo('c'))
  handle({ messageType: 'refresh-direct-cast-conversation', payload: { conversationId: 'c', message: m('srv', 4, 'hi', 7) } })
  assert.deepEqual(store.chats.get('c')!.msgs.map((x) => x.messageId), ['a', 'srv'])
})
