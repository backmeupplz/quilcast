import assert from 'node:assert/strict'
import { test } from 'node:test'

test('the custody wallet is listed only when switched on, and signs with the account phrase', async () => {
  const { mnemonicToAccount } = await import('viem/accounts')
  const phrase = 'test test test test test test test test test test test junk'
  const custody = mnemonicToAccount(phrase).address.toLowerCase()
  const kept: Record<string, string> = {
    'quilcast:accounts': JSON.stringify([{ phrase, custody, fid: 1, username: 'alice', done: true }, { phrase: '', wallet: '0x' + '2'.repeat(40), fid: 2, done: true }]),
    'quilcast:current': custody,
  }
  Object.assign(globalThis, { addEventListener: () => {}, dispatchEvent: () => true })
  ;(globalThis as any).localStorage = { getItem: (k: string) => kept[k] ?? null, setItem: (k: string, v: string) => void (kept[k] = v), removeItem: (k: string) => void delete kept[k] }
  const { walletList, setCustodyWallet, signerOf } = await import('./vault.ts')

  assert.deepEqual(walletList(), [], 'off by default')
  setCustodyWallet(true)
  const [w, ...rest] = walletList()
  assert.equal(rest.length, 0, 'a wallet account brings no custody wallet')
  assert.equal(w.address, custody)
  assert.equal(w.custody, true)
  assert.equal((await signerOf(w.id)).address.toLowerCase(), custody)
  assert.equal(JSON.parse(kept['quilcast:wallets'] ?? '[]').length, 0, 'never saved with the imported wallets')

  // the same wallet imported by hand shows once
  kept['quilcast:wallets'] = JSON.stringify([{ id: 'x', name: 'Mine', address: mnemonicToAccount(phrase).address, kind: 'phrase', index: 0 }])
  assert.deepEqual(walletList().map((x) => x.id), ['x'])

  setCustodyWallet(false)
  kept['quilcast:wallets'] = '[]'
  assert.deepEqual(walletList(), [])
  await assert.rejects(signerOf(w.id), /gone/, "off means mini apps can't sign with it")
})
