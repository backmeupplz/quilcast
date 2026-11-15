// Quilcast WASM (wasm/) in WebKit, Safari's engine, served the way wasm.quilcast.com serves it, against a stand-in
// Hypersnap node: it reads and draws feeds, threads and profiles, signs in with a recovery phrase, and every message
// it submits is a valid Farcaster message signed by the key it added (made by WebCrypto, never seen by the page).
// Needs both builds and WebKit for Playwright: npm run build && sh wasm/build.sh && npx playwright install webkit chromium
// WebKit keeps a CryptoKey in IndexedDB wrapped under a master key from the user's keychain, which a CI runner (a
// launchd daemon with no login keychain) can't reach: there, the sign-in test runs in Chromium and says why.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { ed25519 } from '@noble/curves/ed25519.js'
import { blake3 } from '@noble/hashes/blake3.js'
import { chromium, webkit } from 'playwright'
import { address, custodyKey, hex } from '../src/fc.ts'

const DIST = new URL('../wasm/dist/index.html', import.meta.url).pathname
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)))
const PHRASE = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima'
const CUSTODY = address(await custodyKey(PHRASE))
const me = { fid: 12345, username: 'tester', display_name: 'Tester', custody_address: CUSTODY, follower_count: 3, following_count: 4 }
const cast = (n, extra = {}) => ({ hash: String(n).repeat(40), text: `cast number ${n}`, timestamp: '2026-01-02T00:00:00.000Z', embeds: [], author: { fid: n, username: `user${n}`, display_name: `User ${n}` }, reactions: { likes_count: 5, recasts_count: 1 }, replies: { count: 1 }, ...extra })
const casts = [
  // mentions come as byte offsets, put back as links; links only when they're http(s)
  cast(1, { text: 'gm  see https://example.com/page and javascript:alert(1)', mentioned_profiles: [{ fid: 2, username: 'user2' }], mentioned_profiles_ranges: [{ start: 3, end: 3 }] }),
  cast(2, { text: '<img src=x onerror="window.pwned=1"> not markup' }),
]
const reply = cast(3, { text: 'a reply', parent_hash: casts[0].hash, parent_author: { fid: 1 } })
const MEMES = 'https://warpcast.com/~/channel/memes'
// a 1×1 PNG, to upload
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64')
const inMemes = cast(4, { text: 'a meme', parent_url: MEMES })
// farcaster.xyz's channel directory, as server/channels.mjs reads it
const directory = [
  { id: 'memes', url: MEMES, name: 'Memes', description: 'the memes channel', followerCount: 900, memberCount: 3 },
  { id: 'closed', url: 'https://warpcast.com/~/channel/closed', name: 'Closed', followerCount: 10, publicCasting: false },
]

// --- protobuf, as far as reading the messages back needs ---
function fields(b) {
  const out = []
  let i = 0
  const varint = () => {
    let n = 0n
    for (let s = 0n; ; s += 7n) {
      const x = b[i++]
      n |= BigInt(x & 0x7f) << s
      if (x < 0x80) return n
    }
  }
  while (i < b.length) {
    const key = Number(varint())
    if ((key & 7) === 0) out.push([key >> 3, varint()])
    else {
      const len = Number(varint())
      out.push([key >> 3, b.subarray(i, i + len)])
      i += len
    }
  }
  return out
}
const field = (b, n) => fields(b).find(([f]) => f === n)?.[1]
/** A submitted Message: its MessageData's type and body, after checking the hash and the signature. */
function opened(msg) {
  const data = field(msg, 1)
  assert.deepEqual(field(msg, 7), data, 'data_bytes is data')
  assert.equal(hex(field(msg, 2)), hex(blake3(data, { dkLen: 20 })), 'hash is blake3 of the data')
  assert.ok(ed25519.verify(field(msg, 4), field(msg, 2), field(msg, 6)), 'signed by the key it names')
  const type = Number(field(data, 1))
  const bodyField = { 1: 5, 3: 7, 4: 7, 11: 12, 16: 19, 17: 20 }[type]
  return { type, fid: Number(field(data, 2)), signer: hex(field(msg, 6)), body: field(data, bodyField) }
}

