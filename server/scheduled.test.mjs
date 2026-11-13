// Scheduled casts (server/scheduled.mjs): what a PUT's messages must be, and how the rounds send them.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { before, test } from 'node:test'
import { ed25519 } from '@noble/curves/ed25519.js'
import { castAt, castBody, envelope, MT, pb, rawEd } from '../src/fc.ts'
import { createServer } from 'node:http'
import { dropScheduled, fields, LATEST, loadScheduled, readCast, readItem, SOONEST, submitTo, tick } from './scheduled.mjs'

const priv = ed25519.utils.randomSecretKey()
const key = { ...rawEd(priv), priv }
const keyHex = '0x' + Buffer.from(key.pub).toString('hex')
const NOW = Date.parse('2026-11-13T12:00:00Z')
const b64 = (m) => Buffer.from(m.msg).toString('base64')
/** A thread of `texts` for `at`, each next cast replying to the one before, a second later, as write.ts schedule signs it. */
async function thread(texts, at, { fid = 7, k = key } = {}) {
  const out = []
  let prev
  for (const [i, text] of texts.entries()) {
    const m = await castAt(fid, castBody({ text, parent: prev }), k, at + i * 1000)
    out.push(m)
    prev = { fid, hash: m.hash }
  }
  return out
}

let dir
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'scheduled-'))
  await loadScheduled(dir)
})

test('a cast signed for later carries that time and reads back as signed', async () => {
  const at = NOW + 3 * 86400e3
  const [m] = await thread(['hello later'], at)
  const c = readCast(m.msg, 7)
  assert.deepEqual(c, { at, hash: m.hash, signer: keyHex, parent: undefined, text: 'hello later' })
  // envelope() still clamps ordinary messages to ten minutes ahead
  const now = await envelope(MT.CAST_ADD, 7, castBody({ text: 'now' }), key)
  assert.ok(readCast(now.msg, 7).at <= Date.now() + 600e3)
})

test('tampered, foreign or ambiguous messages are refused', async () => {
  const [m] = await thread(['hello later'], NOW + 3600e3)
  const flip = (bytes, at) => Uint8Array.from(bytes, (x, i) => (i === at ? x ^ 1 : x))
  const textAt = Buffer.from(m.msg).lastIndexOf(Buffer.from('hello'))
  assert.throws(() => readCast(flip(m.msg, textAt), 7), /bad message/)
  assert.throws(() => readCast(m.msg, 8), /bad message: fid/)
  // the data a node stores must be the data that was hashed and signed
  const data = (await thread(['hello later'], NOW + 3600e3))[0]
  const f = fields(data.msg)
  const other = (await thread(['something else'], NOW + 3600e3))[0]
  const mixed = pb([1, fields(other.msg).get(7)], [2, f.get(2)], [3, 1], [4, f.get(4)], [5, 1], [6, f.get(6)], [7, f.get(7)])
  assert.throws(() => readCast(mixed, 7), /data differs/)
  // a field twice (protobuf would take the last) is no guess
  assert.throws(() => readCast(new Uint8Array([...m.msg, ...pb([3, 1])]), 7), /field twice/)
  assert.throws(() => readCast(m.msg.subarray(0, 40), 7), /bad message/)
  // a reply that is also a channel post is neither for sure
  const both = await castAt(7, pb([3, pb([1, 7], [2, new Uint8Array(20)])], [7, 'https://warpcast.com/~/channel/x'], [4, 'hm']), key, NOW + 3600e3)
  assert.throws(() => readCast(both.msg, 7), /bad message: parent/)
  // a parent that isn't a CastId is a 400, not a crash
  const broken = await castAt(7, pb([3, Uint8Array.of(0x0b)], [4, 'hm']), key, NOW + 3600e3)
  assert.throws(() => readCast(broken.msg, 7), (e) => e.status === 400 && /parent/.test(e.message))
  // a like isn't a cast
  const like = await envelope(MT.REACTION_ADD, 7, pb([1, 1], [2, pb([1, 9], [2, new Uint8Array(20)])]), key)
  assert.throws(() => readCast(like.msg, 7), /not a cast/)
})

