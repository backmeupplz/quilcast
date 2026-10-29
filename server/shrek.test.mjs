import assert from 'node:assert/strict'
import { test } from 'node:test'
import { gifResults, parse } from './shrek.mjs'

const gif = (id, desc, size, url = `https://media.tenor.com/${id}/x.webp`) => ({ id, itemurl: `https://tenor.com/view/${id}`, content_description: desc, media_formats: { webp: { url, size } } })

test('Tenor search pages give animated Shrek GIFs only', () => {
  const results = [
    gif('a', 'shrek is dancing', 300e3),
    gif('b', 'shrek face on white', 6e3), // a still image
    gif('c', 'a donkey from shrek is smiling', 300e3),
    gif('d', 'shrek holding a sign that says hello', 300e3), // a caption meme
    gif('e', 'shrek waving', 9e6), // too heavy
    gif('f', 'shrek roaring', 300e3, 'https://evil.example/x.webp'),
  ]
  const html = `<div></div><script id="store-cache" type="text/x-cache" nonce="n">${JSON.stringify({ universal: { search: { 'shrek-low-all': { results } } } })}</script>`
  assert.deepEqual(parse(html).map((g) => g.page), ['https://tenor.com/view/a'])
  assert.deepEqual(parse('<html>no results</html>'), [])
})

test('the GIF picker casts a .gif other Farcaster clients animate, not a webp or an mp4, at a size a feed takes', () => {
  const fmt = (id, kind, ext, size) => ({ url: `https://media1.tenor.com/m/${id}${kind}/x.${ext}`, size, dims: [498, 300] })
  const g = (id, f) => ({ id, content_description: id, media_formats: { webp: fmt(id, 'x', 'webp', 90e3), tinywebp: fmt(id, '1', 'webp', 30e3), mp4: fmt(id, 'Po', 'mp4', 60e3), ...f } })
  const page = (results, stickers) => gifResults(`<script id="store-cache">${JSON.stringify({ universal: { search: { 'x-low-all': { results } } } })}</script>`, stickers)
  const list = page([
    g('medium', { gif: fmt('medium', 'C', 'gif', 900e3), mediumgif: fmt('medium', 'd', 'gif', 600e3), tinygif: fmt('medium', 'M', 'gif', 100e3) }),
    g('full', { gif: fmt('full', 'C', 'gif', 900e3), tinygif: fmt('full', 'M', 'gif', 100e3) }),
    g('heavy', { gif: fmt('heavy', 'C', 'gif', 11e6), mediumgif: fmt('heavy', 'd', 'gif', 9e6), tinygif: fmt('heavy', 'M', 'gif', 1e6) }),
    g('elsewhere', { mediumgif: { url: 'https://evil.example/x.gif', size: 1e5 } }),
  ])
  assert.deepEqual(list.map((x) => x.cast), [
    'https://media1.tenor.com/m/mediumd/x.gif',
    'https://media1.tenor.com/m/fullC/x.gif',
    'https://media1.tenor.com/m/heavyM/x.gif',
    undefined,
  ])
  // profile looks keep taking the webp
  assert.equal(list[0].url, 'https://media1.tenor.com/m/mediumx/x.webp')
  // stickers are for looks and themes only
  const sticker = { id: 's', media_formats: { webp_transparent: fmt('s', 'l', 'webp', 9e4), tinywebp_transparent: fmt('s', 'm', 'webp', 3e4), gif: fmt('s', 'C', 'gif', 9e4) } }
  assert.equal(page([sticker], true)[0].cast, undefined)
})
