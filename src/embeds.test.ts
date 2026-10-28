// A cast's embeds (#257): pictures and videos share a scrolling strip, cards (links, tweets, Spaces) stack full width
// and compact. Squeezed into a strip's 260px tiles, a link card stretched into an empty box, a tweet's photo took the
// tiles' styles and vanished and its header ran out of room.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { embedLayout } from './shared.ts'

const img = (i: number) => `https://imagedelivery.net/a/b${i}/original`
const vid = (i: number) => `https://stream.farcaster.xyz/v${i}/manifest.m3u8`
const link = 'https://quilcast.com/'
const tweet = (i: number) => `https://x.com/someone/status/${i}`

test('cards stack instead of sitting in the strip', () => {
  // the reported cast: a quilcast.com link and a tweet
  assert.deepEqual(embedLayout([link, tweet(1)], 2), { strip: false, compact: true })
  // two tweets
  assert.deepEqual(embedLayout([tweet(1), tweet(2)], 2), { strip: false, compact: true })
  // two pictures (one tile) and a link: the pictures in their grid, the link compact under them
  assert.deepEqual(embedLayout([img(1), img(2), link], 1), { strip: false, compact: true })
})

test('pictures and videos share a strip when there are several', () => {
  assert.deepEqual(embedLayout([img(1), vid(1)], 0), { strip: true, compact: false })
  assert.deepEqual(embedLayout([vid(1), vid(2), tweet(1)], 1), { strip: true, compact: true })
})

test('a lone embed shows as before', () => {
  assert.deepEqual(embedLayout([link], 1), { strip: false, compact: false })
  assert.deepEqual(embedLayout([img(1), img(2), img(3)], 0), { strip: false, compact: false })
  assert.deepEqual(embedLayout([vid(1)], 0), { strip: false, compact: false })
  assert.deepEqual(embedLayout([], 0), { strip: false, compact: false })
})

// every selector in the stylesheet, one per entry (selector lists split, comments and line breaks dropped)
const selectors = readFileSync(new URL('./style.css', import.meta.url), 'utf8').replace(/\/\*[^]*?\*\//g, '')
  .split('{').slice(0, -1).flatMap((s) => s.split(/[{};]/).at(-1)!.split(',').map((x) => x.replace(/\s+/g, ' ').trim()))

test("the strip's tile styles reach only its own tiles", () => {
  const rules = selectors.filter((s) => s.includes('.strip'))
  assert.ok(rules.includes('.strip > .imgs > .img > img'), 'the tile rules are there')
  // a descendant selector would also catch the media inside a card in the strip (a tweet's photo)
  for (const s of rules) assert.match(s, /^\.strip(:hover)?( > [^ ]+)*$/, s)
})

test("a compact link card's picture is a thumbnail that can't stretch the card or squeeze its text", () => {
  const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8')
  const rule = (sel: string) => css.match(new RegExp(`^${sel.replace(/[.*]/g, '\\$&')}[^{]*\\{([^}]*)\\}`, 'm'))?.[1] ?? ''
  // its own height counts for nothing (contain: size), it fills whatever the text makes
  assert.match(rule('.cards .linkcard.big .lc-img'), /contain: size;.*/)
  assert.match(rule('.cards .linkcard.big .lc-img'), /width: 112px;/)
  // text and button keep the second column when the picture fails to load (Img hides it)
  assert.match(rule('.cards .linkcard.big .lc-text, .cards .linkcard.big .lc-btn'), /grid-column: 2;/)
})