const submitted = []
// every request the node got, for a failure to show
const asked = []
const node = createServer((q, r) => {
  asked.push(`${q.method} ${q.url}`)
  r.setHeader('access-control-allow-origin', '*')
  r.setHeader('access-control-allow-headers', 'content-type')
  r.setHeader('access-control-allow-methods', 'GET, POST')
  if (q.method === 'OPTIONS') return r.end()
  r.setHeader('content-type', 'application/json')
  const u = new URL(q.url, 'http://x')
  const p = u.pathname
  const send = (v) => r.end(JSON.stringify(v))
  if (p === '/v2/all-channels') return send({ result: { channels: directory } })
  // the keys server/looks.mjs keySigned checks a signed request against: the ones the KEY_ADDs added
  if (p === '/v1/signersByFid') return send({ signers: submitted.map(opened).filter((m) => m.type === 16).map((m) => ({ key: '0x' + hex(field(m.body, 1)) })) })
  if (p === '/v2/farcaster/feed/parent_urls') return send({ casts: u.searchParams.get('parent_urls') === MEMES ? [inMemes] : [], next: { cursor: null } })
  if (p === '/v2/farcaster/reactions/cast') return send({ reactions: [{ user: { fid: 9, username: 'liker', display_name: 'Liker' } }], next: { cursor: null } })
  if (p === '/v2/farcaster/cast/quotes') return send({ casts: [cast(5, { text: 'a quote' })], next: { cursor: null } })
  if (p === '/v2/farcaster/followers' || p === '/v2/farcaster/following') return send({ users: [{ fid: 8, username: 'friend' }], next: { cursor: null } })
  if (p === '/v1/submitMessage') {
    const chunks = []
    return q.on('data', (c) => chunks.push(c)).on('end', () => (submitted.push(new Uint8Array(Buffer.concat(chunks))), send({})))
  }
  if (p === '/v2/farcaster/feed/trending' || p === '/v2/farcaster/feed/following') return send({ casts, next: { cursor: null } })
  if (p === '/v2/farcaster/cast/conversation') return send({ conversation: { cast: { ...casts.find((c) => c.hash === u.searchParams.get('identifier')), direct_replies: [reply] } } })
  if (p === '/v2/farcaster/user/custody-address') return u.searchParams.get('custody_address') === CUSTODY ? send({ user: me }) : (r.statusCode = 404, send({}))
  if (p === '/v2/farcaster/user/bulk') return send({ users: u.searchParams.get('fids').split(',').map((f) => ({ fid: +f, username: `user${f}`, viewer_context: { following: false } })) })
  if (p === '/v2/farcaster/user') return send({ user: u.searchParams.get('fid') === '12345' ? me : { fid: +u.searchParams.get('fid'), username: `user${u.searchParams.get('fid')}` } })
  if (p === '/v2/farcaster/user/by-username') {
    const name = u.searchParams.get('username')
    // with the viewer's follow in it, so the app needn't ask /v1/linkById (whose 404, "not following", the browser logs)
    if (name === 'user1') return send({ user: { ...casts[0].author, viewer_context: { following: false } } })
    if (name === 'user2') return send({ user: { fid: 2, username: 'user2' } })
    return (r.statusCode = 404), send({})
  }
  if (p === '/v2/farcaster/feed/user/casts') return send({ casts: [casts[0]], next: { cursor: null } })
  if (p === '/v1/signer' || p === '/v1/reactionsByFid') return send({ messages: [] })
  // the profile Settings edits: what the account has set so far
  if (p === '/v1/userDataByFid') return send({ messages: u.searchParams.get('fid') === '12345' ? [{ data: { userDataBody: { type: 'USER_DATA_TYPE_DISPLAY', value: 'Tester' } } }, { data: { userDataBody: { type: 'USER_DATA_TYPE_BIO', value: 'testing things' } } }] : [] })
  if (p === '/v2/farcaster/user/search') return send({ result: { users: [{ fid: 2, username: 'user2', display_name: 'User 2' }] } })
  // what server/pins.mjs asks before pinning: the cast, if this FID submitted it
  if (p === '/v1/castById') {
    const m = submitted.find((b) => '0x' + hex(field(b, 2)) === u.searchParams.get('hash'))
    return m ? send({ hash: '0x' + hex(field(m, 2)), data: { fid: opened(m).fid, castAddBody: {} } }) : ((r.statusCode = 404), send({}))
  }
  r.statusCode = 404
  send({})
})

let srv, base, nodeUrl, browser, media
before(async () => {
  assert.ok(existsSync(DIST), 'wasm/dist is missing: run sh wasm/build.sh first')
  nodeUrl = `http://127.0.0.1:${await listen(node)}`
  const port = 41000 + Math.floor(Math.random() * 9000)
  base = `http://127.0.0.1:${port}`
  srv = spawn(process.execPath, [new URL('../server/index.mjs', import.meta.url).pathname], { env: { ...process.env, PORT: String(port), WASM_HOST: '127.0.0.1', MEDIA_DIR: (media = await mkdtemp(join(tmpdir(), 'qw-media-'))), NODE_URL: nodeUrl, FARCASTER_API_URL: nodeUrl, FREE_FLOOR: '0' }, stdio: 'ignore' })
  for (let i = 0; i < 50 && !(await fetch(base + '/health').then((r) => r.ok, () => false)); i++) await new Promise((r) => setTimeout(r, 100))
  browser = await webkit.launch()
})
let other
after(async () => {
  await other?.close()
  await browser?.close()
  srv?.kill()
  node.close()
})

// spam.quilcast.com's scores (src/spam.ts), by cast hash and by FID: anything else it hasn't scored
const spamScores = {}
async function open(path = '/', b = browser) {
  const page = await b.newPage()
  await page.route('https://spam.quilcast.com/**', (route) => {
    const u = new URL(route.request().url())
    const keys = (u.searchParams.get('h') || u.searchParams.get('fid') || '').split(',')
    const body = Object.fromEntries(keys.filter((k) => k in spamScores).map((k) => [k, spamScores[k]]))
    route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) })
  })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  page.on('dialog', (d) => d.accept())
  await page.addInitScript((node) => localStorage.getItem('quilcast-wasm:settings') || localStorage.setItem('quilcast-wasm:settings', JSON.stringify({ node, theme: 'system' })), nodeUrl)
  await page.goto(base + path)
  return { page, errors }
}

