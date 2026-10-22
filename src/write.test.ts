import assert from 'node:assert/strict'
import { test } from 'node:test'

test('saving a look with a key the node dropped adds a new key and saves with it', async () => {
  const store = new Map<string, string>()
  Object.assign(globalThis, { addEventListener: () => {}, dispatchEvent: () => true })
  ;(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) }
  const { ed25519 } = await import('@noble/curves/ed25519.js')
  const { hex } = await import('./fc.ts')
  const api = await import('./api.ts')
  const { saveLook } = await import('./write.ts')
  const old = hex(new Uint8Array(32).fill(1))
  api.setAccount({ phrase: 'test test test test test test test test test test test junk', fid: 7, signer: old, signerAt: Math.floor(Date.now() / 1000), scopes: 2, done: true })
  // the node doesn't list the old key, only one added through submitMessage; our server answers 403 for a key it doesn't list
  const oldKey = '0x' + hex(ed25519.getPublicKey(Uint8Array.from(Buffer.from(old, 'hex'))))
  let submits = 0
  const known = (key: string | null) => submits > 0 && key !== oldKey
  ;(globalThis as any).fetch = async (url: string, o: any = {}) => {
    const u = new URL(url, 'https://quilcast.test')
    const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
    if (u.pathname === '/v1/submitMessage') {
      submits++
      return res(200, {})
    }
    if (u.pathname === '/v1/signer') return known(u.searchParams.get('signer')) ? res(200, {}) : res(400, {})
    if (u.pathname === '/api/look/7') return known(o.headers['x-key']) ? res(200, { ok: true }) : res(403, { error: "That key doesn't belong to this account." })
    throw new Error(`unexpected ${url}`)
  }
  assert.deepEqual(await saveLook({ bg: '#000' }), { ok: true })
  assert.equal(submits, 1)
  assert.notEqual(api.account!.signer, old)
})
