import assert from 'node:assert/strict'
import { test } from 'node:test'

// #313: the Quilcast wallet list (vault.ts) and the wallet each address connected with (wallet.ts) shared one
// localStorage key, so connecting a wallet after creating one made the created one vanish
test('a created wallet and a connected wallet both survive, and lists a connect had folded in come back', { timeout: 10000 }, async () => {
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
  const kept: Record<string, string> = {}
  // just enough IndexedDB for keys.ts to seal a secret
  const vault = new Map<string, unknown>()
  const db = {
    createObjectStore() {},
    transaction() {
      const t: any = {}
      const run = (f: () => unknown) => {
        const r: any = {}
        setTimeout(() => ((r.result = f()), r.onsuccess?.(), setTimeout(() => t.oncomplete?.())))
        return r
      }
      t.objectStore = () => ({ get: (k: string) => run(() => vault.get(k)), put: (v: unknown, k: string) => run(() => void vault.set(k, v)) })
      return t
    },
  }
  const heard: ((e: unknown) => void)[] = []
  Object.assign(globalThis, {
    addEventListener: () => {},
    dispatchEvent: () => true,
    localStorage: { getItem: (k: string) => kept[k] ?? null, setItem: (k: string, v: string) => void (kept[k] = v), removeItem: (k: string) => void delete kept[k] },
    indexedDB: { open: () => { const r: any = { result: db }; setTimeout(() => (r.onupgradeneeded?.(), r.onsuccess?.())); return r } },
    window: {
      addEventListener: (type: string, f: (e: unknown) => void) => void (type === 'eip6963:announceProvider' && heard.push(f)),
      dispatchEvent: (e: { type: string }) =>
        void (e.type === 'eip6963:requestProvider' &&
          heard.forEach((f) => {
            f({ detail: { info: { name: 'Phantom', rdns: 'app.phantom' }, provider: wallet('phantom', other) } })
            f({ detail: { info: { name: 'MetaMask', rdns: 'io.metamask' }, provider: wallet('metamask', mm) } })
          })),
    },
  })
  const v = await import('./vault.ts')
  const w = await import('./wallet.ts')
  const signsWithMetaMask = async (address: string) => {
    asked.length = 0
    assert.equal((await w.walletCustody(address).message(new TextEncoder().encode('hi'))).length, 65)
    assert.ok(asked.includes('metamask:personal_sign') && !asked.some((a) => a.startsWith('phantom:')), asked.join(', '))
  }

  // create, then connect: both are still there
  const made = await v.addWallet('Mine', 'phrase', v.newPhrase())
  assert.ok(vault.has(`w:${made.id}`), 'the secret is sealed')
  const address = await w.connect('io.metamask')
  assert.deepEqual(v.walletList().map((x) => x.id), [made.id], 'the created wallet survives the connect')
  assert.ok(Array.isArray(JSON.parse(kept['quilcast:wallets'])))
  await signsWithMetaMask(address)

  // and the other way round: another wallet created after the connect doesn't drop what the connect stored
  const second = await v.addWallet('Two', 'key', `0x${hex(new Uint8Array(32).fill(5))}`)
  assert.deepEqual(v.walletList().map((x) => x.id), [made.id, second.id])
  await signsWithMetaMask(address)

  // what a connect left behind before the keys were split: the list spread into the address map
  const entry = { id: 'old', name: 'Lost', address: other.address, kind: 'key' }
  delete kept['quilcast:connectedWith']
  kept['quilcast:wallets'] = JSON.stringify({ ...[entry], [address]: 'io.metamask' })
  // signatures still find their wallet before anything moves the map over
  await signsWithMetaMask(address)
  assert.deepEqual(v.walletList(), [entry], 'the folded-in wallet comes back')
  assert.deepEqual(JSON.parse(kept['quilcast:wallets']), [entry], 'and is saved as a list again')
  assert.deepEqual(JSON.parse(kept['quilcast:connectedWith']), { [address]: 'io.metamask' }, 'the map moves to its own key')
  await signsWithMetaMask(address)

  // a map stored on its own under the old key (connected before any wallet was made) no longer breaks the list
  kept['quilcast:wallets'] = JSON.stringify({ [address]: 'io.metamask' })
  delete kept['quilcast:connectedWith']
  assert.deepEqual(v.walletList(), [])
  const third = await v.addWallet('Three', 'key', `0x${hex(new Uint8Array(32).fill(6))}`)
  assert.deepEqual(v.walletList().map((x) => x.id), [third.id])
  await signsWithMetaMask(address)

  // and anything else under the key reads as no wallets
  kept['quilcast:wallets'] = '"nonsense"'
  assert.deepEqual(v.walletList(), [])
})
