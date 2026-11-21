// What the server's tests share. Not a test file itself: its name doesn't end in .test.mjs.
import assert from 'node:assert/strict'
import { ed25519 } from '@noble/curves/ed25519.js'
import { request } from 'node:http'
import { castAt, castBody } from '../src/fc.ts'

/** `key`'s x-key, x-ts and x-sig over "<what>:<fid>:<ts>:<body>", as the app signs (server/looks.mjs keySigned). */
export const signed = (key, what, fid, body = '', ts = Date.now()) => ({
  'x-key': '0x' + Buffer.from(ed25519.getPublicKey(key)).toString('hex'),
  'x-ts': String(ts),
  'x-sig': Buffer.from(ed25519.sign(Buffer.from(`${what}:${fid}:${ts}:${body}`), key)).toString('hex'),
})

/** A request to the server on `port` as if for `host` (fetch can't send another Host): { status, headers, body } with the
 *  body as text. */
export const hostGet = (port, host, path, { method = 'GET', headers = {}, body } = {}) => new Promise((ok, no) => request({ host: '127.0.0.1', port, path, method, headers: { host, ...headers } }, (r) => {
  const parts = []
  r.on('data', (d) => parts.push(d)).on('end', () => ok({ status: r.statusCode, headers: r.headers, body: Buffer.concat(parts).toString() }))
}).on('error', no).end(body))

/** The embed a page's fc:miniapp tag holds. */
export const embedOf = (html) => JSON.parse(html.match(/<meta name="fc:miniapp" content="([^"]*)"/)[1].replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)))

/** A PNG's width and height, from its header. */
export const sizeOf = (png) => [png.readUInt32BE(16), png.readUInt32BE(20)]

/** The header of a PNG 1 pixel wide and `h` high, then 40 bytes of `fill`: enough for the upload checks. */
export const pngStub = (h, fill = 0) => Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.from([0, 0, 0, 1, 0, 0, 0, h]), Buffer.alloc(40, fill)])

/** An upload's one chunk sent and its done asked for (server/upload.mjs): its state once it's no longer sending. */
export async function uploaded(base, id, body) {
  assert.equal((await fetch(`${base}/api/upload/${id}?offset=0`, { method: 'PUT', body })).status, 200)
  let st = await (await fetch(`${base}/api/upload/${id}/done`, { method: 'POST' })).json()
  for (let i = 0; i < 50 && st.state === 'sending'; i++) await new Promise((r) => setTimeout(r, 100)), (st = await (await fetch(`${base}/api/upload/${id}`)).json())
  return st
}

/** A thread of `texts` for `at`, each next cast replying to the one before a second later, as write.ts schedule signs it. */
export async function thread(texts, at, fid, k) {
  const out = []
  let prev
  for (const [i, text] of texts.entries()) {
    const m = await castAt(fid, castBody({ text, parent: prev }), k, at + i * 1000)
    out.push(m)
    prev = { fid, hash: m.hash }
  }
  return out
}
