import assert from 'node:assert/strict'
import { test } from 'node:test'

// api.ts and write.ts expect a browser; this is just enough of one
;(globalThis as any).addEventListener = () => {}
import { rlp } from './eth.ts'
import { hex, mentions, pb } from './fc.ts'

const b = (s: string) => new TextEncoder().encode(s)

test('rlp matches the spec vectors', () => {
  assert.equal(hex(rlp(b('dog'))), '83646f67')
  assert.equal(hex(rlp([b('cat'), b('dog')])), 'c88363617483646f67')
  assert.equal(hex(rlp(new Uint8Array())), '80')
  assert.equal(hex(rlp(Uint8Array.of(0x0f))), '0f')
  assert.equal(hex(rlp([])), 'c0')
  assert.equal(hex(rlp(b('Lorem ipsum dolor sit amet, consectetur adipisicing elit'))).slice(0, 4), 'b838')
})

test('pb writes varints, strings and packed arrays', () => {
  assert.equal(hex(pb([1, 150])), '089601')
  assert.equal(hex(pb([2, 'hi'], [3, ''], [4, undefined])), '12026869')
  assert.equal(hex(pb([9, [1, 300]])), '4a03 01ac02'.replace(' ', ''))
})

test('mentions strip names and record utf-8 byte offsets', async () => {
  const fids: Record<string, number> = { alice: 1, 'bob.eth': 2 }
  const m = await mentions('héllo @alice and @bob.eth, not @nobody', async (n) => fids[n])
  assert.equal(m.text, 'héllo  and , not @nobody')
  assert.deepEqual(m.mentions, [1, 2])
  assert.deepEqual(m.positions, [7, 12])
})

test('castText puts mentions back at their byte offsets, and ignores ones past the end', async () => {
  const { castText, sized } = await import('./shared.ts')
  const c = { text: 'hé  and ', mentioned_profiles: [{ fid: 1, username: 'a' }, { fid: 2, username: 'b.eth' }], mentioned_profiles_ranges: [{ start: 4, end: 4 }, { start: 9, end: 9 }] } as any
  assert.equal(castText(c), 'hé @a and @b.eth')
  assert.equal(castText({ ...c, mentioned_profiles_ranges: [{ start: 99, end: 99 }] }), 'hé  and ')
  assert.equal(sized('https://imagedelivery.net/abc/0f-1/original', 'w=96'), 'https://imagedelivery.net/abc/0f-1/w=96')
  assert.equal(sized('https://example.com/a/original', 'w=96'), 'https://example.com/a/original')
})

test('LINK_RE finds links people type, with or without a scheme', async () => {
  ;(globalThis as any).localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
  const { LINK_RE } = await import('./api.ts')
  const m = (s: string) => s.match(LINK_RE) || []
  assert.deepEqual(m('yeah, quilcast.com, getting the launch video ready'), ['quilcast.com'])
  assert.deepEqual(m('see https://a.b/c?d=1.'), ['https://a.b/c?d=1'])
  assert.deepEqual(m('try x.com/foo/bar. ok'), ['x.com/foo/bar'])
  assert.deepEqual(m('@bob.eth and mail me at a@b.com, e.g. node.js'), [])
  assert.deepEqual(m('docs.github.io and sub.quilcast.com'), ['docs.github.io', 'sub.quilcast.com'])
})

