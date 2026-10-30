import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { blocked, clientIp, imageInfo, safeGet } from './net.mjs'
import { scan } from './unfurl.mjs'
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
