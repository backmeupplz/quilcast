import assert from 'node:assert/strict'
import { test } from 'node:test'

// fc.ts expects a browser here and there; this is just enough of one
;(globalThis as any).addEventListener = () => {}
import { assemble, cardOpening, classify, classifyPart, plainOpening, coverOf, fromNode, fromV2, headOf, isArticle, isArticlePart, loadArticle, maybeArticle, partNow, partText, segments, splitArticle, type Part } from './article.ts'
import { castBody, hex, mentions } from './fc.ts'
import { articleHtml } from './shared.ts'

const bytes = (s: string) => new TextEncoder().encode(s).length
const H = (b: string) => '0x' + b.repeat(20)
// how the node's /v1 API answers for a cast (Farcaster's own announcement of Articles, shortened)
const msg = (hash: string, body: object, fid = 1, timestamp = 185079816) => ({ hash, data: { type: 'MESSAGE_TYPE_CAST_ADD', fid, timestamp, network: 'FARCASTER_NETWORK_MAINNET', castAddBody: { embedsDeprecated: [], mentions: [], parentCastId: null, parentUrl: null, embeds: [], mentionsPositions: [], type: 'CAST', ...body } } })
const ROOT = msg(H('d5'), { text: 'Introducing Farcaster Articles!\n\n## The Basics\n- **Title and cover image.** They show on the feed card.', embeds: [{ url: 'https://imagedelivery.net/x/cover/original' }], formatVersion: 1, chain: { index: 0, count: 2 } })
const SECOND = msg(H('db'), {
  text: '- **A public page.** Every article opens anywhere.\\\n\n---\n**Embedded casts **\n[$1]\n**Inline images**\n[$2]\n|If you want to|Use|\n|-|-|\n|Say gm|A cast|',
  parentCastId: { fid: 1, hash: H('d5') }, embeds: [{ castId: { fid: 533, hash: H('fe') } }, { url: 'https://imagedelivery.net/x/pic/original' }], type: 'TEN_K_CAST', formatVersion: 1, chain: { root: { fid: 1, hash: H('d5') }, index: 1, count: 2 },
}, 1, 185079817)

test('a /v1 cast reads with its format and chain, and a chain that breaks the rules is left out', () => {
  const root = fromNode(ROOT)!
  assert.deepEqual(root.chain, { index: 0, count: 2 })
  assert.equal(root.format, 1)
  assert.equal(root.hash, 'd5'.repeat(20))
  assert.ok(isArticle(root) && !isArticlePart(root))
  const second = fromNode(SECOND)!
  assert.deepEqual(second.chain, { root: { fid: 1, hash: 'd5'.repeat(20) }, index: 1, count: 2 })
  assert.deepEqual(second.embeds, [{ cast_id: { fid: 533, hash: 'fe'.repeat(20) } }, { url: 'https://imagedelivery.net/x/pic/original' }])
  assert.ok(isArticlePart(second) && !isArticle(second))
  // protobuf JSON leaves out a zero index; native FIDs come as strings
  assert.deepEqual(fromNode(msg(H('01'), { formatVersion: 1, chain: { count: 3 } }))!.chain, { index: 0, count: 3 })
  assert.equal(fromNode(msg(H('01'), {}, '4294967296' as any))!.fid, 4294967296)
  const bad = (chain: object, fid = 1) => fromNode(msg(H('02'), { formatVersion: 1, chain }, fid))!.chain
  assert.equal(bad({ index: 2, count: 2 }), undefined, 'index at the count')
  assert.equal(bad({ index: 0, count: 101 }), undefined, 'over 100 casts')
  assert.equal(bad({ index: 100, count: 0 }), undefined, 'index 100')
  assert.equal(bad({ index: 0, count: 2, root: { fid: 1, hash: H('d5') } }), undefined, 'a root at index 0')
  assert.equal(bad({ index: 1, count: 2 }), undefined, 'no root later')
  assert.equal(bad({ index: 1, count: 2, root: { fid: 2, hash: H('d5') } }), undefined, "someone else's root")
  assert.equal(bad({ index: 1, count: 2, root: { fid: 1, hash: '0x12' } }), undefined, 'a short hash')
  assert.equal(fromNode({ hash: H('03'), data: { type: 'MESSAGE_TYPE_CAST_REMOVE', fid: 1 } }), null)
  // plain casts: format 0, no chain
  const plain = fromNode(msg(H('04'), { text: 'gm' }))!
  assert.equal(plain.format, 0)
  assert.ok(!isArticle(plain) && !isArticlePart(plain))
})

