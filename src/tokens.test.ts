import assert from 'node:assert/strict'
import { test } from 'node:test'
import { tipAddress } from './tokens.ts'

test('a tip goes to the primary verified address, then any verified one, then custody', () => {
  const custody_address = '0xc'
  assert.equal(tipAddress({ custody_address, verified_addresses: { primary: { eth_address: '0xp' }, eth_addresses: ['0xv', '0xp'] } }), '0xp')
  assert.equal(tipAddress({ custody_address, verified_addresses: { eth_addresses: ['0xv'] } }), '0xv')
  assert.equal(tipAddress({ custody_address, verified_addresses: { eth_addresses: [] } }), '0xc')
  assert.equal(tipAddress({}), undefined)
})
