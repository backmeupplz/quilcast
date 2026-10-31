import assert from 'node:assert/strict'
import { test } from 'node:test'

test('a WalletConnect session answers the chain viem switched to, and only to approved chains', async () => {
  ;(globalThis as any).window = {}
  const { bridge } = await import('./wallet.ts')
  const sent: [string, string][] = []
  const session = { namespaces: { eip155: { accounts: ['eip155:10:0xabc', 'eip155:1:0xabc'] } } }
  const p = bridge({ session, request: async ({ method }: { method: string }, chain: string) => (sent.push([method, chain]), '0xsig') })
  assert.equal(await p.request({ method: 'eth_chainId' } as any), '0xa')
  await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] } as any)
  assert.equal(await p.request({ method: 'eth_chainId' } as any), '0x1')
  assert.equal(await p.request({ method: 'eth_signTypedData_v4', params: [] } as any), '0xsig')
  // Base was never approved: the request stays on mainnet rather than going to a chain the session can't reach
  await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x2105' }] } as any)
  await p.request({ method: 'personal_sign', params: [] } as any)
  assert.deepEqual(sent, [['eth_signTypedData_v4', 'eip155:1'], ['personal_sign', 'eip155:1']])
})
