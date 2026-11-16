import assert from 'node:assert/strict'
import { test } from 'node:test'

const { BLASTS, choochoo, runTrain } = await import('./choochoo.ts')

test('with no Web Audio and no page, the train button stays quiet and still works', () => {
  assert.equal(typeof (globalThis as any).AudioContext, 'undefined')
  assert.doesNotThrow(() => choochoo())
  assert.doesNotThrow(() => runTrain('Choo choo!'))
})

// a Web Audio stand-in that records what's started and stopped, and when
class Param {
  value = 0
  setValueAtTime() { return this }
  exponentialRampToValueAtTime() { return this }
  linearRampToValueAtTime() { return this }
  cancelScheduledValues() { return this }
}
const log: { kind: string; on?: number; off?: number }[] = []
class Node {
  gain = new Param(); frequency = new Param(); Q = new Param(); type = ''; buffer: unknown; kind: string
  constructor(kind: string) { this.kind = kind; log.push(this as any) }
  connect(n: Node) { return n }
  start(t: number) { (this as any).on = t }
  stop(t: number) { (this as any).off = t }
}
let resumed = 0
class FakeAudio {
  currentTime = 5; sampleRate = 8000; destination = new Node('out')
  resume() { resumed++; return Promise.resolve() }
  createGain() { return new Node('gain') }
  createOscillator() { return new Node('osc') }
  createBiquadFilter() { return new Node('filter') }
  createBufferSource() { return new Node('noise') }
  createBuffer(_c: number, n: number) { return { getChannelData: () => new Float32Array(n) } }
}

test('a tap blows the whistle twice, right away, and it is over within about a second', () => {
  ;(globalThis as any).AudioContext = FakeAudio
  choochoo()
  assert.equal(resumed, 1)
  const played = log.filter((n) => n.on !== undefined)
  // three notes and a puff of steam per blast
  assert.equal(played.filter((n) => n.kind === 'osc').length, 3 * BLASTS.length)
  assert.equal(played.filter((n) => n.kind === 'noise').length, BLASTS.length)
  const starts = [...new Set(played.map((n) => +(n.on! - 5).toFixed(3)))].sort()
  assert.deepEqual(starts, BLASTS.map(([at]) => +(at + 0.01).toFixed(3)))
  for (const n of played) assert.ok(n.off! > n.on! && n.off! - 5 < 1.1, `${n.kind} stops by 1.1s`)
})

// just enough of a page for runTrain
type El = { tag: string; className: string; textContent: string; kids: El[]; attrs: Record<string, string>; on: Record<string, (e: unknown) => void>; gone: boolean; append(...k: El[]): void; setAttribute(k: string, v: string): void; addEventListener(k: string, f: (e: unknown) => void): void; remove(): void }
const page = () => {
  const body: El[] = []
  const make = (tag: string): El => ({
    tag, className: '', textContent: '', kids: [], attrs: {}, on: {}, gone: false,
    append(...k) { this.kids.push(...k) },
    setAttribute(k, v) { this.attrs[k] = v },
    addEventListener(k, f) { this.on[k] = f },
    remove() { this.gone = true; const i = body.indexOf(this); if (i >= 0) body.splice(i, 1) },
  })
  return {
    body,
    document: { createElement: make, body: { append: (e: El) => body.push(e) }, querySelector: (s: string) => body.find((e) => '.' + e.className === s) ?? null },
  }
}
const text = (e: El): string => e.textContent + e.kids.map(text).join('')

test('the train crosses the screen once, saying choo choo, and a new tap starts it over', (t) => {
  const p = page()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  Object.assign(globalThis, { document: p.document, matchMedia: () => ({ matches: false }) })
  runTrain('Chu-chu!')
  assert.equal(p.body.length, 1)
  const [box] = p.body
  assert.equal(box.className, 'choo')
  assert.equal(box.attrs['aria-hidden'], 'true')
  assert.match(text(box), /Chu-chu!.*🚂/)
  runTrain('Chu-chu!')
  assert.equal(p.body.length, 1)
  assert.ok(box.gone)
  // it goes away when the run ends, and on its own if the animation never runs
  const train = p.body[0].kids[0]
  train.on.animationend({ target: p.body[0].kids[0].kids[1] })
  assert.equal(p.body.length, 1, 'a puff of steam ending is not the train arriving')
  train.on.animationend({ target: train })
  assert.equal(p.body.length, 0)
  runTrain('Chu-chu!')
  t.mock.timers.tick(1000)
  runTrain('Chu-chu!')
  // the first train's fallback leaves the newer one running
  t.mock.timers.tick(2000)
  assert.equal(p.body.length, 1)
  t.mock.timers.tick(1000)
  assert.equal(p.body.length, 0)
})

test('with reduced motion there is no train', () => {
  const p = page()
  Object.assign(globalThis, { document: p.document, matchMedia: (q: string) => ({ matches: q.includes('reduce') }) })
  runTrain('Choo choo!')
  assert.equal(p.body.length, 0)
})
