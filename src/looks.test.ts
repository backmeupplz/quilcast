// cleanLook is the only thing between a stored look and the page's CSS, so hostile input has to come out inert.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ampItem, cleanDesign, cleanLook, cleanPrefs, isLookImg, LIMITS, lookBase, lookImages, lookPage, lookVars, marqueeStyle } from './shared.ts'

test('cleanLook keeps valid settings and drops everything else', () => {
  const l = cleanLook({
    bg: '#FFAA00', text: 'red;background:url(https://evil.example/x)', link: '#12345', box: '#000000', boxAlpha: 250, radius: -4,
    bgImg: 'https://media.tenor.com/abc/x.webp', banner: 'https://evil.example/a.gif', font: '__proto__', nameFx: 'blink',
    about: 'hi\u0000‮ there\n\n\n\nyo', mood: 'x'.repeat(500), top: [3, 3, -1, 1.5, 'x', 7, 8, 9, 10, 11, 12, 13, 14], wall: ['https://media1.tenor.com/m/a/b.gif', 'javascript:alert(1)'],
    song: { id: 'dQw4w9WgXcQ', start: 37, title: 'x' }, interests: { music: 'metal', __proto__: { general: 'x' }, evil: 'y' }, extra: 1,
  })
  assert.deepEqual(l, {
    bg: '#ffaa00', box: '#000000', boxAlpha: 100, radius: 0, bgImg: 'https://media.tenor.com/abc/x.webp',
    about: 'hi there\n\nyo', mood: 'x'.repeat(60), top: [3, 7, 8, 9, 10, 11, 12, 13], wall: ['https://media1.tenor.com/m/a/b.gif'],
    song: { id: 'dQw4w9WgXcQ', start: 37, title: 'x' }, interests: { music: 'metal' },
  })
  assert.deepEqual(cleanLook('nope'), {})
  assert.deepEqual(cleanLook([1]), {})
})

test('look images come only from Tenor, the Farcaster CDN and our uploads, and can\'t break out of url()', () => {
  for (const u of ['https://media.tenor.com/WhF9CqAr61sAAAAx/glitter.webp', 'https://imagedelivery.net/BXluQx4ige9GuW0Ia56BHw/85c67149-829d-4f2c-90a1-d17f575be900/w=1600', 'https://quilcast.com/m/0123456789abcdef01234567.gif'])
    assert.ok(isLookImg(u), u)
  for (const u of ['http://media.tenor.com/a/b.gif', 'https://media.tenor.com/a/b.gif")', 'https://media.tenor.com.evil.com/a/b.gif', 'https://imagedelivery.net/a/b/c)d', 'https://quilcast.com/m/../x.gif', 'https://example.com/a.gif'])
    assert.ok(!isLookImg(u), u)
  assert.deepEqual(lookImages({ bgImg: 'a', wall: ['b'] }), [['a', 6e6], ['b', 4e6]])
})

test('stickers keep a known box, an allowed image and in-range numbers; effects come from the list', () => {
  const src = 'https://media.tenor.com/Rrl0kEdmhl0AAAAl/amazed-sparkle.webp'
  const l = cleanLook({
    fx: 'snow',
    stickers: [
      { src, at: 'about', x: 12.345, y: 140, w: 2, r: 0, extra: 'x' },
      { src, at: 'head', x: -5, y: 50, w: 30, r: 45.06 },
      { src: 'https://evil.example/a.gif', at: 'head', x: 1, y: 1, w: 10 },
      { src, at: '__proto__', x: 1, y: 1, w: 10 },
      { src, at: 'head', x: '1', y: 1, w: 10 },
      { src, at: 'head', x: NaN, y: 1, w: 10 },
      ...Array(20).fill({ src, at: 'wall', x: 1, y: 1, w: 10 }),
    ],
  })
  assert.equal(l.fx, 'snow')
  assert.deepEqual(l.stickers!.slice(0, 2), [{ src, at: 'about', x: 12.3, y: 100, w: 4 }, { src, at: 'head', x: 0, y: 50, w: 30, r: 45.1 }])
  assert.equal(l.stickers!.length, 16)
  assert.equal(cleanLook({ fx: 'alert(1)' }).fx, undefined)
  assert.deepEqual(cleanLook({ stickers: [{ src: 'x' }] }), {})
  assert.deepEqual(lookImages({ stickers: [{ src, at: 'head', x: 1, y: 1, w: 9 }, { src, at: 'top', x: 1, y: 1, w: 9 }] }), [[src, 4e6]])
})

