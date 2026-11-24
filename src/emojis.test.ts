// Inline custom emojis (FIP draft "Inline Custom Emoji", farcasterorg/protocol discussion #28): shared.ts emojisOf,
// asEmojis and markdown's `emojis`, fc.ts castBody.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { castBody, hex } from './fc.ts'
import { asEmojis, castText, emojisOf, markdown, taggable, unmarkdown, urlsOf } from './shared.ts'

const st = 'https://quilcast.com/st/abcd1234/0123456789abcdef01234567.webp'
const st2 = 'https://quilcast.com/st/abcd1234/89abcdef0123456789abcdef.webp'
const other = 'https://example.com/e/dirty.gif'

test("a cast's emojis are its labelled url embeds whose :label: its text has, the first one with a label winning", () => {
  const c = {
    text: 'that tackle was :dirty: and the ref saw :eyes: :dup: :Bad:',
    embeds: [{ url: other, emoji_label: 'dirty' }, { url: st, emoji_label: 'eyes' }, { url: st2, emoji_label: 'absent' }, { url: 'https://a.b/1.gif', emoji_label: 'dup' }, { url: 'https://a.b/2.gif', emoji_label: 'dup' }, { url: 'https://a.b/3.gif', emoji_label: 'Bad' }, { url: 'https://a.b/p.jpg' }, { cast_id: { fid: 3, hash: '0x' + 'ab'.repeat(20) } }],
  }
  assert.deepEqual([...emojisOf(c)], [['dirty', other], ['eyes', st], ['dup', 'https://a.b/1.gif']])
  // those are drawn in the text, not again under it; any other labelled embed is an ordinary picture
  assert.deepEqual(urlsOf(c), [st2, 'https://a.b/2.gif', 'https://a.b/3.gif', 'https://a.b/p.jpg'])
  assert.deepEqual([...emojisOf({ text: 'no shortcode', embeds: [{ url: other, emoji_label: 'dirty' }] })], [])
  assert.deepEqual([...emojisOf({ text: ':x:', embeds: [{ url: 'javascript:alert(1)', emoji_label: 'x' }] })], [])
  // a labelled video, front page, .html page or mini app keeps its card; a picture host without an extension counts
  const cards = ['https://a.b/v.mp4#t=1', 'https://a.b/?x', 'https://a.b/x.html', 'https://farcaster.xyz/miniapps/x/y']
  const d = { embeds: [...cards.map((url, i) => ({ url, emoji_label: 'vshm'[i] })), { url: 'https://pics.b/abc123', emoji_label: 'p' }, { url: 'https://a.b/i?src=a.html', emoji_label: 'q' }], text: ':v: :s: :h: :m: :p: :q:' }
  assert.deepEqual([...emojisOf(d)], [['p', 'https://pics.b/abc123'], ['q', 'https://a.b/i?src=a.html']])
  assert.deepEqual(urlsOf(d), cards)
})

test('an emoji sits in the line, from our server or through the picture proxy, and nowhere a :label: means something else', () => {
  const c = { text: 'lfg :check: and `:check:` :other: @dwr', embeds: [{ url: other, emoji_label: 'check' }, { url: st, emoji_label: 'other' }] }
  const html = markdown(c.text, taggable(c.text), emojisOf(c))
  const img = (src: string, l: string) => `<img class="md-emoji" src="${src}" alt=":${l}:" title=":${l}:" height="20" loading="lazy" decoding="async" referrerpolicy="no-referrer">`
  assert.equal(html, `lfg ${img(`/api/img?u=${encodeURIComponent(other)}`, 'check')} and <code>:check:</code> ${img('/st/abcd1234/0123456789abcdef01234567.webp', 'other')} <a href="/u/dwr">@dwr</a>`)
  // in emphasis, a list and a quote too; a :label: no embed has stays text
  assert.match(markdown('**:check:** :nope:\n\n- :check:\n\n> :check:', undefined, emojisOf(c)), /^<strong><img class="md-emoji"[^>]*><\/strong> :nope:<ul><li><img class="md-emoji"[^>]*><\/li><\/ul><blockquote><img class="md-emoji"[^>]*><\/blockquote>$/)
  // a cast without emojis comes out exactly as before, and the next one drawn doesn't get this one's
  assert.equal(markdown(c.text, undefined, new Map()), markdown(c.text))
  assert.ok(!markdown(c.text).includes('md-emoji'))
  // a :label: only in code or inside a link isn't drawn, so its picture shows under the text instead of nowhere
  for (const text of ['use `:check:`', '```\n:check:\n```', 'see https://x.y/:check:']) {
    const d = { text, embeds: [{ url: other, emoji_label: 'check' }] }
    assert.deepEqual([...emojisOf(d)], [], text)
    assert.deepEqual(urlsOf(d), [other], text)
  }
  // emphasis doesn't take a label's underscores
  const u = { text: ':_x_: and :__init__:', embeds: [{ url: other, emoji_label: '_x_' }, { url: st, emoji_label: '__init__' }] }
  assert.deepEqual(urlsOf(u), [])
  assert.equal((markdown(u.text, undefined, emojisOf(u)).match(/md-emoji/g) || []).length, 2)
  assert.equal(markdown(u.text), ':<em>x</em>: and :<strong>init</strong>:')
  // places without pictures keep the :label: text, the FIP's fallback
  assert.equal(unmarkdown(castText(c)), "lfg :check: and :check: :other: @dwr")
})

