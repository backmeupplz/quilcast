import assert from 'node:assert/strict'
import { test } from 'node:test'
import { castHtml, item, rss, shown, xml } from './feed.mjs'

const SITE = 'https://quilcast.test'
const h = (b) => b.repeat(20)
const cast = (o = {}) => ({ hash: '0x' + h('ab'), text: 'hello', timestamp: '2026-01-02T03:04:05Z', author: { fid: 1, username: 'ann', display_name: 'Ann' }, embeds: [], ...o })

test('xml escapes markup and drops what XML 1.0 cannot hold', () => {
  assert.equal(xml(`<a href="x">&'`), '&lt;a href=&quot;x&quot;&gt;&amp;&apos;')
  assert.equal(xml('ring\u0007 the\u0000 bell￿￾'), 'ring the bell')
  // a lone half of a surrogate pair goes, a whole pair stays
  assert.equal(xml('a\ud800b\udc00c😀'), 'abc😀')
  assert.equal(xml('tab\tline\ncr\r'), 'tab\tline\ncr\r')
  assert.equal(xml(undefined), '')
})

test("a cast's HTML: Markdown as the app shows it, links absolute, line breaks kept, pictures and quotes below", () => {
  const out = castHtml(cast({
    text: 'hi **there** @bob in /dev\nsee [docs](https://a.com/?x=1&y=2) <script>alert(1)</script>\n![pic](https://b.com/p.png)',
    embeds: [{ url: 'https://imagedelivery.net/a/b/original' }, { url: 'https://i.imgur.com/x.png' }, { url: 'https://example.com/page' }, { url: 'javascript:alert(1)' }, { cast_id: { fid: 2, hash: '0x' + h('cd') } }, { cast_id: { hash: 'nope' } }],
  }), SITE)
  assert.match(out, /<strong>there<\/strong>/)
  assert.match(out, /<a href="https:\/\/quilcast\.test\/u\/bob">@bob<\/a>/)
  assert.match(out, /href="https:\/\/quilcast\.test\/channel\/dev"/)
  assert.match(out, /dev<\/a><br>see/)
  assert.match(out, /href="https:\/\/a\.com\/\?x=1&#38;y=2"/)
  assert.match(out, /src="https:\/\/quilcast\.test\/api\/img\?u=/)
  assert.ok(!out.includes('<script>'), out)
  assert.match(out, /<p><img src="https:\/\/imagedelivery\.net\/a\/b\/original" alt="" referrerpolicy="no-referrer"><\/p>/)
  // another site's embed loads through our proxy, so its host never sees the reader
  assert.ok(out.includes(`<p><img src="${SITE}/api/img?u=https%3A%2F%2Fi.imgur.com%2Fx.png" alt=""`), out)
  assert.ok(!out.includes('src="https://i.imgur.com'), out)
  assert.match(out, /<p><a href="https:\/\/example\.com\/page">https:\/\/example\.com\/page<\/a><\/p>/)
  assert.match(out, new RegExp(`<a href="${SITE}/c/0x${h('cd')}">Quoted cast</a>`))
  assert.ok(!out.includes('javascript:'), out)
  assert.ok(!/(href|src)="\//.test(out), out)
})

test("a cast's tags link as Hypersnap indexed its text, before its mentions are put back in", () => {
  const m = (text, ...at) => cast({ text, mentioned_profiles: at.map(() => ({ username: 'dwr' })), mentioned_profiles_ranges: at.map((start) => ({ start, end: start })) })
  // a mention inside a tag: Hypersnap indexed "gm", so the "#g" shown finds nothing
  assert.ok(!castHtml(m('#gm', 2), SITE).includes('tag-ref'))
  // a mention glued before the first tag doesn't stop Hypersnap counting it, so #t32 is its 33rd and stays text
  const out = castHtml(m(Array.from({ length: 33 }, (_, i) => `#t${i}`).join(' '), 0), SITE)
  assert.ok(out.includes('/search?q=%23t31&#38;t=casts') && !out.includes('%23t32'), out)
})

test('an item: link and guid are the cast page, the title a cut of the text, author and date set, all escaped', () => {
  const evil = '$& "><script>alert(1)</script> ' + 'word '.repeat(40)
  const x = item(cast({ text: evil }), SITE)
  const link = `${SITE}/c/0x${h('ab')}`
  assert.match(x, new RegExp(`<link>${link}</link><guid isPermaLink="true">${link}</guid>`))
  assert.match(x, /<pubDate>Fri, 02 Jan 2026 03:04:05 GMT<\/pubDate>/)
  assert.match(x, /<dc:creator>Ann \(@ann\)<\/dc:creator>/)
  // a nameless author is named by FID once, not "!2 (!2)"
  assert.match(item(cast({ author: { fid: 2 } }), SITE), /<dc:creator>!2<\/dc:creator>/)
  const title = x.match(/<title>([^<]*)<\/title>/)[1]
  assert.ok(title.startsWith('$&amp; &quot;&gt;&lt;script&gt;') && title.endsWith('…'), title)
  assert.ok(!x.includes('<script'), x)
  // the description's HTML is itself escaped once more, as XML
  assert.match(x, /<description>&lt;div&gt;\$&amp;#38; &amp;#34;&amp;#62;&amp;#60;script/)
  // a picture alone gets a title all the same; a bad date leaves pubDate out
  const bare = item(cast({ text: '', timestamp: 'never', embeds: [{ url: 'https://b.com/p.png' }] }), SITE)
  assert.match(bare, /<title>A cast by @ann<\/title>/)
  assert.ok(!bare.includes('<pubDate>'))
  assert.match(item(cast({ text: '', author: undefined }), SITE), /<title>A cast<\/title>/)
})

test('shown: newest first, replies only when asked, nothing malformed', () => {
  const casts = [
    cast({ hash: '0x' + h('01'), timestamp: '2026-01-01T00:00:00Z' }),
    cast({ hash: '0x' + h('02'), timestamp: '2026-01-03T00:00:00Z', parent_hash: '0x' + h('01') }),
    cast({ hash: '0x' + h('03'), timestamp: '2026-01-02T00:00:00Z', parent_url: 'chain://eip155:1/erc721:0xfd84' }),
    cast({ hash: 'not a hash' }),
    null,
  ]
  assert.deepEqual(shown(casts).map((c) => c.hash.slice(2, 4)), ['03', '01'])
  assert.deepEqual(shown(casts, { replies: true }).map((c) => c.hash.slice(2, 4)), ['02', '03', '01'])
  assert.equal(shown(casts, { replies: true, max: 1 }).length, 1)
  assert.deepEqual(shown(undefined), [])
  // casts and accounts taken down for everyone stay out
  const gone = { casts: ['0x' + h('03')], fids: [] }
  assert.deepEqual(shown(casts, { gone }).map((c) => c.hash.slice(2, 4)), ['01'])
  assert.deepEqual(shown([...casts, cast({ hash: '0x' + h('04'), author: { fid: 66 } })], { gone: { casts: [], fids: [1] } }).map((c) => c.hash.slice(2, 4)), ['04'])
})

test('a whole feed is RSS 2.0 with a self link, an image only when it is https, and every field escaped', () => {
  const doc = rss({ title: 'A & B <x>', link: `${SITE}/u/ann`, self: `${SITE}/u/ann/rss?replies=1`, desc: 'bio\u0007 "quoted"', image: 'https://img/p.png', casts: [cast()], site: SITE })
  assert.ok(doc.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel>'))
  assert.match(doc, /<title>A &amp; B &lt;x&gt;<\/title>/)
  assert.match(doc, /<description>bio &quot;quoted&quot;<\/description>/)
  assert.match(doc, /<atom:link href="https:\/\/quilcast\.test\/u\/ann\/rss\?replies=1" rel="self" type="application\/rss\+xml" \/>/)
  assert.match(doc, /<image><url>https:\/\/quilcast\.test\/api\/img\?u=https%3A%2F%2Fimg%2Fp\.png<\/url><title>A &amp; B &lt;x&gt;<\/title><link>https:\/\/quilcast\.test\/u\/ann<\/link><\/image>/)
  assert.equal(doc.match(/<item>/g).length, 1)
  assert.ok(doc.endsWith('</channel></rss>\n'))
  assert.ok(!rss({ title: 't', link: 'l', self: 's', desc: 'd', image: 'http://insecure/p.png', casts: [], site: SITE }).includes('<image>'))
  assert.ok(rss({ title: 't', link: 'l', self: 's', desc: 'd', image: 'https://imagedelivery.net/a/b/w=400', casts: [], site: SITE }).includes('<image><url>https://imagedelivery.net/a/b/w=400</url>'))
})
