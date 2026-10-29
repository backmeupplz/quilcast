import assert from 'node:assert/strict'
import { test } from 'node:test'

// the timeout matters: without the fix the stale provider never answers and connect() waits forever
test('a stale window.ethereum that answers nothing loses to a wallet that announces itself', { timeout: 10000 }, async () => {
  const { privateKeyToAccount } = await import('viem/accounts')
  const { hex } = await import('./fc.ts')
  const acct = privateKeyToAccount(`0x${hex(new Uint8Array(32).fill(3))}`)
  // the wallet someone actually has, announcing itself over EIP-6963
  const live = {
    isMetaMask: true,
    request: async ({ method }: { method: string }) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [acct.address]
      if (method === 'eth_chainId') return '0xa'
      throw new Error(`unexpected ${method}`)
    },
  }
  // what two extensions racing for the global leave behind: it claims to be MetaMask and answers nothing at all
  const stale = { isMetaMask: true, request: () => new Promise(() => {}) }
  const heard: ((e: unknown) => void)[] = []
  ;(globalThis as any).window = {
    ethereum: stale,
    addEventListener: (type: string, f: (e: unknown) => void) => void (type === 'eip6963:announceProvider' && heard.push(f)),
    dispatchEvent: (e: { type: string }) => void (e.type === 'eip6963:requestProvider' && heard.forEach((f) => f({ detail: { info: { rdns: 'io.metamask' }, provider: live } }))),
  }
  const w = await import('./wallet.ts')
  assert.equal(await w.connect(), acct.address.toLowerCase())
})
