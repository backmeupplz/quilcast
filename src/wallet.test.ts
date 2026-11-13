import assert from 'node:assert/strict'
import { test } from 'node:test'

test('a wallet signs exactly what the phrase key would, switching to the chain each signature is for', async () => {
  const { privateKeyToAccount } = await import('viem/accounts')
  const { fnameProof, hex, keyAdd, keyCustody, rawEd } = await import('./fc.ts')
  const priv = new Uint8Array(32).fill(7)
  const acct = privateKeyToAccount(`0x${hex(priv)}`)
  // a stand-in EIP-1193 wallet that, like MetaMask, refuses typed data for a chain other than the one it's on
  let chain = 10
  let sent: any
  const asked: string[] = []
  ;(globalThis as any).window = {
    ethereum: {
      request: async ({ method, params }: { method: string; params: any[] }) => {
        asked.push(method)
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [acct.address]
        if (method === 'eth_chainId') return `0x${chain.toString(16)}`
        if (method === 'wallet_switchEthereumChain') return void (chain = parseInt(params[0].chainId, 16))
        if (method === 'eth_signTypedData_v4') {
          const t = JSON.parse(params[1])
          if (Number(t.domain.chainId) !== chain) throw new Error('wrong chain')
          return acct.signTypedData(t)
        }
        if (method === 'personal_sign') return acct.signMessage({ message: { raw: params[0] } })
        if (method === 'eth_sendTransaction') return (sent = { ...params[0], chain }), '0x' + 'ab'.repeat(32)
        throw new Error(`unexpected ${method}`)
      },
    },
  }
  const w = await import('./wallet.ts')
  const key = keyCustody(priv)
  const address = await w.connect()
  assert.equal(address, key.address)
  const wallet = w.walletCustody(address)
  const now = Date.now
  Date.now = () => 1792500000000
  try {
    const signer = rawEd(new Uint8Array(32).fill(9))
    assert.equal(hex((await keyAdd(3, wallet, signer, 5)).msg), hex((await keyAdd(3, key, signer, 5)).msg))
    assert.deepEqual(await fnameProof('alice', 1792500000, wallet), await fnameProof('alice', 1792500000, key))
    const login = new TextEncoder().encode('{"method":"generateToken","params":{"expiresAt":2,"timestamp":1}}')
    assert.equal(hex(await wallet.message(login)), hex(await key.message(login)))
    // Hypersnap's free registration (native.ts) is signed for chain 10, the same bytes the phrase key signs
    const store = new Map<string, string>()
    ;(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) }
    Object.assign(globalThis, { addEventListener: () => {}, dispatchEvent: () => true })
    const { commitment, onboardTyped } = await import('./native.ts')
    const { nonceBytes } = await import('./pow.ts')
    const typed = onboardTyped(address, 50485360, '0x' + '11'.repeat(32), commitment(nonceBytes(0, 1), 22))
    chain = 1
    assert.equal(hex(await wallet.typed(typed)), hex(await key.typed(typed)))
    assert.equal(chain, 10)
  } finally {
    Date.now = now
  }
  assert.ok(asked.includes('wallet_switchEthereumChain'))
  // a transaction (the mini app key) goes out on Optimism
  await w.sendTx(address, '0x' + '22'.repeat(20), '0x1234', 123n)
  assert.equal(sent.chain, 10)
  assert.equal(sent.to.toLowerCase(), '0x' + '22'.repeat(20))
  assert.equal(sent.data, '0x1234')
  assert.equal(BigInt(sent.value), 123n)
})
