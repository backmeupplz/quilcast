import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

// the module's clock, moved on by the tests
let now = Date.parse('2026-11-06T12:00:00Z')
Date.now = () => now
const DAY = 864e5
const dir = await mkdtemp(join(tmpdir(), 'quilcast-stats-'))
// a fresh copy of the module, as after a restart
let n = 0
const fresh = async () => {
  const m = await import(`./stats.mjs?${++n}`)
  await m.loadStats(dir)
  return m
}
const files = async () => [await readFile(join(dir, 'stats', 'counts.json'), 'utf8'), await readFile(join(dir, 'stats', 'today.json'), 'utf8')]

test('accounts count once a day, across a restart, and only the numbers outlive the day', async () => {
  let s = await fresh()
  assert.deepEqual(s.stats(), { signedIn: [{ day: '2026-11-06', count: 0 }], campaigns: [] })
  for (const fid of [123456, 123456, '654321', 0, -1, NaN, 1.5]) s.seen(fid)
  assert.deepEqual(s.stats().signedIn, [{ day: '2026-11-06', count: 2 }])
  await s.flushStats()
  // what's on disk: counts, and today's accounts as salted hashes only
  let [counts, today] = await files()
  assert.ok(!/123456|654321/.test(counts + today), counts + today)
  assert.equal(JSON.parse(today).seen.length, 2)

  // a restart the same day: the same accounts don't count again, a new one does
  s = await fresh()
  s.seen(123456)
  s.seen(777)
  assert.deepEqual(s.stats().signedIn, [{ day: '2026-11-06', count: 3 }])

  // the next UTC day: yesterday's number stays, its accounts and salt go
  const salt = JSON.parse(today).salt
  now += DAY
  s.seen(123456)
  await s.flushStats()
  assert.deepEqual(s.stats().signedIn, [{ day: '2026-11-06', count: 3 }, { day: '2026-11-07', count: 1 }])
  ;[counts, today] = await files()
  assert.equal(JSON.parse(today).day, '2026-11-07')
  assert.notEqual(JSON.parse(today).salt, salt)
  assert.equal(JSON.parse(today).seen.length, 1)
  assert.deepEqual(JSON.parse(counts).signedIn, { '2026-11-06': 3, '2026-11-07': 1 })

  // a quiet day is a zero; only the last 90 days show, today the last of them
  now += 2 * DAY
  assert.deepEqual(s.stats().signedIn.slice(-2), [{ day: '2026-11-08', count: 0 }, { day: '2026-11-09', count: 0 }])
  now += 100 * DAY
  const days = s.stats().signedIn
  assert.equal(days.length, 90)
  assert.equal(days.at(-1).day, new Date(now).toISOString().slice(0, 10))
  assert.ok(days.every((d) => d.count === 0))
})

test('campaign sign-ups: counted per day and campaign, an account once a day, only valid names', async () => {
  now = Date.parse('2027-03-01T23:59:00Z')
  const s = await fresh()
  assert.equal(s.joined(5, 'p7-a'), true)
  assert.equal(s.joined(5, 'p7-b'), false)
  assert.equal(s.joined(6, 'p7-a'), true)
  assert.equal(s.joined(8, 'p7_B'), true)
  for (const bad of ['', 'a b', 'x'.repeat(65), 'ü', null, 7, undefined]) assert.equal(s.joined(9, bad), false)
  assert.equal(s.joined(9, 'x'.repeat(64)), true)
  now += 120e3
  // a new day: the same account counts again
  assert.equal(s.joined(5, 'p7-a'), true)
  await s.flushStats()
  const { campaigns } = s.stats()
  assert.deepEqual(campaigns, [
    { day: '2027-03-01', campaign: 'p7-a', count: 2 },
    { day: '2027-03-01', campaign: 'p7_B', count: 1 },
    { day: '2027-03-01', campaign: 'x'.repeat(64), count: 1 },
    { day: '2027-03-02', campaign: 'p7-a', count: 1 },
  ])
  // nothing ties a campaign to an account, on disk or in the answer
  const [counts, today] = await files()
  assert.ok(JSON.parse(today).seen.every((h) => /^[0-9a-f]{32}$/.test(h)))
  assert.deepEqual(Object.keys(JSON.parse(counts)).sort(), ['campaigns', 'signedIn', 'since'])
  // which accounts brought a sign-up is never written: today's file has the signed-in hashes only
  assert.deepEqual(Object.keys(JSON.parse(today)).sort(), ['day', 'salt', 'seen'])
  // so after a restart the same day an account may count once more (memory only, accepted)
  const again = await fresh()
  assert.equal(again.joined(5, 'p7-c'), true)
  assert.equal(again.joined(5, 'p7-c'), false)
})

test("a lost counts file: today still shows, never below today's accounts", async () => {
  now = Date.parse('2027-05-01T10:00:00Z')
  let s = await fresh()
  s.seen(1)
  s.seen(2)
  await s.flushStats()
  await rm(join(dir, 'stats', 'counts.json'))
  s = await fresh()
  // today's accounts kept show at once, before any new one comes
  s.seen(1)
  assert.deepEqual(s.stats().signedIn, [{ day: '2027-05-01', count: 2 }])
  s.seen(3)
  assert.deepEqual(s.stats(), { signedIn: [{ day: '2027-05-01', count: 3 }], campaigns: [] })
  // and a lost today file doesn't take the day's count down
  await s.flushStats()
  await rm(join(dir, 'stats', 'today.json'))
  s = await fresh()
  s.seen(4)
  assert.deepEqual(s.stats().signedIn, [{ day: '2027-05-01', count: 3 }])
})

