import assert from 'node:assert/strict'
import { test } from 'node:test'

// A WalletConnect account whose session ended pairs its wallet again in place (#463): signing asks `again`, which
// shows the QR code (app.tsx PairAsk) through repair(), checks the address, and the signature goes on.
const kept: Record<string, string> = {}
;(globalThis as any).localStorage = { getItem: (k: string) => kept[k] ?? null, setItem: (k: string, v: string) => void (kept[k] = v), removeItem: (k: string) => void delete kept[k] }
;(globalThis as any).window = {}

// topics are unique for good, as the relay's are (wallet.ts remembers one that went unanswered)
let topics = 0
async function setup() {
  const { privateKeyToAccount } = await import('viem/accounts')
  const me = privateKeyToAccount(`0x${'07'.repeat(32)}`)
  const other = privateKeyToAccount(`0x${'08'.repeat(32)}`)
  const w = await import('./wallet.ts')
  const on: Record<string, (u: string) => void> = {}
  // a stand-in for Reown's UniversalProvider: connect() shows a link, then the wallet approves `pairs` (whose key signs)
  const up = {
    session: undefined as any,
    pairs: me,
    paired: 0,
    sent: 0,
    fail: [] as Error[],
    on: (ev: string, f: (u: string) => void) => void (on[ev] = f),
    off: (ev: string) => void delete on[ev],
    connect: async () => {
      up.paired++
      on.display_uri?.(`wc:pair${up.paired}@2`)
      const a = up.pairs.address
      up.session = { topic: `t${++topics}`, namespaces: { eip155: { accounts: [`eip155:10:${a}`, `eip155:8453:${a}`] } } }
    },
    disconnect: async () => void (up.session = undefined),
    request: async ({ method, params }: { method: string; params: any[] }) => {
      const e = up.fail.shift()
      if (e) throw e
      if (method === 'personal_sign') return up.pairs.signMessage({ message: { raw: params[0] } })
      if (method === 'eth_sendTransaction') return up.sent++, '0x' + 'ab'.repeat(32)
      throw new Error(`unexpected ${method}`)
    },
  }
  w.useUniversal(up)
  const address = me.address.toLowerCase()
  kept['quilcast:connectedWith'] = JSON.stringify({ [address]: w.WC })
  const shown: string[] = []
  let asked = 0
  const again = () => (asked++, w.repair(address, (u) => shown.push(u)))
  return { w, up, me, other, address, again, shown, asked: () => asked }
}

test('an ended session pairs again from the signature itself, and the signature goes on', async () => {
  const { w, up, me, address, again, shown, asked } = await setup()
  const msg = new TextEncoder().encode('hello')
  // without a way to pair again (a fresh connect), it's the plain error it always was
  await assert.rejects(w.walletCustody(address).message(msg, { local: true }), /session ended/)
  const sig = await w.walletCustody(address, undefined, again).message(msg, { local: true })
  assert.equal(asked(), 1)
  assert.deepEqual(shown, ['wc:pair1@2', ''])
  assert.equal('0x' + Buffer.from(sig).toString('hex'), await me.signMessage({ message: { raw: msg } }))
  // a live session holding the address signs with no QR code
  await w.walletCustody(address, undefined, again).message(msg, { local: true })
  assert.equal(asked(), 1)

  // the session is still here but the SDK finds it gone once asked: pair again, ask once more
  up.fail.push(new Error("No matching key. session topic doesn't exist: t1"))
  await w.walletCustody(address, undefined, again).message(msg, { local: true })
  assert.equal(asked(), 2)
  assert.equal(up.paired, 2)
  up.fail.push(new Error('Expired. session topic: t2'))
  await w.walletCustody(address, undefined, again).message(msg, { local: true })
  assert.equal(asked(), 3)

  // declining in the wallet is declining, not an ended session
  up.fail.push(Object.assign(new Error('User rejected the request.'), { code: 4001 }))
  await assert.rejects(w.walletCustody(address, undefined, again).message(msg, { local: true }), { code: 4001 })
  assert.equal(asked(), 3)
  // and nor is any other failure
  up.fail.push(new Error('Internal error'))
  await assert.rejects(w.walletCustody(address, undefined, again).message(msg, { local: true }))
  assert.equal(asked(), 3)
})

