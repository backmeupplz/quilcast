// A cast's embeds (#257): pictures and videos share a scrolling strip, cards (links, tweets, Spaces) stack full width
// and compact. Squeezed into a strip's 260px tiles, a link card stretched into an empty box, a tweet's photo took the
// tiles' styles and vanished and its header ran out of room.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { embedLayout, peekOf, playedOf, quotedOf, vidBoxOf, vidShape } from './shared.ts'

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

// #275: a video's box takes its shape (a 1080×1920 cast showed in a 16:9 box with wide black bars)
test("a video's shape: its own once played, else its poster's, else none (the 16:9 box)", () => {
  assert.deepEqual(vidShape([1080, 1920], [404, 720]), [1080, 1920])
  assert.deepEqual(vidShape(null, [404, 720]), [404, 720])
  assert.deepEqual(vidShape([0, 0], [404, 720]), [404, 720], "a video that hasn't its size yet")
  assert.equal(vidShape(null, null), null)
  assert.equal(vidShape(undefined, [0, 720]), null)
  assert.equal(vidBoxOf(null), undefined, 'no box: the 16:9 one')
})

test("a played size is only its own video's: another src falls back to that one's poster", () => {
  const a = 'https://stream.farcaster.xyz/v1/video/a.m3u8'
  const b = 'https://stream.farcaster.xyz/v1/video/b.m3u8'
  const played = { src: a, size: [1920, 1080] as [number, number] }
  assert.deepEqual(playedOf(played, a), [1920, 1080])
  assert.equal(playedOf(played, b), null)
  assert.deepEqual(vidShape(playedOf(played, b), [404, 720]), [404, 720], "B's poster, not A's played 16:9")
  assert.equal(playedOf(null, a), null)
})

test("a video's box is at most 510px tall alone and 300px in a strip", () => {
  // tall: 287px wide at 510px tall, 169px wide in a tile
  assert.equal(vidBoxOf([404, 720]), '--ar:404/720;--alone:286px;--tile:168px')
  assert.equal(vidBoxOf([1080, 1920]), '--ar:1080/1920;--alone:287px;--tile:169px')
  assert.equal(vidBoxOf([720, 720]), '--ar:720/720;--alone:510px;--tile:300px')
  // wide: wider than the column, so it fills it as before
  assert.equal(vidBoxOf([1280, 720]), '--ar:1280/720;--alone:907px;--tile:533px')
  const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8')
  assert.ok(css.includes('.vid.shaped { width: min(100%, var(--alone)); aspect-ratio: var(--ar); }'))
  assert.ok(css.includes('.strip > .vid.shaped { width: min(260px, 80%, var(--tile)); }'))
})

// #663: a quoted cast with no words and a video from outside Farcaster (Firefly's HLS) drew as an empty card, as only
// stream.farcaster.xyz videos get a poster
test("a quote or a notification always has something to show of a cast's embeds", () => {
  const firefly = 'https://media.firefly.land/post_m3u8/abc/def.m3u8'
  assert.deepEqual(peekOf([firefly]), { video: true })
  assert.deepEqual(peekOf(['https://example.com/clip.mp4']), { video: true })
  // Farcaster's own streams still show their poster, and a picture comes first
  const fc = 'https://stream.farcaster.xyz/v1/video/01a18616-1a75-a56e-1a34-d5e740f5898c.m3u8'
  assert.deepEqual(peekOf([fc]), { img: `/api/poster?url=${encodeURIComponent(fc)}` })
  assert.deepEqual(peekOf([firefly, img(1)]), { img: img(1) })
  // only a link: its address, short
  assert.deepEqual(peekOf(['https://www.example.com/post']), { link: 'example.com/post' })
  assert.deepEqual(peekOf([`https://example.com/${'a'.repeat(60)}`]), { link: `example.com/${'a'.repeat(28)}…` })
  assert.deepEqual(peekOf([]), {})
})

// #664: a quoted cast with no words whose only embed is another cast (urlsOf skips those) drew as an empty card
test('a quote of a quote has something to show: the cast it quotes', () => {
  const hash = 'AB'.repeat(20)
  const c = { text: '', embeds: [{ url: undefined }, { cast_id: { fid: 3, hash: 'nope' } }, { cast_id: { fid: 7, hash: `0x${hash}` } }, { cast_id: { fid: 8, hash: '1'.repeat(40) } }] }
  assert.deepEqual(quotedOf(c), { fid: 7, hash: hash.toLowerCase() })
  assert.deepEqual(peekOf([], quotedOf(c)), { quote: { fid: 7, hash: hash.toLowerCase() } })
  // a fid that isn't one is left out; the hash still says which cast
  assert.deepEqual(quotedOf({ embeds: [{ cast_id: { fid: 0, hash } }] }), { hash: hash.toLowerCase() })
  assert.equal(quotedOf({ embeds: [{ url: 'https://example.com/' }] }), undefined)
  assert.equal(quotedOf({}), undefined)
  // a picture, a video or a link still comes first
  assert.deepEqual(peekOf(['https://example.com/post'], quotedOf(c)), { link: 'example.com/post' })
  assert.deepEqual(peekOf([img(1)], quotedOf(c)), { img: img(1) })
  assert.deepEqual(peekOf([], undefined), {})
})
