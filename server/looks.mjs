// Profile looks (MySpace-style customization, src/looks.tsx): one JSON file per FID in <data>/looks.
//   GET /api/look/<fid>   the look, or null
//   PUT /api/look/<fid>   save one (a JSON look, or null to go back to plain), signed by one of the account's
//                         Farcaster keys: x-key, x-ts and x-sig (ed25519 over "quilcast-look:<fid>:<ts>:<body>")
//   GET /api/looks        every profile with a look, newest save first: [{ fid, amp }] (amp: its Winamp is on)
//   POST /api/design      share a look's design (its style only): stored once in <data>/designs under a hash of
//                         itself, so a link always shows the same design; answers { id } for quilcast.com/design/<id>
//   GET /api/design/<id>  a shared design, or null
// The look is cut down to what src/shared.ts allows, and every image in it has to be a real image under its size cap.
import { ed25519 } from '@noble/curves/ed25519.js'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cleanDesign, cleanLook, lookImages } from '../src/shared.ts'
import { fail, fetchJson, gate, imageInfo, keep, parseJson, readText, safeGet } from './net.mjs'

let dir = ''
let designs = ''
export const loadLooks = (dataDir) =>
  Promise.all([mkdir((dir = join(dataDir, 'looks')), { recursive: true }), mkdir((designs = join(dataDir, 'designs')), { recursive: true })])

// images in a design are checked when someone saves it as their look, like any other look
export async function putDesign(req) {
  const design = cleanDesign(parseJson(await readText(req, 4e3)))
  if (!Object.keys(design).length) throw fail(400, 'That design is empty.')
  const body = JSON.stringify(design)
  const id = createHash('sha256').update(body).digest('base64url').slice(0, 10)
  await writeFile(join(designs, `${id}.json`), body, { flag: 'wx' }).catch((e) => {
    if (e.code !== 'EEXIST') throw e
  })
  return { id }
}
export const getDesign = (id) => readFile(join(designs, `${id}.json`), 'utf8').then(JSON.parse, () => null)

const looks = new Map()
const file = (fid) => join(dir, `${fid}.json`)
// the list behind Search's "Customized profiles"; it's read again at most once a minute
let listed = null
export function listLooks() {
  if (listed && listed.at > Date.now() - 60e3) return listed.list
  const list = readdir(dir).then((names) => Promise.all(names.filter((n) => /^[1-9]\d*\.json$/.test(n)).map(async (n) => {
    const fid = Number(n.slice(0, -5))
    const [s, look] = await Promise.all([stat(join(dir, n)), getLook(fid)])
    return look && { fid, at: s.mtimeMs, amp: !!look.amp?.on }
  }))).then((l) => l.filter(Boolean).sort((a, b) => b.at - a.at).map(({ fid, amp }) => ({ fid, amp })))
  listed = { at: Date.now(), list }
  list.catch(() => (listed = null))
  return list
}

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

// a song (or a Winamp list item) has to be a YouTube video or playlist that may be embedded; its title comes from YouTube
const yt = gate(4, 200)
const songTitle = (id, pl) => yt(() => fetchJson(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(pl ? `https://www.youtube.com/playlist?list=${id}` : `https://www.youtube.com/watch?v=${id}`)}`)).catch(() => null)

/** The account's Farcaster key (one the node lists for `fid`) that signed "<what>:<fid>:<ts>:<body>" in the last five
 *  minutes, from the x-key, x-ts and x-sig headers. `stale` makes the answer when they're missing or too old. */
export async function keySigned(req, what, fid, body, node, stale = () => fail(401, 'missing auth')) {
  const key = String(req.headers['x-key'] || '').toLowerCase()
  const ts = Number(req.headers['x-ts'])
  const sig = String(req.headers['x-sig'] || '')
  if (!/^0x[0-9a-f]{64}$/.test(key) || !/^[0-9a-f]{128}$/.test(sig) || !(Math.abs(Date.now() - ts) < 300e3)) throw stale()
  if (!ed25519.verify(Buffer.from(sig, 'hex'), Buffer.from(`${what}:${fid}:${ts}:${body}`), Buffer.from(key.slice(2), 'hex'))) throw fail(401, 'Bad signature.')
  if (!(await keysOf(node, fid)).includes(key) && !(await keysOf(node, fid, 3e3)).includes(key)) throw fail(403, "That key doesn't belong to this account.")
  return { key, ts }
}

export async function putLook(req, fid, node) {
  const body = await readText(req, 20e3)
  await keySigned(req, 'quilcast-look', fid, body, node, () => fail(401, 'Sign in again to save your look.'))
  const raw = parseJson(body)
  if (raw === null) {
    await rm(file(fid), { force: true })
    looks.set(fid, Promise.resolve(null))
    listed = null
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
  if (look.amp) {
    const old = new Map((await getLook(fid))?.amp?.list.map((x) => [x.id, x.title]) || [])
    await Promise.all(look.amp.list.map(async (x) => {
      const title = old.get(x.id) || (await songTitle(x.id, x.pl))?.title
      if (!title) throw fail(400, "A YouTube link in your Winamp list can't be played on other sites.")
      x.title = String(title).slice(0, 100)
    }))
  }
  await writeFile(file(fid) + '.tmp', JSON.stringify(look))
  await rename(file(fid) + '.tmp', file(fid))
  looks.set(fid, Promise.resolve(look))
  listed = null
  return look
}
