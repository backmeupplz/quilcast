import assert from 'node:assert/strict'
import { test } from 'node:test'
import { awake, IDLE, sleepers, type Napper } from './sleep.ts'

type A = Napper & { busy?: boolean }
const ids = (l: A[]) => l.map((a) => a.id)
const busy = (a: A) => !!a.busy
const now = 10 * IDLE

test('an app sleeps once it has waited in the dock long enough', () => {
  const apps: A[] = [{ id: 1, hidAt: now - IDLE }, { id: 2, hidAt: now - IDLE + 1 }, { id: 3 }]
  assert.deepEqual(ids(sleepers(apps, 3, now, 3, busy)), [1])
})

test('the one on screen, a busy one and a sleeping one stay as they are', () => {
  const apps: A[] = [{ id: 1, hidAt: 0 }, { id: 2, hidAt: 0, busy: true }, { id: 3, hidAt: 0, asleep: true }]
  assert.deepEqual(ids(sleepers(apps, 1, now, 3, busy)), [])
  assert.deepEqual(ids(sleepers(apps, null, now, 3, busy)), [1])
  assert.deepEqual(ids(sleepers(apps, null, now, 3, busy, true)), [1])
})

test('past the limit, the apps used longest ago sleep first', () => {
  const apps: A[] = [{ id: 1, hidAt: now - 3 }, { id: 2, hidAt: now - 1 }, { id: 3, hidAt: now - 4 }, { id: 4, hidAt: now - 2 }, { id: 5 }]
  assert.deepEqual(ids(sleepers(apps, 5, now, 2, busy)), [1, 3])
  assert.deepEqual(ids(sleepers(apps, 5, now, awake(true), busy)), [4, 1, 3])
  // a busy app isn't put down, and doesn't use up a place either
  apps[1].busy = true
  assert.deepEqual(ids(sleepers(apps, 5, now, 2, busy)), [3])
})

test('on a phone in the background every waiting app sleeps', () => {
  const apps: A[] = [{ id: 1, hidAt: now }, { id: 2 }, { id: 3, hidAt: now, busy: true }]
  assert.deepEqual(ids(sleepers(apps, 2, now, 3, busy, true)), [1])
})
