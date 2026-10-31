// Settings → Delete account (write.ts deleteServerData, eraseFarcaster) against a fake node and server.
import assert from 'node:assert/strict'
import { test } from 'node:test'

const store = new Map<string, string>()
Object.assign(globalThis, { addEventListener: () => {}, dispatchEvent: () => true })
;(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) }
const { hex, MT } = await import('./fc.ts')
const api = await import('./api.ts')
const { deleteServerData, eraseFarcaster } = await import('./write.ts')
// no IndexedDB here, so the key stays raw in the account; the node lists it (signerAt and scopes are current)
api.setAccount({ phrase: 'test test test test test test test test test test test junk', custody: '0x7', fid: 7, signer: hex(new Uint8Array(32).fill(3)), signerAt: Math.floor(Date.now() / 1000), scopes: 2, done: true })

// the message type of a submitted Message: field 1 (data) holds MessageData, whose field 1 is the type
const typeOf = (b: Uint8Array) => {
  let i = 1
  while (b[i] & 0x80) i++
  return b[i + 2]
}
const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
const cast = (n: number) => ({ hash: '0x' + n.toString(16).padStart(40, '0'), data: { castAddBody: { text: `cast ${n}` } } })
// once messages go out, the lists hold only what `left` keeps (what the node still has)
const fake = (submit: (type: number, n: number) => Response, left: (path: string) => boolean = () => false) => {
  const seen: number[] = []
  const asked: string[] = []
  ;(globalThis as any).fetch = async (url: string, o: any = {}) => {
    const u = new URL(url, 'https://quilcast.test')
    const q = u.searchParams
    if (u.pathname === '/api/account/7') {
      asked.push(`${o.method} ${o.headers['x-sig'] ? 'signed' : ''}`)
      return res(200, asked.length < 2 ? { state: 'running' } : { state: 'done', media: 2, kept: 0, look: true, mutes: true, drafts: 0, translations: 0 })
    }
    if (u.pathname === '/v1/submitMessage') return (seen.push(typeOf(o.body)), submit(typeOf(o.body), seen.length))
    assert.equal(q.get('fid'), '7')
    if (seen.length && !left(u.pathname)) return res(200, { messages: [], nextPageToken: '' })
    // two pages of casts; the second page's token is the node's
    if (u.pathname === '/v1/castsByFid') return res(200, q.get('pageToken') === 'next' ? { messages: [cast(3)], nextPageToken: '' } : { messages: [cast(1), cast(2)], nextPageToken: 'next' })
    if (u.pathname === '/v1/reactionsByFid') return res(200, { messages: [{ data: { reactionBody: { type: q.get('reaction_type') === 'Like' ? 'REACTION_TYPE_LIKE' : 'REACTION_TYPE_RECAST', targetCastId: { fid: 2, hash: '0x' + 'ab'.repeat(20) } } } }] })
    if (u.pathname === '/v1/linksByFid') return res(200, { messages: [{ data: { linkBody: { type: 'follow', targetFid: 2 } } }, { data: { linkBody: { type: 'follow', targetFid: 3 } } }] })
    if (u.pathname === '/v1/userDataByFid')
      return res(200, { messages: [['PFP', 'https://x/p.png'], ['DISPLAY', 'Seven'], ['BIO', ''], ['USERNAME', 'seven'], ['GITHUB', 'seven']].map(([k, value]) => ({ data: { userDataBody: { type: `USER_DATA_TYPE_${k}`, value } } })) })
    throw new Error(`unexpected ${url}`)
  }
  return { seen, asked }
}

test('our server is asked, signed, until it has deleted everything', async () => {
  const { asked } = fake(() => res(200, {}))
  assert.equal((await deleteServerData()).media, 2)
  assert.deepEqual(asked, ['DELETE signed', 'DELETE signed'])
})

test('casts, likes, recasts and follows are removed and the profile emptied, waiting out a rate limit', async () => {
  // the first message is rate limited once; one cast was already removed elsewhere
  const { seen } = fake((_type, n) => (n === 1 ? res(429, { message: 'rate limit exceeded' }) : n === 3 ? res(400, { details: 'message conflicts with a CastRemove' }) : res(200, {})))
  const steps = new Map<string, number>()
  const out = await eraseFarcaster((step, done, total) => steps.set(step, Math.max(steps.get(step) ?? 0, done === total ? total : 0)), 10)
  assert.deepEqual(out, { casts: 3, reactions: 2, follows: 2, profile: 2, failed: 0 })
  // every cast and reaction and follow once (plus the retry), and only the profile fields that have a value and can be emptied
  const count = (t: number) => seen.filter((x) => x === t).length
  assert.deepEqual([count(MT.CAST_REMOVE), count(MT.REACTION_REMOVE), count(MT.LINK_REMOVE), count(MT.USER_DATA_ADD)], [4, 2, 2, 2])
  assert.equal(seen.length, 10)
  assert.deepEqual(Object.fromEntries(steps), { find: 0, casts: 3, reactions: 2, follows: 2, profile: 2 })
})

test('what the node refuses, or still lists afterwards, is counted and reported, and the rest still go', async () => {
  fake((type) => (type === MT.LINK_REMOVE ? res(400, { details: 'invalid link body' }) : res(200, {})), (path) => path === '/v1/linksByFid')
  assert.deepEqual(await eraseFarcaster(() => {}, 10), { casts: 3, reactions: 2, follows: 0, profile: 2, failed: 2, error: 'invalid link body' })
  // a remove the node said it took, but that never landed, is caught by the second look
  fake(() => res(200, {}), (path) => path === '/v1/userDataByFid')
  const out = await eraseFarcaster(() => {}, 10)
  assert.equal(out.failed, 2)
  assert.match(out.error!, /still lists/)
})

