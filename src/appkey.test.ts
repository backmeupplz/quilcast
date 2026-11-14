// The on-chain app key mini app webhook events are signed with (write.ts ensureAppKey, signEvent, removeAppKey),
// against a fake Optimism RPC holding Farcaster's KeyRegistry. Hypersnap answers like it does since its fork: it
// lists no KeyRegistry key added after it, so nothing here may wait on it.
import assert from 'node:assert/strict'
import { test } from 'node:test'

const store = new Map<string, string>()
Object.assign(globalThis, { addEventListener: () => {}, dispatchEvent: () => true })
;(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) }
const { ed25519 } = await import('@noble/curves/ed25519.js')
const { keccak_256 } = await import('@noble/hashes/sha3.js')
const { address, custodyKey, hex, KEY_GATEWAY, KEY_REGISTRY } = await import('./fc.ts')
const api = await import('./api.ts')
const { ensureAppKey, removeAppKey, signEvent } = await import('./write.ts')

const phrase = 'test test test test test test test test test test test junk'
const custody = address(await custodyKey(phrase))
api.setAccount({ phrase, custody, fid: 7, signer: hex(new Uint8Array(32).fill(3)), signerAt: Math.floor(Date.now() / 1000), scopes: 2, done: true })

const sel = (sig: string) => '0x' + hex(keccak_256(new TextEncoder().encode(sig)).slice(0, 4))
const word = (n: number) => n.toString(16).padStart(64, '0')
// the fake chain: each key's KeyRegistry state (0 never added, 1 added, 2 removed), what an add does to it, and the
// receipt of the last transaction (null while it's pending)
const chain = { keys: new Map<string, number>(), txs: [] as string[], adds: 0, onAdd: 1, receipt: null as null | { status: string }, hypersnap: 0, calls: 0, down: false }
let lastKey = ''
;(globalThis as any).fetch = async (url: string, o: any = {}) => {
  const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }))
  if (String(url).includes('/v1/onChainSignersByFid')) return (chain.hypersnap++, new Response(JSON.stringify({ events: [] })))
  assert.equal(url, api.settings.rpc, `unexpected ${url}`)
  const { method, params } = JSON.parse(o.body)
  if (method === 'eth_getBalance') return ok('0x1')
  if (method === 'eth_getTransactionCount') return ok('0x0')
  if (method === 'eth_estimateGas') return ok('0x30000')
  if (method === 'eth_gasPrice' || method === 'eth_maxPriorityFeePerGas') return ok('0x1')
  if (method === 'eth_sendRawTransaction') {
    const raw: string = params[0]
    chain.txs.push(raw)
    // KeyGateway.add carries the new key; its state is set as soon as it "lands"
    if (raw.includes(KEY_GATEWAY.slice(2))) {
      chain.adds++
      const key = raw.match(/0{62}20([0-9a-f]{64})/)![1]
      lastKey = key
      chain.keys.set(key, chain.onAdd === 1 ? 0 : chain.onAdd)
    }
    return ok('0x' + 'aa'.repeat(32))
  }
  if (method === 'eth_getTransactionReceipt') return ok(chain.receipt)
  if (method === 'eth_call') {
    if (chain.down) return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'rate limited' } }))
    chain.calls++
    const { to, data } = params[0]
    assert.equal(to, KEY_REGISTRY)
    assert.equal(data.slice(0, 10), sel('keyDataOf(uint256,bytes)'))
    assert.equal(data.slice(10, 10 + 64 * 3), word(7) + word(64) + word(32))
    const key = data.slice(10 + 64 * 3)
    assert.equal(key.length, 64)
    let state = chain.keys.get(key) ?? 0
    // an add that went through is seen on the second look
    if (chain.onAdd === 1 && key === lastKey && state === 0 && chain.calls > 1) chain.keys.set(key, (state = 1))
    return ok('0x' + word(state) + word(state ? 1 : 0))
  }
  throw new Error(`unexpected ${method}`)
}

