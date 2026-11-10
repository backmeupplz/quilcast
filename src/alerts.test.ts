// Push notifications for the account's own activity, the browser side (api.ts forgetAlerts, write.ts saveAlerts):
// a sign-out that doesn't reach the server is sent again, and a background sign-up never adds a key.
import assert from 'node:assert/strict'
import { test } from 'node:test'

const store = new Map<string, string>()
Object.assign(globalThis, { addEventListener: () => {}, dispatchEvent: () => true })
;(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) }
const api = await import('./api.ts')
const { saveAlerts } = await import('./write.ts')

const calls: { url: string; o: any }[] = []
let up = false
;(globalThis as any).fetch = async (url: string, o: any = {}) => {
  calls.push({ url, o })
  if (!up) throw new TypeError('offline')
  return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
}

test('a sign-out stays on the list until the server takes it', async () => {
  api.save(api.ALERTS, { on: { 7: { endpoint: 'https://push.example/a', kinds: ['replies'] }, 8: { endpoint: 'https://push.example/a', kinds: ['likes'] } }, off: [] })
  await api.forgetAlerts(7)
  assert.deepEqual(Object.keys(api.alertsKept().on), ['8'])
  assert.deepEqual(api.alertsKept().off, [[7, 'https://push.example/a']], 'offline: still waiting')
  assert.equal(calls.at(-1)!.url, '/api/alerts/7/off')
  assert.equal(calls.at(-1)!.o.keepalive, true, 'survives the page leaving')
  assert.deepEqual(JSON.parse(calls.at(-1)!.o.body), { endpoint: 'https://push.example/a' })
  // the next start sends it again
  up = true
  await api.flushAlertsOff()
  assert.deepEqual(api.alertsKept().off, [])
  // nothing on for this account: nothing to send
  const n = calls.length
  await api.forgetAlerts(7)
  assert.equal(calls.length, n)
})

test('a background sign-up without a working key gives up before signing or sending anything', async () => {
  const n = calls.length
  // a key from an older scope (or none) would need a new one: a wallet prompt, or a key added unasked
  for (const a of [{ custody: '0x7', fid: 7, done: true }, { custody: '0x7', fid: 7, done: true, signer: '03'.repeat(32), scopes: 1 }]) {
    await assert.rejects(saveAlerts(a as any, '{}', true), /no key in this browser/)
  }
  assert.equal(calls.length, n, 'no request at all: no KEY_ADD, no sign-up')
})
