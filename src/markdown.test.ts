import assert from 'node:assert/strict'
import { test } from 'node:test'
import { markdown as md } from './shared.ts'

test('plain casts render as before: text, line breaks, links, mentions, channels', () => {
  assert.equal(md('gm\n\nhi @dwr see quilcast.com on /base'), 'gm\n\nhi <a href="/u/dwr">@dwr</a> see <a href="https://quilcast.com/" target="_blank" rel="noopener noreferrer nofollow">quilcast.com</a> on <span class="chan-ref">/base</span>')
  assert.equal(md('<b>x</b> & "y"'), '&#60;b&#62;x&#60;/b&#62; &#38; &#34;y&#34;')
  assert.equal(md('5 * 3 = 15, snake_case_name, @some_x_handle'), '5 * 3 = 15, snake_case_name, <a href="/u/some">@some</a>_x_handle')
  assert.equal(md('born in\n1990. Then more'), 'born in\n1990. Then more')
})

test('inline formatting', () => {
  assert.equal(md('**b** *i* _i_ __b__ ~~s~~ `a*b*`'), '<strong>b</strong> <em>i</em> <em>i</em> <strong>b</strong> <s>s</s> <code>a*b*</code>')
  assert.equal(md('**bold *and em***'), '<strong>bold <em>and em</em></strong>')
  assert.equal(md('x https://a.com/a_b_c_ y'), 'x <a href="https://a.com/a_b_c_" target="_blank" rel="noopener noreferrer nofollow">a.com/a_b_c_</a> y')
  assert.equal(md('[**docs**](https://a.com/d)'), '<a href="https://a.com/d" target="_blank" rel="noopener noreferrer nofollow"><strong>docs</strong></a>')
  assert.equal(md('[x](javascript:alert(1))'), '[x](javascript:alert(1))')
  assert.equal(md('[x](http://localhost/a)'), 'x')
  assert.equal(md('see ![a cat](http://i.imgur.com/c.png) and ![x](javascript:1)'), 'see <img class="md-img" src="https://i.imgur.com/c.png" alt="a cat" loading="lazy" referrerpolicy="no-referrer"> and x')
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
})

test('styled: each character of the card text knows how it looked', async () => {
  const { styled, MD } = await import('./shared.ts')
  const { text, marks } = styled('## Hi\n**b** *i* `c` @dwr\n> q')
  assert.equal(text, 'Hi\nb i c @dwr\nq')
  const at = (s: string) => marks[text.indexOf(s)]
  assert.deepEqual([at('Hi'), at('b'), marks[text.indexOf(' i ') + 1], at('c'), at('@dwr'), at('q'), at(' ')], [MD.heading, MD.bold, MD.italic, MD.code, MD.link, MD.quote, 0])
  assert.equal(marks.length, text.length)
})