test('a torn or garbage file is moved aside and counting goes on', async () => {
  now = Date.parse('2027-06-01T10:00:00Z')
  let s = await fresh()
  s.seen(1)
  assert.equal(s.joined(1, 'p7-a'), true)
  await s.flushStats()
  for (const [counts, today] of [['', ''], ['{"signedIn": {"2027-06-0', 'not json'], ['null', '[1,2]'], ['"x"', '7']]) {
    now += 1e3
    await writeFile(join(dir, 'stats', 'counts.json'), counts)
    await writeFile(join(dir, 'stats', 'today.json'), today)
    s = await fresh()
    s.seen(2)
    assert.equal(s.joined(2, 'p7-b'), true)
    await s.flushStats()
    assert.deepEqual(s.stats(), { signedIn: [{ day: '2027-06-01', count: 1 }], campaigns: [{ day: '2027-06-01', campaign: 'p7-b', count: 1 }] })
    const [c, t] = await files()
    assert.deepEqual(JSON.parse(c).signedIn, { '2027-06-01': 1 })
    assert.equal(JSON.parse(t).seen.length, 1)
  }
  // the unreadable ones were kept beside, not written over
  const bad = (await readdir(join(dir, 'stats'))).filter((f) => f.includes('.bad-'))
  // an empty file is set aside too (it's what a crash between write and rename leaves); only the counts file is kept
  // beside: a torn today file holds the day's salt next to its accounts' hashes, so it's deleted
  assert.ok(bad.length >= 4 && bad.every((f) => f.startsWith('counts.json.bad-')), bad.join())
})

test('a request during start-up counts once what is kept has been read', async () => {
  now = Date.parse('2027-07-01T10:00:00Z')
  let s = await fresh()
  s.seen(1)
  await s.flushStats()
  s = await import(`./stats.mjs?${++n}`)
  s.seen(1)
  s.seen(2)
  await s.loadStats(dir)
  await s.ready
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(s.stats().signedIn.at(-1), { day: '2027-07-01', count: 2 })
})

test('days older than 90 are dropped from the kept counts', async () => {
  now = Date.parse('2027-08-01T10:00:00Z')
  let s = await fresh()
  s.seen(1)
  s.joined(1, 'old')
  await s.flushStats()
  now += 95 * DAY
  s.seen(1)
  await s.flushStats()
  const [c] = await files()
  assert.deepEqual(Object.keys(JSON.parse(c).signedIn).filter((d) => d < '2027-08-02'), [])
  assert.deepEqual(Object.keys(JSON.parse(c).campaigns).filter((d) => d < '2027-08-02'), [])
})

test("a torn today file, or one left half-written, doesn't outlive its day", async () => {
  now = Date.parse('2029-07-01T10:00:00Z')
  let s = await fresh()
  s.seen(1)
  await s.flushStats()
  await writeFile(join(dir, 'stats', 'today.json'), '{"day":"2029-07-01","salt":"ab')
  await writeFile(join(dir, 'stats', 'today.json.tmp'), '{"day":"2029-07-01","salt":"ab","seen":[]}')
  await writeFile(join(dir, 'stats', 'today.json.bad-1'), '{"day":"2029-07-01","salt":"ab","seen":[]}')
  s = await fresh()
  s.seen(2)
  now += 1 * DAY
  s.seen(3)
  await s.flushStats()
  const left = (await readdir(join(dir, 'stats'))).filter((f) => f.startsWith('today.json'))
  assert.deepEqual(left, ['today.json'])
  assert.equal(JSON.parse((await files())[1]).day, '2029-07-02')
})

test('campaigns named like Object.prototype members count like any other, and kept counts are numbers only', async () => {
  now = Date.parse('2029-08-01T10:00:00Z')
  let s = await fresh()
  const names = ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__']
  names.forEach((c, i) => assert.equal(s.joined(100 + i, c), true))
  const want = names.map((campaign) => ({ day: '2029-08-01', campaign, count: 1 })).sort((a, b) => (a.campaign < b.campaign ? -1 : 1))
  const on = () => s.stats().campaigns.filter((c) => c.day === '2029-08-01')
  assert.deepEqual(on(), want)
  await s.flushStats()
  // and the same after a restart, from the file
  s = await fresh()
  assert.deepEqual(on(), want)
  // a kept file with bad values: only finite non-negative whole counts, valid days and campaign names come back
  await writeFile(
    join(dir, 'stats', 'counts.json'),
    JSON.stringify({
      since: '2029-08-01',
      signedIn: { '2029-08-01': 'x', '2029-07-31': 4, 'toString': 9, '2029-07-30': -1 },
      campaigns: { '2029-08-01': { 'p7-a': '1', 'p7-b': 2, 'a b': 3, 'p7-c': 1.5 }, nope: { x: 1 }, '2029-07-31': 'x' },
    }),
  )
  s = await fresh()
  const r = s.stats()
  assert.deepEqual(r.campaigns, [{ day: '2029-08-01', campaign: 'p7-b', count: 2 }])
  assert.deepEqual(r.signedIn, [{ day: '2029-08-01', count: 0 }])
  assert.ok(r.signedIn.concat(r.campaigns).every((d) => Number.isSafeInteger(d.count)))
})
