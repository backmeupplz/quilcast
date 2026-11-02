import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { cut, ends, esc, exactly, FONTS, graphemes, guess, initial, kind, LAYERED, layout, measure, metrics, pictures, richSvg, source, textSvg, width, wrap } from './text.mjs'
import { MD, styled } from '../src/shared.ts'

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
  // how much text wrapping takes apart into graphemes (every width it works out does): a line measured again as it grows
  // takes apart ten times the text about a hundred times over, not ten
  const work = (s) => {
    const segment = Intl.Segmenter.prototype.segment
    let n = 0
    Intl.Segmenter.prototype.segment = function (t) {
      n += String(t).length
      return segment.call(this, t)
    }
    try {
      wrap(s, 24, 356, 9)
    } finally {
      Intl.Segmenter.prototype.segment = segment
    }
    return n
  }
  const grows = (s, n) => work(s.repeat(n * 10)) / work(s.repeat(n))
  // zero-width spaces split by U+FEFF, which counts as whitespace: one long line of hundreds of words. Linear is about
  // ten times as much, quadratic about a hundred
  const zero = cp(0x200b, 0xfeff)
  assert.ok(grows(zero, 100) < 30)
  // words that fill the lines: wrapping stops once they're full, so the rest of the text costs next to nothing
  assert.ok(grows('a ', 300) < 3)
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

test('past the budget, a bold line wrapped exactly() fits as drawn, with what a guess takes as narrower too', async () => {
  // an ideographic space and "↮" are drawn wider than guessed; the budget is spent before each name is wrapped
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
  new Resvg(svg, opts).render()
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
    assert.ok(!/<clipPath|clip-path/.test(svg), e)
    new Resvg(svg, opts).render()
  }
})

test("characters XML can't hold are left out, so the card still draws", () => {
  assert.equal(esc('a\u0007<b\u0000\uffff\ufffe\ud800'), 'a&#60;b')
  const s = textSvg(['ring\u0007 the bell\u0000\uffff 🎉', '\u0001x'], { x: 20, y: 60, lh: 40, size: 30, fill: '#fff' })
  assert.ok(!/[\0-\x08\uffff]/.test(s))
  new Resvg(card(s), opts).render()
})

test('fancy letters no card font has draw as the plain letters they stand for; everything else stays', async () => {
  const { clean } = await import('./text.mjs')
  assert.equal(clean('ȷď𝐛𝐛'), 'ȷďbb') // @jenna's name: mathematical bold b
  assert.equal(clean('𝓈𝒸𝓇𝒾𝓅𝓉 𝕕𝕠𝕦𝕓𝕝𝕖 Ｗｉｄｅ'), 'script double Wide')
  assert.equal(clean('漢字 🙂 café ﬁ'), '漢字 🙂 café fi') // ﬁ isn't in Inter either
})

test('a Markdown table on a card is its rows in columns, header bold, aligned as typed, cut with a "…" row', () => {
  const md = styled('# Fees\n\n| Chain | Fee |\n|-|-:|\n| **Base** | $0.001 |\n| Ethereum with a very long name indeed | $1.20 |\n| Optimism | $0.002 |\n\n~~old~~ text')
  const items = layout(md.text, md.marks, 40, 600, 20)
  const rows = items.filter((it) => it.cells)
  assert.deepEqual(rows.map((r) => r.cells.map((c) => c.l)), [['Chain', 'Fee'], ['Base', '$0.001'], [rows[2].cells[0].l, '$1.20'], ['Optimism', '$0.002']])
  assert.match(rows[2].cells[0].l, /^Ethereum.*…$/)
  assert.ok(rows.every((r) => r.cells[1].x === rows[0].cells[1].x && r.cells[0].x + r.cells[0].w < r.cells[1].x && r.width <= 600))
  assert.ok(rows[0].cells[0].mark(0) & MD.bold && !(rows[3].cells[0].mark(0) & MD.bold))
  assert.equal(rows[0].cells[1].align, MD.right)
  // a half-line gap above and below the table, struck text after it
  assert.deepEqual(items.map((it) => it.h), [1, 0.5, 1, 1, 1, 1, 0.5, 1])
  assert.ok(items.at(-1).mark(0) & MD.strike)
  assert.match(richSvg(items, { x: 0, y: 40, lh: 52, size: 40, fill: '#fff', accent: '#a9f', code: '#fc8', muted: '#999' }), /Optimism/)
  // three and a half lines' room: the title, the gap, the header and a "…" row saying there's more
  const cut = layout(md.text, md.marks, 40, 600, 3.5)
  assert.deepEqual(cut.map((it) => it.l ?? it.cells.map((c) => c.l).join('|')), ['Fees', '', 'Chain|Fee', '…'])
})
