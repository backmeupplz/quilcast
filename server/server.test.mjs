// Starts the real server against a fake Hypersnap node and pokes the edges that matter:
// malformed URLs, meta-tag injection, SSRF through card images, Range, upload types, headers.
// Needs a build (dist/index.html): npm run build && npm test
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'
import { after, before, test } from 'node:test'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { ed25519 } from '@noble/curves/ed25519.js'
import { address, ecSign } from '../src/fc.ts'
import { verify } from '../scripts/verify.mjs'

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)))
let internalHits = 0
const internal = createServer((q, r) => (internalHits++, r.end('secret')))
const internalPort = await listen(internal)
const evil = '$& $\' $` "><script>alert(1)</script>'
const key = secp256k1.utils.randomSecretKey()
// fid 7's one Farcaster key, for profile looks
const signer = ed25519.utils.randomSecretKey()
const signerHex = '0x' + Buffer.from(ed25519.getPublicKey(signer)).toString('hex')
// fid 9's, for a second account
const signer9 = ed25519.utils.randomSecretKey()
// fid 11's, an account only the stats test signs with
const signer11 = ed25519.utils.randomSecretKey()
const fid7 = { casts: [], profile: [] }
const orAsked = []
const hookHits = []
const node = createServer(async (q, r) => {
  const u = new URL(q.url, 'http://x')
  r.setHeader('content-type', 'application/json')
  // Base: fid 77's card (token 0x4d) is collected, nothing else is
  if (u.pathname === '/rpc') {
    let b = ''
    for await (const c of q) b += c
    const { data } = JSON.parse(b).params[0]
    return r.end(JSON.stringify({ jsonrpc: '2.0', id: 1, ...(data === '0x6352211e' + '4d'.padStart(64, '0') ? { result: '0x' + 'ab'.repeat(20).padStart(64, '0') } : { error: { code: 3, message: 'execution reverted' } }) }))
  }
  // farcaster.xyz's direct casts: echo what arrived, so the relay test can check it
  if (u.pathname === '/v2/get-dc-nonce') return r.end(JSON.stringify({ result: { nonce: 'n1' } }))
  if (u.pathname === '/v2/get-dc-auth-token') return r.end(JSON.stringify({ result: { token: u.searchParams.get('message') === 'hi' && u.searchParams.get('signature')?.length === 132 ? 'fc_dc_test' : null } }))
  // farcaster.xyz Spaces: the login exchange, then echo like the DM endpoints
  if (u.pathname === '/v2/onboarding-state' && q.method === 'PUT') {
    let body = ''
    for await (const c of q) body += c
    const ok = q.headers.authorization === `Bearer eip191:${'A'.repeat(88)}` && JSON.parse(body).authRequest?.method === 'generateToken'
    return r.end(JSON.stringify({ result: { token: ok ? { secret: 'fc_space_test', expiresAt: 5 } : null } }))
  }
  if (u.pathname.startsWith('/v2/direct-cast-') || u.pathname.startsWith('/fc/') || u.pathname.startsWith('/v1/audio-room')) {
    let body = ''
    for await (const c of q) body += c
    return r.end(JSON.stringify({ path: u.pathname, method: q.method, auth: q.headers.authorization, query: u.search, idempotency: q.headers['idempotency-key'], body: body && JSON.parse(body) }))
  }
  // OpenRouter: answers like a chatty free model, and remembers what it was asked
  if (u.pathname === '/or/chat') {
    let body = ''
    for await (const c of q) body += c
    orAsked.push({ auth: q.headers.authorization, body: JSON.parse(body) })
    return r.end(JSON.stringify({ choices: [{ message: { content: 'Sure!\n```json\n{"from": "ja", "text": "Hello from Japan"}\n```' } }] }))
  }
  // Quorum's skin gallery
  if (u.pathname === '/skins') return r.end(JSON.stringify({ has_more: true, total: 2, entries: [{ id: SKIN_ID, name: 'Coffee', base: 'light', installs: 5, author_address: 'Qmx', manifest: 'big' }, { id: '../etc', name: 'bad' }] }))
  if (u.pathname === `/skins/${SKIN_ID}`) return r.end(JSON.stringify({ id: SKIN_ID, manifest: JSON.stringify(SKIN) }))
  if (u.pathname === '/tg/bottg-token/sendMessage') return hookHits.push({ path: u.pathname, body: JSON.parse(await new Promise((ok) => { let b = ''; q.on('data', (c) => (b += c)).on('end', () => ok(b)) })) }), r.end('{"ok":true}')
  if (u.pathname === '/spam/scores') return r.end(JSON.stringify({ [u.searchParams.get('h')]: 0.97 }))
  if (u.pathname === '/spam/users') return r.end(JSON.stringify({ [u.searchParams.get('fid')]: null }))
  if (u.pathname === '/report-hook') return hookHits.push({ path: u.pathname + u.search, body: JSON.parse(await new Promise((ok) => { let b = ''; q.on('data', (c) => (b += c)).on('end', () => ok(b)) })) }), r.end('{"ok":true}')
  // pinnable casts: fid 7 wrote 0x7a…, 0x7b… and 0x7c…, and the reply 0x7d…; asking for a 0x5e… cast finds the node
  // failing, a 0x42… one rate-limited. Another FID's cast is "not found" with a 400, like Hypersnap answers.
  if (u.pathname === '/v1/castById') {
    const hash = u.searchParams.get('hash')
    if (hash === '0x' + '5e'.repeat(20)) return (r.statusCode = 500), r.end('{}')
    if (hash === '0x' + '42'.repeat(20)) return (r.statusCode = 429), r.end('{}')
    const parentCastId = hash === '0x' + '7d'.repeat(20) ? { fid: 9, hash: '0x' + '9a'.repeat(20) } : null
    if (u.searchParams.get('fid') === '7' && ['7a', '7b', '7c', '7d'].some((x) => hash === '0x' + x.repeat(20))) return r.end(JSON.stringify({ hash, data: { fid: 7, castAddBody: { text: 'mine', parentCastId } } }))
    return (r.statusCode = 400), r.end(JSON.stringify({ errCode: 'not_found', details: 'cast not found' }))
  }
  if (u.pathname === '/v1/signersByFid') return r.end(JSON.stringify({ signers: u.searchParams.get('fid') === '7' ? [{ key: signerHex, expiresAt: 4e9 }, { key: '0x' + '11'.repeat(32), expiresAt: 1 }] : u.searchParams.get('fid') === '9' ? [{ key: '0x' + Buffer.from(ed25519.getPublicKey(signer9)).toString('hex') }] : u.searchParams.get('fid') === '11' ? [{ key: '0x' + Buffer.from(ed25519.getPublicKey(signer11)).toString('hex') }] : [] }))
  // @eight's casts, two pages, for finding a cast from a farcaster.xyz link's first digits (the Collect mini app)
  if (u.pathname === '/v2/farcaster/user/by-username' && u.searchParams.get('username') === 'eight') return r.end(JSON.stringify({ user: { fid: 8, username: 'eight' } }))
  if (u.pathname === '/v1/castsByFid' && u.searchParams.get('fid') === '8')
    return r.end(JSON.stringify(u.searchParams.get('pageToken') === 'e2' ? { messages: [{ hash: '0x' + 'e8'.repeat(20) }], nextPageToken: '' } : { messages: [{ hash: '0x' + 'e1'.repeat(20) }], nextPageToken: 'e2' }))
  // fid 7's casts (two pages) and profile, as the account-deletion test sets them
  if (u.pathname === '/v1/castsByFid' && u.searchParams.get('fid') === '7') {
    if (!fid7.casts) return (r.statusCode = 500), r.end('{}')
    const page = u.searchParams.get('pageToken') === 'p2' ? 1 : 0
    return r.end(JSON.stringify({ messages: fid7.casts.slice(page * 2, page * 2 + 2), nextPageToken: page === 0 && fid7.casts.length > 2 ? 'p2' : '' }))
  }
  if (u.pathname === '/v1/userDataByFid' && u.searchParams.get('fid') === '7') return r.end(JSON.stringify({ messages: fid7.profile }))
  // a cast and a profile with characters XML can't hold (a bell, NUL, U+FFFF) in the name, bio and text
  if (u.pathname === '/v2/farcaster/cast' && u.searchParams.get('identifier') === '07'.repeat(20))
    return r.end(JSON.stringify({ cast: { hash: '07'.repeat(20), text: 'ring\u0007 the bell\u0000\uffff', timestamp: '2026-01-01T00:00:00Z', embeds: [], author: { fid: 77, username: 'bell', display_name: '\u0007Bell' }, reactions: {}, replies: {} } }))
  if (u.pathname === '/v2/farcaster/user' && u.searchParams.get('fid') === '77')
    return r.end(JSON.stringify({ user: { fid: 77, username: 'bell', display_name: 'Bell\u0007', custody_address: address(key), profile: { bio: { text: 'ding\u0001 dong\ufffe' } } } }))
  if (u.pathname === '/v2/farcaster/cast')
    return r.end(JSON.stringify({ cast: { hash: u.searchParams.get('identifier'), text: evil, timestamp: '2026-01-01T00:00:00Z', embeds: [{ url: `http://127.0.0.1:${internalPort}/a.png` }], author: { fid: 1, username: 'x', display_name: evil, pfp_url: `http://127.0.0.1:${internalPort}/pfp.png` }, reactions: { likes_count: 0, recasts_count: 0 }, replies: { count: 0 } } }))
  // the signed-out home page's feed: a cast, a reply (left out) and a farcaster.xyz Space (left out)
  if (u.pathname === '/v2/farcaster/feed/trending') return r.end(JSON.stringify({ casts: [
    { hash: '0x' + 'a1'.repeat(20), text: evil + ' see quilcast.com <meta http-equiv="refresh" content="0"> \x1b$B', timestamp: '2026-01-02T00:00:00Z', embeds: [], author: { fid: 2, username: 'ann', display_name: evil, custody_address: '0x' + '22'.repeat(20) }, reactions: { likes_count: 1200, recasts_count: 0 }, replies: { count: 3 } },
    { hash: '0x' + 'a2'.repeat(20), parent_hash: '0x' + 'a1'.repeat(20), text: 'a trending reply', timestamp: '2026-01-02T00:00:00Z', embeds: [], author: { fid: 3, username: 'bob' }, reactions: {}, replies: {} },
    { hash: '0x' + 'a3'.repeat(20), text: 'join my space', timestamp: '2026-01-02T00:00:00Z', embeds: [{ url: 'https://farcaster.xyz/~/spaces/abc' }], author: { fid: 4, username: 'cat' }, reactions: {}, replies: {} },
  ] }))
  // farcaster.xyz's channel directory: /memes under its old-style parent URL, /dev under the usual one
  if (u.pathname === '/v2/all-channels') return r.end(JSON.stringify({ result: { channels: [
    { id: 'memes', url: MEMES, name: 'Memes & <stuff>', description: 'the memes channel', imageUrl: 'https://img.test/memes.png', followerCount: 9 },
    { id: 'dev', url: 'https://farcaster.xyz/~/channel/dev', name: 'Dev', followerCount: 5 },
  ] } }))
  // a channel's casts, only for the URL it really has: a top-level cast and (left out of feeds) a reply
  if (u.pathname === '/v2/farcaster/feed/parent_urls') return r.end(JSON.stringify({ casts: u.searchParams.get('parent_urls') === MEMES ? [
    { hash: '0x' + 'c1'.repeat(20), text: 'a meme <b>&amp;</b>', timestamp: '2026-01-03T00:00:00Z', parent_url: MEMES, author: { fid: 3, username: 'bob', display_name: 'Bob' }, embeds: [{ url: 'https://img.test/meme.png' }] },
    { hash: '0x' + 'c2'.repeat(20), parent_hash: '0x' + 'c1'.repeat(20), text: 'a reply in memes', timestamp: '2026-01-04T00:00:00Z', author: { fid: 4, username: 'cat' } },
  ] : [] }))
  // @six mostly replies, so their feed reads a second page; while sixDown their casts fail
  if (u.pathname === '/v2/farcaster/user/by-username' && u.searchParams.get('username') === 'six') return r.end(JSON.stringify({ user: { fid: 6, username: 'six', custody_address: address(key) } }))
  if (u.pathname === '/v2/farcaster/feed/user/casts' && u.searchParams.get('fid') === '6') {
    if (sixDown) return (r.statusCode = 500), r.end('{}')
    const later = u.searchParams.get('cursor') === 'p2'
    const c = (b, top) => ({ hash: '0x' + b.repeat(20), text: `${top ? 'top' : 'reply'} ${b}`, timestamp: `2026-01-${later ? '01' : '02'}T00:00:${b}Z`, author: { fid: 6, username: 'six' }, ...(!top && { parent_hash: '0x' + 'ab'.repeat(20) }) })
    return r.end(JSON.stringify(later ? { casts: [c('51', true), c('52')] } : { casts: [c('41', true), c('42'), c('43')], next: { cursor: 'p2' } }))
  }
  // fid 5 has no fname, so no profile casts or feed
  if (u.pathname === '/v2/farcaster/user' && u.searchParams.get('fid') === '5') return r.end(JSON.stringify({ user: { fid: 5, username: 'fid:5', custody_address: address(key) } }))
  // a profile page's latest casts; nobody is called "nobody"
  if (u.pathname === '/v2/farcaster/feed/user/casts') return r.end(JSON.stringify({ casts: [{ hash: 'ef'.repeat(20), text: evil, timestamp: '2026-01-02T00:00:00Z', author: { fid: 1 } }, { hash: '12'.repeat(20), parent_hash: 'ab'.repeat(20), text: 'a reply', timestamp: '2026-01-01T00:00:00Z' }] }))
  if (u.searchParams.get('username') === 'nobody') return (r.statusCode = 404), r.end('{"message":"User not found"}')
  if (u.pathname === '/v2/farcaster/user/search') return r.end('{"users":[]}')
  if (u.pathname.startsWith('/v2/farcaster/user')) return r.end(JSON.stringify({ user: { fid: 1, username: 'x', display_name: 'X', custody_address: address(key), profile: { bio: { text: evil } } } }))
  r.statusCode = 404
  r.end('{}')
})
// a Quorum skin with an inline wallpaper (a real 1×1 PNG), a fake "PNG" button and a font that isn't one
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const SKIN_ID = 'Qm' + 'a'.repeat(44)
const SKIN = {
  schemaVersion: 1, id: '', meta: { name: 'Coffee' }, base: 'light', frame: { corner: 'square', panelGlow: true },
  colors: { light: { accent: '#FFD700', surface1: '#fbf6ec', textMain: '#403425', textMuted: 'rgba(168, 153, 126, 0.5)' } },
  wallpaper: { source: { dataUri: `data:image/png;base64,${PNG}` }, fit: 'tile', scrimOpacity: 0.5, surfaceAlpha: 0.8 },
  surfaces: { button: { background: `data:image/png;base64,${Buffer.from('<svg onload=alert(1)>').toString('base64')}` } },
  font: { family: 'x', weights: 'static-single', source: { dataUri: 'data:font/ttf;base64,' + Buffer.from('not a font at all').toString('base64') } },
  borders: { scale: 2.2 }, fontScale: 1.25, spacing: { scale: 2 },
}
let sixDown = true
const MEMES = 'chain://eip155:1/erc721:0xfd8427165df67df6d7fd689ae67c8ebf56d9ca61'
const nodePort = await listen(node)
const media = await mkdtemp(join(tmpdir(), 'qc-media-'))
await writeFile(join(media, '0123456789abcdef01234567.png'), Buffer.from('0123456789'))
// a real picture someone uploaded before uploads were recorded (0.36.0), named after its content as uploads are
const OLD_PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.from([0, 0, 0, 1, 0, 0, 0, 1]), Buffer.alloc(40, 99)])
const OLD_NAME = `${createHash('sha256').update(OLD_PNG).digest('hex').slice(0, 24)}.png`
await writeFile(join(media, OLD_NAME), OLD_PNG)
// and one 0.36–0.39 recorded as fid 7's alone (a re-upload then replaced someone else's file and kept only its uploader)
const PRE_NAME = `${'6'.repeat(24)}.png`
await writeFile(join(media, PRE_NAME), OLD_PNG)
await mkdir(join(media, 'owners'))
await writeFile(join(media, 'owners', '7'), PRE_NAME + '\n')
const port = 40000 + Math.floor(Math.random() * 20000)
const base = `http://127.0.0.1:${port}`
let srv
// moves the server's clock on by ms (testclock.mjs)
const later = (ms) => new Promise((ok) => (srv.once('message', ok), srv.send(ms)))
before(async () => {
  srv = spawn(process.execPath, ['--import', new URL('./testclock.mjs', import.meta.url).pathname, new URL('./index.mjs', import.meta.url).pathname], { env: { ...process.env, PORT: String(port), NODE_URL: `http://127.0.0.1:${nodePort}`, BASE_RPC: `http://127.0.0.1:${nodePort}/rpc`, FC_URL: `http://127.0.0.1:${nodePort}`, FARCASTER_API_URL: `http://127.0.0.1:${nodePort}`, MEDIA_DIR: media, FREE_FLOOR: '0', UPLOAD_IDLE_MS: '60000', SITE_URL: 'https://quilcast.test', QUORUM_URL: `http://127.0.0.1:${nodePort}`, OPENROUTER_API_KEY: 'test-key', OPENROUTER_URL: `http://127.0.0.1:${nodePort}/or/chat`, REPORT_WEBHOOK: `http://127.0.0.1:${nodePort}/report-hook?to=mods`, TELEGRAM_API: `http://127.0.0.1:${nodePort}/tg`, TELEGRAM_BOT_TOKEN: 'tg-token', TELEGRAM_CHAT_ID: '76', SPAM_URL: `http://127.0.0.1:${nodePort}/spam` }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  for (let i = 0; i < 50; i++) {
    if (await fetch(base + '/health').then((r) => r.ok, () => false)) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('server did not start')
})
after(() => (srv.kill(), internal.close(), node.close()))

test('malformed percent-encoding is a 400, not a crash', async () => {
  assert.equal((await fetch(base + '/%E0%A4%A')).status, 400)
  assert.equal(await (await fetch(base + '/health')).text(), 'ok')
})

test('text goes out compressed when the client takes it', async () => {
  const js = (await (await fetch(base + '/')).text()).match(/\/assets\/index-[\w-]+\.js/)?.[0]
  for (const path of ['/', js]) {
    const r = await fetch(base + path, { headers: { 'accept-encoding': 'br' } })
    assert.equal(r.headers.get('content-encoding'), 'br', path)
    assert.ok((await r.text()).length > 1024, path)
  }
  assert.equal((await fetch(base + js, { headers: { 'accept-encoding': 'identity' } })).headers.get('content-encoding'), null)
})

test('security headers on every page', async () => {
  const r = await fetch(base + '/')
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/)
  // only Quilcast itself and Farcaster and Base clients may frame it, as a mini app
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'self' https:\/\/farcaster\.xyz /)
  assert.doesNotMatch(r.headers.get('content-security-policy'), /frame-ancestors[^;]*(\*[; ]|https:[; ])/)
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff')
})

test('cast and profile meta tags escape user text, including $ replacement patterns', async () => {
  const hash = 'ab'.repeat(20)
  for (const path of [`/c/${hash}`, `/u/${encodeURIComponent('x"><script>alert(1)</script>')}`]) {
    const html = await (await fetch(base + path)).text()
    assert.ok(!html.includes('<script>alert'), path)
    assert.equal(html.match(/<title>/g).length, 1, path)
    assert.equal(html.match(/<meta property="og:title"/g).length, 1, path)
    assert.ok(!/canonical" href="[^"]*"[^ /]/.test(html), path)
  }
})

test('profile pages: their own head, ProfilePage JSON-LD, plain HTML casts, a share card; unknown names are a 404', async () => {
  const html = await (await fetch(base + '/u/X')).text()
  assert.match(html, /<title>X \(@x\) on Farcaster · Quilcast<\/title>/)
  assert.match(html, /<link rel="canonical" href="https:\/\/quilcast\.test\/u\/x" \/>/)
  const desc = html.match(/<meta name="description" content="([^"]*)"/)[1].replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
  assert.ok(desc.length <= 160 && desc.endsWith("Read @x's latest casts on Quilcast."), desc)
  const ld = JSON.parse(html.match(/<script type="application\/ld\+json">(\{"@context.*?)<\/script>/)[1])
  assert.equal(ld['@type'], 'ProfilePage')
  assert.equal(ld.mainEntity.alternateName, '@x')
  assert.equal(ld.mainEntity.description.slice(0, 5), '$& $\'')
  const app = html.match(/<div id="app">(<section class="ssr">[\s\S]*?<\/section>)<\/div>/)[1]
  assert.match(app, /<h1>X<\/h1>/)
  assert.match(app, new RegExp(`<a href="/c/${'ef'.repeat(20)}"><time datetime="2026-01-02T00:00:00.000Z">Jan 2, 2026</time></a>`))
  assert.match(app, /Reply<\/div><p class="text">a reply<\/p>/)
  assert.ok(!html.includes('noindex'))
  const card = await fetch(html.match(/<meta property="og:image" content="([^"]*)"/)[1].replace('https://quilcast.test', base))
  assert.equal(card.headers.get('content-type'), 'image/png')
  const none = await fetch(base + '/u/nobody')
  assert.equal(none.status, 404)
  assert.match(await none.text(), /<meta name="robots" content="noindex, follow" \/>/)
  const list = await (await fetch(base + '/u/x/followers')).text()
  assert.ok(list.includes('noindex') && !list.includes('rel="canonical"'))
})

test('the home page arrives with the signed-out feed drawn in, its style and scripts allowed by hash', async () => {
  const r = await fetch(base + '/')
  const html = await r.text()
  const csp = r.headers.get('content-security-policy')
  const app = html.match(/<div id="app">(<div class="app ssr-home">[\s\S]*?)<script type="application\/json"/)?.[1]
  assert.ok(app, 'drawn in')
  assert.equal(app.match(/<article class="cast"/g).length, 1)
  assert.ok(!app.includes('trending reply') && !app.includes('join my space'))
  assert.ok(!app.includes('<script>alert') && app.includes('&#60;script&#62;alert(1)'))
  assert.match(app, /<a href="https:\/\/quilcast\.com\/" target="_blank" rel="noopener noreferrer nofollow">quilcast\.com<\/a>/)
  assert.match(app, /<span>1\.2K<\/span>/)
  const boot = JSON.parse(html.match(/<script type="application\/json" id="boot">(.*?)<\/script>/s)[1])
  assert.deepEqual(boot.casts.map((c) => c.hash), ['0x' + 'a1'.repeat(20)])
  assert.equal(boot.casts[0].author.custody_address, undefined)
  const hash = (s) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`
  // the app's stylesheet and the cards' sizes, inline
  const css = html.match(/<style>([\s\S]*?)<\/style>/)[1]
  assert.ok(!/<link rel="stylesheet"/.test(html) && csp.includes(hash(css)))
  // every inline script (the head's account check, the folds' "Show more") is allowed by its hash
  for (const [, js] of html.matchAll(/<script>([^<]*)<\/script>/g)) assert.ok(csp.includes(hash(js)), js.slice(0, 40))
  // browsing as someone (#490) is the bare app, which draws their feed instead of the signed-out one
  const as = await (await fetch(base + '/?as=dwr')).text()
  assert.ok(as.includes('<div id="app">') && !as.includes('ssr-home') && !as.includes('id="boot"'))
})

test('scripts/verify.mjs finds the server serving exactly its build: every file, and only its scripts on the home page (folds and all), an app page and About', async () => {
  const home = await (await fetch(base + '/')).text()
  assert.match(home, /<script>\(function\(s\)/)
  // a cast's text may say "http-equiv" and hold an ESC: the page drops the ESC, and the text is no <meta> (#476 review)
  assert.ok(home.includes('&#60;meta http-equiv=') && !home.includes('\x1b'))
  // never an hour-old /build.json, as it names the build the pages load
  assert.equal((await fetch(base + '/build.json')).headers.get('cache-control'), 'no-cache')
  const v = await verify({ site: base, dist: fileURLToPath(new URL('../dist/', import.meta.url)) })
  assert.deepEqual(v.problems, [])
})

test('casts are mini app embeds with a 3:2 card', async () => {
  const hash = 'cd'.repeat(20)
  const meta = (await (await fetch(`${base}/c/${hash}`)).text()).match(/<meta name="fc:miniapp" content="([^"]*)"/)[1]
  const e = JSON.parse(meta.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)))
  assert.equal(e.button.action.url, `https://quilcast.test/c/${hash}`)
  const png = Buffer.from(await (await fetch(e.imageUrl.replace('https://quilcast.test', base))).arrayBuffer())
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1200, 800])
})

test('a collected cast: square art, metadata the mini app can read, the cast kept on disk, and the collection', async () => {
  const hash = 'cd'.repeat(20)
  const r = await fetch(`${base}/nft/0x${hash}`)
  assert.equal(r.headers.get('access-control-allow-origin'), '*')
  const m = await r.json()
  assert.equal(m.image, `https://quilcast.test/nft/0x${hash}.png`)
  assert.equal(m.external_url, `https://quilcast.test/c/${hash}`)
  assert.ok(m.attributes.some((a) => a.trait_type === 'Author'))
  const png = Buffer.from(await (await fetch(`${base}/nft/0x${hash}.png`)).arrayBuffer())
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1200, 1200])
  assert.ok(existsSync(join(media, 'nft', `${hash}.json`)))
  assert.equal((await (await fetch(`${base}/nft/collection.json`)).json()).name, 'Quilcast Collect')
})

test('collect.quilcast.com: the mini app, a page per cast whose link shows its NFT, and only its own files', async () => {
  const hash = 'cd'.repeat(20)
  const get = (path) => new Promise((ok, no) => request({ host: '127.0.0.1', port, path, headers: { host: 'collect.quilcast.com' } }, (r) => {
    const parts = []
    r.on('data', (d) => parts.push(d)).on('end', () => ok({ status: r.statusCode, headers: r.headers, body: Buffer.concat(parts).toString() }))
  }).on('error', no).end())
  const page = await get(`/c/${hash}`)
  assert.match(page.headers['content-security-policy'], /frame-ancestors \*/)
  const e = JSON.parse(page.body.match(/<meta name="fc:miniapp" content="([^"]*)"/)[1].replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)))
  assert.equal(e.button.action.url, `https://collect.quilcast.com/c/${hash}`)
  assert.match(e.imageUrl, new RegExp(`^https://quilcast\\.test/nft/0x${hash}\\.3x2\\.png\\?v=`))
  assert.match(page.body, new RegExp(`<meta property="og:image" content="https://quilcast\\.test/nft/0x${hash}\\.og\\.png`))
  // what ?cast= opened before is the same page
  assert.equal((await get(`/?cast=${hash}`)).body, page.body)
  assert.equal((await get('/app.js')).headers['content-type'], 'text/javascript')
  assert.equal((await get('/.well-known/farcaster.json')).headers['access-control-allow-origin'], '*')
  for (const path of ['/index.html', '/../server/index.mjs', '/nope']) assert.equal((await get(path)).status, 404, path)
  for (const [kind, h] of [['3x2', 800], ['og', 630]]) {
    const png = Buffer.from(await (await fetch(`${base}/nft/0x${hash}.${kind}.png`)).arrayBuffer())
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1200, h], kind)
  }
})