test("a part without format_version 1 is an article's when its first cast is one", async () => {
  const asked: string[] = []
  const nodes: Record<string, object> = { [H('d5')]: ROOT, [H('0c')]: msg(H('0c'), { text: 'a plain chain', chain: { index: 0, count: 2 } }) }
  const get = async (path: string) => (asked.push(path), nodes[new URLSearchParams(path.split('?')[1]).get('hash')!] || null)
  const part = (root: string) => msg(H('0d'), { text: 'part', chain: { root: { fid: 1, hash: H(root) }, index: 1, count: 2 } })
  assert.equal((await classify(get, part('d5')))?.hash, '0d'.repeat(20))
  assert.equal(await classify(get, part('0c')), null, "a chain that isn't an article")
  assert.deepEqual(asked, [`/v1/castById?fid=1&hash=${H('d5')}`, `/v1/castById?fid=1&hash=${H('0c')}`])
  // an article's cast needs no second look; a plain cast isn't one
  assert.equal((await classify(get, SECOND))?.hash, 'db'.repeat(20))
  assert.equal((await classify(get, ROOT))?.hash, 'd5'.repeat(20))
  assert.equal(await classify(get, msg(H('04'), { text: 'gm' })), null)
  assert.equal(asked.length, 2)
  // a root is asked about once; one the node doesn't have yet is a failure, not a no
  const again = msg(H('0e'), { text: 'part', chain: { root: { fid: 1, hash: H('d5') }, index: 1, count: 2 } })
  assert.equal((await classify(get, again))?.hash, '0e'.repeat(20))
  assert.equal(asked.length, 2)
  await assert.rejects(classify(get, msg(H('0f'), { text: 'part', chain: { root: { fid: 1, hash: H('5a') }, index: 1, count: 2 } })))
})

// how a node with farcasterorg/hypersnap#69 answers in its /v2 API: the same casts, with format_version and chain
const v2 = (hash: string, o: object = {}, fid = 1) => ({ hash, author: { fid, username: 'farcaster' }, text: 'gm', timestamp: '2026-11-12T23:03:36.000Z', embeds: [], mentioned_profiles: [], mentioned_profiles_ranges: [], replies: { count: 0 }, ...o })
const V2_ROOT = v2('d5'.repeat(20), { text: 'Introducing Farcaster Articles!', embeds: [{ url: 'https://imagedelivery.net/x/cover/original', metadata: {} }], format_version: 1, chain: { index: 0, count: 2 } })