test('box and effect opacity: whole percents from 0 to 100; box opacity works without a box color', () => {
  assert.deepEqual(cleanLook({ fx: 'matrix', fxAlpha: 300, boxAlpha: -1 }), { fx: 'matrix', fxAlpha: 100, boxAlpha: 0 })
  for (const bad of [12.5, '40', NaN, {}]) assert.deepEqual(cleanLook({ fxAlpha: bad, boxAlpha: bad, fx: 'snow' }), { fx: 'snow' }, String(bad))
  assert.deepEqual(cleanLook({ fxAlpha: 40, boxAlpha: 50 }), { boxAlpha: 50 })
  const v = lookVars(cleanLook({ boxAlpha: 40, fx: 'snow', fxAlpha: 25 }))
  assert.deepEqual([v['--lk-box-a'], v['--lk-fx-a'], v['--lk-box']], ['40%', '0.25', undefined])
  // a box color still wins, at the same opacity
  assert.equal(lookVars(cleanLook({ box: '#000000', boxAlpha: 40 }))['--lk-box'], 'rgb(0 0 0 / 0.4)')
  assert.deepEqual(lookVars(cleanLook({ fx: 'snow' })), {})
  // a shared design carries the effect's opacity with the effect
  assert.deepEqual(cleanDesign({ fx: 'snow', fxAlpha: 30, about: 'x' }), { fx: 'snow', fxAlpha: 30 })
})

test('a Winamp list keeps real YouTube ids, once each, and a skin only as an md5', () => {
  const l = cleanLook({ amp: { on: 'yes', skin: '../x', list: [
    { id: 'dQw4w9WgXcQ', title: 'a\u0000b', extra: 1 }, { id: 'dQw4w9WgXcQ' }, { id: 'PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI', pl: 1 },
    { id: 'short', pl: 1 }, { id: 'bad id here' }, { id: 'PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI', pl: true },
  ] } })
  assert.deepEqual(l, { amp: { list: [{ id: 'dQw4w9WgXcQ', title: 'ab' }, { id: 'PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI', pl: 1 }] } })
  assert.deepEqual(cleanLook({ amp: { on: true, skin: '5e4f10275dcb1fb211d4a8b4f1bda236', list: [{ id: 'dQw4w9WgXcQ' }] } }).amp, { on: true, skin: '5e4f10275dcb1fb211d4a8b4f1bda236', list: [{ id: 'dQw4w9WgXcQ' }] })
  assert.equal(cleanLook({ amp: { on: true, list: [] } }).amp, undefined)
  assert.equal(cleanLook({ amp: { on: true, list: Array.from({ length: 80 }, (_, i) => ({ id: `abcdefghi${String(i).padStart(2, '0')}` })) } }).amp!.list.length, 50)
})