test('a new app key is added on chain and is ready once the KeyRegistry holds it, without waiting on Hypersnap', async () => {
  chain.calls = 0
  const waits: string[] = []
  const before = Math.floor(Date.now() / 1000)
  const key = await ensureAppKey((w) => waits.push(w), 1)
  assert.equal(chain.adds, 1)
  assert.equal(api.account!.appPub, hex(key.pub))
  // the add's deadline is kept with the key
  const until = api.account!.appUntil!
  assert.ok(until >= before + 3600 && until <= before + 3610, String(until - before))
  assert.ok(chain.txs.at(-1)!.includes(until.toString(16).padStart(64, '0')))
  assert.equal(chain.keys.get(hex(key.pub)), 1)
  assert.equal(chain.hypersnap, 0)
  assert.deepEqual(waits, ['Adding a notification key on Optimism…', 'Waiting for the network to see the key…'])

  // the next time it's there already: no transaction, the same key
  const again = await ensureAppKey(undefined, 1)
  assert.equal(chain.adds, 1)
  assert.equal(hex(again.pub), hex(key.pub))

  // and webhook events are signed with it
  const e = await signEvent({ event: 'notifications_disabled' })
  const header = JSON.parse(Buffer.from(e.header, 'base64url').toString())
  assert.deepEqual(header, { fid: 7, type: 'app_key', key: '0x' + hex(key.pub) })
  assert.ok(ed25519.verify(Buffer.from(e.signature, 'base64url'), Buffer.from(`${e.header}.${e.payload}`), key.pub))
  assert.equal(chain.hypersnap, 0)
})

test('a kept key that was removed on chain since is replaced with a new one', async () => {
  const old = api.account!.appPub!
  chain.keys.set(old, 2)
  chain.calls = 0
  const key = await ensureAppKey(undefined, 1)
  assert.equal(chain.adds, 2)
  assert.notEqual(hex(key.pub), old)
  assert.equal(api.account!.appPub, hex(key.pub))
})

test('an add that reverts is forgotten, so the next try adds a new key', async () => {
  api.setAccount({ ...api.account!, appPub: undefined, appKey: undefined })
  chain.onAdd = 0
  chain.receipt = { status: '0x0' }
  await assert.rejects(ensureAppKey(undefined, 1), /failed on chain/)
  assert.equal(chain.adds, 3)
  assert.equal(api.account!.appPub, undefined)
})

test('an add that stays pending gives up after a while and keeps the key for the next try', async () => {
  chain.receipt = null
  await assert.rejects(ensureAppKey(undefined, 1), /still being confirmed/)
  assert.equal(chain.adds, 4)
  const kept = api.account!.appPub!
  assert.ok(kept)
  // it lands meanwhile: the next try sends nothing and uses that key
  chain.keys.set(kept, 1)
  assert.equal(hex((await ensureAppKey(undefined, 1)).pub), kept)
  assert.equal(chain.adds, 4)
})

test('a kept key not on chain past its add\'s deadline is replaced, and one that may still land is kept', async () => {
  const kept = api.account!.appPub!
  chain.keys.set(kept, 0)
  chain.onAdd = 1
  // its add never lands
  lastKey = ''
  // still within the deadline: kept, and the wait gives up
  await assert.rejects(ensureAppKey(undefined, 1), /still being confirmed/)
  assert.equal(api.account!.appPub, kept)
  assert.equal(chain.adds, 4)
  // just past it, within the grace for a chain clock behind ours: still kept
  api.setAccount({ ...api.account!, appUntil: Math.floor(Date.now() / 1000) - 60 })
  await assert.rejects(ensureAppKey(undefined, 1), /still being confirmed/)
  assert.equal(api.account!.appPub, kept)
  // well past it (the add reverted or was dropped while the page was closed): a new key
  api.setAccount({ ...api.account!, appUntil: Math.floor(Date.now() / 1000) - 700 })
  chain.calls = 0
  const key = await ensureAppKey(undefined, 1)
  assert.equal(chain.adds, 5)
  assert.notEqual(hex(key.pub), kept)
  assert.equal(api.account!.appPub, hex(key.pub))
})

