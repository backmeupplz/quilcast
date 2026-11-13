// Just enough Optimism to register an FID: JSON-RPC, RLP, EIP-1559 signing.
import { keccak_256 } from '@noble/hashes/sha3.js'
import { address, concat, ecSign, hex, unhex } from './fc.ts'

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