test('an item: the account’s key, a time between a minute and 30 days on, and a real thread', async () => {
  const at = NOW + 3600e3
  const msgs = (await thread(['one', 'two', 'three'], at)).map(b64)
  const casts = readItem(msgs, 7, [keyHex], NOW)
  assert.deepEqual(casts.map((c) => c.text), ['one', 'two', 'three'])
  assert.deepEqual(casts[1].parent, { fid: 7, hash: casts[0].hash })
  // a key the node doesn't list for the account
  const stranger = rawEd(ed25519.utils.randomSecretKey())
  const foreign = (await thread(['x'], at, { k: stranger })).map(b64)
  assert.throws(() => readItem(foreign, 7, [keyHex], NOW), /doesn't belong/)
  // the server's clock decides
  const soon = (await thread(['x'], NOW + SOONEST - 1000)).map(b64)
  const far = (await thread(['x'], NOW + LATEST + 60e3)).map(b64)
  assert.throws(() => readItem(soon, 7, [keyHex], NOW), /at least a minute/)
  assert.throws(() => readItem(far, 7, [keyHex], NOW), /30 days/)
  // posts that don't reply to the one before aren't a thread
  const [a] = await thread(['a'], at)
  const [b] = await thread(['b'], at + 1000)
  assert.throws(() => readItem([b64(a), b64(b)], 7, [keyHex], NOW), /bad thread/)
  assert.throws(() => readItem([], 7, [keyHex], NOW), /bad messages/)
  assert.throws(() => readItem(['not base64!'], 7, [keyHex], NOW), /bad messages/)
})

const put = async (item) => {
  await mkdir(join(dir, 'scheduled', String(item.fid)), { recursive: true })
  await writeFile(join(dir, 'scheduled', String(item.fid), `${item.id}.json`), JSON.stringify(item))
}
const get = async (fid, id) => JSON.parse(await readFile(join(dir, 'scheduled', String(fid), `${id}.json`), 'utf8').catch(() => 'null'))
const item = async (id, at, texts = ['hi'], fid = 7) => {
  const ms = await thread(texts, at, { fid })
  return { id, fid, at, msgs: ms.map(b64), hashes: ms.map((m) => m.hash), text: texts[0], status: 'scheduled', posted: 0, created: NOW }
}
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

test('a round sends what is due, in order, and leaves the rest', async () => {
  const due = await item(uuid(1), NOW - 1000, ['first', 'second'])
  const notYet = await item(uuid(2), NOW + 60e3)
  await put(due)
  await put(notYet)
  const sent = []
  await tick({ now: NOW, submit: async (b) => (sent.push(readCast(b, 7).text), 'ok'), notify: () => assert.fail('nothing failed') })
  assert.deepEqual(sent, ['first', 'second'])
  assert.equal((await get(7, uuid(1))).status, 'posted')
  assert.equal((await get(7, uuid(2))).status, 'scheduled')
  // nothing goes twice
  await tick({ now: NOW + 1000, submit: async () => assert.fail('sent again'), notify: () => {} })
  // posted ones leave the list after a few days
  await tick({ now: NOW + 4 * 86400e3, submit: async () => 'ok', notify: () => {} })
  assert.equal(await get(7, uuid(1)), null)
})

test('a node that is down is tried again; a refusal fails the cast and the account is told', async () => {
  const flaky = await item(uuid(3), NOW, ['a', 'b'], 9)
  const revoked = await item(uuid(4), NOW, ['c'], 9)
  await put(flaky)
  await put(revoked)
  const told = []
  let calls = 0
  const submit = async (b) => {
    const c = readCast(b, 9)
    if (c.text === 'c') throw Object.assign(new Error('invalid signer'), { retry: false })
    if (c.text === 'b' && calls++ === 0) throw Object.assign(new Error('node busy'), { retry: true })
    return 'ok'
  }
  await tick({ now: NOW, submit, notify: async (i) => told.push(i.id) })
  const f = await get(9, uuid(3))
  assert.deepEqual([f.status, f.posted, f.error, f.next], ['scheduled', 1, 'node busy', NOW + 60e3])
  assert.deepEqual([(await get(9, uuid(4))).status, (await get(9, uuid(4))).error], ['failed', 'invalid signer'])
  assert.deepEqual(told, [uuid(4)])
  // a minute later it goes on from the second cast
  const sent = []
  await tick({ now: NOW + 60e3, submit: async (b) => (sent.push(readCast(b, 9).text), 'ok'), notify: () => {} })
  assert.deepEqual(sent, ['b'])
  assert.equal((await get(9, uuid(3))).status, 'posted')
  // a node down for over an hour past the time: failed
  await put(await item(uuid(5), NOW, ['d'], 9))
  await tick({ now: NOW + 2 * 3600e3, submit: async () => { throw Object.assign(new Error('down'), { retry: true }) }, notify: async (i) => told.push(i.id) })
  assert.equal((await get(9, uuid(5))).status, 'failed')
  assert.deepEqual(told, [uuid(4), uuid(5)])
})

test('deleting the account drops its scheduled casts', async () => {
  await put(await item(uuid(6), NOW + 3600e3, ['x'], 11))
  assert.equal(await dropScheduled(11), 1)
  assert.deepEqual(await readdir(join(dir, 'scheduled', '11')).catch(() => []), [])
  await tick({ now: NOW + 7200e3, submit: async () => assert.fail('dropped'), notify: () => {} })
})

test('submitTo: the node already having the message counts as sent, in any of its words; its reason otherwise', async () => {
  const answers = {
    '/hub/v1/submitMessage': [400, { errCode: 'bad_request.duplicate', presentable: false, name: 'HubError', code: 3, details: 'message has already been merged' }],
    // Hypersnap (src/network/http_server.rs submit_message): a 400 whose error_detail is the gRPC status, its message the
    // HubError as "<code>/<message>" (src/core/error.rs), the code bad_request.duplicate (mempool.rs) once more in the
    // x-err-code metadata. The text alone, without the code, is matched too.
    '/snap/v1/submitMessage': [400, { error: 'Failed to submit message', error_detail: 'status: InvalidArgument, message: "bad_request.duplicate/message has already been merged", details: [], metadata: MetadataMap { headers: {"x-err-code": "bad_request.duplicate"} }' }],
    '/mempool/v1/submitMessage': [400, { error: 'Failed to submit message', error_detail: 'status: InvalidArgument, message: "message already in the mempool"' }],
    '/bad/v1/submitMessage': [400, { errCode: 'bad_request.validation_failure', details: 'invalid signer' }],
    '/snapbad/v1/submitMessage': [400, { error: 'Failed to submit message', error_detail: 'invalid signer' }],
    '/busy/v1/submitMessage': [503, { details: 'node is starting' }],
    '/ok/v1/submitMessage': [200, {}],
  }
  const srv = createServer((q, r) => {
    const [status, body] = answers[q.url] || [404, {}]
    r.statusCode = status
    r.end(JSON.stringify(body))
  })
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok))
  const at = (p) => `http://127.0.0.1:${srv.address().port}/${p}`
  try {
    const bytes = new Uint8Array([1, 2, 3])
    assert.equal(await submitTo(at('ok'), bytes), 'ok')
    assert.equal(await submitTo(at('hub'), bytes), 'ok')
    assert.equal(await submitTo(at('snap'), bytes), 'ok')
    assert.equal(await submitTo(at('mempool'), bytes), 'ok')
    await assert.rejects(submitTo(at('bad'), bytes), (e) => e.message === 'invalid signer' && !e.retry)
    await assert.rejects(submitTo(at('snapbad'), bytes), (e) => e.message === 'invalid signer' && !e.retry)
    await assert.rejects(submitTo(at('busy'), bytes), (e) => e.retry === true)
    await assert.rejects(submitTo('http://127.0.0.1:1', bytes), (e) => e.retry === true)
  } finally {
    srv.close()
  }
})

