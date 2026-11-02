// The guesses past the card's measuring budget (text.mjs guess), apart from text.test.mjs so the two run side by side:
// these sweeps are most of the time the text tests take
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { guess, measure, metrics, FONTS, textSvg, wrap } from './text.mjs'

const cp = (...c) => String.fromCodePoint(...c)
// where each picture is drawn: [x, y, size]
const placed = (s) => [...s.matchAll(/<use [^>]*translate\(([-\d.]+) ([-\d.]+)\) scale\(([\d.]+)\)/g)].map((m) => m.slice(1).map(Number))
const tick = () => new Promise((r) => setImmediate(r))

test("a run past the budget is guessed, and the guess is never less than resvg's own advance", async () => {
  const inter = metrics(FONTS[0])
  // wide punctuation, fancy-text letters, arrows, numerals, digraphs, marks alone, Inter's widened forms, scripts no
  // font has, and a sample of everything Inter draws
  const runs = ['—————', '……', 'ⓌⒶⓋⒺ', '‱', '⟷⟺', 'Ⅷ', 'Ǳ', cp(0x20dd), 'ïïï ĩĩ īĭ', 'Đđď', 'WWW MMM', '漢字かな', 'नमस्ते', 's̶t̶r̶i̶k̶e̶', 'Z̷̢͎a̸͓l̴̰g̶̱o̵͚', 'a -> b', '*#*', 'A*B*C', 'a_b_c', 'ïïï', 'T_T', 'AVA', '(f)', 'office', 'नमस्ते दुनिया', 'สวัสดีครับ', ' नमस्ते दोस्तों ', ' g̶m̶ ', `z${cp(0x324, 0x308)}`, `ab${cp(0x336).repeat(6)}`, `a${cp(0xfff9)}b${cp(0xfffa)}c${cp(0xfffb)} `, cp(0x600, 0x6dd), cp(0x1bca0, 0x1bca3), `gm${cp(0x3164).repeat(5)}gn`, cp(0x115f, 0x1160, 0xffa0), `mm${cp(0x336, 0x20dd, 0x20dd)}`, `a${cp(0x20dc)}`, `=a${cp(0x20dc)}`, `a${cp(0x20db)}`, `a${cp(0x20e8)}`]
  for (let c = 0x21; c < 0x10000; c += 7) if (inter.glyph(c) && !/[\p{Cc}\p{Cs}]/u.test(cp(c))) runs.push(cp(c, c, c))
  for (const [i, run] of runs.entries()) {
    if (i % 25 === 0) await tick()
    for (const bold of [false, true]) assert.ok(guess(run, bold) >= measure(run, bold), `${bold} ${JSON.stringify(run)}: ${guess(run, bold)} < ${measure(run, bold)}`)
  }
})

