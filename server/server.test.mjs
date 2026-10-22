// Starts the real server against a fake Hypersnap node and pokes the edges that matter:
// malformed URLs, meta-tag injection, SSRF through card images, Range, upload types, headers.
// Needs a build (dist/index.html): npm run build && npm test
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { ed25519 } from '@noble/curves/ed25519.js'
import { address, ecSign } from '../src/fc.ts'

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)))
let internalHits = 0
const internal = createServer((q, r) => (internalHits++, r.end('secret')))
const internalPort = await listen(internal)
const evil = '$& $\' $` "><script>alert(1)</script>'
const key = secp256k1.utils.randomSecretKey()
// fid 7's one Farcaster key, for profile looks
const signer = ed25519.utils.randomSecretKey()
const signerHex = '0x' + Buffer.from(ed25519.getPublicKey(signer)).toString('hex')
const node = createServer(async (q, r) => {
  const u = new URL(q.url, 'http://x')
  r.setHeader('content-type', 'application/json')
  // farcaster.xyz's direct casts: echo what arrived, so the relay test can check it
  if (u.pathname === '/v2/get-dc-nonce') return r.end(JSON.stringify({ result: { nonce: 'n1' } }))
  if (u.pathname === '/v2/get-dc-auth-token') return r.end(JSON.stringify({ result: { token: u.searchParams.get('message') === 'hi' && u.searchParams.get('signature')?.length === 132 ? 'fc_dc_test' : null } }))
  if (u.pathname.startsWith('/v2/direct-cast-') || u.pathname.startsWith('/fc/')) {
    let body = ''
    for await (const c of q) body += c
    return r.end(JSON.stringify({ path: u.pathname, method: q.method, auth: q.headers.authorization, query: u.search, idempotency: q.headers['idempotency-key'], body: body && JSON.parse(body) }))
  }
  if (u.pathname === '/v1/signersByFid') return r.end(JSON.stringify({ signers: u.searchParams.get('fid') === '7' ? [{ key: signerHex, expiresAt: 4e9 }, { key: '0x' + '11'.repeat(32), expiresAt: 1 }] : [] }))
  if (u.pathname === '/v2/farcaster/cast')
    return r.end(JSON.stringify({ cast: { hash: u.searchParams.get('identifier'), text: evil, timestamp: '2026-01-01T00:00:00Z', embeds: [{ url: `http://127.0.0.1:${internalPort}/a.png` }], author: { fid: 1, username: 'x', display_name: evil, pfp_url: `http://127.0.0.1:${internalPort}/pfp.png` }, reactions: { likes_count: 0, recasts_count: 0 }, replies: { count: 0 } } }))
  if (u.pathname.startsWith('/v2/farcaster/user')) return r.end(JSON.stringify({ user: { fid: 1, username: 'x', display_name: 'X', custody_address: address(key), profile: { bio: { text: evil } } } }))
  r.statusCode = 404
  r.end('{}')
})
const nodePort = await listen(node)
const media = await mkdtemp(join(tmpdir(), 'qc-media-'))
await writeFile(join(media, '0123456789abcdef01234567.png'), Buffer.from('0123456789'))
const port = 40000 + Math.floor(Math.random() * 20000)
const base = `http://127.0.0.1:${port}`
let srv
before(async () => {
  srv = spawn(process.execPath, [new URL('./index.mjs', import.meta.url).pathname], { env: { ...process.env, PORT: String(port), NODE_URL: `http://127.0.0.1:${nodePort}`, FC_URL: `http://127.0.0.1:${nodePort}`, MEDIA_DIR: media, SITE_URL: 'https://quilcast.test' }, stdio: 'ignore' })
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
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/)
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(r.headers.get('x-frame-options'), 'DENY')
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
  assert.equal((await put(7, null)).status, 200)
  assert.equal(await (await fetch(`${base}/api/look/7`)).json(), null)
})