test("a /v2 cast with its format fields reads like the /v1 one, and one without them isn't known", () => {
  const root = fromV2(V2_ROOT)!
  assert.ok(isArticle(root))
  assert.deepEqual(root, { fid: 1, hash: 'd5'.repeat(20), at: Math.round((Date.parse('2026-11-12T23:03:36Z') - Date.UTC(2021, 0, 1)) / 1000), text: 'Introducing Farcaster Articles!', mentions: [], positions: [], embeds: [{ url: 'https://imagedelivery.net/x/cover/original' }], format: 1, chain: { index: 0, count: 2 } })
  assert.equal(partNow(root), root)
  // a later part: the root's hash is bare hex here (0x in /v1); mentions and cast embeds as /v1 has them
  const part = fromV2(v2('0x' + 'db'.repeat(20), {
    text: 'hi  and ', mentioned_profiles: [{ fid: 2, username: 'v' }, { fid: '4294967296', username: 'n' }], mentioned_profiles_ranges: [{ start: 3, end: 3 }, { start: 8, end: 8 }],
    embeds: [{ cast_id: { fid: 533, hash: '0x' + 'fe'.repeat(20) }, cast: {} }], format_version: 1, chain: { root: { fid: 1, hash: 'd5'.repeat(20) }, index: 1, count: 2 },
  }))!
  assert.equal(part.hash, 'db'.repeat(20))
  assert.deepEqual(part.chain, { root: { fid: 1, hash: 'd5'.repeat(20) }, index: 1, count: 2 })
  assert.deepEqual([part.mentions, part.positions], [[2, 4294967296], [3, 8]])
  assert.deepEqual(part.embeds, [{ cast_id: { fid: 533, hash: 'fe'.repeat(20) } }])
  assert.equal(partText(part, (fid) => ({ 2: 'v', 4294967296: 'n' })[fid]), 'hi @v and @n')
  assert.equal(partNow(part), part)
  // a plain cast says so; a part not in article Markdown leaves it to its first cast; the chain rules still hold
  assert.equal(partNow(fromV2(v2('04'.repeat(20), { format_version: 0 }))), null)
  assert.equal(partNow(fromV2(v2('05'.repeat(20), { format_version: 0, chain: { root: { fid: 1, hash: 'd5'.repeat(20) }, index: 1, count: 2 } }))), undefined)
  assert.equal(partNow(fromV2(v2('06'.repeat(20), { format_version: 1, chain: { root: { fid: 2, hash: 'd5'.repeat(20) }, index: 1, count: 2 } }))), null, "someone else's root")
  // an older node, a search result or a cast it can't place: the node's /v1 API has to say
  assert.equal(fromV2(v2('07'.repeat(20))), undefined)
  assert.equal(fromV2(v2('08'.repeat(20), { format_version: 1, timestamp: undefined })), undefined)
  assert.equal(fromV2(v2('09', { format_version: 1 })), undefined)
})

test("a /v2 part not in article Markdown asks its first cast through /v2, and through /v1 only when the node can't say", async () => {
  const asked: string[] = []
  const casts: Record<string, object> = { ['c1'.repeat(20)]: v2('c1'.repeat(20), { format_version: 1, chain: { index: 0, count: 2 } }), ['c2'.repeat(20)]: v2('c2'.repeat(20), { format_version: 0, chain: { index: 0, count: 2 } }), ['c3'.repeat(20)]: v2('c3'.repeat(20)), ['c4'.repeat(20)]: v2('c4'.repeat(20), { format_version: 1, chain: { index: 0, count: 2 } }, 2) }
  const get = async (path: string) => {
    asked.push(path.split('?')[0])
    const q = new URLSearchParams(path.split('?')[1])
    if (path.startsWith('/v2/')) return casts[q.get('identifier')!] ? { cast: casts[q.get('identifier')!] } : null
    return q.get('hash') === '0x' + 'c3'.repeat(20) ? msg(H('c3'), { formatVersion: 1, chain: { index: 0, count: 2 } }) : null
  }
  const part = (root: string, fid = 1) => fromV2(v2('0d'.repeat(20), { format_version: 0, chain: { root: { fid, hash: root.repeat(20) }, index: 1, count: 2 } }, fid))!
  assert.equal((await classifyPart(get, part('c1'), true))?.hash, '0d'.repeat(20))
  assert.equal(await classifyPart(get, part('c2'), true), null, "a chain that isn't an article")
  assert.deepEqual(asked.splice(0), ['/v2/farcaster/cast', '/v2/farcaster/cast'])
  // a root without the fields (a node mid-upgrade) is asked about in /v1
  assert.equal((await classifyPart(get, part('c3'), true))?.hash, '0d'.repeat(20))
  assert.deepEqual(asked.splice(0), ['/v2/farcaster/cast', '/v1/castById'])
  // a /v2 lookup is by hash alone, so a root by someone else isn't the author's article
  assert.equal(await classifyPart(get, part('c4', 1), true), null)
  // and one the node doesn't have is a failure
  await assert.rejects(classifyPart(get, part('c5'), true))
  // an article's cast or a plain one needs no lookup at all
  asked.length = 0
  assert.equal((await classifyPart(get, fromV2(V2_ROOT)!, true))?.hash, 'd5'.repeat(20))
  assert.equal(await classifyPart(get, fromV2(v2('04'.repeat(20), { format_version: 0, text: 'A title' }))!, true), null)
  assert.deepEqual(asked, [])
})

