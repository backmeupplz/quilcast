import assert from 'node:assert/strict'
import { mkdtemp, readdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { PassThrough } from 'node:stream'
import { blocked, clientIp, fresh, imageInfo, ipGroup, lru, picInfo, proxiedPic, readBody, safeGet, sendOn, writeAtomic } from './net.mjs'
import { inlineOf, scan } from './unfurl.mjs'
import { looksLike } from './upload.mjs'

test('private, loopback, link-local, CGNAT and their IPv6 forms are blocked', () => {
  for (const ip of ['127.0.0.1', '10.0.1.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.119.195.36', '0.0.0.0', '224.0.0.1', '::1', '::', '::ffff:10.0.0.1', '::ffff:a00:1', 'fd12::1', 'fe80::1', 'fec0::1', '64:ff9b::a00:1', '2002:a00:1::', 'ff02::1'])
    assert.equal(blocked(ip), true, ip)
  for (const ip of ['8.8.8.8', '148.251.0.158', '172.32.0.1', '100.128.0.1', '2606:4700::1111', '2a01:4f8::1']) assert.equal(blocked(ip), false, ip)
})

test('safeGet refuses local targets however they are spelled', async () => {
  const srv = createServer((q, r) => r.end('secret')).listen(0)
  const port = srv.address().port
  for (const u of [`http://127.0.0.1:${port}/`, 'http://localhost/', 'http://[::1]/', 'http://2130706433/', 'http://0x7f.1/', 'http://127.1/', 'ftp://example.com/', 'http://user:pw@example.com/', 'http://example.com:8080/', 'file:///etc/passwd'])
    await assert.rejects(safeGet(u), undefined, u)
  srv.close()
})

test('image headers give type and size', () => {
  assert.deepEqual(imageInfo(Buffer.from('89504e470d0a1a0a0000000d4948445200001000000020000806000000', 'hex')), { type: 'image/png', w: 4096, h: 8192 })
  assert.deepEqual(imageInfo(Buffer.from('474946383961400030000000', 'hex')), { type: 'image/gif', w: 64, h: 48 })
  assert.equal(imageInfo(Buffer.from('<svg onload=alert(1)>')), null)
})

test('uploads must match their declared type and stay within a pixel budget', () => {
  const png = (w, h) => Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.from([w >>> 24, (w >> 16) & 255, (w >> 8) & 255, w & 255, h >>> 24, (h >> 16) & 255, (h >> 8) & 255, h & 255]), Buffer.alloc(8)])
  assert.equal(looksLike('image/png', png(800, 600)), true)
  assert.equal(looksLike('image/png', png(60000, 60000)), false)
  assert.equal(looksLike('image/jpeg', png(800, 600)), false)
  assert.equal(looksLike('image/png', Buffer.from('<html><script>alert(1)</script>')), false)
  assert.equal(looksLike('__proto__', png(1, 1)), false)
})

test('the head scanner is linear on hostile HTML', () => {
  const t = performance.now()
  scan('<link' + ' rel="icon" rel="icon"'.repeat(70000))
  scan('<link<meta '.repeat(150000))
  scan('<meta property="og:title" content="' + 'a'.repeat(1.5e6) + '">')
  assert.ok(performance.now() - t < 1000)
  assert.equal(scan('<meta property="og:description" content="a=1&amp;amp;b &amp;#39;c&amp;#39; &amp;quot;d&amp;quot; e &amp; f">').meta['og:description'], 'a=1&b \'c\' "d" e & f')
  const { meta, title, icon } = scan('<head><title>Hi &amp; bye</title><meta property="og:title" content="T"><link rel="icon" href="/f.ico"></head><meta property="og:image" content="late">')
  assert.equal(meta['og:title'], 'T')
  assert.equal(meta['og:image'], undefined)
  assert.equal(title, 'Hi & bye')
  assert.equal(icon, '/f.ico')
})

test('the visitor is the last forwarded hop, or CF-Connecting-IP when that hop is Cloudflare', () => {
  const ip = (headers) => clientIp({ headers, socket: { remoteAddress: '10.0.0.1' } })
  assert.equal(ip({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }), '5.6.7.8')
  assert.equal(ip({ 'x-forwarded-for': '5.6.7.8', 'cf-connecting-ip': '9.9.9.9' }), '5.6.7.8', 'only Cloudflare may name the visitor')
  assert.equal(ip({ 'x-forwarded-for': '162.158.1.2', 'cf-connecting-ip': '9.9.9.9' }), '9.9.9.9')
  assert.equal(ip({ 'x-forwarded-for': '2606:4700::1', 'cf-connecting-ip': '2001:db8::5' }), '2001:db8::5')
  assert.equal(ip({ 'x-forwarded-for': '162.158.1.2', 'cf-connecting-ip': 'junk' }), '162.158.1.2')
  assert.equal(ip({}), '10.0.0.1')
})

