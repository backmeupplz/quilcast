// Sticker packs, Telegram style (src/stickers.tsx): anyone makes packs, shares their link, and adds others' packs to
// the picker. A sticker is an animated or still WebP at /st/<pack>/<hash>.webp, so in a cast it's an ordinary picture
// embed that every Farcaster client shows; Quilcast draws it as a sticker.
//   <data>/stickers/packs/<id>.json    { id, fid (the owner), title, stickers: [{ h, e }] } (h = file hash, e = emoji)
//   <data>/stickers/files/<h>.webp     each sticker once; kept after a pack drops it, since casts still show it
//   <data>/stickers/saved/<fid>.json   the account's packs (the picker's tabs), newest first, its own included
//   GET  /st/<pack>/<h>.webp           a sticker
//   GET  /api/stickers/<fid>           the account's packs
//   GET  /api/stickers/pack/<id>       one pack
//   POST /api/stickers/<fid>           a change, signed by the account's Farcaster key ("quilcast-stickers"): { op, … }
//   GET  /api/stickers/job/<id>        how a Telegram import is going
// Telegram packs come through the Bot API (TELEGRAM_BOT_TOKEN, the one reports use): still stickers are kept as they
// are, video ones (VP9 WebM with alpha) go through ffmpeg and animated ones (.tgs Lottie) through server/tgs.mjs,
// both into img2webp.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fail, gate, imageInfo, keep, parseJson, readText } from './net.mjs'
import { keySigned } from './looks.mjs'

const run = promisify(execFile)
const TELEGRAM = process.env.TELEGRAM_API || 'https://api.telegram.org'
const FFMPEG = process.env.FFMPEG || 'ffmpeg'
const IMG2WEBP = process.env.IMG2WEBP || 'img2webp'
export const MAX_STICKERS = 120
const MAX_PACKS = 100
const SIDE = 320
const ID = /^[\w-]{8}$/
const HASH = /^[0-9a-f]{24}$/

let dir = ''
export async function loadStickers(dataDir) {
  dir = join(dataDir, 'stickers')
  await Promise.all(['packs', 'files', 'saved'].map((d) => mkdir(join(dir, d), { recursive: true })))
}
const packFile = (id) => join(dir, 'packs', `${id}.json`)
const savedFile = (fid) => join(dir, 'saved', `${fid}.json`)
export const stickerFile = (h) => join(dir, 'files', `${h}.webp`)
export const isSticker = (pack, h) => ID.test(pack) && HASH.test(h)

const packs = new Map()
const read = (f, empty) => readFile(f, 'utf8').then(JSON.parse, () => empty)
export const getPack = (id) => (!ID.test(id) ? Promise.resolve(null) : packs.get(id) || keep(packs, 5000, id, read(packFile(id), null)))
const savedOf = (fid) => read(savedFile(fid), []).then((l) => (Array.isArray(l) ? l.filter((x) => ID.test(x)) : []))
// its own temporary file, so two saves at once can't trip over each other
async function write(f, v) {
  const tmp = `${f}.${randomUUID()}.tmp`
  await writeFile(tmp, Buffer.isBuffer(v) ? v : JSON.stringify(v))
  await rename(tmp, f).catch((e) => rm(tmp, { force: true }).then(() => Promise.reject(e)))
}
const putPack = (p) => (packs.set(p.id, Promise.resolve(p)), write(packFile(p.id), p))

/** The account's packs in its order; packs deleted since quietly drop out. */
export const listPacks = async (fid) => (await Promise.all((await savedOf(fid)).map(getPack))).filter(Boolean)

const title = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 64)

// one sticker at a time across the server: ffmpeg and img2webp take a CPU each while they run
const convert = gate(1, 1000)

/** A sticker's bytes as the WebP we serve, and its first frame as a PNG for share cards (resvg draws no WebP), or
 *  null for an animated WebP kept as it is: `kind` is 'tgs' or 'webm' for Telegram's animated and video stickers,
 *  anything else is sniffed (a WebP that's already small enough is kept as it is). */
