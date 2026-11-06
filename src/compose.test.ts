// The composer's attachments (compose.tsx): a GIF picked from Tenor (src/gifs.tsx) is attached like an uploaded photo,
// counts against MAX_EMBEDS with the first post's quote and fixed embeds, and goes out as the cast's embed as it is.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { castEmbeds, embedRoom, holdsPicture, isImg, pictureToken, isLookImg, MAX_EMBEDS, PICTURE_TOKEN, postMedia, sentFiles, textLinks, urlsOf, withGif } from './shared.ts'

const GIF = 'https://media1.tenor.com/m/gotOLnyvy4YAAAAd/bubu-dancing-dance.gif'
const att = (url: string) => ({ id: Math.random(), preview: url, video: false, url })
const photo = (i: number) => att(`https://imagedelivery.net/a/p${i}/original`)

test('a picked GIF is attached and becomes the post\'s embed, shown as an animated picture', () => {
  const files = withGif([photo(1)], 0, att(GIF))
  assert.deepEqual(files.map((f) => f.url), ['https://imagedelivery.net/a/p1/original', GIF])
  // the first post's fixed embeds (a mini app's links) go first, then the attachments
  assert.deepEqual(postMedia(['https://app.example/'], files), ['https://app.example/', 'https://imagedelivery.net/a/p1/original', GIF])
  // the feed shows it as a picture (ui.tsx Media), not a link card, and the picker accepts it
  assert.ok(isImg(GIF))
  assert.ok(isLookImg(GIF))
})

test('the photo and GIF buttons go off once a post has no room, a quote counting in the first post', () => {
  assert.equal(MAX_EMBEDS, 4)
  assert.equal(embedRoom(0, 0), 4)
  // a quote leaves three
  assert.equal(embedRoom(2, 1), 1)
  assert.equal(embedRoom(3, 1), 0)
  // a full post takes no GIF
  const full = [1, 2, 3, 4].map(photo)
  assert.equal(embedRoom(full.length, 0), 0)
  assert.equal(withGif(full, 0, att(GIF)), full)
  // nor does one whose quote and mini app links fill it
  assert.equal(withGif([photo(1)], 3, att(GIF)).length, 1)
  assert.equal(embedRoom(5, 1), 0)
})

test('posting a GIF signs a cast whose embed is the Tenor URL', async () => {
  const store = new Map<string, string>()
  Object.assign(globalThis, { addEventListener: () => {}, dispatchEvent: () => true })
  ;(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) }
  const { hex } = await import('./fc.ts')
  const api = await import('./api.ts')
  const { post } = await import('./write.ts')
  api.setAccount({ phrase: 'test test test test test test test test test test test junk', custody: '0x7', fid: 7, signer: hex(new Uint8Array(32).fill(1)), signerAt: Math.floor(Date.now() / 1000), scopes: 2, done: true })
  const sent: Uint8Array[] = []
  ;(globalThis as any).fetch = async (url: string, o: any = {}) => {
    const u = new URL(url, 'https://quilcast.test')
    if (u.pathname === '/v1/submitMessage') return sent.push(o.body), new Response('{}')
    if (u.pathname === '/v1/signer') return new Response('{}')
    throw new Error(`unexpected ${url}`)
  }
  const hash = await post('look', { media: postMedia([], [att(GIF)]) })
  assert.equal(sent.length, 1)
  assert.ok(Buffer.from(sent[0]).includes(GIF), 'the signed message embeds the GIF URL')
  assert.deepEqual(api.posting.get(hash)?.embeds, [{ url: GIF }])
})

test("a cast just posted shows as the node will serve it: its text without mentions, so its tags are the indexed ones", async () => {
  const { castText, taggable } = await import('./shared.ts')
  const api = await import('./api.ts')
  const { post } = await import('./write.ts')
  ;(globalThis as any).fetch = async (url: string) => {
    const u = new URL(url, 'https://quilcast.test')
    if (u.pathname === '/v1/submitMessage' || u.pathname === '/v1/signer') return new Response('{}')
    if (u.pathname.endsWith('/user/by-username') && u.searchParams.get('username') === 'dwr') return Response.json({ user: { fid: 3, username: 'dwr' } })
    throw new Error(`unexpected ${url}`)
  }
  const typed = `@dwr${Array.from({ length: 33 }, (_, i) => `#t${i}`).join(' ')}`
  const c = api.posting.get(await post(typed))!
  assert.ok(c.text.startsWith('#t0 '), c.text)
  assert.equal(castText(c), typed)
  // Hypersnap indexes #t0 to #t31 of the text sent, so #t32 isn't one to link
  const tags = taggable(c.text)
  assert.ok(tags.has('#t0') && tags.has('#t31') && !tags.has('#t32'))
})

