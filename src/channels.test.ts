import assert from 'node:assert/strict'
import test from 'node:test'
import { channelFeed, pack, unpack } from './channels.ts'

// a node with haatz's bugs: each page is every shard's next `limit` casts one after another, and a shard whose cursor
// is null starts over from its newest
const EPOCH = 1609459200
const url = 'https://warpcast.com/~/channel/higher'
const head = [31, ...new TextEncoder().encode(url)]
const tsAt = (k: number[]) => ((k[head.length] << 24) >>> 0) + (k[head.length + 1] << 16) + (k[head.length + 2] << 8) + k[head.length + 3]
const at = (ts: number) => [...head, (ts >>> 24) & 255, (ts >>> 16) & 255, (ts >>> 8) & 255, ts & 255, ...Array(24).fill(0)]
const cast = (shard: number, ts: number) => ({ hash: `${shard}:${ts}`, timestamp: new Date((ts + EPOCH) * 1000).toISOString() }) as any
// shard 0 is busy, shard 1 posts rarely and runs out first
const shards = [Array.from({ length: 30 }, (_, i) => cast(0, 1e8 - i * 10)), Array.from({ length: 4 }, (_, i) => cast(1, 1e8 - i * 100))]
const node = async (cursor?: string) => {
  const keys = unpack(cursor)
  const out: any[] = []
  const next = shards.map((list, i) => {
    const from = keys[i] ? tsAt(keys[i]!) : Infinity
    const page = list.filter((c) => Date.parse(c.timestamp) / 1000 - EPOCH < from).slice(0, 5)
    out.push(...page)
    return page.length === 5 ? at(Date.parse(page[4].timestamp) / 1000 - EPOCH) : null
  })
  return { casts: out, next: { cursor: next.some(Boolean) ? pack(next) : null } }
}

test('a channel feed comes out newest first, each cast once, to the end', async () => {
  const load = channelFeed(url, node)
  const all: any[] = []
  let cursor: string | undefined
  for (let i = 0; i < 20; i++) {
    const p = await load(cursor)
    all.push(...p.casts)
    if (!(cursor = p.next.cursor || undefined)) break
  }
  assert.equal(cursor, undefined)
  assert.equal(all.length, 34)
  assert.equal(new Set(all.map((c) => c.hash)).size, 34)
  assert.deepEqual(all.map((c) => c.timestamp), [...all.map((c) => c.timestamp)].sort().reverse())
})

test('a node that ignores the made-up cursor is asked without one', async () => {
  const calls: (string | undefined)[] = []
  const load = channelFeed(url, async (cursor) => (calls.push(cursor), cursor && !calls.includes(undefined) ? { casts: [] } : node()))
  const p = await load()
  assert.equal(calls.length, 2)
  assert.equal(calls[1], undefined)
  assert.ok(p.casts.length)
})