test('collect.quilcast.com finds a pasted cast link: a full hash anywhere in it, or a farcaster.xyz link by its first digits', async () => {
  const find = (link) => new Promise((ok, no) => request({ host: '127.0.0.1', port, path: `/api/find?url=${encodeURIComponent(link)}`, headers: { host: 'collect.quilcast.com' } }, (r) => {
    let b = ''
    r.on('data', (d) => (b += d)).on('end', () => ok(JSON.parse(b).hash))
  }).on('error', no).end())
  assert.equal(await find(`https://quilcast.com/c/${'cd'.repeat(20)}`), 'cd'.repeat(20))
  assert.equal(await find(`0x${'cd'.repeat(20)}`), 'cd'.repeat(20))
  // on the second page of @eight's casts; warpcast.com links are the same
  assert.equal(await find(`https://farcaster.xyz/eight/0x${'e8'.repeat(4)}`), 'e8'.repeat(20))
  assert.equal(await find(`https://warpcast.com/eight/0x${'e8'.repeat(4)}?x=1`), 'e8'.repeat(20))
  for (const link of [`https://farcaster.xyz/eight/0x${'ab'.repeat(4)}`, 'https://example.com/eight/0xe8e8e8e8', 'hello']) assert.equal(await find(link), undefined, link)
})

