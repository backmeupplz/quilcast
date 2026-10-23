// The Quilcast wallet's keys: recovery phrases and private keys the person adds (or creates) in Settings.
// Each secret is encrypted with AES-GCM under one key the browser generates as non-extractable and keeps in
// IndexedDB: page code can ask it to decrypt, but the key itself can never be read out, copied or synced, and
// nothing here is ever sent anywhere. The list (names, addresses) sits in localStorage; secrets only in IndexedDB.
import { generateMnemonic, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts'
import { read, save } from './api.ts'

export type WalletEntry = { id: string; name: string; address: `0x${string}`; kind: 'phrase' | 'key'; index?: number }

export const walletList = () => read<WalletEntry[]>('quilcast:wallets', [])
const setList = (l: WalletEntry[]) => (save('quilcast:wallets', l), dispatchEvent(new Event('wallets')))
export const activeWallet = () => {
  const l = walletList()
  return l.find((w) => w.id === read('quilcast:activeWallet', '')) || l[0]
}
export const setActive = (id: string) => (save('quilcast:activeWallet', id), dispatchEvent(new Event('wallets')))

// --- the sealed store ---

const db = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open('quilcast-vault', 1)
    r.onupgradeneeded = () => r.result.createObjectStore('kv')
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
async function kv<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const d = await db()
  return new Promise((resolve, reject) => {
    const r = f(d.transaction('kv', mode).objectStore('kv'))
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
}
let sealing: Promise<CryptoKey> | undefined
const sealKey = () =>
  (sealing ||= kv<CryptoKey | undefined>('readonly', (s) => s.get('seal')).then(async (k) => {
    if (k) return k
    const fresh = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    await kv('readwrite', (s) => s.put(fresh, 'seal'))
    return fresh
  }))

async function seal(id: string, secret: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await sealKey(), new TextEncoder().encode(secret))
  await kv('readwrite', (s) => s.put({ iv, data }, `w:${id}`))
}
async function unseal(id: string) {
  const box = await kv<{ iv: Uint8Array<ArrayBuffer>; data: ArrayBuffer } | undefined>('readonly', (s) => s.get(`w:${id}`))
  if (!box) throw new Error("This wallet's key is missing from this browser.")
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: box.iv }, await sealKey(), box.data))
}

// --- adding and removing ---

/** What someone pasted: a recovery phrase (12–24 words) or a private key (64 hex digits). */
export function parseSecret(s: string): { kind: 'phrase' | 'key'; secret: string } | null {
  const words = s.trim().toLowerCase().split(/\s+/).join(' ')
  if (validateMnemonic(words, wordlist)) return { kind: 'phrase', secret: words }
  const hex = s.trim().replace(/^0x/i, '')
  if (/^[0-9a-f]{64}$/i.test(hex)) return { kind: 'key', secret: '0x' + hex.toLowerCase() }
  return null
}
const accountOf = (kind: 'phrase' | 'key', secret: string, index = 0) => (kind === 'phrase' ? mnemonicToAccount(secret, { addressIndex: index }) : privateKeyToAccount(secret as `0x${string}`))

export const newPhrase = () => generateMnemonic(wordlist, 128)

export async function addWallet(name: string, kind: 'phrase' | 'key', secret: string, index = 0) {
  const address = accountOf(kind, secret, index).address
  if (walletList().some((w) => w.address === address)) throw new Error('That wallet is already here.')
  const id = crypto.randomUUID()
  await seal(id, secret)
  const w: WalletEntry = { id, name: name.trim().slice(0, 40) || `Wallet ${walletList().length + 1}`, address, kind, ...(kind === 'phrase' && { index }) }
  setList([...walletList(), w])
  setActive(id)
  return w
}
export const renameWallet = (id: string, name: string) => setList(walletList().map((w) => (w.id === id ? { ...w, name: name.trim().slice(0, 40) || w.name } : w)))
export async function removeWallet(id: string) {
  await kv('readwrite', (s) => s.delete(`w:${id}`))
  setList(walletList().filter((w) => w.id !== id))
}
/** The phrase or key, for backing it up. */
export const revealWallet = (id: string) => unseal(id)

/** A viem account that signs with this wallet; the secret is decrypted for the signature and not kept. */
export async function signerOf(id: string) {
  const w = walletList().find((x) => x.id === id)
  if (!w) throw new Error('That wallet is gone.')
  return accountOf(w.kind, await unseal(id), w.index)
}
