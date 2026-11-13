import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { _db, _write, alertState, check, dropAlerts, flushAlerts, group, loadAlerts, message, offAlerts, pushTo, say } from './alerts.mjs'
import { loadMutes } from './mutes.mjs'

// a fake node (its notifications for each fid, and usernames) and spam service
let notes = {}
const spam = { casts: {}, users: {} }
const asked = []
let gate = null
let spamDown = false
const srv = createServer(async (q, r) => {
  const u = new URL(q.url, 'http://x')
  r.setHeader('content-type', 'application/json')
  if (u.pathname === '/v2/farcaster/notifications') {
    if (gate) await gate
    return r.end(JSON.stringify({ notifications: notes[u.searchParams.get('fid')] || [] }))
  }
  if (u.pathname === '/v2/farcaster/user/bulk') return r.end(JSON.stringify({ users: [{ fid: Number(u.searchParams.get('fids')), username: `name${u.searchParams.get('fids')}` }] }))
  if (u.pathname.startsWith('/spam/') && spamDown) return (r.statusCode = 503), r.end('{}')
  if (u.pathname === '/spam/scores') return asked.push('casts'), r.end(JSON.stringify(spam.casts))
  if (u.pathname === '/spam/users') return asked.push('users'), r.end(JSON.stringify(spam.users))
  r.statusCode = 404
  r.end('{}')
})
let node, dir
before(async () => {
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok))
  node = `http://127.0.0.1:${srv.address().port}`
  dir = await mkdtemp(join(tmpdir(), 'alerts-'))
  loadAlerts(dir)
  await loadMutes(dir)
})
after(() => srv.close())

const NOW = Date.parse('2026-11-09T12:00:00Z')
const at = (min) => new Date(NOW - min * 60e3).toISOString()
const user = (fid, extra = {}) => ({ fid, username: `u${fid}`, display_name: `User ${fid}`, pfp_url: `https://img.example/${fid}.png`, ...extra })
const mine = { hash: 'aa'.repeat(20), text: 'my cast about bees', author: { fid: 7 } }
const like = (fid, min = 1, cast = mine) => ({ type: 'likes', cast, user: user(fid), timestamp: at(min) })
const reply = (fid, text, hash, min = 1) => ({ type: 'reply', cast: { hash, text, author: { fid } }, user: user(fid), timestamp: at(min) })
const follow = (fid, min = 1) => ({ type: 'follows', cast: null, user: user(fid), timestamp: at(min) })
const sub = (endpoint, kinds = ['replies', 'mentions', 'quotes', 'likes', 'recasts', 'follows'], extra = {}) => ({ endpoint, keys: {}, kinds, lang: 'en', spam: { casts: false, accounts: false, at: 70 }, ...extra })
const fresh = (subs, since = NOW - 10 * 60e3) => ({ subs, since, seen: {} })
const run = async (fid, now = NOW) => {
  const sent = []
  await check(fid, { node, spamUrl: `${node}/spam`, now, send: async (s, m) => (sent.push([s.endpoint, m]), s.status || 201) })
  return sent
}
const titles = (sent) => sent.map(([, m]) => m.title)

