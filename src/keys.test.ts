import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ed25519 } from '@noble/curves/ed25519.js'

// just enough IndexedDB for keys.ts: one store, and transactions that complete once their last request has
const vault = new Map<string, any>()
const db = {
  createObjectStore() {},
  transaction() {
    const t: any = {}
    let open = 0
    const run = (f: () => unknown) => {
      const r: any = {}
      open++
      setTimeout(() => {
        r.result = f()
        r.onsuccess?.()
        if (--open === 0) setTimeout(() => open === 0 && t.oncomplete?.())
      })
      return r
    }
    t.objectStore = () => ({ get: (k: string) => run(() => vault.get(k)), put: (v: unknown, k: string) => run(() => void vault.set(k, v)), delete: (k: string) => run(() => void vault.delete(k)) })
    return t
  },
}
const store = new Map<string, string>()
Object.assign(globalThis, {
  addEventListener: () => {}, dispatchEvent: () => true,
  localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) },
  indexedDB: { open: () => { const r: any = { result: db }; setTimeout(() => (r.onupgradeneeded?.(), r.onsuccess?.())); return r } },
})

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const signer = hex(new Uint8Array(32).fill(3))
const appKey = hex(new Uint8Array(32).fill(4))
// what 0.21 kept in localStorage, all of it in plain text
store.set('quilcast:accounts', JSON.stringify([{ phrase, fid: 5, signer, signerAt: 1, scopes: 2, done: true, dm: 'fc_dc_5_token', fcx: { secret: 'session', exp: 9 }, inbox: 'ab'.repeat(32), appKey, notify: ['https://app.example'] }]))
store.set('quilcast:current', phrase)

test('an account from before 0.22 moves its secrets into the vault and out of localStorage', async () => {
  const api = await import('./api.ts')
  const { address, custodyKey } = await import('./fc.ts')
  const custody = address(await custodyKey(phrase))
  const kept = store.get('quilcast:accounts')!
  // localStorage knows the account by its custody address and holds nothing secret
  assert.equal(store.get('quilcast:current'), custody)
  for (const s of ['abandon', signer, appKey, 'fc_dc_5', 'session', 'abab']) assert.ok(!kept.includes(s), s)
  const [a] = JSON.parse(kept)
  assert.deepEqual(a, { fid: 5, signerAt: 1, scopes: 2, done: true, notify: ['https://app.example'], custody, pub: hex(ed25519.getPublicKey(Buffer.from(signer, 'hex'))), appPub: hex(ed25519.getPublicKey(Buffer.from(appKey, 'hex'))) })
  // the app still has all of it
  assert.equal(api.account!.phrase, phrase)
  assert.equal(api.account!.dm, 'fc_dc_5_token')
  assert.deepEqual(api.account!.fcx, { secret: 'session', exp: 9 })
  // the vault has only ciphertext and key handles
  for (const [k, v] of vault) assert.ok(k === 'seal' || v.key || !new TextDecoder().decode(v.data).includes('abandon'), k)
  // the same signing key, which page code can use but not read out
  const k = vault.get(`ed:${a.pub}`).key as CryptoKey
  assert.equal(k.extractable, false)
  await assert.rejects(crypto.subtle.exportKey('pkcs8', k))
  const { edKey } = await import('./keys.ts')
  const msg = new TextEncoder().encode('gm')
  assert.ok(ed25519.verify(await (await edKey(a.pub))!.sign(msg), msg, Buffer.from(a.pub, 'hex')))
})

test('a cleared secret leaves the vault, and signing out leaves nothing behind', async () => {
  const api = await import('./api.ts')
  const id = api.idOf(api.account!)
  await api.setAccount({ ...api.account!, dm: undefined })
  assert.ok(!vault.has(`a:${id}:dm`) && vault.has(`a:${id}:phrase`))
  // a copy of the account without its secrets (another tab's, say) changes nothing in the vault
  await api.updateAccount({ ...JSON.parse(store.get('quilcast:accounts')!)[0], fid: 5 })
  assert.ok(vault.has(`a:${id}:phrase`))
  await api.setAccount(null)
  assert.deepEqual([...vault.keys()], ['seal'])
  assert.deepEqual(JSON.parse(store.get('quilcast:accounts')!), [])
})
