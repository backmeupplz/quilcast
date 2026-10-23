// cleanTheme is the only thing between a stored or shared theme and the page's CSS, so hostile input has to come out inert.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cleanTheme, ownMedia, themeId, themeVars } from './shared.ts'

test('cleanTheme keeps valid settings and drops everything else', () => {
  const th = cleanTheme({
    name: '  Night\nDrive\u0000 ', base: 'dusk', bg: '#0A0B0C', ink: 'red;}body{display:none', accent: '#12345', onAccent: '#ffffff',
    bgImg: 'https://media.tenor.com/abc/x.webp', barImg: 'https://evil.example/a.gif', btnImg: 'https://quilcast.com/m/0123456789abcdef01234567.png',
    scrim: 300, sheer: -5, round: 2.25, borderWidth: 9, borderStyle: 'inset', glow: 'yes', font: '__proto__', fontUrl: 'https://quilcast.com/m/0123456789abcdef01234567.ttf',
    size: 1, nameFx: 'none', fx: 'snow', stickers: [{ src: 'https://media.tenor.com/a/b.webp', x: 120, y: 5, w: 30, r: 0 }, { src: 'javascript:alert(1)', x: 1, y: 1, w: 10 }], __proto__: { x: 1 }, extra: 1,
  })
  assert.deepEqual(th, {
    name: 'Night Drive', bg: '#0a0b0c', onAccent: '#ffffff', bgImg: 'https://media.tenor.com/abc/x.webp', btnImg: 'https://quilcast.com/m/0123456789abcdef01234567.png',
    scrim: 90, sheer: 0, round: 2.3, borderWidth: 6, fontUrl: 'https://quilcast.com/m/0123456789abcdef01234567.ttf', fx: 'snow',
    stickers: [{ src: 'https://media.tenor.com/a/b.webp', x: 100, y: 5, w: 30 }],
  })
  assert.deepEqual(cleanTheme(null), {})
  assert.deepEqual(cleanTheme([1]), {})
  // only our own fonts, by their hash name
  for (const u of ['https://quilcast.com/m/x.ttf', 'https://evil.example/m/0123456789abcdef01234567.ttf', 'https://quilcast.com/m/0123456789abcdef01234567.woff']) assert.equal(cleanTheme({ fontUrl: u }).fontUrl, undefined, u)
})

test('themeVars only writes checked values into CSS, and our media loads from wherever the app runs', () => {
  const v = themeVars(cleanTheme({ base: 'light', bg: '#ffffff', accent: '#ff0000', bgImg: 'https://quilcast.com/m/0123456789abcdef01234567.gif', scrim: 50, round: 0, borderWidth: 2, borderStyle: 'dashed', font: 'comic', size: 1.2 }))
  assert.equal(v['--th-img'], 'url("/m/0123456789abcdef01234567.gif")')
  assert.equal(v['--th-scrim'], 'rgb(255 255 255 / 0.5)')
  assert.deepEqual([v['--rs'], v['--bw'], v['--bs'], v['--zoom']], ['0', '2px', 'dashed', '1.2'])
  assert.match(v['--th-font'], /Comic Sans/)
  assert.equal(themeVars(cleanTheme({ fontUrl: 'https://quilcast.com/m/0123456789abcdef01234567.otf', font: 'comic' }))['--th-font'].split(',')[0], "'quilcast-theme'")
  assert.equal(ownMedia('https://media.tenor.com/a/b.webp'), 'https://media.tenor.com/a/b.webp')
  assert.equal(themeId('https://quilcast.com/theme/AbC-_12345'), 'AbC-_12345')
  assert.equal(themeId('AbC-_12345'), 'AbC-_12345')
  assert.equal(themeId('https://quilcast.com/design/AbC-_12345'), undefined)
})