// #572: /api/img also passes AVIF and SVG pictures (avatars, chain logos), and nothing else
test('picInfo reads AVIF and SVG besides imageInfo formats', () => {
  const box = (type, body) => Buffer.concat([Buffer.from([0, 0, 0, 8 + body.length]), Buffer.from(type, 'latin1'), body])
  const ispe = Buffer.concat([Buffer.alloc(4), Buffer.from([0, 0, 2, 0, 0, 0, 1, 0])])
  const avif = Buffer.concat([box('ftyp', Buffer.from('avif\0\0\0\0mif1miaf', 'latin1')), box('meta', box('ispe', ispe))])
  assert.deepEqual(picInfo(avif), { type: 'image/avif', w: 512, h: 256 })
  const mif = Buffer.concat([box('ftyp', Buffer.from('mif1\0\0\0\0mif1avif', 'latin1')), box('ispe', ispe)])
  assert.equal(picInfo(mif)?.type, 'image/avif')
  assert.equal(picInfo(Buffer.concat([box('ftyp', Buffer.from('heic\0\0\0\0mif1heic', 'latin1')), box('ispe', ispe)])), null)
  for (const s of ['<svg xmlns="http://www.w3.org/2000/svg"/>', '﻿<?xml version="1.0"?>\n<!-- logo -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd">\n<svg>'])
    assert.equal(picInfo(Buffer.from(s))?.type, 'image/svg+xml', s)
  for (const s of ['<html><svg></svg></html>', '<!DOCTYPE svg [<!ENTITY a "aaaa">]><svg>&a;</svg>', '<svgfoo>', 'GIF'])
    assert.equal(picInfo(Buffer.from(s)), null, s)
  // a run of comments with no <svg> after them is turned down in linear time (it took seconds at 22 of them)
  const t0 = performance.now()
  assert.equal(picInfo(Buffer.from('<!---->'.repeat(500) + 'x')), null)
  assert.equal(picInfo(Buffer.from('<!-- a --><!-- b -->\n<svg>'))?.type, 'image/svg+xml')
  assert.ok(performance.now() - t0 < 500)
  // a site's favicon.ico, 0 standing for 256 px
  const ico = (w, h) => Buffer.concat([Buffer.from([0, 0, 1, 0, 1, 0, w, h]), Buffer.alloc(16)])
  assert.deepEqual(picInfo(ico(32, 32)), { type: 'image/x-icon', w: 32, h: 32 })
  assert.deepEqual(picInfo(ico(0, 0)), { type: 'image/x-icon', w: 256, h: 256 })
  assert.equal(picInfo(Buffer.concat([Buffer.from([0, 0, 2, 0, 1, 0, 32, 32]), Buffer.alloc(16)])), null, 'a cursor')
})

test('lru keeps pictures and misses, drops the least used past its size, and loads a key once at a time', async () => {
  const c = lru({ bytes: 10, count: 3, big: 6, ttl: 60e3, miss: 60e3 })
  let loads = 0
  const pic = (n) => async () => (loads++, { body: Buffer.alloc(n) })
  const [a, a2] = await Promise.all([c.get('a', pic(4)), c.get('a', pic(4))])
  assert.equal(a, a2)
  assert.equal(loads, 1)
  assert.equal(await c.get('a', pic(4)), a, 'kept')
  assert.equal(await c.get('gone', async () => (loads++, null)), null)
  assert.equal(await c.get('gone', async () => (loads++, null)), null, 'a miss is kept too')
  assert.equal(loads, 2)
  assert.equal(await c.get('err', async () => { throw new Error('timeout') }), null)
  assert.equal(c.has('err'), false, "a load that threw isn't kept")
  await c.get('big', pic(7))
  assert.equal(c.has('big'), false, 'over `big` is served but not kept')
  await c.get('b', pic(4))
  await c.get('a', pic(4)) // a is now the newest
  await c.get('c', pic(4)) // 12 bytes: the least recently used go (the miss, then b) until it fits
  assert.deepEqual(['a', 'b', 'c', 'gone'].map((k) => c.has(k)), [true, false, true, false])
  assert.equal(c.bytes, 8)
  await c.get('d', async () => null)
  await c.get('e', async () => null)
  assert.equal(c.size, 3, 'count holds too')
  assert.equal(c.has('a'), false)
})

