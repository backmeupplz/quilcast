// An external wallet (MetaMask, Rabby, OKX…) as the custody address, through viem. Only loaded when someone
// connects one. Wallets announce themselves over EIP-6963; window.ethereum is the fallback, for older wallets and
// for the mini app host (inapp.ts leaves the client's provider there).
import { createWalletClient, custom, type EIP1193Provider } from 'viem'
import { mainnet, optimism } from 'viem/chains'
import { ID_GATEWAY, registerData } from './eth.ts'
import { unhex, type Custody } from './fc.ts'

type Injected = EIP1193Provider & { providers?: Injected[]; isRabby?: boolean; isOkxWallet?: boolean }
type Info = { name?: string; icon?: string; rdns?: string }
/** A wallet this browser offers. `key` is its EIP-6963 rdns, which is what gets remembered. */
export type Choice = { name: string; icon: string; key: string; provider: Injected }

// Two extensions racing for window.ethereum can leave an object there that answers nothing, not even eth_chainId,
// and the connect then hangs with no prompt. Only a live wallet announces itself, so asking steps around the
// leftover. Extensions answer while this module loads, the same way miniapp.tsx collects them.
const announced: Choice[] = []
window.addEventListener?.('eip6963:announceProvider', (e) => {
  const { info, provider: p } = ((e as CustomEvent).detail || {}) as { info?: Info; provider?: Injected }
  if (typeof p?.request !== 'function' || !info || announced.some((c) => c.provider === p)) return
  const icon = String(info.icon || '')
  announced.push({ name: String(info.name || '').slice(0, 40) || 'Wallet', icon: /^data:image\//.test(icon) ? icon : '', key: String(info.rdns || info.name || ''), provider: p })
})
window.dispatchEvent?.(new Event('eip6963:requestProvider'))

/** The wallets that announced themselves, for the picker on "Use a wallet". */
export const choices = () => announced.slice()

// Which wallet an address connected with, by rdns. Later signatures have to go back to that same wallet: another
// one doesn't hold the address and would refuse, and with several wallets the guess below could land on either.
// api.ts has read/save, but importing it here would pull the account store and its listeners into this chunk,
// which only a connect needs, so these two lines stay local.
const WALLETS = 'quilcast:wallets'
const used = (): Record<string, string> => {
  try {
    return JSON.parse(localStorage.getItem(WALLETS)!) ?? {}
  } catch {
    return {}
  }
}
const remember = (address: string, key: string) => {
  try {
    localStorage.setItem(WALLETS, JSON.stringify({ ...used(), [address]: key }))
  } catch {}
}
const keyFor = (address: string) => used()[address.toLowerCase()]

function provider(key?: string) {
  const w = window as unknown as { ethereum?: Injected; okxwallet?: Injected }
  // the wallet this address was connected with, while it is still here
  const want = key ? announced.find((c) => c.key === key) : undefined
  if (want) return want.provider
  const live = announced.map((c) => c.provider)
  const all = [...live, ...(w.ethereum?.providers || [])]
  // window.ethereum when it is one of the live wallets: that is the one the browser is set to reach for
  const same = w.ethereum && live.includes(w.ethereum) ? w.ethereum : undefined
  const p = all.find((x) => x.isRabby) || all.find((x) => x.isOkxWallet) || same || live[0] || w.okxwallet || w.ethereum
  if (!p) throw new Error('No wallet found in this browser. Install one like MetaMask or Rabby, or open Quilcast in your wallet app.')
  return p
}
const client = (key?: string) => createWalletClient({ transport: custom(provider(key)) })
// viem's errors carry a page of details; people need the first line
const tidy = <T>(p: Promise<T>) => p.catch((e) => Promise.reject(new Error(e?.shortMessage || e?.message || 'The wallet refused.')))

/** Ask a wallet for its address, and remember which one it was. `key` is a choices() rdns; without one this
 *  takes the only wallet there is, the way it did before the picker. */
export async function connect(key?: string) {
  const [addr] = await tidy(client(key).requestAddresses())
  if (!addr) throw new Error('The wallet shared no address.')
  const address = addr.toLowerCase()
  if (key) remember(address, key)
  return address
}

const CHAINS = { 1: mainnet, 10: optimism }
async function on(id: 1 | 10, key?: string) {
  const c = client(key)
  if ((await c.getChainId()) === id) return c
  try {
    await c.switchChain({ id })
  } catch (e: any) {
    if (e?.code !== 4902 && !/unrecognized|unknown chain|not been added/i.test(e?.message)) throw e
    await c.addChain({ chain: CHAINS[id] })
  }
  return c
}
// wallets answer v as 27/28 or as 0/1; the network wants 27/28
const sig65 = (s: string) => {
  const b = unhex(s)
  if (b.length !== 65) throw new Error('The wallet returned an unexpected signature.')
  if (b[64] < 27) b[64] += 27
  return b
}

export const walletCustody = (address: string): Custody => {
  const account = address as `0x${string}`
  const key = keyFor(address)
  return {
    address,
    // MetaMask only signs typed data for the chain it's on, so it switches to the domain's chain first
    typed: async (t) => sig65(await tidy(on(t.domain.chainId as 1, key).then((c) => c.signTypedData({ account, ...t } as any)))),
    message: async (m) => sig65(await tidy(client(key).signMessage({ account, message: { raw: m } }))),
  }
}

/** Pay for IdGateway.register from the wallet on Optimism. Returns the tx hash. */
export const register = (address: string, value: bigint) => sendTx(address, ID_GATEWAY, registerData(address), value)

/** Send a transaction on Optimism from the wallet. Returns the tx hash. */
export async function sendTx(address: string, to: string, data: string, value = 0n) {
  const account = address as `0x${string}`
  return tidy(on(10, keyFor(address)).then((c) => c.sendTransaction({ account, chain: optimism, to: to as `0x${string}`, data: data as `0x${string}`, value })))
}
