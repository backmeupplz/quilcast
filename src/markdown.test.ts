import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LINK_RE, linkify, markdown as md } from './shared.ts'

test('plain casts render as before: text, line breaks, links, mentions, channels', () => {
  assert.equal(md('gm\n\nhi @dwr see quilcast.com on /base'), 'gm\n\nhi <a href="/u/dwr">@dwr</a> see <a href="https://quilcast.com/" target="_blank" rel="noopener noreferrer nofollow">quilcast.com</a> on <a class="chan-ref" href="/channel/base">/base</a>')
  assert.equal(md('<b>x</b> & "y"'), '&#60;b&#62;x&#60;/b&#62; &#38; &#34;y&#34;')
  assert.equal(md('5 * 3 = 15, snake_case_name, @some_x_handle'), '5 * 3 = 15, snake_case_name, <a href="/u/some">@some</a>_x_handle')
  assert.equal(md('born in\n1990. Then more'), 'born in\n1990. Then more')
})

test('a bare domain glued to a letter of another script links nothing, not just its ASCII part', () => {
  const a = (u: string, label = u) => `<a href="https://${u}/" target="_blank" rel="noopener noreferrer nofollow">${label}</a>`
  // Cyrillic а, о and м, Greek ο, a combining accent, an Arabic-Indic digit
  // and the same with invisible characters in between, or a non-ASCII label after it
  for (const s of ['аpple.com', 'see аpple.com/login now', 'pаypal.com', 'google.coм', 'appleο.com', 'épple.com', '٣pple.com', 'quilcast.comа',
    'а​pple.com', 'a­pple.com', 'а⁠﻿pple.com', 'google.co​m', 'apple.com.рф', 'apple.com.​рф',
    'аㅤpple.com', 'а᠎pple.com', 'а‎pple.com', 'а\u{e0041}pple.com', 'google.coㅤм',
    // a later label that starts in ASCII doesn't make a shorter domain out of it either
    'google.co.ukм', 'bbc.co.ukа', 'a⃣pple.com', 'а️⃣pple.com', 'x.com⃣', 'а️pple.com', 'apple.com.xрф', 'apple.com.mаil', 'apple.com.co.uкм', 'apple.com.uk.​рф',
    // combining accents some spaceless scripts share still glue on the letter they sit on: tilde, dot below, NFD
    'а̃pple.com', 'ãpple.com', 'а̣pple.com', 'cạ̀pple.com', 'españa.com', 'google.cõm',
    'a̅pple.com', 'a̱pple.com', 'a゙pple.com', 'aัpple.com', 'ã​pple.com', 'x.com̃', 'x.com​̣', 'x.com゙'])
    for (const out of [linkify(s), md(s)]) assert.ok(!out.includes('<a'), `${s} → ${out}`)
  assert.equal('аpple.com'.match(LINK_RE), null)
  // ASCII bare domains, and ones next to punctuation or a script written without spaces, still link
  assert.equal(linkify('quilcast.com'), a('quilcast.com'))
  assert.equal(linkify('«quilcast.com» — “x.com”'), `«${a('quilcast.com')}» — “${a('x.com')}”`)
  assert.equal(linkify('访问quilcast.com看看'), `访问${a('quilcast.com')}看看`)
  assert.equal(linkify('quilcast.comで見て'), `${a('quilcast.com')}で見て`)
  assert.equal(linkify('ไปที่quilcast.com'), `ไปที่${a('quilcast.com')}`)
  assert.equal(linkify('ไปที่​quilcast.com'), `ไปที่​${a('quilcast.com')}`)
  // their marks too: decomposed kana voicing, Thai vowels and tones, a shared tilde on a Han character
  for (const pre of ['ガ', 'か゚', 'ที่', '漢̃', 'ガ​'])
    assert.equal(linkify(`${pre}quilcast.com`), `${pre}${a('quilcast.com')}`)
  assert.equal(linkify('‏quilcast.com.Next'),`‏${a('quilcast.com')}.Next`)
  assert.equal(linkify('quilcast.com.uk'), a('quilcast.com.uk'))
  assert.equal(linkify('quilcast.com. Затем'), `${a('quilcast.com')}. Затем`)
  // an emoji's variation selector or keycap isn't a glued letter
  assert.equal(linkify('➡️quilcast.com'), `➡️${a('quilcast.com')}`)
  assert.equal(linkify('see ❤️quilcast.com'), `see ❤️${a('quilcast.com')}`)
  assert.equal(linkify('1️⃣quilcast.com'), `1️⃣${a('quilcast.com')}`)
  assert.equal(linkify('x.com️'), `${a('x.com')}️`)
  // characters Japanese and Chinese share with other scripts: ー and 〆 are Common, ｰ and ﾞ halfwidth, ㄅ Bopomofo
  for (const [pre, post] of [['サーバー', ''], ['コーヒー', 'で'], ['ｰ', ''], ['〆', ''], ['ｶﾞ', ''], ['ㄅㄆ', ''], ['〇', ''], ['', 'ー'],
    // and digits every script shares: circled, fullwidth, superscript
    ['①', 'にアクセス'], ['❶', ''], ['２０２４', ''], ['', '１'], ['', '²']])
    assert.equal(linkify(`${pre}quilcast.com${post}`), `${pre}${a('quilcast.com')}${post}`)
  // any case still links, but ſ and the Kelvin sign aren't s and k: they're letters glued to the domain
  assert.equal(linkify('Quilcast.COM and HTTPS://X.com'), `${a('quilcast.com', 'Quilcast.COM')} and ${a('x.com', 'HTTPS://X.com')}`)
  for (const s of ['\u017ftripe.com', '\u212ax.com', 'x.co\u212a', 'http\u017f://x.com']) assert.ok(!linkify(s).includes('<a'), s)
  assert.equal(linkify('https://аpple.com'), a('xn--pple-43d.com', 'аpple.com'))
  assert.equal(md('**quilcast.com**, @dwr on /base'), `<strong>${a('quilcast.com')}</strong>, <a href="/u/dwr">@dwr</a> on <a class="chan-ref" href="/channel/base">/base</a>`)
})

