import assert from 'node:assert/strict'
import { test } from 'node:test'

// a mini app's Quick Auth sign-in after the person said yes (miniapp.tsx signIn): the custody signature is asked for
// on Optimism, Cancel and a wallet's "no" both answer rejected_by_user, anything else is shown before it's thrown,
// and the Cancel button goes away with its own sign-in only
test('mini app sign-in: chain 10, Cancel, declining, failures, and whose Cancel it is', async () => {
  const { signSiwf } = await import('./signin.ts')
  type Call = { o: any; done: (s: Uint8Array) => void; fail: (e: unknown) => void }
  let calls: Call[] = []
  const custody = {
    address: '0x' + '11'.repeat(20),
    typed: async () => new Uint8Array(65),
    message: (_m: Uint8Array, o?: any) => new Promise<Uint8Array>((done, fail) => calls.push({ o, done, fail })),
  }
  let toasts: string[] = []
  let updates = 0
  const host = { wait: <T>(f: () => Promise<T>) => f(), toast: (m: string) => void toasts.push(m), update: () => void updates++ }
  const app: { stop?: () => void } = {}
  const tick = () => new Promise((r) => setTimeout(r, 0))

  // signed: the signature goes to the app, asked for on chain 10
  let p = signSiwf(app, custody, 'hello', host)
  await tick()
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].o, { chain: 10 })
  assert.equal(typeof app.stop, 'function')
  calls[0].done(new Uint8Array([1, 2, 255]))
  assert.deepEqual(await p, { result: { message: 'hello', signature: '0x0102ff', authMethod: 'custody' } })
  assert.equal(app.stop, undefined)
  assert.ok(updates > 0)

  // Cancel while the wallet never answers
  calls = []
  p = signSiwf(app, custody, 'hello', host)
  await tick()
  app.stop!()
  assert.deepEqual(await p, { error: { type: 'rejected_by_user' } })
  assert.equal(app.stop, undefined)
  // the wallet failing after Cancel stays unseen
  calls[0].fail(new Error('late'))
  await tick()
  assert.deepEqual(toasts, [])

  // declined in the wallet
  calls = []
  p = signSiwf(app, custody, 'hello', host)
  await tick()
  calls[0].fail(Object.assign(new Error('User rejected the request.'), { code: 4001 }))
  assert.deepEqual(await p, { error: { type: 'rejected_by_user' } })
  assert.deepEqual(toasts, [])
  assert.equal(app.stop, undefined)

  // anything else: shown, then thrown to the app
  calls = []
  p = signSiwf(app, custody, 'hello', host)
  await tick()
  calls[0].fail(new Error("Your wallet's signature didn't check out for this account."))
  await assert.rejects(p, /didn't check out/)
  assert.deepEqual(toasts, ["Your wallet's signature didn't check out for this account."])
  assert.equal(app.stop, undefined)

  // an older sign-in finishing leaves a newer one's Cancel up
  calls = []
  toasts = []
  const first = signSiwf(app, custody, 'one', host)
  await tick()
  const second = signSiwf(app, custody, 'two', host)
  await tick()
  const newer = app.stop
  calls[0].done(new Uint8Array([1]))
  assert.equal((await first as any).result.message, 'one')
  assert.equal(app.stop, newer)
  app.stop!()
  assert.deepEqual(await second, { error: { type: 'rejected_by_user' } })
  assert.equal(app.stop, undefined)
})
