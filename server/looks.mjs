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
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { cleanDesign, cleanLook, lookImages } from '../src/shared.ts'
import { fail, fetchJson, fresh, gate, imageInfo, keep, parseJson, readJsonFile, readText, safeGet, writeAtomic } from './net.mjs'
import { seen } from './stats.mjs'
import { keepHashed } from './themes.mjs'

let dir = ''
let designs = ''
export const loadLooks = (dataDir) =>
  Promise.all([mkdir((dir = join(dataDir, 'looks')), { recursive: true }), mkdir((designs = join(dataDir, 'designs')), { recursive: true })])

// images in a design are checked when someone saves it as their look, like any other look
export async function putDesign(req) {
  const design = cleanDesign(parseJson(await readText(req, 4e3)))
  if (!Object.keys(design).length) throw fail(400, 'That design is empty.')
  return keepHashed(designs, JSON.stringify(design))
}
export const getDesign = (id) => readJsonFile(join(designs, `${id}.json`))

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

/** The account's look goes (back to plain, and off Search's list); whether it had one. */
export async function dropLook(fid) {
  const had = !!(await stat(file(fid)).catch(() => null))
  await rm(file(fid), { force: true })
  looks.set(fid, Promise.resolve(null))
  listed = null
  return had
}

export const getLook = (fid) => looks.get(fid) || keep(looks, 5000, fid, readJsonFile(file(fid)))

// fid → Map(key → { at, exp }) of keys the node listed when they signed, for when it can't be asked (haatz stalls for
// minutes now and then); only keys the node listed get in, so nobody can crowd real ones out with keys of their own
const held = new Map()
// a key counts while the node lists it for the FID and it hasn't expired; asked again after a minute, or after
// a few seconds when the key isn't there (a browser that just added one). Rows are { key, exp } (ms), and `cast` for a
// key that may only post casts (X crossposting's, server/crosspost.mjs).
const signers = new Map()
const castOnly = (scopes) => Array.isArray(scopes) && scopes.length === 1 && (scopes[0] === 'MESSAGE_TYPE_CAST_ADD' || scopes[0] === 1)
const rowsOf = (node, fid, ttl) =>
  // a timeout or a dropped connection reads the same as an error answer
  fresh(signers, 2000, ttl, fid, () => fetchJson(`${node}/v1/signersByFid?fid=${fid}`).catch(() => null).then((r) => {
    if (!r?.signers) throw fail(502, "Couldn't reach the Farcaster node. Try again.")
    const rows = r.signers.map((s) => ({ key: String(s.key).toLowerCase(), exp: s.expiresAt ? s.expiresAt * 1000 : Infinity, cast: castOnly(s.scopes) }))
    // a key the node no longer lists is forgotten for outages too, whichever request asked
    const h = held.get(fid)
    if (h) for (const k of h.keys()) if (!rows.some((r) => r.key === k)) h.delete(k)
    return rows
  }))
export const keysOf = (node, fid, ttl = 60e3) => rowsOf(node, fid, ttl).then((rows) => rows.filter((r) => r.exp > Date.now()).map((r) => r.key))

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
 *  minutes, from the x-key, x-ts and x-sig headers. `stale` makes the answer when they're missing or too old. `outage`
 *  false: the node has to answer, a key it listed before doesn't count (for what can't be undone). */
export async function keySigned(req, what, fid, body, node, stale = () => fail(401, 'missing auth'), outage = true) {
  const key = String(req.headers['x-key'] || '').toLowerCase()
  const ts = Number(req.headers['x-ts'])
  const sig = String(req.headers['x-sig'] || '')
  if (!/^0x[0-9a-f]{64}$/.test(key) || !/^[0-9a-f]{128}$/.test(sig) || !(Math.abs(Date.now() - ts) < 300e3)) throw stale()
  if (!ed25519.verify(Buffer.from(sig, 'hex'), Buffer.from(`${what}:${fid}:${ts}:${body}`), Buffer.from(key.slice(2), 'hex'))) throw fail(401, 'Bad signature.')
  const listed = async (ttl) => (await rowsOf(node, fid, ttl)).find((r) => r.key === key && r.exp > Date.now())
  const ok = await listed(60e3).then((r) => r || listed(3e3)).then((r) => {
    if (r) {
      // re-adding moves the account to the back of the line
      const h = held.get(fid) || new Map()
      held.delete(fid)
      keep(held, 5000, fid, h).set(key, { at: Date.now(), exp: r.exp, cast: r.cast })
    }
    return r
  }, (e) => {
    // the node can't be asked: a key it listed in the last hour still counts until it expires (so a revoked key can
    // outlive its removal by that long, only while the node is down); any other key waits for the node, never a 403
    const h = outage && held.get(fid)?.get(key)
    if (h && h.at > Date.now() - 3600e3 && h.exp > Date.now()) return h
    throw e
  })
  if (!ok) throw fail(403, "That key doesn't belong to this account.")
  // X crossposting's key may post casts and their media, and nothing else here
  if (ok.cast && what !== 'quilcast-upload') throw fail(403, "That key doesn't belong to this account.")
  // one more account today (server/stats.mjs keeps only the count)
  seen(fid)
  return { key, ts }
}

// `busy()`: the account's own save limit, counted only once the request is signed for it (as pins.mjs does)
export async function putLook(req, fid, node, busy = () => false) {
  const body = await readText(req, 20e3)
  await keySigned(req, 'quilcast-look', fid, body, node, () => fail(401, 'Sign in again to save your look.'))
  if (busy()) throw fail(429, 'Too many saves, try again in a few minutes.')
  const raw = parseJson(body)
  if (raw === null) return await dropLook(fid), null
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
  await writeAtomic(file(fid), JSON.stringify(look))
  looks.set(fid, Promise.resolve(look))
  listed = null
  return look
}
