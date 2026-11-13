// An external wallet (MetaMask, Rabby, OKX…) as the custody address, through viem. Only loaded when someone
// connects one. Wallets announce themselves over EIP-6963; window.ethereum is the fallback, for older wallets and
// for the mini app host (inapp.ts leaves the client's provider there).
import { bytesToHex, createPublicClient, createWalletClient, custom, encodeDeployData, erc6492SignatureValidatorAbi, erc6492SignatureValidatorByteCode, hashMessage, http, recoverMessageAddress, type EIP1193Provider } from 'viem'
import { base, mainnet, optimism } from 'viem/chains'
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

// WalletConnect: a wallet on another device, usually a phone, reached through Reown's relay after scanning a QR code.
// The project id is public (it only names Quilcast to the relay); with none set, the option stays hidden.
const WC_PROJECT = 'b41717a1a3d91a46633e2ec5983515f8'
export const WC = 'walletconnect'
// one session serves sign-in (Optimism, mainnet) and mini apps, so it asks for every chain miniapp.tsx knows
const WC_CHAINS = [10, 1, 8453, 42161, 137, 42220, 7777777, 130, 143, 666666666, 84532].map((id) => `eip155:${id}`)
const WC_METHODS = ['personal_sign', 'eth_signTypedData_v4', 'eth_sendTransaction', 'wallet_sendCalls', 'wallet_getCallsStatus', 'wallet_getCapabilities', 'wallet_watchAsset']
let up: Promise<any> | undefined
const universal = () =>
  (up ??= import('@walletconnect/universal-provider').then(async ({ UniversalProvider }) => {
    const p = await UniversalProvider.init({ projectId: WC_PROJECT, metadata: { name: 'Quilcast', description: 'A Farcaster client', url: location.origin, icons: [`${location.origin}/icon.png`] } })
    // a session lasts a week; each visit asks for another, so it lasts as long as it's used
    if (p.session) p.client.extend({ topic: p.session.topic }).catch(() => {})
    return p
  }))
// viem and mini apps talk EIP-1193; the session answers per chain, so the chain they switch to is kept here and
// passed along. One bridge per session object, so a switch holds for the requests after it.
const bridges = new WeakMap<object, Injected>()
export function bridge(p: any): Injected {
  const b = bridges.get(p)
  if (b) return b
  let chain = 10
  const made = {
    request: async ({ method, params }: { method: string; params?: any }) => {
      if (method === 'eth_chainId') return `0x${chain.toString(16)}`
      if (method === 'wallet_switchEthereumChain') {
        const id = parseInt(params[0].chainId)
        // a chain the wallet didn't approve can't be reached, and a transaction must never land on another one
        if (!p.session.namespaces.eip155?.accounts.some((a: string) => a.startsWith(`eip155:${id}:`))) throw Object.assign(new Error("The wallet didn't connect that network."), { code: 4901 })
        chain = id
        return null
      }
      return p.request({ method, params }, `eip155:${chain}`)
    },
  } as Injected
  bridges.set(p, made)
  return made
}
/** A stand-in for Reown's provider, for tests. */
export const useUniversal = (p: any) => void (up = Promise.resolve(p))
/** Whether a WalletConnect session is up and reaches `chain`, so a mini app can use it without a new QR code. */
export const wcLive = async (chain: number) => !!(await universal()).session?.namespaces.eip155?.accounts.some((a: string) => a.startsWith(`eip155:${chain}:`))
export const wcChoice: Choice = { name: 'WalletConnect', icon: '', key: WC, provider: { request: async (a: any) => (await provider(WC)).request(a) } as Injected }

/** The wallets that announced themselves, for the picker on "Use a wallet", and WalletConnect after them. */
export const choices = () => [...announced, ...(WC_PROJECT ? [wcChoice] : [])]

/** A QR code of a WalletConnect link, as an image URL. */
export const qr = async (uri: string) => `data:image/svg+xml,${encodeURIComponent((await import('uqr')).renderSVG(uri, { border: 2 }))}`

// Which wallet an address connected with, by rdns. Later signatures have to go back to that same wallet: another
// one doesn't hold the address and would refuse, and with several wallets the guess below could land on either.
// api.ts has read/save, but importing it here would pull the account store and its listeners into this chunk,
// which only a connect needs, so these lines stay local.
// This map once sat under quilcast:wallets, the key vault.ts keeps its own wallet list in, and a connect folded that
// list into it so created wallets vanished (#313). vault.ts moves those pairs here when it next reads its list;
// until then they are read from the old key too.
const CONNECTED_WITH = 'quilcast:connectedWith'
const map = (k: string): Record<string, unknown> => {
  try {
    const v = JSON.parse(localStorage.getItem(k)!)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch {
    return {}
  }
}
const pairs = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => typeof v === 'string')) as Record<string, string>
const used = () => ({ ...pairs(map('quilcast:wallets')), ...pairs(map(CONNECTED_WITH)) })
const remember = (address: string, key: string) => {
  try {
    localStorage.setItem(CONNECTED_WITH, JSON.stringify({ ...pairs(map(CONNECTED_WITH)), [address]: key }))
  } catch {}
}
const keyFor = (address: string) => used()[address.toLowerCase()]

