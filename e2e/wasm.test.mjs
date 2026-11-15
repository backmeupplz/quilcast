// Quilcast WASM (wasm/) in WebKit, Safari's engine, served the way wasm.quilcast.com serves it, against a stand-in
// Hypersnap node: it reads and draws feeds, threads and profiles, signs in with a recovery phrase, and every message
// it submits is a valid Farcaster message signed by the key it added (made by WebCrypto, never seen by the page).
// Needs both builds and WebKit for Playwright: npm run build && sh wasm/build.sh && npx playwright install webkit chromium
// WebKit keeps a CryptoKey in IndexedDB wrapped under a master key from the user's keychain, which a CI runner (a
// launchd daemon with no login keychain) can't reach: there, the sign-in test runs in Chromium and says why.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
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
  const bodyField = { 1: 5, 3: 7, 4: 7, 16: 19, 17: 20 }[type]
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
  if (p === '/v1/submitMessage') {
    const chunks = []
    return q.on('data', (c) => chunks.push(c)).on('end', () => (submitted.push(new Uint8Array(Buffer.concat(chunks))), send({})))
  }
  if (p === '/v2/farcaster/feed/trending' || p === '/v2/farcaster/feed/following') return send({ casts, next: { cursor: null } })
  if (p === '/v2/farcaster/cast/conversation') return send({ conversation: { cast: { ...casts.find((c) => c.hash === u.searchParams.get('identifier')), direct_replies: [reply] } } })
  if (p === '/v2/farcaster/user/custody-address') return u.searchParams.get('custody_address') === CUSTODY ? send({ user: me }) : (r.statusCode = 404, send({}))
  if (p === '/v2/farcaster/user' && u.searchParams.get('fid') === '12345') return send({ user: me })
  if (p === '/v2/farcaster/user/by-username') {
    const name = u.searchParams.get('username')
    if (name === 'user1') return send({ user: casts[0].author })
    if (name === 'user2') return send({ user: { fid: 2, username: 'user2' } })
    return (r.statusCode = 404), send({})
  }
  if (p === '/v2/farcaster/feed/user/casts') return send({ casts: [casts[0]], next: { cursor: null } })
  if (p === '/v1/signer' || p === '/v1/reactionsByFid') return send({ messages: [] })
  r.statusCode = 404
  send({})
})

let srv, base, nodeUrl, browser
before(async () => {
  assert.ok(existsSync(DIST), 'wasm/dist is missing: run sh wasm/build.sh first')
  nodeUrl = `http://127.0.0.1:${await listen(node)}`
  const port = 41000 + Math.floor(Math.random() * 9000)
  base = `http://127.0.0.1:${port}`
  srv = spawn(process.execPath, [new URL('../server/index.mjs', import.meta.url).pathname], { env: { ...process.env, PORT: String(port), WASM_HOST: '127.0.0.1', MEDIA_DIR: await mkdtemp(join(tmpdir(), 'qw-media-')), NODE_URL: nodeUrl }, stdio: 'ignore' })
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

async function open(path = '/', b = browser) {
  const page = await b.newPage()
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
  const { page, errors } = await open('/join', other || browser)
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

  // signing out revokes the key with a KEY_REMOVE it signs itself
  await page.goto(base + '/settings')
  await page.click('text=Sign out')
  await page.waitForSelector('text=Signed out')
  const out = opened(submitted.at(-1))
  assert.equal(out.type, 17)
  assert.equal(hex(field(out.body, 1)), keyAdd.signer)
  assert.equal(await page.evaluate(() => localStorage.getItem('quilcast-wasm:account')), null)
  assert.deepEqual(errors, [])
  await page.close()
})
