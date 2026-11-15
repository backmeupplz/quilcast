// Prints the byte vectors wasm/src/fc.rs tests against, made by the TypeScript app's own encoders (src/fc.ts):
// node wasm/vectors.mjs. The clock is fixed, and ed25519 and RFC 6979 ECDSA are deterministic, so the output is too.
Date.now = () => 1763200000000
const fc = await import('../src/fc.ts')
const seed = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
const signer = fc.rawEd(seed)
const phrase = 'test test test test test test test test test test test junk'
const custody = fc.keyCustody(await fc.custodyKey(phrase))
const parent = { fid: 3, hash: '6ba6089bb1d3304b82fa17dbb34aa7c691713b0f' }
const out = {
  signer_pub: fc.hex(signer.pub),
  cast: fc.hex(fc.castBody({ text: 'gm  and héllo', mentions: [3], positions: [3], embeds: ['https://quilcast.com', parent], parent })),
  cast_channel: fc.hex(fc.castBody({ text: 'x'.repeat(321), parent: 'https://farcaster.xyz/~/channel/wasm' })),
  like: fc.hex(fc.reactionBody(1, 3, parent.hash)),
  follow: fc.hex(fc.followBody(3)),
  remove: fc.hex(fc.castRemoveBody(parent.hash)),
  user_data: fc.hex(fc.userDataBody(fc.MT.USER_DATA_ADD && 2, 'Quil')),
  envelope: fc.hex((await fc.envelope(fc.MT.CAST_ADD, 12345, fc.castBody({ text: 'hello wasm' }), signer)).msg),
  key_add: fc.hex((await fc.keyAdd(12345, custody, signer, 1763200000)).msg),
  key_remove: fc.hex((await fc.keyRemoveSelf(12345, signer, 1763200001)).msg),
}
console.log(JSON.stringify(out, null, 1))
