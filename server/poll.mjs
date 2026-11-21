// Poll (poll.quilcast.com, actions/poll/): Quilcast's own composer action (src/composer-actions.json). The app keeps
// a question and 2-4 options here and puts the poll's link in the post; that link is a mini app embed where people
// vote, one vote per FID, proved with Sign in with Farcaster, and see the results.
//   POST /api/poll            { question, options } -> { id, url }
//   GET  /api/poll/<id>       -> { question, options, votes } (votes: a count per option)
//   POST /api/poll/<id>/vote  { message, signature }: a sign-in whose nonce names the poll and the option, so the
//                             signature is the vote -> the same as GET, plus { voted, already? }
// <data>/poll/<id>.json is a poll and <data>/poll/<id>/<fid> a vote (the option's index), created only if it isn't
// there yet, so an FID votes once even while two servers run during a deploy.
import { randomBytes } from 'node:crypto'
import { link, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { join } from 'node:path'
import { fail, fetchJson, readJsonFile, writeAtomic } from './net.mjs'
import { textSvg, wrap } from './text.mjs'
import { personalSigner } from './upload.mjs'
import { rpc } from '../src/shared.ts'
import { logoTile } from './cards.mjs'

export const MAX_QUESTION = 320
export const MAX_OPTION = 60
const ID = /^[0-9a-f]{12}$/
// a sign-in is good for 10 minutes after it's made
const FRESH = 600e3
// a smart-wallet custody's signature is checked on Optimism, where Farcaster's custody addresses live
const OP_RPC = process.env.OP_RPC_URL || 'https://mainnet.optimism.io'

let dir = ''
export const loadPolls = (dataDir) => mkdir((dir = join(dataDir, 'poll')), { recursive: true })

// the page is English only and words its errors with these; they never reach the app's toasts, so they're not
// i18n keys (scripts/i18n-keys.mjs reads fail() calls)
export const no = (status, message) => fail(status, message)
const line = (s, max) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '').slice(0, max)

/** POST /api/poll: keeps a new poll and answers its id and link. */
export async function addPoll(b, host) {
  const question = typeof b?.question === 'string' ? b.question.trim().slice(0, MAX_QUESTION) : ''
  const options = Array.isArray(b?.options) ? b.options.map((o) => line(o, MAX_OPTION)) : []
  if (!question) throw no(400, 'Write a question.')
  if (options.length < 2 || options.length > 4 || options.some((o) => !o)) throw no(400, 'A poll has 2 to 4 options, none of them empty.')
  if (new Set(options.map((o) => o.toLowerCase())).size < options.length) throw no(400, 'Each option has to be different.')
  const id = randomBytes(6).toString('hex')
  await writeAtomic(join(dir, `${id}.json`), JSON.stringify({ question, options, at: Date.now() }))
  return { id, url: `https://${host}/p/${id}` }
}

/** The poll `id`, or null. */
export const getPoll = (id) => (ID.test(id) ? readJsonFile(join(dir, `${id}.json`)) : Promise.resolve(null))

// each poll's votes counted so far, by file name: a count reads only the votes that came in since (from either
// server), and counts of one poll take turns, so many at once after a restart read its votes once
const counted = new Map()
/** The poll with a count of votes per option. */
export function tally(id, p) {
  let c = counted.get(id)
  if (!c) {
    if (counted.size >= 1000) counted.delete(counted.keys().next().value)
    counted.set(id, (c = { seen: new Set(), votes: p.options.map(() => 0), turn: Promise.resolve() }))
  }
  const count = async () => {
    for (const name of await readdir(join(dir, id)).catch(() => [])) {
      if (c.seen.has(name) || !/^\d+$/.test(name)) continue
      const opt = await readFile(join(dir, id, name), 'utf8').catch(() => '')
      if (!/^\d$/.test(opt) || !(opt in c.votes)) continue
      c.seen.add(name)
      c.votes[opt]++
    }
    return { question: p.question, options: p.options, votes: [...c.votes] }
  }
  return (c.turn = c.turn.then(count, count))
}

/** The fields of a Sign in with Farcaster message (EIP-4361) that a vote needs. */
export function parseSiwf(message) {
  const lines = message.split('\n')
  const field = (k) => lines.find((l) => l.startsWith(`${k}: `))?.slice(k.length + 2)
  const date = (k) => (field(k) === undefined ? undefined : Date.parse(field(k)))
  return {
    domain: lines[0]?.match(/^(\S+) wants you to sign in with your Ethereum account:$/)?.[1],
    address: lines[1]?.match(/^0x[0-9a-fA-F]{40}$/)?.[0].toLowerCase(),
    uri: field('URI'), nonce: field('Nonce'), issuedAt: date('Issued At'), expires: date('Expiration Time'), notBefore: date('Not Before'),
    fid: Number(lines.find((l) => /^- farcaster:\/\/fid\/\d+$/.test(l))?.slice(18)) || undefined,
  }
}

/** Whether `address` is `fid`'s custody address: Hypersnap first (every account), then Snapchain (custody moved on
 *  Optimism since Hypersnap's fork). The doc's ownsFid (public/developers/mini-apps.html). */
