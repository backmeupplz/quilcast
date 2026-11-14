// The server-drawn home page lays out a cast's embeds as the app does (src/ui.tsx Embeds, src/shared.ts embedLayout),
// so the app's first frame is the same page (#257: a link card and a tweet, stacked instead of in a strip).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { body } from './home.mjs'

const author = { fid: 3, username: 'ada', display_name: 'Ada', pfp_url: '' }
const cast = (hash, urls) => ({ hash, author, text: 'look', timestamp: '2026-10-28T10:00:00Z', embeds: urls.map((url) => ({ url })), reactions: {}, replies: {} })
const link = 'https://quilcast.com/'
const tweet = 'https://x.com/cass_on_mars/status/1'
const plain = 'https://example.com/post'
const got = {
  [`u:${link}`]: { url: link, title: 'Quilcast', description: 'A Farcaster client', image: 'https://quilcast.com/og.png', button: 'Open in Quilcast' },
  [`u:${plain}`]: { url: plain, title: 'A post', image: 'https://example.com/og.png' },
  [`u:${tweet}`]: { url: tweet, tweet: { text: '(see screenshot)', author: { name: 'Cass', handle: 'cass_on_mars' }, at: 1761645600, photos: ['https://pbs.twimg.com/media/a.jpg'], quote: { name: 'Arf', handle: 'arfonzo', text: 'hi' } } },
}
const page = (urls) => body({ casts: [cast('a'.repeat(40), urls)], got, shapes: {} }, '0.0.0', Date.parse('2026-10-28T12:00:00Z')).html

test('a link card and a tweet stack as compact cards, with the tweet photo in its own grid', () => {
  const html = page([link, tweet])
  assert.ok(!html.includes('class="strip"'))
  const cards = html.slice(html.indexOf('<div class="cards">'))
  assert.ok(html.includes('<div class="cards"><a class="linkcard big lc-app"'), 'the link card opens the stack')
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
  assert.ok(!html.includes('class="cards"') && !html.includes('class="strip"') && html.includes('<a class="linkcard big lc-app"'))
})

// a mini app's embed image is 3:2 (it has a button), so its card gets the 3:2 box; plain Open Graph cards keep theirs
test("a mini app card's picture is 3:2, a plain link's isn't", () => {
  assert.ok(page([link]).includes('<a class="linkcard big lc-app"'))
  assert.ok(page([plain]).includes('<a class="linkcard big"'))
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

test('an X article shows its cover, title and opening instead of its bare link', () => {
  const article = 'https://x.com/cass_on_mars/status/2'
  got[`u:${article}`] = { url: article, tweet: { text: '', author: { name: 'Cass', handle: 'cass_on_mars' }, photos: [], article: { title: 'Hot wallets', text: 'what a week', cover: 'https://pbs.twimg.com/media/c.jpg' } } }
  const html = page([article])
  assert.match(html, /<div class="tw-article"><img[^>]*class="lc-img"[^>]*><div class="lc-text"><span class="lc-title">Hot wallets<\/span><span class="lc-desc">what a week<\/span>/)
})

// #572: another site's picture (an avatar, a link preview's image, a tweet's photo) comes through /api/img, so its
// host never sees who is reading; ours and Farcaster's image CDN load as they are
test("other sites' pictures load through /api/img", () => {
  const html = body({ casts: [{ ...cast('b'.repeat(40), [plain, tweet, 'https://imagedelivery.net/a/b/original']), author: { ...author, pfp_url: 'https://i.imgur.com/me.png' } }], got, shapes: {} }, '0.0.0', Date.parse('2026-10-28T12:00:00Z')).html
  const srcs = [...html.matchAll(/<img[^>]* (?:data-)?src="([^"]*)"/g)].map((m) => m[1].replaceAll('&amp;', '&'))
  for (const u of ['https://i.imgur.com/me.png', 'https://example.com/og.png', 'https://pbs.twimg.com/media/a.jpg']) assert.ok(srcs.includes(`/api/img?u=${encodeURIComponent(u)}`), u)
  assert.ok(srcs.some((s) => s.startsWith('https://imagedelivery.net/') || s.startsWith('/i/')), 'the CDN picture loads as it is')
  assert.ok(!srcs.some((s) => /^https?:\/\/(?!imagedelivery\.net\/)/.test(s)), srcs.join(' '))
})

// #643: a Farcaster Article (src/article.ts, marked by server/index.mjs) is its cover, title and opening, as the app's
// ArticleCard draws it, instead of its first cast's raw text
test('a Farcaster Article shows its cover, title and opening', () => {
  const c = { ...cast('d5'.repeat(20), ['https://imagedelivery.net/x/cover/original']), text: 'Introducing <Articles>\n\n## The Basics\n- **Title** and _cover_', replies: { count: 1 } }
  const article = { fid: 3, hash: c.hash, at: 1, text: c.text, mentions: [], positions: [], embeds: c.embeds, format: 1, chain: { index: 0, count: 2 } }
  const html = body({ casts: [{ ...c, article }], got, shapes: {} }, '0.0.0', Date.parse('2026-10-28T12:00:00Z')).html
  assert.match(html, /<div class="fc-article"><img class="fa-cover"[^>]*src="[^"]*cover\/w=1200[^"]*"[^>]*><div class="fa-text"><b class="fa-title" dir="auto">Introducing &#60;Articles&#62;<\/b><div class="text article-text fa-open" dir="auto"><h3>The Basics<\/h3><ul><li><strong>Title<\/strong> and <em>cover<\/em><\/li><\/ul><\/div><span class="fa-more">Read article<\/span><\/div><\/div>/)
  assert.ok(!html.includes('## The Basics'))
  // a cast that isn't one (or not known yet) is drawn as a cast
  const plain = body({ casts: [{ ...c, article: null }], got, shapes: {} }, '0.0.0', Date.parse('2026-10-28T12:00:00Z')).html
  assert.ok(!plain.includes('fc-article') && plain.includes('class="text fold"'))
})

// #663: a quoted cast with no words and a video from outside Farcaster drew as an empty card (only its author line)
test('a quoted cast with no words shows its video or its link, never an empty card', () => {
  const quoted = (hash, url) => ({ hash, author, text: '', timestamp: '2026-10-28T10:00:00Z', embeds: [{ url }], reactions: {}, replies: {} })
  const drawn = (q) => {
    const c = { ...cast('c'.repeat(40), []), embeds: [{ cast_id: { fid: 3, hash: `0x${q.hash}` } }] }
    const html = body({ casts: [c], got: { ...got, [`c:${q.hash}`]: q }, shapes: {} }, '0.0.0', Date.parse('2026-10-28T12:00:00Z')).html
    return html.slice(html.indexOf('<a class="quote"'))
  }
  const vid = drawn(quoted('d'.repeat(40), 'https://media.firefly.land/post_m3u8/abc/def.m3u8'))
  assert.match(vid, /^<a class="quote" href="\/c\/d{40}">[^]*<div class="qbody bare"><span class="qvid" role="img" aria-label="Play video"><svg [^]*<\/svg><\/span><\/div><\/a>/)
  const lnk = drawn(quoted('e'.repeat(40), 'https://example.com/post'))
  assert.match(lnk, /<div class="qbody bare"><span class="qlink"><svg [^]*<\/svg><span>example\.com\/post<\/span><\/span><\/div><\/a>/)
})
