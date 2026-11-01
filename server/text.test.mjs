import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { cut, ends, esc, exactly, FONTS, graphemes, guess, initial, kind, LAYERED, measure, metrics, pictures, source, textSvg, width, wrap } from './text.mjs'

const cp = (...c) => String.fromCodePoint(...c)
const ZWJ = 0x200d, VS16 = 0xfe0f
const FAMILY = cp(0x1f468, ZWJ, 0x1f469, ZWJ, 0x1f467, ZWJ, 0x1f466)
const THUMB = cp(0x1f44d, 0x1f3fd)
const UA = cp(0x1f1fa, 0x1f1e6)
const PRIDE = cp(0x1f3f3, VS16, ZWJ, 0x1f308)
const PHOENIX = cp(0x1f426, ZWJ, 0x1f525) // Emoji 15.1, newer than Twemoji's set
const CHECK = cp(0x2714)
const opts = { font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'Inter' } }
const card = (body, w = 1200, h = 630) => pictures(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${body}</svg>`)
const uses = (s) => (s.match(/<use href="#tw-/g) || []).length
// where each picture is drawn: [x, y, size]
const placed = (s) => [...s.matchAll(/<use [^>]*translate\(([-\d.]+) ([-\d.]+)\) scale\(([\d.]+)\)/g)].map((m) => m.slice(1).map(Number))

test('emoji are drawn as Twemoji pictures, however they are spelled; what Inter draws stays text', () => {
  assert.equal(kind('🎉'), '1f389.svg')
  assert.equal(kind(FAMILY), '1f468-200d-1f469-200d-1f467-200d-1f466.svg')
  assert.equal(kind(THUMB), '1f44d-1f3fd.svg')
  assert.equal(kind(UA), '1f1fa-1f1e6.svg')
  assert.equal(kind(cp(0x31, VS16, 0x20e3)), '31-20e3.svg')
  // with or without VS16, a ZWJ sequence finds its file
  assert.equal(kind(PRIDE), '1f3f3-fe0f-200d-1f308.svg')
  assert.equal(kind(cp(0x1f3f3, ZWJ, 0x1f308)), '1f3f3-fe0f-200d-1f308.svg')
  assert.equal(kind(cp(0x2764, VS16)), '2764.svg')
  assert.equal(kind(cp(0x1f389, VS16)), '1f389.svg')
  // "❤" alone and "©" are Inter's own glyphs; letters and digits are text
  for (const g of [cp(0x2764), '©', 'a', '1', ' ', 'é']) assert.equal(kind(g), null, g)
  // newer than Twemoji's set: drawn in parts (below)
  assert.equal(kind(PHOENIX), null)
  // a ZWJ sequence without its VS16 even though Inter draws its first part
  assert.equal(kind(cp(0x2764, ZWJ, 0x1f525)), '2764-fe0f-200d-1f525.svg')
  // a text-style pictograph Inter lacks is Noto's outline in the text color; with VS16 it's the picture
  assert.equal(kind(CHECK), 'noto')
  assert.equal(kind(cp(0x2714, VS16)), '2714.svg')
})

test('a cluster no emoji set draws as one is drawn in parts, as browsers do', () => {
  for (const g of [cp(0x1f389, 0x1f3fd), cp(0x1f468, ZWJ, 0x1f389), PHOENIX]) {
    assert.equal(kind(g), null)
    assert.equal(width(g, 20), 2 * width('🎉', 20))
    assert.equal(uses(textSvg([g], { x: 0, y: 40, size: 40, fill: '#fff' })), 2)
  }
  // a skin tone on a letter comes off as its swatch; a keycap mark on a letter is dropped
  const s = textSvg([`a${cp(0x1f3fd)} x${cp(0x20e3)}`], { x: 0, y: 40, size: 40, fill: '#fff' })
  assert.equal(uses(s), 1)
  assert.ok(s.includes('>a</tspan>') && s.includes('> x</tspan>') && !s.includes(cp(0x20e3)))
})

test('an emoji is one glyph when measuring and wrapping, and wrapping never cuts one apart', () => {
  assert.equal(width(FAMILY, 20), width('🎉', 20))
  assert.equal(width(THUMB, 20), width(UA, 20))
  assert.equal(graphemes(`a${FAMILY}b`).length, 3)
  const lines = wrap(FAMILY.repeat(40), 30, 300, 3)
  assert.equal(lines.length, 3)
  assert.ok(lines.at(-1).endsWith('…'))
  for (const l of lines) for (const g of graphemes(l.replace('…', ''))) assert.equal(g, FAMILY)
  // the same number fit on a line as of a one-code-point emoji
  assert.equal(graphemes(wrap(FAMILY.repeat(40), 30, 300, 3)[0]).length, graphemes(wrap('🎉'.repeat(40), 30, 300, 3)[0]).length)
  // the ellipsis still takes the last word
  assert.deepEqual(wrap('one two three four five six seven', 30, 200, 2), ['one two', 'three…'])
})

test('a grapheme wider than the line breaks between the pieces it is drawn as, so every line fits', () => {
  const GRIN = cp(0x1f600)
  for (const [s, pictures] of [
    [`hi a${cp(0x1f3fd).repeat(150)} bye`, 150],
    [Array(120).fill(GRIN).join(cp(ZWJ)), 120],
    [GRIN + cp(0x1f3fb, 0x1f3fc).repeat(60), 121],
  ]) {
    const lines = wrap(s, 46, 1032, 99)
    assert.ok(lines.length > 2, s.slice(0, 8))
    for (const l of lines) assert.ok(width(l, 46) <= 1032 && l.trim(), `${s.slice(0, 8)}: ${width(l, 46)}`)
    // nothing is lost: every picture is still drawn, on some line
    const drawn = lines.join('\n').match(/[\u{1F3FB}-\u{1F3FF}\u{1F600}]/gu)?.length ?? 0
    assert.equal(drawn, pictures)
  }
  // a letter under more marks no font has than a line holds (each a box) keeps the marks that fit, and draws on the card
  for (const n of [40, 599]) {
    const lines = wrap(`hello there x${cp(0xf71).repeat(n)} end`, 46, 1040, 4)
    assert.deepEqual([lines[0], lines.at(-1)], ['hello there', 'end'])
    for (const l of lines) assert.ok(width(l, 46) <= 1040, `${n}: ${width(l, 46)}`)
    const box = new Resvg(card(textSvg(lines, { x: 80, y: 60, lh: 60, size: 46, fill: '#fff' })), opts).getBBox()
    assert.ok(box.x + box.width <= 80 + 1040, `${n}: ${box.x + box.width}`)
  }
  // marks on a space (or a no-break space, or a tab, which the card draws as a space) wrap with it, the same way, and
  // marks after a character the card leaves out go on the letter before it
  for (const sp of [' ', '\u00a0', '\t', '\x01', '\x1f']) {
    const lines = wrap(`hello${sp}${cp(0xf71).repeat(600)} end`, 46, 1040, 6)
    for (const l of lines) assert.ok(width(l, 46) <= 1040, `${JSON.stringify(sp)}: ${width(l, 46)}`)
    const box = new Resvg(card(textSvg(lines, { x: 80, y: 60, lh: 60, size: 46, fill: '#fff' })), opts).getBBox()
    assert.ok(box.x + box.width <= 80 + 1040, `${JSON.stringify(sp)}: ${box.x + box.width}`)
  }
  // the ellipsis takes a few of a line's swatches, not the whole line
  const last = wrap(`hi a${cp(0x1f3fd).repeat(150)} bye`, 46, 1032, 4).at(-1)
  assert.ok(last.endsWith('…') && [...last].length > 6, last)
  // and what's left of a cluster drawn in parts is drawn as the same parts, never joined up into another emoji
  // (a long word the ellipsis has to cut into, ending in a thumb with two swatches, only one of them fitting beside it)
  const long = `one two abcdefghijk${cp(0x1f44d, 0x1f3fb, 0x1f3fc)}`
  const thumb = wrap(`${long} more words here and more`, 34, width(long, 34) + 10, 1)[0]
  assert.ok(thumb.endsWith('…'), thumb)
  assert.equal(uses(card(textSvg([thumb], { x: 0, y: 40, size: 34, fill: '#fff' }))), 2)
  assert.match(textSvg([thumb], { x: 0, y: 40, size: 34, fill: '#fff' }), /tw-1f44d"[\s\S]*tw-1f3fb"/)
  assert.doesNotMatch(textSvg([thumb], { x: 0, y: 40, size: 34, fill: '#fff' }), /tw-1f44d-1f3fb/)
  // an emoji the ellipsis doesn't reach is drawn just as it is without one
  const ids = (l) => [...textSvg([l], { x: 0, y: 40, size: 34, fill: '#fff' }).matchAll(/tw-[0-9a-f-]+|font-family="Noto Emoji">[^<]*/g)].map((m) => m[0])
  for (const e of [cp(0x26d3, VS16, ZWJ, 0x1f4a5), cp(0x1f3c3, 0x1f3fb, ZWJ, 0x27a1, VS16), cp(0x1f600, ZWJ, 0x2764, VS16, ZWJ, 0x1f600), cp(0x1f44d, 0x1f3fd, ZWJ, 0x1f600)]) {
    const l = wrap(`hey ${e} ${'word '.repeat(100)}`, 34, 1032, 1)[0]
    assert.ok(l.endsWith('…'), l)
    assert.deepEqual(ids(l), ids(`hey ${e}`))
  }
})

test("text ending in a mark no font has, right before an emoji, wraps where the card draws it (the boxes' ink end)", () => {
  for (const [s, px, max] of [
    ['हाँ😂 '.repeat(20), 46, 1040],
    ['जी🙏'.repeat(30), 46, 1040],
    ['जी🙏'.repeat(30), 32, 600],
    ['ดี😀 '.repeat(25), 32, 1040],
    // and the ideographic space is a full em
    ['今日は\u3000😀\u3000'.repeat(15), 46, 1040],
    ['「はい」\u3000\u3000'.repeat(20), 32, 600],
    ['こんにちは\u3000世界\u3000'.repeat(10), 46, 1040],
  ]) {
    const lines = wrap(s, px, max, 8)
    const box = new Resvg(card(textSvg(lines, { x: 80, y: 60, lh: px * 1.3, size: px, fill: '#fff' })), opts).getBBox()
    const used = Math.max(box.x + box.width, ...placed(card(textSvg(lines, { x: 80, y: 60, lh: px * 1.3, size: px, fill: '#fff' }))).map(([x, , size]) => x + size))
    assert.ok(used <= 80 + max, `${s.slice(0, 6)} ${px}/${max}: ${used}`)
  }
})

test('wrapping is linear in the length of the text, even when nothing between its words takes room', () => {
  const time = (s) => {
    const t = performance.now()
    wrap(s, 24, 356, 9)
    return performance.now() - t
  }
  // whether ten times the text takes less than k times as long. The deploy build runs these tests on a busy shared
  // machine, so there are no bounds in milliseconds: the two lengths are timed one right after the other (each the best
  // of two), and any of a few tries passes
  const grows = (s, n, k) => {
    const best = (s) => Math.min(time(s), time(s))
    for (let i = 0; i < 5; i++) if (best(s.repeat(n * 10)) < k * best(s.repeat(n))) return true
    return false
  }
  // zero-width spaces split by U+FEFF, which counts as whitespace: one long line of hundreds of words. Linear is about
  // ten times as long, quadratic about a hundred
  const zero = cp(0x200b, 0xfeff)
  time(zero.repeat(30))
  assert.ok(grows(zero, 100, 30))
  // words that fill the lines: wrapping stops once they're full, so the rest of the text costs next to nothing
  assert.ok(grows('a ', 300, 3))
})

test('a font says which characters it has, and their advances', () => {
  const inter = metrics(FONTS[0])
  assert.ok(inter.glyph('A'.codePointAt(0)) && !inter.glyph(0x1f389))
  assert.ok(inter.advance('m'.codePointAt(0)) > inter.advance('i'.codePointAt(0)))
  assert.equal(inter.advance(0x1f389), undefined)
  // resvg's own layout: kerning, and nothing for an empty run
  assert.ok(measure('AV') < measure('A') + measure('V') - 0.02)
  assert.equal(measure(''), 0)
})

// a card measures a bounded number of new runs per synchronous stretch; these tests measure more, so they yield
const tick = () => new Promise((r) => setImmediate(r))

test('the ellipsis keeps what still fits beside it: a run of emoji, a word alone on its line, the end of a long word', () => {
  const FIRE = cp(0x1f525)
  const pics = (l) => graphemes(l).filter((g) => kind(g)).length
  for (const bold of [false, true]) {
    const fits = (l, px, max) => (bold ? ends(l, px, true) : width(l, px)) <= max
    // a theme name of flags, or a word and a run of fire, as the theme card wraps it: the second line used to be "…"
    for (const s of [UA.repeat(15), `Hi ${FIRE.repeat(30)}`]) {
      const lines = wrap(s, 40, 352, 2, { bold })
      assert.equal(lines.length, 2, s)
      assert.ok(lines[1].endsWith('…'), lines[1])
      // all of a full line's emoji but the one the "…" takes the place of
      assert.ok(pics(lines[1]) >= Math.floor(352 / (1.22 * 40)) - 1, lines[1])
      for (const l of lines) assert.ok(fits(l, 40, 352), l)
    }
    // a few emoji after a word aren't a word: as many stay as fit beside the "…"
    const wow = `Wow ${UA.repeat(4)}`
    const max = (bold ? ends(wow, 40, true) : width(wow, 40)) + 10
    const cut = wrap(`${wow} and more words`, 40, max, 1, { bold })[0]
    assert.ok(cut.endsWith('…') && pics(cut) === 3 && fits(cut, 40, max), cut)
    // a long word keeps all of itself that fits beside the "…", not all but its last 12 letters
    const word = 'abcdefghijklmnopqrstuvwxyz'.repeat(3)
    const [first, last] = wrap(word, 40, 352, 2, { bold })
    assert.ok(last.endsWith('…') && graphemes(last).length >= graphemes(first).length - 3, last)
    assert.ok(fits(last, 40, 352), last)
  }
  // a word alone on the last line stays when the "…" fits after it
  assert.deepEqual(wrap('Midnight Wanderer Supreme Edition', 40, 352, 2, { bold: true }), ['Midnight', 'Wanderer…'])
  // and a short last word after others still goes
  assert.deepEqual(wrap('one two three four five six seven', 30, 200, 2, { bold: true }), ['one two', 'three…'])
})

test('a line ends where textSvg draws it to, and bold wrapping fits what is drawn bold', () => {
  for (const bold of [false, true]) {
    for (const l of ['Glittery', `Love ${cp(0x2764, VS16, ZWJ, 0x1f525)}`, `x ${UA} mode`, UA.repeat(3), 'WWWWW MMMMM']) {
      const box = new Resvg(card(textSvg([l], { x: 100, y: 60, size: 40, bold, fill: '#fff' })), opts).getBBox()
      const end = 100 + ends(l, 40, bold)
      // past the ink by no more than a side bearing, or the room a picture leaves on its right
      assert.ok(end >= box.x + box.width - 0.5 && end <= box.x + box.width + 0.15 * 40, `${l} ${bold}: ${end} vs ${box.x + box.width}`)
    }
  }
  // capitals drawn bold are much wider than the guesses, so a bold wrap breaks them sooner, and its lines fit
  const caps = 'WWWWWW WWW WWWWWW WWW'
  assert.ok(wrap(caps, 40, 352, 9, { bold: true }).length > wrap(caps, 40, 352, 9).length)
  for (const l of wrap(caps, 40, 352, 9, { bold: true })) assert.ok(ends(l, 40, true) <= 352, l)
})

test('a long word cut bold fits as drawn, though its letters draw wider together than apart', async () => {
  for (const s of ['ï'.repeat(27), 'ĩ'.repeat(30), 'Q*'.repeat(18), `${'ï'.repeat(40)} ${'ĩ'.repeat(40)}`]) {
    for (const px of [52, 40]) {
      await tick()
      const lines = wrap(s, px, 364, 3, { bold: true })
      for (const l of lines) assert.ok(ends(l, px, true) <= 364, `${px} ${l}: ${ends(l, px, true)}`)
      // nothing is lost but what the ellipsis takes
      if (!lines.at(-1).endsWith('…')) assert.equal(lines.join('').replace(/ /g, ''), s.replace(/ /g, ''))
    }
  }
})

test('a line with emoji: text runs keep their characters, each emoji is a picture where its run ends', async () => {
  for (const bold of [false, true]) {
    await tick()
    // kerning, Cyrillic, combining marks, Inter's contextual arrows and other alternates ("*" after capitals, "_"),
    // format characters, characters no font has, combining marks no font has (strikethrough, underline, an enclosing
    // circle), Devanagari, Thai, Arabic with harakat
    const runs = ['gm', 'AVAWAY To Ty. Done!', 'Привет, мир', 'café naïve WWW', 'a -> b => c <-> d --> e', 'x ---> y <----> z ====> w', 'NEW* A* 1* a_b ï ĩ Đ ď', `x${cp(0xad)}y${cp(0x202e)}z${cp(0x202c)}`, '漢字']
    const gaps = runs.map((run) => {
      const s = textSvg([`${run}|🎉 after`], { x: 20, y: 60, size: 40, bold, fill: '#fff' })
      assert.equal(uses(s), 1)
      assert.ok(!s.includes('🎉') && s.includes('after'))
      const [[x]] = placed(s)
      const r = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="3000" height="100">${s.replace(/<use[^>]*\/>|<tspan[^>]*> after<\/tspan>/g, '')}</svg>`, opts)
      const bb = r.getBBox()
      return x - (bb.x + bb.width)
    })
    // the picture sits the same distance after the bar's ink however the run before it is kerned
    gaps.forEach((g, i) => assert.ok(Math.abs(g - gaps[0]) < 0.5, `${bold} ${runs[i]}: ${gaps}`))
  }
})

