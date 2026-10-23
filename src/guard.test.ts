import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checksum, checkWallet, signInCheck, siwf } from './guard.ts'

const me = '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed'
const hexed = (s: string) => '0x' + Buffer.from(s).toString('hex')
const refused = (method: string, params: any[]) => assert.throws(() => checkWallet('app.example', me, method, params), { code: 4100 })

test('checksums like EIP-55', () => assert.equal(checksum(me), '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'))

test('wallet requests that are fine get through', () => {
  checkWallet('app.example', me, 'personal_sign', [hexed('hello'), me])
  checkWallet('app.example', me, 'personal_sign', [hexed('app.example wants you to sign in with your Ethereum account:\n…'), me])
  checkWallet('app.example', me, 'eth_signTypedData_v4', [me, JSON.stringify({ domain: { name: 'USD Coin', verifyingContract: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' } })])
  checkWallet('app.example', me, 'eth_sendTransaction', [{ from: me.toUpperCase().replace('0X', '0x'), to: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' }])
  checkWallet('app.example', me, 'wallet_sendCalls', [{ calls: [{ to: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' }] }])
})

test('wallet requests that could take over the Farcaster account or another site are refused', () => {
  refused('personal_sign', [hexed('hello'), '0x0000000000000000000000000000000000000001'])
  refused('personal_sign', [hexed('farcaster.xyz wants you to sign in with your Ethereum account:\n…'), me])
  refused('personal_sign', [hexed('https://client.warpcast.com wants you to sign in with your Ethereum account:\n…'), me])
  refused('personal_sign', [hexed('quilcast.com wants you to sign in with your Ethereum account:\n…'), me])
  refused('personal_sign', [hexed('app.example wants you to sign in with your Ethereum account:\n…\n- farcaster://fid/1'), me])
  refused('personal_sign', ['Direct cast authorization for Farcaster FID 1', me])
  refused('personal_sign', [hexed('{"method":"generateToken","params":{}}'), me])
  refused('eth_signTypedData_v4', [me, JSON.stringify({ domain: { name: 'Farcaster KeyGateway' } })])
  refused('eth_signTypedData_v4', [me, { domain: { name: 'x', verifyingContract: '0x00000000FC6C5F01FC30151999387BB99A9F489B' } }])
  refused('eth_signTypedData_v4', [me, 'not json'])
  refused('eth_sendTransaction', [{ to: '0x00000000fc6c5f01fc30151999387bb99a9f489b' }])
  refused('eth_sendTransaction', [{ from: '0x0000000000000000000000000000000000000001', to: '0x1111111111111111111111111111111111111111' }])
  refused('wallet_sendCalls', [{ calls: [{ to: '0x1111111111111111111111111111111111111111' }, { to: '0x00000000fc56947c7e7183f8ca4b62398caadf0b' }] }])
})

test('a sign-in for another site is handed back to ask the person, for Solana too', () => {
  assert.equal(checkWallet('app.example', me, 'personal_sign', [hexed('https://api.example wants you to sign in with your Ethereum account:\n…'), me]), 'api.example')
  assert.equal(checkWallet('app.example', me, 'personal_sign', [hexed('hello'), me]), undefined)
  assert.equal(signInCheck('app.example', 'other.example wants you to sign in with your Solana account:\nAbc'), 'other.example')
  assert.equal(signInCheck('app.example', 'app.example wants you to sign in with your Solana account:\nAbc'), undefined)
  assert.throws(() => signInCheck('app.example', 'farcaster.xyz wants you to sign in with your Solana account:\nAbc'), { code: 4100 })
})

test('Sign In With Farcaster takes nothing from the app it does not check', () => {
  const now = new Date('2026-10-21T00:00:00.000Z')
  const m = siwf({ origin: 'https://app.example', address: me, fid: 42, nonce: 'abcdefgh12', expirationTime: '2026-10-22T00:00:00Z', now })
  assert.equal(m, 'app.example wants you to sign in with your Ethereum account:\n0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed\n\nFarcaster Auth\n\nURI: https://app.example\nVersion: 1\nChain ID: 10\nNonce: abcdefgh12\nIssued At: 2026-10-21T00:00:00.000Z\nExpiration Time: 2026-10-22T00:00:00.000Z\nResources:\n- farcaster://fid/42')
  assert.throws(() => siwf({ origin: 'https://app.example', address: me, fid: 42, nonce: 'abcdefgh\nResources:\n- farcaster://fid/1' }))
  assert.throws(() => siwf({ origin: 'https://app.example', address: me, fid: 42, nonce: 'abcdefgh', notBefore: 'soon\nURI: https://evil' }))
})

test('token calls and typed data that hand tokens over are spelled out', async () => {
  const { encodeFunctionData, erc20Abi, erc721Abi, maxUint256 } = await import('viem')
  const { tokenCall, typedRisk, UNLIMITED } = await import('./guard.ts')
  const spender = '0x' + 'de'.repeat(20)
  const approve = tokenCall(encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender as `0x${string}`, maxUint256] }))
  assert.deepEqual(approve, { kind: 'approve', args: [spender, maxUint256] })
  assert.ok((approve!.args[1] as bigint) >= UNLIMITED)
  assert.deepEqual(tokenCall(encodeFunctionData({ abi: erc721Abi, functionName: 'setApprovalForAll', args: [spender as `0x${string}`, true] })), { kind: 'approveAll', args: [spender, true] })
  assert.deepEqual(tokenCall(encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [spender as `0x${string}`, 5n] })), { kind: 'transfer', args: [spender, 5n] })
  assert.deepEqual(tokenCall(encodeFunctionData({ abi: erc721Abi, functionName: 'safeTransferFrom', args: [me as `0x${string}`, spender as `0x${string}`, 7n, '0x1234'] })), { kind: 'move', args: [me, spender, 7n] })
  const permit2 = [{ type: 'function', name: 'approve', inputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint160' }, { type: 'uint48' }], outputs: [], stateMutability: 'nonpayable' }] as const
  assert.deepEqual(tokenCall(encodeFunctionData({ abi: permit2, functionName: 'approve', args: [me as `0x${string}`, spender as `0x${string}`, 2n ** 160n - 1n, 1900000000] })), { kind: 'approve2', args: [me, spender, 2n ** 160n - 1n, 1900000000n] })
  // anything else, or cut short, is left as bytes
  assert.equal(tokenCall('0xdeadbeef' + '00'.repeat(64)), undefined)
  assert.equal(tokenCall('0x095ea7b3' + '00'.repeat(40)), undefined)
  assert.equal(tokenCall(undefined), undefined)
  assert.deepEqual(typedRisk({ primaryType: 'Permit', domain: { name: 'USD Coin' }, message: { spender } }), { kind: 'permit', spender })
  assert.deepEqual(typedRisk({ primaryType: 'PermitSingle', domain: { name: 'Permit2' }, message: { spender } }), { kind: 'permit', spender })
  assert.deepEqual(typedRisk({ primaryType: 'OrderComponents', domain: { name: 'Seaport' } }), { kind: 'listing' })
  assert.equal(typedRisk({ primaryType: 'Mail', domain: { name: 'Ether Mail' } }), undefined)
})
