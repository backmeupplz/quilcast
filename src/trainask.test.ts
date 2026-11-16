import assert from 'node:assert/strict'
import { test } from 'node:test'

const store = new Map<string, string>()
;(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, String(v)), removeItem: (k: string) => void store.delete(k) }
const { trainOk, trainSheet, trainTold } = await import('./trainask.ts')

// a stand-in for TrainSheet: records each time it's shown and answers with `answer`
let asked: string[] = []
let answer = false
trainSheet.ask = async (kind) => (asked.push(kind), answer)

test('the first train explains itself; Cancel posts nothing and asks again next time', async () => {
  store.clear()
  asked = []
  answer = false
  assert.equal(trainTold(), false)
  assert.equal(await trainOk('join'), false)
  assert.equal(await trainOk('start'), false)
  assert.deepEqual(asked, ['join', 'start'])
  assert.equal(trainTold(), false)
})

test('once someone went on, joining or starting a train never asks again', async () => {
  store.clear()
  asked = []
  answer = true
  assert.equal(await trainOk('join'), true)
  assert.deepEqual(asked, ['join'])
  assert.equal(trainTold(), true)
  answer = false
  for (const kind of ['join', 'join', 'start'] as const) assert.equal(await trainOk(kind), true)
  assert.deepEqual(asked, ['join'])
})

test('going on from the composer\'s toggle counts for joining too', async () => {
  store.clear()
  asked = []
  answer = true
  assert.equal(await trainOk('start'), true)
  assert.equal(await trainOk('join'), true)
  assert.deepEqual(asked, ['start'])
})

test('a browser that keeps nothing asks every time and still goes on when told to', async () => {
  const kept = (globalThis as any).localStorage
  ;(globalThis as any).localStorage = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
  try {
    asked = []
    answer = true
    assert.equal(await trainOk('join'), true)
    assert.equal(await trainOk('join'), true)
    assert.deepEqual(asked, ['join', 'join'])
  } finally {
    ;(globalThis as any).localStorage = kept
  }
})
