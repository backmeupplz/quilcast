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
