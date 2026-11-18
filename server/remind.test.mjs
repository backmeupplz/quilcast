import assert from 'node:assert/strict'
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ed25519 } from '@noble/curves/ed25519.js'
import { addReminder, cut, deliver, duration, human, loadRemind, oneClickReminder, PER_TOKEN, remindRound } from './remind.mjs'

const data = await mkdtemp(join(tmpdir(), 'qc-remind-'))
await loadRemind(data, 'https://quilcast.test')
const files = () => readdir(join(data, 'remind'))
// due time and id, without the token key
const due = async () => (await files()).map((f) => f.replace(/-[qr][\w-]{10}\.json$/, ''))
const add = (now, extra = {}) => addReminder({ token: 'tk', url: 'https://other.example/notify', hash: '0x' + 'AB'.repeat(20), fid: 7, at: now + 60e3, ...extra }, 'remind.quilcast.com', now)

test('a notification body fits the spec’s 128 UTF-16 units, cut at a whole character', () => {
  assert.equal(cut('short', 128), 'short')
  const long = cut('😀'.repeat(100), 128)
  assert.ok(long.length <= 128)
  assert.ok(long.endsWith('😀…'))
  assert.equal(cut('x'.repeat(129), 128), 'x'.repeat(127) + '…')
})

test('a reminder is kept as the notification it will send; a cast hash is lowercased, a name it can’t use is a fid', async () => {
  const now = 1_800_000_000_000
  const r = await add(now, { author: '<b>', text: '' })
  assert.match(r.id, /^[\w-]{12}$/)
  const sent = []
  await remindRound(now + 60e3, async (url, n) => (sent.push([url, n]), 'sent'))
  assert.deepEqual(sent, [['https://other.example/notify', { notificationId: `remind-${r.id}`, title: 'Reminder', body: 'The cast by fid 7', targetUrl: `https://remind.quilcast.com/?castHash=0x${'ab'.repeat(20)}&castFid=7&reminder=1`, tokens: ['tk'] }]])
  assert.deepEqual(await files(), [])
})

test('due reminders: nothing early, a retry a minute on until a day has passed, a token the host refuses dropped', async () => {
  const now = 1_900_000_000_000
  const a = await add(now)
  const b = await add(now, { at: now + 120e3 })
  let answer = 'retry'
  const seen = []
  const post = async (url, n) => (seen.push(n.notificationId), typeof answer === 'function' ? answer() : answer)
  await remindRound(now + 59e3, post)
  assert.deepEqual(seen, [])
  // a: retried, b not due yet
  await remindRound(now + 60e3, post)
  assert.deepEqual(seen, [`remind-${a.id}`])
  assert.deepEqual((await due()).sort(), [`${now + 120e3}-${a.id}`, `${now + 120e3}-${b.id}`].sort())
  // a bad request (400 from the in-process host) won't get better: dropped; a host error is retried
  answer = () => Promise.reject(Object.assign(new Error('bad notification'), { status: 400 }))
  await remindRound(now + 120e3, async (url, n) => (n.notificationId === `remind-${a.id}` ? answer() : Promise.reject(new Error('down'))))
  assert.deepEqual(await due(), [`${now + 180e3}-${b.id}`])
  // past a day of retries, it's given up
  answer = 'retry'
  await remindRound(now + 120e3 + 86400e3, post)
  assert.deepEqual(await files(), [])
  const c = await add(now)
  answer = 'invalid'
  await remindRound(now + 60e3, post)
  assert.ok(seen.includes(`remind-${c.id}`))
  assert.deepEqual(await files(), [])
})

test('a reminder is from a minute to a year away, for an https notification URL and a real cast', async () => {
  const now = 2_000_000_000_000
  for (const bad of [{ at: now + 10e3 }, { at: now + 366 * 86400e3 }, { at: 'soon' }, { url: 'http://x.example/' }, { url: 'nope' }, { token: 7 }, { hash: 'ab' }, { fid: -1 }])
    await assert.rejects(add(now, bad), (e) => e.status === 400, JSON.stringify(bad))
  await assert.rejects(addReminder(null, 'remind.quilcast.com', now), (e) => e.status === 400)
  assert.deepEqual(await files(), [])
})

test('one token keeps at most so many reminders; a made-up token for Quilcast’s own /api/notify isn’t kept', async () => {
  const now = 2_100_000_000_000
  for (let i = 0; i < PER_TOKEN; i++) await add(now, { token: 'busy' })
  await assert.rejects(add(now, { token: 'busy' }), (e) => e.status === 429)
  // another token, or the same one at another host, is its own
  await add(now, { token: 'other' })
  await add(now, { token: 'busy', url: 'https://third.example/notify' })
  await assert.rejects(add(now, { token: 'made-up', url: 'https://quilcast.test/api/notify' }), (e) => e.status === 400)
  await remindRound(now + 60e3, async () => 'sent')
  assert.deepEqual(await files(), [])
})