test('past the budget, a random sweep of hard runs is never guessed short: marks, controls, scripts no font has, decompositions', async () => {
  // what the text-guess tickets kept finding one at a time (#320 to #382): marks with no letter or after a bidi control,
  // a script's mark on a Latin letter, boxes on boxes, "↮" and U+0344 decomposed, the newest marks, wide spaces
  const inter = metrics(FONTS[0])
  const cps = (lo, hi, f) => { const o = []; for (let c = lo; c <= hi; c++) if (f(cp(c), c)) o.push(cp(c)); return o }
  const pools = [
    cps(0x21, 0x2fff, (s, c) => inter.advance(c) != null && !/[\p{M}\p{C}\p{Z}]/u.test(s)),
    cps(0x300, 0x1ffff, (s) => /\p{M}/u.test(s)),
    cps(0, 0xe01ef, (s) => /\p{Cf}/u.test(s)).concat(['​', '‍', '️', '͏']),
    cps(0x590, 0x8ff, (s) => /\p{L}/u.test(s)),
    cps(0xe00, 0x1fff, (s, c) => /\p{L}/u.test(s) && inter.advance(c) == null).concat(cps(0x11f00, 0x11f5a, () => true)),
    [' ', ' ', '　', ' ', ' ', ' '],
    cps(0x378, 0x2fff, (s) => /\p{Cn}/u.test(s)),
    cps(0x21, 0xffff, (s, c) => inter.advance(c) == null && !/[\p{C}\p{M}\p{Extended_Pictographic}]/u.test(s)),
    cps(0xa0, 0x2fff, (s) => s.normalize('NFD') !== s),
  ]
  let seed = 7
  const rnd = (n) => Math.floor(((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * n)
  const runs = ['fi' + cp(0x2066, 0x2069, 0x303) + 'T', 'a' + cp(0x652, 0x308, 0x308), '1Ɨƚ', 'ɥjɥj', cp(0x11f03, 0xe33), 'a' + cp(0x2068, 0x7f2, 0x7f2), `O${cp(0x303)}1${cp(0x5a3)}©${cp(0x344)}`,
    `l${cp(0x30c)} ${cp(0x5a3, 0x378, 0x344)}`, cp(0x64b, 0x6e1) + 'ď' + cp(0x301), cp(0x202e) + 's̶t̶r̶i̶k̶e̶', cp(0x3000) + '↮⇎', 'ϒ' + cp(0x200b, 0x316, 0x301), 'ї' + cp(0x113bf, 0x2009, 0xec6)]
  for (let i = 0; i < 1500; i++) runs.push(Array.from({ length: 1 + rnd(7) }, () => { const p = pools[rnd(pools.length)]; return p[rnd(p.length)] }).join(''))
  for (const [i, run] of runs.entries()) {
    if (i % 50 === 0) await tick()
    for (const bold of [false, true]) assert.ok(guess(run, bold) >= measure(run, bold), `${bold} ${[...run].map((c) => c.codePointAt(0).toString(16)).join(' ')}: ${guess(run, bold)} < ${measure(run, bold)}`)
  }
})

test('a guessed run ends where resvg would end it, within a few px: no holes, nothing pushed off the card', async () => {
  // realistic casts of short phrases between emoji: Latin, struck through (marks no font has), and Hindi (no card font
  // has Devanagari, so its letters and marks are boxes); each guess may be over by a little, more for the boxes
  const sets = {
    latin: [0.3, ['gm frens', 'big day', 'shipping v2', 'DMs fixed', 'push alerts', 'thanks all', 'LFG', 'wagmi', 'ser', 'based', 'ty', 'so good', 'love it', 'lol', 'yes', 'top', 'fire', 'Wow', 'a_b', '2024']],
    strike: [0.3, ['s̶o̶l̶d̶ o̶u̶t̶', 'n̶o̶t̶ ̶y̶e̶t̶', 'f̶r̶e̶e̶', 'o̶l̶d̶ p̶r̶i̶c̶e̶', 'g̶m̶', 'u̲n̲d̲e̲r̲']],
    hindi: [1, ['नमस्ते दोस्तों', 'आज का दिन', 'बहुत अच्छा', 'धन्यवाद सबको', 'शुभ रात्रि', 'चलो चलें', 'मज़ा आया', 'प्यार', 'खुश रहो', 'जय हो']],
  }
  for (const [name, [over, phrases]] of Object.entries(sets)) {
    await tick()
    // the first 32 runs are measured; past them, every run of the cast is guessed
    textSvg([Array.from({ length: 32 }, (_, i) => `warm ${name} ${i}`).join('🎉')], { x: 0, y: 40, size: 32, fill: '#fff' })
    const cast = phrases.join(' 🔥 ')
    const xs = placed(textSvg([cast], { x: 0, y: 40, size: 32, fill: '#fff' })).map(([x]) => x)
    // and wrapped as a card wraps it, every picture stays inside the text box
    const boxed = placed(textSvg(wrap(cast, 32, 1040, 9), { x: 84, y: 232, lh: 42, size: 32, fill: '#fff' }))
    await tick()
    assert.equal(xs.length, phrases.length - 1)
    let at = 0
    phrases.slice(0, -1).forEach((p, i) => {
      const exact = at + measure(i ? ` ${p} ` : `${p} `) * 32 + 0.07 * 32
      assert.ok(xs[i] > exact - 0.06 && xs[i] < exact + over * 32, `${name} ${p}: ${xs[i]} vs ${exact}`)
      at = xs[i] - 0.07 * 32 + 1.22 * 32
    })
    assert.equal(boxed.length, phrases.length - 1)
    for (const [x] of boxed) assert.ok(x + 1.08 * 32 < 84 + 1040 + 16, `${name} ${x}`)
  }
  // each guess is close to resvg's advance, not twice it (a short run carries the guess's fixed tenth of an em)
  for (const run of [' gm ', ' this ', ' 2024 ', ' hello world ']) for (const bold of [false, true]) assert.ok(guess(run, bold) < measure(run, bold) * 1.1, run)
})