test('a picture never lands on text whose marks no font has (their boxes stick out past the advance)', async () => {
  // strikethrough and underline marks, enclosing circles, Devanagari, Thai, Arabic with harakat, Zalgo
  for (const bold of [false, true]) {
    await tick()
    for (const run of ['s̶t̶r̶i̶k̶e̶', 's̶t̶r̶i̶k̶e̶ ', 'u̲n̲d̲e̲r̲', 'a⃝ b⃝', 'नमस्ते दुनिया', 'สวัสดีครับ', 'بِسْمِ ٱللَّٰهِ', 'Z̷̢͎a̸͓l̴̰g̶̱o̵͚', 'gm']) {
      const s = textSvg([`${run}🎉 after`], { x: 20, y: 60, size: 40, bold, fill: '#fff' })
      const [[x]] = placed(s)
      const bb = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="3000" height="100">${s.replace(/<use[^>]*\/>|<tspan[^>]*> after<\/tspan>/g, '')}</svg>`, opts).getBBox()
      const gap = x - (bb.x + bb.width)
      // the picture's own side room is 0.07 em; a trailing space adds its own
      assert.ok(gap > 0 && gap < 0.45 * 40, `${bold} ${run}: ${gap}`)
    }
  }
})

test('paint layers: each paints the text, the pictures are drawn once on top', () => {
  const s = textSvg([`Sunny ${THUMB}`], { x: 10, y: 40, size: 30, weight: 800, paint: ['fill="#f00" filter="url(#glow)"', 'fill="#fff"'] })
  assert.equal((s.match(/<text /g) || []).length, 2)
  assert.equal(uses(s), 1)
  assert.ok(s.lastIndexOf('<text ') < s.indexOf('<use '))
  assert.match(s, /^<text font-family="Inter, Noto Emoji" font-size="30" font-weight="800" fill="#f00" filter="url\(#glow\)" xml:space="preserve">/)
  // weight 800 lays out with Inter Bold's widths, as bold does
  const at = (o) => +textSvg([`Wide ${THUMB}`], { x: 0, y: 40, size: 30, ...o }).match(/<use [^>]*translate\(([\d.]+) /)[1]
  assert.equal(at({ weight: 800, paint: 'fill="#fff"' }), at({ bold: true, fill: '#fff' }))
  assert.notEqual(at({ fill: '#fff' }), at({ bold: true, fill: '#fff' }))
})

test('a card line draws: pictures for emoji, Noto Emoji for text-style pictographs, whitespace collapsed, markup escaped', async () => {
  const s = textSvg([`<b>  hi ${FAMILY}${UA} & ${CHECK}`, 'second'], { x: 84, y: 232, lh: 50, size: 38, fill: '#edebf3' })
  assert.equal(uses(s), 2)
  assert.ok(s.includes('&#60;b&#62; hi ') && s.includes(' &#38; ') && !s.includes('<b>'))
  assert.ok(s.includes(`font-family="Noto Emoji">${CHECK}</tspan>`))
  assert.ok(s.includes('y="282"'))
  assert.match(initial(`${THUMB}x`, 128, 136, 40, '#999'), /<use /)
  assert.match(initial('zed', 128, 136, 40, '#999'), />Z<\/text>/)
  assert.match(initial('\u0007zed', 128, 136, 40, '#999'), />Z<\/text>/)
  const svg = card(`${s}${initial(FAMILY, 128, 136, 40, '#999')}`)
  // each picture is defined once
  assert.equal((svg.match(/<g id="tw-/g) || []).length, 2)
  const png = new Resvg(svg, opts).render().asPng()
  assert.ok(png.length > 2000)
})

test('pictures really draw: in color, and the all-dark ones with a light edge', () => {
  const svg = card(`<rect width="200" height="100" fill="#0d0c11"/>${textSvg([`🎉 ${cp(0x2714, VS16)}`], { x: 0, y: 70, size: 80, fill: '#edebf3' })}`, 200, 100)
  const img = new Resvg(svg, opts).render()
  const px = (x0, x1) => {
    const out = []
    for (let y = 0; y < img.height; y++) for (let x = x0; x < x1; x++) out.push([...img.pixels.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 3)])
    return out
  }
  const [party, check] = placed(svg).map(([x, , size]) => px(Math.ceil(x), Math.floor(x + size)))
  // 🎉 has saturated colors; ✔️ (Twemoji's dark grey) has light pixels from its edge
  assert.ok(party.some(([r, g, b]) => Math.max(r, g, b) - Math.min(r, g, b) > 120))
  assert.ok(check.some(([r, g, b]) => r > 150 && g > 150 && b > 150))
  const [plain, edged] = [...svg.matchAll(/<g id="tw-[\s\S]*?(?=<g id="tw-|<\/defs>)/g)].map((m) => m[0])
  assert.ok(edged.includes('stroke="#bdb8ca"') && !plain.includes('stroke="#bdb8ca"'))
})

test('a run is measured alone, as the card draws it: how it starts never depends on what came before it', async () => {
  await tick()
  // "*" is taller after a bar, "ï"/"Đ" narrower, and a leading enclosing mark folds into one: none of that is the card's
  for (const run of ['*#', 'ïx', 'Đx', `${cp(0x488)}x`, 'x']) {
    const s = textSvg([`${run}🎉`], { x: 20, y: 60, size: 40, fill: '#fff' })
    const [[x]] = placed(s)
    const bb = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="3000" height="100">${s.replace(/<use[^>]*\/>/g, '')}</svg>`, opts).getBBox()
    // the picture's own side room (0.07 em) and the last glyph's side bearing, no more
    const gap = (x - (bb.x + bb.width)) / 40
    assert.ok(gap > 0.05 && gap < 0.13, `${run}: ${gap}`)
  }
  // a run of spaces only has no ink, but still its width
  assert.ok(Math.abs(measure(' ') - 0.28) < 0.03 && Math.abs(measure(`${cp(0xa0)}${cp(0xa0)}`) - 2 * measure(' ')) < 0.01)
})

test('a card measures a bounded number of new runs at once; past that, a guess that leaves room', async () => {
  await tick()
  const words = Array.from({ length: 60 }, (_, i) => `w${i}x${'mW'.repeat(i % 4)}`)
  const s = textSvg([words.join('🎉')], { x: 0, y: 40, size: 20, fill: '#fff' })
  const xs = placed(s).map(([x]) => x)
  assert.equal(xs.length, 59)
  // each picture sits after its run: exactly for the first 32, generously after
  let at = 0
  words.slice(0, -1).forEach((w, i) => {
    const exact = at + (measure(w) + 0.07) * 20
    if (i < 32) assert.ok(Math.abs(xs[i] - exact) < 0.2, `${i}`)
    // and close behind it after: never on the run, never a hole
    else assert.ok(xs[i] > exact && xs[i] < exact + (0.1 + 0.06 * measure(w)) * 20, `${i}: ${xs[i]} vs ${exact}`)
    at = xs[i] - 0.07 * 20 + 1.22 * 20
  })
})

const SARA_AM_BEFORE_RTL = [cp(0xe14, 0xe37, 0xe48, 0xe21, 0xe19, 0xe49, 0xe33, 0x20, 0x5e9, 0x5dc, 0x5d5, 0x5dd), cp(0xe19, 0xe49, 0xe33, 0x20, 0x627, 0x644, 0x633, 0x644, 0x627, 0x645), cp(0x5e9, 0x5dc, 0x5d5, 0x5dd, 0x20, 0xe19, 0xe49, 0xe33, 0x20, 0x627, 0x644, 0x633, 0x644, 0x627, 0x645, 0x20, 0xe19, 0xe49, 0xe33)]
const BOX_ON_RTL_SPACE = [cp(0x20, 0x6db), cp(0x631, 0x64e, 0x64a, 0x652, 0x628, 0x64e, 0x20, 0x6db)]
// a number after Arabic with harakat or Hebrew with points (a word and a count), bare or in brackets
const RTL_BEFORE_NUMBERS = ['كَتَبَ 12', 'عَ 12', 'عَ 1', 'عَ12', 'عَ ١٢', 'عَ 1.5', 'عَ #1', 'كَتَبَ 2024!', 'שָׁלוֹם 12', 'בְּ 12', 'عَ (12)', 'عَ [12]', 'عَ (١٢)', 'عَ ((12))', 'عَ (1)(2)', `عَ ${cp(0x2329)}12${cp(0x3009)}`, 'עִ (12)', 'x (12) عَ', 'عَ (12)َ']
// isolates and embeddings in text with right-to-left text in it: a mention isolated in a Hebrew or Arabic cast, a
// phrase embedded right to left (with a price in it), a Hebrew word isolated in English, and an override
const RTL_ISOLATED = [`gm ${cp(0x2068)}@alice${cp(0x2069)} שלום עולם`, `${cp(0x202b)}שלום world${cp(0x202c)}`, `שלום ${cp(0x2068)}@bob${cp(0x2069)}!`, `مرحبا ${cp(0x2066)}@alice${cp(0x2069)} كيف حالك`, `שלום ${cp(0x2068)}עולם${cp(0x2069)} gm`, `${cp(0x202b)}מחיר 25$${cp(0x202c)}`, `${cp(0x2067)}שלום${cp(0x2069)} world`, `hi ${cp(0x202e)}abc${cp(0x202c)} there`]
// left-to-right isolates and embeddings in text with nothing right to left in it (a mention isolated in a cast)
// (lines with harakat or points and an arrow)
const ARROW_LINES = ['مَرْحَبًا بِكُمْ فِي الْعَالَمِ الْجَدِيدِ –> نَعَمْ', 'مَرْحَبًا –> عَالَم', 'שָׁלוֹם עוֹלָם –> כֵּן']
const LTR_ISOLATED = [`gm ${cp(0x2068)}@alice${cp(0x2069)} how are you`, `A1${cp(0x2069, 0x336)}®`, `ดื่มน้ำ ${cp(0x2068)}x${cp(0x2069)}`, `${cp(0x202a)}Thai ${cp(0x2066)}น้ำ${cp(0x2069)} ok${cp(0x202c)}`, `${cp(0x202d)}a${cp(0x336, 0x202c)}b`]
test("Inter's kerning read from the font is the room resvg gives a pair", () => {
  for (const [i, file] of FONTS.slice(0, 2).entries()) {
    const font = metrics(file)
    for (const [a, z] of [['1', 'ï'], ['ĩ', 'ï'], ['і', 'ї'], ['T', 'o'], ['A', 'V'], ['t', 'y'], ['d', ')'], ['ď', ')']]) {
      const sum = font.advance(a.codePointAt(0)) + font.advance(z.codePointAt(0)) + font.advance(0x48) + font.kern(a, z) + font.kern(z, 'H')
      assert.ok(Math.abs(measure(`${a}${z}H`, i === 1) - sum) < 0.001, `${i} ${a}${z}`)
    }
    assert.ok(font.kern('1', 'ï') > 0.05 && font.kern('T', 'o') < 0)
    // and the forms Inter's contextual lookups draw a glyph as kern too: "(" after a capital is its case form, kerned
    // wider before "Ï" than "(" is
    assert.ok(font.kern('(', 'Ï', true) > font.kern('(', 'Ï') + 0.02 && font.kern('T', 'o', true) >= font.kern('T', 'o'))
  }
})

