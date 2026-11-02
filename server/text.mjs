// Text on the share cards: widths for wrapping, and emoji in color.
// resvg-js (2.6.2, and its 2.7 alphas, still on ttf-parser 0.18) draws no color font format, and its font fallback
// gives up on a whole run of text when the fallback font shapes an emoji sequence (VS16, ZWJ, a skin tone, a flag) into
// fewer glyphs than the main font did, leaving "no glyph" boxes. So the cards lay their lines out here: words stay text,
// each emoji is Twemoji's picture, and every piece starts where resvg's own layout of the text before it ends.
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { keep } from './net.mjs'

export const FONTS = ['Inter-Regular.ttf', 'Inter-Bold.ttf', 'NotoEmoji.ttf'].map((f) => new URL(`fonts/${f}`, import.meta.url).pathname)

/** Which characters a TrueType font has a glyph for, and a glyph's advance in em (undefined when the font has none). */
export function metrics(file) {
  const b = readFileSync(file)
  const u16 = (o) => b.readUInt16BE(o)
  const t = {}
  for (let i = 0; i < u16(4); i++) t[b.toString('latin1', 12 + i * 16, 16 + i * 16)] = b.readUInt32BE(20 + i * 16)
  const upm = u16(t.head + 18)
  const hmetrics = u16(t.hhea + 34)
  // cmap: the Unicode subtable, format 12 (all planes) over format 4 (the BMP)
  let f4, f12
  for (let i = 0; i < u16(t.cmap + 2); i++) {
    const p = t.cmap + 4 + i * 8
    const [platform, encoding, o] = [u16(p), u16(p + 2), t.cmap + b.readUInt32BE(p + 4)]
    if (platform !== 0 && !(platform === 3 && (encoding === 1 || encoding === 10))) continue
    if (u16(o) === 12) f12 = o
    else if (u16(o) === 4) f4 = o
  }
  const glyphs = new Map()
  if (f12) {
    for (let i = 0; i < b.readUInt32BE(f12 + 12); i++) {
      const g = f12 + 16 + i * 12
      const [start, end, id] = [b.readUInt32BE(g), b.readUInt32BE(g + 4), b.readUInt32BE(g + 8)]
      for (let c = start; c <= end; c++) glyphs.set(c, id + c - start)
    }
  } else if (f4) {
    const n = u16(f4 + 6) / 2
    for (let i = 0; i < n; i++) {
      const [end, start, delta] = [u16(f4 + 14 + i * 2), u16(f4 + 16 + n * 2 + i * 2), u16(f4 + 16 + n * 4 + i * 2)]
      const ro = f4 + 16 + n * 6 + i * 2
      const range = u16(ro)
      for (let c = start; c <= end && c !== 0xffff; c++) {
        const id = range ? u16(ro + range + 2 * (c - start)) : c
        if (!range || id) glyphs.set(c, (id + delta) & 0xffff)
      }
    }
  }
  return {
    glyph: (cp) => glyphs.get(cp) || undefined,
    advance: (cp) => {
      const id = glyphs.get(cp)
      return id ? u16(t.hmtx + 4 * Math.min(id, hmetrics - 1)) / upm : undefined
    },
  }
}
const [REGULAR, BOLD, NOTO] = FONTS.map(metrics)

