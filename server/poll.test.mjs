import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { writeFile } from 'node:fs/promises'
import { addPoll, contractSigned, getPoll, loadPolls, parseSiwf, pollCard, tally, vote } from './poll.mjs'

const data = await mkdtemp(join(tmpdir(), 'qc-poll-'))
await loadPolls(data)
const HOST = 'poll.quilcast.com'
const custody = privateKeyToAccount(generatePrivateKey())
const other = privateKeyToAccount(generatePrivateKey())
// the custody address of every fid, as far as these tests' node knows
const owns = async (address) => address === custody.address.toLowerCase()
// no address in these tests is a contract
const contract = async () => false

const message = ({ fid = 7, nonce, domain = HOST, uri = `https://${domain}`, at = new Date(), address = custody.address }) => [
  `${domain} wants you to sign in with your Ethereum account:`, address, '', 'Farcaster Auth', '', `URI: ${uri}`, 'Version: 1',
  'Chain ID: 10', `Nonce: ${nonce}`, `Issued At: ${at.toISOString()}`, 'Resources:', `- farcaster://fid/${fid}`,
].join('\n')
const ballot = async (id, opt, o = {}) => {
  const m = message({ nonce: `${id}${opt}abcDEF123`, ...o })
  return { message: m, signature: await (o.signer || custody).signMessage({ message: m }) }
}
const cast = async (id, opt, o = {}) => vote(id, await ballot(id, opt, o), o.host || HOST, { owns, contract })

test('a poll needs a question and 2 to 4 different options', async () => {
  await assert.rejects(addPoll({ question: '', options: ['a', 'b'] }, HOST), /question/)
  await assert.rejects(addPoll({ question: 'q', options: ['a'] }, HOST), /2 to 4/)
  await assert.rejects(addPoll({ question: 'q', options: ['a', 'b', 'c', 'd', 'e'] }, HOST), /2 to 4/)
  await assert.rejects(addPoll({ question: 'q', options: ['a', ' '] }, HOST), /empty/)
  await assert.rejects(addPoll({ question: 'q', options: ['Yes', 'yes'] }, HOST), /different/)
  const { id, url } = await addPoll({ question: '  Tea or coffee?\n', options: ['  Tea ', 'Coffee'] }, HOST)
  assert.equal(url, `https://${HOST}/p/${id}`)
  assert.deepEqual(await getPoll(id).then((p) => [p.question, p.options]), ['Tea or coffee?', ['Tea', 'Coffee']])
  assert.equal(await getPoll('../../etc'), null)
})

test('each fid votes once, with its custody address, on this poll and host', async () => {
  const { id } = await addPoll({ question: 'Best number?', options: ['One', 'Two', 'Three'] }, HOST)
  const { id: elsewhere } = await addPoll({ question: 'Other?', options: ['x', 'y'] }, HOST)
  assert.deepEqual(await tally(id, await getPoll(id)).then((t) => t.votes), [0, 0, 0])
  const r = await cast(id, 1)
  assert.deepEqual([r.votes, r.voted, r.already], [[0, 1, 0], 1, undefined])
  // the same fid again, for another option: still its first vote
  const again = await cast(id, 2)
  assert.deepEqual([again.votes, again.voted, again.already], [[0, 1, 0], 1, true])
  assert.deepEqual((await cast(id, 0, { fid: 8 })).votes, [1, 1, 0])
  // a sign-in for another poll, another site or an option that isn't there
  await assert.rejects(vote(id, await ballot(elsewhere, 0, { fid: 9 }), HOST, { owns, contract }), /isn’t for this poll/)
  await assert.rejects(cast(id, 0, { fid: 9, domain: 'evil.example' }), /isn’t for this poll/)
  await assert.rejects(cast(id, 0, { fid: 9, host: 'evil.example' }), /isn’t for this poll/)
  await assert.rejects(cast(id, 0, { fid: 9, uri: 'https://evil.example' }), /isn’t for this poll/)
  await assert.rejects(cast(id, 0, { fid: 9, uri: `http://${HOST}` }), /isn’t for this poll/)
  // a host that signs the launch URL rather than the origin
  assert.deepEqual((await cast(id, 2, { fid: 10, uri: `https://${HOST}/p/${id}` })).votes, [1, 1, 1])
  await assert.rejects(cast(id, 3, { fid: 9 }), /isn’t one of the options/)
  // old, signed by someone else, or by an address that isn't the fid's custody
  await assert.rejects(cast(id, 0, { fid: 9, at: new Date(Date.now() - 3600e3) }), /too old/)
  const forged = await ballot(id, 0, { fid: 9 })
  forged.signature = (await ballot(id, 0, { fid: 9, signer: other })).signature
  await assert.rejects(vote(id, forged, HOST, { owns, contract }), /Couldn’t check/)
  await assert.rejects(cast(id, 0, { fid: 9, signer: other, address: other.address }), /Couldn’t check/)
  await assert.rejects(vote(id, { message: 'hi', signature: '0x00' }, HOST, { owns, contract }), /isn’t for this poll/)
  await assert.rejects(vote('0123456789ab', await ballot('0123456789ab', 0), HOST, { owns, contract }), /gone/)
  assert.deepEqual(await tally(id, await getPoll(id)).then((t) => t.votes), [1, 1, 1])
})