test('only casts that could be part of an article are looked up', () => {
  const c = (o: object) => ({ text: 'A title', author: { fid: 1 }, embeds: [], replies: { count: 1 }, ...o })
  assert.ok(maybeArticle(c({})))
  assert.ok(maybeArticle(c({ text: 'A title\n\nThe opening\n- more', embeds: [{ url: 'https://x/cover.png' }] })))
  assert.ok(maybeArticle(c({ replies: undefined })), 'a feed without reply counts')
  assert.ok(!maybeArticle(c({ replies: { count: 0 } })), 'a line alone that nothing follows')
  assert.ok(maybeArticle(c({ text: 'A title\n\nThe whole article', replies: { count: 0 } })), 'an article of one cast')
  assert.ok(!maybeArticle(c({ text: 'two\nlines' })))
  assert.ok(!maybeArticle(c({ embeds: [{ url: 'a' }, { url: 'b' }] })))
  assert.ok(!maybeArticle(c({ embeds: [{ cast_id: { fid: 1, hash: 'ab' } }] })))
  assert.ok(!maybeArticle(c({ text: 'x'.repeat(321) })))
  // a later part replies to the author's own cast
  assert.ok(maybeArticle(c({ parent_hash: 'ab', parent_author: { fid: 1 }, text: 'a\nb\nc' })))
  assert.ok(!maybeArticle(c({ parent_hash: 'ab', parent_author: { fid: 2 } })))
})

test('the first cast holds the title, the opening and the cover', () => {
  assert.deepEqual(headOf('Introducing Farcaster Articles!\n\n## The Basics\n- x'), { title: 'Introducing Farcaster Articles!', opening: '## The Basics\n- x' })
  assert.deepEqual(headOf('  Just a title  '), { title: 'Just a title', opening: '' })
  assert.equal(coverOf([{ url: 'https://imagedelivery.net/x/cover/original' }]), 'https://imagedelivery.net/x/cover/original')
  assert.equal(coverOf([{ url: 'javascript:alert(1)' }]), undefined)
  assert.equal(coverOf([]), undefined)
  // a card's opening leaves out the lines that are embeds
  assert.equal(cardOpening('## Look\n[$1]\nhttps://example.com/x\nwords', [{ url: 'https://c/cover.png' }]), '## Look\nwords')
  assert.equal(plainOpening('a\\*b\n[$1]\nc\\\nd', [{ url: 'https://c/cover.png' }]), 'a*b\nc\nd')
  // an escaped character stays itself, not Markdown; an escaped backslash at a line's end stays
  assert.equal(plainOpening('2\\*3\\*4 and \\_x\\_ **b**'), '2*3*4 and _x_ b')
  assert.equal(plainOpening('a\\\\'), 'a\\')
})