test('Winamp list lines: videos in any link form, and a link with a playlist is the playlist', () => {
  assert.deepEqual(ampItem('https://youtu.be/dQw4w9WgXcQ?t=3'), { id: 'dQw4w9WgXcQ' })
  assert.deepEqual(ampItem('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), { id: 'dQw4w9WgXcQ' })
  assert.deepEqual(ampItem(' dQw4w9WgXcQ '), { id: 'dQw4w9WgXcQ' })
  assert.deepEqual(ampItem('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI'), { id: 'PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI', pl: 1 })
  assert.deepEqual(ampItem('https://music.youtube.com/playlist?list=OLAK5uy_kNWq9zW2'), { id: 'OLAK5uy_kNWq9zW2', pl: 1 })
  assert.equal(ampItem('hello'), undefined)
})

test('a look keeps the page its colors were picked on, whichever the viewer wears', () => {
  // light text on a see-through dark box, no page color (a real one): dark everywhere, never white text on light grey
  const l = cleanLook({ text: '#f2f2f2', muted: '#9a9a9a', box: '#111111', boxAlpha: 33 })
  assert.equal(lookBase(l), 'dark')
  assert.equal(lookPage(l), '#0b0b0f')
  const v = lookVars(l)
  assert.equal(v.colorScheme, 'dark')
  assert.equal(v['--ink'], '#f2f2f2')
  assert.equal(v['--line'], '#23232b')
  assert.equal(lookBase(cleanLook({ text: '#222222' })), 'light')
  assert.equal(lookBase(cleanLook({ bg: '#fffbe0' })), 'light')
  assert.equal(lookBase(cleanLook({ box: '#202040' })), 'dark')
  assert.equal(lookPage(cleanLook({ bg: '#123456', text: '#ffffff' })), '#123456')
  // a look without colors follows the viewer's light or dark
  const plain = cleanLook({ banner: 'https://media.tenor.com/abc/x.webp', font: 'courier' })
  assert.equal(lookBase(plain), undefined)
  assert.equal(lookPage(plain), undefined)
  assert.equal(lookVars(plain)['--bg'], undefined)
})

test('a marquee is one line of plain text with a known speed, direction and colors; no text, no marquee', () => {
  assert.deepEqual(cleanLook({ marquee: { text: '  hi\r\n\nthere\u0000\u202e\u2066 ', speed: 'warp', dir: 'up', color: 'red', bg: '#00FF00', html: '<b>' } }),
    { marquee: { text: 'hi there', bg: '#00ff00' } })
  // markup stays text: it's shown as a text node, never parsed
  assert.equal(cleanLook({ marquee: { text: '<img src=x onerror=alert(1)>' } }).marquee!.text, '<img src=x onerror=alert(1)>')
  // defaults aren't stored
  assert.deepEqual(cleanLook({ marquee: { text: 'x', speed: 'normal', dir: 'left' } }), { marquee: { text: 'x' } })
  assert.deepEqual(cleanLook({ marquee: { text: 'x', speed: 'slow', dir: 'right' } }), { marquee: { text: 'x', speed: 'slow', dir: 'right' } })
  for (const bad of [{ text: '' }, { text: ' \n\t ' }, { text: 5 }, { speed: 'fast' }, 'hello', ['x'], null]) assert.deepEqual(cleanLook({ marquee: bad }), {}, JSON.stringify(bad))
  // nothing to see is no marquee: zero-width and blank-looking characters alone
  for (const blank of ['\u200b\u200d\ufeff', '\u3164\u2800', '\u00ad \u2060', '\u3000\u00a0', '\ufe0f\u034f\u{e0100}']) assert.equal(cleanLook({ marquee: { text: blank } }).marquee, undefined, JSON.stringify(blank))
  assert.equal(cleanLook({ marquee: { text: '\u200bhi' } }).marquee!.text, '\u200bhi')
  // a cut through a long run of spaces never leaves half an emoji
  assert.equal(cleanLook({ marquee: { text: ' '.repeat(3999) + '😀😀' } }).marquee, undefined)
  // the limit counts characters, so an emoji is never cut in half
  assert.equal(cleanLook({ marquee: { text: '😀'.repeat(150) } }).marquee!.text, '😀'.repeat(LIMITS.marquee))
  assert.equal(cleanLook({ marquee: { text: 'a'.repeat(5e4) } }).marquee!.text.length, LIMITS.marquee)
  // it's the owner's words, so a shared design leaves it out
  assert.deepEqual(cleanDesign({ bg: '#000000', marquee: { text: 'x' } }), { bg: '#000000' })
})

test('a marquee stays readable on light and dark, and long text moves about as fast as short', () => {
  // no colors: the look's links on its boxes
  assert.deepEqual(marqueeStyle({}, { text: 'x' }), { ink: undefined, bg: undefined, secs: 6 })
  // a background brings readable text
  assert.equal(marqueeStyle({}, { text: 'x', bg: '#111111' }).ink, '#ffffff')
  assert.equal(marqueeStyle({}, { text: 'x', bg: '#ffff00' }).ink, '#0b0b0f')
  // colored text on a look without a base (which follows the viewer) brings the background it reads on
  assert.equal(marqueeStyle({}, { text: 'x', color: '#ffffff' }).bg, '#131319')
  assert.equal(marqueeStyle({ font: 'courier' }, { text: 'x', color: '#111111' }).bg, '#ffffff')
  // so does a look's link color when it's the look's only color: yellow links never land on a light viewer's white
  assert.deepEqual(marqueeStyle({ link: '#ffe600' }, { text: 'x' }), { ink: undefined, bg: '#131319', secs: 6 })
  assert.equal(marqueeStyle({ link: '#003399' }, { text: 'x' }).bg, '#ffffff')
  // on a look with a base its boxes are the same for every viewer, so the text sits on them
  assert.equal(marqueeStyle({ text: '#000000', box: '#ffffff' }, { text: 'x', color: '#ff0000' }).bg, undefined)
  // both colors are the owner's
  assert.deepEqual(marqueeStyle({}, { text: 'x', color: '#ff0000', bg: '#00ff00' }), { ink: '#ff0000', bg: '#00ff00', secs: 6 })
  const secs = (text: string, speed?: 'slow' | 'fast') => marqueeStyle({}, { text, speed }).secs
  assert.ok(secs('x', 'slow') > secs('x') && secs('x') > secs('x', 'fast'))
  assert.ok(secs('x'.repeat(100)) > secs('x'))
  assert.ok(secs('x', 'fast') >= 4)
})

test('cleanPrefs keeps a synced theme, light or dark, holidays and the stamp', () => {
  assert.equal(cleanPrefs(null), null)
  assert.equal(cleanPrefs({ mode: 'dark' }), null)
  assert.equal(cleanPrefs({ at: -1 }), null)
  assert.deepEqual(cleanPrefs({ at: 3, theme: { evil: 1 }, mode: 'light' }), { theme: null, library: [], mode: 'light', holidays: true, quorum: false, at: 3 })
  assert.deepEqual(cleanPrefs({ at: 3, theme: { base: 'light', ink: 'red' }, holidays: false, quorum: true }), { theme: { base: 'light' }, library: [], mode: 'system', holidays: false, quorum: true, at: 3 })
  // the library: valid themes once each (the first wins), ids only in their shapes, at most 40
  const lib = cleanPrefs({ at: 1, library: [
    { theme: { name: 'A', bg: '#000000' }, id: 'abcdefghij', quorum: 'skin_1' }, { theme: { name: 'A', bg: '#000000' }, id: 'zzzzzzzzzz' },
    { theme: { evil: 1 } }, { theme: { name: 'B' }, id: '../../etc', quorum: 'x'.repeat(65) }, null, 'x',
  ] })!.library
  assert.deepEqual(lib, [{ theme: { name: 'A', bg: '#000000' }, id: 'abcdefghij', quorum: 'skin_1' }, { theme: { name: 'B' } }])
  assert.equal(cleanPrefs({ at: 1, library: Array.from({ length: 60 }, (_, i) => ({ theme: { name: `T${i}` } })) })!.library.length, 40)
})
