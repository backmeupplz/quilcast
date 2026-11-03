// The app in WebKit, Safari's engine, starting on the home page the server draws (#273). Over a slow line the page's
// body arrives well after its head, and the head's script must not start the app before there's a #app to draw in:
// a browser with its own account hides the server's page, so that left Safari with a blank, dark page.
// Needs a build (dist/) and WebKit for Playwright: npm run build && npx playwright install webkit && npm run test:e2e
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { webkit } from 'playwright'

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)))
const cast = (n, extra = {}) => ({ hash: '0x' + String(n).repeat(40), text: `cast number ${n}`, timestamp: '2026-01-02T00:00:00Z', embeds: [], author: { fid: n, username: `user${n}` }, reactions: { likes_count: 5, recasts_count: 0 }, replies: { count: 0 }, ...extra })
// a stand-in Hypersnap node: the trending feed the home page is drawn from; its first cast's pictures make the first one the
// page's lead (index.html waits for it before loading the app)
// page; the app asks it too when its settings point at it (the phone tests), for Following and Trending: one cast in a
// channel with a long name, a long link and big counts, the widest a card gets
const busy = cast(4, { text: 'see https://example.com/a/very/long/path/that/keeps/going/and/going?with=query&and=more on /base', parent_url: 'https://farcaster.xyz/~/channel/a-channel-with-a-rather-long-name', reactions: { likes_count: 12345, recasts_count: 6789 }, replies: { count: 4321 } })
const node = createServer((q, r) => {
  r.setHeader('content-type', 'application/json')
  r.setHeader('access-control-allow-origin', '*')
  if (q.url.startsWith('/v2/farcaster/feed/trending')) return r.end(JSON.stringify({ casts: [cast(1, { embeds: [{ url: 'https://imagedelivery.net/abc/one/original' }, { url: 'https://imagedelivery.net/abc/two/original' }] }), cast(2), cast(3), busy] }))
  if (q.url.startsWith('/v2/farcaster/feed/following')) return r.end(JSON.stringify({ casts: [busy, cast(2)] }))
  r.end('{}')
})
const nodePort = await listen(node)
const spare = createServer()
const port = await listen(spare)
spare.close()
// home page bodies held back until their test lets them through, by the page's ?held= number (open's `held`)
const gates = new Map()
// between the browser and the server: the home page's head at once, its body when its test lets it through (?held=) or
// right after; the page's first picture (through the server's /i/, which would ask Farcaster's CDN for it) never comes
// (but see open's `held`)
const proxy = createServer((q, r) => {
  const url = new URL(q.url, 'http://x')
  if (url.pathname.startsWith('/i/')) return
  const up = request({ host: '127.0.0.1', port, path: q.url, method: q.method, headers: { ...q.headers, host: `127.0.0.1:${port}`, 'accept-encoding': 'identity' } }, async (u) => {
    const h = { ...u.headers }
    delete h['content-length']
    r.writeHead(u.statusCode, h)
    if (url.pathname !== '/' || !String(u.headers['content-type']).includes('html')) return u.pipe(r)
    let s = ''
    for await (const c of u) s += c
    const i = s.indexOf('</head>') + 7
    r.write(s.slice(0, i))
    await gates.get(url.searchParams.get('held'))?.promise
    r.end(s.slice(i))
  })
  // a page closed mid-request, or the server stopped at the end
  up.on('error', () => r.destroy())
  q.pipe(up)
})
const proxyPort = await listen(proxy)
let srv, browser
before(async () => {
  srv = spawn(process.execPath, [new URL('../server/index.mjs', import.meta.url).pathname], { env: { ...process.env, PORT: String(port), NODE_URL: `http://127.0.0.1:${nodePort}`, FC_URL: `http://127.0.0.1:${nodePort}`, MEDIA_DIR: await mkdtemp(join(tmpdir(), 'qc-')), SITE_URL: 'https://quilcast.test', QUORUM_URL: `http://127.0.0.1:${nodePort}` }, stdio: 'ignore' })
  // the server draws the home page in the background: wait until it serves it
  for (let i = 0; ; i++) {
    const page = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text(), () => '')
    if (page.includes('id="app-js"')) break
    assert.ok(i < 100, 'the server never drew the home page')
    await new Promise((ok) => setTimeout(ok, 100))
  }
  browser = await webkit.launch()
})
after(async () => (await browser?.close(), proxy.closeAllConnections(), proxy.close(), srv.kill(), node.close()))