test('a chain is read by its root and count: the latest cast at each index, gaps left as gaps', () => {
  const root = fromNode(msg(H('a0'), { text: 'T', formatVersion: 1, chain: { index: 0, count: 3 } }))! as any
  const part = (hash: string, index: number, at: number, o: { fid?: number; count?: number; root?: string } = {}) =>
    fromNode(msg(H(hash), { text: hash, formatVersion: 1, chain: { root: { fid: o.fid ?? 1, hash: H(o.root ?? 'a0') }, index, count: o.count ?? 3 } }, o.fid ?? 1, at))!
  const a = assemble(root, [part('b1', 1, 10), part('b2', 1, 12), part('c1', 2, 11), part('c2', 2, 11)])
  assert.equal(a.complete, true)
  assert.deepEqual(a.parts.map((p) => p!.hash.slice(0, 2)), ['a0', 'b2', 'c2'], 'latest timestamp, then greatest hash')
  const gappy = assemble(root, [part('b1', 2, 10), part('d1', 1, 10, { count: 4 }), part('e1', 1, 10, { root: 'ff' }), part('f1', 1, 10, { fid: 2 })])
  assert.equal(gappy.complete, false)
  assert.deepEqual(gappy.parts.map((p) => p?.hash.slice(0, 2)), ['a0', undefined, 'b1'])
  // a chain still growing (count 0) goes as far as its parts do
  const growing = fromNode(msg(H('a1'), { text: 'T', formatVersion: 1, chain: { index: 0, count: 0 } }))! as any
  const g = assemble(growing, [fromNode(msg(H('b3'), { formatVersion: 1, chain: { root: { fid: 1, hash: H('a1') }, index: 1, count: 0 } }))!])
  assert.equal(g.parts.length, 2)
  assert.equal(g.complete, true)
})

test("an article is read from the author's casts after its first, page by page, until it's complete", async () => {
  const asked: string[] = []
  const pages: Record<string, object> = {
    '': { messages: [ROOT, msg(H('99'), { text: 'something else' }, 1, 185079817)], nextPageToken: 'p2' },
    p2: { messages: [SECOND, { hash: H('98'), data: { type: 'MESSAGE_TYPE_CAST_REMOVE', fid: 1 } }], nextPageToken: 'p3' },
    p3: { messages: [], nextPageToken: '' },
  }
  const get = async (path: string) => (asked.push(path), pages[new URLSearchParams(path.split('?')[1]).get('pageToken') || ''])
  const a = await loadArticle(get, fromNode(ROOT) as any)
  assert.equal(a.complete, true)
  assert.equal(a.parts[1]!.hash, 'db'.repeat(20))
  assert.deepEqual(asked, ['/v1/castsByFid?fid=1&startTimestamp=185079816&pageSize=100', '/v1/castsByFid?fid=1&startTimestamp=185079816&pageSize=100&pageToken=p2'], 'stops once complete')
})

test("a part's mentions go back into its text", () => {
  const p: Part = { fid: 1, hash: 'ab'.repeat(20), at: 0, text: 'hi  and ', mentions: [2, 3], positions: [3, 8], embeds: [], format: 1 }
  assert.equal(partText(p, (f) => ({ 2: 'ann', 3: 'bob' })[f]), 'hi @ann and @bob')
})

test('a part reads as text and its embeds: where [$N] puts them, links alone on a line as previews, the rest after', () => {
  const s = fromNode(SECOND)!
  const segs = segments(s.text, s.embeds)
  assert.deepEqual(segs.map((x) => ('text' in x ? 'text' : x.embeds.map((e) => e.url || e.cast_id!.hash.slice(0, 2)).join(','))), ['text', 'fe', 'text', 'https://imagedelivery.net/x/pic/original', 'text'])
  // unplaced embeds come after the text, the cover skipped; a [$N] past the embeds stays text
  assert.deepEqual(segments('a\n[$3]\nhttps://example.com/x\nb', [{ url: 'https://c/cover.png' }, { url: 'https://c/2.png' }], [0]), [
    { text: 'a\n[$3]' }, { embeds: [{ url: 'https://example.com/x' }] }, { text: 'b' }, { embeds: [{ url: 'https://c/2.png' }] },
  ])
  // lines in a code block and a line a backslash carries on to stay text
  assert.deepEqual(segments('```\nhttps://example.com\n[$1]\n```\nsee\\\nhttps://example.com', [{ url: 'https://c/1.png' }]), [
    { text: '```\nhttps://example.com\n[$1]\n```\nsee\\\nhttps://example.com' }, { embeds: [{ url: 'https://c/1.png' }] },
  ])
  assert.deepEqual(segments('', []), [])
})

