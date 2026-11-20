import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseToken, SENDCLAP_PERIOD, sendclapAllowance, sendclapOk, tipAddress } from './tokens.ts'

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
