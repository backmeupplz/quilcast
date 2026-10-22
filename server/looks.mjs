// Profile looks (MySpace-style customization, src/looks.tsx): one JSON file per FID in <data>/looks.
//   GET /api/look/<fid>   the look, or null
//   PUT /api/look/<fid>   save one (a JSON look, or null to go back to plain), signed by one of the account's
//                         Farcaster keys: x-key, x-ts and x-sig (ed25519 over "quilcast-look:<fid>:<ts>:<body>")
// The look is cut down to what src/shared.ts allows, and every image in it has to be a real image under its size cap.
import { ed25519 } from '@noble/curves/ed25519.js'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cleanLook, lookImages } from '../src/shared.ts'
import { fail, fetchJson, gate, imageInfo, keep, parseJson, readText, safeGet } from './net.mjs'

let dir = ''
export const loadLooks = (dataDir) => mkdir((dir = join(dataDir, 'looks')), { recursive: true })

const looks = new Map()
const file = (fid) => join(dir, `${fid}.json`)
export const getLook = (fid) => looks.get(fid) || keep(looks, 5000, fid, readFile(file(fid), 'utf8').then(JSON.parse, () => null))

// a key counts while the node lists it for the FID and it hasn't expired; asked again after a minute, or after
// a few seconds when the key isn't there (a browser that just added one)
const signers = new Map()
const keysOf = (node, fid, fresh = 60e3) => {
  const hit = signers.get(fid)
  if (hit && hit.at > Date.now() - fresh) return hit.keys
  const keys = fetchJson(`${node}/v1/signersByFid?fid=${fid}`).then((r) => {
    if (!r?.signers) throw fail(502, "Couldn't reach the Farcaster node. Try again.")
    return r.signers.filter((s) => !s.expiresAt || s.expiresAt * 1000 > Date.now()).map((s) => String(s.key).toLowerCase())
  })
  // a failed lookup isn't kept, so the next save asks the node again
  keep(signers, 2000, fid, { at: Date.now(), keys })
  keys.catch(() => signers.get(fid)?.keys === keys && signers.delete(fid))
  return keys
}

// images are checked once each: fetched up to their cap, so a 1 GB "GIF" stops at the cap and fails
const probes = gate(4)
const checked = new Map()
const checkImage = (url, max) => {
  const k = `${max}:${url}`
  return checked.get(k) || keep(checked, 2000, k, probes(() => safeGet(url, { max: max + 1, timeout: 15e3, headers: { accept: 'image/webp,image/*' } })).then((r) => {
    const info = r.status === 200 && !r.truncated && imageInfo(r.body)
    // the pixel budget keeps tiny files that unpack into huge images (decompression bombs) out
    if (!info || info.w * info.h > 25e6) throw fail(400, `${r.truncated ? 'An image is too big' : "An image couldn't be loaded"} (${max / 1e6} MB at most).`)
    return true
  }))
}

// a song has to be a YouTube video that may be embedded; its title comes from YouTube
const songTitle = (id) => fetchJson(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`).catch(() => null)

export async function putLook(req, fid, node) {
  const body = await readText(req, 20e3)
  const key = String(req.headers['x-key'] || '').toLowerCase()
  const ts = Number(req.headers['x-ts'])
  const sig = String(req.headers['x-sig'] || '')
  if (!/^0x[0-9a-f]{64}$/.test(key) || !/^[0-9a-f]{128}$/.test(sig) || !(Math.abs(Date.now() - ts) < 300e3)) throw fail(401, 'Sign in again to save your look.')
  if (!ed25519.verify(Buffer.from(sig, 'hex'), Buffer.from(`quilcast-look:${fid}:${ts}:${body}`), Buffer.from(key.slice(2), 'hex'))) throw fail(401, 'Bad signature.')
  if (!(await keysOf(node, fid)).includes(key) && !(await keysOf(node, fid, 3e3)).includes(key)) throw fail(403, "That key doesn't belong to this account.")
  const raw = parseJson(body)
  if (raw === null) {
    await rm(file(fid), { force: true })
    looks.set(fid, Promise.resolve(null))
    return null
  }
  const look = cleanLook(raw)
  await Promise.all(lookImages(look).map(([u, max]) => checkImage(u, max)))
  if (look.song) {
    const old = await getLook(fid)
    const title = old?.song?.id === look.song.id ? old.song.title : (await songTitle(look.song.id))?.title
    if (!title) throw fail(400, "That YouTube video can't be played on other sites.")
    look.song.title = String(title).slice(0, 100)
  }
  await writeFile(file(fid) + '.tmp', JSON.stringify(look))
  await rename(file(fid) + '.tmp', file(fid))
  looks.set(fid, Promise.resolve(look))
  return look
}