// Twemoji's pictures, by their code points without VS16 (its file names drop VS16 except in ZWJ sequences; people's
// text has it or not either way)
const TWEMOJI = dirname(createRequire(import.meta.url).resolve('@twemoji/svg/package.json'))
const plain = (g) => g.replace(/\uFE0F/g, '')
const hex = (s) => [...s].map((c) => c.codePointAt(0).toString(16)).join('-')
const PICTURES = new Map(readdirSync(TWEMOJI).filter((f) => f.endsWith('.svg')).map((f) => [hex(plain(String.fromCodePoint(...f.slice(0, -4).split('-').map((h) => parseInt(h, 16))))), f]))
// A few pictures are all dark grey (✔ ➕ © 🖤 ♠ ⬛ 🕷…), close to invisible on the cards' near-black, so they get a
// light edge, the way dark-mode apps keep them readable
const luminance = (h) => {
  const v = h.length === 4 ? [...h.slice(1)].map((c) => c + c) : [h.slice(1, 3), h.slice(3, 5), h.slice(5, 7)]
  const [r, g, b] = v.map((x) => parseInt(x, 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const dark = (svg) => Math.max(...(svg.match(/fill="#(?:[0-9a-f]{3}|[0-9a-f]{6})"/gi) || []).map((f) => luminance(f.slice(6, -1)))) < 0.06

// Each picture a card uses is defined once, as a group of its shapes in a 1×1 box, and drawn with <use>: a data: URI
// per instance made a cast of 600 flags a 20 MB SVG that took seconds. resvg 2.6.2 panics, taking the process down,
// when a <use> of anything it draws in a layer of its own (a clip path, a filter, opacity, an image, a <symbol>) lands
// outside the canvas. So the light edge is the shapes once more underneath with a stroke, not a filter, and a shape's
// opacity (Twemoji puts it only on single unstroked shapes) is its fill-opacity, which draws the same. The only three
// pictures with clip paths (🛜 🪇 🫨) clip nothing (each clip is the picture's own box, or for 🫨 a diamond around all of
// it), so they're drawn without them, like the rest; a test checks they draw the same. A picture that would still need
// a layer of its own (none in this Twemoji) isn't used: its emoji is Noto's outline.
const files = new Map()
const read = (f) => files.get(f) ?? keep(files, 500, f, readFileSync(join(TWEMOJI, f), 'utf8'))
const UNCLIPPED = new Set(['1f6dc.svg', '1fa87.svg', '1fae8.svg'])
const CLIPS = /<defs>(?:<clipPath\b[\s\S]*?<\/clipPath>)+<\/defs>|\sclip-path="[^"]*"/g
/** A Twemoji picture's SVG, as the cards draw it. */
export const source = (f) => (UNCLIPPED.has(f) ? read(f).replace(CLIPS, '') : read(f))
export const LAYERED = /<clipPath|<mask|<filter|<pattern|<use|<symbol|<image|<text/
const flat = new Map()
const drawable = (f) => {
  if (f && !flat.has(f)) flat.set(f, !LAYERED.test(source(f)))
  return f && flat.get(f) ? f : undefined
}
const symbols = new Map()
const symbol = (id) => {
  if (symbols.has(id)) return symbols.get(id)
  const svg = source(`${id.slice(3)}.svg`)
  const [vx, vy, vw] = svg.match(/<svg[^>]*viewBox="([^"]*)"/)[1].trim().split(/[\s,]+/).map(Number)
  const shapes = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/(\s)opacity="/g, '$1fill-opacity="')
  // the edge takes 2 of the box's 40 on each side
  const g = dark(svg)
    ? `<g transform="scale(${1 / (vw + 4)}) translate(${2 - vx} ${2 - vy})"><g stroke="#bdb8ca" stroke-width="2.4" stroke-linejoin="round">${shapes}</g>${shapes}</g>`
    : `<g transform="scale(${1 / vw}) translate(${-vx} ${-vy})">${shapes}</g>`
  return keep(symbols, 500, id, g.replace('<g ', `<g id="${id}" `))
}
// a picture's id in a card: its file's name ("tw-1f468-200d-1f469")
const ID = /href="#(tw-[0-9a-f-]+)"/g
/** A card with the pictures its lines use defined at its top. */
export const pictures = (svg) => {
  const open = svg.match(/<svg\b[^>]*>/)?.[0]
  if (!open) return svg
  const ids = new Set(Array.from(svg.matchAll(ID), (m) => m[1]))
  if (!ids.size) return svg
  return svg.replace(open, () => `${open}<defs>${[...ids].map(symbol).join('')}</defs>`)
}

const SEGMENTER = new Intl.Segmenter('en', { granularity: 'grapheme' })
export const graphemes = (s) => Array.from(SEGMENTER.segment(s), (x) => x.segment)
/** A text cut to at most n UTF-16 code units, at a grapheme boundary: a cut never splits an emoji sequence into a
 *  different one (or a character into half a surrogate pair). */
export const cut = (s, n) => {
  s = String(s)
  if (s.length <= n) return s
  let end = 0
  for (const { index, segment } of SEGMENTER.segment(s)) {
    if (index + segment.length > n) break
    end = index + segment.length
  }
  // a first grapheme longer than n on its own (a letter under hundreds of marks) is cut at a character instead, so
  // text never comes back empty
  if (!end) for (const c of s) if (end + c.length <= n) end += c.length; else break
  return s.slice(0, end)
}
const RGI = /^\p{RGI_Emoji}$/v
const PICTO = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u
// what makes a cluster an emoji sequence even without its VS16: a joiner, a keycap, a skin tone, a tag
const SEQUENCE = /[\u200D\u20E3\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]/u
// what resvg leaves out: joiners, variation selectors and the other default-ignorable characters (but for the four
// shorthand format controls and the Hangul fillers, "ㅤ" the usual "invisible" name, which it draws as boxes like any
// other character no font has)
const IGNORED = /(?![\u{1BCA0}-\u{1BCA3}\u{115F}\u{1160}\u{3164}\u{FFA0}])\p{Default_Ignorable_Code_Point}/u
const ALL_ZERO = /^(?:[\p{Mn}\p{Me}]|(?![\u{1BCA0}-\u{1BCA3}\u{115F}\u{1160}\u{3164}\u{FFA0}])\p{Default_Ignorable_Code_Point})+$/u

/** How a grapheme is drawn: Twemoji's picture (its file), "noto" for Noto Emoji's outline in the text's color, or
 *  null for text. An emoji is a picture, or Noto's outline when it's newer than Twemoji's set. A text-style pictograph
 *  ("✔", "♠" without VS16) is Inter's own glyph when Inter has one ("❤" alone is Inter's heart, with VS16 it's the red
 *  one), else Noto's outline, as browsers draw it with these fonts. */
export function kind(g) {
  const cp = g.codePointAt(0)
  const picture = drawable(PICTURES.get(hex(plain(g))))
  const noto = NOTO.glyph(cp) ? 'noto' : null
  // an emoji, or a sequence spelled without its VS16 ("❤‍🔥"); a sequence neither set draws as one is drawn in parts
  // (an emoji that is one already with a VS16 it doesn't need, "🎉\uFE0F" as some pickers write it, is one too)
  if (RGI.test(g) || RGI.test(plain(g)) || (SEQUENCE.test(g) && picture)) return picture || ([...plain(g)].length === 1 ? noto : null)
  // one pictograph (maybe with a variation selector); a longer cluster is drawn in parts
  return PICTO.test(g) && [...g.replace(/[\uFE0E\uFE0F]/g, '')].length === 1 && !REGULAR.glyph(cp) ? noto : null
}
/** What a grapheme is drawn as: itself, or, for a cluster no emoji set draws as one (🎉🏽, 👨‍🎉, an emoji newer than
 *  Twemoji's), its emoji one after another, the way browsers show it. A skin tone or keycap mark on a letter ("a🏽")
 *  comes off it: the tone as its swatch, the keycap mark dropped. */
const TONES = /[\u{1F3FB}-\u{1F3FF}]/gu
const parts = (g) => {
  if (kind(g) || [...g].length < 2) return [g]
  const ps = PICTO.test(g) ? g.split('\u{200D}').flatMap((p) => (kind(p) ? [p] : [...p])) : [g.replace(/[\u{1F3FB}-\u{1F3FF}\u{20E3}]/gu, ''), ...(g.match(TONES) || [])]
  return ps.filter((p) => p && !ALL_ZERO.test(p))
}
const pieces = (s) => graphemes(s).flatMap(parts)

// an emoji's advance and its picture's size and top, in em
const EMOJI = 1.22, SIZE = 1.08, TOP = 0.9

// What a character no font has takes: the missing-glyph box. A combining mark no font has is a box too, laid out the
// way resvg lays it out (measured): once a base has one, every mark on it is a box; the first box widens the base to a
// box's width (a narrow letter gets wider, a wide one doesn't), each one after that adds a box; and the boxes' ink ends
// half a box past the base, a box further for each one after the first, which can be past the end of the run.
const BOX = 0.66
// marks newer than the Unicode data resvg shapes with (Unicode 16 and 17): it lays them out as letters
const NEWER = /[\u{897}\u{1acf}-\u{1add}\u{1ae0}-\u{1aeb}\u{10d69}-\u{10d6d}\u{10efa}-\u{10efc}\u{113b8}-\u{113c0}\u{113c2}\u{113c5}\u{113c7}-\u{113ca}\u{113cc}-\u{113d0}\u{113d2}\u{113e1}\u{113e2}\u{11b60}-\u{11b67}\u{11f5a}\u{1611e}-\u{1612f}\u{1e5ee}\u{1e5ef}\u{1e6e3}\u{1e6e6}\u{1e6ee}\u{1e6ef}\u{1e6f5}]/u
const MARK = new RegExp(`(?!${NEWER.source})\\p{M}`, 'u')
const boxed = (c, font) => MARK.test(c) && !font.glyph(c.codePointAt(0)) && !NOTO.glyph(c.codePointAt(0))
// a letter and a mark of one script (the scripts with marks people write; any other pair counts as two scripts, which
// only makes a guess wider)
const SCRIPTS = 'Deva Beng Guru Gujr Orya Taml Telu Knda Mlym Sinh Thai Laoo Tibt Mymr Khmr Hebr Arab Syrc Thaa Nkoo Java Bali Sund Mong Tglg Ethi Hang'.split(' ').map((s) => new RegExp(`\\p{sc=${s}}`, 'u'))
const together = (a, b) => SCRIPTS.some((r) => r.test(a) && r.test(b))
const INHERITED = /\p{sc=Zinh}/u
/** A run's advance from its characters' (adv, which gives marks fonts have their own), with the marks no font has
 *  added as resvg adds them; ink: where the boxes' ink ends counts too, as it does at the end of a run. */
const laid = (run, adv, font, ink) => {
  let w = 0, end = 0, base = 0, marks = 0, box = false, own = 0
  const flush = () => {
    if (box) end = Math.max(end, w + base + 0.5 + BOX * (marks - 1)), (w += base + own + (marks === 1 ? Math.max(0, BOX - base) : 0.62 + BOX * (marks - 2)))
    else w += base + own
    base = marks = own = 0
    box = false
  }
  // a base that is a box itself, under a box mark of another script (a Myanmar sign on a Mongolian letter): resvg shapes
  // the two apart, so the mark is one more box, like a letter
  let bare = null
  for (const c of run) {
    if (IGNORED.test(c)) continue
    if (boxed(c, font) && bare && !INHERITED.test(c) && !together(c, bare)) flush(), (base = BOX)
    else if (boxed(c, font)) marks++, (box = true)
    else if (MARK.test(c)) marks++, (own += adv(c))
    else flush(), (base = adv(c)), (bare = !font.glyph(c.codePointAt(0)) && !NOTO.glyph(c.codePointAt(0)) ? c : null)
  }
  flush()
  return ink ? Math.max(w, end) : w
}

// the spaces other than " ", as resvg draws them (measured): the ideographic space Japanese text uses is a full em
const SPACES = new Map([[0xa0, 0.29], [0x1680, 0.66], [0x2000, 0.55], [0x2001, 1.1], [0x2002, 0.5], [0x2003, 1], [0x2004, 0.34], [0x2005, 0.25], [0x2006, 0.17], [0x2007, 0.65], [0x2008, 0.29], [0x2009, 0.19], [0x200a, 0.1], [0x202f, 0.19], [0x205f, 0.29], [0x3000, 1]])
// ponytail: per-character width guesses instead of real font metrics; fine for wrapping, may misjudge exotic scripts
const charW = (c) => (MARK.test(c) ? 0 : SPACES.has(c.codePointAt(0)) ? SPACES.get(c.codePointAt(0)) : /[iljI.,'!|:;`]/.test(c) ? 0.27 : c === ' ' ? 0.28 : /[mwMW@%]/.test(c) ? 0.86 : /[A-Z]/.test(c) ? 0.68 : /[0-9a-z]/.test(c) ? 0.56 : !REGULAR.glyph(c.codePointAt(0)) && !NOTO.glyph(c.codePointAt(0)) ? BOX : c.codePointAt(0) > 0x2e7f ? 1.05 : 0.6)
// an emoji is one glyph however many code points spell it
/** How far text draws: its runs between emoji each end where their boxes' ink does, when that's past their advance,
 *  as textSvg places what comes after them. Never less than the text's pieces measured apart, so a line's width can be
 *  added up word by word. */
export const width = (s, px) => {
  let w = 0, run = ''
  for (const p of pieces(s)) {
    if (!kind(p)) run += p
    else (w += laid(run, charW, REGULAR, true) + EMOJI), (run = '')
  }
  return (w + laid(run, charW, REGULAR, true)) * px
}
// What a word longer than the line breaks between: its graphemes, but a grapheme wider than the line on its own (a ZWJ
// chain of a hundred emoji, a letter with a hundred skin tones) between the pieces it's drawn as. A piece of text still
// wider than the line (a letter under dozens of marks no font has, each a box) keeps only the marks whose boxes' ink fits.
const fit = (p, px, max) => {
  const cs = [...p]
  let [lo, hi] = [1, cs.length]
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1
    if (laid(cs.slice(0, m).join(''), charW, REGULAR, true) * px <= max) lo = m
    else hi = m - 1
  }
  return cs.slice(0, lo).join('')
}
const units = (g, px, max, w) => (w(g, px) <= max ? [g] : parts(g).map((p) => (kind(p) || laid(p, charW, REGULAR, true) * px <= max ? p : fit(p, px, max))))
/** Text in at most `lines` lines of `max` px, the last one ending in "…" when it doesn't all fit. bold: measured as
 *  textSvg draws bold text (resvg's own advances, wider than width's guesses), for a line something has to fit after. */
export function wrap(text, px, max, lines, { bold = false } = {}) {
  const w = bold ? drawnBold : width
  const out = []
  // measured as textSvg draws it: without the characters XML can't hold (marks after one join the letter before it),
  // and a tab or carriage return as a space (marks after it go on that space)
  for (const para of clean(text).replace(/[\t\r]/g, ' ').split('\n')) {
    // the line's width is kept as it grows, so wrapping is linear in the text's length
    let line = '', lw = 0
    // a space with marks on it (which resvg draws, as boxes when no font has them) stays with the word after it
    for (const word of para.split(/(\s+(?!\p{M}))/u)) {
      const ww = w(word, px)
      if (lw + ww > max && line.trim()) out.push(line.trimEnd()), (line = word.trimStart()), (lw = w(line, px))
      else (line += word), (lw += ww)
      // a word longer than the line is cut where it stops fitting, never inside a grapheme that fits on a line
      if (lw > max) {
        const us = graphemes(line).flatMap((g) => units(g, px, max, w))
        const uws = us.map((u) => w(u, px))
        for (let i = 0; i < us.length; ) {
          let j = i + 1
          for (let s = uws[i]; j < us.length && s + uws[j] <= max; ) s += uws[j++]
          // drawn together, the pieces can take more room than apart (Inter's kerning and contextual forms: "ïïï" is
          // wider than three "ï"), so the line keeps the most of them that fits drawn whole
          if (j - i > 1 && w(us.slice(i, j).join(''), px) > max) {
            let [lo, hi] = [1, j - i - 1]
            while (lo < hi) {
              const m = (lo + hi + 1) >> 1
              if (w(us.slice(i, i + m).join(''), px) <= max) lo = m
              else hi = m - 1
            }
            j = i + lo
          }
          line = us.slice(i, j).join('')
          if (j < us.length) out.push(line)
          i = j
        }
        lw = w(line, px)
      }
      if (out.length > lines) break
    }
    out.push(line.trimEnd())
    if (out.length > lines) break
  }
  while (out.length && !out.at(-1)) out.pop()
  if (out.length > lines) {
    out.length = lines
    // the last line loses its last word for the ellipsis when it's a short one after others ("three four" ends
    // "three…"); a run of emoji isn't a word, each one is kept or not
    const gs = graphemes(out[lines - 1])
    const sp = gs.findLastIndex((g) => /\s/.test(g))
    const last = gs.slice(sp + 1).flatMap(parts)
    if (sp > 0 && gs.slice(0, sp).some((g) => !/\s/.test(g)) && last.length <= 12 && !last.some(kind)) gs.length = sp
    // and keeps as much of the rest as fits beside the "…" (a long word, a run of emoji, a line of skin-tone swatches),
    // down to the pieces a grapheme is drawn as
    const ps = gs.map(parts)
    const upTo = (n) => {
      const kept = []
      gs.forEach((g, i) => {
        if (n <= 0) return
        // what's left of a cluster cut into keeps its pieces apart with a zero-width space (which resvg leaves out, and
        // which always ends a grapheme), so they can't join up into another emoji: "👍🏻🏼" less a swatch is 👍 and 🏻, not 👍🏻
        kept.push(n >= ps[i].length ? g : ps[i].slice(0, n).join('\u{200B}'))
        n -= ps[i].length
      })
      while (kept.length && /\s/.test(kept.at(-1))) kept.pop()
      return kept.join('') + '…'
    }
    // (a line is never narrower for having more on it, so the most that fits is found by halving)
    let [lo, hi] = [0, ps.flat().length]
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1
      if (w(upTo(m), px) <= max) lo = m
      else hi = m - 1
    }
    out[lines - 1] = upTo(lo)
  }
  return out
}

/** Text without the characters XML can't hold (control codes other than tab and line breaks, lone surrogates,
 *  U+FFFE/U+FFFF): one in a name or cast would make resvg reject the whole card. */
// "Fancy" letters from name generators (𝐛𝐨𝐥𝐝, 𝓈𝒸𝓇𝒾𝓅𝓉, Ⓐ, Ｗｉｄｅ) that no card font has are drawn as the plain letters
// Unicode says they stand for (NFKC), when Inter has those, instead of as missing-glyph boxes. Anything else stays.
const folds = new Map()
const unfancy = (c) => {
  // spaces, marks and format characters keep their own handling (only what SVG collapses is collapsed)
  if (!/[\p{L}\p{N}\p{S}\p{P}]/u.test(c) || REGULAR.glyph(c.codePointAt(0)) || NOTO.glyph(c.codePointAt(0))) return c
  const f = c.normalize('NFKC')
  return f !== c && [...f].every((x) => REGULAR.glyph(x.codePointAt(0))) ? f : c
}
const fold = (c) => folds.get(c) ?? (folds.set(c, unfancy(c)), folds.get(c))
export const clean = (s) => String(s).replace(/[\0-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff\ufffe\uffff]/gu, '').replace(/[^\0-\u024f]/gu, fold)
export const esc = (s) => clean(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const num = (v) => Math.round(v * 10) / 10

// A run of text is measured by resvg itself, alone, the way the card draws it: Inter's contextual alternates (arrows,
// "*" after capitals, "_"…), its kerning, Noto Emoji for what Inter lacks, and the missing-glyph box for what neither
// font has all come out as resvg will draw them. Set flush left at 0, the run's ink starts at its first glyph's side
// bearing; set flush right at X, at X less its advance plus that same bearing, so the two give its advance. A mark no
// font has is a missing-glyph box that takes no room, so its box can stick out past the advance ("s̶t̶r̶i̶k̶e̶",
// Devanagari, Zalgo text): the run then ends where its ink does, so nothing after it is drawn over it. A run of only
// spaces has no ink: it's set flush right after a bar instead, and how far left the bar went is its advance.
const FONT_OPTIONS = { font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'Inter' } }
const X = 20000
const ink = (s, bold, end) => new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${X}" height="200"><text x="${end ? X : 0}" y="150"${end ? ' text-anchor="end"' : ''} font-family="Inter, Noto Emoji" font-size="100"${bold ? ' font-weight="700"' : ''} xml:space="preserve">${esc(s)}</text></svg>`, FONT_OPTIONS).getBBox()
const BARS = [false, true].map((bold) => ink('|', bold, true).x)
const laidOut = new Map()
const key = (run, bold) => `${bold ? 1 : 0}${run}`
/** A run of text's advance in em, as resvg lays it out (or where its ink ends, when that's further). */
export function measure(run, bold = false) {
  if (!run) return 0
  const k = key(run, bold)
  if (!laidOut.has(k)) {
    const start = ink(run, bold, false)
    const w = start ? Math.max(X - ink(run, bold, true).x + start.x, start.x + start.width) : BARS[+bold] - ink(`|${run}`, bold, true).x
    keep(laidOut, 500, k, w / 100)
  }
  return laidOut.get(k)
}
// Measuring is two renders on the main thread (about 1.5 ms, most of it loading the fonts), so a card measures at most
// MEASURED runs it hasn't seen before (the budget is per synchronous stretch, and a card's SVG is built in one); past
// that, a run's advance is guessed, so a cast of hundreds of short runs between emoji can't stall the server. The guess
// adds up each character's advance in the font resvg draws it with (Inter at the run's weight, Noto Emoji for what
// Inter lacks, the missing-glyph box for what neither has), with a little room for what that leaves out: Inter's wider
// contextual forms ("*" after a capital, "_" between letters), its few positive kerning pairs, and the ink of a mark
// with no advance that ends the run. It stays close to resvg's own advance, and never under it.
const MEASURED = 32
let fresh = 0
let refill = false
const spend = () => {
  if (!refill) (refill = true), (fresh = MEASURED), queueMicrotask(() => (refill = false))
  return fresh-- > 0
}
// The extra room resvg gives a character past its advance, at most, in em: Inter's contextual forms and positive kerning
// ("*" after a capital, "ï" next to another "ï", "_" between letters), and the marks Inter draws wide with no advance.
// Measured once against resvg for every character Inter has, alone, tripled and between letters; generated, not tuned.
const WIDER = [
  [1, /[\u{20dc}]/u],
  [0.92, /[\u{e2c2}]/u],
  [0.66, /[\u{20db}\u{20e8}]/u],
  [0.6, /[\u{e2c3}\u{e2c4}]/u],
  [0.2, /[\u{1dcd}]/u],
  [0.18, /[\u{e2bf}]/u],
  [0.16, /[*\u{209}]/u],
  [0.14, /[\u{ef}\u{457}\u{1e2f}\u{e240}\u{e241}\u{ee90}\u{ee9b}]/u],
  [0.12, /[\u{129}\u{12b}\u{12d}\u{390}\u{3ca}\u{1f32}-\u{1f37}\u{1fd0}-\u{1fd2}\u{1fd6}\u{1fd7}\u{e2a1}\u{e2a4}\u{e2a5}\u{ee07}]/u],
  [0.1, /[_\u{20b}\u{1dfc}]/u],
  [0.08, /[\u{2044}\u{215f}\u{e2c0}\u{e2c1}\u{ee9c}\u{f6c3}]/u],
  [0.06, /[\u{257}\u{ee0f}]/u],
  [0.04, /[\/\u{ce}\u{ee}\u{10f}\u{111}\u{134}\u{135}\u{187}\u{197}\u{1cf}\u{1d0}\u{1f0}\u{240}\u{25f}\u{26b}\u{434}\u{446}\u{449}\u{4b5}\u{1e3d}\u{e050}\u{e0e4}\u{eeba}]/u],
  [0.02, /[(7AVW\[ir{\u{c0}-\u{c6}\u{cd}\u{cf}\u{ec}\u{ed}\u{100}\u{102}\u{104}\u{128}\u{12c}\u{12f}\u{131}\u{133}\u{13a}\u{142}\u{155}\u{157}\u{159}\u{174}\u{193}\u{194}\u{19a}\u{1af}\u{1b9}\u{1c2}\u{1cd}\u{1de}\u{1e0}\u{1e2}\u{1fa}\u{1fc}\u{200}\u{202}\u{20a}\u{211}\u{213}\u{221}\u{226}\u{234}\u{235}\u{23a}\u{244}\u{249}-\u{24b}\u{24d}\u{256}\u{268}\u{26d}\u{273}\u{27b}\u{27e}\u{28c}\u{28e}\u{290}\u{29d}\u{2af}\u{2b3}\u{2de}\u{386}\u{391}\u{394}\u{39b}\u{3aa}\u{3c3}\u{3c4}\u{407}\u{410}\u{414}\u{433}\u{442}\u{44b}\u{453}\u{456}\u{466}\u{467}\u{474}\u{476}\u{48a}\u{48b}\u{491}\u{493}\u{4a2}\u{4a5}\u{4ad}\u{4b7}\u{4c5}\u{4c6}\u{4c9}\u{4ca}\u{4cd}\u{4ce}\u{4d0}\u{4d2}\u{4d4}\u{4f7}\u{4fb}\u{1d00}\u{1d1b}\u{1e00}\u{1e2c}-\u{1e2e}\u{1e39}\u{1e3b}\u{1e59}\u{1e5b}\u{1e5d}\u{1e5f}\u{1e71}\u{1e7c}\u{1e7e}\u{1e80}\u{1e82}\u{1e84}\u{1e86}\u{1e88}\u{1ea0}\u{1ea2}\u{1ea4}\u{1ea6}\u{1ea8}\u{1eaa}\u{1eac}\u{1eae}\u{1eb0}\u{1eb2}\u{1eb4}\u{1eb6}\u{1ec9}\u{1ecb}\u{1ee8}\u{1eea}\u{1eec}\u{1eee}\u{1ef0}\u{1f08}-\u{1f0f}\u{1f88}-\u{1f8f}\u{1fb8}-\u{1fbc}\u{1fd8}\u{2077}\u{20a7}\u{2163}\u{2164}\u{2174}\u{2206}\u{25b2}\u{25b3}\u{266b}\u{26a0}\u{e004}\u{e04b}-\u{e04f}\u{e05b}-\u{e05e}\u{e0bb}\u{e0f3}\u{e10a}\u{e10c}\u{e122}\u{e1e2}-\u{e1e7}\u{e1f6}\u{e1f7}\u{e219}\u{e21b}-\u{e21e}\u{e23f}\u{e242}\u{e243}\u{e245}\u{e249}\u{e256}-\u{e258}\u{e27b}\u{e280}-\u{e282}\u{e28d}\u{e2d9}\u{ee02}\u{ee06}\u{ee0e}\u{ee14}\u{ee1d}-\u{ee25}\u{ee80}\u{ee84}\u{eed5}]/u],
]
const extra = (c) => WIDER.find(([, r]) => r.test(c))?.[0] ?? 0
// a mark fonts have with no advance at a run's end can stick out past it by up to this much
const OVERHANG = 0.4
// What shaping can add that the sum above leaves out: a mark with no letter to sit on gets a dotted circle; a script's
// mark no font has, on a letter a font does, mixes scripts and fonts in one cluster (struck-through text's inherited
// marks don't); a format control, an unassigned code point or a private-use one can come out as a missing-glyph box.
// Each gets room for a box, and a run with any of them 10% more overall. The guess is never short (the sweep in
// text.test.mjs checks it); it runs wide by about that much instead. (2026-11-01: guessing these exactly grew to 1,600
// lines of special cases in a day and still ran short.)
const LOOSE = /[\p{Cf}\p{Cn}\p{Co}]/u, SPACE = /\p{Z}/u
const added = (run, font) => {
  let n = 0, prev = ' ', base = ' '
  for (const c of run) {
    const bare = prev === ' ' || LOOSE.test(prev) || IGNORED.test(prev) || SPACE.test(prev)
    if (LOOSE.test(c) || IGNORED.test(c) || (MARK.test(c) && bare && !INHERITED.test(c)) || (boxed(c, font) && !INHERITED.test(c) && (font.glyph(base.codePointAt(0)) || NOTO.glyph(base.codePointAt(0))))) n++
    if (!MARK.test(c)) base = c
    prev = c
  }
  return n
}
export const guess = (raw, bold = false) => {
  // as drawn: fancy letters folded (clean), like measure's
  const run = clean(raw)
  const font = bold ? BOLD : REGULAR
  const last = [...run].findLast((c) => !IGNORED.test(c) && !boxed(c, font))
  // a mark Inter has gets a little room for its own (they're a few hundredths of an em off their base)
  const adv = (c) => (font.advance(c.codePointAt(0)) ?? SPACES.get(c.codePointAt(0)) ?? NOTO.advance(c.codePointAt(0)) ?? BOX) + extra(c) + (MARK.test(c) ? 0.03 : 0)
  const tail = last && MARK.test(last) && !font.advance(last.codePointAt(0)) ? OVERHANG : 0
  // and Inter's few positive kerning pairs ("ty", "d)"), contextual forms and symbols whose ink passes their advance
  // ("ɥj", "℡", "⅟"): 2% and a tenth of an em more, which the sweep in text.test.mjs found enough for every run
  const n = added(run, font)
  // shaping decomposes what a font lacks the composed form of ("↮" is "↔" and a slash, U+0344 two marks): either may be drawn
  const w = Math.max(laid(run, adv, font, true), laid(run.normalize('NFD'), adv, font, true))
  return w * (n ? 1.1 : 1.02) + tail + 0.1 + n * BOX
}
let exact = 0
const advance = (run, bold) => (!run ? 0 : exact || laidOut.has(key(run, bold)) || spend() ? measure(run, bold) : guess(run, bold))
/** f(), with every run of text it lays out measured, past the card's budget too. For a few short lines with something
 *  placed after their drawn end, like glitter's sparkle after a theme's name: a guess runs wider than resvg draws a
 *  tightly kerned line ("TyTy", "AVAV"), so a line that wrapping found fits would be taken to end past its room. */
export function exactly(f) {
  exact++
  try {
    return f()
  } finally {
    exact--
  }
}

// Whitespace as SVG collapses it (only that: no-break and other wide spaces stay as they are), and a line as textSvg
// draws it, without the space that collapsing leaves at either end.
const collapsed = (s) => clean(s).replace(/[ \t\n\r]+/g, ' ')
const trimmed = (s) => collapsed(s).replace(/^ | $/g, '')
/** A line laid out as textSvg draws it: put(piece, x, kind) for each run of text and each emoji, x from the line's
 *  start, each where the one before it ends. Returns where the line ends; only text with something after it is
 *  measured, unless `whole` asks for the end of the last run too. */
function lay(l, size, bold, put, whole = false) {
  let cx = 0
  let run = ''
  const flush = (last) => {
    if (run) put?.(run, cx, null)
    if (!last || whole) cx += advance(run, bold) * size
    run = ''
  }
  for (const g of pieces(l)) {
    const k = kind(g)
    if (!k) {
      run += g
      continue
    }
    flush()
    put?.(g, cx, k)
    cx += (k === 'noto' ? (NOTO.advance(g.codePointAt(0)) ?? EMOJI) : EMOJI) * size
  }
  flush(true)
  return cx
}
/** Where a line of card text that textSvg draws at x ends, less x: its text as resvg draws it, its emoji as placed. */
export const ends = (l, size, bold = false) => lay(trimmed(l), size, bold, null, true)
// text measured as textSvg draws it bold, for wrapping a bold line: whitespace collapses but stays at the ends, so the
// words and spaces of a line add up to the line
const drawnBold = (s, px) => lay(collapsed(s), px, true, null, true)

/** Lines of card text with their emoji in color: a <text> of pieces, each placed where the one before it ends, then
 *  Twemoji's pictures in the gaps left for them. Whitespace collapses the way SVG text's does. `paint` (attributes, or a
 *  list of them for layers drawn bottom up, like a glow under the name) replaces the fill; it paints the text only, the
 *  pictures go on top once. */
export function textSvg(lines, { x, y, lh = 0, size, bold = false, weight = bold ? 700 : 400, fill, paint = `fill="${fill}"` }) {
  let spans = ''
  let pics = ''
  lines.forEach((l, i) => {
    const by = num(y + i * lh)
    lay(trimmed(l), size, weight >= 600, (g, at, k) => {
      const cx = x + at
      if (!k) spans += `<tspan x="${num(cx)}" y="${by}">${esc(g)}</tspan>`
      else if (k === 'noto') spans += `<tspan x="${num(cx)}" y="${by}" font-family="Noto Emoji">${esc(g)}</tspan>`
      else {
        const [px, py, ps] = [num(cx + ((EMOJI - SIZE) / 2) * size), num(by - TOP * size), num(SIZE * size)]
        pics += `<use href="#tw-${k.slice(0, -4)}" transform="translate(${px} ${py}) scale(${ps})"/>`
      }
    })
  })
  const layer = (attrs) => `<text font-family="Inter, Noto Emoji" font-size="${size}"${weight !== 400 ? ` font-weight="${weight}"` : ''} ${attrs} xml:space="preserve">${spans}</text>`
  return [paint].flat().map(layer).join('') + pics
}

// styled() text's table cells end in this (CELL in src/shared.ts)
const CELL = '\x1f'
// text as wrap sees it (clean), each character keeping the look it had at raw's offset `at` in the styled() text
function cleaned(raw, given, at) {
  let text = ''
  const marks = []
  for (const ch of raw) {
    const c = clean(ch)
    text += c
    for (let n = 0; n < c.length; n++) marks.push(given[at] || 0)
    at += ch.length
  }
  return { text, marks }
}
// wrapped lines found in their cleaned text in order, each with its characters' looks (a line that isn't found, as
// when wrap dropped a character XML can't hold, is drawn plain); the "…" wrap adds looks like what it follows
const found = (ls, { text, marks }) => {
  let from = 0
  return ls.map((l) => {
    const body = l.endsWith('…') ? l.slice(0, -1) : l
    const k = body ? text.indexOf(body, from) : -1
    if (k >= 0) from = k + body.length
    return { l, mark: (j) => (k < 0 ? 0 : marks[k + Math.min(j, body.length - 1)] || 0) }
  })
}
const isBold = (marks) => marks.some((m) => m & 17)

/** styled() text (src/shared.ts) in at most n lines (a fraction too) of max px, for richSvg: wrap()'s lines, except that a table's rows
 *  stay a line each with their cells in columns, each column as wide as its widest cell or an even share of what's
 *  left, a cell too wide for it ending in "…". A blank line, the gap between blocks, takes half a line (its `h`), and a
 *  table always has one above it. When it doesn't all fit, the last line or row says so with a "…". */
export function layout(raw, given, size, max, n) {
  const bold = isBold(given)
  const out = []
  let used = 0
  const push = (it) => (out.push(it), (used += it.h))
  const gap = () => push({ l: '', mark: () => 0, h: 0.5 })
  // runs of table rows and of other lines, each line with where it starts
  const groups = []
  let at = 0
  for (const l of raw.split('\n')) {
    const row = l.includes(CELL)
    if (groups.at(-1)?.row === row) groups.at(-1).lines.push([l, at])
    else groups.push({ row, lines: [[l, at]] })
    at += l.length + 1
  }
  const more = () => {
    while (out.at(-1)?.l === '') used -= out.pop().h
    const last = out.at(-1)
    if (!last || last.l?.endsWith('…')) return
    if (last.cells) out[out.length - 1] = { cells: [{ l: '…', mark: () => 0, x: 0, w: max, align: 0 }], h: 1 }
    // wrap's own "…" for a line with more after it, which may give up its last word for it
    else out[out.length - 1] = { ...last, l: wrap(`${last.l}\nx`, size, max, 1, { bold })[0] }
  }
  for (const g of groups) {
    if (g.row && out.length && out.at(-1).l !== '' && used + 1.5 <= n) gap()
    const room = Math.floor(n - used)
    if (room <= 0) return more(), out
    if (!g.row) {
      const text = g.lines.map(([l]) => l).join('\n')
      // blank lines take half a line, so wrap may have more lines than the room it was given
      const tall = (ls) => ls.reduce((a, l) => a + (l ? 1 : 0.5), 0)
      let ls = wrap(text || ' ', size, max, room, { bold })
      for (let r = room + 1; ; r++) {
        const next = wrap(text || ' ', size, max, r, { bold })
        if (next.length <= ls.length || tall(next) > n - used) break
        ls = next
      }
      for (const it of found(ls, cleaned(text, given, g.lines[0][1]))) push({ ...it, h: it.l ? 1 : 0.5 })
      // wrap drops blank lines at the end, here the gap before a table
      if (g.lines.at(-1)[0] === '' && used + 1.5 <= n) gap()
      continue
    }
    const rows = g.lines.map(([l, s]) => l.split(CELL).map((c) => ((s += c.length + 1), cleaned(c, given, s - c.length - 1))))
    const cols = Math.max(...rows.map((r) => r.length))
    const pad = Math.min(size * 0.9, max / cols / 4)
    const nat = Array.from({ length: cols }, (_, k) => Math.max(0, ...rows.map((r) => (r[k] ? (isBold(r[k].marks) ? drawnBold : width)(r[k].text, size) : 0))))
    // the narrowest columns get all they need, the rest share what's left evenly
    const w = Array(cols).fill(0)
    let left = max - pad * (cols - 1)
    ;[...nat.keys()].sort((a, b) => nat[a] - nat[b]).forEach((k, i) => (left -= w[k] = Math.max(0, Math.min(nat[k], left / (cols - i)))))
    const xs = w.map((_, k) => w.slice(0, k).reduce((a, b) => a + b, 0) + pad * k)
    const align = w.map((_, k) => rows.map((r) => r[k]?.marks.find((m) => m & 384)).find(Boolean) & 384)
    const tw = xs[cols - 1] + w[cols - 1]
    rows.slice(0, room).forEach((r, i) =>
      push({
        cells: r.map((c, k) => ({ ...found([c.text && (wrap(c.text, size, w[k], 1, { bold: isBold(c.marks) })[0] || '')], c)[0], x: xs[k], w: w[k], align: align[k] })),
        rule: i === rows.length - 1 ? 0 : i ? 1 : 2,
        width: tw,
        h: 1,
      }))
    if (rows.length > room) return more(), out
  }
  return out
}

/** Lines from layout() drawn with their Markdown's look: runs of one look each placed where the one before ends, bold
 *  for **bold**, headings and table headers, slanted for *italic*, struck through for ~~strike~~, in color for links,
 *  mentions and code, quotes muted behind a bar, and table rows as columns under a rule. */
export function richSvg(items, { x, y, lh, size, fill, accent, code, muted }) {
  const space = width(' ', size)
  const line = (l, mark, x, by) => {
    let out = ''
    let cx = x
    for (let j = 0; j < l.length; ) {
      const m = mark(j)
      let e = j + 1
      while (e < l.length && mark(e) === m) e++
      const run = l.slice(j, e)
      const core = run.trim()
      cx += (run.length - run.trimStart().length) * space
      if (core) {
        const bold = !!(m & 17)
        const color = m & 8 ? accent : m & 4 ? code : m & 32 ? muted : fill
        // measured, not guessed: a generous guess would leave a gap before the next run (the line's last needs none
        // unless it's struck through)
        const rw = e < l.length || m & 64 ? exactly(() => ends(core, size, bold)) : 0
        let svg = textSvg([core], { x: cx, y: by, size, bold, fill: color })
        if (m & 64) svg += `<rect x="${num(cx)}" y="${num(by - size * 0.34)}" width="${num(rw)}" height="${num(Math.max(2, size * 0.06))}" fill="${color}"/>`
        // slanted about the baseline, so the run stays where it was laid out
        out += m & 2 ? `<g transform="translate(${num(by * 0.2126)} 0) skewX(-12)">${svg}</g>` : svg
        cx += rw
      }
      if (core) cx += (run.length - run.trimEnd().length) * space
      j = e
    }
    return out
  }
  let out = ''
  let by = y - lh
  items.forEach((it, i) => {
    by += lh * (i ? items[i - 1].h : 1)
    if (!it.cells) {
      if (it.mark(0) & 32) out += `<rect x="${num(x - 22)}" y="${num(by - size * 0.85)}" width="4" height="${num(lh)}" rx="2" fill="${muted}"/>`
      out += line(it.l, it.mark, x, by)
      return
    }
    for (const c of it.cells) {
      const cw = c.align && c.l ? exactly(() => ends(c.l, size, !!(c.mark(0) & 17))) : 0
      out += line(c.l, c.mark, x + c.x + (c.align & 128 ? c.w - cw : c.align & 256 ? (c.w - cw) / 2 : 0), by)
    }
    // a rule under the header, fainter ones between rows, halfway to the next row's capitals
    if (it.rule) out += `<rect x="${num(x)}" y="${num(by + size * 0.4)}" width="${num(it.width)}" height="2" fill="${muted}" fill-opacity="${it.rule === 2 ? 0.6 : 0.2}"/>`
  })
  return out
}

/** A name's first letter in a circle (centered on cx), without its marks, or its first emoji when it starts with one
 *  (the first of a cluster drawn in parts). */
export function initial(name, cx, y, size, fill) {
  const g = graphemes(clean(name).replace(/^[\p{M}\p{Cf}\uFE00-\uFE0F\s]+/u, ''))[0]
  const p = g && parts(g)[0]
  const k = p && kind(p)
  if (k && k !== 'noto') return textSvg([p], { x: cx - (EMOJI * size) / 2, y, size, fill })
  return `<text x="${cx}" y="${y}" font-family="Inter, Noto Emoji" font-weight="700" font-size="${size}" fill="${fill}" text-anchor="middle">${esc((g && [...g][0])?.toUpperCase() || '?')}</text>`
}
