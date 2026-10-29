// An external wallet (MetaMask, Rabby, OKX…) as the custody address, through viem. Only loaded when someone
// connects one. Wallets announce themselves over EIP-6963; window.ethereum is the fallback, for older wallets and
// for the mini app host (inapp.ts leaves the client's provider there).
import { createWalletClient, custom, type EIP1193Provider } from 'viem'
import { mainnet, optimism } from 'viem/chains'
import { ID_GATEWAY, registerData } from './eth.ts'
import { unhex, type Custody } from './fc.ts'

type Injected = EIP1193Provider & { providers?: Injected[]; isRabby?: boolean; isOkxWallet?: boolean }
// Two extensions racing for window.ethereum can leave an object there that answers nothing, not even eth_chainId,
// and the connect then hangs with no prompt. Only a live wallet announces itself, so asking steps around the
// leftover. Extensions answer while this module loads, the same way miniapp.tsx collects them.
const announced: Injected[] = []
window.addEventListener?.('eip6963:announceProvider', (e) => {
  const p = (e as CustomEvent).detail?.provider as Injected | undefined
  if (typeof p?.request === 'function' && !announced.includes(p)) announced.push(p)
})
window.dispatchEvent?.(new Event('eip6963:requestProvider'))

function provider() {
  const w = window as unknown as { ethereum?: Injected; okxwallet?: Injected }
  const all = [...announced, ...(w.ethereum?.providers || [])]
  // window.ethereum when it is one of the live wallets: that is the one the browser is set to reach for
  const same = w.ethereum && announced.includes(w.ethereum) ? w.ethereum : undefined
  const p = all.find((x) => x.isRabby) || all.find((x) => x.isOkxWallet) || same || announced[0] || w.okxwallet || w.ethereum
  if (!p) throw new Error('No wallet found in this browser. Install one like MetaMask or Rabby, or open Quilcast in your wallet app.')
  return p
}
const client = () => createWalletClient({ transport: custom(provider()) })
// viem's errors carry a page of details; people need the first line
const tidy = <T>(p: Promise<T>) => p.catch((e) => Promise.reject(new Error(e?.shortMessage || e?.message || 'The wallet refused.')))

/** Ask the wallet for its address. */
export async function connect() {
  const [addr] = await tidy(client().requestAddresses())
  if (!addr) throw new Error('The wallet shared no address.')
  return addr.toLowerCase()
}

const CHAINS = { 1: mainnet, 10: optimism }
async function on(id: 1 | 10) {
  const c = client()
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
  return {
    address,
    // MetaMask only signs typed data for the chain it's on, so it switches to the domain's chain first
    typed: async (t) => sig65(await tidy(on(t.domain.chainId as 1).then((c) => c.signTypedData({ account, ...t } as any)))),
    message: async (m) => sig65(await tidy(client().signMessage({ account, message: { raw: m } }))),
  }
}

/** Pay for IdGateway.register from the wallet on Optimism. Returns the tx hash. */
export const register = (address: string, value: bigint) => sendTx(address, ID_GATEWAY, registerData(address), value)

/** Send a transaction on Optimism from the wallet. Returns the tx hash. */
export async function sendTx(address: string, to: string, data: string, value = 0n) {
  const account = address as `0x${string}`
  return tidy(on(10).then((c) => c.sendTransaction({ account, chain: optimism, to: to as `0x${string}`, data: data as `0x${string}`, value })))
}
