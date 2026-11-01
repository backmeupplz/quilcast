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

// The GSUB features the shaper applies to horizontal text unless it's told not to (rustybuzz's defaults; the kerning
// and mark positioning ones are GPOS's)
const DEFAULT_FEATURES = new Set(['rvrn', 'ccmp', 'locl', 'rlig', 'rclt', 'calt', 'clig', 'liga'])

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
  // where a glyph's ink ends right of its origin (glyf's xMax), and where marks attach: GPOS mark-to-base (4) and
  // mark-to-mark (6) anchors, as each mark's (lookup, class, anchor x) and each base's anchor x by lookup and class
  const s16 = (o) => b.readInt16BE(o)
  const long = t.glyf && s16(t.head + 50)
  const loca = (id) => (long ? b.readUInt32BE(t.loca + 4 * id) : 2 * u16(t.loca + 2 * id))
  const marks = new Map(), bases = new Map()
  const covered = (o) => {
    const ids = []
    if (u16(o) === 1) for (let i = 0; i < u16(o + 2); i++) ids.push(u16(o + 4 + 2 * i))
    else for (let i = 0; i < u16(o + 2); i++) for (let g = u16(o + 4 + 6 * i); g <= u16(o + 6 + 6 * i); g++) ids.push(g)
    return ids
  }
  const anchors = (o, type, key) => {
    // MarkBasePos and MarkMarkPos format 1 share a layout: the marks' coverage, the bases' (or the marks below's), the
    // number of classes, the marks' classes and anchors, and the bases' anchors by class (0: none)
    const [mc, bc, classes, ma, ba] = [o + u16(o + 2), o + u16(o + 4), u16(o + 6), o + u16(o + 8), o + u16(o + 10)]
    covered(mc).forEach((id, i) => (marks.get(id) ?? marks.set(id, []).get(id)).push([type, key, u16(ma + 2 + 4 * i), s16(ma + u16(ma + 4 + 4 * i) + 2) / upm]))
    covered(bc).forEach((id, i) => {
      for (let k = 0; k < classes; k++) {
        const a = u16(ba + 2 + 2 * (i * classes + k))
        if (a) (bases.get(id) ?? bases.set(id, new Map()).get(id)).set(`${key}:${k}`, s16(ba + a + 2) / upm)
      }
    })
  }
  // and its pair adjustments (2: kerning), by lookup, each subtable as the glyphs it covers (first of a pair), at their
  // coverage index, and how far it moves the next glyph's pen after a pair: the first glyph's x advance adjustment
  const pairs = []
  const classes = (o) => {
    const k = new Map()
    if (u16(o) === 1) for (let i = 0; i < u16(o + 4); i++) k.set(u16(o + 2) + i, u16(o + 6 + 2 * i))
    else for (let i = 0; i < u16(o + 2); i++) for (let g = u16(o + 4 + 6 * i); g <= u16(o + 6 + 6 * i); g++) k.set(g, u16(o + 8 + 6 * i))
    return k
  }
  const bits = (f) => (f.toString(2).match(/1/g) ?? []).length
  const pair = (o) => {
    const [f1, f2] = [u16(o + 4), u16(o + 6)]
    const [size, x] = [2 * (bits(f1) + bits(f2)), f1 & 4 ? 2 * bits(f1 & 3) : -1]
    const index = new Map(covered(o + u16(o + 2)).map((id, i) => [id, i]))
    if (u16(o) === 1) {
      return Object.assign((a, z) => {
        if (!index.has(a)) return undefined
        const set = o + u16(o + 10 + 2 * index.get(a))
        // (its pairs are in the order of the second glyph)
        let [lo, hi] = [0, u16(set) - 1]
        while (lo <= hi) {
          const m = (lo + hi) >> 1
          const g = u16(set + 2 + m * (2 + size))
          if (g === z) return x < 0 ? 0 : s16(set + 4 + m * (2 + size) + x)
          if (g < z) lo = m + 1
          else hi = m - 1
        }
        return undefined
      }, {
        index,
        // (the most it adjusts the glyph by, before any other)
        most: (a) => {
          const set = o + u16(o + 10 + 2 * index.get(a))
          let m = -Infinity
          for (let i = 0; i < u16(set); i++) m = Math.max(m, x < 0 ? 0 : s16(set + 4 + i * (2 + size) + x))
          return m
        },
      })
    }
    const [one, two, n2] = [classes(o + u16(o + 8)), classes(o + u16(o + 10)), u16(o + 14)]
    const at = (a, k) => (x < 0 ? 0 : s16(o + 16 + ((one.get(a) ?? 0) * n2 + k) * size + x))
    return Object.assign((a, z) => (!index.has(a) ? undefined : at(a, two.get(z) ?? 0)), {
      index,
      most: (a) => Math.max(...Array.from({ length: n2 }, (_, k) => at(a, k))),
    })
  }
  // (by lookup, the subtables that have pairs a glyph is the first of: only those are looked through for its kerning)
  const firsts = new Map()
  const kerns = (g) => firsts.get(g) ?? firsts.set(g, pairs.map((subtables) => subtables.filter((p) => p.index.has(g))).filter((s) => s.length)).get(g)
  if (t.GPOS) {
    const list = t.GPOS + u16(t.GPOS + 8)
    for (let l = 0; l < u16(list); l++) {
      const lookup = list + u16(list + 2 + 2 * l)
      const subtables = []
      for (let s = 0; s < u16(lookup + 4); s++) {
        let [type, o] = [u16(lookup), lookup + u16(lookup + 6 + 2 * s)]
        if (type === 9) [type, o] = [u16(o + 2), o + b.readUInt32BE(o + 4)]
        if ((type === 4 || type === 6) && u16(o) === 1) anchors(o, type, `${l}.${s}`)
        if (type === 2 && (u16(o) === 1 || u16(o) === 2)) subtables.push(pair(o))
      }
      if (subtables.length) pairs.push(subtables)
    }
  }
  // and the glyphs the substitutions the shaper applies by default can swap a glyph for (GSUB single substitutions (1)
  // of the default features' lookups, or of the lookups a contextual (5) or chained contextual (6) one of them applies,
  // through extensions (7)): Inter's contextual alternates draw "(" next to a capital as its case form, which it kerns
  // wider before "Ï" than "(" (+0.028 em, bold +0.051), so a guess can take a pair as kerned as the widest of the forms
  // either glyph can take, wherever it is (so "(j" counts the case form's kerning too: a little wider, never short).
  // Not the features text has to ask for, like small capitals', nor the fraction forms the shaper puts around "⁄" by
  // itself, which are narrower than the digits (swept: no guess with them was short)
  const alternates = new Map()
  if (t.GSUB) {
    const list = t.GSUB + u16(t.GSUB + 8)
    const subtables = (l) => {
      const lookup = list + u16(list + 2 + 2 * l)
      return Array.from({ length: u16(lookup + 4) }, (_, s) => {
        const o = lookup + u16(lookup + 6 + 2 * s)
        return u16(lookup) === 7 ? [u16(o + 2), o + b.readUInt32BE(o + 4)] : [u16(lookup), o]
      })
    }
    const applied = new Set()
    const features = t.GSUB + u16(t.GSUB + 6)
    for (let i = 0; i < u16(features); i++) {
      if (!DEFAULT_FEATURES.has(b.toString('latin1', features + 2 + 6 * i, features + 6 + 6 * i))) continue
      const f = features + u16(features + 6 + 6 * i)
      for (let k = 0; k < u16(f + 2); k++) applied.add(u16(f + 4 + 2 * k))
    }
    const records = (n, p) => {
      for (let i = 0; i < n; i++) applied.add(u16(p + 2 + 4 * i))
    }
    // (a chained rule: the glyphs before, the input past its first glyph, the glyphs after, then the lookups it applies;
    // format 3 has coverages instead of glyphs, and the whole input)
    const chained = (p, whole) => {
      p += 2 + 2 * u16(p)
      p += (whole ? 2 : 0) + 2 * u16(p)
      p += 2 + 2 * u16(p)
      records(u16(p), p + 2)
    }
    // (and the lookups those apply, as they're found)
    for (const l of applied) {
      for (const [type, o] of subtables(l)) {
        const f = u16(o)
        if (type === 5 && f === 3) records(u16(o + 4), o + 6 + 2 * u16(o + 2))
        else if (type === 5 && (f === 1 || f === 2)) {
          // (a rule: the input past its first glyph, the lookups it applies)
          const sets = f === 1 ? o + 4 : o + 6
          for (let i = 0; i < u16(sets); i++) {
            const set = u16(sets + 2 + 2 * i) && o + u16(sets + 2 + 2 * i)
            for (let r = 0; set && r < u16(set); r++) {
              const p = set + u16(set + 2 + 2 * r)
              records(u16(p + 2), p + 4 + 2 * (u16(p) - 1))
            }
          }
        } else if (type === 6 && f === 3) chained(o + 2, true)
        else if (type === 6 && (f === 1 || f === 2)) {
          const sets = f === 1 ? o + 4 : o + 10
          for (let i = 0; i < u16(sets); i++) {
            const set = u16(sets + 2 + 2 * i) && o + u16(sets + 2 + 2 * i)
            for (let r = 0; set && r < u16(set); r++) chained(set + u16(set + 2 + 2 * r), false)
          }
        }
      }
    }
    const add = (from, to) => (alternates.get(from) ?? alternates.set(from, new Set()).get(from)).add(to)
    for (const l of applied) {
      for (const [type, o] of subtables(l)) {
        if (type !== 1) continue
        if (u16(o) === 1) for (const id of covered(o + u16(o + 2))) add(id, (id + u16(o + 4)) & 0xffff)
        else if (u16(o) === 2) covered(o + u16(o + 2)).forEach((id, i) => add(id, u16(o + 6 + 2 * i)))
      }
    }
  }
  const kernOf = (ga, gz) => {
    let k = 0
    for (const subtables of kerns(ga)) {
      for (const p of subtables) {
        const v = p(ga, gz)
        if (v !== undefined) {
          k += v
          break
        }
      }
    }
    return k
  }
  // (kern(a, z, true) by glyph pair, as they're asked for, up to a limit; and most() by glyph)
  const anyKern = new Map()
  const mosts = new Map()
  // (a form of a form too)
  const formed = new Map()
  const forms = (g) => {
    if (formed.has(g)) return formed.get(g)
    const all = new Set([g])
    for (const x of all) for (const y of alternates.get(x) ?? []) all.add(y)
    return formed.set(g, all).get(g)
  }
  // the glyphs GDEF calls marks (class 3): a mark is attached to the last glyph before it that isn't one
  const marked = new Set()
  const cd = t.GDEF && u16(t.GDEF + 4) && t.GDEF + u16(t.GDEF + 4)
  if (cd && u16(cd) === 1) for (let i = 0; i < u16(cd + 4); i++) u16(cd + 6 + 2 * i) === 3 && marked.add(u16(cd + 2) + i)
  else if (cd) for (let i = 0; i < u16(cd + 2); i++) if (u16(cd + 8 + 6 * i) === 3) for (let g = u16(cd + 4 + 6 * i); g <= u16(cd + 6 + 6 * i); g++) marked.add(g)
  return {
    glyph: (cp) => glyphs.get(cp) || undefined,
    advance: (cp) => {
      const id = glyphs.get(cp)
      return id ? u16(t.hmtx + 4 * Math.min(id, hmetrics - 1)) / upm : undefined
    },
    reach: (cp) => {
      const id = glyphs.get(cp)
      return id && t.glyf && loca(id + 1) > loca(id) ? s16(t.glyf + loca(id) + 6) / upm : undefined
    },
    // how far right of the base's (or, onto: 6, the mark below's) origin a mark goes when it attaches to it, in em, as
    // the last lookup that attaches it puts it (by the first of its subtables that does); undefined when none does
    attach: (mark, base, onto = 4) => {
      const bs = bases.get(glyphs.get(base))
      let x, done
      for (const [type, key, k, mx] of marks.get(glyphs.get(mark)) ?? []) {
        const lookup = key.split('.')[0]
        if (type === onto && lookup !== done && bs?.has(`${key}:${k}`)) (x = bs.get(`${key}:${k}`) - mx), (done = lookup)
      }
      return x
    },
    mark: (cp) => marked.has(glyphs.get(cp)),
    // how much wider the pair adjustments make the first of two characters drawn next to each other, in em: each lookup
    // adjusts it by its first subtable that has the pair. any: the most for any forms the contextual lookups can draw
    // them as, not only their own glyphs ("(" "Ï" after a capital)
    kern: (a, z, any = false) => {
      const ga = glyphs.get(a.codePointAt(0))
      const gz = glyphs.get(z.codePointAt(0))
      if (!ga || !gz) return 0
      if (!any) return kernOf(ga, gz) / upm
      const key = ga * 0x10000 + gz
      if (!anyKern.has(key)) {
        let most = -Infinity
        for (const fa of forms(ga)) for (const fz of forms(gz)) most = Math.max(most, kernOf(fa, fz))
        if (anyKern.size >= 1e5) anyKern.clear()
        anyKern.set(key, most / upm)
      }
      return anyKern.get(key)
    },
    // the most the pair adjustments can make a character (any of its forms) wider before any other, in em: each lookup
    // by the most any of its subtables that have pairs it's the first of adjusts it, or none
    most: (a) => {
      const ga = glyphs.get(a.codePointAt(0))
      if (!ga) return 0
      if (!mosts.has(ga)) mosts.set(ga, Math.max(...[...forms(ga)].map((f) => kerns(f).reduce((k, subtables) => k + Math.max(0, ...subtables.map((p) => p.most(f))), 0))) / upm)
      return mosts.get(ga)
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
// other character no font has, and the newest Mongolian variation selector, which it draws as a mark no font has)
const IGNORED = /(?![\u{1BCA0}-\u{1BCA3}\u{115F}\u{1160}\u{3164}\u{FFA0}\u{180F}])\p{Default_Ignorable_Code_Point}/u
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
// box's width (a narrow letter gets wider, a wide one doesn't), and more boxes don't widen it further (the guess still
// takes two boxes 0.62 past the base's own width and a box more for each one after that, an over-count, but never less
// than a box's width in all, so boxes opening a run with no letter under them take a box too: what follows them starts
// there); and the boxes' ink ends half a box past the base, a box further for each one after the first, which can be
// past the end of the run.
const BOX = 0.66
// Marks newer than resvg's Unicode (16 and 17's) are characters it doesn't know, each a box of its own like a letter no
// font has, not one on the letter before it. Measured against resvg for every mark; regenerate it if resvg is updated.
const NEWER = /[\u{897}\u{1acf}-\u{1add}\u{1ae0}-\u{1aeb}\u{10d69}-\u{10d6d}\u{10efa}-\u{10efc}\u{113b8}-\u{113c0}\u{113c2}\u{113c5}\u{113c7}-\u{113ca}\u{113cc}-\u{113d0}\u{113d2}\u{113e1}\u{113e2}\u{11b60}-\u{11b67}\u{11f5a}\u{1611e}-\u{1612f}\u{1e5ee}\u{1e5ef}\u{1e6e3}\u{1e6e6}\u{1e6ee}\u{1e6ef}\u{1e6f5}]/u
const MARK = new RegExp(`(?!${NEWER.source})\\p{M}`, 'u')
const boxed = (c, font) => MARK.test(c) && !font.glyph(c.codePointAt(0)) && !NOTO.glyph(c.codePointAt(0))
// Thai and Lao sara am. In a run resvg shapes as Thai (its first character of any script is Thai or Lao), the shaper
// splits it into nikhahit and sara aa, two boxes in the cluster of the character before it (or, starting the run, a box
// with a box on it). Such a cluster advances a box (or its first character's advance, when that's wider), but its boxes
// are drawn one after another, so their ink ends a box further for each one: "น้ำ" is four boxes of ink on one box of
// advance, and at a run's end draws far past it. In any other run it's one box like any letter no font has.
const AM = /[\u0e33\u0eb3]/u
// Hebrew's points (niqqud, cantillation)
const POINTS = /[\u{591}-\u{5c7}]/u
// The characters newer than resvg's scripts (Unicode 16 and 17's): it has none for them, so they don't decide how a
// run is shaped ("\u{113b8}ຳ" after a right-to-left letter is shaped as Lao). From DerivedAge.txt; regenerate it if resvg
// is updated.
const UNKNOWN = /[\u{88f}\u{897}\u{c5c}\u{cdc}\u{1acf}-\u{1add}\u{1ae0}-\u{1aeb}\u{1b4e}-\u{1b4f}\u{1b7f}\u{1c89}-\u{1c8a}\u{20c1}\u{2427}-\u{2429}\u{2b96}\u{31e4}-\u{31e5}\u{a7cb}-\u{a7cf}\u{a7d2}\u{a7d4}\u{a7da}-\u{a7dc}\u{a7f1}\u{fbc3}-\u{fbd2}\u{fd90}-\u{fd91}\u{fdc8}-\u{fdce}\u{105c0}-\u{105f3}\u{10940}-\u{10959}\u{10d40}-\u{10d65}\u{10d69}-\u{10d85}\u{10d8e}-\u{10d8f}\u{10ec2}-\u{10ec7}\u{10ed0}-\u{10ed8}\u{10efa}-\u{10efc}\u{11380}-\u{11389}\u{1138b}\u{1138e}\u{11390}-\u{113b5}\u{113b7}-\u{113c0}\u{113c2}\u{113c5}\u{113c7}-\u{113ca}\u{113cc}-\u{113d5}\u{113d7}-\u{113d8}\u{113e1}-\u{113e2}\u{116d0}-\u{116e3}\u{11b60}-\u{11b67}\u{11bc0}-\u{11be1}\u{11bf0}-\u{11bf9}\u{11db0}-\u{11ddb}\u{11de0}-\u{11de9}\u{11f5a}\u{13460}-\u{143fa}\u{16100}-\u{16139}\u{16d40}-\u{16d79}\u{16ea0}-\u{16eb8}\u{16ebb}-\u{16ed3}\u{16ff2}-\u{16ff6}\u{187f8}-\u{187ff}\u{18cff}\u{18d09}-\u{18d1e}\u{18d80}-\u{18df2}\u{1cc00}-\u{1ccfc}\u{1cd00}-\u{1ceb3}\u{1ceba}-\u{1ced0}\u{1cee0}-\u{1cef0}\u{1e5d0}-\u{1e5fa}\u{1e5ff}\u{1e6c0}-\u{1e6de}\u{1e6e0}-\u{1e6f5}\u{1e6fe}-\u{1e6ff}\u{1f6d8}\u{1f777}-\u{1f77a}\u{1f8b2}-\u{1f8bb}\u{1f8c0}-\u{1f8c1}\u{1f8d0}-\u{1f8d8}\u{1fa54}-\u{1fa57}\u{1fa89}-\u{1fa8a}\u{1fa8e}-\u{1fa8f}\u{1fabe}\u{1fac6}\u{1fac8}\u{1facd}\u{1fadc}\u{1fadf}\u{1fae9}-\u{1faea}\u{1faef}\u{1fbcb}-\u{1fbef}\u{1fbfa}\u{2b73a}-\u{2b73f}\u{2cea2}-\u{2cead}\u{323b0}-\u{33479}]/u
const THAI = new RegExp(`^(?:[\\p{sc=Zyyy}\\p{sc=Zinh}\\p{sc=Zzzz}]|${UNKNOWN.source})*[\\p{sc=Thai}\\p{sc=Laoo}]`, 'u')
// The default-ignorables resvg starts a new cluster at (a soft hyphen, the zero-width space and non-joiner, the word
// joiner, the BOM, direction marks…): the marks after one have no base, like marks opening a run, and take a box. The
// rest (the joiner, variation selectors, tags) keep them on the character before. Measured against resvg for every
// default-ignorable.
const BREAKS = /[\u{ad}\u{61c}\u{180e}\u{200b}\u{200c}\u{200e}\u{200f}\u{202a}-\u{202e}\u{2060}-\u{206f}\u{feff}\u{fff0}-\u{fff8}\u{1d173}-\u{1d17a}\u{e0000}-\u{e001f}\u{e0080}-\u{e00ff}\u{e01f0}-\u{e0fff}]/u
const starts = (c) => (IGNORED.test(c) ? BREAKS.test(c) : !MARK.test(c))
const SCRIPTED = /[^\p{Script=Common}\p{Script=Inherited}\p{Script=Unknown}]/u
const UNMARKED = /[\p{Script=Cyrillic}\p{Script=Greek}]/u
const JOINS = /[\u{200d}\u{180b}-\u{180d}\u{e0020}-\u{e007f}]/u
const DOTTED = { ı: 'i', ȷ: 'j' }
// whole: a break doesn't start a cluster (resvg doesn't always cut there)
const layAt = (run, adv, font, ink, thai, hang, { far = false, hebrew = false, over, room }, whole) => {
  let w = 0, end = 0, base = 0, marks = 0, box = false, own = 0, am = false, hung = false, started = false, i = -1, letter = '', points = true, ends = 0
  // A mark the font has that nothing anchors (it has no letter under it, or one with no place for it: a digit, "#", a
  // letter of another font or none) is drawn where the pen is, after its base and the marks before it, and its ink
  // reaches right of there, as resvg draws it (measured); a mark stacked on such a mark goes where that one's anchor
  // puts it. For a run drawn alone (hang). of: the cluster's base; below: the marks on it the font has, with how far
  // right of the pen each is (null: anchored); and whether a joiner or another invisible character came after the base.
  // drift: how far right of its pen such a mark's ink reaches, at most: in a run bidi turns around (a stretch shaped
  // right to left, right-to-left letters, or a right-to-left mark, embedding, override or isolate, as U+200F U+0308 "1"
  // is drawn "1" then the mark), it can be drawn anywhere in it, up to its end.
  let of = '', below = new Map(), joined = false, hidden = false, drift = 0
  // The pen such a mark is drawn at is past the letter as resvg draws it, which can be wider than the letter: with a mark
  // after it, the character it normalizes to (the Greek varia as "`"), or the one it composes into with the mark ("l"
  // U+030C is "ľ"; past a joiner it may be or not, "і" U+200D U+0308 can be "ї"). drawn: those characters, any of which
  // it may be drawn as; loose: how far right the cluster's unanchored marks' ink reaches. And Inter's
  // kerning between the letter and the next one widens the letter's advance, so it moves those marks right too ("1"
  // U+0308 "ï" has the diaeresis further right than "1" U+0308 alone, as "1ï" is kerned wider): before, reach: the
  // letter of the cluster before, as drawn, and how far its unanchored marks reach (-Infinity: none). (Its kerning with
  // the letter before it puts the pen further right as well: "l" "ĩ" U+200D U+0308.)
  let drawn = '', loose = -Infinity, before = '', reach = -Infinity, roomed = 0
  const singleton = (c) => {
    const n = c.normalize('NFC')
    return n !== c && [...n].length === 1 && font.glyph(n.codePointAt(0)) ? n : c
  }
  const widest = (d) => Math.max(0, ...[...d].map(adv))
  const kerned = (a, z) => {
    let k = 0
    for (const x of a) for (const y of z) k = Math.max(k, font.kern(x, y, true))
    return k
  }
  // The shaper takes the run's script from its first letter, and Inter positions no marks in Cyrillic or Greek text
  // ("Ж̂" has the mark after the letter, "aЖ̂" over it); every other script, or none, gets its default (Latin) marks
  const marked = hang && !UNMARKED.test(run.match(SCRIPTED)?.[0] ?? '')
  const pen = (c) => {
    const m = c.codePointAt(0)
    if (letter && drawn === letter) drawn = singleton(letter)
    // a letter and the mark right on it that make a character the font has are drawn as it ("Жa" U+0302 is "Жâ")
    const one = !below.size && !hidden && of && (of + c).normalize('NFC')
    if (one && [...one].length === 1 && font.glyph(one.codePointAt(0))) {
      if (!joined) return void (of = drawn = one)
      if (!drawn.includes(one)) drawn += one
    }
    // (and Inter draws a dotless "ı" or "ȷ" with a mark on it as the dotted letter with it, which kerns as that: "ı"
    // U+0308 is kerned as "ï", measured for every mark above)
    const dot = !below.size && DOTTED[of] && (DOTTED[of] + c).normalize('NFC')
    if (dot && [...dot].length === 1 && font.glyph(dot.codePointAt(0)) && !drawn.includes(dot)) drawn += dot
    // where it goes: on a mark below it with no anchor (not only the last: a lookup can skip marks of another class),
    // wherever that is, or at the pen when nothing anchors it; the furthest right of those it could go
    let x = marked && !joined && of && font.attach(m, of.codePointAt(0)) !== undefined ? null : 0
    for (const [p, px] of marked ? below : []) {
      const d = px === null ? undefined : font.attach(m, p, 6)
      if (d !== undefined) x = Math.max(x ?? -Infinity, px + d)
    }
    const right = x === null ? -Infinity : x + (font.reach(m) ?? 0)
    // (past the letter as drawn, and its kerning with the letter before, past the room counted after that one)
    const at = w + Math.max(0, kerned(before, drawn) - roomed) + Math.max(base, widest(drawn)) + own + right
    end = Math.max(end, at)
    loose = Math.max(loose, at)
    drift = Math.max(drift, right)
    // (one the font doesn't call a mark, like the Cyrillic "҈", is the base of the marks after it; a mark repeated on
    // the letter counts once, where it goes furthest right: what goes on it depends only on that)
    if (font.glyph(m) && !font.mark(m)) (of = c), (below = new Map())
    else if (!below.has(m) || (x !== null && (below.get(m) === null || x > below.get(m)))) below.set(m, x)
  }
  const flush = () => {
    // (a letter's room for kerning and wider forms is on top of the box its boxes widen it to: resvg kerns the widened
    // letter as it kerns the letter, "l" and "ΐ" with a box on it as "lΐ")
    const r = letter && room ? room(letter, marks > 0) : 0
    // (the letter before is kerned wider with this one, as this one is drawn, than the room counted after it for a few
    // pairs: "ď]" +0.088 em, bold +0.131, "ȴj"; that puts this cluster further right. Only with room counted: a run
    // without it is guessed at its advance, the room added by whoever asks)
    const d = letter && marks && drawn === letter ? singleton(letter) : drawn
    const k = letter ? kerned(before, d) : 0
    if (letter && room) w += Math.max(0, k - roomed)
    // (a mark's overhang is past the letter as its boxes widen it, or past the boxes' ink when it ends further, as
    // resvg sets a mark after a box against the box)
    // (shaped right to left, a letter's boxes start past its ink, not its advance: up to a box further, unless it's a
    // box itself or a space, which has no ink)
    // (with no letter under them, the boxes' ink can end a whole box past the pen each, not half of one for the first:
    // U+05C1 and a Devanagari vowel sign before a bidi control or a word joiner are drawn as two full boxes; measured)
    const boxes = w + base + r + (letter ? 0.5 : BOX) + BOX * (marks - 1) + own + (far && has(letter, font) && !/\p{Zs}/u.test(letter) ? BOX : 0)
    // (shaped as Hebrew, Hebrew points no font has are drawn within a letter no font has)
    if (hebrew && box && !am && points && letter && !has(letter, font)) w += base + r + own
    else if (am) end = Math.max(end, boxes), (w += Math.max(base, BOX) + r + own)
    else if (box) end = Math.max(end, boxes), (w += base + r + own + Math.max(BOX - base, marks === 1 ? 0 : 0.62 + BOX * (marks - 2)))
    else w += base + r + own
    // (and shaped right to left, any mark on nothing, after a direction mark, up to 0.17 further; measured)
    if (hung) end = Math.max(end, (box ? Math.max(w, boxes) : w) + OVERHANG + (far && !letter ? 0.2 : 0))
    // (and a letter whose ink ends past its advance reaches past what comes after it when that's narrower: "\u{e2c2} ")
    end = Math.max(end, w + ends)
    // (the unanchored marks of the letter before are moved right by its kerning with this one, as this one is drawn; the
    // marks after a break with no letter of their own are drawn after that letter too)
    if (letter) {
      if (reach > -Infinity) end = Math.max(end, reach + k)
      ;(before = d), (reach = loose), (roomed = r)
    } else reach = Math.max(reach, loose)
    base = marks = own = ends = 0
    box = am = hung = joined = hidden = false
    of = drawn = ''
    below = new Map()
    letter = ''
    points = true
    loose = -Infinity
  }
  for (const c of run) {
    i++
    if (!whole && BREAKS.test(c)) flush()
    // the invisible characters the cluster goes on after keep a letter and a mark after them from making one character
    // ("Ж" U+FE0F U+0308 isn't "Ӝ"), and a joiner, a Mongolian variation selector or a tag leaves the marks after it
    // nothing to go on ("x" U+200D U+0302 has the mark after the pen; one that would make a character with the letter
    // can be over it, "a" U+200D U+0308 is drawn as "ä", which a guess doesn't count on). Measured for every one.
    else if (IGNORED.test(c)) JOINS.test(c) ? (joined = true) && (below = new Map()) : (hidden = true)
    else if (thai && AM.test(c)) started ? (marks += 2) : ((base = BOX), marks++), (box = am = started = true), (of = ''), (below = new Map())
    else if (boxed(c, font)) marks++, (box = started = true), (of = ''), (below = new Map()), (points &&= POINTS.test(c))
    else if (MARK.test(c)) {
      if (hang) pen(c)
      marks++, (own += adv(c)), (started = true)
      if (hang?.(i) && (!font.advance(c.codePointAt(0)) || (far && !letter))) hung = true
    } else flush(), (base = adv(c)), (letter = drawn = c), (ends = over?.(c) ?? 0), (started = true), (of = c)
  }
  flush()
  if (drift > 0 && (far || LEFTWARD.test(run))) end = Math.max(end, w + drift)
  return ink ? Math.max(w, end) : w
}
// A run with a break in it, unless it's said where resvg cuts (o.whole), takes the wider of laying it out cut at its
// breaks and not (a mark with no base after an Arabic letter mark stays on the box mark past a zero-width non-joiner)
const laidAs = (run, adv, font, ink, thai, hang, o) => {
  if (o.whole !== undefined) return layAt(run, adv, font, ink, thai, hang, o, o.whole)
  const whole = layAt(run, adv, font, ink, thai, hang, o, true)
  return BREAKS.test(run) ? Math.max(whole, layAt(run, adv, font, ink, thai, hang, o, false)) : whole
}
// resvg shapes each stretch of one direction apart, so Thai after right-to-left text is shaped as Thai whatever came first.
// The scripts written right to left (the shaper's list)
const RTL = new RegExp(`(?!${UNKNOWN.source})${/[\p{sc=Arab}\p{sc=Hebr}\p{sc=Syrc}\p{sc=Thaa}\p{sc=Cprt}\p{sc=Khar}\p{sc=Phnx}\p{sc=Nkoo}\p{sc=Lydi}\p{sc=Avst}\p{sc=Armi}\p{sc=Phli}\p{sc=Prti}\p{sc=Sarb}\p{sc=Orkh}\p{sc=Samr}\p{sc=Mand}\p{sc=Merc}\p{sc=Mero}\p{sc=Mani}\p{sc=Mend}\p{sc=Nbat}\p{sc=Narb}\p{sc=Palm}\p{sc=Phlp}\p{sc=Hatr}\p{sc=Hung}\p{sc=Adlm}\p{sc=Rohg}\p{sc=Sogo}\p{sc=Sogd}\p{sc=Elym}\p{sc=Chrs}\p{sc=Yezi}\p{sc=Ougr}]/u.source}`, 'u')
const SCRIPT = new RegExp(`(?!${UNKNOWN.source})[^\\p{sc=Zyyy}\\p{sc=Zinh}\\p{sc=Zzzz}]`, 'u')
const HEBREW = /\p{sc=Hebr}/u
// and what turns a stretch of a run around: those letters, and the right-to-left mark, Arabic letter mark, embedding,
// override and isolate
const LEFTWARD = new RegExp(`${RTL.source}|[\\u{200f}\\u{61c}\\u{202b}\\u{202e}\\u{2067}]`, 'u')
/** A run's advance from its characters' (adv, which gives marks fonts have their own), with the marks no font has
 *  added as resvg adds them; ink: where the boxes' ink ends counts too, as it does at the end of a run. hang: given for
 *  a run drawn alone, as it is, and true for the characters (by index in it) of a mark fonts have with no advance whose
 *  ink can end up to OVERHANG past its letter (a diaeresis on "l" before a space). Without it, the run may be a word of
 *  a line resvg shapes as Thai or not, and takes the wider of the two. o.far: the run is a stretch shaped right to left;
 *  o.hebrew: shaped as Hebrew; o.over: a letter's ink past its advance; o.room(letter, marked): the room a letter (with
 *  marks on it, or not) gets past its advance, which a box widening it doesn't take up; o.whole: whether a break starts
 *  a cluster (true: it doesn't; unset: either). */
const laid = (run, adv, font, ink, hang, o = {}) => {
  if (!AM.test(run)) return laidAs(run, adv, font, ink, false, hang, o)
  if (hang && THAI.test(run)) return laidAs(run, adv, font, ink, true, hang, o)
  // (nor in one with a break in it: after a left-to-right mark, resvg shapes a sara am as Thai in a Latin run)
  if (hang && !RTL.test(run) && !BREAKS.test(run)) return laidAs(run, adv, font, ink, false, hang, o)
  return Math.max(laidAs(run, adv, font, ink, false, hang, o), laidAs(run, adv, font, ink, true, hang, o))
}

// The bidi classes (UAX #9) of the characters that aren't left-to-right (L), as resvg has them: Unicode 15.0's
// DerivedBidiClass.txt, with its defaults for what it hadn't assigned yet, but for the Arabic letters it defaults to
// past the Arabic blocks Unicode 6 had (U+0860-08FF, Hanifi Rohingya, Arabic Extended-C, Sogdian, the Siyaq numbers):
// resvg takes those as right to left, not Arabic (a European number after U+0897 stays one), and U+2FFC as left to
// right (measured). Generated, not tuned; regenerate it if resvg is updated. ON stands for all the neutrals (B, S, WS,
// ON), X for the explicit embeddings, overrides and isolates.
const BIDI = {
  AL: /[\u{608}\u{60b}\u{60d}\u{61b}-\u{64a}\u{66d}-\u{66f}\u{671}-\u{6d5}\u{6e5}-\u{6e6}\u{6ee}-\u{6ef}\u{6fa}-\u{710}\u{712}-\u{72f}\u{74b}-\u{7a5}\u{7b1}-\u{7bf}\u{860}-\u{86a}\u{870}-\u{88e}\u{8a0}-\u{8c9}\u{fb50}-\u{fd3d}\u{fd50}-\u{fdce}\u{fdf0}-\u{fdfc}\u{fe70}-\u{fefe}\u{10d00}-\u{10d23}\u{10f30}-\u{10f45}\u{10f51}-\u{10f59}\u{1ec71}-\u{1ecb4}\u{1ed01}-\u{1ed3d}\u{1ee00}-\u{1eeef}\u{1eef2}-\u{1eeff}]/u,
  R: /[\u{590}\u{5be}\u{5c0}\u{5c3}\u{5c6}\u{5c8}-\u{5ff}\u{7c0}-\u{7ea}\u{7f4}-\u{7f5}\u{7fa}-\u{7fc}\u{7fe}-\u{815}\u{81a}\u{824}\u{828}\u{82e}-\u{858}\u{85c}-\u{85f}\u{86b}-\u{86f}\u{88f}\u{892}-\u{897}\u{200f}\u{fb1d}\u{fb1f}-\u{fb28}\u{fb2a}-\u{fb4f}\u{10800}-\u{1091e}\u{10920}-\u{10a00}\u{10a04}\u{10a07}-\u{10a0b}\u{10a10}-\u{10a37}\u{10a3b}-\u{10a3e}\u{10a40}-\u{10ae4}\u{10ae7}-\u{10b38}\u{10b40}-\u{10cff}\u{10d28}-\u{10d2f}\u{10d3a}-\u{10e5f}\u{10e7f}-\u{10eaa}\u{10ead}-\u{10efc}\u{10f00}-\u{10f2f}\u{10f5a}-\u{10f81}\u{10f86}-\u{10fff}\u{1e800}-\u{1e8cf}\u{1e8d7}-\u{1e943}\u{1e94b}-\u{1ec70}\u{1ecb5}-\u{1ed00}\u{1ed3e}-\u{1edff}\u{1ef00}-\u{1efff}]/u,
  AN: /[\u{600}-\u{605}\u{660}-\u{669}\u{66b}\u{66c}\u{6dd}\u{890}\u{891}\u{8e2}\u{10d30}-\u{10d39}\u{10e60}-\u{10e7e}]/u,
  EN: /[\u{30}-\u{39}\u{b2}\u{b3}\u{b9}\u{6f0}-\u{6f9}\u{2070}\u{2074}-\u{2079}\u{2080}-\u{2089}\u{2488}-\u{249b}\u{ff10}-\u{ff19}\u{102e1}-\u{102fb}\u{1d7ce}-\u{1d7ff}\u{1f100}-\u{1f10a}\u{1fbf0}-\u{1fbf9}]/u,
  ES: /[\u{2b}\u{2d}\u{207a}\u{207b}\u{208a}\u{208b}\u{2212}\u{fb29}\u{fe62}\u{fe63}\u{ff0b}\u{ff0d}]/u,
  CS: /[\u{2c}\u{2e}\u{2f}\u{3a}\u{a0}\u{60c}\u{202f}\u{2044}\u{fe50}\u{fe52}\u{fe55}\u{ff0c}\u{ff0e}\u{ff0f}\u{ff1a}]/u,
  ET: /[\u{23}-\u{25}\u{a2}-\u{a5}\u{b0}\u{b1}\u{58f}\u{609}\u{60a}\u{66a}\u{9f2}\u{9f3}\u{9fb}\u{af1}\u{bf9}\u{e3f}\u{17db}\u{2030}-\u{2034}\u{20a0}-\u{20cf}\u{212e}\u{2213}\u{a838}\u{a839}\u{fe5f}\u{fe69}\u{fe6a}\u{ff03}-\u{ff05}\u{ffe0}\u{ffe1}\u{ffe5}\u{ffe6}\u{11fdd}-\u{11fe0}\u{1e2ff}]/u,
  ON: /[\u{9}-\u{d}\u{1c}-\u{22}\u{26}-\u{2a}\u{3b}-\u{40}\u{5b}-\u{60}\u{7b}-\u{7e}\u{85}\u{a1}\u{a6}-\u{a9}\u{ab}\u{ac}\u{ae}\u{af}\u{b4}\u{b6}-\u{b8}\u{bb}-\u{bf}\u{d7}\u{f7}\u{2b9}\u{2ba}\u{2c2}-\u{2cf}\u{2d2}-\u{2df}\u{2e5}-\u{2ed}\u{2ef}-\u{2ff}\u{374}\u{375}\u{37e}\u{384}\u{385}\u{387}\u{3f6}\u{58a}\u{58d}\u{58e}\u{606}\u{607}\u{60e}\u{60f}\u{6de}\u{6e9}\u{7f6}-\u{7f9}\u{bf3}-\u{bf8}\u{bfa}\u{c78}-\u{c7e}\u{f3a}-\u{f3d}\u{1390}-\u{1399}\u{1400}\u{1680}\u{169b}\u{169c}\u{17f0}-\u{17f9}\u{1800}-\u{180a}\u{1940}\u{1944}\u{1945}\u{19de}-\u{19ff}\u{1fbd}\u{1fbf}-\u{1fc1}\u{1fcd}-\u{1fcf}\u{1fdd}-\u{1fdf}\u{1fed}-\u{1fef}\u{1ffd}\u{1ffe}\u{2000}-\u{200a}\u{2010}-\u{2029}\u{2035}-\u{2043}\u{2045}-\u{205f}\u{207c}-\u{207e}\u{208c}-\u{208e}\u{2100}\u{2101}\u{2103}-\u{2106}\u{2108}\u{2109}\u{2114}\u{2116}-\u{2118}\u{211e}-\u{2123}\u{2125}\u{2127}\u{2129}\u{213a}\u{213b}\u{2140}-\u{2144}\u{214a}-\u{214d}\u{2150}-\u{215f}\u{2189}-\u{218b}\u{2190}-\u{2211}\u{2214}-\u{2335}\u{237b}-\u{2394}\u{2396}-\u{2426}\u{2440}-\u{244a}\u{2460}-\u{2487}\u{24ea}-\u{26ab}\u{26ad}-\u{27ff}\u{2900}-\u{2b73}\u{2b76}-\u{2b95}\u{2b97}-\u{2bff}\u{2ce5}-\u{2cea}\u{2cf9}-\u{2cff}\u{2e00}-\u{2e5d}\u{2e80}-\u{2e99}\u{2e9b}-\u{2ef3}\u{2f00}-\u{2fd5}\u{2ff0}-\u{2ffb}\u{3000}-\u{3004}\u{3008}-\u{3020}\u{3030}\u{3036}\u{3037}\u{303d}-\u{303f}\u{309b}\u{309c}\u{30a0}\u{30fb}\u{31c0}-\u{31e3}\u{321d}\u{321e}\u{3250}-\u{325f}\u{327c}-\u{327e}\u{32b1}-\u{32bf}\u{32cc}-\u{32cf}\u{3377}-\u{337a}\u{33de}\u{33df}\u{33ff}\u{4dc0}-\u{4dff}\u{a490}-\u{a4c6}\u{a60d}-\u{a60f}\u{a673}\u{a67e}\u{a67f}\u{a700}-\u{a721}\u{a788}\u{a828}-\u{a82b}\u{a874}-\u{a877}\u{ab6a}\u{ab6b}\u{fd3e}-\u{fd4f}\u{fdcf}\u{fdfd}-\u{fdff}\u{fe10}-\u{fe19}\u{fe30}-\u{fe4f}\u{fe51}\u{fe54}\u{fe56}-\u{fe5e}\u{fe60}\u{fe61}\u{fe64}-\u{fe66}\u{fe68}\u{fe6b}\u{ff01}\u{ff02}\u{ff06}-\u{ff0a}\u{ff1b}-\u{ff20}\u{ff3b}-\u{ff40}\u{ff5b}-\u{ff65}\u{ffe2}-\u{ffe4}\u{ffe8}-\u{ffee}\u{fff9}-\u{fffd}\u{10101}\u{10140}-\u{1018c}\u{10190}-\u{1019c}\u{101a0}\u{1091f}\u{10b39}-\u{10b3f}\u{11052}-\u{11065}\u{11660}-\u{1166c}\u{11fd5}-\u{11fdc}\u{11fe1}-\u{11ff1}\u{16fe2}\u{1d1e9}\u{1d1ea}\u{1d200}-\u{1d241}\u{1d245}\u{1d300}-\u{1d356}\u{1d6db}\u{1d715}\u{1d74f}\u{1d789}\u{1d7c3}\u{1eef0}\u{1eef1}\u{1f000}-\u{1f02b}\u{1f030}-\u{1f093}\u{1f0a0}-\u{1f0ae}\u{1f0b1}-\u{1f0bf}\u{1f0c1}-\u{1f0cf}\u{1f0d1}-\u{1f0f5}\u{1f10b}-\u{1f10f}\u{1f12f}\u{1f16a}-\u{1f16f}\u{1f1ad}\u{1f260}-\u{1f265}\u{1f300}-\u{1f6d7}\u{1f6dc}-\u{1f6ec}\u{1f6f0}-\u{1f6fc}\u{1f700}-\u{1f776}\u{1f77b}-\u{1f7d9}\u{1f7e0}-\u{1f7eb}\u{1f7f0}\u{1f800}-\u{1f80b}\u{1f810}-\u{1f847}\u{1f850}-\u{1f859}\u{1f860}-\u{1f887}\u{1f890}-\u{1f8ad}\u{1f8b0}\u{1f8b1}\u{1f900}-\u{1fa53}\u{1fa60}-\u{1fa6d}\u{1fa70}-\u{1fa7c}\u{1fa80}-\u{1fa88}\u{1fa90}-\u{1fabd}\u{1fabf}-\u{1fac5}\u{1face}-\u{1fadb}\u{1fae0}-\u{1fae8}\u{1faf0}-\u{1faf8}\u{1fb00}-\u{1fb92}\u{1fb94}-\u{1fbca}]/u,
  BN: /[\u{0}-\u{8}\u{e}-\u{1b}\u{7f}-\u{84}\u{86}-\u{9f}\u{ad}\u{180e}\u{200b}-\u{200d}\u{2060}-\u{2065}\u{206a}-\u{206f}\u{fdd0}-\u{fdef}\u{feff}\u{fff0}-\u{fff8}\u{fffe}\u{ffff}\u{1bca0}-\u{1bca3}\u{1d173}-\u{1d17a}\u{1fffe}\u{1ffff}\u{2fffe}\u{2ffff}\u{3fffe}\u{3ffff}\u{4fffe}\u{4ffff}\u{5fffe}\u{5ffff}\u{6fffe}\u{6ffff}\u{7fffe}\u{7ffff}\u{8fffe}\u{8ffff}\u{9fffe}\u{9ffff}\u{afffe}\u{affff}\u{bfffe}\u{bffff}\u{cfffe}\u{cffff}\u{dfffe}-\u{e00ff}\u{e01f0}-\u{e0fff}\u{efffe}\u{effff}\u{ffffe}\u{fffff}\u{10fffe}\u{10ffff}]/u,
  X: /[\u{202a}-\u{202e}\u{2066}-\u{2069}]/u,
  NSM: /(?![\u{897}\u{cbf}\u{cc6}\u{1acf}-\u{1add}\u{1ae0}-\u{1aeb}\u{10d69}-\u{10d6d}\u{10efa}-\u{10efc}\u{113bb}-\u{113c0}\u{113ce}\u{113d0}\u{113d2}\u{113e1}\u{113e2}\u{11a07}\u{11a08}\u{11b60}\u{11b62}-\u{11b64}\u{11b66}\u{11c3f}\u{11f5a}\u{1611e}-\u{16129}\u{1612d}-\u{1612f}\u{1e5ee}\u{1e5ef}\u{1e6e3}\u{1e6e6}\u{1e6ee}\u{1e6ef}\u{1e6f5}])[\p{Mn}\p{Me}\u{1171e}]/u,
}
const CLASSES = Object.entries(BIDI)
const bidi = (c) => CLASSES.find(([, r]) => r.test(c))?.[0] ?? 'L'
const RIGHT = new RegExp(`${BIDI.AL.source}|${BIDI.R.source}|${BIDI.AN.source}|${BIDI.X.source}`, 'u')
// the right-to-left embedding, override and isolate; and the embeddings, overrides and isolates that open a level
const RLX = /[\u202b\u202e\u2067]/u
const OPENS = /[\u202a\u202d\u2066\u2068]/u
// The paired brackets (BidiBrackets.txt, as unicode-bidi has them): each opening one by the code point it pairs by, and
// each closing one by minus that ("〈" pairs with "〉" and "〉")
const BRACKETS = new Map()
for (const [o, c, as = o] of [[0x28, 0x29], [0x5b, 0x5d], [0x7b, 0x7d], [0xf3a, 0xf3b], [0xf3c, 0xf3d], [0x169b, 0x169c], [0x2045, 0x2046], [0x207d, 0x207e], [0x208d, 0x208e], [0x2308, 0x2309], [0x230a, 0x230b], [0x2329, 0x232a, 0x3008], [0x2768, 0x2769], [0x276a, 0x276b], [0x276c, 0x276d], [0x276e, 0x276f], [0x2770, 0x2771], [0x2772, 0x2773], [0x2774, 0x2775], [0x27c5, 0x27c6], [0x27e6, 0x27e7], [0x27e8, 0x27e9], [0x27ea, 0x27eb], [0x27ec, 0x27ed], [0x27ee, 0x27ef], [0x2983, 0x2984], [0x2985, 0x2986], [0x2987, 0x2988], [0x2989, 0x298a], [0x298b, 0x298c], [0x298d, 0x2990], [0x298f, 0x298e], [0x2991, 0x2992], [0x2993, 0x2994], [0x2995, 0x2996], [0x2997, 0x2998], [0x29d8, 0x29d9], [0x29da, 0x29db], [0x29fc, 0x29fd], [0x2e22, 0x2e23], [0x2e24, 0x2e25], [0x2e26, 0x2e27], [0x2e28, 0x2e29], [0x2e55, 0x2e56], [0x2e57, 0x2e58], [0x2e59, 0x2e5a], [0x2e5b, 0x2e5c], [0x3008, 0x3009], [0x300a, 0x300b], [0x300c, 0x300d], [0x300e, 0x300f], [0x3010, 0x3011], [0x3014, 0x3015], [0x3016, 0x3017], [0x3018, 0x3019], [0x301a, 0x301b], [0xfe59, 0xfe5a], [0xfe5b, 0xfe5c], [0xfe5d, 0xfe5e], [0xff08, 0xff09], [0xff3b, 0xff3d], [0xff5b, 0xff5d], [0xff5f, 0xff60], [0xff62, 0xff63]]) BRACKETS.set(o, as).set(c, -as)
const STRONG = new Set(['L', 'R', 'AL'])
const NUMBER = new Set(['EN', 'AN'])
/** resvg lays a run out in stretches of one direction, unicode-bidi's level runs for text set left to right, and
 *  shapes each apart. The ways it may be cut into stretches (null for a run with explicit embeddings, overrides or
 *  isolates and right-to-left text, or a right-to-left one of them), each a list of stretches: their characters'
 *  indices, a right-to-left stretch's in the order its clusters are drawn (its first letter's marks no font has, boxes
 *  set past the letter, end up at its right); far: shaped right to left, as a right-to-left stretch is, and one whose
 *  script is (a stretch set left to right that starts with an Arabic digit is shaped right to left and turned around);
 *  hebrew: a right-to-left stretch shaped as Hebrew (its first character of any script is Hebrew). Measured. */
const stretches = (cs) => {
  const all = cs.map((_, i) => i)
  const stretch = (s, rtl) => {
    const first = cs[s.find((i) => SCRIPT.test(cs[i]))]
    const far = rtl || RTL.test(first ?? '')
    // (a break may or may not start a cluster where it's laid out: the stretch is guessed both ways, by whole)
    const ways = s.some((i) => BREAKS.test(cs[i])) ? [false, true] : [false]
    if (!rtl) {
      // (and one set left to right but shaped right to left by its script may have the marks before its first cluster
      // turned around into the cluster after them: guessed both ways too)
      const orders = ways.map((whole) => ({ order: s, whole }))
      let k = 0
      while (k < s.length && !starts(cs[s[k]])) k++
      if (!far || !k || k === s.length) return { orders, far }
      let e = k + 1
      while (e < s.length && !starts(cs[s[e]])) e++
      const turned = [...s.slice(k, e), ...s.slice(0, k), ...s.slice(e)]
      return { orders: [...orders, ...ways.map((whole) => ({ order: turned, whole }))], far }
    }
    const hebrew = HEBREW.test(first ?? '')
    const orders = ways.map((whole) => {
      const clusters = []
      for (const i of s) !clusters.length || (whole ? !IGNORED.test(cs[i]) && starts(cs[i]) : starts(cs[i])) ? clusters.push([i]) : clusters.at(-1).push(i)
      return { order: clusters.reverse().flat(), whole }
    })
    return { orders, far, hebrew }
  }
  if (!cs.some((c) => RIGHT.test(c))) return [[stretch(all, false)]]
  const t = cs.map(bidi)
  if (t.includes('X')) {
    // (left-to-right embeddings, overrides and isolates in text with nothing right to left in it reorder nothing, but
    // may cut it into stretches at every level: guessed cut there and not)
    if (t.some((x) => x === 'R' || x === 'AL' || x === 'AN') || cs.some((c) => RLX.test(c))) return null
    const stack = []
    const level = []
    for (const i of all) {
      const c = cs[i]
      if (OPENS.test(c)) {
        level[i] = 2 * stack.length
        // (past unicode-bidi's deepest level, it ignores them: not modelled)
        if (stack.length === 62) return null
        stack.push(c === '\u2066' || c === '\u2068')
      } else if (c === '\u2069') stack.includes(true) && stack.splice(stack.lastIndexOf(true)), (level[i] = 2 * stack.length)
      else if (c === '\u202c') (level[i] = i ? level[i - 1] : 0), stack.length && !stack.at(-1) && stack.pop()
      else level[i] = 2 * stack.length
    }
    const out = []
    for (const i of all) i && level[i] === level[i - 1] ? out.at(-1).push(i) : out.push([i])
    return [[stretch(all, false)], out.map((s) => stretch(s, false))]
  }
  // (boundary neutrals are left out, and take the level of the character before them)
  const at = all.filter((i) => t[i] !== 'BN')
  const near = (k, d) => t[at[k + d]] ?? 'sos'
  // W1-W3: a mark takes its letter's class, a European number after Arabic letters is an Arabic one
  let strong = 'L'
  at.forEach((i, k) => {
    if (t[i] === 'NSM') t[i] = k ? t[at[k - 1]] : 'L'
    if (t[i] === 'EN' && strong === 'AL') t[i] = 'AN'
    if (STRONG.has(t[i])) strong = t[i]
  })
  for (const i of at) if (t[i] === 'AL') t[i] = 'R'
  // W4-W7: a separator inside a number and terminators beside one join it, a European number after left-to-right text
  // is left to right
  at.forEach((i, k) => {
    const [a, b] = [near(k, -1), near(k, 1)]
    if (t[i] === 'ES' && a === 'EN' && b === 'EN') t[i] = 'EN'
    else if (t[i] === 'CS' && a === b && NUMBER.has(a)) t[i] = a
  })
  for (let k = 0; k < at.length; k++) {
    if (t[at[k]] !== 'ET') continue
    let e = k
    while (t[at[e + 1]] === 'ET') e++
    if (near(k, -1) === 'EN' || t[at[e + 1]] === 'EN') for (let j = k; j <= e; j++) t[at[j]] = 'EN'
    k = e
  }
  strong = 'L'
  for (const i of at) {
    if (['ES', 'ET', 'CS'].includes(t[i])) t[i] = 'ON'
    if (t[i] === 'EN' && strong === 'L') t[i] = 'L'
    if (STRONG.has(t[i])) strong = t[i]
  }
  // N0: a pair of brackets takes the direction of what's in it, when that's left to right; when it's right to left or a
  // number, the direction of what's before them (left to right, or right to left after right-to-left text or a number:
  // "عَ (12)" is drawn "(12) عَ", the box mark at its end); and the marks right after a bracket with it. BD16 pairs
  // them, at most 63 open at once, as unicode-bidi does.
  const open = []
  const pairs = []
  for (const [k, i] of at.entries()) {
    const b = t[i] === 'ON' && BRACKETS.get(cs[i].codePointAt(0))
    if (!b) continue
    if (b > 0) {
      if (open.length === 63) break
      open.push([b, k])
    } else {
      const j = open.findLastIndex(([o]) => o === -b)
      if (j >= 0) pairs.push([open[j][1], k]), (open.length = j)
    }
  }
  for (const [o, e] of pairs.sort(([a], [b]) => a - b)) {
    const inside = at.slice(o + 1, e).map((i) => t[i])
    let d = inside.includes('L') ? 'L' : inside.some((x) => x === 'R' || NUMBER.has(x)) ? null : undefined
    if (d === undefined) continue
    if (d === null) {
      const before = at.slice(0, o).map((i) => t[i]).findLast((x) => x === 'L' || x === 'R' || NUMBER.has(x))
      d = before && before !== 'L' ? 'R' : 'L'
    }
    for (const k of [o, e]) {
      t[at[k]] = d
      for (let j = k + 1; j < at.length && bidi(cs[at[j]]) === 'NSM'; j++) t[at[j]] = d
    }
  }
  // N1, N2: neutrals between two of one direction take it (numbers count as right to left), others the text's
  const dir = (x) => (x === 'L' || x === 'sos' || x === undefined ? 'L' : 'R')
  for (let k = 0; k < at.length; k++) {
    if (t[at[k]] !== 'ON') continue
    let e = k
    while (t[at[e + 1]] === 'ON') e++
    const d = dir(near(k, -1)) === dir(t[at[e + 1]]) ? dir(t[at[e + 1]]) : 'L'
    for (let j = k; j <= e; j++) t[at[j]] = d
    k = e
  }
  // I1: levels 0, 1 and 2
  const level = []
  let last = 0
  for (const i of all) last = level[i] = t[i] === 'BN' ? last : t[i] === 'L' ? 0 : t[i] === 'R' ? 1 : 2
  const out = []
  for (const i of all) i && level[i] === level[i - 1] ? out.at(-1).push(i) : out.push([i])
  return [out.map((s) => ({ ...stretch(s, level[s[0]] === 1), level: level[s[0]] }))]
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
export const clean = (s) => String(s).replace(/[\0-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff\ufffe\uffff]/gu, '')
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
// Inter lacks, the missing-glyph box for what neither has, unless it's a space or decomposes into what Inter has), with
// a little room for what that leaves out: Inter's wider contextual forms ("*" after a capital, "_" between letters), its
// few positive kerning pairs, the ink of a mark with no advance that ends the run, the ink of Inter's marks that nothing
// anchors (after the pen, wherever they are in the run), and the ink of a character that reaches past the run's end (a
// space after it can be narrower than its overhang). It stays close to resvg's own advance, and never under it (a run
// with a skin tone outside an emoji, which card text never has, is guessed wider: see toned, unless Noto Emoji draws the
// run whole: see notoWhole).
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
// A few of those characters Inter kerns wider on both sides at once, after a character and before one that have no room
// of their own ("ĩ" after "f" or "T" and before "T", "ď" before ")", "Д" after "„"), by more past their room than a
// guess's own 0.04 covers: they get all of it, so a run of them ("TĩTĩT") isn't short either. Measured against resvg,
// each between the characters Inter's kerning pairs it with most, at both weights; generated, not tuned. But for "_",
// which needs 0.17 only between "ζ" and "Ƒ": that much room for every underscore in a name would push the rest of a
// line well past where resvg draws it.
const KERNED = [
  [0.2, /[\u{ef}\u{129}\u{12d}\u{457}]/u],
  [0.19, /[\u{12b}\u{20b}\u{1e2f}]/u],
  [0.14, /[\u{10f}]/u],
  [0.11, /[\u{234}]/u],
  [0.1, /[\u{4c6}]/u],
  [0.09, /[\u{434}]/u],
  [0.08, /[\u{2af}\u{414}\u{1e2c}]/u],
  [0.07, /[\u{249}\u{24b}\u{268}\u{273}\u{1e3b}\u{1e71}]/u],
]
const extra = (c) => (KERNED.find(([, r]) => r.test(c)) ?? WIDER.find(([, r]) => r.test(c)))?.[0] ?? 0
// a mark fonts have with no advance at a run's end can stick out past it by up to this much
const OVERHANG = 0.43
// The characters whose ink ends past their advance, by up to this much more in em ("⁄", some of Inter's private-use
// glyphs, bold "ɀ"), past the end of the run too when what follows them is narrower (a space). Measured against resvg
// for every character either font has as a run's last character, alone and after a letter, at both weights; generated,
// not tuned.
const PAST = [
  [0.3, /[\u{e2c2}]/u],
  [0.28, /[\u{e2bf}\u{e2c3}\u{e2c4}]/u],
  [0.22, /[\u{ee90}]/u],
  [0.2, /[\u{ee9b}]/u],
  [0.16, /[\u{ee07}]/u],
  [0.1, /[\u{e2c0}\u{e2c1}\u{ee0e}\u{ee9c}\u{f6c3}]/u],
  [0.08, /[\u{2044}\u{215f}]/u],
  [0.06, /[\u{ee0f}]/u],
  [0.04, /[\u{240}]/u],
  [0.02, /[\u{260}\u{2a0}]/u],
]
const past = (c) => PAST.find(([, r]) => r.test(c))?.[0] ?? 0
// A character neither font has that decomposes into ones Inter has is drawn as them: "↮" is "↔" with a slash through.
// So is a mark that decomposes on a letter, though Inter has it: "a" U+0343 is "a" U+0313 (and U+0343 alone, its own
// glyph, is narrower than U+0313).
const has = (c, font) => font.glyph(c.codePointAt(0)) || NOTO.glyph(c.codePointAt(0))
const apart = (c, font) => {
  const d = c.normalize('NFD')
  return d !== c && (!has(c, font) || MARK.test(c)) && [...d].every((x) => font.glyph(x.codePointAt(0))) ? d : c
}
// A run Inter lacks a character of that Noto Emoji has every character of is drawn in Noto whole: resvg shapes it again
// with the fallback font and keeps that when nothing is missing. So a keycap mark with no digit before it, "⃣7", makes
// the digits after it (and a space, "#", "*") Noto's, each as wide as an emoji. The other spaces are never missing: a
// font without one gets its space glyph at the width the space should have (measured in Noto, where the no-break and
// figure spaces are its emoji-wide space and the narrow one half of it), but for one with a variation selector after it,
// which Noto can't draw after a space, so the run isn't Noto's whole. A keycap mark or a skin tone after one of those spaces (even
// past an ignorable) can have resvg drop Noto's shaping too and draw Inter's wider spaces, so each character is priced at
// the wider of the two fonts.
const VARIANT = /[\u{fe00}-\u{fe0f}\u{e0100}-\u{e01ef}]/u
const SPACE_VARIANT = new RegExp(`[\\u{a0}\\u{2000}-\\u{200a}\\u{202f}\\u{205f}\\u{3000}]${VARIANT.source}`, 'u')
const NOTO_SPACES = new Map([[0xa0, 1.2695], [0x2000, 0.5], [0x2001, 1], [0x2002, 0.5], [0x2003, 1], [0x2004, 0.3335], [0x2005, 0.25], [0x2006, 0.1665], [0x2007, 1.2695], [0x2008, 1.2695], [0x2009, 0.2002], [0x200a, 0.0625], [0x202f, 0.6348], [0x205f, 0.2222], [0x3000, 1]])
const notoWhole = (run, font) => {
  if (SPACE_VARIANT.test(run)) return null
  const cs = [...run].filter((c) => !IGNORED.test(c)).map((c) => c.codePointAt(0))
  const drawn = (c) => NOTO.glyph(c) || NOTO_SPACES.has(c)
  return cs.some((c) => !font.glyph(c) && !NOTO_SPACES.has(c)) && cs.every(drawn) ? cs.reduce((w, c) => w + Math.max(NOTO.advance(c) ?? NOTO_SPACES.get(c), font.advance(c) ?? 0), 0) : null
}
// A letter and the marks after it that compose into a character the font has are drawn as that character, which can be
// wider than the letter and its marks: "l" with a caron after it is drawn "ľ". The shaper composes them as NFC does
// (marks reordered, a mark blocked by one of the same class or by an ignorable between them), so a cluster is guessed
// composed when it composes into characters the font has (and ignorables it hides, and marks it doesn't have, which stay
// boxes beside the letter: "l", a caron and a box mark are drawn "ľ" and the box), and the guess is the wider of the two
// ways. And Inter draws a caron after "d", "l" and "t" as the apostrophe of "ď", and an acute (or the acute tone mark,
// which is the same acute) on "ϒ" as in "ϓ", even with an ignorable between them that keeps them from composing (a
// joiner, a variation selector; not a non-joiner, a Mongolian variation selector, a tag or a bidi control that opens a
// stretch of its own). Measured for every letter and mark that compose into a character Inter has, past each ignorable;
// generated, not tuned.
const COMPOSABLE = /\P{M}\p{M}+/gu
const HIDDEN = new RegExp(IGNORED.source, 'gu')
const SKIPPED = String.raw`(?:(?![\u{200c}\u{180b}-\u{180d}\u{e0020}-\u{e007f}\u{61c}\u{200f}\u{202a}\u{202b}\u{202d}\u{202e}\u{2066}-\u{2068}])${IGNORED.source})+`
const APART = new RegExp(String.raw`[dlt]${SKIPPED}\u{30c}|\u{3d2}${SKIPPED}[\u{301}\u{341}]`, 'gu')
// After composing, Inter's ccmp also joins a letter and the first mark on it (in the shaper's order, marks of a lower
// combining class first) into a character where NFC doesn't: "l" with a dot above is drawn "ŀ", "ı" with a tilde "ĩ",
// "O" with a long solidus "Ø", "e" with U+1DC6 "ḕ" (past the same ignorables as the caron above). The letter, mark and
// character of each, in hex, from Inter's GSUB (the same at both weights); regenerate it if Inter is updated. A dotted
// "i" or "j" with a mark above is drawn dotless, so it joins the same way when an ignorable keeps NFC from composing it:
// "i", a joiner and a tilde are "ĩ" (measured against resvg for every mark above and every ignorable, at both weights).
const LIGATURES = new Map(
  `104 30a ee02,105 30a ee04,131 300 ec,131 301 ed,131 302 ee,131 303 129,131 304 12b,131 306 12d,131 308 ef,131 309 1ec9,131 30c 1d0,131 30f 209,69 300 ec,69 301 ed,69 302 ee,69 303 129,69 304 12b,69 306 12d,69 308 ef,69 309 1ec9,69 30c 1d0,69 30f 209,237 302 135,237 30c 1f0,6a 302 135,6a 30c 1f0,30 338 e06b,43 338 23b,63 338 23c,4c 307 13f,4c 338 141,4f 338 d8,6c 307 140,6c 338 142,6f 338 f8,59 328 ee03,79 328 ee05,61 ee90 1eb3,e050 338 e051,e071 338 e07b,44 f6c3 1e10,47 f6c3 122,4b f6c3 136,4c f6c3 13b,4e f6c3 145,52 f6c3 156,53 f6c3 218,54 f6c3 21a,64 f6c3 1e11,6b f6c3 137,6c f6c3 13c,6e f6c3 146,72 f6c3 157,73 f6c3 219,74 f6c3 21b,65 1dc6 1e15,65 1dc4 1e17,6f 1dc6 1e51,6f 1dc4 1e53`
    .split(',')
    .map((l) => l.split(' ').map((h) => String.fromCodePoint(parseInt(h, 16))))
    .map(([letter, mark, c]) => [letter + mark, c]),
)
const LIGATED = new RegExp(String.raw`(\P{M})(${SKIPPED})?([\p{M}\u{ee90}\u{f6c3}]\p{M}*)`, 'gu')
const together = (run, font) => run.replace(APART, (p) => p.replace(HIDDEN, '').normalize('NFC')).replace(COMPOSABLE, (g) => {
  const n = g.normalize('NFC')
  return n !== g && [...n].every((x) => IGNORED.test(x) || font.glyph(x.codePointAt(0)) || (/\p{M}/u.test(x) && g.includes(x))) ? n : g
})
const ligated = (run, font) => run.replace(LIGATED, (all, letter, _, marks) => {
  // (a variation selector among the marks keeps the shaper from decomposing them)
  const ms = VARIANT.test(marks) ? marks : marks.normalize('NFD')
  const first = String.fromCodePoint(ms.codePointAt(0))
  const c = LIGATURES.get(letter + first)
  return c && font.glyph(c.codePointAt(0)) ? c + ms.slice(first.length) : all
})
export const guess = (run, bold = false) => {
  const font = bold ? BOLD : REGULAR
  const composed = together(run, font)
  // the ligated text is a guess of its own, not a replacement: a pair past a PDF or PDI that closes an embedding or
  // isolate opened before the letter is drawn apart, and the composed text alone may be what keeps the run covered
  const joined = ligated(composed, font)
  return Math.max(...[...new Set([run, composed, joined])].map((t) => guessed(t, font)))
}
const guessed = (run, font) => {
  const noto = notoWhole(run, font)
  if (noto !== null) return noto + 0.04
  // (a decomposed letter's own marks are drawn within it: the slash through "↮" doesn't stick out past it)
  const cs = []
  const within = new Set()
  // (marks Inter has in the order the shaper puts them, by combining class: U+035E over U+0302 goes after it)
  const ordered = run.replace(/\p{M}{2,}/gu, (ms) => ([...ms].every((c) => font.glyph(c.codePointAt(0))) ? ms.normalize('NFD') : ms))
  // (but the shaper decomposes nothing in a cluster, a character and the marks after it, with a variation selector in
  // it: "I" U+0340 U+FE05 has U+0340 as a box widening the "I", not U+0300 on it, and "↮" U+FE05 is a box)
  const chars = [...ordered]
  let whole = false
  for (const [i, c] of chars.entries()) {
    if (!i || !MARK.test(c)) {
      whole = false
      for (let k = i; k < chars.length && (k === i || MARK.test(chars[k])); k++) whole ||= VARIANT.test(chars[k])
    }
    for (const [j, x] of [...(whole ? c : apart(c, font))].entries()) j && within.add(cs.length), cs.push(x)
  }
  // a mark Inter has gets a little room for its own (they're a few hundredths of an em off their base); a space no font
  // has is as wide as resvg draws it (the ideographic space is a full em, not a box)
  const adv = (c) => (font.advance(c.codePointAt(0)) ?? NOTO.advance(c.codePointAt(0)) ?? SPACES.get(c.codePointAt(0)) ?? BOX) + (MARK.test(c) ? extra(c) + 0.03 : 0)
  // a letter's extra room is its own, past a box that widens it; with marks on it, resvg draws the character it
  // normalizes to instead ("ΐ" as "ΐ", which Inter kerns after "l"; the Greek varia as a wider "`"), so the room is
  // what that takes past the letter's advance, when it's more
  const room = (c, marked) => {
    const n = marked ? c.normalize('NFC') : c
    return n === c || [...n].length > 1 || !font.glyph(n.codePointAt(0)) ? extra(c) : Math.max(extra(c), adv(n) + extra(n) - adv(c))
  }
  // each stretch of one direction is guessed apart, as resvg shapes it: its advance, and where its ink ends (past: the
  // ink of the characters that end past their advance, wherever it reaches past the stretch's end). They're laid out in
  // the order they're drawn (each sequence of right-to-left and number stretches turned around; two next to each other
  // are never of one level, so this is all of rule L2), so ink past one stretch's end, like sara am's, is under the
  // next one's text rather than added to it, and the run takes the furthest any of it reaches.
  // Where the run may be cut into stretches more than one way, it takes the widest.
  const lay = (ss) => {
    const drawn = ss.map(({ orders, far, hebrew, level }) => {
      const at = (ink) => Math.max(...orders.map(({ order, whole }) => laid(order.map((i) => cs[i]).join(''), adv, font, ink, (j) => !within.has(order[j]), { far, hebrew, over: past, room, whole })))
      return { a: at(false), ink: at(true), level }
    })
    for (let k = 0; k < drawn.length; k++) {
      let e = k
      while (drawn[e]?.level) e++
      if (e > k) drawn.splice(k, e - k, ...drawn.slice(k, e).reverse()), (k = e - 1)
    }
    let w = 0, end = 0
    for (const { a, ink } of drawn) end = Math.max(end, w + ink), (w += a)
    return Math.max(w, end)
  }
  const ways = stretches(cs)
  let w = ways ? Math.max(...ways.map(lay)) : 0
  // A run with right-to-left embeddings, overrides or isolates, or any with right-to-left text (contrived), gets room
  // for every cluster in any order and direction: each mark no font has a box of its own, sara am two, and the most one
  // cluster's ink can end past them (boxes set past a letter's ink, a mark's overhang on nothing) and one character's
  // ink past its advance (or one of Inter's marks past the pen, where nothing anchors it). Each letter gets the more of
  // its room and the most Inter kerns it before anything, whatever comes after it ("ď]" sixteen times in an embedding),
  // as it's drawn with the marks after it too (composed with them, a dotless "ı" as "i")
  if (!ways) {
    const drawn = cs.filter((c) => !IGNORED.test(c))
    // (past the letter's advance: the room and kerning of each letter it can be drawn as)
    const most = (c, i) => {
      let marks = ''
      for (let k = i + 1; k < drawn.length && MARK.test(drawn[k]); k++) marks += drawn[k]
      const as = [c, ...(marks ? [(c + marks).normalize('NFC'), DOTTED[c] && (DOTTED[c] + marks).normalize('NFC')] : [])]
      const one = as.filter((x) => x && [...x].length === 1 && font.glyph(x.codePointAt(0)))
      return Math.max(room(c, true), ...one.map((x) => Math.max(font.most(x), adv(x) + extra(x) - adv(c))))
    }
    for (const [i, c] of drawn.entries()) w += AM.test(c) ? 2 * BOX : boxed(c, font) ? BOX : adv(c) + (MARK.test(c) ? 0 : most(c, i))
    w += BOX + OVERHANG + 0.2 + Math.max(0, ...drawn.map(past), ...drawn.map((c) => (MARK.test(c) && font.reach(c.codePointAt(0))) || 0))
  }
  // and a little for Inter's positive kerning ("ty", "d)"; a pair kerned wider than the room its first letter gets is
  // counted where it's laid out: "ď]", "ȴj"); a skin tone outside an emoji as wide as toned has it (which counts a
  // letter's extra room in its advance, as it did before laid() took it as room)
  return (TONE.test(run) ? Math.max(w, toned(cs, (c) => adv(c) + (MARK.test(c) ? 0 : extra(c)))) : w) + 0.04
}
// A skin tone outside an emoji. Card text never has one in a run of text (pieces() takes tones off as pictures), so only
// a run guessed on its own does, and how resvg draws it depends on what's around it (measured): a box on the letter
// before it, one more box after that letter's boxes (past the ink of "ทำ" or a struck-through letter), two boxes after
// a symbol under a box, or, when Noto Emoji has the letter too, the letter, the tone and the digits and spaces next to
// them reshaped in Noto Emoji, each as wide as its glyphs. So a run with one is guessed as wide as each of its characters
// could be drawn: its advance, a Noto Emoji glyph (every one is NOTO_EM or narrower), or, for the tone, two boxes, and
// sara am's two boxes twice that; its ink past them as for any run. (A run Noto Emoji draws whole, such as "27🏻" or
// " 🏻", never gets here: guessed() returns notoWhole's sum of its Noto glyphs for it first.)
const TONE = /[\u{1F3FB}-\u{1F3FF}]/u
const NOTO_EM = 1.27
const toned = (cs, adv) => cs.reduce((w, c) => w + (AM.test(c) ? 2 : 1) * Math.max(adv(c), NOTO_EM, TONE.test(c) ? 2 * BOX : 0), 0) + cs.reduce((m, c) => Math.max(m, past(c)), 0)
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

/** A name's first letter in a circle (centered on cx), without its marks, or its first emoji when it starts with one
 *  (the first of a cluster drawn in parts). */
export function initial(name, cx, y, size, fill) {
  const g = graphemes(clean(name).replace(/^[\p{M}\p{Cf}\uFE00-\uFE0F\s]+/u, ''))[0]
  const p = g && parts(g)[0]
  const k = p && kind(p)
  if (k && k !== 'noto') return textSvg([p], { x: cx - (EMOJI * size) / 2, y, size, fill })
  return `<text x="${cx}" y="${y}" font-family="Inter, Noto Emoji" font-weight="700" font-size="${size}" fill="${fill}" text-anchor="middle">${esc((g && [...g][0])?.toUpperCase() || '?')}</text>`
}