test('what came after the sign-up is pushed once, grouped; what came before is not', async () => {
  _db({ fids: { 7: fresh([sub('https://push.example/a')], NOW - 2 * 60e3) } })
  // before the sign-up two minutes ago, and after it: a burst of likes on one cast, a reply, two follows
  notes[7] = [like(5), like(6), follow(8), reply(9, 'nice bees', '22'.repeat(20)), follow(10), like(12), like(3, 3), reply(4, 'old', '11'.repeat(20), 5)]
  const sent = await run(7)
  assert.deepEqual(sent.map(([, m]) => [m.title, m.body, m.url, m.tag]), [
    ['User 5 and 2 others liked your cast', 'my cast about bees', `/c/${mine.hash}`, `7:likes:${mine.hash}`],
    ['User 8 and 1 other followed you', 'User 8, User 10', '/notifications', '7:follows'],
    ['User 9 replied', 'nice bees', `/c/${'22'.repeat(20)}`, undefined],
  ])
  assert.equal(sent[0][1].icon, `/api/img?u=${encodeURIComponent('https://img.example/5.png')}`) // through /api/img, like every other site's picture (#572)
  assert.ok(sent.every(([, m]) => m.fid === 7))
  // nothing new, nothing sent
  assert.deepEqual(await run(7), [])
  // a like that reached the node late (its time before the last look) still goes, once
  notes[7] = [...notes[7], like(13, 1.5)]
  assert.deepEqual(titles(await run(7)), ['User 13 and 3 others liked your cast'])
  assert.deepEqual(await run(7), [])
  // only ids from the last WINDOW are kept
  assert.ok(Object.values(_db().fids[7].seen).every((t) => t > NOW - 15 * 60e3))
})

test('likes and follows add up into the notification they replace, for half an hour', async () => {
  _db({ fids: { 7: fresh([sub('https://push.example/a')]) } })
  notes[7] = [follow(30)]
  assert.deepEqual((await run(7)).map(([, m]) => [m.title, m.url, m.tag]), [['User 30 followed you', '/u/u30', '7:follows']])
  notes[7] = [follow(31, 0), ...notes[7]]
  assert.deepEqual((await run(7, NOW + 60e3)).map(([, m]) => [m.title, m.url]), [['User 31 and 1 other followed you', '/notifications']])
  // past half an hour, a new burst
  notes[7] = [{ ...follow(32), timestamp: new Date(NOW + 40 * 60e3).toISOString() }, ...notes[7]]
  assert.deepEqual(titles(await run(7, NOW + 41 * 60e3)), ['User 32 followed you'])
})

test('mutes, blocks, muted words, the account itself and old news stay out', async () => {
  _db({ fids: { 7: fresh([sub('https://push.example/a')], 0) } })
  await writeFile(join(dir, 'mutes', '7.json'), JSON.stringify({ words: [{ v: 'bees' }], users: [{ v: 20 }], blocks: [{ v: 21 }] }))
  // muted words only hide casts written by others; a like on your cast that has the word still counts
  notes[7] = [like(20), like(21), reply(22, 'I love bees', '33'.repeat(20)), like(7), reply(24, 'fine words', '44'.repeat(20)), like(25, 2), like(23, 2 * 60)]
  // in the node's order, newest first
  assert.deepEqual(titles(await run(7)), ['User 24 replied', 'User 25 liked your cast'])
  // only what was sent is kept: nothing about the muted, the blocked, the muted words or the account itself
  assert.deepEqual(Object.keys(_db().fids[7].seen).map((id) => id.split(':').at(-1)).sort(), ['24', '25'])
  // and what stayed out still stays out the next time
  assert.deepEqual(await run(7), [])
  await writeFile(join(dir, 'mutes', '7.json'), '{}')
})

test('each browser gets the kinds it asked for, in its language, past its own spam settings', async () => {
  _db({ fids: { 7: fresh([sub('https://push.example/a', ['replies']), sub('https://push.example/b', ['likes', 'replies'], { lang: 'de', spam: { casts: true, accounts: true, at: 80 } })]) } })
  spam.casts = { ['55'.repeat(20)]: 0.9, ['66'.repeat(20)]: 0.1 }
  spam.users = { 31: 0.95, 32: 0.5 }
  asked.length = 0
  notes[7] = [like(31), like(32), like(33), reply(34, 'buy now', '55'.repeat(20)), reply(35, 'hi', '66'.repeat(20))]
  const sent = await run(7)
  assert.deepEqual(titles(sent.filter(([e]) => e.endsWith('/a'))), ['User 34 replied', 'User 35 replied'])
  assert.deepEqual(titles(sent.filter(([e]) => e.endsWith('/b'))), ['User 32 und 1 weiteren Person gefällt dein Cast', 'User 35 hat geantwortet'])
  assert.deepEqual(asked.sort(), ['casts', 'users'])
})