test('reads: the feed, cast text as text, threads and profiles', async () => {
  const { page, errors } = await open('/')
  await page.waitForSelector('article.cast')
  assert.equal(await page.locator('article.cast').count(), 2)
  // tapping the page you're on reads it again without a second history entry for Back to land on
  const entries = await page.evaluate(() => history.length)
  await page.locator('nav[aria-label=Main] a[href="/"]').first().click()
  await page.waitForSelector('article.cast')
  assert.equal(await page.evaluate(() => history.length), entries)
  // the mention goes back in at its byte offset, as a link to the profile
  assert.equal(await page.locator('article.cast .text').first().innerText(), 'gm @user2 see example.com/page and javascript:alert(1)')
  assert.equal(await page.locator('article.cast .text a.mention').first().getAttribute('href'), '/u/user2')
  const out = page.locator('article.cast .text a[target=_blank]').first()
  assert.equal(await out.getAttribute('href'), 'https://example.com/page')
  assert.match(await out.getAttribute('rel'), /noopener/)
  assert.equal(await page.locator('article.cast .text a').count(), 2, 'javascript: is not a link')
  // a cast's text is never markup
  assert.equal(await page.locator('article.cast .text img').count(), 0)
  assert.equal(await page.evaluate(() => window.pwned), undefined)
  assert.match(await page.locator('article.cast .text').nth(1).innerText(), /^<img src=x/)
  // a tap on the card opens its thread, in place
  await page.locator('article.cast .text').first().click()
  await page.waitForSelector('article.cast.big')
  assert.match(page.url(), new RegExp(`/c/${casts[0].hash}$`))
  assert.equal(await page.locator('.replies article.cast .text').innerText(), 'a reply')
  await page.goBack()
  await page.waitForSelector('article.cast:not(.big)')
  // profiles by name
  await page.goto(base + '/u/user1')
  await page.waitForSelector('.profile h2')
  assert.equal(await page.locator('.profile h2').innerText(), 'User 1')
  assert.deepEqual(errors, [])
  await page.close()
})

test('spam: labelled from the threshold, hidden once Settings says so', async () => {
  spamScores['0x' + casts[1].hash] = 0.97
  spamScores['1'] = 0.92
  try {
    const { page, errors } = await open('/')
    await page.waitForSelector('article.cast .spam-tag')
    const tags = await page.locator('article.cast .spam-tag').allInnerTexts()
    assert.deepEqual(tags, ['Spam account 92%', 'Spam 97%'])
    // Settings → Spam: Hide takes the spam cast out; hiding spam accounts takes the account's casts out too
    await page.goto(base + '/settings')
    await page.click('[aria-label="Spam casts"] >> text=Hide')
    await page.goto(base + '/')
    await page.waitForSelector('article.cast')
    assert.deepEqual(await page.locator('article.cast .text').allInnerTexts().then((t) => t.map((x) => x.slice(0, 2))), ['gm'])
    await page.goto(base + '/settings')
    await page.click('[aria-label="Spam accounts"] >> text=Hide')
    await page.goto(base + '/')
    // every cast on the page is hidden: the feed is there, with nothing in it
    await page.waitForSelector('main .feed', { state: 'attached' })
    await page.waitForTimeout(1800)
    assert.equal(await page.locator('article.cast').count(), 0)
    // and a threshold over both scores brings them back, labels gone
    await page.goto(base + '/settings')
    await page.locator('input[type=range]').fill('99')
    await page.goto(base + '/')
    await page.waitForSelector('article.cast')
    assert.equal(await page.locator('article.cast').count(), 2)
    assert.equal(await page.locator('.spam-tag').count(), 0)
    assert.deepEqual(errors, [])
    await page.close()
  } finally {
    for (const k of Object.keys(spamScores)) delete spamScores[k]
  }
})

/** The error that stops this browser keeping a CryptoKey in IndexedDB, if one does. */
async function keyless(b) {
  const page = await b.newPage()
  await page.goto(base + '/health')
  const why = await page.evaluate(() =>
    crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt']).then((k) => new Promise((ok) => {
      const r = indexedDB.open('probe', 1)
      r.onupgradeneeded = () => r.result.createObjectStore('v')
      r.onerror = () => ok(String(r.error))
      r.onsuccess = () => {
        try {
          const t = r.result.transaction('v', 'readwrite')
          t.objectStore('v').put(k, 'k')
          t.oncomplete = () => ok('')
          t.onerror = t.onabort = () => ok(String(t.error))
        } catch (e) {
          ok(String(e))
        }
      }
    })))
  await page.close()
  return why
}