test('Quilcast’s own reminders go first; other hosts a few at a time, and a retry stops after 30 tries', async () => {
  const now = 2_200_000_000_000
  const order = []
  for (let i = 0; i < 20; i++) await add(now, { token: `r${i}` })
  // one for Quilcast's own /api/notify, written straight in (its token can't be made here): sent before the others
  const { writeFile } = await import('node:fs/promises')
  const q = { id: 'qqqqqqqqqqqq', key: 'qAAAAAAAAAA', url: 'https://quilcast.test/api/notify', at: now + 60e3, tries: 0, notification: { notificationId: 'remind-q', tokens: ['q'] } }
  await writeFile(join(data, 'remind', `${now + 60e3}-${q.id}-${q.key}.json`), JSON.stringify(q))
  let open = 0, most = 0
  await remindRound(now + 60e3, async (url, n) => {
    order.push(n.notificationId)
    most = Math.max(most, ++open)
    await new Promise((r) => setTimeout(r, 5))
    open--
    return 'sent'
  })
  assert.equal(order[0], 'remind-q')
  assert.equal(order.length, 21)
  assert.ok(most > 1 && most <= 8, String(most))
  assert.deepEqual(await files(), [])
  // retried every minute, but not more than 30 times
  await add(now)
  let tries = 0
  for (let t = now + 60e3; (await files()).length && tries < 40; t += 60e3) await remindRound(t, async () => (tries++, 'retry'))
  assert.equal(tries, 30)
})

test('another host’s address that can’t be reached for good drops the reminder; a timeout is tried again', async () => {
  const n = { notificationId: 'x', title: 'Reminder', body: 'b', targetUrl: 'https://remind.quilcast.com/', tokens: ['t'] }
  assert.equal(await deliver('https://127.0.0.1/notify', n), 'invalid')
  assert.equal(await deliver('https://nothing-here.invalid/notify', n), 'invalid')
})

test('a one-click duration: "1d", "3 days", "a week", "90 min"; anything else is null', () => {
  assert.equal(duration('1d'), 86400e3)
  assert.equal(duration('3 days'), 3 * 86400e3)
  assert.equal(duration(' a Week '), 604800e3)
  assert.equal(duration('90 min'), 90 * 60e3)
  assert.equal(duration('2.5h'), 2.5 * 3600e3)
  // "up to a year" reads as one too
  assert.equal(duration('1 year'), 365 * 86400e3)
  for (const bad of ['', 'soon', '0 days', '-1d', '3 fortnights', null]) assert.equal(duration(bad), null, String(bad))
  assert.deepEqual([human(90 * 60e3), human(86400e3), human(2 * 604800e3)], ['90 minutes', '1 day', '2 weeks'])
})

test('a one-click tap: signed by a key the fid holds, for this action, now; anything else is refused', async () => {
  const now = 1_800_000_000_000
  const host = 'remind.quilcast.com'
  const priv = ed25519.utils.randomSecretKey(), key = '0x' + Buffer.from(ed25519.getPublicKey(priv)).toString('hex')
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const tap = (payload, { fid = 9, k = key, sign = priv } = {}) => {
    const header = b64({ fid, type: 'app_key', key: k }), body = b64(payload)
    return { header, payload: body, signature: Buffer.from(ed25519.sign(Buffer.from(`${header}.${body}`), sign)).toString('base64url') }
  }
  const hash = '0x' + 'cd'.repeat(20)
  const good = { type: 'cast_action', url: `https://${host}/api/action?in=1d`, cast: { hash, fid: 5 }, notificationDetails: { url: 'https://other.example/notify', token: 'tok' }, timestamp: now }
  const asked = []
  const isKey = async (fid, k) => (asked.push([fid, k]), fid === 9 && k === key)
  const real = globalThis.fetch
  globalThis.fetch = async (u) => (String(u).startsWith('https://node.test/v2/farcaster/cast') ? new Response(JSON.stringify({ cast: { hash: hash.slice(2), text: 'gm', author: { fid: '4294967296', username: 'bob' } } })) : real(u))
  const run = (b) => oneClickReminder(b, host, { nodes: ['https://node.test'], node: 'https://node.test', isKey, now }).catch((e) => e)
  try {
    const before = (await files()).length
    assert.deepEqual(await run(tap(good)), { message: "I'll remind you in 1 day." })
    assert.equal((await files()).length, before + 1)
    assert.deepEqual(asked, [[9, key]])
    // what was typed, when the entry asks
    assert.deepEqual(await run(tap({ ...good, url: `https://${host}/api/action`, input: '3 hours' })), { message: "I'll remind you in 3 hours." })
    const refused = async (b, status, msg) => {
      const e = await run(b)
      assert.ok(e instanceof Error, msg)
      assert.equal(e.status, status, msg)
    }
    const other = ed25519.utils.randomSecretKey()
    await refused({ ...tap(good), signature: tap(good, { sign: other }).signature }, 401, 'signed by another key')
    await refused(tap(good, { fid: 10 }), 401, "a key the fid doesn't hold")
    await refused(tap({ event: 'notifications_enabled', notificationDetails: good.notificationDetails }), 401, 'a webhook event')
    await refused(tap({ ...good, url: 'https://evil.example/api/action?in=1d' }), 401, 'meant for another action')
    await refused(tap({ ...good, timestamp: now - 600e3 }), 401, 'too old')
    await refused(tap({ ...good, notificationDetails: undefined }), 400, 'notifications off')
    await refused(tap({ ...good, url: `https://${host}/api/action`, input: 'whenever' }), 400, 'a time it can’t read')
    // past a year: addReminder's short code comes back worded for the toast
    const far = await run(tap({ ...good, url: `https://${host}/api/action`, input: '13 months' }))
    assert.deepEqual([far.status, far.message], [400, 'Pick a time from a minute to a year away.'])
    await refused({ header: 'x', payload: 'y', signature: 'z' }, 401, 'garbage')
  } finally {
    globalThis.fetch = real
  }
})