test('article Markdown renders block by block, safely', () => {
  const s = fromNode(SECOND)!
  const html = segments(s.text, s.embeds).flatMap((x) => ('text' in x ? [articleHtml(x.text)] : [])).join('')
  assert.ok(html.startsWith('<ul><li><strong>A public page.</strong> Every article opens anywhere.<br></li></ul><hr><p><strong>Embedded casts</strong> </p>'), html)
  assert.ok(html.includes('<table><thead><tr><th>If you want to</th><th>Use</th></tr></thead><tbody><tr><td>Say gm</td><td>A cast</td></tr></tbody></table>'))
  const md = articleHtml
  assert.equal(md('# Big\n## Small\n### not one'), '<h2>Big</h2><h3>Small</h3><p>### not one</p>')
  assert.equal(articleHtml('## In the feed', undefined, true), '<p class="md-head md-h3">In the feed</p>')
  assert.equal(md('- a\n  - b\n    - c\n- d\n1. one\n2. two'), '<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li><li>d</li></ul><ol><li>one</li><li>two</li></ol>')
  assert.equal(md('> said\n> more\nafter'), '<blockquote><p>said</p><p>more</p></blockquote><p>after</p>')
  assert.equal(md('a\n\nb'), '<p>a</p><p class="md-gap"></p><p>b</p>')
  assert.equal(md('one\\\ntwo\\\\\nthree'), '<p>one<br>two&#92;</p><p>three</p>', 'odd backslashes go on, even ones are an escaped backslash')
  assert.equal(md('**b** _i_ ~~s~~ ++u++ snake_case_name'), '<p><strong>b</strong> <em>i</em> <s>s</s> <u>u</u> snake_case_name</p>')
  assert.equal(md('\\*not em\\* \\_x\\_ C\\+\\+ \\a'), '<p>&#42;not em&#42; &#95;x&#95; C&#43;&#43; \\a</p>')
  assert.equal(md('\\# not a heading\n\\- not a list\n\\> nor a quote'), '<p># not a heading</p><p>- not a list</p><p>&#62; nor a quote</p>')
  assert.equal(md('```js\nconst a = "<b>"\n```'), '<pre><code>const a = &#34;&#60;b&#62;&#34;</code></pre>')
  assert.equal(md('$$\nE = mc^2\n$$\n$$x^2$$\nand $$y$$ inline'), '<pre class="md-math"><code>E = mc^2</code></pre><pre class="md-math"><code>x^2</code></pre><p>and <code class="md-math">y</code> inline</p>')
  assert.equal(md('|a\\|b|c\\-d|\n|-|-|\n|1|2|'), '<table><thead><tr><th>a|b</th><th>c-d</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>')
  assert.equal(md('---'), '<hr>')
  // code and LaTeX are literal: an escape keeps its backslash there
  assert.equal(md('`a\\*b` $$x\\_1 \\\\ y$$ \\*e\\*'), '<p><code>a\\*b</code> <code class="md-math">x\\_1 \\\\ y</code> &#42;e&#42;</p>')
  // an escape in a link's address is its character
  assert.equal(md('[x](https://a.co/a\\_b) https://a.co/c\\_d'), '<p><a class="md-link" href="https://a.co/a_b" target="_blank" rel="noopener noreferrer nofollow">x</a> <a href="https://a.co/c_d" target="_blank" rel="noopener noreferrer nofollow">a.co/c_d</a></p>')
  // no HTML, and only http(s) links
  assert.equal(md('<img src=x onerror=alert(1)> [x](javascript:alert) [ok](https://a.co)'), '<p>&#60;img src=x onerror=alert(1)&#62; x <a class="md-link" href="https://a.co/" target="_blank" rel="noopener noreferrer nofollow">ok</a></p>')
  // mentions, put back before parsing, link
  assert.equal(md('hi @ann'), '<p>hi <a href="/u/ann">@ann</a></p>')
  // the private-use characters escapes use can't be typed in
  assert.equal(md('\ue000'), '<p>\ufffd</p>')
})

