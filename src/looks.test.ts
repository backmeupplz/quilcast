// cleanLook is the only thing between a stored look and the page's CSS, so hostile input has to come out inert.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ampItem, cleanDesign, cleanLook, cleanPrefs, isLookImg, lookBase, lookImages, lookPage, lookVars } from './shared.ts'

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
