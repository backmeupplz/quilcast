// keySigned, which every signed route uses: a node that can't be asked never reads as "not your key"
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { after, mock, test } from 'node:test'
import { ed25519 } from '@noble/curves/ed25519.js'
import { keySigned } from './looks.mjs'

const key = ed25519.utils.randomSecretKey()
const soon = ed25519.utils.randomSecretKey()
const hexOf = (k) => '0x' + Buffer.from(ed25519.getPublicKey(k)).toString('hex')
// 'up' lists `key` for every FID, and `soon` expiring in 30 s; 'none' lists nothing (the key was revoked); 'reset'
// drops the connection; 'error' answers like Cloudflare does when haatz is down
let node = 'up'
const srv = createServer((q, r) =>
  node === 'reset' ? q.socket.destroy()
    : node === 'error' ? r.writeHead(502).end('error code: 502')
    : r.end(JSON.stringify({ signers: node === 'none' ? [] : [{ key: hexOf(key) }, { key: hexOf(soon), expiresAt: Math.floor(Date.now() / 1000) + 30 }] })))
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const url = `http://127.0.0.1:${srv.address().port}`
after(() => srv.close())

const check = (fid, k = key, outage = true) => {
  const ts = Date.now()
  const headers = { 'x-key': hexOf(k), 'x-ts': String(ts), 'x-sig': Buffer.from(ed25519.sign(Buffer.from(`w:${fid}:${ts}:`), k)).toString('hex') }
  return keySigned({ headers }, 'w', fid, '', url, undefined, outage).then(() => 200, (e) => e.status || 500)
}

test('keySigned: a node that is down answers 502, and a key it listed in the last hour still counts', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.now() })
  try {
    assert.equal(await check(1), 200)
    assert.equal(await check(1, soon), 200)
    assert.equal(await check(1, ed25519.utils.randomSecretKey()), 403)
    for (node of ['reset', 'error']) {
      // past the minute the node's answer is kept, so it's asked again
      mock.timers.tick(61e3)
      assert.equal(await check(1), 200)
      // not for what can't be undone, nor a key that has expired since
      assert.equal(await check(1, key, false), 502)
      assert.equal(await check(1, soon), 502)
      // a key the node didn't list, or an account it was never asked about, waits for the node instead of a 403
      // (a 403 makes the browser replace its key)
      assert.equal(await check(1, ed25519.utils.randomSecretKey()), 502)
      assert.equal(await check(2), 502)
    }
    mock.timers.tick(3600e3)
    assert.equal(await check(1), 502)
    node = 'up'
    assert.equal(await check(1), 200)
    // a key the node stops listing doesn't come back while it's down, also when another key's request saw that
    node = 'none'
    mock.timers.tick(61e3)
    assert.equal(await check(1, ed25519.utils.randomSecretKey()), 403)
    node = 'reset'
    mock.timers.tick(61e3)
    assert.equal(await check(1), 502)
  } finally {
    mock.timers.reset()
  }
})