test('long runs of invisible characters or labels around a domain take linear time', () => {
  const a = (u: string) => `<a href="https://${u}/" target="_blank" rel="noopener noreferrer nofollow">${u}</a>`
  for (const ch of ['​', '⁠']) {
    const s = ch.repeat(20000) + ' quilcast.com'
    const t = performance.now()
    const out = [linkify(s), md(s)]
    const ms = performance.now() - t
    for (const o of out) assert.ok(o.endsWith(` ${a('quilcast.com')}`), o.slice(-120))
    assert.ok(ms < 200, `${ms} ms`)
  }
  // and long runs of labels before a glued letter, which the match backs off one label at a time
  for (const s of ['com.'.repeat(20000) + 'рф', 'x.' + 'a.'.repeat(20000) + 'м', 'x.' + 'co.​'.repeat(20000) + 'м']) {
    const t = performance.now()
    const out = [linkify(s), md(s)]
    const ms = performance.now() - t
    for (const o of out) assert.ok(!o.includes('<a'), o.slice(-120))
    assert.ok(ms < 200, `${ms} ms`)
  }
  // and long runs of invisible characters after a domain, then a space (links) or a glued letter or keycap (doesn't)
  for (const ch of ['​', '️', '⁠'])
    for (const [end, links] of [[' ', true], ['м', false], ['⃣', false], ['̃', false]] as const) {
      const s = 'quilcast.com' + ch.repeat(30000) + end
      const t = performance.now()
      const out = [linkify(s), md(s)]
      const ms = performance.now() - t
      for (const o of out) assert.equal(o.startsWith(a('quilcast.com')), links, o.slice(0, 120))
      assert.ok(ms < 200, `${ms} ms`)
    }
  // and long runs of marks, with or without invisible characters, before a domain or after its labels
  for (const [s, links] of [['a' + '̃'.repeat(30000) + 'quilcast.com', false], ['漢' + '̃'.repeat(30000) + 'quilcast.com', true],
    ['漢' + '̃​'.repeat(30000) + 'quilcast.com', true], ['x.' + 'a.'.repeat(20000) + 'm' + '̃'.repeat(20000), false]] as const) {
    const t = performance.now()
    const out = [linkify(s), md(s)]
    const ms = performance.now() - t
    for (const o of out) assert.equal(o.includes('<a'), links, o.slice(-120))
    assert.ok(ms < 200, `${ms} ms`)
  }
  // and long runs of invisible characters right before a domain, after the start, a space or a glued letter
  for (const ch of ['​', '⁠', '­', '͏', '️', '᠋', '\u{e0100}'])
    for (const [start, links] of [['', true], [' ', true], ['a', false], ['а', false]] as const) {
      const s = start + ch.repeat(20000) + 'quilcast.com'
      const t = performance.now()
      const out = [linkify(s), md(s)]
      const ms = performance.now() - t
      for (const o of out) assert.equal(o.endsWith(`${a('quilcast.com')}`), links, o.slice(-120))
      assert.ok(ms < 200, `${ch.codePointAt(0)?.toString(16)} after '${start}': ${ms} ms`)
    }
})