export const toWebp = (buf, kind) =>
  convert(async () => {
    const info = imageInfo(buf)
    // an animated WebP (VP8X's animation flag) can't be read by ffmpeg, so one is kept as it is or not at all
    const animated = info?.type === 'image/webp' && buf.toString('latin1', 12, 16) === 'VP8X' && (buf[20] & 2) > 0
    const keep = !kind && info?.type === 'image/webp' && ((info.w <= 512 && info.h <= 512 && buf.length <= 512e3) || animated)
    if (keep && animated) {
      if (info.w > 512 || info.h > 512 || buf.length > 1e6) throw fail(400, 'An animated WebP sticker can be 512 pixels and 1 MB at most.')
      return { webp: buf, still: null }
    }
    if (!kind && !info && buf.readUInt32BE(0) === 0x1a45dfa3) kind = 'webm'
    if (!kind && !info) throw fail(400, "That file isn't a picture Quilcast can make a sticker from.")
    if (info && info.w * info.h > 25e6) throw fail(400, 'That picture is too big.')
    const tmp = await mkdtemp(join(tmpdir(), 'sticker-'))
    try {
      const input = join(tmp, 'in')
      const frames = join(tmp, 'f')
      await mkdir(frames)
      await writeFile(input, buf)
      const png = (from) => run(FFMPEG, ['-v', 'error', '-i', from, '-frames:v', '1', join(tmp, 'still.png')], { timeout: 30e3 }).then(() => readFile(join(tmp, 'still.png')))
      if (keep) return { webp: buf, still: await png(input) }
      let ms = 33
      if (kind === 'tgs') ms = Number((await run(process.execPath, [new URL('./tgs.mjs', import.meta.url).pathname, input, frames, String(SIDE)], { timeout: 60e3 })).stdout) || 33
      // a WebM's alpha only comes through libvpx's decoder, not ffmpeg's own
      else await run(FFMPEG, ['-v', 'error', ...(kind === 'webm' ? ['-c:v', 'libvpx-vp9'] : []), '-i', input, '-t', '10', '-vf', `fps=30,scale=${SIDE}:${SIDE}:force_original_aspect_ratio=decrease`, '-pix_fmt', 'rgba', join(frames, '%04d.pam')], { timeout: 60e3 })
      const list = (await readdir(frames)).sort().slice(0, 300)
      if (!list.length) throw fail(400, "That file isn't a picture Quilcast can make a sticker from.")
      const webp = (args, out) => run(IMG2WEBP, ['-lossy', '-q', '75', '-m', '4', ...args, '-o', join(tmp, out)], { timeout: 120e3 }).then(() => readFile(join(tmp, out)))
      const still = await png(join(frames, list[0]))
      if (list.length === 1) return { webp: await webp([join(frames, list[0])], 'out.webp'), still }
      return { webp: await webp(['-loop', '0', '-d', String(ms), ...list.map((f) => join(frames, f))], 'out.webp'), still }
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

/** Keep a sticker's WebP (and its still); its name is its hash. */
async function keepFile({ webp, still }) {
  const h = createHash('sha256').update(webp).digest('hex').slice(0, 24)
  if (still) await write(stillFile(h), still)
  if (!(await stat(stickerFile(h)).catch(() => null))) await write(stickerFile(h), webp)
  return h
}
const stillFile = (h) => join(dir, 'files', `${h}.png`)
/** A sticker's first frame as a PNG for a share card, or null (an animated WebP that came in as it is). */
export const stickerStill = (h) => readFile(stillFile(h)).catch(() => null)

/** The pack name in a Telegram link: t.me/addstickers/<name>, t.me/addemoji/<name>, tg://addstickers?set=<name>, or the bare name. */
export function tgName(url) {
  const s = String(url || '').trim()
  const m = s.match(/^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\/add(?:stickers|emoji)\/([A-Za-z0-9_]+)\/?$/i) || s.match(/^tg:\/\/add(?:stickers|emoji)\?set=([A-Za-z0-9_]+)$/i) || s.match(/^([A-Za-z][A-Za-z0-9_]{0,63})$/)
  return m?.[1] || null
}

const tg = async (method, params) => {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) throw fail(503, "Telegram import isn't set up on this server yet.")
  const r = await fetch(`${TELEGRAM}/bot${token}/${method}?${new URLSearchParams(params)}`, { signal: AbortSignal.timeout(15e3) }).catch(() => null)
  const j = await r?.json().catch(() => null)
  if (!j?.ok && r && r.status < 500 && j) throw fail(404, "Telegram doesn't have a sticker pack by that name.")
  if (!j?.ok) throw fail(502, "Couldn't reach Telegram. Try again.")
  return j.result
}
async function tgFile(fileId) {
  const { file_path: path } = await tg('getFile', { file_id: fileId })
  const r = await fetch(`${TELEGRAM}/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${path}`, { signal: AbortSignal.timeout(30e3) })
  if (!r.ok || Number(r.headers.get('content-length')) > 2e6) throw new Error(`telegram file ${r.status}`)
  const b = Buffer.from(await r.arrayBuffer())
  if (b.length > 2e6) throw new Error('telegram file too big')
  return b
}

// imports in progress, by id; they're in memory, so a deploy mid-import stops it (what came in so far stays)
// ponytail: one process holds the jobs; a second server instance would need them on disk
const jobs = new Map()
const running = new Map()
export const getJob = (id) => jobs.get(id) || null

function startImport(fid, pack, set) {
  if (running.has(fid)) throw fail(429, 'One Telegram import at a time. Wait for this one to finish.')
  const id = randomBytes(8).toString('hex')
  const job = { id, pack: pack.id, total: Math.min(set.stickers.length, MAX_STICKERS - pack.stickers.length), done: 0, failed: 0, finished: false }
  keep(jobs, 500, id, job)
  running.set(fid, id)
  ;(async () => {
    for (const s of set.stickers.slice(0, job.total)) {
      try {
        const webp = await toWebp(await tgFile(s.file_id), s.is_animated ? 'tgs' : s.is_video ? 'webm' : undefined)
        const h = await keepFile(webp)
        // the pack as it is now, since its owner may change it while the import runs
        const now = await getPack(pack.id)
        if (!now) break
        if (now.stickers.length < MAX_STICKERS && !now.stickers.some((x) => x.h === h)) await putPack({ ...now, stickers: [...now.stickers, { h, e: String(s.emoji || '').slice(0, 16) }] })
        job.done++
      } catch (e) {
        console.error('sticker import', set.name, e?.message)
        job.failed++
      }
    }
  })().finally(() => ((job.finished = true), running.delete(fid)))
  return job
}

async function own(fid, id) {
  const p = await getPack(id)
  if (!p) throw fail(404, "That sticker pack doesn't exist anymore.")
  // not a 403, which the app takes for a key the node doesn't list (and replaces it)
  if (p.fid !== fid) throw fail(400, "Only the pack's creator can change it.")
  return p
}
const setSaved = (fid, list) => write(savedFile(fid), list.slice(0, MAX_PACKS))

/** A deleted account's packs and list go (server/account.mjs). Their sticker files stay, as casts still show them. */
export async function dropStickers(fid) {
  for (const id of await savedOf(fid)) if ((await getPack(id))?.fid === fid) await rm(packFile(id), { force: true }), packs.set(id, Promise.resolve(null))
  await rm(savedFile(fid), { force: true })
}

// `busy()`: the account's own limit, counted only once the request is signed for it
export async function postStickers(req, fid, node, busy = () => false) {
  const body = await readText(req, 3e6)
  await keySigned(req, 'quilcast-stickers', fid, body, node, () => fail(401, 'Sign in again to change your stickers.'))
  if (busy()) throw fail(429, 'Too many changes, try again in a few minutes.')
  const b = parseJson(body) || {}
  const saved = await savedOf(fid)
  const room = () => {
    if (saved.length >= MAX_PACKS) throw fail(400, 'You can keep 100 sticker packs at most. Remove one first.')
  }
  const create = async (name) => {
    room()
    const p = { id: randomBytes(6).toString('base64url'), fid, title: title(name) || 'Stickers', stickers: [] }
    await putPack(p)
    await setSaved(fid, [p.id, ...saved])
    return p
  }
  switch (b.op) {
    case 'create':
      return { pack: await create(b.title) }
    case 'edit': {
      // a rename, or a new order of the stickers it has (one left out is removed)
      const p = await own(fid, b.pack)
      const have = new Map(p.stickers.map((s) => [s.h, s]))
      const stickers = Array.isArray(b.stickers) ? [...new Set(b.stickers)].map((h) => have.get(h)).filter(Boolean) : p.stickers
      const next = { ...p, title: b.title === undefined ? p.title : title(b.title) || p.title, stickers }
      await putPack(next)
      return { pack: next }
    }
    case 'delete': {
      await own(fid, b.pack)
      await rm(packFile(b.pack), { force: true })
      packs.set(b.pack, Promise.resolve(null))
      await setSaved(fid, saved.filter((x) => x !== b.pack))
      return { ok: true }
    }
    case 'add': {
      const p = await own(fid, b.pack)
      if (p.stickers.length >= MAX_STICKERS) throw fail(400, 'A pack holds 120 stickers at most.')
      const buf = Buffer.from(String(b.image || ''), 'base64')
      if (!buf.length || buf.length > 2e6) throw fail(400, 'A sticker can be 2 MB at most.')
      const h = await keepFile(await toWebp(buf))
      const now = await getPack(p.id)
      const next = now.stickers.some((s) => s.h === h) ? now : { ...now, stickers: [...now.stickers, { h, e: String(b.emoji || '').slice(0, 16) }] }
      await putPack(next)
      return { pack: next }
    }
    case 'import': {
      const name = tgName(b.url)
      if (!name) throw fail(400, 'Paste a Telegram sticker pack link, like t.me/addstickers/name.')
      const set = await tg('getStickerSet', { name })
      const p = b.pack ? await own(fid, b.pack) : await create(set.title || name)
      if (p.stickers.length >= MAX_STICKERS) throw fail(400, 'A pack holds 120 stickers at most.')
      return { pack: p, job: startImport(fid, p, set) }
    }
    case 'save': {
      if (!(await getPack(b.pack))) throw fail(404, "That sticker pack doesn't exist anymore.")
      if (!saved.includes(b.pack)) room(), await setSaved(fid, [b.pack, ...saved])
      return { ok: true }
    }
    case 'unsave':
      await setSaved(fid, saved.filter((x) => x !== b.pack))
      return { ok: true }
    default:
      throw fail(400, 'bad op')
  }
}
