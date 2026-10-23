// What a mini app may ask of the person's wallet and Farcaster account. The wallet sees every request as
// coming from quilcast.com, so the checks a wallet would make per site (whose sign-in is this?) happen here,
// and nothing from a mini app may touch the Farcaster account itself (custody, keys, fname, logins).
import { keccak_256 } from '@noble/hashes/sha3.js'
import { hex, unhex } from './fc.ts'

const utf8 = (s: string) => new TextEncoder().encode(s)
export const rpcError = (code: number, message: string) => Object.assign(new Error(message), { code })

/** Answered from a public RPC for the app's chain: no wallet, no prompt. */
export const READS = new Set(['eth_blockNumber', 'eth_call', 'eth_estimateGas', 'eth_feeHistory', 'eth_gasPrice', 'eth_getBalance', 'eth_getBlockByHash', 'eth_getBlockByNumber', 'eth_getCode', 'eth_getLogs', 'eth_getProof', 'eth_getStorageAt', 'eth_getTransactionByHash', 'eth_getTransactionCount', 'eth_getTransactionReceipt', 'eth_maxPriorityFeePerGas'])
/** Go to the wallet, which asks the person. eth_sign (blind hashes), eth_signTransaction, older typed data
 *  and permission changes are left out on purpose. */
export const SIGNS = new Set(['personal_sign', 'eth_signTypedData_v4', 'eth_sendTransaction', 'wallet_sendCalls', 'wallet_watchAsset'])
/** Go to the wallet, which answers without asking. */
export const WALLET_READS = new Set(['wallet_getCallsStatus', 'wallet_getCapabilities'])

// Farcaster's contracts on Optimism: transfers, recovery changes, key adds and registrations
const FARCASTER = new Set([
  '0x00000000fc6c5f01fc30151999387bb99a9f489b', // IdRegistry
  '0x00000000fc25870c6ed6b6c7e41fb078b7656f69', // IdGateway
  '0x00000000fc1237824fb747abde0ff18990e59b7e', // KeyRegistry
  '0x00000000fc56947c7e7183f8ca4b62398caadf0b', // KeyGateway
  '0x00000000fcce7f938e7ae6d3c335bd6a1a7c593d', // StorageRegistry
  '0x00000000fc04c910a0b5fea33b03e0447ad0b0aa', // Bundler
  '0x00000000fc700472606ed4fa22623acf62c60553', // SignedKeyRequestValidator
  '0x00000000fcb080a4d6c39a9354da9eb9bc104cd7', // RecoveryProxy
])

const text = (m: unknown) => {
  const s = String(m ?? '')
  return /^0x([0-9a-f]{2})*$/i.test(s) ? new TextDecoder().decode(unhex(s)) : s
}

// signing in to these with the person's wallet could hand over their Farcaster account
const FARCASTER_SITES = /(^|\.)(farcaster\.xyz|warpcast\.com|quilcast\.com)$/i

/** For a message about to be signed (Ethereum or Solana). Throws for Farcaster logins, which only Quilcast's own
 *  prompts may sign. Returns the site a Sign-In message is for when that isn't the app's own host, so the person
 *  can be asked: one app could otherwise sign you in somewhere else as you. */
export function signInCheck(host: string, m: string): string | undefined {
  if (/farcaster:\/\/fid\/|Direct cast authorization|"method"\s*:\s*"generateToken"/i.test(m)) throw rpcError(4100, "Mini apps can't ask for Farcaster account signatures.")
  const site = m.match(/^(?:https?:\/\/)?(\S+) wants you to sign in with your (?:Ethereum|Solana) account:/)?.[1]
  if (!site || site === host) return
  if (FARCASTER_SITES.test(site.replace(/:\d+$/, ''))) throw rpcError(4100, `Mini apps can't sign you in to ${site}.`)
  return site
}

/** Throws (code 4100) if a wallet request from the app at `host` must not reach the wallet of `me`. Returns a
 *  site to confirm with the person (see signInCheck). */
export function checkWallet(host: string, me: string, method: string, params: any[]): string | undefined {
  const no = (why: string) => {
    throw rpcError(4100, why)
  }
  const mine = (a: unknown) => String(a).toLowerCase() === me || no("That address isn't the connected one.")
  const to = (x: unknown) => FARCASTER.has(String(x).toLowerCase()) && no("Mini apps can't send transactions to Farcaster's account contracts.")
  if (method === 'personal_sign') {
    mine(params[1])
    return signInCheck(host, text(params[0]))
  } else if (method === 'eth_signTypedData_v4') {
    mine(params[0])
    let t: any
    try {
      t = typeof params[1] === 'string' ? JSON.parse(params[1]) : params[1]
    } catch {}
    if (!t || typeof t !== 'object') no("The wallet can't read that request.")
    if (/farcaster/i.test(String(t.domain?.name)) || FARCASTER.has(String(t.domain?.verifyingContract).toLowerCase())) no("Mini apps can't ask for Farcaster account signatures.")
  } else if (method === 'eth_sendTransaction') {
    const tx = params[0]
    if (!tx || typeof tx !== 'object') no('Missing transaction.')
    if (tx.from !== undefined) mine(tx.from)
    to(tx.to)
  } else if (method === 'wallet_sendCalls') {
    const p = params[0]
    if (!p || typeof p !== 'object' || !Array.isArray(p.calls)) no('Missing calls.')
    if (p.from !== undefined) mine(p.from)
    for (const c of p.calls) to(c?.to)
  }
}

