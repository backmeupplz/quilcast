import assert from 'node:assert/strict'
import { test } from 'node:test'

test('a WalletConnect session answers the chain viem switched to, and only approved chains', async () => {
  ;(globalThis as any).window = {}
  const { bridge } = await import('./wallet.ts')
  const sent: [string, string][] = []
  const up = {
    session: { namespaces: { eip155: { accounts: ['eip155:10:0xabc', 'eip155:1:0xabc'] } } },
    request: async ({ method }: { method: string }, chain: string) => (sent.push([method, chain]), '0xsig'),
  }
  const p = bridge(up)
  assert.equal(await p.request({ method: 'eth_chainId' } as any), '0xa')
  await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] } as any)
  // the same session gets the same bridge, so the switch holds for whoever asks next
  assert.equal(bridge(up), p)
  assert.equal(await p.request({ method: 'eth_chainId' } as any), '0x1')
  assert.equal(await p.request({ method: 'eth_signTypedData_v4', params: [] } as any), '0xsig')
  // Base was never approved: the switch fails, so nothing meant for Base can land on mainnet
  await assert.rejects(p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x2105' }] } as any), { code: 4901 })
  await p.request({ method: 'personal_sign', params: [] } as any)
  assert.deepEqual(sent, [['eth_signTypedData_v4', 'eip155:1'], ['personal_sign', 'eip155:1']])
})