test("a translation's emojis are the ones it draws, and the rest show under the cast as pictures", () => {
  const c = { text: 'lfg :check: :eyes:', embeds: [{ url: other, emoji_label: 'check' }, { url: st, emoji_label: 'eyes' }] }
  assert.deepEqual(urlsOf(c), [])
  // kept, translated, dropped or put in code: only a :label: the translation draws hides its picture
  const shown: [string, string[], string[]][] = [['погнали :check: :eyes:', ['check', 'eyes'], []], ['погнали :галочка: :eyes:', ['eyes'], [other]], ['погнали', [], [other, st]], ['погнали `:check:` :eyes:', ['eyes'], [other]]]
  for (const [text, drawn, under] of shown) {
    assert.deepEqual([...emojisOf(c, text).keys()], drawn, text)
    assert.deepEqual(urlsOf(c, text), under, text)
  }
  // a label the original doesn't use still counts once the shown text draws it, and no shown text is the cast's own
  assert.deepEqual([...emojisOf({ ...c, text: 'lfg' }, ':check:').keys()], ['check'])
  assert.deepEqual(urlsOf(c, undefined), urlsOf(c))
})

test("the composer's shortcode stickers go out as emojis in the slots left, and its mentions move with the text", () => {
  const text = `gm ![:sunrise:](${st}) é ![:sunrise:](${st}) ![:sunrise:](${st2}) ![:wave:](${st2}) ![🌅](${st}) ![:x:](${other}) ![:y:](${st2})`
  // "@a" was before the first sticker, "@b" (at its byte) after the second, as mentions() leaves them
  const at = new TextEncoder().encode(text.slice(0, text.indexOf(' ![:wave:]'))).length
  const r = asEmojis(text, [3, at], 2)
  // the same sticker twice is one emoji; another sticker with a taken label, any non-sticker and anything past the
  // room stay Markdown
  assert.equal(r.text, `gm :sunrise: é :sunrise: ![:sunrise:](${st2}) :wave: ![🌅](${st}) ![:x:](${other}) ![:y:](${st2})`)
  assert.deepEqual(r.emojis, [{ url: st, label: 'sunrise' }, { url: st2, label: 'wave' }])
  assert.deepEqual(r.positions, [3, new TextEncoder().encode(r.text.slice(0, r.text.indexOf(' :wave:'))).length])
  assert.deepEqual(asEmojis(text, [], 0).text, text)
  // a sticker the cast also embeds as a picture stays Markdown: readers would hide that picture with the emoji
  assert.deepEqual(asEmojis(`a ![:wave:](${st2})`, [], 4, [st2]).emojis, [])
})

test('an emoji embed carries its label as Embed field 3', () => {
  // CastAddBody: text (4), then embed (6) { url (1), emoji_label (3) }
  assert.equal(hex(castBody({ text: ':a:', embeds: [{ url: 'https://x.y/a.gif', label: 'a' }] })), '22033a613a' + '3216' + '0a11' + hex(new TextEncoder().encode('https://x.y/a.gif')) + '1a0161')
  assert.equal(hex(castBody({ text: 'x', embeds: ['https://x.y/a.gif'] })), '220178' + '3213' + '0a11' + hex(new TextEncoder().encode('https://x.y/a.gif')))
})

test('a train car keeps an emoji its label, so it draws it in its text too', async () => {
  const { carMedia, castEmbeds, TRAIN } = await import('./shared.ts')
  const c = { text: 'lfg :check:', embeds: [{ url: 'https://a.b/p.jpg' }, { url: other, emoji_label: 'check' }, { url: 'https://a.b/x.gif', emoji_label: 'Not' }] }
  const q = { fid: 3, hash: 'ab'.repeat(20) }
  assert.deepEqual(castEmbeds(c.text, carMedia(c), q), ['https://a.b/p.jpg', { url: other, label: 'check' }, TRAIN, q])
})
