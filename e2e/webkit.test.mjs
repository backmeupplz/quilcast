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
import { after, before, test } from 'node:test'
import { webkit } from 'playwright'

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)))
const cast = (n, extra = {}) => ({ hash: '0x' + String(n).repeat(40), text: `cast number ${n}`, timestamp: '2026-01-02T00:00:00Z', embeds: [], author: { fid: n, username: `user${n}` }, reactions: { likes_count: 5, recasts_count: 0 }, replies: { count: 0 }, ...extra })
// a stand-in Hypersnap node: the trending feed the home page is drawn from; its first cast's pictures make the first one the
// page's lead (index.html waits for it before loading the app)
const node = createServer((q, r) => {
  r.setHeader('content-type', 'application/json')
  if (q.url.startsWith('/v2/farcaster/feed/trending')) return r.end(JSON.stringify({ casts: [cast(1, { embeds: [{ url: 'https://imagedelivery.net/abc/one/original' }, { url: 'https://imagedelivery.net/abc/two/original' }] }), cast(2), cast(3)] }))
  r.end('{}')
})
const nodePort = await listen(node)
const spare = createServer()
const port = await listen(spare)
spare.close()
// between the browser and the server: the home page's head at once, its body 1.5 s later (or ?hold= ms); the page's
// first picture (through the server's /i/, which would ask Farcaster's CDN for it) never comes
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
    setTimeout(() => r.end(s.slice(i)), Number(url.searchParams.get('hold') || 1500))
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

/**
 * Open the home page through the slow line, with `storage` in localStorage; its errors are collected. `edit` changes
 * the page, `hold` is how long its body takes, and `fail` is a glob for requests that fail.
 */
async function open(storage = {}, { edit, hold, fail } = {}) {
  const ctx = await browser.newContext()
  // nothing leaves this machine: the app's node, avatars and pictures elsewhere don't answer
  await ctx.route((u) => !['127.0.0.1', 'localhost'].includes(u.hostname), (r) => r.abort())
  if (fail) await ctx.route(fail, (r) => r.fulfill({ status: 404, body: 'gone' }))
  await ctx.addInitScript((s) => Object.entries(s).forEach(([k, v]) => localStorage.setItem(k, v)), storage)
  const page = await ctx.newPage()
  // (not waiting for the page's load, which waits for that picture)
  const url = `http://127.0.0.1:${proxyPort}/${hold ? `?hold=${hold}` : ''}`
  if (edit) await page.route(url, async (r) => {
    const res = await r.fetch()
    await r.fulfill({ response: res, body: edit(await res.text()) })
  })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(url, { waitUntil: 'commit' })
  return { page, errors, close: () => ctx.close() }
}

// the app's own page, in place of the server's (which has a tab bar of its own)
const drawn = (page) => page.waitForFunction(() => document.querySelector('#app nav.tabbar') && !document.querySelector('.ssr-home'), null, { timeout: 30e3 })

test('signed in, the app draws its own home page once the server\'s page is parsed', async () => {
  const { page, errors, close } = await open({ 'quilcast:settings': '{}' })
  await drawn(page)
  assert.equal(await page.locator('.crash').count(), 0)
  assert.deepEqual(errors, [])
  await close()
})

test('signed out, the app takes over the server\'s page when its first picture and the page itself take over 3 s', async () => {
  // the head's script loads the app 3 s in without that picture, with the page's body still on its way
  const { page, errors, close } = await open({}, { hold: 3500 })
  await page.locator('meta[name="quilcast:lead"]').waitFor({ state: 'attached' })
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