test('an item being sent is neither cancelled nor replaced; one removed while it is sent stays gone', async () => {
  const { cancelScheduled, putScheduled } = await import('./scheduled.mjs')
  // a node that lists fid 12's key, for the handlers' key check
  const srv = createServer((q, r) => r.end(JSON.stringify({ signers: q.url.includes('fid=12') ? [{ key: keyHex }] : [] })))
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok))
  const node = `http://127.0.0.1:${srv.address().port}`
  const req = (what, body) => {
    const ts = Date.now()
    const sig = Buffer.from(ed25519.sign(Buffer.from(`${what}:12:${ts}:${body}`), key.priv)).toString('hex')
    return Object.assign(Readable.from([body]), { headers: { 'x-key': keyHex, 'x-ts': String(ts), 'x-sig': sig } })
  }
  try {
    const it = await item(uuid(7), NOW - 1000, ['busy'], 12)
    await put(it)
    let release
    const gate = new Promise((ok) => (release = ok))
    const round = tick({ now: NOW, submit: () => gate.then(() => 'ok'), notify: () => {} })
    await new Promise((ok) => setTimeout(ok, 50))
    assert.equal((await get(12, uuid(7))).status, 'posting')
    const cancel = JSON.stringify({ id: uuid(7) })
    await assert.rejects(cancelScheduled(req('quilcast-scheduled-cancel', cancel), 12, node), (e) => e.status === 409)
    const again = JSON.stringify({ id: uuid(7), msgs: (await thread(['edited'], Date.now() + 3600e3, { fid: 12 })).map(b64) })
    await assert.rejects(putScheduled(req('quilcast-scheduled', again), 12, node), (e) => e.status === 409)
    release()
    await round
    assert.equal((await get(12, uuid(7))).status, 'posted')
    // one still waiting is replaced in place (Edit), keeping its id
    const waiting = await item(uuid(9), Date.now() + 3600e3, ['first version'], 12)
    await put(waiting)
    const edited = await thread(['second version'], Date.now() + 7200e3, { fid: 12 })
    const r = await putScheduled(req('quilcast-scheduled', JSON.stringify({ id: uuid(9), msgs: edited.map(b64) })), 12, node)
    assert.deepEqual([r.id, r.hash, (await get(12, uuid(9))).text], [uuid(9), edited[0].hash, 'second version'])
    assert.deepEqual(await cancelScheduled(req('quilcast-scheduled-cancel', JSON.stringify({ id: uuid(9) })), 12, node), { id: uuid(9), was: 'scheduled' })
    // a thread half sent before a node error: no longer replaced; cancelling stops the rest and says part went out
    await put({ ...(await item(uuid(10), NOW - 1000, ['one', 'two'], 12)), posted: 1, error: 'node busy', next: NOW + 60e3 })
    const redo = JSON.stringify({ id: uuid(10), msgs: (await thread(['redo'], Date.now() + 3600e3, { fid: 12 })).map(b64) })
    await assert.rejects(putScheduled(req('quilcast-scheduled', redo), 12, node), (e) => e.status === 409)
    assert.deepEqual(await cancelScheduled(req('quilcast-scheduled-cancel', JSON.stringify({ id: uuid(10) })), 12, node), { id: uuid(10), was: 'posted' })
    assert.equal(await get(12, uuid(10)), null)
  } finally {
    srv.close()
  }
  // removed while it's being sent (by the other server during a deploy): what came of it isn't written back
  await put(await item(uuid(8), NOW - 1000, ['never'], 12))
  await tick({ now: NOW, submit: async () => (await rm(join(dir, 'scheduled', '12', `${uuid(8)}.json`)), 'ok'), notify: () => {} })
  assert.equal(await get(12, uuid(8)), null)
})
