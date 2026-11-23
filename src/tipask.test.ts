import assert from 'node:assert/strict'
import { test } from 'node:test'

const store = new Map<string, string>()
;(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, String(v)), removeItem: (k: string) => void store.delete(k) }
const { holdTip, setHoldTip, tipOk, tipSheet, tipTold } = await import('./tipask.ts')

// a stand-in for TipSheet: records each time it's shown, may flip its switch, and answers with `answer`
let asked = 0
let answer = false
let switchOff = false
tipSheet.ask = async () => (asked++, switchOff && setHoldTip(false), answer)
const reset = () => (store.clear(), (asked = 0), (answer = false), (switchOff = false))
const o = { from: 'Main', to: 'alice' }

test('hold-to-tip is on until someone turns it off', () => {
  reset()
  assert.equal(holdTip(), true)
  setHoldTip(false)
  assert.equal(holdTip(), false)
  setHoldTip(true)
  assert.equal(holdTip(), true)
})

test('the first hold explains itself; Cancel tips nothing and asks again next time', async () => {
  reset()
  assert.equal(await tipOk(o), false)
  assert.equal(await tipOk(o), false)
  assert.equal(asked, 2)
  assert.equal(tipTold(), false)
})

test('once someone tipped from the sheet, holds tip without asking', async () => {
  reset()
  answer = true
  assert.equal(await tipOk(o), true)
  assert.equal(tipTold(), true)
  answer = false
  assert.equal(await tipOk(o), true)
  assert.equal(await tipOk(o), true)
  assert.equal(asked, 1)
})

test('switched off, a hold never asks and never tips, even once told', async () => {
  reset()
  setHoldTip(false)
  answer = true
  assert.equal(await tipOk(o), false)
  assert.equal(asked, 0)
  setHoldTip(true)
  assert.equal(await tipOk(o), true)
  setHoldTip(false)
  assert.equal(await tipOk(o), false)
  assert.equal(asked, 1)
})

test("turning the sheet's switch off means no tip, and no more asking", async () => {
  reset()
  answer = true
  switchOff = true
  assert.equal(await tipOk(o), false)
  assert.equal(tipTold(), false)
  assert.equal(holdTip(), false)
  assert.equal(await tipOk(o), false)
  assert.equal(asked, 1)
})

test('a browser that keeps nothing stays on, asks every time and still tips when told to', async () => {
  const kept = (globalThis as any).localStorage
  ;(globalThis as any).localStorage = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') }, removeItem: () => { throw new Error('blocked') } }
  try {
    asked = 0
    answer = true
    switchOff = false
    assert.equal(holdTip(), true)
    assert.equal(await tipOk(o), true)
    assert.equal(await tipOk(o), true)
    assert.equal(asked, 2)
  } finally {
    ;(globalThis as any).localStorage = kept
  }
})