test('custody key from WebCrypto PBKDF2 matches the BIP-39 reference derivation', async () => {
  ;(globalThis as any).localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
  const { custodyKey } = await import('./fc.ts')
  const { mnemonicToSeedSync } = await import('@scure/bip39')
  const { HDKey } = await import('@scure/bip32')
  for (const phrase of ['legal winner thank year wave sausage worth useful legal winner thank yellow', 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about']) {
    const ref = HDKey.fromMasterSeed(mnemonicToSeedSync(phrase)).derive("m/44'/60'/0'/0/0").privateKey!
    assert.equal(hex(await custodyKey(`  ${phrase.toUpperCase().replace(/ /g, '   ')} `)), hex(ref))
  }
})

test('video metadata boxes become free boxes without moving any bytes', async () => {
  ;(globalThis as any).localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
  const { stripVideoMeta } = await import('./write.ts')
  const box = (type: string, ...kids: Uint8Array[]) => {
    const body = kids.length ? Uint8Array.from(kids.flatMap((k) => [...k])) : new TextEncoder().encode(type === '©xyz' ? '+37.7749-122.4194/' : 'data')
    const out = new Uint8Array(8 + body.length)
    new DataView(out.buffer).setUint32(0, out.length)
    out.set(new TextEncoder().encode(type), 4)
    out.set(body, 8)
    return out
  }
  const file = Uint8Array.from([...box('ftyp'), ...box('moov', box('mvhd'), box('udta', box('©xyz')), box('trak', box('tkhd'), box('udta')), box('meta')), ...box('mdat')])
  const out = new Uint8Array(await (await stripVideoMeta(new Blob([file], { type: 'video/mp4' }))).arrayBuffer())
  const text = new TextDecoder('latin1').decode(out)
  assert.equal(out.length, file.length)
  assert.ok(!text.includes('udta') && !text.includes('meta') && !text.includes('+37.7749'))
  assert.ok(text.includes('ftyp') && text.includes('moov') && text.includes('mvhd') && text.includes('tkhd') && text.includes('mdat'))
})

test('safeUrl lets only public http(s) URLs through', async () => {
  ;(globalThis as any).localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
  const { safeUrl } = await import('./api.ts')
  for (const bad of ['javascript:alert(document.cookie)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:x', 'file:///etc/passwd', 'blob:https://x.com/1', 'http://localhost:3000/', 'http://127.0.0.1/', 'http://192.168.1.1/reboot', 'http://10.0.0.1/', 'http://169.254.169.254/', 'http://[::1]/', 'http://router.local/', 'https://user:pw@example.com/', '//evil.com', '', undefined, null, 42 as any])
    assert.equal(safeUrl(bad), undefined, String(bad))
  assert.equal(safeUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1')
  assert.equal(safeUrl('http://imagedelivery.net/x/original'), 'http://imagedelivery.net/x/original')
})

test('KEY_ADD and fname proofs keep their exact bytes, and what a wallet signs hashes like viem', async () => {
  const { fnameProof, hashTyped, hex, keyAdd, keyCustody, rawEd } = await import('./fc.ts')
  const { hashTypedData } = await import('viem')
  const now = Date.now
  Date.now = () => 1792500000000
  try {
    const key = keyCustody(new Uint8Array(32).fill(7))
    const seen: any[] = []
    const custody = { ...key, typed: (t: any) => (seen.push(t), key.typed(t)) }
    // vectors from the hand-rolled encoder this replaced, which the network accepts
    assert.equal(hex((await keyAdd(3, custody, rawEd(new Uint8Array(32).fill(9)), 5)).msg), '0ab0030810100318a0f6a35720019a01a1030a20fd1724385aa0c75b64fb78cd602fa1d991fdebf76b13c58ed702eac835e9f61810011a4111fd5ca88c1399f1e506b88a2cfdafaa9ba79d32fc2887f124e67b4d43a5e2507f1730bbf84ae7fa7923f1bfac2f0af42aad543591e06dda3850c8f132d2df131c20b092a457280532a002000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000030000000000000000000000004a62316623ad457f02cdc5d997ded67a383ec5690000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000ae909300000000000000000000000000000000000000000000000000000000000000041cca42f0c76b794c1f7c9422ac1f0136cfc8c952be3b53fa5b011b875d37917ce0b870916541c15375313a335562ba728d843b93d85003f97dccbc734b818d0b11c0000000000000000000000000000000000000000000000000000000000000038014a070102030405060b5080ceda031214bb578255e454aef4345367dd8811b110ec6224b918012240ecd7e6e63807f137149aab2a5050a4d17b5a975a407899fbaf67dc7fe8f568579908007666b3cbba5c6cd4a13dd81e2731a847ce27a1c5373b432c522ffed40c28013220fd1724385aa0c75b64fb78cd602fa1d991fdebf76b13c58ed702eac835e9f6183ab0030810100318a0f6a35720019a01a1030a20fd1724385aa0c75b64fb78cd602fa1d991fdebf76b13c58ed702eac835e9f61810011a4111fd5ca88c1399f1e506b88a2cfdafaa9ba79d32fc2887f124e67b4d43a5e2507f1730bbf84ae7fa7923f1bfac2f0af42aad543591e06dda3850c8f132d2df131c20b092a457280532a002000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000030000000000000000000000004a62316623ad457f02cdc5d997ded67a383ec5690000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000ae909300000000000000000000000000000000000000000000000000000000000000041cca42f0c76b794c1f7c9422ac1f0136cfc8c952be3b53fa5b011b875d37917ce0b870916541c15375313a335562ba728d843b93d85003f97dccbc734b818d0b11c0000000000000000000000000000000000000000000000000000000000000038014a070102030405060b5080ceda03')
    assert.deepEqual(await fnameProof('alice', 1792500000, custody), {'owner': '0x4a62316623ad457f02cdc5d997ded67a383ec569', 'signature': '0xb66f2a6f8615b542bd08ead67c13878bcdec5722c0db46905fa56bda8442bd5b3aa421c4cd3d80ec68fadc8a432be9dccb3cf9092d037935e34ab16a34641bb41b'})
    assert.equal(seen.length, 3)
    for (const t of seen) assert.equal('0x' + hex(hashTyped(t)), hashTypedData(t), t.primaryType)
  } finally {
    Date.now = now
  }
})

test('on-chain key calldata matches viem, with a SignedKeyRequest the validator would accept', async () => {
  const { encodeAbiParameters, encodeFunctionData, recoverTypedDataAddress } = await import('viem')
  const { base58, keyCustody, keyGatewayAdd, keyRegistryRemove } = await import('./fc.ts')
  const custody = keyCustody(new Uint8Array(32).fill(9))
  const key = new Uint8Array(32).fill(5)
  const data = await keyGatewayAdd(42, custody, key, 1800000000)
  // pull the signature back out of the encoded metadata and check who signed what
  const sig = ('0x' + data.slice(2 + 8 + 64 * 13, 2 + 8 + 64 * 13 + 130)) as `0x${string}`
  const signer = await recoverTypedDataAddress({
    domain: { name: 'Farcaster SignedKeyRequestValidator', version: '1', chainId: 10, verifyingContract: '0x00000000fc700472606ed4fa22623acf62c60553' },
    types: { SignedKeyRequest: [{ name: 'requestFid', type: 'uint256' }, { name: 'key', type: 'bytes' }, { name: 'deadline', type: 'uint256' }] },
    primaryType: 'SignedKeyRequest', message: { requestFid: 42n, key: `0x${'05'.repeat(32)}`, deadline: 1800000000n }, signature: sig,
  })
  assert.equal(signer.toLowerCase(), custody.address)
  const metadata = encodeAbiParameters([{ type: 'tuple', components: [{ name: 'requestFid', type: 'uint256' }, { name: 'requestSigner', type: 'address' }, { name: 'signature', type: 'bytes' }, { name: 'deadline', type: 'uint256' }] }],
    [{ requestFid: 42n, requestSigner: custody.address as `0x${string}`, signature: sig, deadline: 1800000000n }])
  const abi = [{ type: 'function', name: 'add', inputs: [{ type: 'uint32' }, { type: 'bytes' }, { type: 'uint8' }, { type: 'bytes' }], outputs: [], stateMutability: 'nonpayable' }, { type: 'function', name: 'remove', inputs: [{ type: 'bytes' }], outputs: [], stateMutability: 'nonpayable' }] as const
  assert.equal(data, encodeFunctionData({ abi, functionName: 'add', args: [1, `0x${'05'.repeat(32)}`, 1, metadata] }))
  assert.equal(keyRegistryRemove(key), encodeFunctionData({ abi, functionName: 'remove', args: [`0x${'05'.repeat(32)}`] }))
  assert.equal(base58(new TextEncoder().encode('hello world')), 'StV1DL6CwTryKyV')
  assert.equal(base58(Uint8Array.of(0, 0, 1)), '112')
})
