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
const seven = { fid: 7, username: 'user7', display_name: 'Seven', follower_count: 1, following_count: 2 }
const sevens = [cast(8, { text: 'a RAD feature', author: seven }), cast(9, { text: 'nothing to see', author: seven, parent_hash: 'a'.repeat(40) })]
// 3 pages of 25 casts by the page's ?cursor, each cast's hash all f's but its number (#502)
const longFeed = (q, text) => {
  const page = Number(q.get('cursor') || 0)
  const casts = Array.from({ length: 25 }, (_, i) => page * 25 + i + 1).map((n) => cast(n, { hash: '0x' + n.toString(16).padStart(40, 'f'), text: `${text} ${n}` }))
  return JSON.stringify({ casts, next: { cursor: page < 2 ? String(page + 1) : null } })
}
const reader = { fid: 13, username: 'reader', display_name: 'Reader', follower_count: 1, following_count: 75 }
const slowpoke = { fid: 14, username: 'slowpoke', display_name: 'Slowpoke', follower_count: 1, following_count: 75 }
// @looky has a profile look, with a mood and an About me box above their casts; the look comes from the app's server
const looky = { fid: 12, username: 'looky', display_name: 'Looky', follower_count: 1, following_count: 1 }
const LOOK = { mood: 'in a mood', about: Array.from({ length: 8 }, (_, i) => `About line ${i + 1}`).join('\n\n') }
// the [fid, viewer_fid] of every Following feed asked for
const followingAsked = []
const node = createServer((q, r) => {
  r.setHeader('content-type', 'application/json')
  r.setHeader('access-control-allow-origin', '*')
  if (q.url.startsWith('/v2/farcaster/feed/trending')) return r.end(JSON.stringify({ casts: [cast(1, { embeds: [{ url: 'https://imagedelivery.net/abc/one/original' }, { url: 'https://imagedelivery.net/abc/two/original' }] }), cast(2), cast(3), busy] }))
  // @user7, browsed as (#490), follows the authors of casts 5 and 6
  if (q.url.startsWith('/v2/farcaster/feed/following')) {
    const u = new URL(q.url, 'http://x').searchParams
    followingAsked.push([u.get('fid'), u.get('viewer_fid')])
    // @reader follows enough people for 3 pages (#502)
    if (u.get('fid') === '13') return r.end(longFeed(u, 'following cast'))
    // and @slowpoke's second page takes 2 s
    if (u.get('fid') === '14') return void setTimeout(() => r.end(longFeed(u, 'following cast')), u.get('cursor') === '1' ? 2000 : 0)
    return r.end(JSON.stringify({ casts: u.get('fid') === '7' ? [cast(5), cast(6)] : [busy, cast(2)] }))
  }
  const at = new URL(q.url, 'http://x')
  // a long channel feed, and @looky's casts (#502)
  if (at.pathname === '/v2/farcaster/feed/parent_urls') return r.end(longFeed(at.searchParams, 'long feed cast'))
  if (at.pathname === '/v2/farcaster/feed/user/casts' && at.searchParams.get('fid') === '12') return r.end(longFeed(at.searchParams, 'looky cast'))
  if (at.pathname === '/v2/farcaster/feed/user/replies_and_recasts' && at.searchParams.get('fid') === '12') return r.end(JSON.stringify({ casts: [] }))
  for (const u of [reader, slowpoke, looky]) if ((at.pathname === '/v2/farcaster/user/by-username' && at.searchParams.get('username') === u.username) || (at.pathname === '/v2/farcaster/user' && at.searchParams.get('fid') === String(u.fid))) return r.end(JSON.stringify({ user: u }))
  if (at.pathname === '/v2/farcaster/cast/quotes') return r.end(JSON.stringify({ casts: [] }))
  // and one of them opened
  if (at.pathname === '/v2/farcaster/cast/conversation' && at.searchParams.get('identifier').startsWith('fff')) {
    const n = parseInt(at.searchParams.get('identifier').replace(/^f+/, ''), 16)
    return r.end(JSON.stringify({ conversation: { cast: cast(n, { hash: at.searchParams.get('identifier'), text: `long feed cast ${n}`, direct_replies: [] } ) } }))
  }
  // "seven" is an fname whose account goes by another username, like vbuterin's vitalik.eth
  if ((at.pathname === '/v2/farcaster/user/by-username' && ['user7', 'seven'].includes(at.searchParams.get('username'))) || (at.pathname === '/v2/farcaster/user' && at.searchParams.get('fid') === '7')) return r.end(JSON.stringify({ user: seven }))
  // @user7's casts as the hub lists them (0x hashes), for searching a profile (#495), and in full (bare hashes)
  if (at.pathname === '/v1/castsByFid' && at.searchParams.get('fid') === '7') return r.end(JSON.stringify({ messages: sevens.map((c) => ({ data: { type: 'MESSAGE_TYPE_CAST_ADD', fid: 7, castAddBody: { text: c.text } }, hash: c.hash })), nextPageToken: '' }))
  if (at.pathname === '/v2/farcaster/casts') {
    const hs = at.searchParams.get('casts').split(',')
    return r.end(JSON.stringify({ casts: sevens.filter((c) => hs.includes(c.hash.slice(2))).map((c) => ({ ...c, hash: c.hash.slice(2) })) }))
  }
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
  // (a second and a half late, so the casts draw before it)
  if (url.pathname === `/api/look/${looky.fid}`) return void setTimeout(() => r.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(LOOK)), 1500)
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
 * for requests that fail, `phone` makes it a 390 px phone, and `path` opens another page than the home page.
 */
let gated = 0
async function open(storage = {}, { edit, held, clock, fail, phone, path = '/' } = {}) {
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
  const url = `http://127.0.0.1:${proxyPort}${held ? `/?held=${id}` : path}`
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

// #502: scrolled down past the first page of a feed; a link, as the app follows one (go() in api.ts); Back's spot
const deep = (page) => page.waitForFunction(() => (scrollTo(0, document.documentElement.scrollHeight), document.querySelectorAll('#app article.cast').length > 25), null, { polling: 100, timeout: 30e3 })
const link = (page, path) => page.evaluate((p) => (history.pushState(null, '', p), dispatchEvent(new PopStateEvent('popstate'))), path)
const spot = (page, at, y) => page.waitForFunction(([at, y]) => location.pathname + location.search === at && Math.abs(scrollY - y) < 2, [at, y], { timeout: 10e3 })

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

  // #490: browsing as someone shows their Following feed, read-only, with a way out
  const feedText = (page) => page.locator('#app article.cast').allInnerTexts().then((ts) => ts.join('\n'))
  test('signed out, a profile\'s Browse as shows their Following feed, and Exit goes back to Trending', async () => {
    const { page, close } = await open({ 'quilcast:settings': JSON.stringify(nodeAt) }, { path: '/u/user7' })
    await page.locator('#app .profile h2', { hasText: 'Seven' }).waitFor({ timeout: 30e3 })
    await page.locator('#app .profile button[aria-label="More"]').click()
    await page.getByRole('menuitem', { name: 'Browse as @user7' }).click()
    const banner = page.locator('#app .banner.browsing')
    await banner.getByText('Browsing as @user7').waitFor({ timeout: 30e3 })
    await page.locator('#app article.cast', { hasText: 'cast number 5' }).waitFor({ timeout: 30e3 })
    assert.equal(await page.evaluate(() => location.pathname + location.search), '/?as=user7')
    const text = await feedText(page)
    assert.ok(text.includes('cast number 6') && !text.includes('cast number 2'), text)
    assert.ok(followingAsked.some(([fid, viewer]) => fid === '7' && viewer === null))
    // a signed-out visitor can join from here, and the last account browsed as is remembered
    assert.equal(await banner.getByRole('link', { name: 'Join' }).count(), 1)
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('quilcast:browsed')).map((r) => r.fid)), [7])
    await banner.getByRole('link', { name: 'Exit' }).click()
    await page.locator('#app article.cast', { hasText: 'cast number 3' }).waitFor({ timeout: 30e3 })
    assert.equal(await page.locator('#app .banner.browsing').count(), 0)
    assert.equal(await page.evaluate(() => location.search), '')
    // the signed-out banner offers the account again
    assert.equal(await page.locator('#app .banner .recents a', { hasText: '@user7' }).getAttribute('href'), '/?as=user7')
    await close()
  })

  // #495: a profile's search finds only that account's casts, and is a link
  test('signed out, a profile\'s search shows only their matching casts, keeps ?q= in the address, and Escape ends it', async () => {
    const { page, close } = await open({ 'quilcast:settings': JSON.stringify(nodeAt) }, { path: '/u/user7' })
    await page.locator('#app .profile h2', { hasText: 'Seven' }).waitFor({ timeout: 30e3 })
    await page.locator('#app .profile button[aria-label="Search @user7\'s casts"]').click()
    const box = page.locator('#app .profile-search input')
    // opened with the button, the box takes focus
    await page.waitForFunction(() => document.activeElement === document.querySelector('#app .profile-search input'))
    await box.fill('rad')
    await page.locator('#app article.cast', { hasText: 'a RAD feature' }).waitFor({ timeout: 30e3 })
    assert.ok(!(await feedText(page)).includes('nothing to see'))
    assert.equal(await page.locator('#app .lk-feed [role="tablist"], #app .lk-feed .tabs').count(), 0, 'no Casts/Replies tabs while searching')
    await page.waitForFunction(() => location.search === '?q=rad')
    await box.fill('zebra')
    await page.locator('#app .note', { hasText: 'No casts by @user7 match “zebra”.' }).waitFor({ timeout: 30e3 })
    await box.press('Escape')
    await page.waitForFunction(() => location.search === '' && !document.querySelector('#app .profile-search'))
    await close()
  })

  test('a profile link with ?q= opens with its search', async () => {
    const { page, close } = await open({ 'quilcast:settings': JSON.stringify(nodeAt) }, { path: '/u/user7?q=see' })
    await page.locator('#app article.cast', { hasText: 'nothing to see' }).waitFor({ timeout: 30e3 })
    assert.equal(await page.locator('#app .profile-search input').inputValue(), 'see')
    // a link doesn't focus the box, so a phone's keyboard stays down
    assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('#app .profile-search input')), false)
    assert.ok(!(await feedText(page)).includes('a RAD feature'))
    // the profile's own link (no ?q=) ends the search; Back brings it back
    await page.evaluate(() => (history.pushState(null, '', '/u/user7'), dispatchEvent(new PopStateEvent('popstate'))))
    await page.waitForFunction(() => !document.querySelector('#app .profile-search') && document.querySelector('#app .lk-feed [role="tablist"]'))
    await page.evaluate(() => history.back())
    await page.waitForFunction(() => location.search === '?q=see' && document.querySelector('#app .profile-search input')?.value === 'see')
    await page.locator('#app article.cast', { hasText: 'nothing to see' }).waitFor({ timeout: 30e3 })
    await close()
  })

  // #502: Back from a cast goes back to the spot in the feed, with the pages loaded by scrolling still there
  test('on a desktop, Back from a cast keeps the feed\'s place and its later pages; a link starts at the top', async () => {
    const { page, errors, close } = await open({ 'quilcast:settings': JSON.stringify(nodeAt) }, { path: '/channel/longfeed' })
    const cards = page.locator('#app article.cast')
    await cards.first().waitFor({ timeout: 30e3 })
    // scrolled down into the second page
    await page.waitForFunction(() => (scrollTo(0, document.documentElement.scrollHeight), document.querySelectorAll('#app article.cast').length > 25), null, { polling: 100, timeout: 30e3 })
    const target = page.locator('#app article.cast', { hasText: 'long feed cast 40' }).first()
    await target.scrollIntoViewIfNeeded()
    await page.evaluate(() => scrollBy(0, -100))
    const before = await page.evaluate(() => ({ y: scrollY, n: document.querySelectorAll('#app article.cast').length }))
    assert.ok(before.y > 1000, `scrolled to ${before.y}`)
    await target.click()
    await page.waitForFunction(() => location.pathname.startsWith('/c/'))
    // a cast opened by a link starts at the top
    assert.equal(await page.evaluate(() => scrollY), 0)
    await page.goBack({ waitUntil: 'commit' })
    await page.waitForFunction((y) => location.pathname === '/channel/longfeed' && Math.abs(scrollY - y) < 2, before.y, { timeout: 10e3 })
    assert.ok(await cards.count() >= before.n, 'the later pages are gone')
    await target.waitFor()
    // the app's own Back does the same
    await target.click()
    await page.waitForFunction(() => location.pathname.startsWith('/c/'))
    await page.evaluate(() => history.back())
    await page.waitForFunction((y) => location.pathname === '/channel/longfeed' && Math.abs(scrollY - y) < 2, before.y, { timeout: 10e3 })
    // after a refresh, Back finds the refreshed list, not the one before it
    await page.locator('#app button[aria-label="Refresh"]').click()
    await page.waitForFunction(() => scrollY === 0 && document.querySelectorAll('#app article.cast').length <= 25, null, { polling: 100, timeout: 10e3 })
    await page.waitForFunction(() => (scrollTo(0, document.documentElement.scrollHeight), document.querySelectorAll('#app article.cast').length > 25), null, { polling: 100, timeout: 30e3 })
    await target.scrollIntoViewIfNeeded()
    const again = await page.evaluate(() => scrollY)
    assert.ok(again > 1000, `scrolled to ${again}`)
    await target.click()
    await page.waitForFunction(() => location.pathname.startsWith('/c/'))
    await page.goBack({ waitUntil: 'commit' })
    await page.waitForFunction((y) => location.pathname === '/channel/longfeed' && Math.abs(scrollY - y) < 2, again, { timeout: 10e3 })
    // a link to the feed starts it over at the top
    await target.click()
    await page.waitForFunction(() => location.pathname.startsWith('/c/'))
    await page.evaluate(() => (history.pushState(null, '', '/channel/longfeed'), dispatchEvent(new PopStateEvent('popstate'))))
    await page.waitForFunction(() => location.pathname === '/channel/longfeed' && document.querySelector('#app article.cast') && document.querySelectorAll('#app article.cast').length <= 25, null, { polling: 100, timeout: 10e3 })
    assert.equal(await page.evaluate(() => scrollY), 0)
    assert.deepEqual(errors, [])
    await close()
  })

  test('Back to a page visited twice finds each visit\'s own place and pages', async () => {
    const { page, errors, close } = await open({ 'quilcast:settings': JSON.stringify(nodeAt) }, { path: '/channel/longfeed' })
    const cards = page.locator('#app article.cast')
    await cards.first().waitFor({ timeout: 30e3 })
    await deep(page)
    const target = page.locator('#app article.cast', { hasText: 'long feed cast 40' }).first()
    await target.scrollIntoViewIfNeeded()
    const first = await page.evaluate(() => ({ y: scrollY, n: document.querySelectorAll('#app article.cast').length }))
    await target.click()
    await page.waitForFunction(() => location.pathname.startsWith('/c/'))
    // the feed again by a link, which starts it over, scrolled a little way into its first page
    await link(page, '/channel/longfeed')
    await page.locator('#app article.cast', { hasText: 'long feed cast 20' }).first().waitFor({ timeout: 10e3 })
    const second = await page.evaluate(() => (scrollTo(0, 600), scrollY))
    assert.ok(second > 0 && first.y - second > 1000, `${second} vs ${first.y}`)
    await page.locator('#app article.cast', { hasText: 'long feed cast 9' }).first().click()
    await page.waitForFunction(() => location.pathname.startsWith('/c/'))
    await page.goBack({ waitUntil: 'commit' })
    await spot(page, '/channel/longfeed', second)
    await page.goBack({ waitUntil: 'commit' })
    await page.waitForFunction(() => location.pathname.startsWith('/c/'))
    // the first visit comes back as it was: its spot and its 2 pages, not the second visit's
    await page.goBack({ waitUntil: 'commit' })
    await spot(page, '/channel/longfeed', first.y)
    assert.ok(await cards.count() >= first.n, 'the later pages are gone')
    assert.deepEqual(errors, [])
    await close()
  })

  test('Back to a channel reached from another channel that was refreshed finds its place', async () => {
    const { page, errors, close } = await open({ 'quilcast:settings': JSON.stringify(nodeAt) }, { path: '/channel/longfeed' })
    const cards = page.locator('#app article.cast')
    await cards.first().waitFor({ timeout: 30e3 })
    await page.locator('#app button[aria-label="Refresh"]').click()
    await page.locator('#app article.cast', { hasText: 'long feed cast 20' }).first().waitFor({ timeout: 10e3 })
    // the same page, drawn for another channel
    await link(page, '/channel/second')
    await page.locator('#app article.cast', { hasText: 'long feed cast 20' }).first().waitFor({ timeout: 10e3 })
    await deep(page)
    const target = page.locator('#app article.cast', { hasText: 'long feed cast 40' }).first()
    await target.scrollIntoViewIfNeeded()
    const before = await page.evaluate(() => ({ y: scrollY, n: document.querySelectorAll('#app article.cast').length }))
    await target.click()
    await page.waitForFunction(() => location.pathname.startsWith('/c/'))
    await page.goBack({ waitUntil: 'commit' })
    await spot(page, '/channel/second', before.y)
    assert.ok(await cards.count() >= before.n, 'the later pages are gone')
    assert.deepEqual(errors, [])
    await close()
  })

  test('a reload stays where the page was', async () => {
    const { page, errors, close } = await open({ 'quilcast:settings': JSON.stringify(nodeAt) }, { path: '/channel/longfeed' })
    await page.locator('#app article.cast', { hasText: 'long feed cast 20' }).first().waitFor({ timeout: 30e3 })
    const y = await page.evaluate(() => (scrollTo(0, 1000), scrollY))
    assert.equal(y, 1000)
    await page.reload({ waitUntil: 'commit' })
    await page.waitForFunction((y) => document.querySelector('#app article.cast') && Math.abs(scrollY - y) < 2, y, { timeout: 15e3 })
    assert.deepEqual(errors, [])
    await close()
  })

  test('Home\'s threaded Following comes back with its pages and goes on without repeats; its tab comes back too', async () => {
    const { page, close } = await open({ 'quilcast:settings': JSON.stringify(nodeAt) }, { path: '/?as=reader' })
    const cards = page.locator('#app article.cast')
    await page.locator('#app article.cast', { hasText: 'following cast 1' }).first().waitFor({ timeout: 30e3 })
    await deep(page)
    const target = page.locator('#app article.cast', { hasText: 'following cast 40' }).first()
    await target.scrollIntoViewIfNeeded()
    const before = await page.evaluate(() => ({ y: scrollY, n: document.querySelectorAll('#app article.cast').length }))
    await target.click()
    await page.waitForFunction(() => location.pathname.startsWith('/c/'))
    await page.goBack({ waitUntil: 'commit' })
    await spot(page, '/?as=reader', before.y)
    assert.ok(await cards.count() >= before.n, 'the later pages are gone')
    // scrolling on loads the third page, and nothing shows twice
    await page.waitForFunction(() => (scrollTo(0, document.documentElement.scrollHeight), document.querySelector('#app').innerText.includes('following cast 75')), null, { polling: 100, timeout: 30e3 })
    const shown = await page.$$eval('#app article.cast', (as) => as.map((a) => a.innerText.match(/following cast \d+/)?.[0]).filter(Boolean))
    assert.equal(new Set(shown).size, shown.length, `repeated: ${shown}`)
    // Trending, left for a cast, is the tab Back comes back to
    await page.getByRole('tab', { name: 'Trending' }).click()
    await page.locator('#app article.cast', { hasText: 'cast number 3' }).first().click()
    await page.waitForFunction(() => location.pathname.startsWith('/c/'))
    await page.goBack({ waitUntil: 'commit' })
    await page.waitForFunction(() => location.search === '?as=reader' && document.querySelector('#app [role="tab"][aria-selected="true"]')?.textContent === 'Trending', null, { timeout: 10e3 })
    await close()
  })

  test('Back after leaving while Following\'s next page was loading shows that page in full', async () => {
    const { page, close } = await open({ 'quilcast:settings': JSON.stringify(nodeAt) }, { path: '/?as=slowpoke' })
    await page.locator('#app article.cast', { hasText: 'following cast 25' }).first().waitFor({ timeout: 30e3 })
    // the next page is asked for (it takes 2 s), and a cast is opened meanwhile; that page arrives after the feed is left
    await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight))
    await page.locator('#app .spinner').waitFor({ timeout: 5e3 })
    await page.locator('#app article.cast', { hasText: 'following cast 24' }).first().click()
    await page.waitForFunction(() => location.pathname.startsWith('/c/'))
    await page.waitForTimeout(2500)
    await page.goBack({ waitUntil: 'commit' })
    await page.locator('#app article.cast', { hasText: 'following cast 24' }).first().waitFor({ timeout: 10e3 })
    await page.waitForFunction(() => (scrollTo(0, document.documentElement.scrollHeight), document.querySelector('#app').innerText.includes('following cast 26')), null, { polling: 100, timeout: 15e3 })
    await close()
  })

  test('Back to a profile, or a reload of it whose look draws late, keeps the casts where they were; its tab comes back too', async () => {
    const { page, close } = await open({ 'quilcast:settings': JSON.stringify(nodeAt) }, { path: '/u/looky' })
    await page.locator('#app').getByText('About line 8').waitFor({ timeout: 30e3 })
    await page.locator('#app article.cast', { hasText: 'looky cast 1' }).first().waitFor({ timeout: 30e3 })
    await deep(page)
    const target = page.locator('#app article.cast', { hasText: 'looky cast 40' }).first()
    await target.scrollIntoViewIfNeeded()
    const top = (await target.boundingBox()).y
    await target.click()
    await page.waitForFunction(() => location.pathname.startsWith('/c/'))
    await page.goBack({ waitUntil: 'commit' })
    await page.locator('#app').getByText('About line 8').waitFor({ timeout: 10e3 })
    await page.waitForTimeout(500)
    assert.ok(Math.abs((await target.boundingBox()).y - top) < 2, `${(await target.boundingBox()).y} vs ${top}`)
    // after a reload the look comes a second and a half after the casts, and pushes them down: the page keeps them in
    // place until it has settled
    const near = page.locator('#app article.cast', { hasText: 'looky cast 15' }).first()
    await near.scrollIntoViewIfNeeded()
    const nearTop = (await near.boundingBox()).y
    await page.reload({ waitUntil: 'commit' })
    await page.locator('#app').getByText('About line 8').waitFor({ timeout: 10e3 })
    await page.waitForTimeout(1000)
    assert.ok(Math.abs((await near.boundingBox()).y - nearTop) < 2, `${(await near.boundingBox()).y} vs ${nearTop}`)
    await page.getByRole('tab', { name: 'Replies' }).click()
    await link(page, '/channel/longfeed')
    await page.locator('#app article.cast', { hasText: 'long feed cast 1' }).first().waitFor({ timeout: 10e3 })
    await page.goBack({ waitUntil: 'commit' })
    await page.waitForFunction(() => location.pathname === '/u/looky' && document.querySelector('#app [role="tab"][aria-selected="true"]')?.textContent === 'Replies', null, { timeout: 10e3 })
    await close()
  })

  test('signed in, a ?as= link shows their feed without the composer, and Exit goes back to your own', async () => {
    const { page, close } = await open({ 'quilcast:accounts': me, 'quilcast:settings': JSON.stringify({ ...nodeAt, quorum: true }) }, { path: '/?as=seven' })
    await page.locator('#app .banner.browsing').getByText('Browsing as @user7').waitFor({ timeout: 30e3 })
    await page.locator('#app article.cast', { hasText: 'cast number 5' }).waitFor({ timeout: 30e3 })
    assert.ok(followingAsked.some(([fid, viewer]) => fid === '7' && viewer === '9'))
    assert.equal(await page.locator('#app .q-sub').innerText().then((t) => t.includes('From people @user7 follows')), true)
    assert.equal(await page.locator('#app .banner.browsing').getByRole('link', { name: 'Join' }).count(), 0)
    assert.equal(await page.locator('#app .q-compose').count(), 0)
    await page.locator('#app .banner.browsing').getByRole('link', { name: 'Exit' }).click()
    // your own Following (casts 4 and 2), not Trending (which also has 1 and 3) and not @user7's (5 and 6)
    await page.locator('#app article.cast', { hasText: 'cast number 2' }).waitFor({ timeout: 30e3 })
    const own = await feedText(page)
    assert.ok(!/cast number [1356]/.test(own), own)
    assert.ok((await page.locator('#app .q-sub').innerText()).includes('From people you follow'))
    assert.equal(await page.locator('#app .q-compose').count(), 1)
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

  // #467: a mini app at game.test, its link metadata not looked up, opened from the Mini apps page. The page gets there
  // by itself rather than by a new load: a load sets localStorage again, and the old page, hearing another tab change the
  // accounts, would go home
  const game = async (ctx) => {
    await ctx.route('**/api/unfurl**', (r) => r.fulfill({ body: 'null', contentType: 'application/json' }))
    await ctx.route('https://game.test/**', (r) => r.fulfill({ body: '<!doctype html><title>game</title><p>a game</p>', contentType: 'text/html' }))
  }
  const toApps = async (page) => {
    await drawn(page)
    // (until the router hears it: it starts listening a moment after the page is drawn)
    await page.evaluate(() => history.pushState(null, '', '/apps'))
    await page.waitForFunction(() => document.querySelector('[aria-label="Mini app link"]') || void dispatchEvent(new Event('popstate')), null, { polling: 100, timeout: 30e3 })
  }
  const launchGame = async (page) => {
    await page.getByLabel('Mini app link').fill('https://game.test/')
    await page.getByLabel('Mini app link').press('Enter')
    await page.locator('section.mini').waitFor()
  }

  // #467: on a desktop, in either layout, a mini app's window goes full screen over the sidebar and the feed, with its
  // header and the dock still in reach; the app keeps it (minimized, and closed and opened again), and Escape leaves it
  for (const [who, quorum] of [['', false], [', in Quorum mode', true]]) test(`on a desktop, a mini app goes full screen and back${who}`, async () => {
    const { page, ctx, close } = await open({ 'quilcast:accounts': me, 'quilcast:settings': JSON.stringify({ ...nodeAt, quorum }) })
    await game(ctx)
    const win = page.locator('section.mini')
    // what's on top at a point: the window, the dock or something else
    const top = (where) => page.evaluate(([x, y]) => {
      const el = document.elementFromPoint(x, y)
      return el?.closest('.dock') ? 'dock' : el?.closest('section.mini') ? 'mini' : el?.tagName
    }, where)
    const mid = async (loc) => (({ x, y, width, height }) => [x + width / 2, y + height / 2])(await loc.boundingBox())
    const { width, height } = page.viewportSize()
    const toggle = (name) => win.getByRole('button', { name, exact: true })

    await toApps(page)
    await launchGame(page)
    // Quorum mode's Expand is this toggle now
    assert.equal(await win.getByRole('button', { name: 'Expand' }).count(), 0)
    assert.ok((await win.boundingBox()).width < width / 2, 'a window to start with')
    await toggle('Full screen').click()
    await toggle('Exit full screen').waitFor()
    const r = await win.boundingBox()
    assert.deepEqual([r.x, r.y, r.width, r.height], [0, 0, width, height])
    // the sidebar is behind it, the header's buttons and the dock in front, and the app's frame clear of the dock
    assert.equal(await top([40, height / 2]), 'mini')
    for (const name of ['Minimize', 'More', 'Close', 'Exit full screen']) assert.equal(await top(await mid(win.getByRole('button', { name, exact: true }))), 'mini', name)
    const dock = page.locator('nav.dock button.open')
    assert.equal(await top(await mid(dock)), 'dock')
    const f = await win.locator('iframe').boundingBox()
    assert.ok(f.y + f.height <= (await dock.boundingBox()).y, 'the dock covers the app')
    // nothing behind it takes focus, so Tab stays with the window and the dock
    assert.equal(await page.evaluate(() => (document.querySelector('.side a').focus(), document.activeElement.closest('.side'))), null)
    // Escape for something over the window is for that, not for full screen: the More menu, and Quorum's composer
    const more = win.getByRole('button', { name: 'More' })
    await more.click()
    await page.locator('.menu').waitFor()
    await page.keyboard.press('Escape')
    await win.locator('.mini-name').click()
    await page.locator('.menu').waitFor({ state: 'detached' })
    assert.equal(await toggle('Exit full screen').count(), 1)
    if (quorum) {
      await win.getByRole('button', { name: 'Share in a cast' }).click()
      await page.locator('.modal textarea').first().focus()
      await page.keyboard.press('Escape')
      await page.locator('.modal').waitFor({ state: 'detached' })
      assert.equal(await toggle('Exit full screen').count(), 1)
    }

    // minimized and shown again from the dock, it's still full screen
    await win.getByRole('button', { name: 'Minimize' }).click()
    await win.waitFor({ state: 'hidden' })
    await dock.click()
    await toggle('Exit full screen').waitFor()
    // and it opens that way next time, until Escape takes it back to a window
    const reopen = async () => (await win.getByRole('button', { name: 'Close' }).click(), await win.waitFor({ state: 'detached' }), await launchGame(page))
    await reopen()
    await toggle('Exit full screen').waitFor()
    await page.keyboard.press('Escape')
    await toggle('Full screen').waitFor()
    assert.ok((await win.boundingBox()).width < width / 2)
    await reopen()
    await toggle('Full screen').waitFor()

    // Fill the monitor: the browser full screen too; the toggle leaves both, back to the window it was, remembering nothing
    const monitor = async () => (await more.click(), await page.getByRole('menuitem', { name: 'Fill the monitor' }).click(), await page.waitForFunction(() => document.fullscreenElement === document.documentElement))
    await monitor()
    await toggle('Exit full screen').click()
    await page.waitForFunction(() => !document.fullscreenElement)
    await toggle('Full screen').waitFor()
    assert.equal(await page.evaluate(() => localStorage.getItem('quilcast:full')), '{}')
    // a window kept full screen stays so after it, here left by minimizing the app
    await toggle('Full screen').click()
    await monitor()
    await win.getByRole('button', { name: 'Minimize' }).click()
    await page.waitForFunction(() => !document.fullscreenElement)
    await dock.click()
    await toggle('Exit full screen').waitFor()
    await close()
  })

  // a phone's window already fills the screen: no toggle, even for an app kept full screen on a desktop
  test('on a phone, a mini app has no full screen toggle', async () => {
    const { page, ctx, close } = await open({ 'quilcast:accounts': me, 'quilcast:settings': JSON.stringify(nodeAt), 'quilcast:full': JSON.stringify({ 'https://game.test': '1' }) }, { phone: true })
    await game(ctx)
    await toApps(page)
    await launchGame(page)
    const win = page.locator('section.mini')
    assert.equal(await win.locator('.mini-full').count(), 1)
    assert.equal(await win.locator('.mini-full').isVisible(), false)
    const r = await win.boundingBox()
    assert.deepEqual([r.x, r.y, r.width, r.height], [0, 0, 390, 844])
    await close()
  })
})