test('a picture the text shows with Markdown is not embedded too, so it takes no slot (#396)', () => {
  const pic = 'https://imagedelivery.net/a/inline/original'
  const text = `Intro\n![a cat](${pic})\nmore at https://a.com and https://b.com`
  // the links in the text fill the slots left, the inline picture is not one of them
  assert.deepEqual(castEmbeds(text, [photo(1).url]), [photo(1).url, 'https://a.com', 'https://b.com'])
  assert.deepEqual(castEmbeds(`![](${pic}) ![](${pic.replace('inline', 'two')})`, []), [])
  // a quote and four links: the quote first, at most MAX_EMBEDS
  const q = { fid: 1, hash: '0x1' }
  assert.deepEqual(castEmbeds('a.com b.com c.com d.com e.com', [], q), [q, 'https://a.com', 'https://b.com', 'https://c.com'])
  // an attachment the text already shows inline isn't embedded either
  assert.deepEqual(postMedia(['https://app.example/'], [photo(1), att(pic)], text), ['https://app.example/', photo(1).url])
})

test('the link cards the composer shows are the links that go out: a picture\'s URL is one however it is typed (#396)', () => {
  // ![](https://A.com) shows https://a.com/, so neither the typed https://A.com nor A.com gets a card or an embed
  for (const text of ['![](https://A.com) https://A.com and https://b.com', '![](https://a.com) A.com and https://b.com', '![](https://A.com) https://b.com']) {
    assert.deepEqual(textLinks(text), ['https://b.com'], text)
    assert.deepEqual(castEmbeds(text, []), textLinks(text), text)
  }
  assert.deepEqual(textLinks('see https://A.com'), ['https://A.com'])
})

test('words typed right after a picture don\'t make its URL a link, so a picture ending a post is no broken embed (#396)', () => {
  const pic = 'https://imagedelivery.net/abc/def/original'
  for (const text of [`![](${pic})nice`, `![](${pic})これ`, `Intro\n![a https://b.com cat](${pic})これ`]) {
    assert.deepEqual(textLinks(text), [], text)
    assert.deepEqual(castEmbeds(text, []), [], text)
    // nor does a reader's Quilcast make a card of it for a cast with no embeds
    assert.deepEqual(urlsOf({ text }), [], text)
  }
  // a link typed after it is still one
  assert.deepEqual(textLinks(`![](${pic})nice https://b.com`), ['https://b.com'])
  assert.deepEqual(urlsOf({ text: `![](${pic})nice https://b.com` }), ['https://b.com/'])
})

test('an attachment the text also shows as a picture leaves its slot to a link, as postMedia doesn\'t send it (#396)', () => {
  const pic = 'https://imagedelivery.net/a/inline/original'
  const text = `![](${pic}) a.com b.com c.com d.com`
  const files = [att(pic)]
  assert.equal(sentFiles(files, text), 0)
  assert.equal(sentFiles(files, 'a.com'), 1)
  // the composer's link cards: all four links, as castEmbeds sends them
  assert.equal(embedRoom(sentFiles(files, text), 0), MAX_EMBEDS)
  assert.deepEqual(castEmbeds(text, postMedia([], files, text)), ['https://a.com', 'https://b.com', 'https://c.com', 'https://d.com'])
  // the room for attachments counts it, so with the picture taken out of the text again a quote and every attachment
  // still go out: two more fit with a quote, then a GIF doesn't
  const q = { fid: 1, hash: '0x1' }
  const full = [...files, photo(1), photo(2)]
  assert.equal(embedRoom(full.length, 1), 0)
  assert.equal(withGif(full, 1, att(GIF)).length, 3)
  assert.deepEqual(castEmbeds('hi', postMedia([], full, 'hi'), q), [pic, photo(1).url, photo(2).url, q])
  // still uploading, it takes its slot
  assert.equal(sentFiles([{ id: 1, preview: '', video: false }], text), 1)
  assert.equal(withGif([photo(1), photo(2), photo(3), photo(4)], 0, att(GIF)).length, 4)
})

test('a post that still holds a picture\'s upload stand-in is never sent or saved, even with the stand-in broken (#396)', () => {
  const token = `${PICTURE_TOKEN}ab12cd34`
  assert.ok(holdsPicture(`one\n![](${token})\ntwo`))
  // its ) deleted, or cut out and pasted into another post while it uploads: no picture of that post can settle it
  assert.ok(holdsPicture(`one ![alt](${token} two`))
  assert.ok(holdsPicture(`![x](${token.slice(0, -3)}`))
  assert.ok(!holdsPicture('uploading: done, see ![](https://imagedelivery.net/a/p/original)'))
  // its ![…]( broken up: the token alone still holds the post back, but only a token the composer handed out
  const mine = pictureToken()
  assert.ok(holdsPicture(`![hello ! (${mine})](https://imagedelivery.net/x/y/original)`))
  assert.ok(holdsPicture(`![(${mine})`))
  assert.ok(holdsPicture(`hello ${mine} two`))
  for (const t of ['Status uploading:complete, thanks', 'build uploading:20261102', `hello ${token} two`]) assert.ok(!holdsPicture(t))
})