test('a new reply the spam service has not scored yet waits, for browsers that hide spam', async () => {
  _db({ fids: { 7: fresh([sub('https://push.example/a', undefined, { spam: { casts: true, accounts: false, at: 70 } })]) } })
  spam.casts = {}
  notes[7] = [reply(36, 'cheap pills', '77'.repeat(20), 0.5)]
  assert.deepEqual(await run(7), [])
  // judged until just before the held reply, so a settings change now still lets it through
  assert.equal(_db().fids[7].checked, Date.parse(notes[7][0].timestamp) - 1)
  // scored as spam: never pushed
  spam.casts = { ['77'.repeat(20)]: 0.99 }
  assert.deepEqual(await run(7, NOW + 60e3), [])
  // another one the service never scores goes after a few minutes
  notes[7] = [reply(37, 'hello', '88'.repeat(20), 0.5), ...notes[7]]
  assert.deepEqual(await run(7, NOW + 60e3), [])
  assert.deepEqual(titles(await run(7, NOW + 4 * 60e3)), ['User 37 replied'])
  spam.casts = {}
  spam.users = {}
})

test('while the spam service is down, browsers that hide spam get nothing it would judge, and get it once it answers', async () => {
  _db({ fids: { 7: fresh([sub('https://push.example/a', undefined, { spam: { casts: true, accounts: true, at: 70 } })]) } })
  notes[7] = [reply(50, 'buy now', '99'.repeat(20), 4), like(51, 4)]
  spamDown = true
  assert.deepEqual(await run(7), [])
  assert.deepEqual(_db().fids[7].seen, {})
  spamDown = false
  spam.casts = { ['99'.repeat(20)]: 0.99 }
  assert.deepEqual(titles(await run(7, NOW + 60e3)), ['User 51 liked your cast'])
  spam.casts = {}
})

test('a new reply waits for every browser while the spam service is down, so the one that hides spam still gets it', async () => {
  _db({ fids: { 7: fresh([sub('https://push.example/plain'), sub('https://push.example/careful', undefined, { spam: { casts: true, accounts: false, at: 70 } })]) } })
  notes[7] = [reply(52, 'hello there', 'ab'.repeat(20), 0.5)]
  spamDown = true
  assert.deepEqual(await run(7), [])
  assert.deepEqual(_db().fids[7].seen, {})
  spamDown = false
  spam.casts = { ['ab'.repeat(20)]: 0.01 }
  const sent = await run(7, NOW + 60e3)
  assert.deepEqual(sent.map(([e, m]) => [e.split('/').at(-1), m.title]), [['plain', 'User 52 replied'], ['careful', 'User 52 replied']])
  spam.casts = {}
})

test('everything waits for every browser while the spam service is down, so one that hides spam accounts still gets it', async () => {
  _db({ fids: { 7: fresh([sub('https://push.example/plain'), sub('https://push.example/careful', undefined, { spam: { casts: false, accounts: true, at: 70 } })]) } })
  notes[7] = [reply(53, 'hi again', 'cd'.repeat(20), 0.5), like(54, 0.5)]
  spamDown = true
  assert.deepEqual(await run(7), [])
  assert.deepEqual(_db().fids[7].seen, {})
  spamDown = false
  spam.users = { 53: 0.01, 54: 0.01 }
  const sent = await run(7, NOW + 60e3)
  assert.deepEqual(sent.map(([e, m]) => [e.split('/').at(-1), m.title]).sort(), [['careful', 'User 53 replied'], ['careful', 'User 54 liked your cast'], ['plain', 'User 53 replied'], ['plain', 'User 54 liked your cast']])
  spam.users = {}
})

test('what happened before a browser changed its settings stays out for it', async () => {
  // likes just ticked half a minute ago
  _db({ fids: { 7: fresh([sub('https://push.example/a', undefined, { since: NOW - 30e3 })]) } })
  notes[7] = [like(52, 0.2), like(53, 1, { hash: 'bb'.repeat(20), text: 'older' })]
  assert.deepEqual((await run(7)).map(([, m]) => m.body), ['my cast about bees'])
})