test('signs in with a recovery phrase, then casts, likes and signs out with valid signed messages', async (t) => {
  submitted.length = 0
  const why = await keyless(browser)
  if (why) {
    t.diagnostic(`WebKit here can't keep a key (${why}): signing in in Chromium`)
    other = await chromium.launch()
  }
  // a context of its own, so a second tab shares its storage
  const ctx = await (other || browser).newContext()
  const { page, errors } = await open('/join', ctx)
  await page.fill('textarea', PHRASE.toUpperCase())
  asked.length = 0
  await page.click('button[type=submit]')
  // done, or what stopped it
  await page.waitForSelector('text=Signed in', { timeout: 30000 }).catch(async (e) => {
    const shown = await page.locator('main').innerText().catch(() => '?')
    throw new Error(`${e.message}\npage: ${shown.slice(0, 400)}\nnode was asked: ${asked.join(', ')}\nerrors: ${errors.join(' | ')}`)
  })
  assert.equal(await page.locator('textarea').count(), 0)
  // one KEY_ADD for FID 12345, signed by the new key it adds
  const [keyAdd] = submitted.map(opened)
  assert.equal(keyAdd.type, 16)
  assert.equal(keyAdd.fid, 12345)
  assert.equal(hex(field(keyAdd.body, 1)), keyAdd.signer)
  // the phrase isn't kept anywhere the page can read
  const kept = await page.evaluate(() => JSON.stringify(localStorage))
  assert.doesNotMatch(kept, /alpha|bravo/i)
  assert.match(kept, new RegExp(keyAdd.signer))

  // a cast, with a mention resolved to its FID at its byte position
  await page.click('nav.side .cast-btn')
  await page.fill('.dialog textarea', 'gm @user2!')
  await page.press('.dialog textarea', 'Meta+Enter')
  await page.waitForSelector('text=Posted')
  const c = opened(submitted[1])
  assert.equal(c.type, 1)
  assert.equal(c.signer, keyAdd.signer)
  assert.equal(new TextDecoder().decode(field(c.body, 4)), 'gm !')
  assert.deepEqual([...field(c.body, 2)], [2], 'mentions')
  assert.deepEqual([...field(c.body, 5)], [3], 'positions')

  // a like goes out at once and shows
  const like = page.locator('article.cast').first().locator('button.like')
  await like.click()
  await page.waitForFunction(() => document.querySelector('article.cast button.like')?.getAttribute('aria-pressed') === 'true')
  for (let i = 0; i < 50 && submitted.length < 3; i++) await page.waitForTimeout(100)
  const l = opened(submitted[2])
  assert.equal(l.type, 3)

  // a cast into a channel goes under the channel's parent URL
  await page.goto(base + '/channel/memes')
  await page.click('text=Cast here')
  await page.fill('.dialog textarea', 'into memes')
  await page.click('.dialog-foot button.primary')
  await page.waitForSelector('text=Posted')
  const inChannel = opened(submitted.at(-1))
  assert.equal(inChannel.type, 1)
  assert.equal(new TextDecoder().decode(field(inChannel.body, 7)), MEMES)

  // the cast just posted is pinned to the profile (the server checks with the node that it's this account's own)
  await page.locator('article.cast').first().locator('button[aria-label=More]').click()
  await page.click('.dialog >> text=Pin to profile')
  await page.waitForSelector('text=Pinned to your profile')
  assert.equal(JSON.parse(await readFile(join(media, 'pins', '12345.json'), 'utf8')).hash, '0x' + hex(field(submitted.at(-1), 2)))

  // an @name being typed offers people; a picture goes up through Quilcast's server and becomes the cast's embed
  await page.click('nav.side .cast-btn')
  await page.locator('.dialog textarea').pressSequentially('hi @us')
  await page.click('.suggest >> text=@user2')
  assert.equal(await page.inputValue('.dialog textarea'), 'hi @user2 ')
  await page.setInputFiles('.dialog input[type=file]', { name: 'dot.png', mimeType: 'image/png', buffer: PNG })
  await page.waitForSelector('.attach img')
  await page.waitForFunction(() => document.querySelector('.attach') && !document.querySelector('.attach-state'), null, { timeout: 20000 }).catch(async (e) => {
    throw new Error(`${e.message}: ${await page.locator('.attach').innerText().catch(() => '?')} ${errors.join(' | ')}`)
  })
  await page.click('.dialog-foot button.primary')
  await page.waitForSelector('text=Posted')
  const pic = opened(submitted.at(-1))
  const url = new TextDecoder().decode(field(field(pic.body, 6), 1))
  // photos are drawn again by the browser (no EXIF), as a JPEG when nothing is see-through
  assert.match(url, /\/m\/[0-9a-f]{24}\.jpg$/)
  assert.ok((await readdir(join(media))).includes(url.split('/').pop()), 'kept on the server')
  assert.deepEqual([...field(pic.body, 2)], [2], 'the picked name is a mention')

  // a thread written post by post: each goes out as a reply to the one before; an emoji goes where the caret is
  await page.click('nav.side .cast-btn')
  await page.fill('.dialog .part textarea', 'first post')
  await page.click('.dialog button[aria-label="Add another post to the thread"]')
  await page.waitForFunction(() => document.querySelectorAll('.dialog .part textarea').length === 2 && document.activeElement === document.querySelectorAll('.dialog .part textarea')[1])
  await page.locator('.dialog .part textarea').nth(1).pressSequentially('second post')
  await page.locator('.dialog .part textarea').nth(1).press('ArrowLeft')
  await page.click('.dialog button[aria-label="Add an emoji"]')
  await page.fill('.dialog input[aria-label="Search emoji"]', 'thumbs up')
  await page.click('.dialog .emoji-opt[aria-label="thumbs up"]')
  await page.waitForFunction(() => document.querySelectorAll('.dialog .part textarea')[1]?.value === 'second pos👍t').catch(async (e) => {
    throw new Error(`${e.message}: ${await page.locator('.dialog .part textarea').nth(1).inputValue().catch(() => '?')}`)
  })
  assert.equal(await page.evaluate(() => document.activeElement.selectionStart), 12, 'the caret comes back after it')
  // an empty third post is left out, and Backspace in it takes it away
  await page.click('.dialog button[aria-label="Add another post to the thread"]')
  await page.locator('.dialog .part textarea').nth(2).press('Backspace')
  await page.waitForFunction(() => document.querySelectorAll('.dialog .part textarea').length === 2)
  // the sticker picker: this account has no packs yet
  await page.click('.dialog button[aria-label="Add a sticker"]')
  await page.waitForSelector('.dialog .stk-empty')
  await page.click('.dialog .stickers >> text=Back')
  await page.click('.dialog-foot button.primary:has-text("Post all")')
  await page.waitForSelector('text=Thread posted')
  const [one, two] = submitted.slice(-2).map(opened)
  assert.equal(new TextDecoder().decode(field(one.body, 4)), 'first post')
  assert.equal(new TextDecoder().decode(field(two.body, 4)), 'second pos👍t')
  assert.equal(hex(field(field(two.body, 3), 2)), hex(field(submitted.at(-2), 2)), 'the second replies to the first')

  // closing a cast offers to keep it as a draft, sealed in the browser: the server only ever has ciphertext
  await page.click('nav.side .cast-btn')
  await page.fill('.dialog textarea', 'a draft to keep')
  await page.click('.dialog button[aria-label=Close]')
  await page.click('.draft-ask >> text=Save draft')
  await page.waitForSelector('text=Draft saved')
  const drafts = join(media, 'drafts', '12345')
  const [sealed] = await readdir(drafts)
  const box = await readFile(join(drafts, sealed), 'utf8')
  assert.match(box, /^[\w+/=]+\.[\w+/=]+$/)
  assert.doesNotMatch(box, /draft to keep/)
  await page.click('nav.side .cast-btn')
  await page.click('.dialog .head-links >> text=Drafts')
  await page.click('.draft-open >> text=a draft to keep')
  assert.equal(await page.inputValue('.dialog textarea'), 'a draft to keep')
  await page.click('.dialog button[aria-label=Close]')

  // a scheduled cast is signed now for its time and handed to the server, listed, and cancelled
  await page.click('nav.side .cast-btn')
  await page.fill('.dialog textarea', 'see you later')
  await page.click('.dialog button[aria-label=Schedule]')
  const when = await page.evaluate(() => {
    const d = new Date(Date.now() + 2 * 3600e3)
    const two = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`
  })
  await page.fill('.timing input', when)
  await page.click('.dialog-foot button.primary')
  await page.waitForSelector('text=Scheduled for')
  const waiting = join(media, 'scheduled', '12345')
  const [item] = (await readdir(waiting)).filter((f) => f.endsWith('.json'))
  const sched = JSON.parse(await readFile(join(waiting, item), 'utf8'))
  assert.deepEqual([sched.status, sched.text, sched.msgs.length], ['scheduled', 'see you later', 1])
  assert.ok(Math.abs(sched.at - (Date.now() + 2 * 3600e3)) < 120e3, 'for the time picked')
  await page.click('nav.side .cast-btn')
  await page.click('.dialog .head-links >> text=Scheduled')
  await page.click('.draft:has-text("see you later") >> text=Cancel')
  await page.waitForSelector('text=Cancelled')
  assert.deepEqual((await readdir(waiting)).filter((f) => f.endsWith('.json')), [])
  await page.keyboard.press('Escape')

  // one that failed can't be replaced on the server, so Edit schedules it again as a new one and takes the failed one off
  for (let i = 0; i < 3 && (await page.locator('.dialog').count()); i++) await page.click('.dialog button[aria-label=Close]')
  await page.click('nav.side .cast-btn')
  await page.fill('.dialog textarea', 'try me again')
  await page.click('.dialog button[aria-label=Schedule]')
  await page.fill('.timing input', when)
  await page.click('.dialog-foot button.primary')
  let failedFile
  for (let i = 0; i < 50 && !failedFile; i++) [failedFile] = await page.waitForTimeout(100).then(() => readdir(waiting)).then((l) => l.filter((f) => f.endsWith('.json')))
  assert.ok(failedFile, 'scheduled')
  const failed = JSON.parse(await readFile(join(waiting, failedFile), 'utf8'))
  await writeFile(join(waiting, failedFile), JSON.stringify({ ...failed, at: Date.now() - 3600e3, status: 'failed', done: Date.now(), error: 'node down' }))
  await page.click('nav.side .cast-btn')
  await page.click('.dialog .head-links >> text=Scheduled')
  await page.click('.draft.failed:has-text("try me again") >> text=Edit')
  await page.waitForSelector('.dialog textarea')
  assert.equal(await page.inputValue('.dialog textarea'), 'try me again')
  assert.equal(await page.inputValue('.timing input'), '', 'a failed one\'s time has passed')
  await page.fill('.timing input', when)
  await page.click('.dialog-foot button.primary')
  await page.waitForSelector('text=Scheduled for')
  let again
  for (let i = 0; i < 50; i++) {
    again = (await readdir(waiting)).filter((f) => f.endsWith('.json'))
    if (again.length === 1 && again[0] !== failedFile) break
    await page.waitForTimeout(100)
  }
  assert.equal(again.length, 1, 'the failed one is taken off')
  assert.notEqual(again[0], failedFile, 'scheduled under a new id')
  const redone = JSON.parse(await readFile(join(waiting, again[0]), 'utf8'))
  assert.deepEqual([redone.status, redone.text], ['scheduled', 'try me again'])
  assert.equal(await page.locator('text=already sent').count(), 0)
  await page.click('nav.side .cast-btn')
  await page.click('.dialog .head-links >> text=Scheduled')
  await page.click('.draft:has-text("try me again") >> text=Cancel')
  await page.waitForSelector('text=Cancelled')
  await page.keyboard.press('Escape')

  // muting someone is kept on Quilcast's server with the account, signed by this browser's key
  await page.goto(base + '/u/user1')
  await page.click('button[aria-label="Profile menu"]')
  await page.click('.dialog >> text=Mute @user1')
  await page.click('.dialog >> text=For good')
  await page.waitForSelector('text=Muted @user1')
  let muted
  for (let i = 0; i < 50 && !muted; i++) muted = await readFile(join(media, 'mutes', '12345.json'), 'utf8').then(JSON.parse, () => page.waitForTimeout(100).then(() => null))
  assert.deepEqual(muted?.users, [{ v: 1 }])
  assert.equal(await page.locator('text=not on Quilcast\'s server').count(), 0)

  // Settings lists the accounts signed in here, with a way to add another
  await page.goto(base + '/settings')
  await page.waitForSelector('.accounts .acct.on >> text=@tester')
  assert.equal(await page.locator('.accounts .acct.on >> text=In use').count(), 1)
  // another tab signs in a second account: this one lists it at once, without reloading
  const tab = await ctx.newPage()
  await tab.goto(base + '/health')
  await tab.evaluate(() => {
    const list = JSON.parse(localStorage.getItem('quilcast-wasm:accounts'))
    localStorage.setItem('quilcast-wasm:accounts', JSON.stringify([...list, { ...list[0], fid: 777, username: 'other', pub: 'ab'.repeat(32) }]))
  })
  await page.waitForSelector('.accounts .acct >> text=@other')
  assert.equal(await page.locator('.accounts .acct.on >> text=@tester').count(), 1)
  await page.click('text=Add account')
  await page.waitForSelector('h1:has-text("Add account")')
  assert.equal(await page.locator('textarea#phrase').count(), 1)

  // the profile: what the node has, and a new name and bio sent as USER_DATA_ADDs signed by this browser's key
  await page.goto(base + '/settings')
  await page.waitForFunction(() => document.querySelector('#edit-name')?.value === 'Tester')
  assert.equal(await page.inputValue('#edit-bio'), 'testing things')
  const before = submitted.length
  await page.fill('#edit-name', 'Tester Two')
  await page.fill('#edit-url', 'https://tester.example')
  await page.click('text=Save changes')
  await page.waitForSelector('text=Profile saved')
  const data = submitted.slice(before).map(opened)
  assert.deepEqual(data.map((m) => [m.type, m.fid, m.signer]), [[11, 12345, keyAdd.signer], [11, 12345, keyAdd.signer]])
  assert.deepEqual(data.map((m) => [Number(field(m.body, 1)), new TextDecoder().decode(field(m.body, 2))]), [[2, 'Tester Two'], [5, 'https://tester.example']])
  assert.equal(await page.locator('text=Save changes').count(), 0)
  // saving the profile wrote the list back with the other tab's account still in it; then that tab signs it out
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('quilcast-wasm:accounts')).map((a) => a.fid))
  assert.deepEqual(await stored(), [12345, 777])
  await tab.evaluate(() => localStorage.setItem('quilcast-wasm:accounts', JSON.stringify(JSON.parse(localStorage.getItem('quilcast-wasm:accounts')).filter((a) => a.fid !== 777))))
  await page.waitForSelector('.accounts .acct >> text=@other', { state: 'detached' })
  await tab.close()

  // signing out revokes the key with a KEY_REMOVE it signs itself
  await page.click('text=Sign out')
  await page.waitForSelector('text=Signed out')
  const out = opened(submitted.at(-1))
  assert.equal(out.type, 17)
  assert.equal(hex(field(out.body, 1)), keyAdd.signer)
  assert.equal(await page.evaluate(() => localStorage.getItem('quilcast-wasm:account')), null)
  assert.deepEqual(errors, [])
  await ctx.close()
})

test('channels, who liked and quoted, followers, Browse as, following on this device, mutes and reports', async () => {
  const { page, errors } = await open('/channels')
  // the directory, then a channel's page with the casts under its URL
  await page.waitForSelector('a.person[href="/channel/memes"]')
  assert.equal(await page.locator('a.person').count(), 2)
  await page.click('a.person[href="/channel/memes"]')
  await page.waitForSelector('article.cast')
  assert.equal(await page.locator('.profile h2').innerText(), 'Memes')
  assert.equal(await page.locator('article.cast .text').innerText(), 'a meme')
  assert.equal(await page.locator('article.cast .chan-tag').innerText(), '/memes')
  // a members-only channel says so
  await page.goto(base + '/channel/closed')
  await page.waitForSelector('text=Members only')

  // who liked, recast and quoted a cast; whom someone follows
  await page.goto(base + `/c/${casts[0].hash}`)
  await page.click('.stats a[href$="/likes"]')
  await page.waitForSelector('a.person[href="/u/liker"]')
  await page.click('a.tab[href$="/quotes"]')
  await page.waitForSelector('article.cast >> text=a quote')
  await page.goto(base + '/u/user1')
  await page.click('.counts a[href="/u/user1/followers"]')
  await page.waitForSelector('a.person[href="/u/friend"]')

  // Browse as: Home on someone's Following feed, offered again on the signed-out Home
  await page.goto(base + '/u/user1')
  await page.click('button[aria-label="Profile menu"]')
  asked.length = 0
  await page.click('.dialog >> text=Browse as @user1')
  await page.waitForSelector('.banner')
  assert.match(page.url(), /\/\?as=user1$/)
  await page.waitForSelector('article.cast')
  assert.ok(asked.some((a) => a.startsWith('GET /v2/farcaster/feed/following?') && a.includes('fid=1')), asked.join(', '))
  await page.click('.banner >> text=Exit')
  await page.waitForSelector('.recents a.chip[href="/?as=user1"]')

  // following someone without an account keeps them on this device, and Home's Following tab shows their casts
  await page.goto(base + '/u/user1')
  await page.click('.profile button:has-text("Follow")')
  await page.waitForSelector('text=on this device only')
  assert.deepEqual(JSON.parse(await page.evaluate(() => localStorage.getItem('quilcast-wasm:local-follows'))), [{ fid: 1, username: 'user1' }])
  asked.length = 0
  await page.goto(base + '/')
  await page.waitForSelector('a.tab.on >> text=Following')
  await page.waitForSelector('article.cast')
  assert.equal(await page.locator('article.cast').count(), 1)
  assert.ok(asked.some((a) => a.startsWith('GET /v2/farcaster/feed/user/casts?') && a.includes('fid=1')), asked.join(', '))

  // muting someone signed out hides their casts, kept in this browser
  await page.goto(base + '/?feed=trending')
  await page.waitForSelector('article.cast')
  assert.equal(await page.locator('article.cast').count(), 2)
  await page.locator('article.cast').nth(1).locator('button[aria-label=More]').click()
  await page.click('.dialog >> text=Mute @user2')
  await page.click('.dialog >> text=For a day')
  await page.waitForFunction(() => document.querySelectorAll('article.cast').length === 1)
  assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem('quilcast-wasm:mutes:local'))).users[0].v, 2)
  // and Settings lifts it
  await page.goto(base + '/settings')
  await page.click('button:has-text("Unmute")')
  await page.waitForSelector('text=Unmuted @')

  // a report reaches Quilcast's server (anonymous, signed out)
  await page.goto(base + '/?feed=trending')
  await page.locator('article.cast').first().locator('button[aria-label=More]').click()
  await page.click('.dialog >> text=Report this cast')
  await page.click('.dialog label:has-text("Harassment")')
  await page.fill('.dialog textarea', 'testing')
  await page.click('.dialog >> text=Send report')
  await page.waitForSelector('text=The report was sent')
  const reports = (await readFile(join(media, 'reports.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual([reports.at(-1).fid, reports.at(-1).hash, reports.at(-1).reason, reports.at(-1).text, reports.at(-1).by], [1, '0x' + casts[0].hash, 'abuse', 'testing', null])
  assert.deepEqual(errors, [])
  await page.close()
})

test('push notifications: Settings signs each account up with its own key, and a tapped one opens as its account', async () => {
  // Chromium has push and WebCrypto's Ed25519 everywhere; the push service and the permission prompt are stood in for
  const b = await chromium.launch()
  try {
    const page = await b.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.addInitScript(() => {
      const granted = () => localStorage.getItem('e2e:perm') === 'granted'
      Object.defineProperty(Notification, 'permission', { get: () => (granted() ? 'granted' : 'default') })
      Notification.requestPermission = async () => (localStorage.setItem('e2e:perm', 'granted'), 'granted')
      const fake = { endpoint: 'https://push.test/sub1', toJSON: () => ({ endpoint: 'https://push.test/sub1', expirationTime: null, keys: { p256dh: 'BPk', auth: 'au' } }) }
      PushManager.prototype.getSubscription = async () => (localStorage.getItem('e2e:sub') ? fake : null)
      PushManager.prototype.subscribe = async function (o) {
        if (!(o.applicationServerKey instanceof Uint8Array) || !o.applicationServerKey.length) throw new Error('no VAPID key')
        localStorage.setItem('e2e:sub', '1')
        return fake
      }
    })
    const alerts = []
    await page.route('**/api/notify/vapid', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ key: 'BAECAwQ' }) }))
    await page.route('**/api/alerts/**', (r) => {
      const q = r.request()
      alerts.push({ method: q.method(), path: new URL(q.url()).pathname, headers: q.headers(), body: q.postData() || '' })
      r.fulfill({ contentType: 'application/json', body: q.url().endsWith('/state') ? 'null' : '{}' })
    })
    // two accounts signed in here, each with a non-extractable key in the vault as the app keeps them
    await page.goto(base + '/manifest.webmanifest')
    const keys = await page.evaluate(async () => {
      const db = await new Promise((ok, no) => {
        const r = indexedDB.open('quilcast-wasm', 1)
        r.onupgradeneeded = () => r.result.createObjectStore('v')
        r.onsuccess = () => ok(r.result)
        r.onerror = () => no(r.error)
      })
      const hex = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('')
      const out = []
      for (let i = 0; i < 2; i++) {
        const k = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])
        const pub = hex(await crypto.subtle.exportKey('raw', k.publicKey))
        await new Promise((ok, no) => {
          const t = db.transaction('v', 'readwrite')
          t.objectStore('v').put(k, 'ed:' + pub)
          t.oncomplete = ok
          t.onerror = () => no(t.error)
        })
        out.push(pub)
      }
      return out
    })
    const accts = [{ fid: 12345, username: 'tester', pub: keys[0] }, { fid: 777, username: 'second', pub: keys[1] }]
    await page.evaluate(([n, a]) => {
      localStorage.setItem('quilcast-wasm:settings', JSON.stringify({ node: n, theme: 'system' }))
      localStorage.setItem('quilcast-wasm:accounts', JSON.stringify(a))
      localStorage.setItem('quilcast-wasm:account', JSON.stringify(a[0]))
    }, [nodeUrl, accts])

    await page.goto(base + '/settings')
    const on = page.getByRole('button', { name: 'Turn on push notifications for @second' })
    await on.click()
    await page.waitForSelector('text=Notifications on')
    // @second's sign-up, signed by @second's key over quilcast-alerts:<fid>:<ts>:<body>, while @tester stays in use
    const up = alerts.find((a) => a.method === 'PUT')
    assert.equal(up.path, '/api/alerts/777')
    assert.equal(up.headers['x-key'], '0x' + keys[1])
    const sig = Uint8Array.from(Buffer.from(up.headers['x-sig'], 'hex'))
    assert.ok(ed25519.verify(sig, new TextEncoder().encode(`quilcast-alerts:777:${up.headers['x-ts']}:${up.body}`), Uint8Array.from(Buffer.from(keys[1], 'hex'))))
    const body = JSON.parse(up.body)
    assert.equal(body.subscription.endpoint, 'https://push.test/sub1')
    assert.deepEqual(body.kinds, ['replies', 'mentions', 'quotes', 'likes', 'recasts', 'follows'])
    // the service worker that shows them is quilcast.com's, served here too
    assert.equal(await page.evaluate(() => navigator.serviceWorker.getRegistration('/sw.js').then((r) => r?.active?.scriptURL || r?.installing?.scriptURL || r?.waiting?.scriptURL)), base + '/sw.js')
    // a kind unticked is sent again with the rest
    await page.getByRole('group', { name: 'Kinds for @second' }).getByLabel('Likes').uncheck()
    await page.waitForFunction(() => document.querySelectorAll('[aria-label="Kinds for @second"] input:checked').length === 5)
    assert.deepEqual(JSON.parse(alerts.filter((a) => a.method === 'PUT').at(-1).body).kinds, ['replies', 'mentions', 'quotes', 'recasts', 'follows'])

    // a tapped notification: the worker asks whether the app is here, then has it open the page as its account
    const answered = await page.evaluate(() => new Promise((ok) => {
      const ch = new MessageChannel()
      ch.port1.onmessage = () => ok(true)
      navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { probe: true, until: Date.now() + 400 }, ports: [ch.port2] }))
      setTimeout(() => ok(false), 1000)
    }))
    assert.ok(answered)
    await page.evaluate(() => navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { open: '/u/user1', fid: 777 } })))
    await page.waitForSelector('text=Using @second')
    assert.equal(new URL(page.url()).pathname, '/u/user1')
    assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem('quilcast-wasm:account'))).fid, 777)
    // a new window it opened starts as the account in ?as-fid=, which leaves the address
    await page.goto(base + '/u/user1?as-fid=12345')
    await page.waitForSelector('.profile h2')
    assert.equal(new URL(page.url()).search, '')
    assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem('quilcast-wasm:account'))).fid, 12345)

    // turning off tells the server, unsigned: the endpoint is this browser's secret
    await page.goto(base + '/settings')
    await page.getByRole('button', { name: 'Turn off push notifications for @second' }).click()
    await page.waitForSelector('text=Notifications off')
    await page.waitForFunction(() => !JSON.parse(localStorage.getItem('quilcast-wasm:alerts')).off.length)
    const off = alerts.find((a) => a.path === '/api/alerts/777/off')
    assert.deepEqual(JSON.parse(off.body), { endpoint: 'https://push.test/sub1' })
    assert.equal(off.headers['x-sig'], undefined)
    assert.deepEqual(errors, [])
  } finally {
    await b.close()
  }
})