test('a new picture never breaks up one still uploading, and one broken up anyway never goes out as it\'s typed (#396)', async () => {
  const { format, pictureSpot, pictureToken, settlePicture } = await import('./shared.ts')
  const url = 'https://imagedelivery.net/x/y/original'
  const [ta, tb] = [pictureToken(), pictureToken()]
  assert.match(ta, /^uploading:[a-z0-9]{8}$/)
  const [one] = format('hello', 5, 5, { picture: ta })
  assert.equal(one, `hello\n![](${ta})`)
  // the review's repro: select it all and put in another picture
  const [two] = format(one, 0, one.length, { picture: tb })
  assert.equal(two, `${one}\n![](${tb})`)
  // a selection that ends partway into it, or a caret inside it, the same
  assert.equal(format(one, 0, 10, { picture: tb })[0], two)
  assert.equal(format(one, 9, 9, { picture: tb })[0], two)
  assert.deepEqual(pictureSpot(one, 0, 10), [one.length, one.length])
  // around it, the selection is still the new picture's alt text
  assert.equal(format(one, 0, 5, { picture: tb })[0], `![hello](${tb})\n![](${ta})`)
  assert.deepEqual(pictureSpot(one, one.length, one.length), [one.length, one.length])
  let text = settlePicture(two, tb, url)
  assert.ok(holdsPicture(text))
  assert.equal(settlePicture(text, ta, url), `hello\n![](${url})\n![](${url})`)
  assert.ok(!holdsPicture(settlePicture(text, ta, url)))
  // broken up by hand (as the old alt text did): it's still put right, done or failed, so nothing holds the post back
  text = `![hello ! (${ta})](${url})`
  assert.equal(settlePicture(text, ta, url), `![hello ! (${url})](${url})`)
  assert.equal(settlePicture(text, ta), `![hello ! ()](${url})`)
  assert.equal(settlePicture(`![(${ta}) end`, ta, undefined, `![](${ta})`), '![() end')
  // its ] deleted, and a caret inside its token: the new picture goes after the token, which stays whole
  const cut = `![(${ta})`
  const [put] = format(cut, 7, 7, { picture: tb })
  assert.equal(put, `${cut.slice(0, -1)}\n![](${tb})\n)`)
  assert.equal(settlePicture(settlePicture(put, tb, url), ta, url), `![(${url}\n![](${url})\n)`)
  // a caret just before or after it is left where it is
  assert.deepEqual(pictureSpot(cut, 3, 3), [3, 3])
  assert.deepEqual(pictureSpot(cut, cut.length - 1, cut.length - 1), [cut.length - 1, cut.length - 1])
  for (const t of [settlePicture(text, ta, url), settlePicture(text, ta)]) assert.ok(!holdsPicture(t))
})

test('uploads wait their turn, at most 3 at a time (server/upload.mjs MAX_ACTIVE_PER_FID), even when some fail (#396)', async () => {
  const { queue } = await import('./shared.ts')
  const slot = queue(3)
  let now = 0
  let most = 0
  const started: number[] = []
  const go: (() => void)[] = []
  const jobs = [0, 1, 2, 3, 4, 5].map((i) =>
    slot(() => {
      started.push(i)
      most = Math.max(most, ++now)
      return new Promise<number>((ok, no) => go.push(() => (now--, i === 1 ? no(new Error('failed')) : ok(i))))
    }),
  )
  for (const j of jobs) j.catch(() => {})
  const tick = () => new Promise((r) => setTimeout(r))
  await tick()
  assert.deepEqual(started, [0, 1, 2])
  go[1]()
  delete go[1]
  await tick()
  assert.deepEqual(started, [0, 1, 2, 3])
  for (let i = 0; go.some(Boolean) && i < 20; i++) {
    const g = go.findIndex(Boolean)
    const f = go[g]
    delete go[g]
    f()
    await tick()
  }
  const out = await Promise.allSettled(jobs)
  assert.deepEqual(out.map((r) => r.status), ['fulfilled', 'rejected', 'fulfilled', 'fulfilled', 'fulfilled', 'fulfilled'])
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5])
  assert.equal(most, 3)
})

test('a Markdown [label](url) link is already in the text, so it gets no card, no embed, and no card for readers', () => {
  for (const text of ['see [my site](https://a.com)', 'see [a.com](https://a.com)', '[x](https://a.com)nice']) {
    assert.deepEqual(textLinks(text), [], text)
    assert.deepEqual(castEmbeds(text, []), [], text)
    assert.deepEqual(urlsOf({ text }), [], text)
    // a cast already sent with it embedded
    assert.deepEqual(urlsOf({ text, embeds: [{ url: 'https://a.com' }] }), [], text)
  }
  assert.deepEqual(textLinks('[x](https://a.com) and https://b.com'), ['https://b.com'])
  assert.deepEqual(textLinks('![](https://a.com/p.png) [x](https://b.com) c.com'), ['https://c.com'])
})