test('a burst becomes a few pushes and one "more"; a browser with several accounts sees whose it is', async () => {
  _db({ fids: { 7: fresh([sub('https://push.example/a')]), 9: fresh([sub('https://push.example/a')]) } })
  notes[7] = [40, 41, 42, 43, 44, 45].map((f, i) => reply(f, `r${i}`, String(i).repeat(40)))
  const sent = await run(7)
  assert.deepEqual(titles(sent), ['User 40 replied · @name7', 'User 41 replied · @name7', 'User 42 replied · @name7', '3 more notifications · @name7'])
  assert.deepEqual([sent.at(-1)[1].url, sent.at(-1)[1].tag], ['/notifications', '7:more'])
})

test('a subscription the push service says is gone is forgotten', async () => {
  _db({ fids: { 7: fresh([{ ...sub('https://push.example/gone'), status: 410 }, sub('https://push.example/a')]) } })
  notes[7] = [follow(50)]
  assert.equal((await run(7)).length, 2)
  assert.deepEqual(_db().fids[7].subs.map((s) => s.endpoint), ['https://push.example/a'])
  _db({ fids: { 7: { ..._db().fids[7], subs: [{ ...sub('https://push.example/a'), status: 404 }] } } })
  notes[7] = [follow(51), ...notes[7]]
  await run(7)
  assert.equal(_db().fids[7], undefined)
})

test('an account deleted while its look is under way gets nothing pushed', async () => {
  _db({ fids: { 7: fresh([sub('https://push.example/a')]) } })
  notes[7] = [follow(60)]
  let open
  gate = new Promise((ok) => (open = ok))
  const pending = run(7)
  await new Promise((ok) => setTimeout(ok, 50))
  assert.equal(dropAlerts(7), true)
  open()
  gate = null
  assert.deepEqual(await pending, [])
  assert.equal(dropAlerts(7), false)
})

test('a write that failed does not stop the next one', async () => {
  _db({ fids: { 7: fresh([sub('https://push.example/a')]) } })
  _db().fids[7].seen = { first: NOW }
  // a folder in the file's place makes the write fail, as a full disk would; its temporary file goes
  await rm(join(dir, 'alerts.json'), { force: true })
  await mkdir(join(dir, 'alerts.json'))
  await assert.rejects(_write())
  await rm(join(dir, 'alerts.json'), { recursive: true })
  assert.deepEqual((await readdir(dir)).filter((f) => f.endsWith('.tmp')), [])
  _db().fids[7].seen = { second: NOW }
  await _write()
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'alerts.json'), 'utf8')).fids[7].seen, { second: NOW })
})

