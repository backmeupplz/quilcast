import assert from 'node:assert/strict'
import { test } from 'node:test'

// a wallet account's message signatures (Quick Auth sign-in, farcaster.xyz logins) are checked against its address:
// another account's signature fails here with a clear error, a smart wallet's long one goes on when the chain says so
test('wallet message signatures: smart wallets pass, another account is caught, a refusal keeps its code', async () => {
  const { privateKeyToAccount } = await import('viem/accounts')
  const { hex, keyCustody } = await import('./fc.ts')
  const mine = privateKeyToAccount(`0x${'07'.repeat(32)}`)
  const other = privateKeyToAccount(`0x${'08'.repeat(32)}`)
  let answer: (raw: `0x${string}`) => Promise<string> = (raw) => mine.signMessage({ message: { raw } })
  ;(globalThis as any).window = {
    ethereum: {
      request: async ({ method, params }: { method: string; params: any[] }) => {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [mine.address]
        if (method === 'personal_sign') return answer(params[0])
        throw new Error(`unexpected ${method}`)
      },
    },
  }
  // the Optimism RPC: `onChain` is what ERC-6492's validator answers; undefined: the RPC is down, 429: rate-limited
  let onChain: boolean | undefined | 429
  let calls = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    calls++
    if (onChain === undefined) throw new TypeError('fetch failed')
    if (onChain === 429) return new Response('Too Many Requests', { status: 429 })
    const body = JSON.parse(init.body)
    assert.equal(body.method, 'eth_call')
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: onChain ? '0x01' : '0x00' }), { headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  try {
    const w = await import('./wallet.ts')
    const wallet = w.walletCustody(mine.address.toLowerCase(), 'http://rpc.test')
    const key = keyCustody(new Uint8Array(32).fill(7))
    const m = new TextEncoder().encode('example.com wants you to sign in with your Ethereum account')

    // the right account: checked locally, no RPC
    assert.equal(hex(await wallet.message(m)), hex(await key.message(m)))
    // v as 0/1 still comes out as 27/28
    answer = async (raw) => {
      const s = await mine.signMessage({ message: { raw } })
      return s.slice(0, -2) + (parseInt(s.slice(-2), 16) - 27).toString(16).padStart(2, '0')
    }
    assert.equal(hex(await wallet.message(m)), hex(await key.message(m)))
    assert.equal(calls, 0)

    // another account in the same wallet: the chain says no, and the error says what to do
    answer = (raw) => other.signMessage({ message: { raw } })
    onChain = false
    await assert.rejects(wallet.message(m), /signed with a different address than this account's/)
    // a smart wallet's 65-byte signature the chain accepts goes on
    onChain = true
    calls = 0
    assert.equal(hex(await wallet.message(m)), hex(await keyCustody(new Uint8Array(32).fill(8)).message(m)))
    assert.equal(calls, 1)

    // a smart wallet's ERC-1271/6492 signature is longer than 65 bytes; valid on chain, it goes on unchanged
    const long = '0x' + 'ab'.repeat(200)
    answer = async () => long
    onChain = true
    calls = 0
    assert.equal('0x' + hex(await wallet.message(m)), long)
    assert.ok(calls > 0)
    // a secret (the drafts key) is never sent to the RPC
    calls = 0
    assert.equal('0x' + hex(await wallet.message(m, { local: true })), long)
    assert.equal(calls, 0)
    // with the RPC down or rate-limited, it's left to the app that asked
    onChain = undefined
    assert.equal('0x' + hex(await wallet.message(m)), long)
    onChain = 429
    assert.equal('0x' + hex(await wallet.message(m)), long)
    // and an invalid one is refused, without blaming another address (it may be another chain's, or broken)
    onChain = false
    await assert.rejects(wallet.message(m), /didn't check out for this account/)

    // too short to be any signature
    answer = async () => '0x' + 'ab'.repeat(64)
    await assert.rejects(wallet.message(m), /unexpected signature/)

    // declining in the wallet keeps code 4001, so a mini app hears "rejected by user"
    answer = async () => {
      throw Object.assign(new Error('User rejected the request.'), { code: 4001 })
    }
    await assert.rejects(wallet.message(m), (e: any) => e.code === 4001 && !/Details:/.test(e.message))
  } finally {
    globalThis.fetch = realFetch
    delete (globalThis as any).window
  }
})

// a smart wallet signs for the chain it's on, and Quick Auth checks on Optimism: a sign-in (`chain: 10`) moves the
// wallet there first. Other signatures (the drafts key above all, which must never change) are signed where it is
test('wallet message signatures: a sign-in switches to Optimism first, declining the switch is declining', async () => {
  const { privateKeyToAccount } = await import('viem/accounts')
  const mine = privateKeyToAccount(`0x${'07'.repeat(32)}`)
  let chain = 8453
  let log: string[] = []
  let switching: () => unknown = () => {}
  let answer: (raw: `0x${string}`) => Promise<string> = (raw) => mine.signMessage({ message: { raw } })
  ;(globalThis as any).window = {
    ethereum: {
      request: async ({ method, params }: { method: string; params: any[] }) => {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [mine.address]
        if (method === 'eth_chainId') return '0x' + chain.toString(16)
        if (method === 'wallet_switchEthereumChain') {
          log.push(`switch ${parseInt(params[0].chainId, 16)}`)
          switching()
          chain = parseInt(params[0].chainId, 16)
          return null
        }
        if (method === 'personal_sign') {
          log.push(`sign on ${chain}`)
          return answer(params[0])
        }
        throw new Error(`unexpected ${method}`)
      },
    },
  }
  const realFetch = globalThis.fetch
  let onChain = '0x01'
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body)
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: onChain }), { headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  try {
    const w = await import('./wallet.ts')
    const wallet = w.walletCustody(mine.address.toLowerCase(), 'http://rpc.test')
    const m = new TextEncoder().encode('example.com wants you to sign in with your Ethereum account')

    // without a chain (the drafts key, tokens) nothing switches
    await wallet.message(m)
    await wallet.message(m, { local: true })
    assert.deepEqual(log, ['sign on 8453', 'sign on 8453'])

    // a sign-in: switched to Optimism, then signed there
    log = []
    await wallet.message(m, { chain: 10 })
    assert.deepEqual(log, ['switch 10', 'sign on 10'])
    // already there: just signed
    log = []
    await wallet.message(m, { chain: 10 })
    assert.deepEqual(log, ['sign on 10'])

    // declining the switch is declining the sign-in, and nothing is signed
    chain = 8453
    log = []
    switching = () => {
      throw Object.assign(new Error('User rejected the request.'), { code: 4001 })
    }
    await assert.rejects(wallet.message(m, { chain: 10 }), (e: any) => e.code === 4001)
    assert.deepEqual(log, ['switch 10'])

    // a wallet that can't switch signs where it is
    log = []
    switching = () => {
      throw Object.assign(new Error('Method not supported.'), { code: 4200 })
    }
    await wallet.message(m, { chain: 10 })
    assert.deepEqual(log, ['switch 10', 'sign on 8453'])

    // a smart wallet's long signature the chain says no to: not blamed on another address, which it may well not be
    answer = async () => '0x' + 'ab'.repeat(200)
    onChain = '0x00'
    await assert.rejects(wallet.message(m), (e: any) => e.message === "Your wallet's signature didn't check out for this account.")
    // a 65-byte one that isn't this address's own key goes to the chain as it came (v = 0/1 left alone)
    let sent = ''
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body)
      sent = body.params[0].data
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x01' }), { headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const contract = '0x' + 'cd'.repeat(64) + '01'
    answer = async () => contract
    assert.equal('0x' + (await import('./fc.ts')).hex(await wallet.message(m)), contract)
    assert.ok(sent.endsWith(contract.slice(2) + '00'.repeat(31)))
  } finally {
    globalThis.fetch = realFetch
    delete (globalThis as any).window
  }
})