test('a follow made by a clock running ahead is removed with a newer timestamp than it', async () => {
  // MessageData's fields in a submitted Message: field 1 (data), then type (1), fid (2), timestamp (3), all varints
  const varint = (b: Uint8Array, i: number) => {
    let v = 0
    for (let m = 1; ; m *= 128) {
      v += (b[i] & 0x7f) * m
      if (!(b[i++] & 0x80)) return [v, i]
    }
  }
  const stamps: number[] = []
  const now = Math.floor(Date.now() / 1000) - 1609459200
  ;(globalThis as any).fetch = async (url: string, o: any = {}) => {
    const u = new URL(url)
    if (u.pathname === '/v1/submitMessage') {
      let [, i] = varint(o.body, 1)
      for (let f = 0; f < 3; f++) {
        const [key, j] = varint(o.body, i)
        const [v, k] = varint(o.body, j)
        if (key >> 3 === 3) stamps.push(v)
        i = k
      }
      return res(200, {})
    }
    if (stamps.length) return res(200, { messages: [] })
    return res(200, { messages: u.pathname === '/v1/linksByFid' ? [{ data: { timestamp: now + 120, linkBody: { type: 'follow', targetFid: 2 } } }] : [] })
  }
  assert.equal((await eraseFarcaster(() => {}, 10)).follows, 1)
  assert.equal(stamps.length, 1)
  assert.ok(stamps[0] > now + 120 && stamps[0] < now + 600, String(stamps[0] - now))
})

test('a key replaced while the casts go is the one revoked, and a key step that failed can be tried again', async () => {
  const { removeAppKey, revokeSigner } = await import('./write.ts')
  const { ed25519 } = await import('@noble/curves/ed25519.js')
  const { unhex } = await import('./fc.ts')
  const contains = (b: Uint8Array, k: Uint8Array) => Buffer.from(b).indexOf(Buffer.from(k)) >= 0
  // the account as Settings sees it when Delete is clicked, with an on-chain app key and no ETH for removing it
  const appPub = hex(ed25519.getPublicKey(new Uint8Array(32).fill(5)))
  api.setAccount({ ...api.account!, appPub })
  const clicked = api.account!
  const oldPub = ed25519.getPublicKey(unhex(clicked.signer!))
  const sent: Uint8Array[] = []
  let removed = 0
  let appOnChain = true
  ;(globalThis as any).fetch = async (url: string, o: any = {}) => {
    const u = new URL(url, 'https://quilcast.test')
    if (u.pathname === '/v1/submitMessage') {
      const type = typeOf(o.body)
      // the node stopped knowing the old key: the first remove fails, a new key is added
      if (type === MT.CAST_REMOVE && !removed++) return res(400, { details: 'invalid signer' })
      sent.push(o.body)
      return res(200, {})
    }
    if (u.pathname === '/v1/signer') return res(200, {})
    if (u.pathname === '/v1/onChainSignersByFid') return res(200, { events: appOnChain ? [{ signerEventBody: { key: '0x' + appPub } }] : [] })
    if (o.body && String(o.body).includes('eth_getBalance')) return res(200, { jsonrpc: '2.0', id: 1, result: '0x0' })
    if (u.pathname === '/v1/castsByFid') return res(200, { messages: removed > 1 ? [] : [cast(1)] })
    if (u.pathname.startsWith('/v1/')) return res(200, { messages: [] })
    throw new Error(`unexpected ${url}`)
  }
  assert.deepEqual(await eraseFarcaster(() => {}, 10), { casts: 1, reactions: 0, follows: 0, profile: 0, failed: 0 })
  const newPub = unhex(api.account!.pub!)
  assert.notDeepEqual(newPub, oldPub)
  assert.equal(typeOf(sent[0]), MT.KEY_ADD)

  // no ETH on Optimism for the app key's removal: the key step fails, and nothing is revoked yet
  await assert.rejects(removeAppKey(clicked), /ETH/)
  assert.equal(api.account!.appPub, appPub)
  // the key went off chain meanwhile (removed from another app): the next try sends no transaction and forgets it
  appOnChain = false
  await removeAppKey(clicked)
  assert.equal(api.account!.appPub, undefined)
  await removeAppKey(clicked)

  // the signer revokes itself with the key the account holds now, though Delete was clicked with the old one
  await revokeSigner(clicked)
  const last = sent.at(-1)!
  assert.equal(typeOf(last), MT.KEY_REMOVE)
  assert.ok(contains(last, newPub) && !contains(last, oldPub))
})

test('deleting an account while another one got selected works on the deleted one, and removes only it', async () => {
  const seven = api.account!
  const sevenPub = api.account!.pub
  api.setAccount({ phrase: '', custody: '0x9', fid: 9, signer: hex(new Uint8Array(32).fill(9)), signerAt: Math.floor(Date.now() / 1000), scopes: 2, done: true })
  assert.equal(api.account!.fid, 9)
  // the fake node and server answer only for fid 7
  const { asked } = fake(() => res(200, {}))
  const inner = (globalThis as any).fetch
  const keys: string[] = []
  ;(globalThis as any).fetch = (url: string, o: any = {}) => (String(url).startsWith('/api/account/') && keys.push(o.headers['x-key']), inner(url, o))
  await deleteServerData(seven)
  assert.deepEqual(asked, ['DELETE signed', 'DELETE signed'])
  assert.ok(sevenPub && keys.every((k) => k === '0x' + sevenPub), keys.join())
  const out = await eraseFarcaster(() => {}, 10, seven)
  assert.equal(out.failed, 0)
  assert.equal(out.casts, 3)
  await api.removeAccount(seven)
  assert.equal(api.account!.fid, 9)
  assert.deepEqual(api.accounts.map((a) => a.fid), [9])
})
