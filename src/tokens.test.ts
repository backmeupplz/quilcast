import assert from 'node:assert/strict'
import { test } from 'node:test'
import { encodeAbiParameters } from 'viem'
import { balanceOf, erc20Meta, parseToken, pastedToken, SENDCLAP_PERIOD, sendclapAllowance, sendclapOk, tipAddress } from './tokens.ts'

test("a token id names an ERC-20 or the chain's coin, as slip44 or native (#780)", () => {
  assert.deepEqual(parseToken('eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'), { chain: 8453, address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' })
  assert.deepEqual(parseToken('eip155:8453/slip44:60'), { chain: 8453, address: undefined })
  assert.deepEqual(parseToken('eip155:8453/native'), { chain: 8453, address: undefined })
  assert.throws(() => parseToken('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/native'))
  assert.throws(() => parseToken('eip155:8453/nativex'))
})

test('a tip goes to the primary verified address, then any verified one, then custody', () => {
  const custody_address = '0xc'
  assert.equal(tipAddress({ custody_address, verified_addresses: { primary: { eth_address: '0xp' }, eth_addresses: ['0xv', '0xp'] } }), '0xp')
  assert.equal(tipAddress({ custody_address, verified_addresses: { eth_addresses: ['0xv'] } }), '0xv')
  assert.equal(tipAddress({ custody_address, verified_addresses: { eth_addresses: [] } }), '0xc')
  assert.equal(tipAddress({}), undefined)
})

test("a Sendclap checkout must be Sendclap, Base USDC, the amount shown and the tier's billing period (#722)", () => {
  const tip = { contract: '0x3aFF4fa297B7aa8D009281e348E5312d8e93ef9b', usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', amount: '2550000' }
  assert.ok(sendclapOk(tip, 2.55))
  assert.ok(!sendclapOk({ ...tip, contract: '0x000000000000000000000000000000000000dead' }, 2.55))
  assert.ok(!sendclapOk({ ...tip, usdc: '0x000000000000000000000000000000000000dead' }, 2.55))
  assert.ok(!sendclapOk({ ...tip, amount: '255000000' }, 2.55))
  assert.ok(!sendclapOk({ ...tip, period: 1 }, 2.55))
  const join = { ...tip, amount: '3000000', period: SENDCLAP_PERIOD.month }
  assert.ok(sendclapOk(join, 3, SENDCLAP_PERIOD.month))
  assert.ok(sendclapOk({ ...join, period: SENDCLAP_PERIOD.year }, 3, SENDCLAP_PERIOD.year))
  assert.ok(!sendclapOk({ ...join, period: 1 }, 3, SENDCLAP_PERIOD.month))
  assert.ok(!sendclapOk({ ...join, period: undefined }, 3, SENDCLAP_PERIOD.month))
  assert.ok(!sendclapOk(join, 3, -1))
  assert.ok(!sendclapOk(join, 0, SENDCLAP_PERIOD.month))
})

test('a weekly Sendclap tier pins a 7-day period and approves a year of charges (#724)', () => {
  assert.equal(SENDCLAP_PERIOD.week, 7 * 86400)
  const weekly = { contract: '0x3aFF4fa297B7aa8D009281e348E5312d8e93ef9b', usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', amount: '2000000', period: 7 * 86400 }
  assert.ok(sendclapOk(weekly, 2, SENDCLAP_PERIOD.week))
  assert.ok(!sendclapOk({ ...weekly, period: 86400 }, 2, SENDCLAP_PERIOD.week))
  assert.ok(!sendclapOk({ ...weekly, period: SENDCLAP_PERIOD.month }, 2, SENDCLAP_PERIOD.week))
  assert.ok(!sendclapOk(weekly, 2, SENDCLAP_PERIOD.month))
  assert.equal(sendclapAllowance(2_000_000n, SENDCLAP_PERIOD.week), 104_000_000n)
  // monthly and yearly as before #724: 12 months, one year; a tip just itself
  assert.equal(sendclapAllowance(3_000_000n, SENDCLAP_PERIOD.month), 36_000_000n)
  assert.equal(sendclapAllowance(3_000_000n, SENDCLAP_PERIOD.year), 3_000_000n)
  assert.equal(sendclapAllowance(2_550_000n), 2_550_000n)
  assert.equal(sendclapAllowance(2_550_000n, 0), 2_550_000n)
})

test("Add a token takes a contract address or a CAIP-19 id, and nothing else (#789)", () => {
  const a = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
  assert.deepEqual(pastedToken(` ${a} `, 10), { chain: 10, address: a.toLowerCase() })
  assert.deepEqual(pastedToken(`eip155:8453/erc20:${a}`, 10), { chain: 8453, address: a.toLowerCase() })
  for (const bad of ['', '0x1234', 'eip155:8453/native', 'hello']) assert.throws(() => pastedToken(bad, 8453), /Paste a token contract address/)
})

test("a token's details are read from its contract, and anything else fails readably (#789)", async () => {
  const str = (s: string) => encodeAbiParameters([{ type: 'string' }], [s])
  const uint = (n: bigint) => encodeAbiParameters([{ type: 'uint256' }], [n])
  // selectors: symbol 95d89b41, decimals 313ce567, name 06fdde03, balanceOf 70a08231
  const erc20 = (method: string, params: any[]) => Promise.resolve(method === 'eth_getCode' ? '0x60' : ({ '95d89b41': str('CLNK'), '313ce567': uint(18n), '06fdde03': str('Clanker'), '70a08231': uint(5n) } as any)[params[0].data.slice(2, 10)])
  assert.deepEqual(await erc20Meta(erc20, '0x1'), { symbol: 'CLNK', name: 'Clanker', decimals: 18 })
  assert.equal(await balanceOf(erc20, '0x1', '0x0000000000000000000000000000000000000002'), 5n)
  await assert.rejects(erc20Meta(async (m) => (m === 'eth_getCode' ? '0x' : '0x'), '0x1'), /No contract at that address/)
  await assert.rejects(erc20Meta(async (m) => (m === 'eth_getCode' ? '0x60' : Promise.reject(new Error('execution reverted'))), '0x1'), /isn't an ERC-20 token/)
  await assert.rejects(erc20Meta(async (m) => (m === 'eth_getCode' ? '0x60' : '0x'), '0x1'), /isn't an ERC-20 token/)
  await assert.rejects(erc20Meta(() => Promise.reject(new TypeError('Failed to fetch')), '0x1'), /Couldn't reach the network/)
})