test("a wallet that comes back with another address isn't used, and the next try pairs afresh", async () => {
  const { w, up, other, me, address, again } = await setup()
  up.session = undefined
  up.pairs = other
  await assert.rejects(w.walletCustody(address, undefined, again).message(new Uint8Array([1]), { local: true }), /different address than this account's/)
  assert.equal(up.session, undefined)
  up.pairs = me
  await w.walletCustody(address, undefined, again).message(new Uint8Array([1]), { local: true })
})

test("a transaction pairs again too, but one the wallet never answered for isn't sent twice", async () => {
  const { w, up, address, again, asked } = await setup()
  up.session = undefined
  const to = '0x' + '11'.repeat(20)
  assert.match(await w.sendTx(address, to, '0x', 0n, 10, again), /^0x(ab){32}$/)
  assert.equal(asked(), 1)
  // gone before it was asked: nothing went out, so it goes again on the new session
  up.fail.push(new Error('Missing or invalid. Record was recently deleted - session: t1'))
  await w.sendTx(address, to, '0x', 0n, 10, again)
  assert.equal(asked(), 2)
  assert.equal(up.sent, 2)
  // asked but never answered: it may have gone out, so the person checks first, and nothing pairs from there
  up.fail.push(new Error('Request expired. Please try again.'))
  await assert.rejects(w.sendTx(address, to, '0x', 0n, 10, again), /Check whether the transaction went through/)
  assert.equal(asked(), 2)
  assert.equal(up.sent, 2)
  // the next one pairs again first, and when that's cancelled nothing is sent
  const no = () => Promise.reject(Object.assign(new Error('You declined.'), { code: 4001 }))
  await assert.rejects(w.sendTx(address, to, '0x', 0n, 10, no), { code: 4001 })
  assert.equal(up.sent, 2)
  await w.sendTx(address, to, '0x', 0n, 10, again)
  assert.equal(asked(), 3)
  assert.equal(up.sent, 3)
})

test('a signature nobody waits for any more never pairs or signs again by itself; the next one pairs first', async () => {
  const { w, up, me, address, again, asked } = await setup()
  const msg = new Uint8Array([1])
  await w.walletCustody(address, undefined, again).message(msg, { local: true })
  assert.equal(asked(), 1)
  // a sign-in cancelled while the wallet sat on it: 5 minutes later the SDK gives up on the request
  up.fail.push(new Error('Request expired. Please try again.'))
  await assert.rejects(w.walletCustody(address, undefined, again).message(msg, { local: true }), /didn't answer\. Try again to reconnect it/)
  assert.equal(asked(), 1)
  assert.equal(up.paired, 1)
  // the person's next try, on the session that went quiet, pairs again before it asks
  const sig = await w.walletCustody(address, undefined, again).message(msg, { local: true })
  assert.equal(asked(), 2)
  assert.equal('0x' + Buffer.from(sig).toString('hex'), await me.signMessage({ message: { raw: msg } }))
  // and the new session is trusted again
  await w.walletCustody(address, undefined, again).message(msg, { local: true })
  assert.equal(asked(), 2)
})

test('a session paired again while a request was out is used as it is, and a wallet saying "expired" itself is just an error', async () => {
  const { w, up, address, again, asked } = await setup()
  const msg = new Uint8Array([1])
  await w.walletCustody(address, undefined, again).message(msg, { local: true })
  assert.equal(asked(), 1)
  // Settings › Reconnect paired meanwhile, then this request finds its old session gone: it asks on the new one
  const old = up.request
  up.request = async () => {
    up.request = old
    await again()
    throw new Error("No matching key. session topic doesn't exist: t1")
  }
  await w.walletCustody(address, undefined, again).message(msg, { local: true })
  assert.equal(asked(), 2)
  assert.equal(up.paired, 2)
  up.fail.push(new Error('Transaction expired'))
  await assert.rejects(w.walletCustody(address, undefined, again).message(msg, { local: true }), (e: any) => /Transaction expired/.test(e.cause?.details))
  assert.equal(asked(), 2)
})

test("the SDK's other ways of saying a session is gone count, and a pairing that settled on another account doesn't sign", async () => {
  const { w, up, other, address, again, asked } = await setup()
  const msg = new Uint8Array([1])
  await w.walletCustody(address, undefined, again).message(msg, { local: true })
  for (const m of ['Missing or invalid. session topic does not exist in keychain: t1', 'Please call connect() before request()']) {
    up.fail.push(new Error(m))
    await w.walletCustody(address, undefined, again).message(msg, { local: true })
  }
  assert.equal(asked(), 3)
  // `again` shared with a pairing for another address (two asked at once) resolves, but this account isn't in it
  up.session = undefined
  up.pairs = other
  await assert.rejects(w.walletCustody(address, undefined, () => up.connect()).message(msg, { local: true }), /different address than this account's/)
})

test('another wallet never shows a QR code', async () => {
  const { w, address, again, asked } = await setup()
  delete kept['quilcast:connectedWith']
  ;(globalThis as any).window.ethereum = { request: async () => { throw new Error('Expired. session topic: x') } }
  await assert.rejects(w.walletCustody(address, undefined, again).message(new Uint8Array([1]), { local: true }))
  assert.equal(asked(), 0)
  delete (globalThis as any).window.ethereum
})
