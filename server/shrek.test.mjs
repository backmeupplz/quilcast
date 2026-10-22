import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parse } from './shrek.mjs'

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