// a 1×1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
/**
 * Open the home page through the slow line, with `storage` in localStorage; its errors are collected. `edit` changes
 * the page, `held` holds its body back until `release()` (and its pictures come then), `clock` fakes the page's timers (ctx.clock), `fail` is a glob
 * for requests that fail, and `phone` makes it a 390 px phone.
 */
let gated = 0
async function open(storage = {}, { edit, held, clock, fail, phone } = {}) {
  const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : {})
  if (clock) await ctx.clock.install()
  // nothing leaves this machine: the app's node, avatars and pictures elsewhere don't answer
  await ctx.route((u) => !['127.0.0.1', 'localhost'].includes(u.hostname), (r) => r.abort())
  if (fail) await ctx.route(fail, (r) => r.fulfill({ status: 404, body: 'gone' }))
  await ctx.addInitScript((s) => Object.entries(s).forEach(([k, v]) => localStorage.setItem(k, v)), storage)
  const page = await ctx.newPage()
  // (not waiting for the page's load, which waits for that picture)
  const id = String(++gated)
  if (held) {
    const gate = Promise.withResolvers()
    gates.set(id, gate)
    await ctx.route('**/i/**', async (r) => (await gate.promise, r.fulfill({ body: PNG, contentType: 'image/png' })))
  }
  const url = `http://127.0.0.1:${proxyPort}/${held ? `?held=${id}` : ''}`
  if (edit) await page.route(url, async (r) => {
    const res = await r.fetch()
    await r.fulfill({ response: res, body: edit(await res.text()) })
  })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(url, { waitUntil: 'commit' })
  return { page, errors, ctx, release: () => gates.get(id)?.resolve(), close: () => ctx.close() }
}

// the app's own page, in place of the server's (which has a tab bar of its own)
const drawn = (page) => page.waitForFunction(() => document.querySelector('#app nav.tabbar') && !document.querySelector('.ssr-home'), null, { timeout: 30e3 })

