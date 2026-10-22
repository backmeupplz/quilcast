// cleanLook is the only thing between a stored look and the page's CSS, so hostile input has to come out inert.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cleanLook, isLookImg, lookImages } from './shared.ts'

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