test('a smart-wallet custody signs with ERC-1271, checked on chain', async () => {
  const { id } = await addPoll({ question: 'Smart?', options: ['Yes', 'No'] }, HOST)
  const wallet = '0x' + '5a'.repeat(20)
  const m = message({ nonce: `${id}1xyz12345`, address: wallet, fid: 11 })
  const long = '0x' + 'ab'.repeat(200)
  const ownsWallet = async (a) => a === wallet
  await assert.rejects(vote(id, { message: m, signature: long }, HOST, { owns: ownsWallet, contract: async () => false }), /Couldn’t check/)
  let asked
  const r = await vote(id, { message: m, signature: long }, HOST, { owns: ownsWallet, contract: async (...a) => ((asked = a), true) })
  assert.deepEqual([r.votes, asked[0], asked[2].length], [[0, 1], wallet, 200])
  // the call: isValidSignature(EIP-191 hash of the message, signature), padded to whole words
  const real = globalThis.fetch
  let body
  globalThis.fetch = async (url, o) => ((body = JSON.parse(o.body)), { json: async () => ({ result: '0x1626ba7e' + '0'.repeat(56) }) })
  try {
    assert.equal(await contractSigned(wallet, Buffer.from('hi'), Buffer.alloc(70, 1)), true)
  } finally {
    globalThis.fetch = real
  }
  const data = body.params[0].data
  assert.equal(body.params[0].to, wallet)
  assert.equal(data.slice(0, 10), '0x1626ba7e')
  assert.equal(BigInt('0x' + data.slice(74, 138)), 64n)
  assert.equal(BigInt('0x' + data.slice(138, 202)), 70n)
  assert.equal((data.length - 2 - 8) / 64, 1 + 1 + 1 + 3)
})

test('a count reads only whole votes', async () => {
  const { id } = await addPoll({ question: 'Half?', options: ['a', 'b'] }, HOST)
  await cast(id, 1, { fid: 21 })
  await writeFile(join(data, 'poll', id, '22'), '')
  await writeFile(join(data, 'poll', id, '23.abc.tmp'), '0')
  const p = await getPoll(id)
  assert.deepEqual((await Promise.all([tally(id, p), tally(id, p)])).map((t) => t.votes), [[0, 1], [0, 1]])
})

test('a sign-in message parses', () => {
  const m = parseSiwf(message({ fid: 4294967296, nonce: 'abcdefgh1' }))
  assert.deepEqual([m.domain, m.address, m.uri, m.nonce, m.fid], [HOST, custody.address.toLowerCase(), `https://${HOST}`, 'abcdefgh1', 4294967296])
})

test('the card holds the question and every option', () => {
  const svg = pollCard({ question: 'Tea <or> coffee?', options: ['Tea', 'Coffee', 'Both', 'Neither'] })
  assert.match(svg, /^<svg[^>]+width="1200" height="800"/)
  assert.ok(!svg.includes('<or>'))
  for (const w of ['Tea', 'Coffee', 'Both', 'Neither']) assert.ok(svg.includes(`>${w[0]}<`) || svg.includes(w))
})