test('RSS feeds: an account\'s casts (replies on request) and a channel\'s under its old-style URL, escaped, advertised by their pages', async () => {
  const rssType = 'application/rss+xml; charset=utf-8'
  const page = await (await fetch(base + '/u/X')).text()
  assert.match(page, /<link rel="alternate" type="application\/rss\+xml" title="X \(@x\) on Quilcast" href="https:\/\/quilcast\.test\/u\/x\/rss" \/>/)
  const r = await fetch(base + '/u/X/rss')
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('content-type'), rssType)
  assert.match(r.headers.get('cache-control'), /max-age=600/)
  const feed = await r.text()
  assert.match(feed, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<rss version="2\.0"/)
  assert.match(feed, /<atom:link href="https:\/\/quilcast\.test\/u\/x\/rss" rel="self"/)
  // the bio and cast text are user content: nothing of theirs comes out as markup
  assert.ok(!feed.includes('<script'), feed)
  assert.match(feed, /<description>\$&amp; \$&apos; \$` &quot;&gt;&lt;script&gt;/)
  assert.equal(feed.match(/<item>/g).length, 1)
  assert.match(feed, new RegExp(`<link>https://quilcast\\.test/c/${'ef'.repeat(20)}</link><guid isPermaLink="true">https://quilcast\\.test/c/${'ef'.repeat(20)}</guid>`))
  // compressed (kept with the feed, not in dist/'s cache), the same feed again
  assert.ok(Buffer.byteLength(feed) > 1024)
  for (const enc of ['br', 'gzip', 'br']) {
    const z = await fetch(base + '/u/X/rss', { headers: { 'accept-encoding': enc } })
    assert.equal(z.headers.get('content-encoding'), enc)
    assert.equal(await z.text(), feed)
  }
  const all = await (await fetch(base + '/u/x/rss?replies=1')).text()
  assert.equal(all.match(/<item>/g).length, 2)
  assert.match(all, /<title>a reply<\/title>/)
  // characters XML can't hold never reach a reader
  const bell = await (await fetch(base + '/u/77/rss')).text()
  assert.match(bell, /<title>Bell \(@bell\) on Farcaster<\/title>/)
  assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/.test(bell))
  // a nameless account: no feed, and its page doesn't offer one; nor does anyone who doesn't exist
  assert.equal((await fetch(base + '/u/5/rss')).status, 404)
  assert.ok(!(await (await fetch(base + '/u/5')).text()).includes('application/rss+xml'))
  assert.equal((await fetch(base + '/u/nobody/rss')).status, 404)
  // a node failure is a 502 a reader retries, and isn't kept
  const down = await fetch(base + '/u/six/rss')
  assert.equal(down.status, 502)
  assert.equal(down.headers.get('retry-after'), '60')
  sixDown = false
  // someone who mostly replies: the second page fills their feed, newest first
  const six = await (await fetch(base + '/u/six/rss')).text()
  assert.deepEqual([...six.matchAll(/<title>(top \d+)<\/title>/g)].map((m) => m[1]), ['top 41', 'top 51'])

  // /memes casts under chain://…, which only the directory knows
  const chPage = await (await fetch(base + '/channel/memes')).text()
  assert.match(chPage, /<link rel="alternate" type="application\/rss\+xml" title="Memes &#38; &#60;stuff&#62; \(\/memes\) on Quilcast" href="https:\/\/quilcast\.test\/channel\/memes\/rss" \/>/)
  const ch = await fetch(base + '/channel/memes/rss')
  assert.equal(ch.headers.get('content-type'), rssType)
  const chFeed = await ch.text()
  assert.match(chFeed, /<title>Memes &amp; &lt;stuff&gt; \(\/memes\) on Farcaster<\/title>/)
  assert.match(chFeed, /<image><url>https:\/\/img\.test\/memes\.png<\/url>/)
  assert.equal(chFeed.match(/<item>/g).length, 1)
  assert.match(chFeed, /<dc:creator>Bob \(@bob\)<\/dc:creator>/)
  assert.match(chFeed, /<title>a meme &lt;b&gt;&amp;amp;&lt;\/b&gt;<\/title>/)
  assert.match(chFeed, /&lt;img src=&quot;https:\/\/img\.test\/meme\.png&quot;/)
  assert.equal((await (await fetch(base + '/channel/dev/rss')).text()).match(/<item>/g), null)
  assert.equal((await fetch(base + '/channel/nowhere/rss')).status, 404)
})

test('a profile card: square art, metadata, the profile kept once collected, its page and a profile link found', async () => {
  const r = await fetch(`${base}/nft/card/77`)
  assert.equal(r.headers.get('access-control-allow-origin'), '*')
  const m = await r.json()
  assert.equal(m.image, 'https://quilcast.test/nft/card/77.png')
  assert.ok(m.attributes.some((a) => a.trait_type === 'Rarity' && a.value === 'Legendary'))
  // collected (the mock Base says so), so it's kept as it is now
  assert.ok(existsSync(join(media, 'nft', 'card-77.json')))
  for (const [kind, h] of [['', 1200], ['.3x2', 800], ['.og', 630]]) {
    const png = Buffer.from(await (await fetch(`${base}/nft/card/77${kind}.png`)).arrayBuffer())
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1200, h], kind)
  }
  assert.equal((await fetch(`${base}/nft/card/0`)).status, 404)
  assert.equal((await (await fetch(`${base}/nft/cards.json`)).json()).name, 'Quilcast Cards')
  const get = (path) => new Promise((ok, no) => request({ host: '127.0.0.1', port, path, headers: { host: 'collect.quilcast.com' } }, (r) => {
    let b = ''
    r.on('data', (d) => (b += d)).on('end', () => ok(b))
  }).on('error', no).end())
  const page = await get('/p/77')
  const e = JSON.parse(page.match(/<meta name="fc:miniapp" content="([^"]*)"/)[1].replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)))
  assert.equal(e.button.action.url, 'https://collect.quilcast.com/p/77')
  assert.match(e.imageUrl, /^https:\/\/quilcast\.test\/nft\/card\/77\.3x2\.png\?v=abababab$/)
  assert.match(page, /<title>@bell&#39;s card, collected by/)
  assert.equal(await get('/?fid=77'), page)
  for (const link of ['https://farcaster.xyz/eight', 'https://quilcast.com/u/eight', '@eight', 'eight']) assert.equal(JSON.parse(await get(`/api/find?url=${encodeURIComponent(link)}`)).fid, 8, link)
})

