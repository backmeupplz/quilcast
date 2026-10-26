import assert from 'node:assert/strict'
import { test } from 'node:test'
import { matches, newest, toActivity } from './activity.ts'

const me = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
const h = (n: number) => `0x${String(n).padStart(64, '0')}`
// trimmed from explorer.optimism.io's /api/v2/addresses/<me>/transactions
const page = {
  items: [
    { hash: h(1), timestamp: '2026-10-19T07:46:29.000000Z', status: 'ok', result: 'success', method: null, value: '10000000000000', from: { hash: '0x9F10063326B86cAE32A3fF2d3072537576c0E24f' }, to: { hash: me }, transaction_types: ['coin_transfer', 'contract_call'] },
    { hash: h(2), timestamp: '2026-10-20T00:00:00.000000Z', status: 'error', result: 'Reverted', method: 'swap', value: '0', from: { hash: me }, to: { hash: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE' }, transaction_types: ['contract_call'] },
    { hash: h(3), timestamp: null, status: null, result: 'pending', method: '0xa9059cbb', value: '1500000000000000000', from: { hash: me }, to: { hash: '0x000000000000000000000000000000000000dEaD' }, transaction_types: ['coin_transfer'] },
    { hash: h(4), timestamp: '2026-10-01T00:00:00.000000Z', status: 'ok', method: null, value: '0', from: { hash: me }, to: null, created_contract: { hash: '0x00000000000000000000000000000000000000Aa' }, transaction_types: ['contract_creation'] },
    { hash: 'not a hash', status: 'ok' },
    null,
  ],
}

test('explorer transactions become activity rows: status, direction, coin amount and a readable method', () => {
  const list = toActivity(10, me, page)
  assert.equal(list.length, 4)
  const [received, failed, waiting, deploy] = list
  assert.deepEqual(received, { chain: 10, hash: h(1), at: Date.parse('2026-10-19T07:46:29Z'), status: 'ok', method: 'Contract call', out: false, amount: 0.00001, from: '0x9f10063326b86cae32a3ff2d3072537576c0e24f', to: me.toLowerCase() })
  assert.equal(failed.status, 'failed')
  assert.equal(failed.method, 'swap')
  assert.equal(failed.out, true)
  // an undecoded selector isn't a name; a waiting one has no time yet
  assert.equal(waiting.method, 'Transfer')
  assert.equal(waiting.status, 'pending')
  assert.equal(waiting.at, 0)
  assert.equal(waiting.amount, 1.5)
  assert.equal(deploy.method, 'Deploy')
  assert.equal(deploy.to, '0x00000000000000000000000000000000000000aa')
  // fields of the wrong shape are read as missing, never thrown on
  const odd = toActivity(10, me, { items: [{ hash: h(5), status: 'ok', method: 7, transaction_types: 5, from: 'x', to: { hash: 42 }, value: 'lots' }] })
  assert.deepEqual(odd, [{ chain: 10, hash: h(5), at: 0, status: 'ok', method: 'Transfer', out: false, amount: 0, from: '', to: '' }])
  // dropped or replaced: no status, a final result, so it isn't left spinning (or pinned on top)
  const gone = toActivity(10, me, { items: [{ hash: h(6), timestamp: null, status: null, result: 'dropped/replaced', from: { hash: me } }, { hash: h(7), status: null, from: { hash: me } }] })
  assert.deepEqual(gone.map((a) => a.status), ['failed', 'pending'])
  assert.deepEqual(newest([...gone, received]).map((a) => a.hash), [h(7), h(1), h(6)])
  assert.deepEqual(toActivity(10, me, { items: 'nope' }), [])
  assert.deepEqual(toActivity(10, me, null), [])
})

test('activity lists waiting transactions first, then newest, and searches methods, addresses and hashes', () => {
  const list = newest(toActivity(10, me, page))
  assert.deepEqual(list.map((a) => a.hash), [h(3), h(2), h(1), h(4)])
  assert.deepEqual(list.filter((a) => matches(a, 'SWAP')).map((a) => a.hash), [h(2)])
  assert.deepEqual(list.filter((a) => matches(a, '0x9f1006')).map((a) => a.hash), [h(1)])
  assert.equal(list.filter((a) => matches(a, '  ')).length, 4)
  // and what the row shows, in the reader's language
  assert.deepEqual(list.filter((a) => matches(a, 'コントラクト', a.method === 'Contract call' ? 'コントラクト呼び出し' : a.method)).map((a) => a.hash), [h(1)])
})
