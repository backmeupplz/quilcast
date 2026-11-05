// Pinned casts (the ⋯ menu's "Pin to profile" on your own cast, src/ui.tsx): one JSON file per FID in <data>/pins, public
// like profile looks. Hypersnap has channel pins but no profile pin yet, so it's kept here until it moves on-protocol.
//   GET /api/pin/<fid>   the pinned cast, { hash }, or null
//   PUT /api/pin/<fid>   pin one ({ hash }) or unpin (null), signed by one of the account's Farcaster keys: x-key, x-ts and
//                        x-sig (ed25519 over "quilcast-pin:<fid>:<ts>:<body>")
// A pin has to be a top-level cast the node has from that FID (a reply can't be pinned). One that's deleted later stays
// here, and the app quietly skips it.
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fail, keep, parseJson, readText } from './net.mjs'
import { keySigned } from './looks.mjs'

let dir = ''
export const loadPins = (dataDir) => mkdir((dir = join(dataDir, 'pins')), { recursive: true })
const file = (fid) => join(dir, `${fid}.json`)
const pins = new Map()

const HASH = /^0x[0-9a-f]{40}$/
const clean = (p) => (HASH.test(p?.hash) ? { hash: p.hash } : null)
// a file cut short (a full disk) reads as no pin
const parse = (s) => {
  try {
    return clean(JSON.parse(s))
  } catch {
    return null
  }
}
export const getPin = (fid) => pins.get(fid) || keep(pins, 5000, fid, readFile(file(fid), 'utf8').then(parse, () => null))

/** The account's pin goes; whether it had one. */
export async function dropPin(fid) {
  const had = await rm(file(fid)).then(() => true, () => false)
  pins.set(fid, Promise.resolve(null))
  return had
}

// `busy()`: the account's own save limit, counted only once the request is signed for it, so nobody else can use it up
export async function putPin(req, fid, node, busy = () => false) {
  const body = await readText(req, 200)
  await keySigned(req, 'quilcast-pin', fid, body, node, () => fail(401, 'Sign in again to pin a cast.'))
  if (busy()) throw fail(429, 'Too many pins, try again in a few minutes.')
  const raw = parseJson(body)
  if (raw === null) return await dropPin(fid), null
  // the node's feeds give bare hex; a pin keeps 0x…
  const hash = '0x' + String(raw?.hash || '').replace(/^0x/i, '').toLowerCase()
  if (!HASH.test(hash)) throw fail(400, 'bad hash')
  // the node answers castById only for a cast that FID wrote (400 "not found" otherwise), so this checks both that it's
  // there and that it's theirs; anything else (a 429, a 5xx, no answer) is the node failing
  const r = await fetch(`${node}/v1/castById?fid=${fid}&hash=${hash}`, { signal: AbortSignal.timeout(5000) }).catch(() => null)
  if (!r || (!r.ok && r.status !== 400 && r.status !== 404)) throw fail(502, "Couldn't reach the Farcaster node. Try again.")
  const m = r.ok ? await r.json().catch(() => null) : null
  if (Number(m?.data?.fid) !== fid || String(m?.hash).toLowerCase() !== hash) throw fail(400, 'You can only pin your own casts.')
  if (m.data.castAddBody?.parentCastId) throw fail(400, "Replies can't be pinned.")
  const pin = { hash }
  // its own temporary file, so two saves at once can't trip over each other
  const tmp = `${file(fid)}.${randomUUID()}.tmp`
  await writeFile(tmp, JSON.stringify(pin))
  await rename(tmp, file(fid)).catch((e) => rm(tmp, { force: true }).then(() => Promise.reject(e)))
  pins.set(fid, Promise.resolve(pin))
  return pin
}
