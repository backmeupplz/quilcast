// Tokens for the mini app actions sendToken, swapToken and viewToken: CAIP-19 ids, ERC-20 basics read over
// a public RPC, and swap routes from LI.FI (keyless). The only contract a swap may call or be approved for is
// LI.FI's diamond, so a quote can't point the wallet somewhere else.
import { decodeFunctionResult, encodeFunctionData, erc20Abi } from 'viem'

export type TokenId = { chain: number; address?: `0x${string}` }
export type Token = TokenId & { symbol: string; decimals: number }
export const LIFI = '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae'
// USDC, what a swap buys when the app doesn't say
export const USDC: Record<number, `0x${string}`> = {
  8453: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 10: '0x0b2c639c533813f4aa9d7837caf62653d097ff85', 1: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  42161: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', 137: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
}

/** "eip155:8453/erc20:0x…" (a token) or "eip155:8453/slip44:60" (the chain's own coin). */
export function parseToken(id: unknown): TokenId {
  const m = String(id).match(/^eip155:(\d{1,12})\/(?:erc20:(0x[0-9a-fA-F]{40})|slip44:\d{1,10})$/)
  if (!m) throw new Error('Quilcast can send and swap tokens on EVM chains only.')
  return { chain: Number(m[1]), address: m[2]?.toLowerCase() as `0x${string}` | undefined }
}

type Rpc = (method: string, params: unknown[]) => Promise<any>
const read = async (rpc: Rpc, to: string, functionName: 'symbol' | 'decimals' | 'allowance', args: unknown[] = []) =>
  decodeFunctionResult({ abi: erc20Abi, functionName, data: await rpc('eth_call', [{ to, data: encodeFunctionData({ abi: erc20Abi, functionName, args } as any) }, 'latest']) } as any)

/** Symbol and decimals; the chain's coin uses `native`. */
export async function tokenInfo(rpc: Rpc, t: TokenId, native: { symbol: string; decimals: number }): Promise<Token> {
  if (!t.address) return { ...t, ...native }
  const [symbol, decimals] = await Promise.all([read(rpc, t.address, 'symbol'), read(rpc, t.address, 'decimals')])
  return { ...t, symbol: String(symbol).slice(0, 12), decimals: Number(decimals) }
}

export const allowance = async (rpc: Rpc, t: TokenId, owner: string) => BigInt(await read(rpc, t.address!, 'allowance', [owner, LIFI]) as bigint)

/** The transaction that sends `amount` (base units) of `t` to `to`. */
export const transferTx = (t: TokenId, to: string, amount: bigint) =>
  t.address
    ? { to: t.address, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to as `0x${string}`, amount] }), value: '0x0' }
    : { to, data: '0x', value: '0x' + amount.toString(16) }

/** Approval for exactly `amount`, to LI.FI only. */
export const approveTx = (t: TokenId, amount: bigint) => ({ to: t.address!, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [LIFI, amount] }), value: '0x0' })

export type Quote = {
  tx: { to: string; data: string; value: string; gas?: string }; toAmount: bigint; toAmountMin: bigint
  // what the wallet's swap screen shows: the route LI.FI picked (a DEX or a bridge), how long, and what it costs
  tool?: string; seconds?: number; feesUsd?: number; fromUsd?: number; toUsd?: number
}
/** A LI.FI route selling `amount` of `sell` for `buy`, sent from and to `from`. */
export async function quote(sell: TokenId, buy: TokenId, amount: bigint, from: string): Promise<Quote> {
  const zero = '0x0000000000000000000000000000000000000000'
  const q = new URLSearchParams({ fromChain: String(sell.chain), toChain: String(buy.chain), fromToken: sell.address || zero, toToken: buy.address || zero, fromAmount: String(amount), fromAddress: from })
  const r = await fetch(`https://li.quest/v1/quote?${q}`)
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.message || 'No swap route found.')
  const t = j.transactionRequest
  // the route must run through LI.FI's own contract, on the chain the tokens are sold on
  if (String(t?.to).toLowerCase() !== LIFI || Number(t.chainId) !== sell.chain || (sell.address && String(j.estimate?.approvalAddress).toLowerCase() !== LIFI)) throw new Error('The swap route looks wrong, so Quilcast stopped.')
  const e = j.estimate
  const usd = (xs: { amountUSD?: string; included?: boolean }[] = []) => xs.reduce((n, x) => n + (Number(x.amountUSD) || 0), 0)
  return {
    tx: { to: t.to, data: t.data, value: t.value || '0x0', gas: t.gasLimit }, toAmount: BigInt(e.toAmount), toAmountMin: BigInt(e.toAmountMin),
    tool: j.toolDetails?.name, seconds: e.executionDuration, feesUsd: usd(e.gasCosts) + usd((e.feeCosts || []).filter((f: { included?: boolean }) => !f.included)), fromUsd: Number(e.fromAmountUSD) || undefined, toUsd: Number(e.toAmountUSD) || undefined,
  }
}

export type ListedToken = Token & { name: string; logo?: string; usd: number }
const lists = new Map<number, Promise<ListedToken[]>>()
/** LI.FI's verified tokens on a chain (the coin first), for picking what to buy. */
export const tokensOn = (chain: number) =>
  lists.get(chain) ||
  (lists.set(chain, fetch(`https://li.quest/v1/tokens?chains=${chain}`).then((r) => r.json()).then((j) =>
    ((j.tokens?.[chain] || []) as any[]).filter((x) => x.verificationStatus === 'verified' || /^0x0{40}$/.test(x.address)).map((x): ListedToken => ({
      chain, address: /^0x0{40}$/.test(x.address) ? undefined : (x.address.toLowerCase() as `0x${string}`), symbol: String(x.symbol).slice(0, 12), name: String(x.name || ''), decimals: Number(x.decimals), logo: x.logoURI, usd: Number(x.priceUSD) || 0,
    })),
  ).catch((e) => (lists.delete(chain), Promise.reject(e)))), lists.get(chain)!)

/** Where a cross-chain transfer is: PENDING until the tokens land (DONE) or it fails. */
export async function transferStatus(hash: string, fromChain: number, toChain: number): Promise<{ status: string; received?: string }> {
  const j = await fetch(`https://li.quest/v1/status?${new URLSearchParams({ txHash: hash, fromChain: String(fromChain), toChain: String(toChain) })}`).then((r) => r.json())
  return { status: String(j.status || 'PENDING'), received: j.receiving?.txHash }
}