// --- what a request does, in words: the calls and signatures drainers use ---

const sel = (sig: string) => '0x' + hex(keccak_256(utf8(sig)).slice(0, 4))
const CALLS = Object.fromEntries(([
  ['approve(address,uint256)', 'approve'], ['increaseAllowance(address,uint256)', 'approve'], ['setApprovalForAll(address,bool)', 'approveAll'],
  // Permit2's own approve(token, spender, amount, expiration)
  ['approve(address,address,uint160,uint48)', 'approve2'],
  ['transfer(address,uint256)', 'transfer'], ['transferFrom(address,address,uint256)', 'move'],
  ['safeTransferFrom(address,address,uint256)', 'move'], ['safeTransferFrom(address,address,uint256,bytes)', 'move'],
] as const).map(([sig, kind]) => [sel(sig), { kind, types: sig.slice(sig.indexOf('(') + 1, -1).split(',').filter((t) => t !== 'bytes') }]))

export type TokenCall = { kind: 'approve' | 'approveAll' | 'approve2' | 'transfer' | 'move'; args: (string | bigint | boolean)[] }
/** The token call in a transaction's data, when it's one that gives tokens away or lets someone else take them. */
export function tokenCall(data: unknown): TokenCall | undefined {
  const d = String(data || '').toLowerCase()
  const c = /^0x[0-9a-f]*$/.test(d) ? CALLS[d.slice(0, 10)] : undefined
  const words = c?.types.map((_, i) => d.slice(10 + i * 64, 74 + i * 64))
  if (!c || !words || words.some((w) => w.length < 64)) return
  return { kind: c.kind, args: c.types.map((t, i) => (t === 'address' ? '0x' + words[i].slice(24) : t === 'bool' ? BigInt('0x' + words[i]) !== 0n : BigInt('0x' + words[i]))) }
}
/** Amounts this big are "everything you have", whatever the token. */
export const UNLIMITED = 2n ** 128n

/** A typed-data signature that hands something over: a permit lets `spender` take tokens without asking again, a
 *  Seaport order puts NFTs up for sale. */
export function typedRisk(t: any): { kind: 'permit' | 'listing'; spender?: string } | undefined {
  const name = String(t?.domain?.name || '')
  const type = String(t?.primaryType || '')
  if (type === 'Permit' || name === 'Permit2' || /^Permit(Single|Batch|TransferFrom|BatchTransferFrom|WitnessTransferFrom|BatchWitnessTransferFrom)$/.test(type))
    return { kind: 'permit', spender: typeof t?.message?.spender === 'string' ? t.message.spender : undefined }
  if (name === 'Seaport' || type === 'OrderComponents') return { kind: 'listing' }
}

/** EIP-55 mixed-case address: Sign-In with Ethereum verifiers refuse lowercase ones. */
export const checksum = (a: string) => {
  const low = a.toLowerCase().replace(/^0x/, '')
  const h = hex(keccak_256(utf8(low)))
  return '0x' + [...low].map((c, i) => (parseInt(h[i], 16) >= 8 ? c.toUpperCase() : c)).join('')
}

const iso = (s: unknown) => {
  const t = Date.parse(String(s))
  if (Number.isNaN(t)) throw new Error('Invalid time.')
  return new Date(t).toISOString()
}

/** The Sign In With Farcaster message for the app at `origin`. Everything the app passes in is checked or
 *  re-written first, so it can't add lines (another domain, other resources) to what gets signed. */
export function siwf(o: { origin: string; address: string; fid: number; nonce: unknown; notBefore?: unknown; expirationTime?: unknown; now?: Date }) {
  const nonce = String(o.nonce ?? '')
  if (!/^[a-zA-Z0-9]{8,96}$/.test(nonce)) throw new Error('Invalid nonce.')
  const { host, origin } = new URL(o.origin)
  return [
    `${host} wants you to sign in with your Ethereum account:`,
    checksum(o.address),
    '',
    'Farcaster Auth',
    '',
    `URI: ${origin}`,
    'Version: 1',
    'Chain ID: 10',
    `Nonce: ${nonce}`,
    `Issued At: ${(o.now || new Date()).toISOString()}`,
    ...(o.expirationTime === undefined ? [] : [`Expiration Time: ${iso(o.expirationTime)}`]),
    ...(o.notBefore === undefined ? [] : [`Not Before: ${iso(o.notBefore)}`]),
    'Resources:',
    `- farcaster://fid/${o.fid}`,
  ].join('\n')
}