test('a control character in a name, bio or cast still gets the full card', async () => {
  for (const path of [`/og/c/${'07'.repeat(20)}.png`, `/og/c/${'07'.repeat(20)}.3x2.png`, '/og/u/77.png']) {
    const r = await fetch(base + path)
    assert.equal(r.headers.get('content-type'), 'image/png', path)
    const png = Buffer.from(await r.arrayBuffer())
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1200, path.includes('3x2') ? 800 : 630], path)
  }
  // the pages' own tags drop them too
  const html = await (await fetch(`${base}/c/${'07'.repeat(20)}`)).text()
  assert.ok(!/[\0-\x08\x0b\x0c\x0e-\x1f\uffff]/.test(html))
  assert.match(html, /<meta property="og:title" content="Bell \(@bell\) on Quilcast"/)
})

test('any page opens itself as a mini app', async () => {
  const meta = (await (await fetch(`${base}/search`)).text()).match(/<meta name="fc:miniapp" content="([^"]*)"/)[1]
  assert.equal(JSON.parse(meta.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))).button.action.url, 'https://quilcast.test/search')
})

test('card images never reach private addresses', async () => {
  internalHits = 0
  const r = await fetch(`${base}/og/c/${'cd'.repeat(20)}.png`)
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('content-type'), 'image/png')
  assert.equal(internalHits, 0)
  assert.equal(await (await fetch(`${base}/api/unfurl?url=${encodeURIComponent(`http://127.0.0.1:${internalPort}/`)}`)).json(), null)
  assert.equal(internalHits, 0)
})

test('media is served inert, with sane ranges', async () => {
  const f = `${base}/m/0123456789abcdef01234567.png`
  const r = await fetch(f)
  assert.equal(r.status, 200)
  assert.match(r.headers.get('content-security-policy'), /sandbox/)
  assert.equal((await fetch(f, { headers: { range: 'bytes=5-2' } })).status, 416)
  const tail = await fetch(f, { headers: { range: 'bytes=-3' } })
  assert.equal(tail.status, 206)
  assert.equal(await tail.text(), '789')
  assert.equal((await fetch(`${base}/m/0123456789abcdef01234567.html`)).status, 404)
})

test('Markdown pictures come through /api/img only from public addresses', async () => {
  for (const u of ['http://127.0.0.1:1/a.png', 'http://192.168.1.1/a.png', 'javascript:alert(1)', 'file:///etc/passwd', '']) assert.equal((await fetch(`${base}/api/img?u=${encodeURIComponent(u)}`)).status, 400, u)
})

test('upload start rejects prototype keys and unknown types', async () => {
  for (const type of ['__proto__', 'constructor', 'text/html', 'image/svg+xml'])
    assert.equal((await fetch(base + '/api/upload', { method: 'POST', headers: { 'content-type': type, 'x-size': '10' } })).status, 415, type)
})

// the farcaster.xyz login request uploads are signed with, as write.ts builds it
const login = (ts, highS = false) => {
  const exp = ts + 600e3
  const msg = Buffer.from(`{"method":"generateToken","params":{"expiresAt":${exp},"timestamp":${ts}}}`)
  let { rs, v } = ecSign(keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${msg.length}`), msg])), key)
  if (highS) {
    // the same signature re-encoded: s → n - s with the other recovery bit, still valid for the same signer
    const n = secp256k1.Point.CURVE().n
    const s = (n - BigInt('0x' + Buffer.from(rs.slice(32)).toString('hex'))).toString(16).padStart(64, '0')
    rs = Buffer.concat([Buffer.from(rs.slice(0, 32)), Buffer.from(s, 'hex')])
    v ^= 1
  }
  return { authorization: `Bearer eip191:${Buffer.from([...rs, v + 27]).toString('base64')}`, 'x-auth-request': JSON.stringify({ method: 'generateToken', params: { timestamp: ts, expiresAt: exp } }) }
}

test('an upload signature works once, also when re-encoded, and the file lands on the volume', async () => {
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.from([0, 0, 0, 1, 0, 0, 0, 1]), Buffer.alloc(40)])
  const start = (auth) => fetch(base + '/api/upload', { method: 'POST', headers: { 'content-type': 'image/png', 'x-size': String(png.length), 'x-fid': '1', ...auth } })
  const ts = Date.now()
  const r = await start(login(ts))
  assert.equal(r.status, 200)
  const { id } = await r.json()
  assert.equal((await start(login(ts))).status, 401)
  assert.equal((await start(login(ts, true))).status, 401)
  assert.equal((await fetch(`${base}/api/upload/${id}?offset=0`, { method: 'PUT', body: png })).status, 200)
  let st = await (await fetch(`${base}/api/upload/${id}/done`, { method: 'POST' })).json()
  for (let i = 0; i < 50 && st.state === 'sending'; i++) await new Promise((r) => setTimeout(r, 100)), (st = await (await fetch(`${base}/api/upload/${id}`)).json())
  assert.equal(st.state, 'ready')
  assert.match(st.url, /^https:\/\/quilcast\.test\/m\/[0-9a-f]{24}\.png$/)
  // giving up on it now changes nothing (#407)
  assert.equal((await (await fetch(`${base}/api/upload/${id}`, { method: 'DELETE' })).json()).state, 'ready')
})

test('an upload signed by one of the account\'s keys works once; a key the node doesn\'t list, or none, is refused', async () => {
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.from([0, 0, 0, 1, 0, 0, 0, 2]), Buffer.alloc(40)])
  // as write.ts keySigned builds it
  const signed = (k, ts) => ({ 'x-key': '0x' + Buffer.from(ed25519.getPublicKey(k)).toString('hex'), 'x-ts': String(ts), 'x-sig': Buffer.from(ed25519.sign(Buffer.from(`quilcast-upload:7:${ts}:`), k)).toString('hex') })
  const start = (auth) => fetch(base + '/api/upload', { method: 'POST', headers: { 'content-type': 'image/png', 'x-size': String(png.length), 'x-fid': '7', ...auth } })
  const ts = Date.now()
  const r = await start(signed(signer, ts))
  assert.equal(r.status, 200)
  assert.equal((await start(signed(signer, ts))).status, 401)
  assert.equal((await start(signed(ed25519.utils.randomSecretKey(), ts + 1))).status, 403)
  assert.equal((await start(signed(signer, ts - 600e3))).status, 401)
  assert.equal((await start({})).status, 401)
  const { id } = await r.json()
  assert.equal((await fetch(`${base}/api/upload/${id}?offset=0`, { method: 'PUT', body: png })).status, 200)
  let st = await (await fetch(`${base}/api/upload/${id}/done`, { method: 'POST' })).json()
  for (let i = 0; i < 50 && st.state === 'sending'; i++) await new Promise((r) => setTimeout(r, 100)), (st = await (await fetch(`${base}/api/upload/${id}`)).json())
  assert.equal(st.state, 'ready')
  assert.match(st.url, /^https:\/\/quilcast\.test\/m\/[0-9a-f]{24}\.png$/)
})

test('an upload given up on stops holding one of the account\'s 3 places: at once when cancelled, after a while idle (#407)', async () => {
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.from([0, 0, 0, 1, 0, 0, 0, 3]), Buffer.alloc(40)])
  // timestamps of their own, and an address of its own so these starts don't eat into the other tests' rate limit
  let ts = Date.now() - 120e3
  const start = () => fetch(base + '/api/upload', { method: 'POST', headers: { 'content-type': 'image/png', 'x-size': String(png.length), 'x-fid': '7', 'x-forwarded-for': '203.0.113.7', 'x-key': signerHex, 'x-ts': String(ts), 'x-sig': Buffer.from(ed25519.sign(Buffer.from(`quilcast-upload:7:${ts++}:`), signer)).toString('hex') } })
  const open = async () => {
    const r = await start()
    assert.equal(r.status, 200)
    return (await r.json()).id
  }
  const put = (id, offset, body) => fetch(`${base}/api/upload/${id}?offset=${offset}`, { method: 'PUT', body })
  const state = async (id) => (await (await fetch(`${base}/api/upload/${id}`)).json())
  const [a, b, c] = [await open(), await open(), await open()]
  assert.equal((await put(a, 0, png.subarray(0, 20))).status, 200)
  assert.equal((await start()).status, 429)
  // the browser gave up on a partway: its place frees at once, and it takes no more chunks
  assert.equal((await fetch(`${base}/api/upload/${a}`, { method: 'DELETE' })).status, 200)
  assert.deepEqual(await state(a), { state: 'failed', received: 20, size: png.length, error: 'Upload cancelled' })
  assert.equal((await put(a, 20, png.subarray(20))).status, 404)
  const d = await open()
  assert.equal((await start()).status, 429)
  // b and c never hear from their browser again (the network went); d keeps sending, more slowly than the idle limit
  // (UPLOAD_IDLE_MS, a minute here) between its start and its finish, but never that long between two chunks. A new
  // upload that finds the account full makes the idle ones give way. The server's clock is moved on, not waited for
  await later(40e3)
  assert.equal((await put(d, 0, png.subarray(0, 10))).status, 200)
  await later(30e3)
  // idle as they are, b and c keep their places while nothing else needs them (a phone may only have paused the tab)
  for (const id of [b, c]) assert.equal((await state(id)).state, 'receiving')
  // one gives way per new upload, the one idle longest
  const e = await open()
  assert.equal((await state(b)).state, 'failed')
  assert.equal((await state(c)).state, 'receiving')
  const f = await open()
  assert.equal((await start()).status, 429)
  for (const id of [b, c]) assert.deepEqual(await state(id), { state: 'failed', received: 0, size: png.length, error: 'Upload timed out' })
  assert.equal((await put(d, 10, png.subarray(10))).status, 200)
  assert.deepEqual(await state(d), { state: 'receiving', received: png.length, size: png.length })
  // (not finished: a file fid 7 alone put here would change what deleting its account finds below; an unknown upload
  // can't be cancelled, and a finished one isn't, see the test above)
  assert.equal((await fetch(`${base}/api/upload/${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}`, { method: 'DELETE' })).status, 404)
  for (const id of [d, e, f]) assert.equal((await fetch(`${base}/api/upload/${id}`, { method: 'DELETE' })).status, 200)
})

test('reports: kept and sent to the webhook, anonymous or signed by the reporter\'s key', async () => {
  const send = (r, headers = {}) => fetch(base + '/api/report', { method: 'POST', body: typeof r === 'string' ? r : JSON.stringify(r), headers })
  const hash = '0x' + 'ab'.repeat(20)
  assert.equal((await send({ fid: 9, hash, reason: 'nope' })).status, 400)
  assert.equal((await send({ fid: 0, reason: 'spam' })).status, 400)
  assert.equal((await send({ fid: 9, hash: 'x', reason: 'spam' })).status, 400)
  assert.equal((await fetch(base + '/api/report')).status, 405)
  assert.equal((await send({ fid: 9, hash, reason: 'abuse', text: 'mean' })).status, 200)
  const body = JSON.stringify({ fid: 9, reason: 'spam' })
  const ts = Date.now()
  const signed = (key, what = 'quilcast-report') => ({ 'x-fid': '7', 'x-key': '0x' + Buffer.from(ed25519.getPublicKey(key)).toString('hex'), 'x-ts': String(ts), 'x-sig': Buffer.from(ed25519.sign(Buffer.from(`${what}:7:${ts}:${body}`), key)).toString('hex') })
  assert.equal((await send(body, signed(ed25519.utils.randomSecretKey()))).status, 403)
  assert.equal((await send(body, signed(signer, 'quilcast-look'))).status, 401)
  assert.equal((await send(body, signed(signer))).status, 200)
  for (let i = 0; i < 50 && hookHits.length < 2; i++) await new Promise((r) => setTimeout(r, 50))
  assert.deepEqual(hookHits.map((h) => h.path), ['/report-hook?to=mods', '/report-hook?to=mods'])
  assert.match(hookHits[0].body.text, /Harassment or hate[\s\S]*\/c\/0xabab[\s\S]*From: signed out[\s\S]*mean/)
  assert.match(hookHits[1].body.text, /Spam[\s\S]*Account: https:\/\/quilcast\.test\/u\/9[\s\S]*From: https:\/\/quilcast\.test\/u\/7/)
  // Not spam goes to Telegram (@frdy_bot), not the webhook, with the cast's and the account's scores
  assert.equal((await send({ fid: 9, hash, reason: 'not_spam' })).status, 200)
  for (let i = 0; i < 50 && hookHits.length < 3; i++) await new Promise((r) => setTimeout(r, 50))
  assert.equal(hookHits[2].path, '/tg/bottg-token/sendMessage')
  assert.equal(hookHits[2].body.chat_id, '76')
  assert.match(hookHits[2].body.text, /isn't spam[\s\S]*\/c\/0xabab\S* \(spam 97%\)[\s\S]*\/u\/9 \(spam account not scored yet\)[\s\S]*spam\/\?c=0xabab/)
})

test('the DM relay carries the token to the direct-cast endpoints and nowhere else', async () => {
  const call = (op, init) => fetch(`${base}/api/dm/${op}`, init)
  assert.equal((await (await call('nonce')).json()).result.nonce, 'n1')
  // the signed message is exchanged from a POST body, never a URL
  const token = (body) => call('token', { method: 'POST', body: JSON.stringify(body) })
  assert.equal((await (await token({ message: 'hi', signature: '0x' + 'ab'.repeat(65) })).json()).result.token, 'fc_dc_test')
  assert.equal((await token({ message: 'hi', signature: 'nope' })).status, 400)
  assert.equal((await call('token?message=hi')).status, 405)
  const auth = { authorization: 'Bearer fc_dc_test_token' }
  const inbox = await (await call('inbox?category=request&limit=5&fid=1', { headers: auth })).json()
  assert.deepEqual([inbox.path, inbox.auth, inbox.query], ['/v2/direct-cast-inbox', 'Bearer fc_dc_test_token', '?category=request&limit=5'])
  assert.equal((await call('inbox')).status, 401)
  for (const op of ['me', 'auth', '__proto__', 'constructor']) assert.equal((await call(op, { headers: auth })).status, 404, op)
  assert.equal((await call('send', { headers: auth })).status, 405)
  const sent = await (await call('send', { method: 'PUT', headers: auth, body: JSON.stringify({ message: 'yo' }) })).json()
  assert.deepEqual([sent.path, sent.method, sent.body], ['/fc/message', 'PUT', { message: 'yo' }])
  assert.ok(sent.idempotency)
  const muted = await (await call('mute', { method: 'POST', headers: auth, body: JSON.stringify({ conversationId: 'c', muted: true }) })).json()
  assert.deepEqual([muted.path, muted.body], ['/v2/direct-cast-conversation-notifications', { conversationId: 'c', muted: true }])
  assert.match((await fetch(base + '/')).headers.get('content-security-policy'), /connect-src [^;]*wss:\/\/ws\.farcaster\.xyz/)
})

test('the Spaces relay mints a token from a signed login and reaches only the audio-room endpoints', async () => {
  const call = (op, init) => fetch(`${base}/api/space/${op}`, init)
  const ts = Date.now()
  const login = (bearer, method = 'generateToken') => call('token', { method: 'POST', body: JSON.stringify({ authRequest: { method, params: { timestamp: ts, expiresAt: ts + 1000 } }, bearer }) })
  assert.deepEqual(await (await login(`eip191:${'A'.repeat(88)}`)).json(), { secret: 'fc_space_test', expiresAt: 5 })
  assert.equal((await login('eip191:short')).status, 400)
  assert.equal((await login(`eip191:${'A'.repeat(88)}`, 'other')).status, 400)
  assert.equal((await call('token')).status, 405)
  const auth = { authorization: 'Bearer fc_space_test_token' }
  const live = await (await call('live?limit=5&fid=1', { headers: auth })).json()
  assert.deepEqual([live.path, live.auth, live.query], ['/v1/audio-rooms', 'Bearer fc_space_test_token', '?limit=5'])
  assert.equal((await call('live')).status, 401)
  for (const op of ['me', 'livekit', '__proto__', 'constructor']) assert.equal((await call(op, { headers: auth })).status, 404, op)
  assert.equal((await call('join', { headers: auth })).status, 405)
  const joined = await (await call('join', { method: 'POST', headers: auth, body: JSON.stringify({ roomId: 'r1' }) })).json()
  assert.deepEqual([joined.path, joined.method, joined.body], ['/v1/audio-room/join', 'POST', { roomId: 'r1' }])
  const invited = await (await call('invite', { method: 'POST', headers: auth, body: JSON.stringify({ roomId: 'r1', fid: 2, role: 'speaker' }) })).json()
  assert.deepEqual([invited.path, invited.body], ['/v1/audio-room/accept-speaker', { roomId: 'r1', fid: 2, role: 'speaker' }])
  assert.match((await fetch(base + '/')).headers.get('content-security-policy'), /connect-src [^;]*wss:\/\/\*\.livekit\.cloud/)
})

test('mini app notifications: tokens per inbox, the spec answer, rate limits, same-domain targets, drop', async () => {
  const post = (path, body) => fetch(base + path, { method: 'POST', body: JSON.stringify(body) })
  const inbox = 'ab'.repeat(32)
  const t = await (await post('/api/notify/token', { inbox, origin: 'https://app.example', name: 'App' })).json()
  assert.equal(t.url, 'https://quilcast.test/api/notify')
  // one token per app and inbox
  assert.equal((await (await post('/api/notify/token', { inbox, origin: 'https://app.example' })).json()).token, t.token)
  assert.equal((await post('/api/notify/token', { inbox: 'short', origin: 'https://app.example' })).status, 400)
  assert.equal((await post('/api/notify/token', { inbox, origin: 'http://app.example' })).status, 400)
  const send = (id, extra = {}) => post('/api/notify', { notificationId: id, title: 'Hi', body: 'There', targetUrl: 'https://app.example/x', tokens: [t.token, 'nope'], ...extra })
  assert.deepEqual((await (await send('n1')).json()).result, { successfulTokens: [t.token], invalidTokens: ['nope'], rateLimitedTokens: [] })
  // the same id again counts as sent, a new one within 30 s is rate limited
  assert.deepEqual((await (await send('n1')).json()).result.successfulTokens, [t.token])
  assert.deepEqual((await (await send('n2')).json()).result.rateLimitedTokens, [t.token])
  // a target off the app's domain doesn't go out
  assert.deepEqual((await (await send('n3', { targetUrl: 'https://evil.example/' })).json()).result.invalidTokens, [t.token, 'nope'])
  assert.equal((await send('n4', { title: 'x'.repeat(33) })).status, 400)
  const items = (await (await fetch(base + '/api/notify/inbox', { headers: { 'x-inbox': inbox } })).json()).items
  assert.deepEqual(items.map((i) => [i.notificationId, i.title, i.targetUrl, i.name]), [['n1', 'Hi', 'https://app.example/x', 'App']])
  assert.equal((await fetch(base + '/api/notify/inbox')).status, 400)
  // push only to browsers' push services; webhook events must be signed by the key they name
  assert.equal((await post('/api/notify/push', { inbox, subscription: { endpoint: 'https://evil.example/', keys: { p256dh: 'x', auth: 'y' } } })).status, 400)
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const event = { header: b64({ fid: 1, type: 'app_key', key: '0x' + '11'.repeat(32) }), payload: b64({ event: 'miniapp_added' }), signature: Buffer.alloc(64).toString('base64url') }
  assert.equal((await post('/api/notify/event', { origin: 'https://app.example', event })).status, 400)
  assert.match((await (await fetch(base + '/api/notify/vapid')).json()).key, /^B[\w-]{86}$/)
  // signing out drops the inbox and its tokens
  await post('/api/notify/drop', { inbox })
  assert.deepEqual((await (await send('n5')).json()).result.invalidTokens, [t.token, 'nope'])
})

test('mutes: private to the account, read and written only with its key', async () => {
  const call = (method, fid, body = '', { key = signer, what = method === 'GET' ? 'quilcast-mutes-read' : 'quilcast-mutes' } = {}) => {
    const ts = Date.now()
    const sig = Buffer.from(ed25519.sign(Buffer.from(`${what}:${fid}:${ts}:${body}`), key)).toString('hex')
    return fetch(`${base}/api/mutes/${fid}`, { method, body: method === 'GET' ? undefined : body, headers: { 'x-key': '0x' + Buffer.from(ed25519.getPublicKey(key)).toString('hex'), 'x-ts': String(ts), 'x-sig': sig } })
  }
  assert.equal((await fetch(`${base}/api/mutes/7`)).status, 401)
  assert.deepEqual(await (await call('GET', 7)).json(), { words: [], users: [], blocks: [] })
  const body = JSON.stringify({ words: [{ v: '$BASED', until: Date.now() + 864e5 }, { v: 'gone', until: 1 }], users: [{ v: 3 }], blocks: [{ v: 4 }] })
  assert.equal((await call('PUT', 7, body, { what: 'quilcast-mutes-read' })).status, 401)
  assert.equal((await call('PUT', 8, body)).status, 403)
  const r = await call('PUT', 7, body)
  assert.equal(r.status, 200)
  const got = await (await call('GET', 7)).json()
  assert.deepEqual(got, await r.json())
  assert.deepEqual([got.words.map((x) => x.v), got.users, got.blocks], [['$based'], [{ v: 3 }], [{ v: 4 }]])
  assert.equal((await call('GET', 7, '', { key: ed25519.utils.randomSecretKey() })).status, 403)
})

test('stats: accounts a day and campaign sign-ups, counts only', async () => {
  const signed = (what, fid, body = '', key = signer11) => {
    const ts = Date.now()
    return { 'x-key': '0x' + Buffer.from(ed25519.getPublicKey(key)).toString('hex'), 'x-ts': String(ts), 'x-sig': Buffer.from(ed25519.sign(Buffer.from(`${what}:${fid}:${ts}:${body}`), key)).toString('hex') }
  }
  const get = async () => {
    const r = await fetch(`${base}/api/stats`)
    assert.equal(r.status, 200)
    assert.match(r.headers.get('cache-control'), /public/)
    return r.json()
  }
  const signup = (body, key) => fetch(`${base}/api/signup`, { method: 'POST', body, headers: { 'x-fid': '11', ...signed('quilcast-signup', 11, body, key) } })
  const s0 = await get()
  assert.deepEqual(Object.keys(s0), ['signedIn', 'campaigns'])
  const today = s0.signedIn.at(-1)
  assert.match(today.day, /^\d{4}-\d{2}-\d{2}$/)
  assert.ok(s0.signedIn.length <= 90 && s0.signedIn.every((d) => Object.keys(d).join() === 'day,count' && Number.isInteger(d.count)))
  // a signed request moves today's count by one, however often it comes; a refused one doesn't
  assert.equal((await fetch(`${base}/api/mutes/11`, { headers: signed('quilcast-mutes-read', 11, '', signer) })).status, 403)
  assert.equal((await get()).signedIn.at(-1).count, today.count)
  for (let i = 0; i < 2; i++) assert.equal((await fetch(`${base}/api/mutes/11`, { headers: signed('quilcast-mutes-read', 11) })).status, 200)
  assert.deepEqual((await get()).signedIn.at(-1), { day: today.day, count: today.count + 1 })
  // a campaign sign-up: only with the account's key, a valid name, once a day per account
  assert.equal((await fetch(`${base}/api/signup`, { method: 'POST', body: '{"campaign":"p7-a"}', headers: { 'x-fid': '11' } })).status, 401)
  // the account goes in x-fid only: without it the sign-up is refused
  assert.equal((await fetch(`${base}/api/signup`, { method: 'POST', body: '{"campaign":"p7-a"}', headers: signed('quilcast-signup', 11, '{"campaign":"p7-a"}') })).status, 400)
  assert.equal((await signup('{"campaign":"p7-a"}', signer)).status, 403)
  assert.deepEqual(await (await signup('{"campaign":"p7 a"}')).json(), { counted: false })
  assert.deepEqual(await (await signup('{"campaign":"p7-a"}')).json(), { counted: true })
  assert.deepEqual(await (await signup('{"campaign":"p7-b"}')).json(), { counted: false })
  assert.equal((await fetch(`${base}/api/signup`, { method: 'GET' })).status, 405)
  assert.equal((await fetch(`${base}/api/stats`, { method: 'POST' })).status, 405)
  const s1 = await get()
  assert.deepEqual(s1.campaigns.filter((c) => c.day === today.day), [{ day: today.day, campaign: 'p7-a', count: 1 }])
  assert.equal(s1.signedIn.at(-1).count, today.count + 1)
})

test('prefs: theme sync kept per account, read and written only with its key', async () => {
  const call = (method, fid, body = '', what = method === 'GET' ? 'quilcast-prefs-read' : 'quilcast-prefs') => {
    const ts = Date.now()
    const sig = Buffer.from(ed25519.sign(Buffer.from(`${what}:${fid}:${ts}:${body}`), signer)).toString('hex')
    return fetch(`${base}/api/prefs/${fid}`, { method, body: method === 'GET' ? undefined : body, headers: { 'x-key': signerHex, 'x-ts': String(ts), 'x-sig': sig } })
  }
  assert.equal((await fetch(`${base}/api/prefs/7`)).status, 401)
  assert.equal(await (await call('GET', 7)).json(), null)
  const body = JSON.stringify({ theme: { name: 'Xmas', base: 'dark', bg: '#102030', evil: 'x' }, library: [{ theme: { name: 'Kept' }, id: 'abcdefghij' }, { theme: {} }], mode: 'nope', holidays: false, quorum: true, at: 5 })
  assert.equal((await call('PUT', 7, body, 'quilcast-prefs-read')).status, 401)
  assert.equal((await call('PUT', 8, body)).status, 403)
  assert.equal((await call('PUT', 7, '{"theme":null}')).status, 400)
  assert.equal((await call('PUT', 7, body)).status, 200)
  assert.deepEqual(await (await call('GET', 7)).json(), { theme: { name: 'Xmas', base: 'dark', bg: '#102030' }, library: [{ theme: { name: 'Kept' }, id: 'abcdefghij' }], mode: 'system', holidays: false, quorum: true, at: 5 })
})

test('drafts: sealed boxes kept per account, read and written only with its key', async () => {
  const call = (method, fid, body = '', { key = signer, what = method === 'GET' ? 'quilcast-drafts-read' : 'quilcast-drafts' } = {}) => {
    const ts = Date.now()
    const sig = Buffer.from(ed25519.sign(Buffer.from(`${what}:${fid}:${ts}:${body}`), key)).toString('hex')
    return fetch(`${base}/api/drafts/${fid}`, { method, body: method === 'GET' ? undefined : body, headers: { 'x-key': '0x' + Buffer.from(ed25519.getPublicKey(key)).toString('hex'), 'x-ts': String(ts), 'x-sig': sig } })
  }
  const id = crypto.randomUUID()
  const body = JSON.stringify({ id, box: 'aXY=.c2VhbGVk' })
  assert.equal((await fetch(`${base}/api/drafts/7`)).status, 401)
  assert.deepEqual(await (await call('GET', 7)).json(), [])
  assert.equal((await call('PUT', 7, body, { what: 'quilcast-drafts-read' })).status, 401)
  assert.equal((await call('PUT', 8, body)).status, 403)
  assert.equal((await call('PUT', 7, JSON.stringify({ id: '../x', box: 'a.b' }))).status, 400)
  assert.equal((await call('PUT', 7, JSON.stringify({ id, box: 'not sealed' }))).status, 400)
  assert.equal((await call('PUT', 7, body)).status, 200)
  assert.deepEqual(await (await call('GET', 7)).json(), [{ id, box: 'aXY=.c2VhbGVk' }])
  assert.equal((await call('GET', 7, '', { key: ed25519.utils.randomSecretKey() })).status, 403)
  assert.equal((await call('PUT', 7, JSON.stringify({ id, box: null }))).status, 200)
  assert.deepEqual(await (await call('GET', 7)).json(), [])
})

test('profile looks: saved only with a key the node lists for that FID, cleaned, and removable', async () => {
  const put = (fid, look, { key = signer, ts = Date.now(), as = fid } = {}) => {
    const body = JSON.stringify(look)
    const sig = Buffer.from(ed25519.sign(Buffer.from(`quilcast-look:${as}:${ts}:${body}`), key)).toString('hex')
    return fetch(`${base}/api/look/${fid}`, { method: 'PUT', body, headers: { 'x-key': '0x' + Buffer.from(ed25519.getPublicKey(key)).toString('hex'), 'x-ts': String(ts), 'x-sig': sig } })
  }
  const look = { bg: '#FF00FF', text: 'red;background:url(//evil)', about: 'hi', top: [1, 1, 2], bgImg: 'https://evil.example/x.gif' }
  assert.equal((await put(8, look)).status, 403)
  assert.equal((await put(7, look, { key: ed25519.utils.randomSecretKey() })).status, 403)
  assert.equal((await put(7, look, { as: 8 })).status, 401)
  assert.equal((await put(7, look, { ts: Date.now() - 600e3 })).status, 401)
  const r = await put(7, look)
  assert.equal(r.status, 200)
  const saved = { bg: '#ff00ff', about: 'hi', top: [1, 2] }
  assert.deepEqual(await r.json(), saved)
  assert.deepEqual(await (await fetch(`${base}/api/look/7`)).json(), saved)
  // Search's "Customized profiles" lists it while it's there
  assert.deepEqual(await (await fetch(`${base}/api/looks`)).json(), [{ fid: 7, amp: false }])
  assert.equal((await put(7, null)).status, 200)
  assert.equal(await (await fetch(`${base}/api/look/7`)).json(), null)
  assert.deepEqual(await (await fetch(`${base}/api/looks`)).json(), [])
})

test('pinned casts: only your own cast, signed with a key the node lists for that FID, public, and removable', async () => {
  const put = (fid, pin, { key = signer, ts = Date.now(), as = fid } = {}) => {
    const body = JSON.stringify(pin)
    const sig = Buffer.from(ed25519.sign(Buffer.from(`quilcast-pin:${as}:${ts}:${body}`), key)).toString('hex')
    return fetch(`${base}/api/pin/${fid}`, { method: 'PUT', body, headers: { 'x-key': '0x' + Buffer.from(ed25519.getPublicKey(key)).toString('hex'), 'x-ts': String(ts), 'x-sig': sig } })
  }
  const get = async (fid) => (await fetch(`${base}/api/pin/${fid}`)).json()
  const mine = '0x' + '7a'.repeat(20)
  assert.equal(await get(7), null)
  // someone else's key, another FID's signature, an old one, or a look's signature: nothing is pinned
  assert.equal((await put(7, { hash: mine }, { key: ed25519.utils.randomSecretKey() })).status, 403)
  assert.equal((await put(8, { hash: mine })).status, 403)
  assert.equal((await put(7, { hash: mine }, { as: 8 })).status, 401)
  assert.equal((await put(7, { hash: mine }, { ts: Date.now() - 600e3 })).status, 401)
  const body = JSON.stringify({ hash: mine })
  const ts = Date.now()
  const lookSig = Buffer.from(ed25519.sign(Buffer.from(`quilcast-look:7:${ts}:${body}`), signer)).toString('hex')
  assert.equal((await fetch(`${base}/api/pin/7`, { method: 'PUT', body, headers: { 'x-key': signerHex, 'x-ts': String(ts), 'x-sig': lookSig } })).status, 401)
  // not a hash, someone else's cast (or none at all), its own reply, or a node that fails or rate-limits
  assert.equal((await put(7, { hash: 'nope' })).status, 400)
  const theirs = await put(7, { hash: '0x' + '9a'.repeat(20) })
  assert.deepEqual([theirs.status, await theirs.json()], [400, { error: 'You can only pin your own casts.' }])
  const reply = await put(7, { hash: '0x' + '7d'.repeat(20) })
  assert.deepEqual([reply.status, await reply.json()], [400, { error: "Replies can't be pinned." }])
  assert.equal((await put(7, { hash: '0x' + '5e'.repeat(20) })).status, 502)
  assert.equal((await put(7, { hash: '0x' + '42'.repeat(20) })).status, 502)
  assert.equal(await get(7), null)
  // its own cast pins, uppercase or not, with 0x or bare like the node's feeds give it, and everyone can read it
  assert.deepEqual(await (await put(7, { hash: '7c'.repeat(20) })).json(), { hash: '0x' + '7c'.repeat(20) })
  const r = await put(7, { hash: mine.toUpperCase().replace('0X', '0x') })
  assert.equal(r.status, 200)
  assert.deepEqual(await r.json(), { hash: mine })
  assert.deepEqual(await get(7), { hash: mine })
  // a new pin replaces the old one, and null unpins
  assert.equal((await put(7, { hash: '0x' + '7b'.repeat(20) })).status, 200)
  assert.deepEqual(await get(7), { hash: '0x' + '7b'.repeat(20) })
  // two saves at once both land, and the pin is one of them
  const both = await Promise.all(['7a', '7c'].map((x) => put(7, { hash: '0x' + x.repeat(20) })))
  assert.deepEqual(both.map((x) => x.status), [200, 200])
  const now = (await get(7)).hash
  assert.ok(['7a', '7c'].some((x) => now === '0x' + x.repeat(20)), now)
  assert.equal((await put(7, null)).status, 200)
  assert.equal(await get(7), null)
  assert.equal((await fetch(`${base}/api/pin/7`, { method: 'DELETE' })).status, 405)
  // unsigned saves from many addresses don't use up the account's own limit: it can still pin and unpin
  for (let i = 1; i <= 35; i++) {
    const r = await fetch(`${base}/api/pin/7`, { method: 'PUT', body: 'null', headers: { 'x-forwarded-for': `198.51.100.${i}` } })
    assert.equal(r.status, 401)
  }
  assert.equal((await put(7, { hash: mine })).status, 200)
  assert.deepEqual(await get(7), { hash: mine })
  assert.equal((await put(7, null)).status, 200)
  // nor do ones from an address that reads like the FID: addresses and accounts are counted apart
  for (let i = 1; i <= 30; i++) {
    const r = await fetch(`${base}/api/pin/7`, { method: 'PUT', body: 'null', headers: { 'x-forwarded-for': '7' } })
    assert.equal(r.status, 401)
  }
  assert.equal((await fetch(`${base}/api/pin/7`, { method: 'PUT', body: 'null', headers: { 'x-forwarded-for': '7' } })).status, 429)
  assert.equal((await put(7, { hash: mine })).status, 200)
  assert.equal((await put(7, null)).status, 200)
})

test('shared designs: only the style is kept, under a stable id', async () => {
  const share = (look) => fetch(`${base}/api/design`, { method: 'POST', body: JSON.stringify(look) })
  const r = await share({ bg: '#FF00FF', font: 'impact', about: 'mine', top: [1], text: 'red;x', fx: 'snow', fxAlpha: 140, boxAlpha: 30 })
  assert.equal(r.status, 200)
  const { id } = await r.json()
  assert.match(id, /^[\w-]{10}$/)
  assert.deepEqual(await (await share({ font: 'impact', bg: '#ff00ff', fx: 'snow', fxAlpha: 100, boxAlpha: 30 })).json(), { id })
  assert.deepEqual(await (await fetch(`${base}/api/design/${id}`)).json(), { bg: '#ff00ff', boxAlpha: 30, font: 'impact', fx: 'snow', fxAlpha: 100 })
  assert.equal(await (await fetch(`${base}/api/design/aaaaaaaaaa`)).json(), null)
  assert.equal((await share({ about: 'only words' })).status, 400)
  const page = await (await fetch(`${base}/design/${id}`)).text()
  assert.match(page, /A profile design on Quilcast/)
  assert.match(page, new RegExp(`og:image" content="[^"]*/og/design/${id}\\.png`))
  const png = await fetch(`${base}/og/design/${id}.png`)
  assert.equal(png.headers.get('content-type'), 'image/png')
  assert.ok((await png.arrayBuffer()).byteLength > 5000)
})

test('Quorum skins: the gallery is trimmed, a skin becomes a theme, and only real pictures are kept', async () => {
  const list = await (await fetch(base + '/api/quorum/skins?sort=new')).json()
  const th = await (await fetch(`${base}/api/quorum/skin/${SKIN_ID}`)).json()
  // each listed skin comes converted, for its preview
  assert.deepEqual(list, { more: true, skins: [{ id: SKIN_ID, name: 'Coffee', base: 'light', installs: 5, theme: th }] })
  assert.match(th.bgImg, /^https:\/\/quilcast\.com\/m\/[0-9a-f]{24}\.png$/)
  assert.deepEqual({ ...th, bgImg: 'x' }, {
    name: 'Coffee', base: 'light', bg: '#fbf6ec', card: '#eeeef3', soft: '#e6e6eb', line: '#dedee3', ink: '#403425', muted: '#a8997e',
    accent: '#ffd700', onAccent: '#000000', like: '#e74a4a', recast: '#46c236', warn: '#e7b04a', bgImg: 'x', bgMode: 'tile', scrim: 50, sheer: 80, round: 0, borderWidth: 2, glow: true, size: 1.3,
  })
  // the stored picture is the skin's own bytes, served from /m/
  const img = await fetch(base + th.bgImg.replace('https://quilcast.com', ''))
  assert.equal(img.headers.get('content-type'), 'image/png')
  assert.equal(Buffer.from(await img.arrayBuffer()).toString('base64'), PNG)
  // pasted skins go the same way; anything that isn't a skin is refused
  const imp = await fetch(base + '/api/quorum/import', { method: 'POST', body: JSON.stringify(SKIN) })
  assert.deepEqual(await imp.json(), th)
  const bad = await fetch(base + '/api/quorum/import', { method: 'POST', body: JSON.stringify({ name: 'x' }) })
  assert.equal(bad.status, 400)
  // an id that isn't one never reaches Quorum: it's just the app's page
  assert.match((await fetch(base + '/api/quorum/skin/Qm..%2F..')).headers.get('content-type'), /^text\/html/)
})

test('shared themes: cleaned, stored under a stable id, with their page and share card', async () => {
  const put = (b) => fetch(base + '/api/theme', { method: 'POST', body: JSON.stringify(b) }).then(async (r) => [r.status, await r.json()])
  const [code, { id }] = await put({ name: evil, base: 'dark', accent: '#ff00aa', round: 0, fx: 'stars', fxAlpha: 45.5, sheer: 101, nameFx: 'rainbow', evil: 1 })
  assert.equal(code, 200)
  assert.deepEqual((await put({ evil: 2, fx: 'stars', sheer: 100, round: 0, accent: '#ff00aa', base: 'dark', name: evil, nameFx: 'rainbow' }))[1].id, id)
  assert.equal((await put({ nope: 1 }))[0], 400)
  assert.deepEqual(await (await fetch(`${base}/api/theme/${id}`)).json(), { name: evil.slice(0, 60).trim(), base: 'dark', accent: '#ff00aa', sheer: 100, round: 0, nameFx: 'rainbow', fx: 'stars' })
  // the effect's opacity is kept, and the share card draws with it
  const [, { id: id2 }] = await put({ base: 'dark', fx: 'matrix', fxAlpha: 40, sheer: 70 })
  assert.deepEqual(await (await fetch(`${base}/api/theme/${id2}`)).json(), { base: 'dark', sheer: 70, fx: 'matrix', fxAlpha: 40 })
  assert.equal((await fetch(`${base}/og/theme/${id2}.png`)).headers.get('content-type'), 'image/png')
  const page = await (await fetch(`${base}/theme/${id}`)).text()
  assert.ok(page.includes(`/og/theme/${id}.png`) && !page.includes('<script>alert'))
  const png = await fetch(`${base}/og/theme/${id}.png`)
  assert.equal(png.headers.get('content-type'), 'image/png')
  assert.equal(Buffer.from(await png.arrayBuffer()).readUInt32BE(16), 1200)
})

// a PNG's RGBA pixels (8-bit RGBA, non-interlaced, as resvg writes them)
function pixels(png) {
  const [w, h] = [png.readUInt32BE(16), png.readUInt32BE(20)]
  assert.deepEqual([png[24], png[25], png[28]], [8, 6, 0])
  const idat = []
  for (let o = 8; o < png.length; o += 12 + png.readUInt32BE(o)) if (png.toString('latin1', o + 4, o + 8) === 'IDAT') idat.push(png.subarray(o + 8, o + 8 + png.readUInt32BE(o)))
  const raw = inflateSync(Buffer.concat(idat))
  const row = w * 4
  const px = Buffer.alloc(h * row)
  for (let y = 0; y < h; y++) {
    const f = raw[y * (row + 1)]
    for (let x = 0; x < row; x++) {
      const a = x >= 4 ? px[y * row + x - 4] : 0, b = y ? px[(y - 1) * row + x] : 0, c = x >= 4 && y ? px[(y - 1) * row + x - 4] : 0
      const p = a + b - c, [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)]
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f]
      px[y * row + x] = raw[y * (row + 1) + 1 + x] + pred
    }
  }
  return { w, h, at: (x, y) => px.readUInt32BE((y * w + x) * 4) >>> 8 }
}

test('a theme card draws the emoji in a theme name in color, under every name effect', async () => {
  for (const nameFx of [undefined, 'rainbow', 'glitter', 'glow', 'shadow', 'outline']) {
    const { id } = await (await fetch(base + '/api/theme', { method: 'POST', body: JSON.stringify({ name: 'Sunny \u2600\uFE0F \u{1F44D}\u{1F3FD}', base: 'dark', nameFx }) })).json()
    const { w, h, at } = pixels(Buffer.from(await (await fetch(`${base}/og/theme/${id}.png`)).arrayBuffer()))
    // Twemoji's sun and the thumb's medium skin tone, in the panel
    const count = (rgb) => { let n = 0; for (let y = 0; y < h; y++) for (let x = 748; x < w; x++) n += at(x, y) === rgb; return n }
    assert.ok(count(0xffac33) > 100, `${nameFx} sun`)
    assert.ok(count(0xd4ab88) > 50, `${nameFx} thumb`)
  }
})

test("glitter's sparkle follows each line of a theme's name and stays in the panel, after a full first line too", async () => {
  // a name that just fits one line by the old guesses, a full line of flags at 40 px, wide capitals drawn bold, and
  // names (of at most 60 characters, as a theme's name is kept) of so many words that the card would have measured all
  // it may before its last lines: kerned tight ("Ty", "AV"), where a guess at a line's end runs wider than it's drawn,
  // and with ideographic spaces, which guesses took as narrower than they're drawn until they knew better
  const words = ' To b c d e f g h i j k l m n o p q r s t u v w x'
  const names = ['TyTyTyTyTy' + words, 'AVAVAVAVAV' + words, 'AVAVAVAVAV e b v n r g　　 s p t k y c j f w q h i m l z o u']
  for (const n of names) assert.ok([...n].length <= 60, n)
  for (const name of ['Love ❤️‍\u{1F525} mode', '\u{1F1FA}\u{1F1E6}'.repeat(12), 'MMMMMMMMMMMMMMMMMMMMMMMMMMMMM', ...names]) {
    const { id } = await (await fetch(base + '/api/theme', { method: 'POST', body: JSON.stringify({ name, base: 'dark', nameFx: 'glitter' }) })).json()
    const { w, h, at } = pixels(Buffer.from(await (await fetch(`${base}/og/theme/${id}.png`)).arrayBuffer()))
    // the sparkle's gold in the panel (x 748 to 1152), and anything warm (its soft edge too) to the right of it
    let inside = 0, outside = 0
    for (let y = 0; y < h; y++) for (let x = 748; x < w; x++) {
      const [r, b] = [at(x, y) >> 16, at(x, y) & 0xff]
      if (x < 1152) inside += at(x, y) === 0xffc928
      else outside += r > 40 && r > b + 20
    }
    assert.ok(inside > 40, `${name}: ${inside}`)
    assert.equal(outside, 0, name)
  }
  // and a name with no effect may use the panel's padding too, up to 8 px from its edge
  {
    const { id } = await (await fetch(base + '/api/theme', { method: 'POST', body: JSON.stringify({ name: 'Christmas Morning Magic \u2728', base: 'dark' }) })).json()
    const { w, h, at } = pixels(Buffer.from(await (await fetch(`${base}/og/theme/${id}.png`)).arrayBuffer()))
    // the sparkles emoji, drawn: the name isn't cut before it
    let gold = 0
    for (let y = 0; y < h; y++) for (let x = 748; x < w; x++) gold += at(x, y) === 0xffac33
    assert.ok(gold > 30, `sparkles: ${gold}`)
  }
  // and a name that fits whole beside its sparkles still does: the sunrise ending it is drawn (its water's blue)
  const { id } = await (await fetch(base + '/api/theme', { method: 'POST', body: JSON.stringify({ name: 'Golden Hour Glow \u{1F305}', base: 'dark', nameFx: 'glitter' }) })).json()
  const { w, h, at } = pixels(Buffer.from(await (await fetch(`${base}/og/theme/${id}.png`)).arrayBuffer()))
  let water = 0
  for (let y = 0; y < h; y++) for (let x = 748; x < w; x++) water += at(x, y) === 0x3b88c3
  assert.ok(water > 50, `sunrise: ${water}`)
})

test('translations: asked once per cast and language, from the node\'s words, from free models only, then kept', async () => {
  const hash = 'ab'.repeat(20)
  assert.deepEqual(await (await fetch(`${base}/api/translate`)).json(), { on: true })
  const tr = (body, path = '/api/translate') => fetch(`${base}${path}`, { method: 'POST', body: JSON.stringify(body) })
  assert.equal((await tr({ hash: 'nope', to: 'en' })).status, 400)
  assert.equal((await tr({ hash, to: 'klingon' })).status, 400)
  assert.deepEqual(await (await tr({ to: 'en', hashes: [hash] }, '/api/translations')).json(), {})
  const [a, b] = await Promise.all([tr({ hash, to: 'en' }), tr({ hash: '0x' + hash, to: 'en' })])
  assert.deepEqual(await a.json(), { from: 'ja', text: 'Hello from Japan' })
  assert.deepEqual(await b.json(), { from: 'ja', text: 'Hello from Japan' })
  assert.equal(orAsked.length, 1)
  const { auth, body } = orAsked[0]
  assert.equal(auth, 'Bearer test-key')
  assert.ok(body.models.length && body.models.every((m) => m.endsWith(':free') || m === 'openrouter/free'))
  assert.deepEqual(body.provider.max_price, { prompt: 0, completion: 0 })
  // the words are the node's (the fake node's cast text), not anything the browser sent
  assert.equal(body.messages[1].content, evil.trim())
  assert.deepEqual(await (await tr({ hash, to: 'en' })).json(), { from: 'ja', text: 'Hello from Japan' })
  assert.equal(orAsked.length, 1)
  assert.deepEqual(await (await tr({ to: 'en', hashes: [hash, 'cd'.repeat(20)] }, '/api/translations')).json(), { [hash]: { from: 'ja', text: 'Hello from Japan' } })
})

test('deleting an account: only with its own key, and only files it alone put here go', async () => {
  const sign = (what, fid, key, ts = Date.now(), body = '') => ({ 'x-key': '0x' + Buffer.from(ed25519.getPublicKey(key)).toString('hex'), 'x-ts': String(ts), 'x-sig': Buffer.from(ed25519.sign(Buffer.from(`${what}:${fid}:${ts}:${body}`), key)).toString('hex') })
  const del = (fid, { key = signer, what = 'quilcast-delete', ts, run = '' } = {}) => fetch(`${base}/api/account/${fid}?run=${run}`, { method: 'DELETE', headers: sign(what, fid, key, ts) })
  // a different PNG each time: same header, its own trailing bytes
  let pngs = 0
  const png = () => Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.from([0, 0, 0, 1, 0, 0, 0, 1]), Buffer.alloc(40, ++pngs + 100)])
  let ts = Date.now() + 1000
  const upload = async (fid, key, body) => {
    const r = await fetch(base + '/api/upload', { method: 'POST', headers: { 'content-type': 'image/png', 'x-size': String(body.length), 'x-fid': String(fid), ...sign('quilcast-upload', fid, key, ts++) } })
    assert.equal(r.status, 200)
    const { id } = await r.json()
    assert.equal((await fetch(`${base}/api/upload/${id}?offset=0`, { method: 'PUT', body })).status, 200)
    let st = await (await fetch(`${base}/api/upload/${id}/done`, { method: 'POST' })).json()
    for (let i = 0; i < 50 && st.state === 'sending'; i++) await new Promise((r) => setTimeout(r, 100)), (st = await (await fetch(`${base}/api/upload/${id}`)).json())
    assert.equal(st.state, 'ready')
    return st.url.split('/m/')[1]
  }
  // fid 7's own upload (as well as the one from the test above), a file both uploaded, and fid 9's
  const mine = await upload(7, signer, png())
  const same = png()
  const both = await upload(7, signer, same)
  assert.equal(await upload(9, signer9, same), both)
  const theirs = await upload(9, signer9, png())
  // a file from before uploads were recorded: uploading its bytes again doesn't replace it or make it fid 7's alone
  const { mtimeMs } = await stat(join(media, OLD_NAME))
  assert.equal(await upload(7, signer, OLD_PNG), OLD_NAME)
  assert.equal((await stat(join(media, OLD_NAME))).mtimeMs, mtimeMs)
  // a picture fid 7 alone uploaded, worn in a theme it shared: it stays for everyone who wears the theme
  const themePic = await upload(7, signer, png())
  assert.equal((await fetch(base + '/api/theme', { method: 'POST', body: JSON.stringify({ base: 'dark', bgImg: `https://quilcast.com/m/${themePic}` }) })).status, 200)
  // and one nobody recorded at all
  const stray = `${'5'.repeat(24)}.png`
  await writeFile(join(media, stray), png())
  const cast = (hash, urls, text = '') => ({ hash, data: { fid: 7, castAddBody: { text, embeds: urls.map((n) => ({ url: `https://quilcast.test/m/${n}` })) } } })
  const hash = '0x' + '7a'.repeat(20)
  fid7.casts = [cast(hash, [theirs, stray]), cast('0x' + '7b'.repeat(20), [both]), cast('0x' + '7c'.repeat(20), [], `see https://quilcast.test/m/${mine}`)]
  fid7.profile = [{ data: { userDataBody: { type: 'USER_DATA_TYPE_PFP', value: `https://quilcast.test/m/${OLD_NAME}` } } }]
  // the rest of what's kept for fid 7: its look, pinned cast, mutes, a draft and a translation of one of its casts
  const body = JSON.stringify({ bg: '#123456' })
  assert.equal((await fetch(`${base}/api/look/7`, { method: 'PUT', body, headers: sign('quilcast-look', 7, signer, Date.now(), body) })).status, 200)
  const pin = JSON.stringify({ hash: '0x' + '7c'.repeat(20) })
  assert.equal((await fetch(`${base}/api/pin/7`, { method: 'PUT', body: pin, headers: sign('quilcast-pin', 7, signer, Date.now(), pin) })).status, 200)
  const mutes = JSON.stringify({ words: [{ v: 'gm' }], users: [], blocks: [] })
  assert.equal((await fetch(`${base}/api/mutes/7`, { method: 'PUT', body: mutes, headers: sign('quilcast-mutes', 7, signer, Date.now(), mutes) })).status, 200)
  const prefs = JSON.stringify({ theme: null, mode: 'dark', holidays: true, at: 1 })
  assert.equal((await fetch(`${base}/api/prefs/7`, { method: 'PUT', body: prefs, headers: sign('quilcast-prefs', 7, signer, Date.now(), prefs) })).status, 200)
  const draft = JSON.stringify({ id: crypto.randomUUID(), box: 'aXY=.c2VhbGVk' })
  assert.equal((await fetch(`${base}/api/drafts/7`, { method: 'PUT', body: draft, headers: sign('quilcast-drafts', 7, signer, Date.now(), draft) })).status, 200)
  await writeFile(join(media, 'translations', 'de', `${'7a'.repeat(20)}.json`), '{"from":"en","text":"x"}')
  await writeFile(join(media, 'translations', 'de', `${'9a'.repeat(20)}.json`), '{"from":"en","text":"y"}')

  // someone else's key, fid 9's own key for fid 7, an old or missing signature, another kind of signature: nothing happens
  assert.equal((await del(7, { key: ed25519.utils.randomSecretKey() })).status, 403)
  assert.equal((await del(7, { key: signer9 })).status, 403)
  assert.equal((await del(8)).status, 403)
  assert.equal((await del(7, { ts: Date.now() - 600e3 })).status, 401)
  assert.equal((await del(7, { what: 'quilcast-mutes' })).status, 401)
  assert.equal((await fetch(`${base}/api/account/7`, { method: 'DELETE' })).status, 401)
  assert.equal((await fetch(`${base}/api/account/7`)).status, 405)
  assert.ok(existsSync(join(media, mine)) && existsSync(join(media, 'mutes', '7.json')))

  const r = await del(7, { run: 'one' })
  assert.equal(r.status, 200)
  const out = await r.json()
  // its two uploads go; the one it shares with fid 9, the theme's picture, the old one and the one recorded before the
  // legacy list stay (counted as maybe its own), as do fid 9's it linked and the stray
  assert.deepEqual(out, { state: 'done', media: 2, kept: 4, look: true, mutes: true, drafts: 1, translations: 1 })
  assert.ok(!existsSync(join(media, mine)))
  for (const n of [both, theirs, OLD_NAME, PRE_NAME, themePic, stray, '0123456789abcdef01234567.png']) assert.ok(existsSync(join(media, n)), n)
  assert.equal(await (await fetch(`${base}/api/look/7`)).json(), null)
  assert.ok(!existsSync(join(media, 'prefs', '7.json')))
  assert.equal(await (await fetch(`${base}/api/pin/7`)).json(), null)
  assert.ok(!existsSync(join(media, 'pins', '7.json')))
  assert.ok(!existsSync(join(media, 'mutes', '7.json')) && !existsSync(join(media, 'drafts', '7')) && !existsSync(join(media, 'owners', '7')))
  assert.ok(!existsSync(join(media, 'translations', 'de', `${'7a'.repeat(20)}.json`)) && existsSync(join(media, 'translations', 'de', `${'9a'.repeat(20)}.json`)))
  // asked again (a lost reply), the same answer; a new deletion finds nothing more: the shared file is fid 9's alone now
  assert.deepEqual(await (await del(7, { run: 'one' })).json(), out)
  assert.deepEqual(await (await del(7, { run: 'two' })).json(), { state: 'done', media: 0, kept: 1, look: false, mutes: false, drafts: 0, translations: 0 })
  assert.ok(existsSync(join(media, both)))
  // a node that can't list the casts stops it before anything goes
  fid7.casts = null
  assert.equal((await del(7, { run: 'three' })).status, 502)
})

test('standalone pages inline their stylesheet, allowed by its hash, and ask Cloudflare not to rewrite them', async () => {
  const r = await fetch(base + '/about')
  const html = await r.text()
  const css = html.match(/<style>([\s\S]*?)<\/style>/)?.[1]
  assert.ok(css && !html.includes('href="/legal.css"'))
  assert.match(r.headers.get('cache-control'), /no-transform/)
  const hash = createHash('sha256').update(css).digest('base64')
  assert.ok(r.headers.get('content-security-policy').includes(`'sha256-${hash}'`))
})

test('the standalone pages are served in the other languages at their own addresses, with the stylesheet inlined', async () => {
  const r = await fetch(base + '/de/privacy')
  const html = await r.text()
  assert.equal(r.status, 200)
  assert.match(html, /<html lang="de">/)
  assert.ok(html.includes('<link rel="canonical" href="https://quilcast.com/de/privacy" />') && !html.includes('href="/legal.css"'))
})