// each test has a page of its own, so they all run at once
describe('the app in WebKit', { concurrency: true }, () => {
  test('signed in, the app draws its own home page once the server\'s page is parsed', async () => {
    const { page, errors, release, close } = await open({ 'quilcast:settings': '{}' }, { held: true })
    // the head's script has seen the account (data-own) with the page's body still on its way
    await page.locator('html[data-own]').waitFor({ state: 'attached' })
    release()
    await drawn(page)
    assert.equal(await page.locator('.crash').count(), 0)
    assert.deepEqual(errors, [])
    await close()
  })

  test('signed out, the app takes over the server\'s page when its first picture and the page itself take over 3 s', async () => {
    // the head's script loads the app 3 s in without that picture, with the page's body still on its way: once it asked for
    // the picture, the page's clock jumps those 3 s, and only then do the body and the picture come
    const { page, errors, ctx, release, close } = await open({}, { held: true, clock: true })
    await page.locator('meta[name="quilcast:lead"]').waitFor({ state: 'attached' })
    await page.locator('link[rel="preload"][as="image"]').waitFor({ state: 'attached' })
    await ctx.clock.fastForward(3000)
    release()
    await drawn(page)
    assert.deepEqual(errors, [])
    await close()
  })

  test('an app that fails to start says so, with a Reload button, instead of leaving a blank page', async () => {
    // no #app to draw in: the app's start throws
    const { page, close } = await open({ 'quilcast:settings': '{}' }, { edit: (html) => html.replace('<div id="app">', '<div id="elsewhere">') })
    const crash = page.locator('.crash[role="alert"]')
    await crash.waitFor({ timeout: 30e3 })
    assert.match(await crash.innerText(), /Something went wrong/)
    assert.equal(await crash.getByRole('button', { name: 'Reload' }).count(), 1)
    await close()
  })

  test('signed in, app code that fails to load says so, with a Reload button, instead of leaving a blank page', async () => {
    // one of the files the app's first file needs is gone (a deploy, a cache): the app's own code never runs
    const { page, close } = await open({ 'quilcast:settings': '{}' }, { fail: '**/assets/ui-*.js' })
    const crash = page.locator('.crash[role="alert"]')
    await crash.waitFor({ timeout: 30e3 })
    assert.match(await crash.innerText(), /Something went wrong/)
    assert.equal(await crash.getByRole('button', { name: 'Reload' }).count(), 1)
    await close()
  })

  // a phone's page never scrolls sideways: 0.46.0's sixth cast action made every page with casts 30 px too wide
  const me = JSON.stringify([{ phrase: '', custody: '0x' + '0'.repeat(39) + '1', fid: 9, username: 'me', done: true }])
  const nodeAt = { node: `http://127.0.0.1:${nodePort}` }
  for (const [who, storage] of [
    ['signed out', { 'quilcast:settings': JSON.stringify(nodeAt) }],
    ['signed in', { 'quilcast:accounts': me, 'quilcast:settings': JSON.stringify(nodeAt) }],
    ['in Quorum mode', { 'quilcast:accounts': me, 'quilcast:settings': JSON.stringify({ ...nodeAt, quorum: true }) }],
  ]) test(`on a phone, the page with casts and the tab bar fits the screen, ${who}`, async () => {
    const { page, close } = await open(storage, { phone: true })
    await drawn(page)
    await page.locator('#app article.cast footer').first().waitFor({ timeout: 30e3 })
    const { wide, page: w } = await page.evaluate(() => ({ wide: document.documentElement.scrollWidth, page: innerWidth }))
    assert.ok(wide <= w, `the page is ${wide} px wide on a ${w} px screen`)
    await close()
  })

  // #417: Back closes the image viewer and stays on the page, and a double tap zooms in on the spot and back out
  test('on a phone, Back closes the image viewer, which zooms on a double tap', async () => {
    const { page, ctx, errors, close } = await open({ 'quilcast:settings': JSON.stringify(nodeAt) }, { phone: true })
    // the cast's pictures, 800×600
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#48c"/></svg>'
    await ctx.route('https://imagedelivery.net/**', (r) => r.fulfill({ body: svg, contentType: 'image/svg+xml' }))
    await drawn(page)
    const pics = page.locator('#app article.cast button.img')
    await pics.first().waitFor({ timeout: 30e3 })
    const where = await page.evaluate(() => location.href)
    const box = page.locator('.lightbox')
    const img = box.locator('img')
    const scale = () => img.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a)
    const scaled = (a) => page.waitForFunction((a) => Math.abs(new DOMMatrix(getComputedStyle(document.querySelector('.lightbox img')).transform).a - a) < 1e-6, a)
    const openIt = async () => (await pics.first().click(), await box.waitFor(), await img.evaluate((el) => el.decode()))
    const dbl = async (p) => (await page.touchscreen.tap(p.x, p.y), await page.waitForTimeout(80), await page.touchscreen.tap(p.x, p.y))
    // fingers on the picture: [type, finger, x, y] (pointer events, which the viewer's gestures go by)
    const touch = (steps) => page.evaluate((steps) => {
      const el = document.querySelector('.lightbox img')
      for (const [type, id, x, y] of steps) el.dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: x, clientY: y, bubbles: true, cancelable: true, pointerType: 'touch', isPrimary: id === 1 }))
    }, steps)
    const swipe = (x, y, dx) => touch([['pointerdown', 1, x, y], ['pointermove', 1, x + dx / 3, y], ['pointermove', 1, x + dx, y], ['pointerup', 1, x + dx, y]])
    const count = () => box.locator('.lb-count').innerText()
    // the page's own listeners, after the app's: the router hears a pop only if this does
    await page.evaluate(() => ((window.pops = 0), addEventListener('popstate', () => window.pops++)))
    const pops = () => page.evaluate(() => window.pops)
    // the backdrop, below the picture even when zoomed
    const backdrop = { x: 20, y: 830 }

    await page.evaluate(() => scrollTo(0, 60))
    await openIt()
    const y = await page.evaluate(() => scrollY)
    const r = await img.boundingBox()
    const mid = { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    // a swipe at 1× goes to the next picture
    assert.equal(await count(), '1 / 2')
    await swipe(mid.x, mid.y, -120)
    await box.locator('.lb-count', { hasText: '2 / 2' }).waitFor()
    await img.evaluate((el) => el.decode())

    // a double tap on the picture's right half zooms in there: that spot stays under the finger
    const at = { x: r.x + r.width * 0.75, y: mid.y }
    await dbl(at)
    await scaled(2.5)
    const z = await img.boundingBox()
    assert.ok(Math.abs(z.x + z.width * 0.75 - at.x) < 2, 'the tapped spot moved')
    // zoomed, a swipe pans it instead of moving on, and a tap on the backdrop doesn't close it
    const x0 = z.x
    await swipe(mid.x, mid.y, 60)
    await page.waitForFunction((x0) => document.querySelector('.lightbox img').getBoundingClientRect().x > x0 + 30, x0)
    assert.equal(await count(), '2 / 2')
    await page.touchscreen.tap(backdrop.x, backdrop.y)
    await page.waitForTimeout(400)
    assert.equal(await box.count(), 1)
    assert.equal(await scale(), 2.5)
    // and a double tap zooms back out
    await dbl(mid)
    await scaled(1)
    await page.waitForTimeout(400)

    // two fingers spread twice as far apart zoom it in twice; 0 fits it again, + zooms in
    await touch([['pointerdown', 1, mid.x - 50, mid.y], ['pointerdown', 2, mid.x + 50, mid.y], ['pointermove', 2, mid.x + 100, mid.y], ['pointermove', 2, mid.x + 150, mid.y], ['pointerup', 2, mid.x + 150, mid.y], ['pointerup', 1, mid.x - 50, mid.y]])
    await scaled(2)
    assert.equal(await count(), '2 / 2')
    await page.keyboard.press('0')
    await scaled(1)
    await page.keyboard.press('+')
    await scaled(1.5)

    // Back closes it on the same page, where it was (the router, which scrolls a page it goes to to the top, never
    // heard it); Forward opens it again, on the picture it was left on; Back once more
    await page.waitForTimeout(600)
    await page.evaluate(() => history.back())
    await box.waitFor({ state: 'detached' })
    assert.equal(await page.evaluate(() => location.href), where)
    assert.equal(await page.evaluate(() => scrollY), y)
    await page.evaluate(() => history.forward())
    await box.waitFor()
    assert.equal(await count(), '2 / 2')
    // closed right after a swipe, Forward still opens it on the picture it was left on
    await img.evaluate((el) => el.decode())
    await swipe(mid.x, mid.y, 120)
    await box.locator('.lb-count', { hasText: '1 / 2' }).waitFor()
    await box.getByRole('button', { name: 'Close' }).click()
    await box.waitFor({ state: 'detached' })
    await page.waitForFunction(() => !history.state?.['quilcast:viewing'])
    await page.evaluate(() => history.forward())
    await box.waitFor()
    assert.equal(await count(), '1 / 2')
    await page.evaluate(() => history.back())
    await box.waitFor({ state: 'detached' })

    // ✕, Escape and a tap on the backdrop close it without leaving its history entry behind
    for (const shut of [() => box.getByRole('button', { name: 'Close' }).click(), () => page.keyboard.press('Escape'), () => page.touchscreen.tap(backdrop.x, backdrop.y)]) {
      await openIt()
      assert.ok(await page.evaluate(() => history.state?.['quilcast:viewing']))
      await shut()
      await box.waitFor({ state: 'detached' })
      await page.waitForFunction(() => !history.state?.['quilcast:viewing'])
      assert.equal(await page.evaluate(() => location.href), where)
    }
    assert.equal(await pops(), 0)
    assert.deepEqual(errors, [])
    await close()
  })
})