test('an article goes out as casts that each fit, blocks whole, embeds after text and of one kind', () => {
  const pic = (n: number) => `![](https://imagedelivery.net/x/${n}/original)`
  const out = splitArticle({ title: '  My   trip ', cover: 'https://imagedelivery.net/x/cover/original', body: `## Day one\nWe left early.\n${pic(1)}\n${pic(2)}\nhttps://example.com/map\nThen it rained.\n${'Long words go on. '.repeat(120)}\n\`\`\`\n${'code line\n'.repeat(150)}\`\`\`` })
  assert.deepEqual(out[0], { text: 'My trip\n\n## Day one\nWe left early.', embeds: ['https://imagedelivery.net/x/cover/original'] })
  assert.deepEqual(out[1], { text: '', embeds: ['https://imagedelivery.net/x/1/original', 'https://imagedelivery.net/x/2/original'] })
  assert.deepEqual(out[2], { text: '', embeds: ['https://example.com/map'] })
  assert.equal(out[3].text.split('\n')[0], 'Then it rained.')
  for (const p of out) assert.ok(bytes(p.text) <= 1024, `${bytes(p.text)} bytes`)
  // the long paragraph is cut at spaces, the code block by lines, each piece a whole block
  const code = out.filter((p) => p.text.startsWith('```'))
  assert.ok(code.length > 1)
  for (const p of code) assert.match(p.text, /^```\n(code line\n)+```$/)
  // and it reads back as written
  const back = out.slice(1).map((p) => p.text).join('\n')
  assert.equal(back.replace(/\n```\n```\n/g, '\n').replace(/\s+/g, ' ').includes('Then it rained. ' + 'Long words go on. '.repeat(119) + 'Long words go on.'), true)
  // four embeds at most in a cast, and text after an embed starts a new one
  const many = splitArticle({ title: 'Pics', body: `intro\n${[1, 2, 3, 4, 5].map(pic).join('\n')}\nend` })
  assert.deepEqual(many.map((p) => [p.text, p.embeds.length]), [['Pics\n\nintro', 0], ['', 4], ['', 1], ['end', 0]])
  // a table stays whole, or is cut by rows with its header again
  const table = splitArticle({ title: 'T', body: `x\n|a|b|\n|-|-|\n${'|row|cell|\n'.repeat(200)}` })
  for (const p of table.slice(1).filter((p) => p.text.includes('|'))) assert.match(p.text, /^(x\n)?\|a\|b\|\n\|-\|-\|\n(\|row\|cell\|\n?)+$/)
  assert.throws(() => splitArticle({ title: ' ', body: 'x' }), /needs a title/)
  assert.throws(() => splitArticle({ title: 'x'.repeat(321), body: '' }), /title is too long/)
  assert.throws(() => splitArticle({ title: 'x', body: 'word '.repeat(30000) }), /too long to publish/)
  // a heading that opens the body comes with its paragraph; a long opening waits for the next cast
  assert.deepEqual(splitArticle({ title: 'T', body: 'x'.repeat(1030) })[0], { text: 'T', embeds: [] })
  assert.deepEqual(splitArticle({ title: 'T', body: '# Hi\n\nthere\nmore' })[0], { text: 'T\n\n# Hi\nthere', embeds: [] })
  // no cast is sent empty, not even the gap before a block too long to join it
  const gap = splitArticle({ title: 'T', body: 'p\n\n```\n' + 'a'.repeat(3000) + '\n```' })
  for (const p of gap) assert.ok(p.text || p.embeds.length, JSON.stringify(gap.map((x) => x.text.length)))
  // a long quote or list item is cut into pieces that each keep its marker; a long code line keeps every character
  const quote = splitArticle({ title: 'T', body: `x\n> ${'said it. '.repeat(200)}\n  - ${'item '.repeat(300)}` })
  for (const p of quote.slice(1)) for (const l of p.text.split('\n')) assert.match(l, /^(x|> \S|  - \S)/)
  const line = '  ' + 'ab '.repeat(500)
  const longCode = splitArticle({ title: 'T', body: `x\n\`\`\`\n${line}\n\`\`\`` }).slice(1).map((p) => p.text.split('\n').slice(1, -1).join(''))
  assert.equal(longCode.join('').length, line.length)
  // a line typed as [$N] is written escaped, so readers don't take it for an embed
  assert.deepEqual(splitArticle({ title: 'T', body: 'x\n[$1]' }).map((p) => p.text), ['T\n\nx', '\\[$1]'])
  assert.equal(articleHtml('\\[$1]'), '<p>&#91;$1]</p>')
  assert.throws(() => splitArticle({ title: 'T', cover: 'https://example.com/' + 'a'.repeat(260), body: '' }), /address is too long/)
  assert.throws(() => splitArticle({ title: 'T', body: `x\n|${'h'.repeat(1200)}|\n|-|\n|a|` }), /too wide/)
  // a long paragraph's pieces never start like a block: each would be read as one
  // a carry-on backslash cut off on its own still carries the line on
  const carried = splitArticle({ title: 'T', body: `x\n${'w'.repeat(1021)} \\\nafter` })
  assert.ok(carried.slice(1).map((p) => articleHtml(p.text)).join('').endsWith('<p><br>after</p>'))
  for (const [tail, shown] of [['- item and more', '- item and more'], ['1. one and more', '1. one and more'], ['# head and more', '# head and more'], ['> quote and more', '&#62; quote and more'],
    ['```js and more', '```js and more'], ['[$1]', '&#91;$1]'], ['https://example.com/x', 'example.com/x'], ['|a|b|', '|a|b|']]) {
    // the first piece is as full as it gets, so the next starts right at `tail`
    const out = splitArticle({ title: 'T', body: `x\n${'w'.repeat(1021)} ${tail}\nafter` })
    assert.equal(out[2].text.split('\n')[0], `\\${tail}`)
    const html = out.slice(1).map((p) => articleHtml(p.text)).join('')
    assert.ok(!/<(ul|ol|h2|blockquote|pre|table)/.test(html), `${tail}: ${html.slice(-200)}`)
    assert.ok(html.includes(shown), `${tail}: ${html.slice(-200)}`)
    assert.ok(!out.slice(1).some((p) => segments(p.text, []).some((s) => 'embeds' in s)), tail)
  }
})

test('an article cast mentions at most 10 people; the rest stay as text', async () => {
  const names = Array.from({ length: 12 }, (_, i) => `@u${i}`).join(' ')
  const m = await mentions(names, async (n) => Number(n.slice(1)) + 1, 10)
  assert.equal(m.mentions.length, 10)
  assert.ok(m.text.endsWith('@u10 @u11'))
})

test('an article cast carries format_version 1 and its place in the chain (fields 9 and 10)', () => {
  const root = { fid: 1, hash: 'ab'.repeat(20) }
  const id = '0801' + '1214' + 'ab'.repeat(20)
  assert.equal(hex(castBody({ text: 'T', format: 1, chain: { index: 0, count: 2 } })), '220154' + '4801' + '52021802')
  assert.equal(hex(castBody({ text: 'T', parent: root, format: 1, chain: { root, index: 1, count: 2 } })), '1a18' + id + '220154' + '4801' + '521e' + '0a18' + id + '1001' + '1802')
  // a plain cast is as before
  assert.equal(hex(castBody({ text: 'T' })), '220154')
})
