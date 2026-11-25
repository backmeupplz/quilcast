import assert from 'node:assert/strict'
import { test } from 'node:test'
import { outage } from './outage.ts'

const haatz = 'https://haatz.quilibrium.com'
const snap = (status: string, nodes: { url?: string | null; state?: string }[]) => ({ networks: { hypersnap: { status, nodes } } })

test('the node in use being offline is an outage, even with the network fine', () => {
  assert.equal(outage(snap('operational', [{ url: haatz, state: 'offline' }, { url: 'https://x.example', state: 'synced' }]), haatz), 'node')
  assert.equal(outage(snap('operational', [{ url: haatz, state: 'offline' }]), haatz + '/'), 'node')
})

test('a node listed twice is down only when every entry is offline', () => {
  assert.equal(outage(snap('operational', [{ url: haatz, state: 'offline' }, { url: haatz, state: 'synced' }]), haatz), null)
})

test('the network in trouble is an outage; an unknown node goes by the network', () => {
  assert.equal(outage(snap('partial', [{ url: haatz, state: 'synced' }]), haatz), 'network')
  assert.equal(outage(snap('operational', [{ url: haatz, state: 'offline' }]), 'https://mine.example'), null)
  assert.equal(outage(snap('major', []), 'https://mine.example'), 'network')
})

test('no snapshot, no outage', () => {
  assert.equal(outage(null, haatz), null)
  assert.equal(outage({}, haatz), null)
})