// #676: a picture over /api/img's 8 MB is checked by its head, then the rest goes on as it comes
test('readBody cuts a long body off, or with keep hands its rest on paused', async () => {
  const src = () => {
    const s = new PassThrough()
    s.write(Buffer.alloc(6, 1)), s.write(Buffer.alloc(6, 2)), s.end(Buffer.alloc(6, 3))
    return s
  }
  assert.deepEqual(await readBody(src(), 100), { body: Buffer.concat([Buffer.alloc(6, 1), Buffer.alloc(6, 2), Buffer.alloc(6, 3)]), truncated: false })
  const cut = await readBody(src(), 8)
  assert.equal(cut.truncated, true)
  assert.deepEqual(cut.body, Buffer.concat([Buffer.alloc(6, 1), Buffer.alloc(2, 2)]))
  assert.equal(cut.rest, undefined)
  const kept = await readBody(src(), 8, true)
  assert.equal(kept.truncated, true)
  assert.deepEqual(kept.body, Buffer.concat([Buffer.alloc(6, 1), Buffer.alloc(6, 2)]))
  assert.equal(kept.rest.isPaused(), true)
  const out = new PassThrough()
  const got = []
  out.on('data', (c) => got.push(c))
  sendOn(out, kept.body, kept.rest, { max: 100, ms: 5000 })
  await new Promise((r) => out.on('end', r))
  assert.deepEqual(Buffer.concat(got), Buffer.concat([Buffer.alloc(6, 1), Buffer.alloc(6, 2), Buffer.alloc(6, 3)]))
})

test('sendOn cuts off a rest that runs past its cap or its time', async () => {
  const over = new PassThrough()
  const out = new PassThrough()
  out.resume()
  sendOn(out, Buffer.alloc(8), over, { max: 10, ms: 5000 })
  over.write(Buffer.alloc(4))
  await new Promise((r) => out.on('close', r))
  assert.equal(over.destroyed && out.destroyed, true)
  const slow = new PassThrough()
  const out2 = new PassThrough()
  out2.resume()
  sendOn(out2, Buffer.alloc(1), slow, { max: 100, ms: 20 })
  await new Promise((r) => out2.on('close', r))
  assert.equal(slow.destroyed, true)
})

test('sendOn lets go of the rest when the reader has already gone', () => {
  const rest = new PassThrough()
  const out = new PassThrough()
  out.destroy()
  sendOn(out, Buffer.alloc(1), rest, { max: 100, ms: 5000 })
  assert.equal(rest.destroyed, true)
})

// #677: a slow or cold upstream (here, scaled down: a 9 MB GIF over ~0.9 s with a 0.3 s deadline, as 16 MB over 16 s
// against /api/img's 8 s) isn't failed: what came by the deadline is checked, then the rest still streams through
test('readBody with keep hands on a slow body at its deadline, and the rest streams through', async () => {
  const gif = Buffer.alloc(9e6, 7)
  Buffer.from('474946383961400030000000', 'hex').copy(gif)
  const src = new PassThrough()
  let at = 0
  const drip = setInterval(() => {
    src.write(gif.subarray(at, (at += 1e5)))
    if (at >= gif.length) clearInterval(drip), src.end()
  }, 10)
  const t = Date.now()
  const r = await readBody(src, 8e6, true, Date.now() + 300)
  assert.ok(Date.now() - t < 600, 'resolves at the deadline, not when the body ends')
  assert.equal(r.truncated, true)
  assert.equal(r.late, true)
  assert.ok(r.body.length > 0 && r.body.length < 8e6, `${r.body.length} bytes by the deadline`)
  assert.deepEqual(picInfo(r.body), { type: 'image/gif', w: 64, h: 48 })
  assert.equal(r.rest.isPaused(), true)
  const out = new PassThrough()
  const got = []
  out.on('data', (c) => got.push(c))
  sendOn(out, r.body, r.rest, { max: 64e6, ms: 60e3 })
  await new Promise((done) => out.on('end', done))
  assert.equal(Buffer.compare(Buffer.concat(got), gif), 0)
})

test('readBody without keep ignores a deadline, and a body done in time has no rest', async () => {
  const quick = new PassThrough()
  quick.end(Buffer.alloc(10, 1))
  assert.deepEqual(await readBody(quick, 100, true, Date.now() + 1000), { body: Buffer.alloc(10, 1), truncated: false })
  const plain = new PassThrough()
  const p = readBody(plain, 100, false, Date.now() + 20)
  setTimeout(() => plain.end(Buffer.alloc(3)), 60)
  assert.deepEqual(await p, { body: Buffer.alloc(3), truncated: false })
})

