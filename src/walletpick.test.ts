import assert from 'node:assert/strict'
import { test } from 'node:test'

// the timeout matters: reaching the wrong provider means nothing ever answers and this would wait forever
test('the wallet someone picks is the one that connects and signs, and a stale global is not on offer', { timeout: 10000 }, async () => {
  const { privateKeyToAccount } = await import('viem/accounts')
  const { hex } = await import('./fc.ts')
  const mm = privateKeyToAccount(`0x${hex(new Uint8Array(32).fill(3))}`)
  const other = privateKeyToAccount(`0x${hex(new Uint8Array(32).fill(4))}`)
  const asked: string[] = []
  const wallet = (tag: string, acct: typeof mm) => ({
    request: async ({ method, params }: { method: string; params: any[] }) => {
      asked.push(`${tag}:${method}`)
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [acct.address]
      if (method === 'eth_chainId') return '0xa'
      if (method === 'personal_sign') return acct.signMessage({ message: { raw: params[0] } })
      throw new Error(`unexpected ${method}`)
    },
  })
  const metamask = wallet('metamask', mm)
  const phantom = wallet('phantom', other)
  // what two extensions racing for the global leave behind: it claims to be MetaMask and answers nothing at all
  const stale = { isMetaMask: true, request: () => new Promise(() => {}) }
  const kept: Record<string, string> = {}
  const heard: ((e: unknown) => void)[] = []
  ;(globalThis as any).localStorage = { getItem: (k: string) => kept[k] ?? null, setItem: (k: string, v: string) => void (kept[k] = v) }
  ;(globalThis as any).window = {
    ethereum: stale,
    addEventListener: (type: string, f: (e: unknown) => void) => void (type === 'eip6963:announceProvider' && heard.push(f)),
    dispatchEvent: (e: { type: string }) =>
      void (e.type === 'eip6963:requestProvider' &&
        heard.forEach((f) => {
          f({ detail: { info: { name: 'Phantom', rdns: 'app.phantom' }, provider: phantom } })
          f({ detail: { info: { name: 'MetaMask', rdns: 'io.metamask' }, provider: metamask } })
        })),
  }
  const w = await import('./wallet.ts')
  // the picker offers both wallets, and the stale object is not one of them
  assert.deepEqual(w.choices().map((c) => c.key), ['app.phantom', 'io.metamask'])
  assert.deepEqual(w.choices().map((c) => c.name), ['Phantom', 'MetaMask'])
  // picking the second one connects that one, not the first and not the stale global
  const address = await w.connect('io.metamask')
  assert.equal(address, mm.address.toLowerCase())
  // and a later signature finds its way back to it from what the connect stored, with nothing held in memory
  const signed = await w.walletCustody(address).message(new TextEncoder().encode('hello'))
  assert.equal(signed.length, 65)
  assert.ok(asked.includes('metamask:personal_sign'))
  assert.ok(!asked.some((a) => a.startsWith('phantom:')), `the other wallet was asked: ${asked.join(', ')}`)
})