test("a run past the budget is guessed, and the guess is never less than resvg's own advance", async () => {
  const inter = metrics(FONTS[0])
  // wide punctuation, fancy-text letters, arrows, numerals, digraphs, marks alone, Inter's widened forms, scripts no
  // font has, and a sample of everything Inter draws
  const runs = ['—————', '……', 'ⓌⒶⓋⒺ', '‱', '⟷⟺', 'Ⅷ', 'Ǳ', cp(0x20dd), 'ïïï ĩĩ īĭ', 'Đđď', 'WWW MMM', '漢字かな', 'नमस्ते', 's̶t̶r̶i̶k̶e̶', 'Z̷̢͎a̸͓l̴̰g̶̱o̵͚', 'a -> b', '*#*', 'A*B*C', 'a_b_c', 'ïïï', 'T_T', 'AVA', '(f)', 'office', 'नमस्ते दुनिया', 'สวัสดีครับ', ' नमस्ते दोस्तों ', ' g̶m̶ ', `z${cp(0x324, 0x308)}`, `ab${cp(0x336).repeat(6)}`, `a${cp(0xfff9)}b${cp(0xfffa)}c${cp(0xfffb)} `, cp(0x600, 0x6dd), cp(0x1bca0, 0x1bca3), `gm${cp(0x3164).repeat(5)}gn`, cp(0x115f, 0x1160, 0xffa0), `mm${cp(0x336, 0x20dd, 0x20dd)}`, `a${cp(0x20dc)}`, `=a${cp(0x20dc)}`, `a${cp(0x20db)}`, `a${cp(0x20e8)}`]
  for (let c = 0x21; c < 0x10000; c += 7) if (inter.glyph(c) && !/[\p{Cc}\p{Cs}]/u.test(cp(c))) runs.push(cp(c, c, c))
  // alone and between letters: the ideographic space (a full em, not a box), arrows no font has that resvg draws as
  // Inter's arrow with a slash through it, marks newer than resvg's Unicode (a box each, like a letter), and the
  // Mongolian variation selector it draws as a box on the letter before it
  for (const c of [0x3000, 0x219a, 0x219b, 0x21ae, 0x21cd, 0x21ce, 0x21cf, 0x897, 0x180f, 0x10d69, 0x113b8, 0x1611e, 0x1e6f5]) runs.push(cp(c), `a${cp(c)}b`)
  // (the 16 and 17 marks listed, not found with the runtime's \p{M}, which may not know them)
  for (const [from, to] of [[0x1acf, 0x1add], [0x1ae0, 0x1aeb]]) for (let c = from; c <= to; c++) runs.push(`a${cp(c)}b`)
  // Thai and Lao sara am, two boxes of ink on one box of advance at a run's end (after a tone mark, alone, repeated,
  // after a space, in a run resvg doesn't shape as Thai), and the characters whose ink ends past their advance, ending
  // the run or before a space or hair space that ends it short of their ink
  runs.push('น้ำ', 'ก่ำ', 'ทำ', 'จำ', 'กำ', 'ກຳ', 'ນ້ຳ', 'ความจำ', 'ไม่ทำ', 'ำำำ', 'ำ', 'ຳ', 'น้ำใจ', 'ทำงาน', 'ก ำ', ' ำก', '1ำ', '—ำ', 'กaำ', 'aำ', 'a ทำก', 'ทำ a', 'กินน้ำ ', 'عربي ทำ', 'שלום ทำ', '١٢٣ทำ', 'abc عربي น้ำ')
  for (const c of [0x2044, 0x215f, 0xe2bf, 0xe2c0, 0xe2c1, 0xe2c2, 0xe2c3, 0xe2c4, 0xee07, 0xee0e, 0xee0f, 0xee90, 0xee9b, 0xee9c, 0xf6c3, 0x240, 0x260, 0x2a0, 0x308, 0x30f, 0x360]) runs.push(`a${cp(c)}`, `y${cp(c)}`, cp(c), cp(c, 0x20), cp(c, 0x200a), `a${cp(c, 0x200a)}`)
  // and the marks Inter draws wider than a narrow letter, with narrow letters or a space after them
  for (const c of [0x308, 0x30f, 0x313, 0x315, 0x32c, 0x343, 0x35d, 0x360, 0x361, 0x362]) runs.push(`i${cp(c)}i`, `l${cp(c)} `, `'${cp(c)} `, ` ${cp(c)}l`)
  // a wide mark after one no font has, set against the box that widens its letter
  for (const c of [0x20db, 0x20dc, 0x20e8]) for (const box of [0xe31, 0xe48, 0x336]) runs.push(`a${cp(box, c)}`, ` ${cp(box, c)}`)
  // or after sara am's boxes, and bold "ɀ" after marks
  runs.push(`ก${cp(0xe33, 0x20dc)}`, `${cp(0xe33, 0x20dc)}x`, `ท${cp(0xe33, 0x20dc)}ก`, `${cp(0x313, 0xe31)}a${cp(0x240)}`, `${cp(0x336, 0x362, 0x240)}`)
  // right-to-left letters with marks no font has or sara am: resvg shapes each stretch of one direction apart (a
  // Devanagari vowel sign is a left-to-right letter, a box of its own after Hebrew; sara am is shaped as Thai on one side
  // of Hebrew and not on the other), by Unicode 15.0's bidi classes (U+0897 an Arabic letter, U+2FFC left to right); a
  // right-to-left stretch's first letter's boxes end at its right, a stretch shaped right to left (an Arabic digit
  // first) sets them past a letter's ink, and a mark Inter has on nothing there sticks out further. Explicit embeddings
  // and overrides, and Hebrew and Arabic with their points and harakat, too.
  runs.push(`ع${cp(0xe31)}ע`, `ע${cp(0x93f)}`, `a${cp(0xe33)} עברית น้ำ`, `ע${cp(0x93f)} a`, `a${cp(0x897)}ع${cp(0xe31)}`, `ع${cp(0xe31, 0x2ffc)}ע`, `ع${cp(0xe31, 0x2ff0)}ע`)
  runs.push(`${cp(0x6f4)}2${cp(0x940)}`, `${cp(0x66a)}ɀ${cp(0x940)}`, `${cp(0x6f4)}Ƈ${cp(0x651)}`, `${cp(0x200f)}.${cp(0x64b)}ع`, `${cp(0x200f)}.${cp(0x64b, 0x64b)}ع`, `${cp(0x200f, 0x323)}ב`, `${cp(0x200f, 0x1dff)}ב`, `${cp(0x20dd, 0x200f)}!${cp(0x730)}م${cp(0x336)}`)
  runs.push(`ع${cp(0x202e)}a${cp(0x336)}b${cp(0x202c)}`, `ר${cp(0x2067, 0x902)}،${cp(0x93e, 0x66a)}`, 'שָׁלוֹם', 'מִשְׁפָּט טוֹב', 'مَرْحَبًا بِكُمْ', `שָׁ${cp(0x941)}ל`)
  // and a mark no font has after a character resvg leaves out (other than a joiner) is a box on nothing
  runs.push(`a${cp(0x200b, 0x902)}`, `ไ${cp(0x200e, 0x902)}ใ`, `a${cp(0xfeff, 0x336, 0x336)}`, `ท${cp(0x200b)}ำ`, `a${cp(0x200c, 0x902)}`)
  // two or more of them on nothing are at least a box; shaped right to left (Samaritan, Syriac or Arabic marks or
  // Persian digits first), such a character may or may not start a cluster, and marks before a stretch's first cluster
  // may or may not join the cluster after them
  runs.push(cp(0x82a, 0x3b1, 0xfeff, 0xe48, 0x823), cp(0x817, 0x3b1, 0x41, 0x4d, 0x642), cp(0x336, 0x6f5, 0x57), cp(0x1ab0, 0x6f7, 0x2029), cp(0x817, 0xfeff, 0x336), cp(0x740, 0x56, 0x44f, 0x200d, 0x56), cp(0x817, 0x41, 0x42))
  runs.push(cp(0x817, 0x336, 0xfeff, 0x64c, 0x826), cp(0x652, 0x819, 0x200c, 0x747), cp(0x736, 0x59a, 0x200e, 0x5ac), cp(0x82b, 0xe48, 0xfe0f, 0x2060, 0x1ab0), cp(0x327, 0x200c, 0x34f, 0x737), cp(0x20e8, 0x200c, 0x82c), cp(0x1ab0, 0x659, 0x5b8, 0xad, 0x5ab, 0x5ab, 0x200f))
  runs.push(cp(0x1dff, 0x6f5, 0x7eb, 0x2801), cp(0x336, 0x81c, 0x69, 0x301), cp(0x323, 0x6f4, 0x302f, 0x2f, 0x597, 0x34, 0x6f4, 0x3b1, 0x5e0), cp(0x1dff, 0x66a, 0x5a8, 0x6f4, 0x240, 0x21, 0x35, 0x31, 0x5d9, 0x66c, 0x64a, 0x200d))
  // and a right-to-left mark before two such marks, an Arabic one among them, and a digit or a right-to-left letter
  for (const lead of [[0x336, 0x6d6], [0x64b, 0x6d6], [0x651, 0x6d6], [0x6d6, 0x336], [0x6d6, 0x6d6]]) for (const t of ['1', '12', '٣', 'א', 'ع', '1א']) runs.push(cp(0x200f, ...lead) + t)
  // and turned runs with sara am, which the shaper turns into letters before the stretch is laid out
  runs.push(cp(0x31, 0x66, 0x628, 0xeb3, 0x20dd, 0x35c, 0x360, 0x360), cp(0x69, 0x5d0, 0x7b, 0x37, 0xeb3, 0x20dc), cp(0x29, 0x915, 0x5d0, 0xeb3, 0x74), cp(0x41, 0x57, 0x6a, 0xe01, 0x202c, 0x1e900, 0xe33, 0x69))
  // and two boxes opening a run, which take a box's width, before narrow characters and a mark Inter has at the end
  runs.push(`${cp(0xe31, 0xe48)} ${cp(0x308)}`, `${cp(0x940, 0x940)}4${cp(0x200d)} ${cp(0x308)}`, `${cp(0xe38, 0xe38)}%${cp(0x360)}`, `${cp(0x94d, 0x902)}+${cp(0x360)}`, `${cp(0x93e, 0x6d6)}l${cp(0xe81)},%${cp(0x308)}`)
  // an enclosing mark Inter has under boxes, sara am before a letter whose ink reaches left, and a keycap mark opening a
  // run, which has resvg draw the whole run in Noto Emoji when Noto has every character of it (digits, "#", a space)
  runs.push(cp(0x20dd, 0x336, 0x336), 'จำj', `${cp(0x20e3)}7`, `${cp(0x20e3)}#`, `${cp(0x20e3)} 7`, `7 ${cp(0x20e3)}`, `${cp(0x20e3, 0xfe0f)}7`, `${cp(0x20e3)}0123456789#*`, `${cp(0x20e3)}7a`, `${cp(0x20e3, 0x200b)}77`)
  // with the other spaces in it, which Noto draws with its own space glyph at their width (but not with a variation
  // selector after them, which it has no glyph for)
  for (const c of [0xa0, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x202f, 0x205f, 0x3000]) runs.push(cp(0x20e3, c, 0x37), cp(0x20e3, 0x37, c, 0x23), cp(0xfe4e5, c, 0x37), cp(0x20e3, c, 0xfe0f), cp(0x20e3, c, 0xfe0e, 0x37))
  // or with a keycap mark or a skin tone after one, even past an ignorable, which can have resvg draw Inter's wider
  // spaces instead
  const n = (c, k) => Array(k).fill(c)
  runs.push(cp(...n(0x2001, 13), 0x1f3fb), cp(0x2001, 0x20e3, ...n(0x2001, 12)), cp(...n(0x2001, 12), 0x2000, 0x1f3fb, ...n(0x2000, 12)), cp(...n(0x2001, 13), 0x200d, 0x20e3), cp(...n(0x2000, 13), 0x200b, 0x1f3ff), cp(0x20e3, 0x37, ...n(0xa0, 13), 0x20e3))
  // a box mark before an orphaned private-use glyph, and a keycap mark after a symbol past a bidi isolate
  runs.push('Tf' + cp(0x360, 0xee90), '*' + cp(0x2066, 0x20e3))
  // sara am before right-to-left text, its ink under the next stretch's text; a box mark on a space in right-to-left
  // text; isolates and embeddings, with right-to-left text in them or around them or none; and characters newer than
  // resvg's scripts (Unicode 16's), which don't decide how a stretch is shaped;
  runs.push(...SARA_AM_BEFORE_RTL, ...BOX_ON_RTL_SPACE, ...RTL_ISOLATED, ...LTR_ISOLATED, cp(0x2068, 0x41, 0xe33, 0xe33, 0x20, 0x2069, 0xeb3, 0x336), cp(0x6cc, 0x113b8, 0xeb3), cp(0x5d0, 0x897, 0x11f5a, 0xe33, 0xeb3, 0xe33), cp(0x113b8, 0xe33))
  // brackets after an isolate, with left-to-right then right-to-left text before it: unicode-bidi looks back for the
  // direction they take over the level run before the isolate read forwards (the "a"), so they're set left to right
  runs.push(`gm ש ${cp(0x2068)}@bob${cp(0x2069)} (שלום)${cp(0x336)}`, `aש${cp(0x2066)}x${cp(0x2069)}(ב)${cp(0x336)}`, `aש${cp(0x2066)}x${cp(0x2069)}(בָ)${cp(0x6db)}`, `aש${cp(0x2066)}x${cp(0x2069)}(1)${cp(0x902)}`)
  // a mark newer than resvg's Unicode data (U+0897) before a fatha, which it doesn't reorder past it, so the fatha stays
  // apart from the letter (in an override or embedding, and with none), and a tab past an isolate, which resvg draws as
  // a space before bidi rather than as a segment separator
  runs.push(cp(0x6c, 0x897, 0x64e, 0x202d, 0x6c, 0x30c), cp(0x6c, 0x897, 0x64e, 0x202b, 0x6c, 0x30c), cp(0x61, 0x897, 0x64e, 0x202d, 0x6c, 0x30c), cp(0x6c, 0x30c, 0xad, 0x20, 0x897, 0x670, 0x7ca), cp(0x2068, 0x3009, 0x336, 0x20, 0x6db, 0x9, 0x5d0))
  // a mark resvg doesn't know between a dot above and a mark NFD would put first, which keeps the dot on the "l" (drawn
  // "ŀ"), with an embedding and without; left-to-right letters overridden right to left after Arabic or a digit, whose
  // kerning and composing resvg takes from the stretch's first script; and a caron past an empty isolate in Hebrew text
  runs.push(cp(0x6c, 0x307, 0x897, 0x334, 0x6c), cp(0x202a, 0x6c, 0x307, 0x897, 0x334, 0x6c), cp(0x628, 0x202e, 0x234, 0x6a), cp(0x628, 0x202e, 0x76, 0x234, 0x191), cp(0x202e, 0x639, 0x64e, 0x234, 0x6a), cp(0x661, 0x202e, 0x30c, 0x6c))
  // and brackets in them, which resvg mirrors; and left-to-right letters after a digit or a letter that has resvg shape the
  // stretch they're in right to left, in an embedding, an isolate or an override, kerned in the shaper's order (set left
  // to right, so kerned the other way round: "}" "ď" after a box mark as "ď}")
  runs.push(cp(0x202e, 0x48, 0x5b, 0xcf, 0x5d), cp(0x202e, 0xcf, 0x5d), cp(0x202e, 0x48, 0x7b, 0xcf, 0x7d), cp(0x202b, 0x661, 0x6a, 0x234), `ש ${cp(0x2067, 0x661, 0x6a, 0x234, 0x2069)}`, `ש${cp(0x202b, 0x661, 0x662, 0x6a, 0x234, 0x202c)} ok`, cp(0x202d, 0x628, 0x6a, 0x234), cp(0x661, 0x202d, 0x6a, 0x234), cp(0x202d, 0x5e9, 0x6a, 0x234), cp(0x202d, 0x6db, 0x7d, 0x10f))
  runs.push(cp(0x6c, 0x2066, 0x2069, 0x30c, 0x6c, 0x5e9), cp(0x64, 0x2066, 0x2069, 0x30c, 0x5d, 0x5e9), cp(0x6c, 0x2066, 0x2069, 0x307, 0x6c, 0x5e9))
  // a vertical tab and U+001F, which measure() strips, so they don't separate segments; and an en dash with an angle
  // bracket in a stretch shaped right to left, which mirrors the bracket into Inter's long arrow
  runs.push(cp(0x2067, 0x2c, 0xe33, 0x30c, 0xb, 0x5e9, 0x2c), cp(0x2067, 0x2c, 0xe33, 0x30c, 0x1f, 0x5e9, 0x2c), cp(0x202b, 0x2c, 0xe33, 0x30c, 0xb, 0x5e9, 0x5e9))
  // and a caron joined to an "l" past an unmatched PDF and an LRE, in an RLI, which leave both at the same level
  runs.push(cp(0x2067, 0x6c, 0x202c, 0x202a, 0x30c, 0x6c, 0x5e9), cp(0x5e9, 0x20, 0x6c, 0x202c, 0x202a, 0x30c, 0x6c))
  runs.push(cp(0x202d, 0x5d1, 0x2013, 0x3c, 0x5e9), cp(0x202b, 0x661, 0x3e, 0x2013), cp(0x5e9, 0x2067, 0x661, 0x2013, 0x3c, 0x5e9), cp(0x202d, 0x628, 0x2013, 0x3c), cp(0x202d, 0x661, 0x3e, 0x2013))
  // and a number after a letter resvg's Unicode hadn't assigned in a newer Arabic block, which it takes as right to left,
  // not Arabic, so the number stays a European one
  runs.push(cp(0x10ec2, 0x36, 0xb0, 0xe33, 0x1ed01), cp(0x897, 0x36, 0xb0, 0xe33, 0x1ed01), cp(0x88f, 0x36, 0xb0, 0xe33, 0x10d28))
  // and a number after Arabic letters with harakat, which bidi draws before them, so a haraka's box ends the run: a
  // number on its own, and in brackets, which take the direction of the letters before them; Hebrew with points too
  runs.push(...RTL_BEFORE_NUMBERS)
  // marks no font has opening a run resvg shapes right to left (the first of any script is Arabic, Samaritan, Hebrew):
  // each letter drawn past its own boxes, and a letter composed with its mark ("ĺ") past the opening boxes too, which
  // a precomposed letter ("ï" as one character) is as well: it's shaped as its letter and marks, which can be wider
  // than it ("î")
  for (const lead of [[0x6d6, 0xe48], [0x64b, 0x6d6], [0x336, 0x6d6], [0x6d6, 0x336], [0x6d6], [0x816], [0x5b4, 0x5b4], [0x6d6, 0x5b4]]) {
    for (const t of [`i${cp(0x308)}`, `l${cp(0x301)}`, `a${cp(0x301)}`, `l${cp(0x301)}x`, `c${cp(0xe48)}`, `f${cp(0x331)}`, `a${cp(0xe48)}a${cp(0xe48)}`, `a${cp(0xe48, 0x301)}`, cp(0xef), cp(0x13a), cp(0xe1), cp(0xe9), `${cp(0x13a)}x`, cp(0x1d8), cp(0xee), cp(0x1f0), cp(0x135), cp(0xce), cp(0x1cf), cp(0x1fd2)]) runs.push(cp(...lead) + t)
  }
  runs.push(`1${cp(0x6d6)}c${cp(0xe48)}`)
  // a skin tone outside an emoji: one more box after sara am's or a struck-through letter's, two after a symbol under a
  // box, and Noto Emoji's glyphs for it and the digits, spaces and symbols around it
  for (const t of [0x1f3fb, 0x1f3ff]) {
    runs.push(`ท${cp(0xe33, t)}`, `27${cp(0xfe82c, 0x336, t)}`, `น้${cp(0xe33, t, 0x336)}`, `ท${cp(0xe33, t, 0xe33)}`, `a${cp(0x336, 0x336, t, 0x336)}`, cp(0x2764, 0x336, t))
    runs.push(cp(0x2764, 0xe33, t), cp(0x2764, t), `27${cp(t)}`, ` ${cp(t)}`, `${cp(t)}   `, `${cp(t)}777`, `a${cp(0x200b, t)}`, `7${cp(0xfe0f, t)}`)
  }
  // marks no font has with no base before them: after an invisible character resvg starts a new cluster at (a box of
  // their own, not one on the letter before), once and repeated, and two or more opening a run
  const AM = cp(0xe33)
  for (const z of [0x200b, 0x200c, 0x2060, 0xad, 0xfeff, 0x61c, 0x200e, 0x2066, 0xe0001]) {
    for (const m of [cp(0xe4a), cp(0x336), cp(0xe48, 0xe4a), cp(0x336, 0x336)]) runs.push(`ค${cp(z)}${m}`, `a${cp(z)}${m}`, `a${cp(z)}${m}b`, `ค${cp(z)}${m}`.repeat(3), `a${cp(z)}${m}`.repeat(3))
    runs.push(`ค${cp(z)}${AM}`, `ค${cp(z, 0xe48)}${AM}`, `a${cp(z)}${AM}`, `${cp(z)}${AM}ก`)
  }
  runs.push(`${cp(0xe49, 0xe48)}ba`, `${cp(0xe48, 0xe35)}a${cp(0xe35, 0xe38)}${AM}${cp(0xe31, 0xe31)}`, `${cp(0xe48, 0xe48, 0xe48)}ba`, `${cp(0x336, 0x336)}ba`)
  // (where resvg doesn't cut: a mark with no base after an Arabic letter mark stays on the box mark past a break)
  runs.push(cp(0x61c, 0x301, 0x200c, 0xe49), cp(0x61c, 0x362, 0x200b, 0xe4a), cp(0x61c, 0x301, 0x200b, 0xe4a, 0x62))
  // and sara am after them
  for (const k of [1, 2, 3, 5, 7]) runs.push(`${cp(0xe48).repeat(k)}${AM}`, `${cp(0xe48).repeat(k)}${AM}ba`, `${cp(0x200b)}${cp(0x336).repeat(k)}${AM}`, `ค${cp(0x200b)}${cp(0xe48).repeat(k)}${AM}`, `${cp(0x336).repeat(k)}${AM}ก`)
  // marks Inter has that nothing anchors, so resvg draws them after the pen with their ink reaching right, before a
  // narrow character: opening a run, after an invisible character resvg starts a new cluster at, on a digit, "#", a
  // letter of a script Inter lacks or an emoji, in Cyrillic and Greek text (Inter positions no marks there), stacked on
  // each other (U+035E goes well right of the U+0308 under it), out of their canonical order, decomposing into another
  // mark, after a mark Inter doesn't call one, and after a joiner, a variation selector or a tag (no "Ӝ" then, and
  // nothing to go on after a joiner, a Mongolian variation selector or a tag)
  for (const z of [0x200d, 0xfe0f, 0xfe00, 0x34f, 0x180b, 0xe002a, 0xe0037, 0xe0100]) for (const p of ['a', 'x', 'Ж', '1', `a${cp(0x308)}`, `1${cp(0x302)}`, `1${cp(0x308)}`]) runs.push(`${p}${cp(z, 0x308)} `, `${p}${cp(z, 0x302)}i`, `${p}${cp(z, 0x35e)} `)
  for (const m of [0x302, 0x308, 0x301, 0x313, 0x343, 0x35e, 0x1dcd, 0x20db]) {
    for (const p of ['', '1', '#', `#${cp(0x200b)}`, `a${cp(0x200b)}`, 'ก', 'क', cp(0x231a), ' ', '.', 'Ж', 'α', 'aЖ', 'Жx', `i${cp(0x488)}`, cp(0x308), `1${cp(0x308)}`]) for (const s of ['', ' ', 'i', '.']) runs.push(`${p}${cp(m)}${s}`)
  }
  runs.push(`1${cp(0x302)} `, `#${cp(0x200b, 0x308)}i`, `${cp(0x308)}i`, `${cp(0x302, 0x308)}i`, `1${cp(0x308, 0x35e)} `, `1${cp(0x35e, 0x308)} `, `1${cp(0x308, 0x35e, 0x1ddf)} `, `क${cp(0x35e, 0x302, 0x1de0)}l`, `Ж${cp(0x302, 0x308)} `, `ä${cp(0x308)}i`, `a${cp(0x336, 0x302)} `)
  // such a mark in a run bidi turns around is drawn after what follows it: a right-to-left mark, Arabic letter mark,
  // embedding, override or isolate before it, or a right-to-left letter in the run; and one repeated on a digit
  for (const o of [0x200f, 0x61c, 0x202b, 0x202e, 0x2067]) for (const m of [0x302, 0x308, 0x30f]) runs.push(`${cp(o, m)}1`, `a${cp(o, m)}1`, `${cp(o, 0x200b, m)}i${cp(0x202c)}`)
  runs.push(`${cp(0x2067, 0x302)}i${cp(0x2069)}`, `א${cp(0x308)}1`, `${cp(0x5d0, 0x20, 0x308)}.`, `1${cp(0x302).repeat(300)} `)
  // and stacked after a bidi control that follows a Cyrillic or Greek letter: after an isolate, an embedding, an
  // override, a right-to-left mark or an Arabic letter mark, resvg shapes the marks apart from the letter and stacks
  // them further right than the letter's script would
  runs.push(cp(0x431, 0x2067, 0x308, 0x35e), cp(0x431, 0x2066, 0x308, 0x35e), cp(0x416, 0x200f, 0x6c, 0xe01, 0x35e, 0x308))
  for (const l of [0x431, 0x416, 0x3c9]) for (const o of [0x2066, 0x2067, 0x2068, 0x200f, 0x61c, 0x202a, 0x202b, 0x202d, 0x202e]) for (const [m, n] of [[0x308, 0x35e], [0x35e, 0x308]]) runs.push(cp(l, o, m, n), cp(l, o, m, n, 0x6c))
  // a mark after an ignorable that cuts it off the letter before it (a non-joiner, a bidi isolate's end, a soft hyphen
  // before sara am)
  runs.push('g' + cp(0x200c, 0x20e0), cp(0x2199, 0x2066, 0x20e0) + '*', 'A1' + cp(0x2069, 0x336, 0xae), '_' + cp(0x2069, 0x336) + '52' + cp(0xfe0e, 0x2069) + ' ', cp(0x2044, 0xad, 0xe33) + '73')
  // text resvg lays out right to left, its clusters reversed, so the first one can end the run: after a right-to-left
  // override (letters struck through, marks no font has with no base and on one, a digit, a slash or private-use glyph
  // with one, or reaching past its advance, Inter's wide marks), in an embedding or isolate, and Arabic with its marks
  const RLO = cp(0x202e)
  runs.push(`${RLO}s̶t̶`, `a${RLO}s̶t̶`, `a${RLO}${cp(0xe48, 0xe4a)}b`, `a${RLO}${cp(0xe31).repeat(3)}b`, `a${RLO}b${cp(0xe4a)}c`, `a${RLO}b${cp(0xe4a, 0xe4a)}c`, `a${RLO}${cp(0xe48, 0xe4a, 0xe48, 0xe4a)}b`)
  for (const b of ['1', '/', '_', '→', cp(0x2044), cp(0xe2c2), cp(0xee90)]) runs.push(`${RLO}${b}${cp(0x336)}`, `a${RLO}${b}${cp(0x336, 0x336)}bc`)
  runs.push(`a${RLO}${cp(0x2044)}bc`, `a${RLO}${cp(0xe2c2)}bc`, `a${RLO}f${cp(0x360)}bc`, `a${RLO}a${cp(0x20dc)}bc`, `a${RLO}i${cp(0x20dc)}bc`)
  for (const e of [cp(0x202b), cp(0x2067)]) runs.push(`a${e}${cp(0x660)}s${cp(0x336)}`, `${e}${cp(0x2044, 0x336)}b`, `a${e}${cp(0xe48, 0xe4a)}b`, `a${e}${cp(0xe31).repeat(3)}b`)
  runs.push('مَرْحَبًا', 'aمَرْحَبًاb', 'שָׁלוֹם')
  // and everyday words with harakat or points, each a box on its letter (once 0.44 em short: "قُرْآن", "مَرْحَبًا"),
  // with a shadda or dagesh doubling a letter, and a word or two after
  runs.push('قُرْآن', 'قُرْان', 'ٱلْقُرْآن', 'كِتَابٌ', 'شُكْرًا', 'مُحَمَّدٌ', 'ٱللَّهِ', 'إِنْ شَاءَ ٱللَّهُ', 'اَلسَّلَامُ عَلَيْكُمْ', 'قُرْآنٌ كَرِيمٌ', 'أَهْلًا وَسَهْلًا')
  runs.push('תּוֹרָה', 'בְּרֵאשִׁית', 'יִשְׂרָאֵל', 'חַיִּים', 'סֵפֶר', 'תּוֹדָה רַבָּה')
  // spacing marks no font has (Devanagari's vowel signs) after right-to-left letters, an Arabic digit or "." in an
  // embedding, and two clusters' ink past their room adding up
  runs.push(cp(0x5d0, 0x93f, 0x5d1, 0x93f, 0x5d2, 0x93f), cp(0x627, 0x93f, 0x4e00, 0x336), `${cp(0x202b)}${cp(0x660, 0x93f)}`, `${cp(0x202b)}.${cp(0x93f, 0x93f)}`)
  runs.push(`${RLO}${cp(0x336, 0x336)}«${cp(0xe48)}`, `${RLO}${cp(0x336, 0x336)}.${cp(0xe48)}`, cp(0x5c1, 0x941, 0x202e))
  // an acute, a diaeresis, sara am or two strikes after a right-to-left control (with "i" between too), found short by
  // other tickets' sweeps
  runs.push(`_${cp(0x2067, 0x301)}®`, `W${cp(0x202e, 0x301)}52`, `A1${cp(0x2067, 0x301)}W`, `g${cp(0x2067, 0x308)}®`)
  // marks no font has with nothing under them, a Hebrew point (U+05C1, U+059A, U+05AD) first, before a bidi control, a
  // left-to-right mark, a word joiner, a soft hyphen, a non-joiner or an isolate at the run's end: resvg draws each box a
  // whole box past the last
  for (const z of [0x202a, 0x202c, 0x200e, 0x2060, 0xad, 0x200c, 0x2066, 0x2069]) runs.push(cp(0x5c1, 0x941, 0x93f, z), cp(0x5c1, 0x941, z), cp(0x5c1, 0x93f, z), cp(0x59a, 0x941, z), cp(0x5ad, 0x93f, z), cp(0x5c1, 0x941, 0x941, 0x941, z), `a${cp(0x200b, 0x5c1, 0x941, z)}`)
  for (const o of [0x202e, 0x2067, 0x202b, 0x200f, 0x61c]) runs.push(`1${cp(o, 0xe48, 0xe33)}73`, `*${cp(o, 0xe33)}73`)
  for (const o of [0x202e, 0x202b, 0x2067]) runs.push(`${cp(o, 0x336, 0x336)}i`, `a${cp(o, 0x336, 0x336)}i`, `a${cp(o)}i${cp(0x336, 0x336)}`)
  runs.push(`${cp(0x2067, 0x335, 0x335)}i`)
  // (a spacing mark after a right-to-left letter in an embedding or isolate is a box of its own, not one widening it)
  runs.push(cp(0x202b) + cp(0x5e2, 0x93f).repeat(8), cp(0x2067) + cp(0x628, 0x940).repeat(8), cp(0x5e2, 0x202b) + cp(0x5e2, 0x903).repeat(4))
  // a box mark on a letter Inter kerns wider after "l" (resvg kerns the box-wide letter too), also as a character drawn
  // as that letter once a mark is on it ("ΐ" as "ΐ", the Greek varia as a wider "`")
  runs.push(cp(0x6c, 0x1fd3, 0x345, 0x20), cp(0x6c, 0x390, 0x345, 0x20), cp(0x6c, 0x3ca, 0x345, 0x20), cp(0x6c, 0xef, 0x345, 0x20), cp(0x6c, 0x390, 0x345), cp(0x6c, 0x1fef, 0x345), cp(0x69, 0x1ffd, 0x336))
  // decomposed text (as macOS file names have it), whose letters and marks resvg composes into letters Inter draws
  // wider than the two: "l" and a caron are drawn "ľ", Slovak and Czech words, the same with marks in another order or
  // through a singleton ("Ω" and an acute tone mark are drawn "Ώ"), and the caron after "d", "l", "t" (and the acute on
  // "ϒ") that Inter draws as the composed letter's past an ignorable between them too
  runs.push(`l${cp(0x30c)}x`, `d${cp(0x30c)}x`, `l${cp(0x30c)} x`, `t${cp(0x30c)}ah`, `${cp(0x3d2, 0x301)}x`, `${cp(0x3a5, 0x301)}x`, `${cp(0x395, 0x313, 0x301)}x`, `${cp(0x3a9, 0x341)}x`, `a${cp(0x302, 0x323)}x`)
  for (const w of ['ľúbiť ťava ďakujem', 'Ďábel ťuk ľad', 'příliš žluťoučký kůň', 'Ύψος ϓ']) runs.push(w.normalize('NFD'))
  for (const [l, m] of [[0x64, 0x30c], [0x6c, 0x30c], [0x74, 0x30c], [0x3d2, 0x301], [0x3d2, 0x341]]) for (const between of [0x34f, 0xfe0f, 0x200d, 0x200b, 0x2060, 0xad, 0x200e]) runs.push(`${cp(l, between, m)}x`, `${cp(l, between, m)}ah`)
  // (and with a mark no font has after them, or between them, which stays a box beside the composed letter)
  for (const [l, m] of [[0x64, 0x30c], [0x6c, 0x30c], [0x74, 0x30c], [0x3a5, 0x301]]) for (const box of [0x1acf, 0x1ad0, 0x1ad9, 0x113d2, 0x11b61]) runs.push(`${cp(l, m, box)}x`, `${cp(l, m, box)}ah`, `${cp(l, box, m)}x`)
  // a letter and a mark Inter's ccmp joins into a wider character NFC doesn't compose them into: "l" and a dot above are
  // drawn "ŀ", "ı" and a tilde "ĩ" (kerned after "f"), past an ignorable between them too, and with marks the shaper puts
  // after the first
  runs.push(cp(0x6c, 0x307, 0x78), cp(0x6c, 0x307, 0x6e), cp(0x6c, 0x307, 0x72), cp(0x328, 0x20, 0x6c, 0x307, 0x72, 0x644, 0x6c), cp(0x6c, 0x307, 0x76), cp(0x6c, 0x307, 0x301, 0x78), cp(0x6c, 0x307, 0x307, 0x78), cp(0x6c, 0x307, 0xfe0f, 0x78))
  for (const between of [0x34f, 0xfe0f, 0x200d, 0x200b, 0x2060, 0xad, 0x200e, 0x202c, 0x2069]) runs.push(`${cp(0x6c, between, 0x307)}x`, `T${cp(0x6c, between, 0x307)}v`)
  for (const m of [0x303, 0x304, 0x306, 0x308]) runs.push(`f${cp(0x131, m)}x`, `f${cp(0x131, m)}n`, `T${cp(0x131, m)}v`)
  // (but not "e" or "o" and U+1DC4 with a joiner between them, where U+1DC4 is drawn at its own advance, after a pair
  // that does join: "l" a dot above "o" U+200D U+1DC4 is "ŀo᷄", not "ŀṓ"; past other ignorables beside the joiner too)
  for (const l of [0x65, 0x6f]) for (const g of [[0x200d], [0x200b, 0x200d], [0x200d, 0x34f], [0xfe00, 0x200d], [0x200d, 0x200e]]) for (const m of [[0x1dc4], [0x1dc4, 0x301], [0x1dc4, 0x1dc6]]) runs.push(cp(0x6c, 0x307, l, ...g, ...m), `T${cp(l, ...g, ...m)}T${cp(0x6c, 0x307)}`, cp(0x131, 0x303, l, ...g, ...m, 0x6c, 0x307))
  runs.push(cp(0x6c, 0x307, 0x65, 0x200d, 0x1dc6), cp(0x6c, 0x307, 0x6f, 0x200d, 0x1dc6), cp(0x6c, 0x307, 0x6f, 0x34f, 0x1dc4))
  // (but not after a PDF or PDI that closes an embedding or isolate opened before the letter: drawn apart, beside a
  // letter that composes)
  for (const [open, close] of [[0x202a, 0x202c], [0x202d, 0x202c], [0x2066, 0x2069], [0x2068, 0x2069]]) runs.push(cp(open, 0x6c, 0x30c, 0x131, close, 0x308), cp(open, 0x6c, 0x30c, 0x6c, close, 0xf6c3), cp(open, 0x6c, 0x30c, 0x61, close, 0xee90), cp(open, 0x6c, 0x30c, 0x131, close, 0x30f))
  // a strike after an ignorable that cuts it off a space or symbol, with variation selectors after it and a narrow
  // space or letter next: a whole box after the space, not the box widening it
  runs.push(cp(0x205f, 0x2060, 0x336, 0xfe0f, 0xfe0f, 0x2009))
  for (const z of [0x2060, 0x200b, 0x200c, 0xad, 0xfeff, 0x180e, 0xe0001, 0x200e, 0x202a, 0x202d, 0x2066, 0x2069]) {
    for (const s of [' ', cp(0x205f), cp(0x2009), cp(0x3000), cp(0xa0), '#', '-', '*', '→', '']) runs.push(`${s}${cp(z, 0x336, 0xfe0f, 0xfe0f, 0x2009)}`, `${s}${cp(z, 0x336, 0x336)}i`, `${s}${cp(z, 0xfe0f, 0x336)}x`)
  }
  // a tone mark Inter draws as its grave or acute, or an arrow as one with a slash through, in a cluster with a variation
  // selector anywhere in it: the shaper decomposes nothing there, so the mark is a box widening a narrow letter
  for (const v of [0xfe00, 0xfe05, 0xfe0f, 0xe0100, 0xe0124, 0xe01ec]) {
    for (const m of [0x340, 0x341, 0x344]) for (const p of ['I', 'a', 'l', '']) runs.push(`${p}${cp(m, v)}x`, `${p}${cp(v, m)}x`, `${p}${cp(m, 0x301, v)}x`, `${p}${cp(0x301, v, m)}i`)
    runs.push(`a${cp(0x343, v)}i`, `I${cp(0x21ae, v)}x`)
  }
  // a mark nothing anchors after a letter drawn wider than it is (the Greek varia as "`", "l" and "d" with a caron as "ľ"
  // and "ď"), and before a letter Inter kerns wider after the one under it ("1ï", "ĩï", "ії"), which moves the mark
  // right with it ("I" U+0362 "ï"), or after one it kerns wider after the letter before ("lĩ")
  runs.push(cp(0x49, 0x362, 0xef), cp(0x212a, 0x362, 0xef), cp(0x6c, 0x1fef, 0x308, 0x35e), cp(0x64, 0x30c, 0x200d, 0x308, 0x69), cp(0x416, 0x64, 0x30c, 0x308, 0x69), cp(0x3b1, 0x6c, 0x30c, 0x308, 0x69), cp(0x6c, 0x30c, 0x200d, 0x308, 0x69), cp(0x416, 0x6c, 0x30c, 0x308))
  runs.push(cp(0x31, 0x308, 0xef), cp(0x31, 0x360, 0xef), cp(0x31, 0x30f, 0xef), cp(0x6c, 0x129, 0x200d, 0x308, 0xef), cp(0x416, 0x456, 0x308, 0x308, 0x457), cp(0x6c, 0x200d, 0x308, 0xef), cp(0x31, 0x308, 0x200b, 0xef), cp(0x6c, 0x1fef, 0x302, 0xef))
  // (a letter and a mark a joiner keeps apart may still be drawn as one, "і" U+200D U+0308 as "ї", kerned as that, and
  // a dotless "ı" with a mark above as the dotted letter with it, "ı" U+0308 as "ï")
  runs.push(cp(0xef, 0x456, 0x200d, 0x308, 0x308, 0xef), cp(0x456, 0x200d, 0x308, 0x308, 0xef), cp(0x3b1, 0x131, 0x308, 0x457, 0x308, 0xef), cp(0x3b1, 0x131, 0x308, 0x457, 0x360, 0xef), cp(0x31, 0x131, 0x303, 0x200d, 0x308, 0xef))
  // and a sample of the pairs Inter kerns wider, the mark at the pen of a digit or a letter in a Cyrillic run, or after
  // a joiner
  const kerned = []
  const chars = Array.from({ length: 0x600 - 0x21 }, (_, i) => cp(0x21 + i)).filter((c) => inter.glyph(c.codePointAt(0)) && /[\p{L}\p{N}\p{P}\p{S}]/u.test(c))
  for (const a of chars) for (const z of chars) if (inter.kern(a, z) > 0.05) kerned.push([a, z])
  for (const [a, z] of kerned.filter((_, i) => i % 50 === 0)) runs.push(a + cp(0x308) + z, `Ж${a}${cp(0x302)}${z}`, a + cp(0x200d, 0x360) + z)
  // two letters Inter kerns wider than the room the first gets ("ď" before closing brackets +0.13 em, "ȴ" before "j"),
  // alone, after a capital and among others, and a bracket next to a capital, which Inter draws as its case form and
  // kerns wider before "Ï" than the bracket; and a sample of those pairs, alone and after a capital
  runs.push('ď]', 'ď)', 'ď}', 'ȴj', 'ȴȷ', 'ȴј', 'Ŧῒ', 'Ɋǰ', 'ɖĵ', '1ИȋṰῒ', 'αȴʃ', 'Жȴɲ', 'HƫɏЋH', 'H(Ï', `H(${cp(0x308)}Ï`, 'H[Ï', 'H{Ï')
  for (const [a, z] of kerned.filter((_, i) => i % 7 === 0)) runs.push(a + z, `H${a}${z}`)
  // and bold "d" kerned +0.018 em past its room before a closing bracket, then a fraction slash, whose ink past its
  // advance leaves only 0.005 em of the slack a guess has (once short in #354); and the same between capitals and repeated
  runs.push('d]⁄', 'd)⁄', 'd}⁄', 'Hd]⁄H', 'd]⁄'.repeat(8))
  // (repeated in a right-to-left embedding, override or isolate, past the room such a run gets for its clusters)
  for (const o of [0x202b, 0x202e, 0x2067]) runs.push(cp(o) + 'ď]'.repeat(30), cp(o) + 'ȴj'.repeat(17))
  runs.push(cp(0x202a) + 'ď]'.repeat(15) + 'א', cp(0x202b) + cp(0x131, 0x308).repeat(40), cp(0x202b) + `l${cp(0x30c)}]`.repeat(20))
  // (and long, where each cluster laid out apart would lose the kerning to the next one: bold "ľ]" eighty times)
  runs.push(cp(0x202b) + 'ľ]'.repeat(80), cp(0x202e) + 'ľ]'.repeat(100), cp(0x2067) + 'ľ)'.repeat(80), cp(0x202b) + 'H(Ï'.repeat(120))
  // a letter Inter kerns wider on both sides at once, between letters that get no room of their own ("ĩ" after "f" and
  // before "T"), repeated too, also spelled as a dotless "ı" and the mark Inter's ccmp joins it with; and the others it
  // does that for, each between the characters that kern it most
  for (const c of 'ĩīĭïїȋḯ') for (const [x, y] of [['T', 'T'], ['f', 'T'], ['Ҥ', 'Ҡ']]) runs.push(x + c + y, x + c + y + c + y)
  for (const m of [0x303, 0x304, 0x306, 0x308]) for (const x of ['T', 'f']) runs.push(`${x}${cp(0x131, m)}T`, `${x}${cp(0x131, m)}T${cp(0x131, m)}T`)
  // a dotless "ı" with a mark above on it, anchored there in a Latin run, is drawn and kerned as the dotted letter with
  // that mark ("ı" U+0308 as "ï", wider against "ĩ" or "T"), repeated too; and "ȷ" with the same marks (ĵ, ǰ joined)
  for (const d of [0x131, 0x237]) for (const m of [0x308, 0x303, 0x304, 0x306, 0x302, 0x301, 0x30c]) runs.push(`H${cp(d, m)}ĩH`, `H${cp(d, m)}TH`, `H${cp(d, m, d, m, d, m)}ĩH`, `${cp(d, m)}ĩH`)
  // (and a dotted "i" or "j" with an ignorable before that mark, which keeps NFC from composing them, though Inter
  // still draws them dotless and joins them: "i", a grapheme joiner and a tilde are "ĩ" between the letters that kern it
  // wider; past each ignorable it joins past, repeated too, and "ĵ", "ǰ")
  for (const g of [0x34f, 0x200d, 0x200b, 0xad, 0x2060, 0xfe0f, 0x200e, 0x202c, 0x2069]) for (const m of [0x303, 0x304, 0x306, 0x308, 0x30f]) for (const [x, y] of [['f', 'T'], ['T', 'T'], ['7', '7'], ['1', '1']]) runs.push(`${x}${cp(0x69, g, m)}${y}`, `${x}${cp(0x69, g, m, 0x69, g, m)}${y}`)
  for (const m of [0x302, 0x30c]) for (const [x, y] of [['f', 'T'], ['T', 'T'], ['H', 'H']]) runs.push(`${x}${cp(0x6a, 0x34f, m)}${y}`, `${x}${cp(0x6a, 0x200d, m)}ĩ${y}`)
  // (and past an isolate or embedding closed as soon as it's opened, which the shaper joins them past too, in either
  // direction, with a joiner in it or another such pair: "f i" LRI PDI tilde "T" is "fĩT", "d" LRI PDI caron "]" is "ď]",
  // "l" LRE PDF dot above is "ŀ"; repeated, and after a ligature already in the run)
  for (const e of [[0x2066, 0x2069], [0x2068, 0x2069], [0x202a, 0x202c], [0x202d, 0x202c], [0x2067, 0x2069], [0x202e, 0x202c], [0x2066, 0x200d, 0x2069], [0x2066, 0x202a, 0x202c, 0x2069], [0x2066, 0x2069, 0x34f]]) {
    for (const [x, y] of [['f', 'T'], ['T', 'T']]) for (const m of [0x303, 0x304, 0x306, 0x308, 0x30f]) runs.push(`${x}${cp(0x69, ...e, m)}${y}`, `${x}${cp(0x69, ...e, m, 0x69, ...e, m)}${y}`)
    for (const [l, m, y] of [[0x64, 0x30c, ']'], [0x6c, 0x30c, 'T'], [0x74, 0x30c, ']'], [0x6c, 0x307, 'T'], [0x4c, 0x307, 'T'], [0x3d2, 0x301, 'T'], [0x131, 0x303, 'T']]) runs.push(`f${cp(l, ...e, m)}${y}`, `H${cp(l, ...e, m)}${y}`, `Hŀ${cp(l, ...e, m)}ĩ`)
  }
  // (and the Cyrillic "і" with a mark above, which Inter draws dotless and joins like "ı": "і" and a tilde are "ĩ",
  // between the letters that kern it wider, past a joiner too, and past a CGJ, where it doesn't compose into "ї" and a
  // diaeresis is "ï")
  for (const m of [0x303, 0x304, 0x306, 0x30f]) for (const [x, y] of [['1', '1'], ['7', '7'], ['f', 'T'], ['T', 'T'], ['7', 'T']]) runs.push(`${x}${cp(0x456, m)}${y}`, `${x}${cp(0x456, m)}${y}${cp(0x456, m)}${y}`, `${x}${cp(0x456, 0x200d, m)}${y}`)
  for (const [x, y] of [['f', 'T'], ['T', 'T'], ['1', '1']]) runs.push(`${x}${cp(0x456, 0x200d, 0x308)}${y}`, `${x}${cp(0x456, 0x34f, 0x308)}${y}`)
  runs.push('aď)', '(loď)', '„ДЛЯ', '„д,', '„ӆ₄', 'vȴƑ', 'ưʯƑ', 'ɬḬƑ', 'ƎḻĐ', 'ưɨ₄', 'ưɉ₄', 'ưṱ₄', 'ƒɳƑ', 'ƒɋƑ', '1Ɨƚ', '1ƗƚƗƚ', 'ɥjɥj', 'Ɨɥjɥj', 'ζ_j', 'ζ_Ƒ')
  // the runs once guessed short in #336: a tone mark before a variation selector and a dot or a space, a mark whose ink
  // reaches past its letter after a right-to-left override, "i" and a diaeresis drawn as a wider "ï" between digits, a
  // digit before a Mende Kikakui combining mark no font has, and Hebrew before a Devanagari vowel sign drawn before its letter
  runs.push(cp(0x340, 0xfe00, 0x2e), cp(0x6c, 0x341, 0xfe0f, 0x20), cp(0x6c, 0x344, 0xfe0f, 0x20), cp(0x202e, 0x6c, 0x35e, 0x31), cp(0x202e, 0x69, 0x308, 0x31), cp(0x31, 0x69, 0x308, 0x31), cp(0x31, 0x1e8d0), cp(0x5d0, 0x93f, 0x20), cp(0x5d0, 0x93f), cp(0x5d0, 0x94b, 0x20))
  // and the run once guessed short in #350: a digit and letters Inter kerns wider though they get no room ("0t" +0.017
  // em bold, "tM"), before "Ƈ", whose ink past its room left bold too little to spare for that kerning (a left-to-right
  // isolate and harakat among them, and "0tƇ" alone)
  runs.push(cp(0x31, 0x2066, 0x30, 0x74, 0x4d, 0x65b, 0x2066, 0x64e, 0x187), '0tƇ')
  // and the runs once guessed short in #353: a mark newer than resvg's Unicode (a letter to it) before a mark NFC
  // would put ahead of it, which stays on it, not on the space or letter before (after "ľ" drawn composed)
  runs.push(cp(0x6c, 0x30c, 0xad, 0x20, 0x897, 0x670, 0x7ca), cp(0x6c, 0x30c, 0xad, 0x20, 0x6c, 0x897, 0x670), cp(0x6c, 0x30c, 0xad, 0x20, 0x61, 0x1add, 0x308))
  // and known marks after a newer one, which the shaper still puts in combining-class order on their own
  runs.push(cp(0x61, 0x11b65, 0x35e, 0x308), cp(0x6c, 0x30c, 0x20, 0x1add, 0x35e, 0x308))
  // and known marks after a newer one that only decompose into marks Inter has, or past a variation selector or a
  // grapheme joiner, and a mark below on a space before a newer mark and U+0344, which resvg draws half an em wider
  runs.push(cp(0x61, 0x1612c, 0x35e, 0x344), cp(0x6a, 0x11b64, 0x1612c, 0x35e, 0x358, 0x344), cp(0x20, 0x303, 0x64, 0xfe00, 0x113c0, 0x35e, 0x344, 0x2f))
  runs.push(cp(0x61, 0x113cc, 0x35e, 0x303, 0xfe00), cp(0x20, 0x113c0, 0xfe00, 0x34f, 0x35e, 0x303), cp(0x6c, 0x30c, 0x20, 0x5a3, 0x1aeb, 0x344), cp(0x6c, 0x30c, 0x20, 0x316, 0x1aeb, 0x344))
  // and the runs once guessed short in #361: a stretch set left to right whose first letter of a script is Arabic (a box
  // mark, an Extended Arabic-Indic digit) is shaped right to left, so it's kerned the other way round: a closing bracket
  // and "ď" as "ď}" (+0.088 em, bold +0.131), before Hebrew, a letter or a dot, the bracket first or the mark, repeated
  // too, and "jȴ" as "ȴj"; and the same after a Latin letter, which has the stretch shaped left to right
  runs.push('}ۛďא', ')ۛďא', ']ۛďא', '}ۛďאא', '}ۛďa', '}ۛď.', 'ۛ}ď', 'ۛ)ď', `${cp(0x6f1)}}ď`, `${cp(0x610)}}ď`, 'ۛjȴא', '}ۛď'.repeat(6) + 'א', 'ۛ' + '}ď'.repeat(10), 'x}ۛďא hi')
  // and the runs once guessed short in #367: a zero-width space (or another boundary neutral) right after an isolate or
  // embedding opens takes the level before it, so it's laid out in the stretch before, and the marks no font has after
  // it start a stretch of their own, a whole box each, not boxes on the space; after U+0610 too, with an acute on "ď"
  runs.push(cp(0x610, 0x2066, 0x200b, 0x64b, 0x6e1, 0x10f, 0x301), cp(0x610, 0x2066, 0x200b, 0x64b, 0x6e1, 0x10f), cp(0x2066, 0x200b, 0x64b, 0x6e1, 0x10f, 0x301), cp(0x61, 0x2066, 0x200b, 0x64b, 0x6e1, 0x10f))
  for (const open of [0x2066, 0x2068, 0x202a, 0x202d]) for (const bn of [0x200b, 0x200c, 0x200d, 0xad, 0x2060, 0xfeff, 0x180e]) runs.push(cp(open, bn, 0x64b, 0x6e1, 0x10f), cp(open, bn, 0x200b, 0x6e1, 0x64b, 0x61, 0x2069))
  // and right after an embedding closes, which takes the level inside it, so the space is laid out with what's inside
  runs.push(cp(0x202a, 0x61, 0x202c, 0x200b, 0x64b, 0x6e1, 0x10f), cp(0x202d, 0x61, 0x202c, 0x2060, 0x64b, 0x6e1, 0x10f))
  // and the runs once guessed short in #363: a stretch turned around a grapheme at a time puts the marks it starts with
  // (U+0340 on nothing) after the grapheme after them, and decomposes none of them with a variation selector there, so
  // U+0340 is a box, not a grave: after a soft hyphen, a space or "!", with U+06D6 and a joiner or not, U+FE00 or
  // U+E0100, with U+06DB for U+06D6, after a left-to-right embedding, and U+0341 and U+0344 the same
  runs.push(cp(0x340, 0xad, 0x6d6, 0x200d, 0xfe00, 0x1ae0, 0x64), cp(0x340, 0xad, 0x6d6, 0x200d, 0xfe00, 0x61, 0x64), cp(0x340, 0xad, 0x6d6, 0xfe00, 0x61, 0x64))
  runs.push(cp(0x340, 0x20, 0x6d6, 0xfe00, 0x61, 0x64), cp(0x340, 0x21, 0x6d6, 0xfe00, 0x61, 0x64), cp(0x340, 0x200d, 0xad, 0x6d6, 0xfe00, 0x61, 0x64), cp(0x340, 0xad, 0x6d6, 0xe0100, 0x61, 0x64))
  runs.push(cp(0x341, 0xad, 0x6d6, 0xfe00, 0x61, 0x64), cp(0x344, 0xad, 0x6d6, 0xfe00, 0x61, 0x64), cp(0x340, 0xad, 0x6db, 0xfe00, 0x61, 0x64), cp(0x61, 0x202a, 0x340, 0xad, 0x6d6, 0xfe00, 0x61, 0x64))
  // (and the other way round: a variation selector among the marks it starts with keeps the next grapheme's marks whole)
  runs.push(cp(0xfe00, 0x6db, 0x2069, 0x341, 0x64, 0xfe0f, 0x64), cp(0xfe00, 0x6db, 0x2069, 0x341, 0x64, 0xfe0f, 0x64, 0x6d6), cp(0x6db, 0xfe00, 0x20, 0x341, 0x61))
  runs.push(cp(0x610, 0xfe00, 0xad, 0x340, 0x64, 0x200c, 0x301), cp(0x300, 0x308, 0x34f, 0xfe00, 0x200c, 0x300, 0x344, 0x6f1, 0x64, 0x5d0))
  // and the runs once guessed short in #366: marks on nothing before a variation selector (which no font has), still put
  // in combining-class order, U+0308 before U+035E, as resvg draws them; and U+0344, which Inter has the parts of, decomposed
  // and ordered the same way (a tag after it, not in its cluster), before a space, a closing bracket or an embedding
  runs.push(cp(0x35e, 0x308, 0xfe00, 0x20), cp(0x35e, 0x308, 0xfe00, 0x202a, 0xfe00, 0x343, 0x7d), cp(0x35e, 0x344, 0xe007f, 0x2069, 0x34f, 0x7d, 0xfe0f, 0xfe0f))
  runs.push(cp(0x35e, 0x308, 0xfe00, 0x7d), cp(0x35e, 0x303, 0xe0100, 0x20), cp(0x35e, 0x344, 0x7d))
  // (and U+0344 in a cluster with a variation selector, which the shaper doesn't decompose: a box, its marks left as they are)
  runs.push(cp(0x35e, 0x344, 0xfe00, 0x20))
  // and the runs once guessed short in #370 (stretches() models these since #342, so they're kept as regression runs): a
  // right-to-left stretch shaped as Thai (U+10D69, which resvg doesn't know, is a right-to-left letter to it) is turned
  // around a grapheme at a time, past an embedding; and past an isolate in an embedding, before U+0897
  runs.push(cp(0x202b, 0x340, 0x341, 0x341, 0xe48, 0x10d69, 0xe0100, 0x35e), cp(0x202b, 0x340, 0x341, 0x341, 0xe48, 0x10d69, 0xe0100))
  runs.push(cp(0x202a, 0x2067, 0x200b, 0xe49, 0x341, 0x341, 0x340, 0x897, 0x35e, 0xe0100, 0x202c))
  // and one that leading() reaches with stretches() null: an override forces a left-to-right letter with marks right to
  // left (forced), which stretches() doesn't model, so leading() takes every stretch as possibly turned around
  runs.push(cp(0x202e, 0x341, 0x341, 0x341, 0x456, 0xe0100))
  // a dotted "i" or Cyrillic "і" and a mark above past an ignorable that keeps NFC from composing them (a variation
  // selector, a zero-width space, a word joiner, a joiner), which Inter still draws dotless and kerns as "ĩ" or "ï",
  // between letters it kerns those with, repeated too
  for (const d of [0x69, 0x456]) {
    for (const g of [[0xfe00], [0x200b], [0x2060], [0x200d, 0x200b]]) for (const m of [[0x303], [0x308], [0x30f], [0x303, 0x308]]) {
      const u = cp(d, ...g, ...m)
      runs.push(`f${u}T`, `T${u}T${u}T`, `ĩ${u}ĩ${u}ĩ`)
    }
  }
  runs.push(`ĩ${cp(0x69, 0xfe00, 0x308)}`.repeat(3) + 'ĩ', `ï${cp(0x69, 0xfe00, 0x308)}`.repeat(2) + 'ï', `ĩ${cp(0x69, 0xfe00, 0x308, 0x362)}ĩ`)
  // and the runs once guessed short in #371: a variation selector keeps U+0340 (or U+0341, U+0343, U+0344) a box, not a
  // mark composed onto the letter before, beside a letter that composes wider ("ľ", "Ώ"), in an isolate too; the shaper
  // still composes the letter with a mark in such a cluster ("ϒ" U+0301 U+FE05 is "ϓ"), and U+0341 past a variation
  // selector, even one after it in its cluster, stays a box beside "ϒ" rather than the acute of "ϓ"
  runs.push(cp(0x61, 0x340, 0xfe00, 0x20, 0x6c, 0x30c, 0x628), cp(0x2067, 0x340, 0xfe00, 0x6c, 0x30c, 0x2069, 0x628), cp(0x3d2, 0x341, 0x64, 0x30c, 0x6c, 0x30c, 0xfe05, 0x3a9, 0x341, 0xfe00))
  runs.push(cp(0x6f, 0x344, 0xfe00, 0x3d2, 0x301, 0xfe05, 0x41, 0x20), cp(0x3a5, 0x301, 0xfe00, 0x49, 0x344, 0xfe00, 0x5d0, 0x64, 0x30c, 0x6f, 0xfe0f, 0x344), cp(0x2e, 0x343, 0xfe0f, 0x6c, 0x30c, 0xfe00, 0x5d0))
  runs.push(cp(0x3a9, 0x341, 0x3d2, 0xfe00, 0x341), cp(0x3a9, 0x341, 0x3d2, 0x200d, 0x341, 0xfe00), cp(0x6c, 0x30c, 0x2066, 0x3d2, 0xe0100, 0x341, 0x2069), cp(0x200d, 0x2068, 0x3a9, 0x341, 0x3a9, 0x341, 0x2069, 0x69, 0x308, 0x3d2, 0xfe00, 0x341))
  // (a variation selector just before U+0341 on "i" keeps it a box, not the acute of the dotless "í"; and the Tibetan
  // U+0F73, U+0F75 and U+0F81 are of class 0, so nothing after them composes with the letter before them)
  runs.push(cp(0x69, 0xfe01, 0x341, 0x6c, 0x307, 0xdc), cp(0x69, 0x200d, 0xfe01, 0x341, 0x6c, 0x307, 0xdc), cp(0x456, 0x34f, 0xfe00, 0x341, 0x6c, 0x307, 0xdc))
  runs.push(cp(0x6c, 0x30c, 0x391, 0xf73, 0x345, 0xfe01), cp(0x6c, 0x30c, 0x391, 0xf81, 0x345, 0xfe01), cp(0x64, 0x2060, 0x30c, 0x3b7, 0xf75, 0x345, 0xfe00))
  // (and a seeded sweep of them: box marks with a variation selector before or after, letters that compose, a variation
  // selector on those too, right-to-left letters and brackets after, in an isolate or embedding or not)
  let seed = 371
  const random = () => {
    seed = (seed + 0x6d2b79f5) >>> 0
    let t = Math.imul(seed ^ (seed >>> 15), seed | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const pick = (a) => a[Math.floor(random() * a.length)]
  const vs = [0xfe00, 0xfe05, 0xfe0f, 0xe0100]
  const composing = [[0x6c, 0x30c], [0x64, 0x30c], [0x74, 0x30c], [0x3d2, 0x301], [0x3d2, 0x341], [0x3a9, 0x341], [0x61, 0x301], [0x69, 0x308], [0x6c, 0x307], [0x3a5, 0x301]]
  const piece = () => {
    const r = random()
    if (r < 0.35) {
      const [b, m, v, x] = [random() < 0.2 ? [] : [pick([0x61, 0x49, 0x6c, 0x69, 0x20, 0x2e, 0x3a9, 0x3d2, 0x6f, 0x64])], pick([0x340, 0x341, 0x343, 0x344]), pick(vs), random() < 0.3 ? [pick([0x301, 0x300, 0x308, 0x30c])] : []]
      return pick([[...b, m, v, ...x], [...b, v, m, ...x], [...b, m, ...x, v], [...b, ...x, m, v]])
    }
    if (r < 0.7) {
      const [l, m] = pick(composing), t = random()
      return t < 0.15 ? [l, pick(vs), m] : t < 0.3 ? [l, m, pick(vs)] : [l, m]
    }
    return r < 0.85 ? [pick([0x628, 0x5d0, 0x78, 0x5d, 0x29, 0x41, 0x20])] : [pick([0x20, 0x200d, 0x34f, 0xad])]
  }
  for (let k = 0; k < 150; k++) {
    let ps = Array.from({ length: 2 + Math.floor(random() * 4) }, piece)
    if (random() < 0.5) {
      const [open, close] = pick([[0x2067, 0x2069], [0x2066, 0x2069], [0x2068, 0x2069], [0x202b, 0x202c], [0x202a, 0x202c], [0x202e, 0x202c]])
      const i = Math.floor(random() * ps.length), j = i + 1 + Math.floor(random() * (ps.length - i))
      ps = [...ps.slice(0, i), [open], ...ps.slice(i, j), ...(random() < 0.85 ? [[close]] : []), ...ps.slice(j)]
    }
    if (!ps.flat().some((c) => c >= 0x340 && c <= 0x344 && c !== 0x342)) ps.unshift([0x61, 0x340, 0xfe00])
    runs.push(cp(...ps.flat()))
  }
  // (and a variation selector among the Arabic-script marks a stretch shaped right to left starts with, which come after
  // the grapheme after them and keep its U+0340 a box, so that grapheme isn't composed or ligated either: "a" U+0340
  // past U+06DB U+FE00, with or without an isolate or embedding around them, beside "ľ", "ď", "ϓ" or "ŀ"; and a seeded
  // sweep of those leaders, a box mark on the letter after them and letters that compose wider)
  runs.push(cp(0x2068, 0x6db, 0xfe00, 0x61, 0x340, 0x20, 0x6c, 0x30c, 0x2069, 0x5d0), cp(0x2068, 0x6e1, 0xe0100, 0x20, 0x340, 0x64, 0x30c, 0x3d2, 0x341, 0x2069, 0x5d0))
  runs.push(cp(0x6db, 0xfe00, 0x61, 0x340, 0x20, 0x6c, 0x30c, 0x628), cp(0x202d, 0x6e1, 0xfe01, 0x61, 0x340, 0x3d2, 0xfe0f, 0x341, 0x3d2, 0xfe01, 0x301, 0x202c, 0x20, 0x628))
  runs.push(cp(0x6d6, 0xfe0f, 0x69, 0x341, 0x6c, 0xfe05, 0x307, 0x200d, 0x628), cp(0x2068, 0x6e1, 0xfe01, 0x69, 0x344, 0x2e, 0x6c, 0xfe05, 0x307, 0x2069, 0x5d0))
  seed = 3711
  for (let k = 0; k < 100; k++) {
    const lead = [pick([0x6d6, 0x6db, 0x6e1, 0x610]), ...(random() < 0.8 ? [pick(vs)] : []), ...(random() < 0.3 ? [pick([0x6db, 0x301])] : [])]
    const first = [pick([0x61, 0x49, 0x69, 0x3b9, 0x3c5, 0x6f, 0x6c, 0x3d2, 0x20, 0x2e]), pick([0x340, 0x341, 0x343, 0x344]), ...(random() < 0.3 ? [pick([0x301, 0x308, 0x30c])] : [])]
    const rest = Array.from({ length: 1 + Math.floor(random() * 3) }, () => {
      if (random() < 0.4) return [pick([0x20, 0x2e, 0x41, 0x200d])]
      const [l, m] = pick(composing), t = random()
      return t < 0.2 ? [l, pick(vs), m] : t < 0.35 ? [l, m, pick(vs)] : [l, m]
    })
    const body = [...lead, ...first, ...rest.flat()], tail = pick([[], [0x628], [0x5d0], [0x20, 0x628]])
    runs.push(cp(...pick([[...body, ...tail], [0x2068, ...body, 0x2069, 0x5d0], [0x5e9, 0x20, 0x2066, ...body, 0x2069], [0x202d, ...body, 0x202c, ...tail], [0x628, 0x20, 0x202a, ...body, 0x202c]])))
  }
  // and the arrows Inter's contextual alternates join dashes and an angle bracket into, wider than what they join ("–>"
  // is "⟶", "--->" a longer arrow; and with Inter's private-use case forms), alone, after letters, next to each other,
  // past the ignorables the shaper skips, and in right-to-left text, where bidi mirrors the bracket ("م–<" is "⟵")
  runs.push('–>', '<–', 'a–>', 'م–>', '--->', '<---', '–-–>', '<—––', '—–->', '---->', 'A–>B', '–>–>', '<–<–', ' –> ', cp(0xe089, 0xe098), cp(0xe097, 0x2013), cp(0xe088, 0xe089, 0x2d, 0xe098), cp(0xe097, 0xe08b, 0x2013, 0x2d))
  runs.push('م–<م', 'م>–م', 'م–<1', 'מ<–', 'מ–>', '1–<م', `${cp(0x202b)}–<`, `${cp(0x202e)}>–`, `${cp(0x2067)}–<${cp(0x2069)}`, `a${cp(0x200f)}–<`)
  for (const g of [0x34f, 0x200d, 0xfe0f, 0xad, 0x200b, 0x200e, 0x2060, 0x202c, 0x2069, 0x17b4, 0xe0100]) runs.push(cp(0x2013, g, 0x3e), cp(0x3c, g, 0x2013), cp(0x2d, 0x2d, g, 0x2d, 0x3e), cp(0x644, 0x2013, g, 0x3c, 0x644))
  // (and turned around by the shaper, in a run of a script written right to left set left to right: a Persian digit,
  // an Arabic sign or mark, the mark after its letter moved past the arrow, and a mark no font has drawn a box past it)
  runs.push(cp(0x6f1, 0x3e, 0x2013), cp(0x609, 0x3e, 0x2013), cp(0x3e, 0x2013, 0x6de), cp(0x656, 0x3e, 0x2d, 0x2d, 0x2d), cp(0x3e, 0x5b4, 0x2013, 0x645), cp(0x3e, 0x591, 0x2d, 0x2d, 0x2d), cp(0x2d, 0x656, 0x656, 0x2d, 0x2d, 0x3c))
  for (const m of [0x610, 0x656, 0x711, 0x7eb, 0x816]) runs.push(cp(0x3e, m, 0x2d, 0x2d, 0x2d), cp(0x2013, m, 0x3c), cp(0x2d, m, 0x2d, 0x2d, 0x3c), cp(0x3e, m, m, 0x2d, 0x2d, 0x2d))
  // (Inter's private-use case forms of the brackets turned around too, and a box mark past an arrow narrower than what
  // it joins, "-" U+0610 "-<"; and lines with harakat or points and an arrow)
  runs.push(cp(0x20, 0x6f5, 0x656, 0xe098, 0x2d, 0x2d, 0x2d), cp(0x8d3, 0x60a, 0x6f5, 0xe098, 0x338, 0x2d, 0x2d, 0x2d), cp(0x670, 0xe098, 0xe089, 0x6e9, 0x20d2, 0x2013, 0x3c))
  runs.push(cp(0x2d, 0x610, 0x2d, 0x3c), cp(0x6f5, 0x2d, 0x610, 0x2d, 0x3c), cp(0x2d, 0x6f5, 0x2d, 0x610, 0x2d, 0x3c, 0x200c), ...ARROW_LINES)
  // a pictograph Inter has ("©", "®", "↔") right after a joiner, which the shaper keeps in the cluster before it: resvg
  // draws it past that cluster's glyphs one after another, a box mark's whole width too, and the marks after it past it
  // (after two boxes, chained past another joiner, after "*" drawn wider, and shaped right to left, "⁄" drawn last)
  runs.push(cp(0x23, 0x1ab5, 0x200d, 0xae), cp(0x20, 0x316, 0x200d, 0xa9, 0x344, 0xfe00), cp(0x65, 0x307, 0xa0, 0x5a3, 0x200d, 0xae, 0x344), cp(0x4f, 0x303, 0x31, 0x5a3, 0x200d, 0xa9, 0x343, 0xfe0f), cp(0x20, 0x64, 0xad, 0x323, 0x2a, 0x5a3, 0x200d, 0xa9, 0x344, 0xfe0e))
  runs.push(cp(0x4f, 0x303, 0x31, 0x5a3, 0x200d, 0xa9, 0x343, 0xfe0f, 0x456), cp(0x57, 0x1ab5, 0x1ab5, 0x200d, 0xae), cp(0x61, 0x1ab5, 0x200d, 0xae, 0x1ab5, 0x1ab5), cp(0x61, 0x1ab5, 0x200d, 0xae, 0x200d, 0xa9), cp(0x61, 0x1ab5, 0x200d, 0x200d, 0x2194))
  runs.push(cp(0x2665, 0x2a, 0x64b, 0x200d, 0x24c2), cp(0x2044, 0x82a, 0x200d, 0x26a0), cp(0x6d6, 0x2044, 0x200d, 0x2049), cp(0x200c, 0x82a, 0x2014, 0xae, 0x5a3, 0x2044, 0x82a, 0x200d, 0x203c))
  // and a sample of every character Inter has below U+0600, between the characters it kerns most with on each side
  // (at the regular weight), alone and repeated
  const most = (pair) => chars.reduce(([b, k], x) => (pair(x) > k ? [x, pair(x)] : [b, k]), ['', 0])[0]
  for (const c of chars.filter((_, i) => i % 12 === 0)) {
    const [x, y] = [most((x) => inter.kern(x, c, true)), most((y) => inter.kern(c, y, true))]
    runs.push(x + c + y, x + c + y + c + y)
  }
  for (const [i, run] of runs.entries()) {
    if (i % 25 === 0) await tick()
    for (const bold of [false, true]) assert.ok(guess(run, bold) >= measure(run, bold), `${bold} ${JSON.stringify(run)}: ${guess(run, bold)} < ${measure(run, bold)}`)
  }
})

test('a guessed run ends where resvg would end it, within a few px: no holes, nothing pushed off the card', async () => {
  // realistic casts of short phrases between emoji: Latin, struck through (marks no font has), and Hindi (no card font
  // has Devanagari, so its letters and marks are boxes); each guess may be over by a little, more for the boxes
  const sets = {
    latin: [0.15, ['gm frens', 'big day', 'shipping v2', 'DMs fixed', 'push alerts', 'thanks all', 'LFG', 'wagmi', 'ser', 'based', 'ty', 'so good', 'love it', 'lol', 'yes', 'top', 'fire', 'Wow', 'a_b', '2024']],
    strike: [0.15, ['s̶o̶l̶d̶ o̶u̶t̶', 'n̶o̶t̶ ̶y̶e̶t̶', 'f̶r̶e̶e̶', 'o̶l̶d̶ p̶r̶i̶c̶e̶', 'g̶m̶', 'u̲n̲d̲e̲r̲']],
    hindi: [0.8, ['नमस्ते दोस्तों', 'आज का दिन', 'बहुत अच्छा', 'धन्यवाद सबको', 'शुभ रात्रि', 'चलो चलें', 'मज़ा आया', 'प्यार', 'खुश रहो', 'जय हो']],
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
  // each guess is close to resvg's advance, not twice it
  for (const run of [' gm ', ' this ', ' 2024 ', ' hello world ']) for (const bold of [false, true]) assert.ok(guess(run, bold) < measure(run, bold) * 1.05, run)
  // (also Russian and Czech, whose "д" and "ď" Inter kerns wide only next to a few characters)
  for (const [run, over] of [['ДЛЯ ДРУЗЕЙ', 0.1], ['ДОБРОЕ УТРО', 0.1], ['Loď do přístavu', 0.15], ['Ďakujem, ďalší deň', 0.15]]) for (const bold of [false, true]) assert.ok(guess(run, bold) < measure(run, bold) + over, `${bold} ${run}`)
  // and Thai with sara am, one box of advance however many boxes of ink, isn't taken as a box wider for each one
  for (const run of ['น้ำ', 'น้ำใจ', 'ทำงาน', 'ความจำ']) for (const bold of [false, true]) assert.ok(guess(run, bold) < measure(run, bold) + 0.1, run)
  // and Inter's arrows are counted once, each as wide as it's drawn: not as the shorter ones inside it too
  for (const run of ['–>', '--->', '–––>', '–>–>', 'a –> b', '<–––']) for (const bold of [false, true]) assert.ok(guess(run, bold) < measure(run, bold) + 0.1, run)
  // and a line with harakat or points and an arrow takes a box only for a mark on the arrow, not for every one
  for (const run of ARROW_LINES) for (const bold of [false, true]) assert.ok(guess(run, bold) < measure(run, bold) + 0.5, run)
  // and right-to-left text, its own letters first (with points no font has too), isn't taken as turned around
  for (const run of ['عربي', 'שלום', `ע${cp(0x5b4)}ב${cp(0x5b0)}ר${cp(0x5b4)}ית`, 'abc عربي']) for (const bold of [false, true]) assert.ok(guess(run, bold) < measure(run, bold) + 0.1, run)
  // a mark at a run's end gets room for its ink once, and a decomposed arrow's slash none
  for (const [run, over] of [[`cafe${cp(0x301)}`, 0.55], ['a↮', 0.1]]) for (const bold of [false, true]) assert.ok(guess(run, bold) < measure(run, bold) + over, run)
  // and Hebrew and Arabic, with their points and harakat (drawn within Hebrew's letters), mixed with English and
  // numbers, are as close
  for (const run of ['שלום עולם', 'שָׁלוֹם', 'מִשְׁפָּט טוֹב', 'مَرْحَبًا بِكُمْ', 'gm مرحبا friends', 'שנת 2024 טובה', 'قیمت: ۵۰٪', `ดีครับ שלום น้ำ`]) for (const bold of [false, true]) assert.ok(guess(run, bold) < measure(run, bold) + 0.15, run)
  // Thai's sara am right before right-to-left text: its boxes' ink past the end of its stretch is under the text drawn
  // after it, not added to it, and a box mark on a space shaped right to left isn't set past ink the space doesn't have
  for (const run of SARA_AM_BEFORE_RTL) for (const bold of [false, true]) assert.ok(guess(run, bold) < measure(run, bold) + 0.75, run)
  for (const run of BOX_ON_RTL_SPACE) for (const bold of [false, true]) assert.ok(guess(run, bold) < measure(run, bold) + 0.3, run)
  // and a number after Arabic with harakat or Hebrew with points, bare or in brackets, is as close as other text
  for (const run of RTL_BEFORE_NUMBERS) for (const bold of [false, true]) assert.ok(guess(run, bold) < measure(run, bold) + 0.15, run)
  // and isolates and embeddings that only set text left to right are guessed as the stretches they cut, not as room for
  // every cluster in any order
  for (const run of LTR_ISOLATED) for (const bold of [false, true]) assert.ok(guess(run, bold) < measure(run, bold) + 0.75, run)
  // and so are those in right-to-left text, laid out at the levels resvg's bidi gives them: as close as other text
  for (const run of RTL_ISOLATED) for (const bold of [false, true]) assert.ok(guess(run, bold) < measure(run, bold) + 0.15, run)
  // (and so are stretches set left to right but shaped right to left with left-to-right letters in them, kerned the
  // other way round, not given room for every cluster: LRO, a box mark, "}" and "ď"; an RLE, an Arabic digit and "jȴ")
  for (const run of [cp(0x202d, 0x6db, 0x7d, 0x10f), cp(0x202b, 0x661, 0x6a, 0x234), `ש ${cp(0x2067, 0x661, 0x6a, 0x234, 0x2069)}`]) for (const bold of [false, true]) assert.ok(guess(run, bold) < measure(run, bold) + 0.15, `${bold} ${run}`)
  // and right-to-left text with its marks (pointed Arabic and Hebrew), or text struck through after a right-to-left
  // override (each box widening its letter, not a box beside it), isn't guessed far wider for each letter carrying marks
  const struck = [...'strike this'].map((c) => c + cp(0x336)).join('')
  const pointed = ['مَرْحَبًا بِالْعَالَمِ', 'بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ', 'שָׁלוֹם עוֹלָם', 'בְּרֵאשִׁית בָּרָא אֱלֹהִים אֵת הַשָּׁמַיִם וְאֵת הָאָרֶץ', `a${cp(0x202e)}${struck}`]
  for (const run of pointed) for (const bold of [false, true]) assert.ok(guess(run, bold) < measure(run, bold) * 1.3, `${bold} ${run}: ${guess(run, bold)} vs ${measure(run, bold)}`)
})

test('past the budget, exactly() still measures: a tightly kerned line ends where resvg ends it, not at the guess', () => {
  // the budget spent on runs never seen before
  textSvg([Array.from({ length: 40 }, (_, i) => `spent ${i}`).join('🎉')], { x: 0, y: 40, size: 32, fill: '#fff' })
  const line = 'TyTyTyTy AVAVAVAV'
  const guessed = ends(line, 52, true)
  assert.ok(guessed > measure(line, true) * 52 + 20, `${guessed}`)
  assert.equal(exactly(() => ends(line, 52, true)), measure(line, true) * 52)
  // and draws the line the same way: the emoji after it is placed at the measured end
  const [[x]] = placed(exactly(() => textSvg([`${line} 🔥 xyzxyz`], { x: 0, y: 40, size: 52, bold: true, fill: '#fff' })))
  assert.ok(Math.abs(x - (measure(`${line} `, true) * 52 + 0.07 * 52)) < 0.1, `${x}`)
})

test('past the budget, a bold line wrapped exactly() fits as drawn, with what guesses have taken as narrower too', async () => {
  // an ideographic space and "↮", which guesses took as narrower than they're drawn until they knew better; the budget
  // is spent before each name is wrapped
  const names = []
  for (const s of ['　', '↮']) for (let n = 1; n <= 8; n++) for (const k of [0, 3, 9]) names.push([...'bcdfghjkl'.slice(0, k)].map((c) => `${c} `).join('') + 'Hi' + s.repeat(n) + 'Ok more')
  for (const [j, name] of names.entries()) {
    await tick()
    textSvg([Array.from({ length: 40 }, (_, i) => `spent ${j} ${i}`).join('🎉')], { x: 0, y: 40, size: 32, fill: '#fff' })
    for (const [px, max] of [[52, 327.6], [40, 336]]) {
      const lines = exactly(() => wrap(name, px, max, 2, { bold: true }))
      for (const l of lines) assert.ok(exactly(() => ends(l, px, true)) <= max + 0.01, `${JSON.stringify(name)} ${px}: ${JSON.stringify(l)}`)
    }
  }
})

test('wrapping counts marks no font has as resvg draws them (boxes), and what it leaves out as nothing', () => {
  // a box on a narrow letter widens it to a box; a mark Inter has, joiners and selectors take no room
  const strike = (s) => [...s].map((c) => `${c}${cp(0x336)}`).join('')
  const adv = (s) => width(`${s}x`, 1) - width('x', 1)
  for (const s of ['this price is no longer valid', 'sold out']) assert.ok(Math.abs(adv(strike(s)) - (measure(`${strike(s)}x`) - measure('x'))) < 0.03 * s.length, s)
  for (const s of ['नमस्ते दुनिया', 'आज का दिन']) assert.ok(Math.abs(adv(s) - (measure(`${s}x`) - measure('x'))) < 0.4, s)
  // and alone, to where the boxes' ink ends, as the card places what comes after them: never short of it
  for (const s of [strike('sold out'), 'नमस्ते दुनिया', 'आज का दिन', `a${cp(0xf71).repeat(5)}`]) assert.ok(width(s, 1) >= measure(s) - 0.02 && width(s, 1) - measure(s) < 0.3, s)
  assert.equal(width(`a${cp(0x301)}`, 20), width('a', 20))
  assert.equal(width(`a${cp(0x200d, 0xfe0e, 0xad)}`, 20), width('a', 20))
  // a format character resvg doesn't leave out is a box, and so is a Hangul filler
  for (const c of [0xfff9, 0x3164]) assert.ok(Math.abs(width(`a${cp(c)}`, 1) - width('a', 1) - (measure(`a${cp(c)}x`) - measure('ax'))) < 0.02, c.toString(16))
})

test('long text is cut at a grapheme, never into a different emoji or half a character', () => {
  assert.equal(cut(FAMILY.repeat(30), 80), FAMILY.repeat(7))
  assert.equal(cut(FAMILY.repeat(30), FAMILY.length * 3 - 1), FAMILY.repeat(2))
  assert.equal(cut(`ab${UA}`, 3), 'ab')
  assert.equal(cut('short', 80), 'short')
  assert.equal(cut(42, 80), '42')
  // a first grapheme longer than the limit on its own is cut at a character, never to nothing
  assert.equal(cut(`a${cp(0x301).repeat(300)} rest`, 280), `a${cp(0x301).repeat(279)}`)
  assert.equal(cut(`${cp(0x1f600)}${cp(0x1f3fb).repeat(10)}`, 5), cp(0x1f600, 0x1f3fb))
  assert.equal(cut(`${cp(0x1f600)}${cp(0x1f3fb).repeat(10)}`, 1), '')
})

test('only what SVG collapses is collapsed: no-break and other wide spaces stay', () => {
  const s = textSvg([`a  \t b${cp(0xa0, 0xa0)}c${cp(0x3000)}d${cp(0xfeff)}e 🎉`], { x: 0, y: 40, size: 20, fill: '#fff' })
  assert.ok(s.includes(`>a b${cp(0xa0, 0xa0)}c${cp(0x3000)}d${cp(0xfeff)}e </tspan>`), s)
})

test("a name's initial is one glyph: its first letter without marks, or its first emoji", () => {
  for (const name of [cp(0x1f389, 0x1f3fd), cp(0x1f468, ZWJ, 0x1f389), `${THUMB}x`]) assert.equal((initial(name, 128, 136, 40, '#999').match(/<use /g) || []).length, 1, name)
  assert.match(initial('s̶t̶r̶i̶k̶e̶', 128, 136, 40, '#999'), />S<\/text>/)
  assert.match(initial('Z̷̢͎a̸͓l̴̰g̶̱o̵͚', 128, 136, 40, '#999'), />Z<\/text>/)
  assert.match(initial(`${cp(0x301)}${cp(0x200d)} ann`, 128, 136, 40, '#999'), />A<\/text>/)
  assert.match(initial('', 128, 136, 40, '#999'), />\?<\/text>/)
})

test('a picture drawn many times is defined once, and the card stays small and quick', () => {
  const flags = Array.from({ length: 8 }, () => cp(0x1f1fa, 0x1f1f3).repeat(75))
  const svg = card(textSvg(flags, { x: 0, y: 40, lh: 40, size: 30, fill: '#fff' }))
  assert.equal((svg.match(/<g id="tw-/g) || []).length, 1)
  assert.equal(uses(svg), 600)
  assert.ok(svg.length < 200e3, svg.length)
  const t = performance.now()
  new Resvg(svg, opts).render()
  assert.ok(performance.now() - t < 2000)
})

test('pictures far off the card never bring resvg down', () => {
  // resvg 2.6.2 panics (an abort, not an exception) on a <use> of a clip path, filter or opacity layer that lands far
  // outside the canvas: popcorn and the target have opacity, 🛜 🪇 🫨 clip paths (taken off), ✔️ the edge
  const all = [0x1f37f, 0x1f3af, 0x1f6dc, 0x1fa87, 0x1fae8, 0x2714, 0x1f389].map((c) => cp(c, VS16)).join('')
  for (const [x, y] of [[20000, 40], [3000, 40], [-8000, 40], [20, 5000], [20, -5000], [20, 60]]) {
    const svg = card(textSvg([all], { x, y, size: 30, fill: '#fff' }))
    assert.ok(!/<image|<clipPath|clip-path/.test(svg) && uses(svg) === 7, `${x} ${y}`)
    new Resvg(svg, opts).render()
  }
})

test('no picture needs a layer of its own: the three with clip paths draw the same without them', () => {
  const dir = dirname(createRequire(import.meta.url).resolve('@twemoji/svg/package.json'))
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.svg') && LAYERED.test(source(f))), [])
  // drawn at 4× on a canvas twice the picture's size, so anything a clip kept in its box would show up outside it
  const big = (s) => s.replace('viewBox="0 0 36 36"', 'viewBox="-18 -18 72 72" width="288" height="288"')
  for (const f of ['1f6dc.svg', '1fa87.svg', '1fae8.svg']) {
    const [a, b] = [readFileSync(join(dir, f), 'utf8'), source(f)].map((s) => new Resvg(big(s)).render().pixels)
    assert.ok(/<clipPath/.test(readFileSync(join(dir, f), 'utf8')), f)
    let off = 0
    for (let i = 0; i < a.length; i += 4) {
      const d = Math.max(...[0, 1, 2, 3].map((k) => Math.abs(a[i + k] - b[i + k])))
      const [x, y] = [(i / 4) % 288, Math.floor(i / 4 / 288)]
      assert.ok(!d || (x >= 72 && x < 216 && y >= 72 && y < 216), `${f} draws outside its box at ${x},${y}`)
      // only antialiasing where 🫨's face touches its diamond
      if (d > 8) off++
    }
    assert.ok(off < 60, `${f}: ${off}`)
  }
})

test('a picture that once had clip paths, drawn hundreds of times, keeps the card small and quick', () => {
  for (const e of [cp(0x1fa87), cp(0x1f6dc), cp(0x1fae8)]) {
    const svg = card(textSvg(Array.from({ length: 7 }, () => e.repeat(38)), { x: 0, y: 40, lh: 40, size: 30, fill: '#fff' }))
    assert.equal(uses(svg), 266)
    assert.ok(svg.length < 40e3, `${e}: ${svg.length}`)
    const t = performance.now()
    new Resvg(svg, opts).render()
    assert.ok(performance.now() - t < 300, e)
  }
})

test("characters XML can't hold are left out, so the card still draws", () => {
  assert.equal(esc('a\u0007<b\u0000\uffff\ufffe\ud800'), 'a&#60;b')
  const s = textSvg(['ring\u0007 the bell\u0000\uffff 🎉', '\u0001x'], { x: 20, y: 60, lh: 40, size: 30, fill: '#fff' })
  assert.ok(!/[\0-\x08\uffff]/.test(s))
  new Resvg(card(s), opts).render()
})