test('a kept key from before deadlines were recorded gets one, and is replaced once it passes', async () => {
  const kept = api.account!.appPub!
  chain.keys.set(kept, 0)
  lastKey = ''
  api.setAccount({ ...api.account!, appUntil: undefined })
  const before = Math.floor(Date.now() / 1000)
  await assert.rejects(ensureAppKey(undefined, 1), /still being confirmed/)
  assert.equal(api.account!.appPub, kept)
  assert.ok(api.account!.appUntil! >= before + 3600)
  assert.equal(chain.adds, 5)
  api.setAccount({ ...api.account!, appUntil: before - 700 })
  chain.calls = 0
  assert.notEqual(hex((await ensureAppKey(undefined, 1)).pub), kept)
  assert.equal(chain.adds, 6)
})

test('a key removed on chain while it\'s being waited for is replaced in the same try', async () => {
  const kept = api.account!.appPub!
  // still pending at first, then removed from another app
  chain.keys.set(kept, 0)
  lastKey = ''
  let looks = 0
  const inner = (globalThis as any).fetch
  ;(globalThis as any).fetch = async (url: string, o: any = {}) => {
    if (o.body && String(o.body).includes('eth_call') && String(o.body).includes(kept) && ++looks === 3) chain.keys.set(kept, 2)
    return inner(url, o)
  }
  try {
    chain.calls = 0
    const key = await ensureAppKey(undefined, 1)
    assert.notEqual(hex(key.pub), kept)
    assert.equal(api.account!.appPub, hex(key.pub))
    assert.equal(chain.adds, 7)
  } finally {
    ;(globalThis as any).fetch = inner
  }
})

test('an RPC that can\'t be asked keeps the key, says so, and still has the key removed on sign-out', async () => {
  const kept = api.account!.appPub!
  chain.keys.set(kept, 2)
  chain.down = true
  // removed on chain, but that can't be seen: nothing is dropped or added
  await assert.rejects(ensureAppKey(undefined, 1), /Couldn't reach the Optimism RPC/)
  assert.equal(api.account!.appPub, kept)
  assert.equal(chain.adds, 7)
  // sign-out sends the remove, as it did when the node couldn't be asked
  const sent = chain.txs.length
  await removeAppKey(api.account!)
  assert.equal(chain.txs.length, sent + 1)
  assert.ok(chain.txs.at(-1)!.includes(kept))
  assert.equal(api.account!.appPub, undefined)
  chain.down = false
  // back up: a new key goes on chain
  chain.calls = 0
  const key = await ensureAppKey(undefined, 1)
  assert.equal(chain.adds, 8)
  assert.equal(api.account!.appPub, hex(key.pub))
})

test('signing out removes a key the KeyRegistry holds, and only forgets one it never got or already removed', async () => {
  const pub = api.account!.appPub!
  const sent = chain.txs.length
  await removeAppKey(api.account!)
  assert.equal(chain.txs.length, sent + 1)
  assert.ok(chain.txs.at(-1)!.includes(KEY_REGISTRY.slice(2)) && chain.txs.at(-1)!.includes(sel('remove(bytes)').slice(2)))
  assert.ok(chain.txs.at(-1)!.includes(pub))
  assert.equal(api.account!.appPub, undefined)

  for (const state of [0, 2]) {
    const k = hex(ed25519.getPublicKey(new Uint8Array(32).fill(10 + state)))
    chain.keys.set(k, state)
    api.setAccount({ ...api.account!, appPub: k })
    await removeAppKey(api.account!)
    assert.equal(chain.txs.length, sent + 1)
    assert.equal(api.account!.appPub, undefined)
  }
  assert.equal(chain.hypersnap, 0)
})

test('a key added for an account that isn\'t selected (another got selected meanwhile) is kept on that one', async () => {
  const selected = api.account!
  const otherPhrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
  // fid 7 too, which is all the fake chain answers for
  const other = { phrase: otherPhrase, custody: address(await custodyKey(otherPhrase)), fid: 7, done: true }
  api.updateAccount(other)
  api.setAccount(selected)
  assert.equal(api.idOf(api.account!), selected.custody)
  chain.calls = 0
  const key = await ensureAppKey(undefined, 1, other)
  const stored = api.accounts.find((x) => x.custody === other.custody)!
  assert.equal(stored.appPub, hex(key.pub))
  assert.equal(api.idOf(api.account!), selected.custody)
  assert.notEqual(api.account!.appPub, hex(key.pub))
})