test('mentions, channels and emphasis treat ſ and the Kelvin sign as letters, not s and k', () => {
  for (const s of ['@Kelvin', '@aſb', '/ſtar', '/Kb']) assert.equal(md(s), s)
  assert.equal(md('@DWR on /Base'), '<a href="/u/DWR">@DWR</a> on <a class="chan-ref" href="/channel/base">/Base</a>')
  assert.equal(md('ſ/base K@dwr ſ_x_'), 'ſ<a class="chan-ref" href="/channel/base">/base</a> K<a href="/u/dwr">@dwr</a> ſ<em>x</em>')
})

test('inline formatting', () => {
  assert.equal(md('**b** *i* _i_ __b__ ~~s~~ `a*b*`'), '<strong>b</strong> <em>i</em> <em>i</em> <strong>b</strong> <s>s</s> <code>a*b*</code>')
  assert.equal(md('**bold *and em***'), '<strong>bold <em>and em</em></strong>')
  assert.equal(md('x https://a.com/a_b_c_ y'), 'x <a href="https://a.com/a_b_c_" target="_blank" rel="noopener noreferrer nofollow">a.com/a_b_c_</a> y')
  assert.equal(md('[**docs**](https://a.com/d)'), '<a class="md-link" href="https://a.com/d" target="_blank" rel="noopener noreferrer nofollow"><strong>docs</strong></a>')
  assert.equal(md('[x](javascript:alert(1))'), '[x](javascript:alert(1))')
  assert.equal(md('[x](http://localhost/a)'), 'x')
  assert.equal(md('see ![a cat](http://i.imgur.com/c.png) and ![x](javascript:1)'), 'see <img class="md-img" src="/api/img?u=http%3A%2F%2Fi.imgur.com%2Fc.png" alt="a cat" loading="lazy" decoding="async" referrerpolicy="no-referrer"> and x')
  assert.match(md('![](https://imagedelivery.net/a/b/original)'), /src="https:\/\/imagedelivery\.net\/a\/b\/original"/)
  // the app's own uploads that stay on our server load straight from it too; a look-alike host still goes through /api/img
  assert.match(md('![](https://quilcast.com/m/0123456789abcdef01234567.png)'), /src="https:\/\/quilcast\.com\/m\/0123456789abcdef01234567\.png"/)
  assert.match(md('![](https://quilcast.com.evil.com/m/a.png)'), /src="\/api\/img\?u=/)
  assert.match(md('[x](https://a.com) https://b.com @dwr'), /^(?:[^<]*<a [^>]*>[^<]*<\/a>){3}$/)
  for (const a of md('[x](https://a.com) https://b.com').match(/<a [^>]*>/g)!) assert.match(a, /rel="noopener noreferrer nofollow"/)
})

test('a Markdown picture is not an embed too', async () => {
  const { urlsOf } = await import('./shared.ts')
  const text = '![cat](https://i.imgur.com/c.png)'
  assert.deepEqual(urlsOf({ text, embeds: [{ url: 'https://i.imgur.com/c.png' }, { url: 'https://a.com/' }] }), ['https://a.com/'])
  assert.deepEqual(urlsOf({ text, embeds: [] }), [])
})

test('blocks', () => {
  assert.equal(md('# Title\ntext\n## Sub #'), '<h1>Title</h1>text<h2>Sub</h2>')
  assert.equal(md('#hashtag'), '#hashtag')
  assert.equal(md('a\n\n```js\nif (a < b) **x**\n```\nb'), 'a<pre><code>if (a &#60; b) **x**</code></pre>b')
  assert.equal(md('> quoted **x**\n> more\nafter'), '<blockquote>quoted <strong>x</strong>\nmore</blockquote>after')
  assert.equal(md('a\n---\nb'), 'a<hr>b')
  assert.equal(md('- a\n- b\n  - c\n    1. d\nend'), '<ul><li>a</li><li>b<ul><li>c<ol><li>d</li></ol></li></ul></li></ul>end')
  assert.equal(md('3. x\n4. y'), '<ol start="3"><li>x</li><li>y</li></ol>')
  assert.equal(md('| a | b |\n|:-|-:|\n| 1 | **2** |\nafter'), '<table><thead><tr><th>a</th><th class="md-right">b</th></tr></thead><tbody><tr><td>1</td><td class="md-right"><strong>2</strong></td></tr></tbody></table>after')
  assert.equal(md('a | b\n---'), 'a | b<hr>')
})

test('unmarkdown: what share cards and meta tags say', async () => {
  const { unmarkdown } = await import('./shared.ts')
  assert.equal(unmarkdown('gm @dwr, 5 * 3 & snake_case'), 'gm @dwr, 5 * 3 & snake_case')
  assert.equal(unmarkdown('# Title\n**bold** [docs](https://a.com/d) `x<y`\n> quote\n\n3. a\n4. b\n   - c\n---\n| A | B |\n|-|-|\n| 1 | 2 |'), 'Title\nbold docs x<y\nquote\n\n3. a\n4. b\n  • c\n\nA · B\n1 · 2')
})

test('the composer formatting buttons', async () => {
  const { format } = await import('./shared.ts')
  const f = (text: string, how: any) => {
    const [s, e] = [text.indexOf('['), text.indexOf(']') - 1]
    const [out, a, b] = format(text.replace('[', '').replace(']', ''), s, e, how)
    return out.slice(0, a) + '[' + out.slice(a, b) + ']' + out.slice(b)
  }
  assert.equal(f('a [bold] b', { mark: '**' }), 'a **[bold]** b')
  assert.equal(f('a **[bold]** b', { mark: '**' }), 'a [bold] b')
  assert.equal(f('a [**bold**] b', { mark: '**' }), 'a [bold] b')
  assert.equal(f('a [] b', { mark: '`' }), 'a `[]` b')
  assert.equal(f('see [docs]', { link: 'link' }), 'see [docs]([https://])')
  assert.equal(f('see []', { link: 'link' }), 'see [link]([https://])')
  assert.equal(f('one\nt[wo\nthr]ee\nfour', { line: '- ' }), 'one\n[- two\n- three]\nfour')
  assert.equal(f('[- two\n- three]', { line: '- ' }), '[two\nthree]')
  assert.equal(f('[- two\nthree]', { line: '1. ' }), '[1. two\n2. three]')
  assert.equal(f('x\n[ti]tle', { line: '## ' }), 'x\n[## title]')
  // a picture goes on a line of its own, the selection as its alt text, the caret after it
  assert.equal(f('one[]two', { picture: 'up:1' }), 'one\n![](up:1)\n[]two')
  assert.equal(f('one\n[]\ntwo', { picture: 'up:1' }), 'one\n![](up:1)[]\ntwo')
  assert.equal(f('[]', { picture: 'up:1' }), '![](up:1)[]')
  assert.equal(f('see [a cat]\nend', { picture: 'up:1' }), 'see \n![a cat](up:1)[]\nend')
  assert.equal(format('[a]\nb', 0, 5, { picture: 'up:1' })[0], '![a b](up:1)')
})

test('a picture put in by the composer, once its upload is done', async () => {
  const { format, settlePicture, imagesIn, urlsOf } = await import('./shared.ts')
  const url = 'https://imagedelivery.net/a/b/original'
  // two pictures between paragraphs, put in one after the other
  let [text, a] = format('Intro\n\nOutro', 6, 6, { picture: 'uploading:a' })
  const putA = text.slice(6, a)
  ;[text] = format(text, a, a, { picture: 'uploading:b' })
  assert.equal(text, 'Intro\n![](uploading:a)\n![](uploading:b)\nOutro')
  // still uploading, the token is no link and no picture: nothing is shown or embedded for it
  assert.deepEqual(imagesIn(text), [])
  assert.equal(md(text).includes('uploading'), false)
  text = settlePicture(text, 'uploading:b', url)
  assert.equal(text, `Intro\n![](uploading:a)\n![](${url})\nOutro`)
  // a failed one is taken out as it went in
  text = settlePicture(text, 'uploading:a', undefined, putA)
  assert.equal(text, `Intro\n\n![](${url})\nOutro`)
  // the reader's Quilcast shows it in place and doesn't embed it again
  assert.match(md(text), /^Intro\n\n<img class="md-img" src="https:\/\/imagedelivery\.net\/a\/b\/original"/)
  assert.deepEqual(urlsOf({ text, embeds: [{ url }] }), [])
  // one the author already deleted from the text stays deleted
  assert.equal(settlePicture('gone', 'uploading:c', url), 'gone')
  // one that failed or was taken out leaves its alt text where it was: the author's selection, or what the brackets hold now
  assert.equal(settlePicture('![alt](uploading:d) end', 'uploading:d'), 'alt end')
  let [cat] = format('see a cat\nend', 4, 9, { picture: 'uploading:k' })
  assert.equal(cat, 'see \n![a cat](uploading:k)\nend')
  assert.equal(settlePicture(cat, 'uploading:k', undefined, cat.slice(4, -4), 'a cat'), 'see a cat\nend')
  ;[cat] = format('see [a]\nb cat', 4, 13, { picture: 'uploading:m' })
  assert.equal(settlePicture(cat, 'uploading:m', undefined, cat.slice(4), '[a]\nb cat'), 'see [a]\nb cat')
  assert.equal(settlePicture('see \n![a big cat](uploading:n)\nend!', 'uploading:n', undefined, '\n![a cat](uploading:n)\n', 'a cat'), 'see \na big cat\nend!')
  // a failed one comes out as it went in, line breaks and all; one edited since only as far as its own line goes
  const [put] = format('onetwo', 3, 3, { picture: 'uploading:e' })
  assert.equal(settlePicture(put, 'uploading:e', undefined, put.slice(3, -3)), 'onetwo')
  assert.equal(settlePicture('![a](x)\nalt](uploading:f)\nb', 'uploading:f', undefined, '\n![alt](uploading:f)\n'), '![a](x)\nalt\nb')
  // two put in one after the other share a line break, so the second keeps its line when the first fails
  let [two, c] = format('onetwo', 3, 3, { picture: 'uploading:g' })
  const putG = two.slice(3, c)
  ;[two] = format(two, c, c, { picture: 'uploading:h' })
  assert.equal(two, 'one\n![](uploading:g)\n![](uploading:h)\ntwo')
  assert.equal(settlePicture(two, 'uploading:g', undefined, putG), 'one\n![](uploading:h)\ntwo')
  // and with the selection back, the second still keeps its line
  ;[two, c] = format('one cat', 4, 7, { picture: 'uploading:p' })
  const putP = two.slice(4, c)
  ;[two] = format(two, c, c, { picture: 'uploading:q' })
  assert.equal(settlePicture(two, 'uploading:p', undefined, putP, 'cat'), 'one cat\n![](uploading:q)')
})

test('the caret is found again after a picture finished uploading somewhere else in the post', async () => {
  const { remap } = await import('./shared.ts')
  const url = 'https://imagedelivery.net/a/b/original'
  const was = 'one\n![](uploading:a)\ntwo three'
  const now = was.replace('uploading:a', url)
  // after the picture: moved along with the text after it, a selection kept whole
  const t = was.indexOf('two')
  assert.deepEqual(remap(was, t, t + 3, now), [now.indexOf('two'), now.indexOf('two') + 3])
  // before it: stays
  assert.deepEqual(remap(was, 1, 2, now), [1, 2])
  assert.deepEqual(remap(was, 0, 0, now), [0, 0])
  // at the end
  assert.deepEqual(remap(was, was.length, was.length, now), [now.length, now.length])
  // right before what changed it stays, in the middle of it it goes to the end
  assert.deepEqual(remap(was, 8, 8, now), [8, 8])
  assert.deepEqual(remap(was, 12, 12, now), [now.length, now.length])
  assert.deepEqual(remap(was, 5, 7, was), [5, 7])
})

test('styled: each character of the card text knows how it looked', async () => {
  const { styled, MD } = await import('./shared.ts')
  const { text, marks } = styled('## Hi\n**b** *i* `c` @dwr\n> q')
  assert.equal(text, 'Hi\nb i c @dwr\nq')
  const at = (s: string) => marks[text.indexOf(s)]
  assert.deepEqual([at('Hi'), at('b'), marks[text.indexOf(' i ') + 1], at('c'), at('@dwr'), at('q'), at(' ')], [MD.heading, MD.bold, MD.italic, MD.code, MD.link, MD.quote, 0])
  assert.equal(marks.length, text.length)
})