async function provider(key?: string): Promise<Injected> {
  if (key === WC) {
    const p = await universal()
    // ponytail: an ended session can't be picked up again from a signature prompt; connecting again pairs a new one
    // (an account's signatures go through again() below, which shows a new QR code first)
    if (!p.session) throw new Error('The WalletConnect session ended. Connect your wallet again.')
    return bridge(p)
  }
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
const client = async (key?: string) => createWalletClient({ transport: custom(await provider(key)) })
// viem's errors carry a page of details; people need the first line. The code stays (4001: the person declined), and
// the error itself as the cause, for stale() to read what WalletConnect said
const tidy = <T>(p: Promise<T>) =>
  p.catch((e) => Promise.reject(Object.assign(new Error(e?.shortMessage || e?.message || 'The wallet refused.', { cause: e }), { code: e?.code ?? e?.cause?.code })))

/** Ask a wallet for its address, and remember which one it was. `key` is a choices() rdns; without one this
 *  takes the only wallet there is, the way it did before the picker. WalletConnect hands `show` the link to
 *  pair with, and '' once it's done. */
export async function connect(key?: string, show?: (uri: string) => void) {
  if (key === WC) await pair(show)
  const [addr] = await tidy((await client(key)).requestAddresses())
  if (!addr) throw new Error('The wallet shared no address.')
  const address = addr.toLowerCase()
  if (key) remember(address, key)
  return address
}

// ponytail: one session per browser, so a second WalletConnect account replaces the first one's connection
export async function pair(show?: (uri: string) => void) {
  const p = await universal()
  if (p.session) await p.disconnect().catch(() => {})
  const uri = (u: string) => show?.(u)
  p.on('display_uri', uri)
  try {
    await tidy(p.connect({ optionalNamespaces: { eip155: { chains: WC_CHAINS, methods: WC_METHODS, events: ['accountsChanged', 'chainChanged'] } } }))
  } finally {
    p.off?.('display_uri', uri)
    show?.('')
  }
}

// whether the WalletConnect session holds `address`, on any chain
const holds = (p: any, address: string) => !!p.session?.namespaces.eip155?.accounts.some((a: string) => a.toLowerCase().endsWith(`:${address.toLowerCase()}`))

/** Pair WalletConnect again for an account whose session ended, handing `show` the link the way connect() does, and
 *  check that the wallet came back with the account's own address. */
export async function repair(address: string, show?: (uri: string) => void) {
  await pair(show)
  const p = await universal()
  if (!holds(p, address)) {
    // another account's session would sign as someone else; the next try pairs afresh
    await p.disconnect().catch(() => {})
    throw new Error("Your wallet connected a different address than this account's. Switch to the account's address in your wallet and try again.")
  }
  remember(address.toLowerCase(), WC)
}

/** What the WalletConnect SDK says about a session that's gone (expired, deleted, unknown to the relay), or about a
 *  request the wallet never answered: either way the wallet isn't listening on it any more. Declining isn't one, and
 *  nor is a wallet's own "transaction expired": only the SDK's wording counts. */
export const stale = (e: any) => e?.code !== 4001 && /request expired|expired\. (session|pairing|proposal)|session topic (doesn't|does not) exist|recently deleted|no matching key|session ended|connect\(\) before/i.test(said(e))
const unanswered = (e: any) => /request expired/i.test(said(e))
// an error's text, with viem's details and what caused it
const said = (e: any, depth = 0): string => (e && depth < 5 ? `${e.shortMessage} ${e.message} ${e.details} ${said(e.cause, depth + 1)}` : '')

/** Pairs a WalletConnect account's wallet again (app.tsx shows the QR code and calls repair()). */
export type Again = () => Promise<void>
// A WalletConnect account whose session ended (unused for a week, dropped by the wallet, storage cleared) pairs again
// in place through `again` before it signs; a session the SDK only finds stale once asked pairs again and asks once
// more. Without `again` (a fresh connect), or for any other wallet, it just runs.
// A request the wallet never answered ("Request expired", after 5 minutes) is different: the person may have given up
// on it long ago (a sign-in cancelled while it waited) and a transaction may still have gone out, so nothing pairs or
// asks again from there. The person hears it, and the next request on that session pairs again first. (A phone that's
// fine but was left unanswered then costs a scan; the other way round, a dead session would cost 5 minutes every time.)
let silent: string | undefined
async function live<T>(address: string, again: Again | undefined, run: () => Promise<T>, tx = false): Promise<T> {
  if (!again || keyFor(address) !== WC) return run()
  // `again` can settle on another account's pairing (several asked at once), so the address is checked here too
  const paired = async () => {
    await again()
    if (!holds(await universal(), address)) throw new Error("Your wallet connected a different address than this account's. Switch to the account's address in your wallet and try again.")
  }
  const before = await universal()
  if (!holds(before, address) || (silent && before.session?.topic === silent)) await paired()
  const topic = (await universal()).session?.topic
  try {
    return await run()
  } catch (e) {
    if (!stale(e)) throw e
    if (unanswered(e)) {
      silent = topic
      if (tx) throw new Error("Your wallet didn't answer. Check whether the transaction went through before you try again.")
      throw new Error("Your wallet didn't answer. Try again to reconnect it.")
    }
    // another request, or Settings › Reconnect, may have paired again while this one was out
    const now = await universal()
    if (!now.session || now.session.topic === topic || !holds(now, address)) await paired()
    return run()
  }
}

const CHAINS = { 1: mainnet, 10: optimism, 8453: base }
async function on(id: keyof typeof CHAINS, key?: string) {
  const c = await client(key)
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

/** A message signature, checked against the address it's meant to be from. A smart-contract wallet (Coinbase
 *  Smart Wallet, Safe…) answers with a longer ERC-1271/6492 signature, which apps check on chain the same way
 *  (Quick Auth does, on Optimism), so it goes on as it is. A wallet that signed with another of its accounts is
 *  caught here, with an error that says so, instead of by the app the signature was for. */
async function checked(address: string, m: Uint8Array, s: string, rpc?: string) {
  const raw = unhex(s)
  if (raw.length < 65) throw new Error('The wallet returned an unexpected signature.')
  if (raw.length === 65) {
    const sig = sig65(s)
    // a contract wallet's 65 bytes need not be a point at all
    if ((await recoverMessageAddress({ message: { raw: m }, signature: sig }).catch(() => '')).toLowerCase() === address.toLowerCase()) return sig
  }
  // not this address's own key: a contract wallet's signature goes on byte for byte (its v isn't ours to change)
  if (!rpc) return raw
  // a contract wallet's signature (deployed or not), or another account's: ERC-6492's universal validator tells, in one
  // eth_call. Only a clear "no" counts: an RPC that's down or rate-limited, or a call that reverts, leaves it to the app
  const data = encodeDeployData({ abi: erc6492SignatureValidatorAbi, bytecode: erc6492SignatureValidatorByteCode, args: [address as `0x${string}`, hashMessage({ raw: m }), bytesToHex(raw)] })
  const said = await createPublicClient({ transport: http(rpc, { retryCount: 0 }) }).call({ data }).then((r) => r.data, () => undefined)
  if (said && /^0x0+$/.test(said)) {
    // a plain signature from another key is another account; a smart wallet's can also be for another chain, or broken
    if (raw.length === 65) throw new Error("Your wallet signed with a different address than this account's. Switch to the account's address in your wallet and try again.")
    throw new Error("Your wallet's signature didn't check out for this account.")
  }
  return raw
}

/** The wallet that holds `address`, as its custody signer. `rpc` (Optimism) checks smart-wallet signatures; `again`
 *  pairs a WalletConnect wallet whose session ended. */
export const walletCustody = (address: string, rpc = 'https://mainnet.optimism.io', again?: Again): Custody => {
  const account = address as `0x${string}`
  const key = keyFor(address)
  // a smart wallet's message signature holds the chain it's on (Coinbase Smart Wallet's replaySafeHash, Safe), so a
  // message checked on `chain` is signed there. Declining the switch is declining; a wallet that can't switch signs
  // where it is, which a plain wallet's signature doesn't care about
  const signer = async (chain?: keyof typeof CHAINS) => {
    if (!chain) return client(key)
    try {
      return await on(chain, key)
    } catch (e: any) {
      if ((e?.code ?? e?.cause?.code) === 4001) throw e
      return client(key)
    }
  }
  return {
    address,
    // MetaMask only signs typed data for the chain it's on, so it switches to the domain's chain first
    typed: async (t) => sig65(await live(address, again, () => tidy(on(t.domain.chainId as 1, key).then((c) => c.signTypedData({ account, ...t } as any))))),
    message: async (m, o) => checked(address, m, await live(address, again, () => tidy(signer(o?.chain).then((c) => c.signMessage({ account, message: { raw: m } })))), o?.local ? undefined : rpc),
  }
}


/** Send a transaction from the wallet, on Optimism unless `chain` says otherwise. Returns the tx hash. `again` pairs a
 *  WalletConnect wallet whose session ended. */
export async function sendTx(address: string, to: string, data: string, value = 0n, chain: keyof typeof CHAINS = 10, again?: Again) {
  const account = address as `0x${string}`
  return live(address, again, () => tidy(on(chain, keyFor(address)).then((c) => c.sendTransaction({ account, chain: CHAINS[chain], to: to as `0x${string}`, data: data as `0x${string}`, value }))), true)
}
