// The Quilcast wallet's keys: recovery phrases and private keys the person adds (or creates) in Settings. Each secret
// is sealed in keys.ts (AES-GCM under a non-extractable key in IndexedDB) and nothing here is ever sent anywhere. The
// list (names, addresses) sits in localStorage; secrets only in the vault.
import { generateMnemonic, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts'
import { accounts, askUser, read, save, saveSettings, settings, type Account } from './api.ts'
import { t } from './i18n.ts'
import { drop, seal, unseal } from './keys.ts'

// `custody`: a phrase account's custody address, listed only while Settings allows it (off by default: a mini app can
// ask it to sign away the Farcaster account itself)
export type WalletEntry = { id: string; name: string; address: `0x${string}`; kind: 'phrase' | 'key'; index?: number; custody?: true }

const stored = () => read<WalletEntry[]>('quilcast:wallets', [])
/** Phrase accounts in this browser (wallet accounts sign with their own wallet, which mini apps already see). */
export const custodyAccounts = () => accounts.filter((a) => a.custody && !a.wallet)
const custodyId = (a: Account) => `custody:${a.custody}`
export const walletList = () => {
  const l = stored()
  const own = settings.custodyWallet ? custodyAccounts() : []
  const extra = own
    .filter((a) => !l.some((w) => w.address.toLowerCase() === a.custody!.toLowerCase()))
    .map((a): WalletEntry => ({ id: custodyId(a), name: t('{name} (custody)', { name: a.username ? '@' + a.username : `${a.custody!.slice(0, 6)}…` }), address: a.custody as `0x${string}`, kind: 'phrase', custody: true }))
  return [...l, ...extra]
}
export const setCustodyWallet = (on: boolean) => ((settings.custodyWallet = on), saveSettings(), dispatchEvent(new Event('wallets')))
const setList = (l: WalletEntry[]) => (save('quilcast:wallets', l), dispatchEvent(new Event('wallets')))
export const activeWallet = () => {
  const l = walletList()
  return l.find((w) => w.id === read('quilcast:activeWallet', '')) || l[0]
}
export const setActive = (id: string) => (save('quilcast:activeWallet', id), dispatchEvent(new Event('wallets')))

// a wallet's secret sits in the vault under w:<id>
const unsealed = async (id: string) => {
  const s = await unseal(`w:${id}`)
  if (s === undefined) throw new Error("This wallet's key is missing from this browser.")
  return s
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
  await seal(`w:${id}`, secret)
  const w: WalletEntry = { id, name: name.trim().slice(0, 40) || `Wallet ${stored().length + 1}`, address, kind, ...(kind === 'phrase' && { index }) }
  setList([...stored(), w])
  setActive(id)
  return w
}
export const renameWallet = (id: string, name: string) => setList(stored().map((w) => (w.id === id ? { ...w, name: name.trim().slice(0, 40) || w.name } : w)))
export async function removeWallet(id: string) {
  await drop(`w:${id}`)
  setList(stored().filter((w) => w.id !== id))
}
/** The phrase or key, for backing it up. */
export const revealWallet = (id: string) => unsealed(id)

/** A viem account that signs with this wallet; the secret is decrypted for the signature and not kept. */
export async function signerOf(id: string) {
  const w = walletList().find((x) => x.id === id)
  if (!w) throw new Error('That wallet is gone.')
  if (w.custody) {
    const a = custodyAccounts().find((x) => custodyId(x) === id)!
    const phrase = a.phrase || (await askUser.phrase(a))
    if (!phrase) throw new Error("This needs the account's recovery phrase.")
    return mnemonicToAccount(phrase) // PhraseAsk checked it against a.custody
  }
  return accountOf(w.kind, await unsealed(id), w.index)
}
