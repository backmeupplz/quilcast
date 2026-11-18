import assert from 'node:assert/strict'
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { addReminder, cut, deliver, loadRemind, PER_TOKEN, remindRound } from './remind.mjs'

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
