// Just enough Optimism to register an FID: JSON-RPC, RLP, EIP-1559 signing.
import { keccak_256 } from '@noble/hashes/sha3.js'
import { address, concat, ecSign, hex, KEY_REGISTRY, unhex } from './fc.ts'

const ID_REGISTRY = '0x00000000fc6c5f01fc30151999387bb99a9f489b'

export async function rpc(url: string, method: string, params: unknown[] = []) {
  const r = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()
  if (r.error) throw new Error(r.error.message)
  return r.result
}
const call = async (url: string, to: string, data: string) => BigInt(await rpc(url, 'eth_call', [{ to, data }, 'latest']))
const sel = (sig: string) => hex(keccak_256(new TextEncoder().encode(sig)).slice(0, 4))
const arg = (a: string) => a.replace(/^0x/, '').padStart(64, '0')

export const balance = async (url: string, addr: string) => BigInt(await rpc(url, 'eth_getBalance', [addr, 'latest']))
export const fidOf = async (url: string, addr: string) => Number(await call(url, ID_REGISTRY, '0x' + sel('idOf(address)') + arg(addr)))

/** A key of `fid` in Farcaster's KeyRegistry, what mini app webhooks are checked against: 0 never added, 1 added,
 *  2 removed. Throws when the RPC can't be asked or answers with something that isn't a KeyData (callers catch it,
 *  so the message isn't shown). */
export async function keyState(url: string, fid: number, key: Uint8Array) {
  // keyDataOf(uint256 fid, bytes key) returns (uint8 state, uint32 keyType)
  const r: string = await rpc(url, 'eth_call', [{ to: KEY_REGISTRY, data: '0x' + sel('keyDataOf(uint256,bytes)') + arg(fid.toString(16)) + arg('40') + arg(key.length.toString(16)) + hex(key).padEnd(Math.ceil(key.length / 32) * 64, '0') }, 'latest'])
  const state = /^0x[0-9a-f]{128}$/i.test(r) ? BigInt(r.slice(0, 66)) : -1n
  if (state < 0n || state > 2n) throw new Error(`unexpected KeyRegistry answer: ${String(r).slice(0, 140)}`)
  return Number(state) as 0 | 1 | 2
}

/** Whether transaction `hash` was mined and reverted: true when it failed, false when it went through, undefined while it's pending. */
export async function reverted(url: string, hash: string) {
  const r = await rpc(url, 'eth_getTransactionReceipt', [hash])
  return r ? BigInt(r.status) === 0n : undefined
}

// RLP: bytes or lists of bytes; integers go in as minimal big-endian bytes
type R = Uint8Array | R[]
const be = (n: bigint | number) => {
  const s = BigInt(n).toString(16)
  return BigInt(n) === 0n ? new Uint8Array() : unhex(s.length % 2 ? '0' + s : s)
}
const len = (n: number, off: number) => (n < 56 ? Uint8Array.of(off + n) : concat(Uint8Array.of(off + 55 + be(n).length), be(n)))
export const rlp = (x: R): Uint8Array =>
  Array.isArray(x)
    ? ((p) => concat(len(p.length, 0xc0), p))(concat(...x.map(rlp)))
    : x.length === 1 && x[0] < 0x80 ? x : concat(len(x.length, 0x80), x)

/** Send a transaction on Optimism from the custody key. Returns the tx hash. */
export async function sendTx(url: string, custody: Uint8Array, to: string, data: string, value = 0n) {
  const from = address(custody)
  const [nonce, gas, base, tip] = await Promise.all([
    rpc(url, 'eth_getTransactionCount', [from, 'latest']),
    rpc(url, 'eth_estimateGas', [{ from, to, data, value: '0x' + value.toString(16) }]),
    rpc(url, 'eth_gasPrice'),
    rpc(url, 'eth_maxPriorityFeePerGas'),
  ])
  const maxFee = BigInt(base) * 2n + BigInt(tip)
  const limit = (BigInt(gas) * 13n) / 10n
  // Optimism gas costs a tiny fraction of a gwei; refuse numbers a broken or hostile RPC might hand us
  if (value > 10n ** 16n || maxFee > 10n ** 10n || limit > 2_000_000n) throw new Error('The Optimism RPC returned unexpected fees. Check the RPC in settings.')
  const fields: R[] = [10n, BigInt(nonce), BigInt(tip), maxFee, limit, unhex(to), value, unhex(data), []]
    .map((f) => (typeof f === 'bigint' ? be(f) : f))
  const { rs, v } = ecSign(keccak_256(concat(Uint8Array.of(2), rlp(fields))), custody)
  const raw = concat(Uint8Array.of(2), rlp([...fields, be(v), be(BigInt('0x' + hex(rs.slice(0, 32)))), be(BigInt('0x' + hex(rs.slice(32))))]))
  return rpc(url, 'eth_sendRawTransaction', ['0x' + hex(raw)]) as Promise<string>
}
