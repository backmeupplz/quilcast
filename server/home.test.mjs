// The server-drawn home page lays out a cast's embeds as the app does (src/ui.tsx Embeds, src/shared.ts embedLayout),
// so the app's first frame is the same page (#257: a link card and a tweet, stacked instead of in a strip).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { body } from './home.mjs'

const author = { fid: 3, username: 'ada', display_name: 'Ada', pfp_url: '' }
const cast = (hash, urls) => ({ hash, author, text: 'look', timestamp: '2026-10-28T10:00:00Z', embeds: urls.map((url) => ({ url })), reactions: {}, replies: {} })
const link = 'https://quilcast.com/'
const tweet = 'https://x.com/cass_on_mars/status/1'
const got = {
  [`u:${link}`]: { url: link, title: 'Quilcast', description: 'A Farcaster client', image: 'https://quilcast.com/og.png', button: 'Open in Quilcast' },
  [`u:${tweet}`]: { url: tweet, tweet: { text: '(see screenshot)', author: { name: 'Cass', handle: 'cass_on_mars' }, at: 1761645600, photos: ['https://pbs.twimg.com/media/a.jpg'], quote: { name: 'Arf', handle: 'arfonzo', text: 'hi' } } },
}
const page = (urls) => body({ casts: [cast('a'.repeat(40), urls)], got, shapes: {} }, '0.0.0', Date.parse('2026-10-28T12:00:00Z')).html

test('a link card and a tweet stack as compact cards, with the tweet photo in its own grid', () => {
  const html = page([link, tweet])
  assert.ok(!html.includes('class="strip"'))
  const cards = html.slice(html.indexOf('<div class="cards">'))
  assert.ok(html.includes('<div class="cards"><a class="linkcard big"'), 'the link card opens the stack')
  assert.match(cards, /<div class="tweet"[^]*<div class="imgs n1">/, "the tweet's photo")
  // the X logo by the name, the time unshrinkable
  assert.match(cards, /<b>Cass<\/b><svg class="tw-x"[^>]*>[^]*?<\/svg><span class="handle">@cass_on_mars<\/span><span class="handle tw-at">/)
})

test('pictures and videos share the strip; cards stay out of it', () => {
  const html = page(['https://imagedelivery.net/a/b/original', 'https://stream.farcaster.xyz/v/manifest.m3u8', link])
  const strip = html.slice(html.indexOf('<div class="strip">'), html.indexOf('<div class="cards">'))
  assert.match(strip, /^<div class="strip"><div class="imgs n1">[^]*<div class="vid">/)
  assert.ok(!strip.includes('linkcard'))
})

test('a lone card is drawn as before', () => {
  const html = page([link])
  assert.ok(!html.includes('class="cards"') && !html.includes('class="strip"') && html.includes('<a class="linkcard big"'))
})

test('the first picture comes through quilcast.com at its final size; a link preview\'s pictures come last', () => {
  const pic = 'https://imagedelivery.net/a/b/original'
  const d = { casts: [cast('a'.repeat(40), [pic]), cast('b'.repeat(40), [pic.replace('/b/', '/c/'), link])], got, shapes: { 'https://imagedelivery.net/a/b/w=1200': [1200, 800] } }
  const { html, css, lead } = body(d, '0.0.0')
  assert.equal(lead, 'https://imagedelivery.net/a/b/w=1200')
  assert.match(html, /<img class="s\d+" alt="" loading="lazy" fetchpriority="high" referrerpolicy="no-referrer" src="\/i\/a\/b\/w=1200\.webp" srcset="\/i\/a\/b\/w=600\.webp 600w, \/i\/a\/b\/w=1200\.webp 1200w"/)
  // the next one is the CDN's, waits for the first (index.html), and without a known size takes the picture's own
  // (so no srcset, which would change it)
  assert.match(html, /<img alt="" loading="lazy" referrerpolicy="no-referrer" data-src="https:\/\/imagedelivery\.net\/a\/c\/w=1200">/)
  // a known size holds the box before the picture arrives (without it `.imgs` fit to an empty picture: 120 px wide)
  assert.match(css, /aspect-ratio:1200\/800;contain:size;contain-intrinsic-size:1200px 800px/)
  assert.match(html, /<img class="lc-img" alt="" loading="lazy" fetchpriority="low"/)
})

test('without a first picture nothing waits for one', () => {
  const html = page([link])
  assert.ok(!html.includes('data-src') && html.includes('<img class="lc-img" alt="" loading="lazy" fetchpriority="low" referrerpolicy="no-referrer" src="https://quilcast.com/og.png">'))
})

// #275: a video's box takes the shape the server read from its poster, before anything loads
test("a video is drawn in its poster's shape, and 16:9 when that's unknown", () => {
  const v = 'https://stream.farcaster.xyz/v1/video/01a18616-1a75-a56e-1a34-d5e740f5898c.m3u8'
  const drawn = (shapes) => body({ casts: [cast('b'.repeat(40), [v])], got, shapes }, '0.0.0', Date.parse('2026-10-28T12:00:00Z'))
  const tall = drawn({ [v]: [404, 720] })
  const k = tall.html.match(/<div class="vid shaped (s\d+)"><video /)?.[1]
  assert.ok(k, 'the shaped box')
  assert.ok(tall.css.includes(`#app .${k}{--ar:404/720;--alone:286px;--tile:168px}`))
  const plain = drawn({ [v]: null })
  assert.ok(plain.html.includes('<div class="vid"><video '))
})