export async function ownsFid(address, fid, { node, snapchain }) {
  const u = await fetchJson(`${node}/v2/farcaster/user?fid=${fid}`).catch(() => null)
  if (u?.user?.custody_address?.toLowerCase() === address) return true
  if (!snapchain) return false
  const e = await fetchJson(`${snapchain}/v1/onChainIdRegistryEventByAddress?address=${address}`).catch(() => null)
  return Number(e?.fid) === fid && e?.idRegisterEventBody?.to?.toLowerCase() === address
}

/** Whether contract wallet `address` on Optimism takes `sig` for EIP-191 `message` (ERC-1271 isValidSignature). */
export async function contractSigned(address, message, sig) {
  const digest = keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${message.length}`), message]))
  const word = (n) => n.toString(16).padStart(64, '0')
  const data = '0x1626ba7e' + Buffer.from(digest).toString('hex') + word(64) + word(sig.length) + sig.toString('hex').padEnd(Math.ceil(sig.length / 32) * 64, '0')
  // a revert or no answer is a no
  return (await rpc(OP_RPC, 'eth_call', [{ to: address, data }, 'latest'], AbortSignal.timeout(5000)).catch(() => null)) === '0x1626ba7e' + '0'.repeat(56)
}

// some hosts sign the app's launch URL, not its origin; the signed domain already ties it to this host
const sameHost = (uri, host) => {
  try {
    const u = new URL(uri)
    return u.protocol === 'https:' && u.host === host
  } catch {
    return false
  }
}

/** POST /api/poll/<id>/vote: the sign-in proves the FID; its nonce, <poll id><option><anything>, is the vote. */
export async function vote(id, b, host, { node, snapchain, owns = ownsFid, contract = contractSigned, now = Date.now() }) {
  const p = await getPoll(id)
  if (!p) throw no(404, 'That poll is gone.')
  const message = typeof b?.message === 'string' && b.message.length < 2000 ? b.message : ''
  // 65 bytes from an ordinary address, longer from a smart wallet
  const sig = typeof b?.signature === 'string' && b.signature.length <= 4000 && /^0x(?:[0-9a-f]{2}){65,}$/i.test(b.signature) ? Buffer.from(b.signature.slice(2), 'hex') : null
  const m = parseSiwf(message)
  const n = m.nonce?.match(/^([0-9a-f]{12})(\d)[0-9a-zA-Z]*$/)
  if (!sig || !m.address || !m.fid || m.domain !== host || !sameHost(m.uri, host) || n?.[1] !== id) throw no(401, 'That sign-in isn’t for this poll.')
  if (!(Math.abs(now - m.issuedAt) < FRESH) || m.expires < now || m.notBefore > now) throw no(401, 'That sign-in is too old. Try again.')
  const opt = Number(n[2])
  if (!(opt < p.options.length)) throw no(400, 'That isn’t one of the options.')
  let signer
  try {
    signer = sig.length === 65 && personalSigner(Buffer.from(message), sig)
  } catch {}
  // ponytail: a smart wallet that isn't deployed yet (ERC-6492) fails here; unwrap it with viem's verifyMessage if one turns up
  const signed = signer === m.address || (await contract(m.address, Buffer.from(message), sig).catch(() => false))
  if (!signed || !(await owns(m.address, m.fid, { node, snapchain }))) throw no(401, 'Couldn’t check that sign-in. It has to be signed by the account’s custody address.')
  await mkdir(join(dir, id), { recursive: true })
  // written whole, then linked in under the FID only if it isn't there yet, so a count never reads half a vote
  const file = join(dir, id, String(m.fid)), tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(tmp, String(opt))
  const already = await link(tmp, file).then(() => false, (e) => {
    if (e.code !== 'EEXIST') throw e
    return true
  }).finally(() => rm(tmp, { force: true }))
  const voted = already ? Number(await readFile(file, 'utf8')) : opt
  return { ...(await tally(id, p)), voted, ...(already && { already: true }) }
}

const BARS = ['#7a61ff', '#5b3df5', '#4a31c9', '#3a279e']
/** A poll's picture for its mini app embed, 1200×800 (Farcaster shows embeds at 3:2): the question and the options,
 *  without counts, so it never changes. */
export function pollCard(p) {
  const q = wrap(p.question, 50, 1072, p.options.length > 3 ? 2 : 3, { bold: true })
  const top = 196 + q.length * 62
  const gap = 18, h = Math.min(104, (800 - 64 - top - gap * (p.options.length - 1)) / p.options.length)
  const rows = p.options.map((o, i) => {
    const y = top + i * (h + gap)
    return `<rect x="64" y="${y}" width="1072" height="${h}" rx="22" fill="#fff" fill-opacity="0.06" stroke="#fff" stroke-opacity="0.12"/>
  <rect x="64" y="${y}" width="12" height="${h}" rx="6" fill="${BARS[i]}"/>
  ${textSvg(wrap(o, 36, 980, 1), { x: 104, y: y + h / 2 + 13, size: 36, bold: true, fill: '#edebf3' })}`
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1d1540"/><stop offset="0.6" stop-color="#110e1f"/><stop offset="1" stop-color="#0d0c11"/></linearGradient></defs>
  <rect width="1200" height="800" fill="url(#bg)"/>
  ${logoTile(64, 52, 1.5)}
  <text x="124" y="87" font-family="Inter" font-weight="800" font-size="28" letter-spacing="3" fill="#a594ff">POLL</text>
  ${textSvg(q, { x: 64, y: 180, lh: 62, size: 50, bold: true, weight: 800, fill: '#f4f2fa' })}
  ${rows.join('\n  ')}
</svg>`
}
