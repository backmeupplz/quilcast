import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cancelAll, confirmSignOut, waitingToPost, warning } from './signout.ts'

test('only casts still waiting count: posted, failed and ones being sent are left out', () => {
  const list = [
    { id: 'a', status: 'scheduled' }, { id: 'b', status: 'posting' }, { id: 'c', status: 'posted' },
    { id: 'd', status: 'failed' }, { id: 'e', status: 'scheduled' },
  ]
  assert.deepEqual(waitingToPost(list).map((s) => s.id), ['a', 'e'])
  assert.deepEqual(waitingToPost([]), [])
})

test("a cast that can't be cancelled is reported, and the rest are still cancelled", async () => {
  const done: string[] = []
  const failed = await cancelAll(['a', 'b', 'c'], async (id) => {
    if (id === 'b') throw new Error('That cast is being sent right now.')
    done.push(id)
  })
  assert.deepEqual(done, ['a', 'c'])
  assert.deepEqual(failed, [{ id: 'b', error: 'That cast is being sent right now.' }])
})

// a server holding `list` (the waiting ids), recording what the sign-out does, in order
function server(list: string[], o: { stuck?: string[]; revokeFails?: boolean; readFails?: boolean | number } = {}) {
  const log: string[] = []
  let reads = 0
  return {
    log,
    list,
    // readFails: every read fails; a number: the reads after that many fail
    reread: async () => {
      reads++
      if (o.readFails === true || (typeof o.readFails === 'number' && reads > o.readFails)) throw new Error('offline')
      return [...list]
    },
    cancel: async (id: string) => {
      if (o.stuck?.includes(id)) throw new Error('That cast is being sent right now.')
      log.push(`cancel ${id}`)
      list.splice(list.indexOf(id), 1)
    },
    revoke: async () => {
      if (o.revokeFails) throw new Error('node down')
      log.push('revoke')
    },
  }
}

test('confirming cancels every waiting cast before the key is revoked', async () => {
  const s = server(['a', 'b'])
  assert.deepEqual(await confirmSignOut(['a', 'b'], s), { state: 'done' })
  assert.deepEqual(s.log, ['cancel a', 'cancel b', 'revoke'])
})

test('with nothing scheduled, signing out only revokes the key', async () => {
  const s = server([])
  assert.deepEqual(await confirmSignOut([], s), { state: 'done' })
  assert.deepEqual(s.log, ['revoke'])
})

test('a cast scheduled after the prompt opened (another tab) is named first, and nothing goes yet', async () => {
  const s = server(['a', 'b'])
  assert.deepEqual(await confirmSignOut(['a'], s), { state: 'ask', waiting: ['a', 'b'] })
  assert.deepEqual(await confirmSignOut([], server(['c'])), { state: 'ask', waiting: ['c'] })
  assert.deepEqual(s.log, [])
})

test('one posted or cancelled elsewhere since the prompt is simply not there any more', async () => {
  const s = server(['b'])
  assert.deepEqual(await confirmSignOut(['a', 'b'], s), { state: 'done' })
  assert.deepEqual(s.log, ['cancel b', 'revoke'])
})

test("one that can't be cancelled keeps the key: the prompt comes back with what's still waiting", async () => {
  const s = server(['a', 'b', 'c'], { stuck: ['b'] })
  assert.deepEqual(await confirmSignOut(['a', 'b', 'c'], s), { state: 'ask', waiting: ['b'], error: 'That cast is being sent right now.' })
  assert.deepEqual(s.log, ['cancel a', 'cancel c'])
})

test("a list that can't be read again goes by what the prompt showed", async () => {
  const s = server(['a'], { readFails: true })
  assert.deepEqual(await confirmSignOut(['a'], s), { state: 'done' })
  assert.deepEqual(s.log, ['cancel a', 'revoke'])
})

test("keys that can't be revoked are reported after the casts are cancelled", async () => {
  const s = server(['a'], { revokeFails: true })
  assert.deepEqual(await confirmSignOut(['a'], s), { state: 'stuck', error: 'node down' })
  assert.deepEqual(s.log, ['cancel a'])
})

test("a list that couldn't be read is never taken for none: the prompt says it couldn't check", () => {
  assert.equal(warning('unknown'), 'unchecked')
  assert.equal(warning([]), 'none')
  assert.equal(warning(['a']), 'casts')
  assert.equal(warning(null), 'checking')
})

test("past the \"couldn't check\" warning, a list that reads now is named before anything goes", async () => {
  const s = server(['a'])
  assert.deepEqual(await confirmSignOut('unknown', s), { state: 'ask', waiting: ['a'] })
  assert.deepEqual(s.log, [])
  const none = server([])
  assert.deepEqual(await confirmSignOut('unknown', none), { state: 'done' })
  assert.deepEqual(none.log, ['revoke'])
})

test("no read ever succeeding revokes only once the \"couldn't check\" warning was confirmed", async () => {
  // the prompt's first read failed, so it showed the warning (not "Erase keys?"), and that's what was confirmed
  assert.equal(warning('unknown'), 'unchecked')
  const s = server(['a'], { readFails: true })
  assert.deepEqual(await confirmSignOut('unknown', s), { state: 'done' })
  assert.deepEqual(s.log, ['revoke'])
})

test("cancelled ones aren't named again when the list can't be read after a cast couldn't be cancelled", async () => {
  const s = server(['a', 'b'], { stuck: ['b'], readFails: 1 })
  assert.deepEqual(await confirmSignOut(['a', 'b'], s), { state: 'ask', waiting: ['b'], error: 'That cast is being sent right now.' })
  assert.deepEqual(s.log, ['cancel a'])
})
