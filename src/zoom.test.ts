// The image viewer's zoom (#417): a double tap zooms in on the tapped spot, a pinch follows the fingers, and a zoomed
// picture never pans its edge in past the screen's.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bound, FIT, MAX_ZOOM, zoomAt } from './zoom.ts'

// where a spot of the picture (from its fitted middle) is on screen (from the screen's middle)
const at = (v: { z: number; x: number; y: number }, q: { x: number; y: number }) => ({ x: v.x + v.z * q.x, y: v.y + v.z * q.y })

test('zooming about a point keeps the spot under it there', () => {
  const v = zoomAt(FIT, 2.5, { x: 100, y: -40 })
  assert.equal(v.z, 2.5)
  assert.deepEqual(at(v, { x: 100, y: -40 }), { x: 100, y: -40 })
  // and again from there, about another point
  const p = at(v, { x: 30, y: 10 })
  const w = zoomAt(v, 4, p)
  assert.deepEqual(at(w, { x: 30, y: 10 }), p)
})

test('a pinch carries the spot it began on to the fingers\' middle', () => {
  const v = zoomAt(FIT, 2, { x: 10, y: 20 }, { x: 60, y: -30 })
  assert.deepEqual(at(v, { x: 10, y: 20 }), { x: 60, y: -30 })
})

test('zoom stays between fitted and the most', () => {
  assert.equal(zoomAt(FIT, 0.3, { x: 50, y: 50 }).z, 1)
  assert.deepEqual(zoomAt(FIT, 0.3, { x: 50, y: 50 }), FIT)
  assert.equal(zoomAt(FIT, 99, { x: 0, y: 0 }).z, MAX_ZOOM)
  assert.equal(bound({ z: 0.5, x: 3, y: 4 }, 300, 200, 390, 844).z, 1)
})

test('a zoomed picture pans only as far as its edges', () => {
  // 350×200 fitted on a 390×844 screen at 2×: 700 wide (155 px past each side), 400 tall (less than the screen)
  assert.deepEqual(bound({ z: 2, x: 500, y: 300 }, 350, 200, 390, 844), { z: 2, x: 155, y: 0 })
  assert.deepEqual(bound({ z: 2, x: -500, y: -300 }, 350, 200, 390, 844), { z: 2, x: -155, y: 0 })
  assert.deepEqual(bound({ z: 2, x: 20, y: 0 }, 350, 200, 390, 844), { z: 2, x: 20, y: 0 })
  // fitted, it sits in the middle (and never at -0)
  assert.deepEqual(bound({ z: 1, x: -12, y: -7 }, 350, 200, 390, 844), FIT)
  assert.ok(Object.is(bound({ z: 1, x: -12, y: 0 }, 350, 200, 390, 844).x, 0))
})

test('a double tap near an edge zooms in without showing past it', () => {
  // tapped at the picture's right edge: the picture's right edge stays at the screen's
  const v = bound(zoomAt(FIT, 2.5, { x: 175, y: 0 }), 350, 200, 390, 844)
  assert.equal(v.x, -(2.5 * 350 - 390) / 2)
  assert.equal(v.x + (2.5 * 350) / 2, 390 / 2)
})