test('during a deploy, a change either server answered stays, sign-outs included', async () => {
  // the old server (this module) and the new one, which starts from the same folder
  const reqOf = (b) => Readable.from([JSON.stringify(b)])
  _db({ fids: { 7: fresh([sub('https://push.example/a'), sub('https://push.example/b')]), 8: fresh([sub('https://push.example/c')]) } })
  _db().fids[7].seen = { 'follows::70': NOW }
  await _write()
  const fresh2 = await import(`./alerts.mjs?second=${Date.now()}`)
  fresh2.loadAlerts(dir)
  assert.deepEqual(fresh2._db().fids[7].seen, { 'follows::70': NOW }, 'what the old server handled is not pushed again')
  // the old server takes a sign-out after the new one started, the new one takes another
  assert.deepEqual(await offAlerts(reqOf({ endpoint: 'https://push.example/a' }), 7), { ok: true })
  assert.deepEqual(await fresh2.offAlerts(reqOf({ endpoint: 'https://push.example/c' }), 8), { ok: true })
  // the old server stops and writes what it keeps; the new one's own writes come after
  await flushAlerts()
  await fresh2._write()
  // each answers what's on disk, before its next look: the other's sign-outs too
  for (const m of [{ alertState }, fresh2]) {
    assert.equal(await m.alertState(reqOf({ endpoint: 'https://push.example/a' }), 7), null)
    assert.equal(await m.alertState(reqOf({ endpoint: 'https://push.example/c' }), 8), null)
  }
  // neither server pushes to a browser that signed out on either, or has it in its state
  notes[7] = [follow(71)]
  notes[8] = [follow(72)]
  const sent = []
  const send = async (s, m) => (sent.push(s.endpoint), 201)
  for (const m of [{ check, alertState }, fresh2]) {
    for (const fid of [7, 8]) await m.check(fid, { node, spamUrl: `${node}/spam`, now: NOW, send })
    assert.equal(await m.alertState(reqOf({ endpoint: 'https://push.example/a' }), 7), null)
    assert.equal(await m.alertState(reqOf({ endpoint: 'https://push.example/c' }), 8), null)
    assert.deepEqual(await m.alertState(reqOf({ endpoint: 'https://push.example/b' }), 7), { kinds: sub('x').kinds, lang: 'en', spam: { casts: false, accounts: false, at: 70 } })
  }
  // (each server keeps its own seen ids in memory, so both may push the same one during the overlap)
  assert.deepEqual([...new Set(sent)], ['https://push.example/b'])
  assert.equal(fresh2._db().fids[8], undefined)
})

test('groups and words', () => {
  const g = group([like(1), like(2), like(1), { type: 'recasts', cast: mine, user: user(3), timestamp: at(1) }, { type: 'quote', cast: { hash: '77'.repeat(20), text: 'look' }, user: user(4), timestamp: at(1) }])
  assert.deepEqual(g.map((x) => [x.type, x.users.map((u) => u.fid)]), [['likes', [1, 2]], ['recasts', [3]], ['quote', [4]]])
  assert.equal(message(g[2], 'ru').title, 'User 4 процитировал(а) ваш каст')
  assert.equal(message(g[0], 'ru').title, 'Ваш каст лайкнули User 1 и ещё 1 человек')
  // no display name: the handle; a long cast is cut by characters, emoji whole
  const long = message({ type: 'mention', cast: { hash: 'ab'.repeat(20), text: '🐝'.repeat(300) }, users: [{ fid: 5, username: 'five' }] }, 'en')
  assert.equal(long.title, '@five mentioned you')
  assert.equal([...long.body].length, 140)
  assert.ok(!long.body.includes('�') && long.body.startsWith('🐝'))
  assert.equal(long.icon, undefined)
  // a cast with only a picture
  assert.equal(message({ type: 'likes', key: 'likes:x', cast: { hash: 'cd'.repeat(20), text: '' }, users: [user(6)] }, 'de').body, 'Dein Cast')
})

test('pushTo: one push to every browser of the account, in its language, whatever kinds it picked; a gone one is forgotten', async () => {
  _db({ fids: { 7: { since: 0, seen: {}, subs: [sub('https://push.example/a', ['likes']), sub('https://push.example/b', [], { lang: 'de' })] } } })
  const sent = []
  await pushTo(7, (lang) => ({ title: say(lang, "Your scheduled cast couldn't be posted"), body: 'x', url: '/?scheduled', tag: 'scheduled:1' }), async (s, m) => (sent.push([s.endpoint, m]), s.endpoint.endsWith('/b') ? 410 : 201))
  assert.deepEqual(sent, [
    ['https://push.example/a', { title: "Your scheduled cast couldn't be posted", body: 'x', url: '/?scheduled', tag: '7:scheduled:1', fid: 7 }],
    ['https://push.example/b', { title: 'Dein geplanter Cast konnte nicht gepostet werden', body: 'x', url: '/?scheduled', tag: '7:scheduled:1', fid: 7 }],
  ])
  assert.deepEqual(_db().fids[7].subs.map((s) => s.endpoint), ['https://push.example/a'])
  await pushTo(8, () => ({ title: 'nobody' }), async () => assert.fail('fid 8 has no browsers'))
})