test('lru never keeps a value with a rest still to come', async () => {
  const c = lru({ bytes: 100, count: 10, big: 50, ttl: 1e6, miss: 1e6 })
  await c.get('streamed', async () => ({ body: Buffer.alloc(4), rest: new PassThrough() }))
  assert.equal(c.has('streamed'), false)
  await c.get('whole', async () => ({ body: Buffer.alloc(4) }))
  assert.equal(c.has('whole'), true)
})

test('proxiedPic: a picture by its head, nothing for what is not one, a throw (not a kept miss) for a head cut short', async () => {
  const opts = { big: 64e6, pixels: 50e6 }
  const gif = Buffer.from('474946383961400030000000', 'hex')
  assert.deepEqual(proxiedPic({ status: 200, body: gif, size: 12 }, opts), { type: 'image/gif', body: gif, rest: undefined, size: 12 })
  assert.equal(proxiedPic({ status: 200, body: Buffer.from('<html>'), size: 6 }, opts), null)
  assert.equal(proxiedPic({ status: 404, body: gif, size: 12 }, opts), null)
  const huge = Buffer.from('474946383961ffffffff0000', 'hex') // 65535 x 65535
  assert.equal(proxiedPic({ status: 200, body: huge, size: 12 }, opts), null)
  const over = new PassThrough()
  assert.equal(proxiedPic({ status: 200, body: gif, size: 65e6, rest: over }, opts), null)
  assert.equal(over.destroyed, true)
  // the deadline came before a header could be read (nothing, part of one, a JPEG's long EXIF): not a verdict, so not
  // kept ten minutes as a miss (a slow page that's no picture isn't either; the per-IP limit still counts its fetches)
  for (const body of [Buffer.alloc(0), gif.subarray(0, 4), Buffer.from('ffd8ffe1', 'hex')]) {
    const rest = new PassThrough()
    assert.throws(() => proxiedPic({ status: 200, body, rest, late: true, size: 16e6 }, opts), /timeout/)
    assert.equal(rest.destroyed, true)
  }
})

test('rate limits count an IPv6 address by its /64', () => {
  assert.equal(ipGroup('203.0.113.7'), '203.0.113.7')
  assert.equal(ipGroup('::ffff:203.0.113.7'), '203.0.113.7')
  assert.equal(ipGroup('2a01:4f8:1:2:aaaa::1'), '2a01:4f8:1:2::/64')
  assert.equal(ipGroup('2a01:04f8:0001:0002:ffff:1:2:3'), '2a01:4f8:1:2::/64')
  assert.equal(ipGroup('2a01::1'), '2a01:0:0:0::/64')
  assert.equal(ipGroup('2a01:4f8::'), '2a01:4f8:0:0::/64')
})

test("a mini app embed's inline view is taken only on the app's own origin, its height held to 80-480", () => {
  const app = 'https://poll.example.com/p/1'
  assert.deepEqual(inlineOf('{"url":"https://poll.example.com/p/1?inline","height":200}', app), { url: 'https://poll.example.com/p/1?inline', height: 200 })
  assert.deepEqual(inlineOf('{"url":"https://poll.example.com/x","height":9000}', app), { url: 'https://poll.example.com/x', height: 480 })
  assert.equal(inlineOf('{"url":"https://poll.example.com/x","height":10}', app).height, 80)
  for (const bad of ['{"url":"https://evil.example/x","height":200}', '{"url":"http://poll.example.com/x","height":200}', '{"url":"https://poll.example.com/x"}', '{"url":"https://poll.example.com/x","height":"tall"}', 'not json', undefined])
    assert.equal(inlineOf(bad, app), undefined, bad)
})

test("writeAtomic leaves no temporary file when the rename fails, and fresh() doesn't keep a rejection", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qc-atomic-'))
  // a file can't take a directory's place
  await assert.rejects(writeAtomic(dir, '{}'))
  assert.deepEqual(await readdir(join(dir, '..')).then((l) => l.filter((f) => f.startsWith(dir.split('/').pop() + '.'))), [])
  const m = new Map()
  let loads = 0
  await assert.rejects(fresh(m, 10, 1e6, 'k', async () => (loads++, Promise.reject(new Error('down')))))
  assert.equal(m.has('k'), false)
  assert.equal(await fresh(m, 10, 1e6, 'k', async () => (loads++, 1)), 1)
  assert.equal(await fresh(m, 10, 1e6, 'k', async () => (loads++, 2)), 1, 'kept')
  assert.equal(loads, 2)
})
