// Uploads, in small steps so no request outlives the proxy's 60 s limit:
//   POST /api/upload            start: checks who's uploading, returns { id }
//   PUT  /api/upload/<id>?offset=n   append one chunk (≤ 8 MB)
//   POST /api/upload/<id>/done  hand the file to Farcaster's CDN (or our volume) in the background
//   GET  /api/upload/<id>       { state: 'receiving' | 'processing' | 'ready' | 'failed', url?, error? }
// Who's uploading is proven by one of the account's Farcaster keys (the browser's signer, as the node lists it). Farcaster's
// CDN takes uploads the way Quorum does it, with a farcaster.xyz token from a login the custody signs; a browser that holds
// the recovery phrase sends one along. The CDN only serves accounts that have a Warpcast signer, so other files (and every
// upload without a login) are kept on our volume and served from /m/<name>.
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, statfs, truncate } from 'node:fs/promises'
import { join } from 'node:path'
import { keySigned } from './looks.mjs'
import { fail, fetchJson, gate, imageInfo } from './net.mjs'

export const FC = process.env.FC_URL || 'https://client.farcaster.xyz'
// farcaster.xyz's API answers its own site only
export const FC_HEADERS = { origin: 'https://farcaster.xyz', referer: 'https://farcaster.xyz/', accept: 'application/json' }
export const MEDIA = process.env.MEDIA_DIR || '/data/media'
const TMP = join(MEDIA, '..', 'incoming')
export const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' }
const LIMIT = { image: 10e6, video: 100e6 }
const CHUNK = 8 * 1024 * 1024
// the volume shares the host disk with every other service, so local storage is capped hard
const MAX_ACTIVE = 40, MAX_ACTIVE_PER_FID = 3, MAX_INCOMING = 2e9
// FREE_FLOOR is the host's: tests (server.test.mjs) set 0 so they don't depend on the runner's free disk
const DAILY_LOCAL_PER_FID = 300e6, MEDIA_CAP = 20e9, FREE_FLOOR = Number(process.env.FREE_FLOOR || 40e9)
const known = (type) => typeof type === 'string' && Object.hasOwn(EXT, type)

// the first bytes must match the declared type, so nothing else can be stored under a media name
const MAGIC = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.length > 8 && b.readUInt32BE(0) === 0x89504e47,
  'image/gif': (b) => /^GIF8[79]a/.test(b.toString('latin1', 0, 6)),
  'image/webp': (b) => b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
  'video/mp4': (b) => b.toString('latin1', 4, 8) === 'ftyp',
  'video/quicktime': (b) => ['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'].includes(b.toString('latin1', 4, 8)),
  'video/webm': (b) => b.length > 4 && b.readUInt32BE(0) === 0x1a45dfa3,
}
export function looksLike(type, b) {
  if (!known(type) || !MAGIC[type](b)) return false
  // images also get a pixel budget, so nobody can host a decompression bomb for viewers' browsers
  if (type.startsWith('image/')) {
    const info = imageInfo(b)
    return !!info && info.type === type && info.w > 0 && info.h > 0 && info.w * info.h <= 100e6
  }
  return true
}

const canon = (o) => (o === null || typeof o !== 'object' ? JSON.stringify(o) : Array.isArray(o) ? `[${o.map(canon).join(',')}]` : `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(',')}}`)

/** Address that signed the farcaster.xyz bearer (EIP-191 over the canonical auth request). */
function signerOf(authRequest, bearer) {
  const sig = Buffer.from(bearer.replace(/^eip191:/, ''), 'base64')
  const msg = Buffer.from(canon(authRequest))
  const digest = keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${msg.length}`), msg]))
  const pub = secp256k1.Signature.fromBytes(sig.subarray(0, 64), 'compact').addRecoveryBit(sig[64] - 27).recoverPublicKey(digest).toBytes(false)
  return '0x' + Buffer.from(keccak_256(pub.subarray(1)).subarray(12)).toString('hex')
}

async function fcJson(path, token, init = {}) {
  const r = await fetch(FC + path, { ...init, headers: { ...FC_HEADERS, 'content-type': 'application/json', authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60000) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw fail(r.status, j.errors?.[0]?.reason || j.errors?.[0]?.message || `farcaster.xyz ${r.status}`)
  return j.result
}

async function toCdn(job, body, token) {
  const { kind, type } = job
  if (kind === 'image') {
    const { url } = await fcJson('/v1/generate-image-upload-url', token, { method: 'POST', body: '{}' })
    const form = new FormData()
    form.append('file', new Blob([body], { type }), `image.${EXT[type]}`)
    const r = await (await fetch(url, { method: 'POST', body: form })).json()
    const original = r.result?.variants?.find((v) => v.endsWith('/original'))
    if (!original) throw fail(502, 'image upload failed')
    return original
  }
  const prep = await fcJson('/v1/prepare-video-upload', token, { method: 'POST', body: JSON.stringify({ videoSizeBytes: body.length, supportsDynamicUpload: true }) })
  // tus: create the upload, then send the bytes in one PATCH
  const meta = Object.entries({ filetype: type, name: 'cast-video', ...prep.metadata }).map(([k, v]) => `${k} ${Buffer.from(String(v)).toString('base64')}`).join(',')
  const created = await fetch(prep.uploadUrl, { method: 'POST', headers: { ...prep.headers, 'Tus-Resumable': '1.0.0', 'Upload-Length': String(body.length), 'Upload-Metadata': meta } })
  const location = created.headers.get('location')
  if (!location) throw fail(502, `video upload failed (${created.status} ${(await created.text().catch(() => '')).slice(0, 120)})`)
  const patched = await fetch(new URL(location, prep.uploadUrl), { method: 'PATCH', headers: { ...prep.headers, 'Tus-Resumable': '1.0.0', 'Upload-Offset': '0', 'Content-Type': 'application/offset+octet-stream' }, body })
  if (!patched.ok) throw fail(502, `video upload failed (${patched.status} ${(await patched.text().catch(() => '')).slice(0, 120)})`)
  job.state = 'processing'
  for (let i = 0; i < 150; i++) {
    const { video } = await fcJson(`/v1/uploaded-video?videoId=${encodeURIComponent(prep.videoId)}`, token)
    if (video.state === 'ready' && video.embed?.sourceUrl) return video.embed.sourceUrl
    if (video.state === 'failed') throw fail(502, 'video processing failed')
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw fail(504, 'video processing timed out')
}

// ponytail: jobs live in memory, so a deploy mid-upload loses them; the browser just shows the error
const jobs = new Map()
const quota = new Map() // fid -> { day, bytes } stored on our volume today
const spent = new Map() // login requests already used, so a captured one can't be replayed
let mediaBytes = 0
readdir(MEDIA).then(async (names) => {
  for (const n of names) mediaBytes += (await stat(join(MEDIA, n)).catch(() => ({ size: 0 }))).size
}, () => {})
const today = () => Math.floor(Date.now() / 86400e3)
const used = (fid) => (quota.get(fid)?.day === today() ? quota.get(fid).bytes : 0)
const active = (j) => j.state === 'receiving' || j.state === 'sending' || j.state === 'processing'
setInterval(() => {
  const now = Date.now()
  // finished jobs go after 10 minutes, abandoned ones after an hour
  for (const [id, j] of jobs) if ((!active(j) && now - j.endedAt > 600e3) || now - j.at > 3600e3) jobs.delete(id), rm(j.file, { force: true }).catch(() => {})
  for (const [fid, q] of quota) q.day !== today() && quota.delete(fid)
  // a timestamp is accepted for 10 minutes either side of now, so a used one is remembered for longer than those 20
  for (const [once, at] of spent) now - at > 1800e3 && spent.delete(once)
}, 60e3).unref()

// at most two files are read into memory and sent on at a time (the rest wait their turn)
const sends = gate(2, MAX_ACTIVE)

/** Who signed the farcaster.xyz login request on `req` (it must be `fid`'s custody address). Each signature works once. */
async function signedBy(req, fid, node) {
  let authRequest
  try {
    authRequest = JSON.parse(req.headers['x-auth-request'])
  } catch {
    throw fail(400, 'missing auth')
  }
  const bearer = (req.headers.authorization || '').replace(/^Bearer /, '')
  const { timestamp, expiresAt } = authRequest?.params || {}
  if (authRequest?.method !== 'generateToken' || Math.abs(Date.now() - timestamp) > 600e3 || expiresAt - timestamp > 3600e3) throw fail(401, 'stale auth')
  let signer
  try {
    signer = signerOf(authRequest, bearer)
  } catch {
    throw fail(401, 'bad signature')
  }
  const user = await fetchJson(`${node}/v2/farcaster/user?fid=${fid}`, 8000)
  if (!user?.user?.custody_address || user.user.custody_address.toLowerCase() !== signer) throw fail(401, 'signature does not match this account')
  // keyed on what was signed, not the signature bytes, which can be re-encoded (high s) into a new valid one
  const once = `${signer}:${timestamp}`
  if (spent.has(once)) throw fail(401, 'this signature was already used')
  spent.set(once, Date.now())
  return { signer, bearer, authRequest }
}

/** farcaster.xyz session token for a signed login request, or undefined. */
async function fcToken({ bearer, authRequest }) {
  try {
    const r = await fetch(FC + '/v2/onboarding-state', { method: 'PUT', headers: { ...FC_HEADERS, 'content-type': 'application/json', authorization: `Bearer ${bearer}` }, body: JSON.stringify({ authRequest }), signal: AbortSignal.timeout(20000) })
    return (await r.json()).result?.token?.secret
  } catch {}
}

/** POST /api/upload: verify who is uploading and decide where the file will go. */
export async function start(req, { node }) {
  const type = req.headers['content-type']
  if (!known(type)) throw fail(415, 'Use a JPEG, PNG, GIF, WebP, MP4, WebM or MOV file.')
  const kind = type.startsWith('image/') ? 'image' : 'video'
  const size = Number(req.headers['x-size'])
  if (!Number.isSafeInteger(size) || size <= 0) throw fail(400, 'missing size')
  if (size > LIMIT[kind]) throw fail(413, `Files are limited to ${LIMIT[kind] / 1e6} MB.`)
  const fid = Number(req.headers['x-fid'])
  if (!Number.isSafeInteger(fid) || fid <= 0) throw fail(400, 'missing fid')
  // a custody login says who it is and opens the CDN; without one, a signature from the account's key, once
  const auth = req.headers['x-auth-request'] ? await signedBy(req, fid, node) : null
  if (!auth) {
    const { key, ts } = await keySigned(req, 'quilcast-upload', fid, '', node)
    if (spent.has(`${key}:${ts}`)) throw fail(401, 'this signature was already used')
    spent.set(`${key}:${ts}`, Date.now())
  }
  const mine = [...jobs.values()].filter(active)
  if (mine.filter((j) => j.fid === fid).length >= MAX_ACTIVE_PER_FID) throw fail(429, 'Finish your other uploads first.')
  if (mine.length >= MAX_ACTIVE || mine.reduce((n, j) => n + (j.state === 'receiving' ? j.size : 0), 0) + size > MAX_INCOMING) throw fail(503, 'Uploads are busy right now, try again in a minute.')
  const disk = await statfs(join(MEDIA, '..')).catch(() => null)
  if (!disk || disk.bavail * disk.bsize - size < FREE_FLOOR) throw fail(507, 'Upload storage is full right now.')
  // a farcaster.xyz token means the CDN will take it; no token (no Warpcast signer) means our volume.
  // The token is only a probe: the upload itself uses a fresh one from /done, so none is held while bytes arrive.
  let cdn = false
  const token = auth && (await fcToken(auth))
  if (token) cdn = await fcJson('/v1/generate-image-upload-url', token, { method: 'POST', body: '{}' }).then(() => true, (e) => e.message !== 'missing_warpcast_signer')
  // files we keep ourselves count against a daily allowance and a total cap
  if (!cdn && (used(fid) + size > DAILY_LOCAL_PER_FID || mediaBytes + size > MEDIA_CAP)) throw fail(429, 'Upload limit reached for today.')
  const id = randomUUID()
  await mkdir(TMP, { recursive: true })
  jobs.set(id, { id, fid, signer: auth?.signer, kind, type, size, cdn, file: join(TMP, id), received: 0, state: 'receiving', at: Date.now() })
  return { id, chunk: CHUNK }
}

/** PUT /api/upload/<id>?offset=n: append one chunk; offsets must line up so retries are safe. */
export async function chunk(req, id, offset) {
  const job = jobs.get(id)
  if (!job || job.state !== 'receiving') throw fail(404, 'unknown upload')
  if (offset !== job.received) return { received: job.received }
  // one chunk at a time per upload: two writers appending at once would interleave bytes
  if (job.busy) throw fail(409, 'chunk already in progress')
  job.busy = true
  try {
    return await append(req, job)
  } finally {
    job.busy = false
    job.at = Date.now() // slow uploads stay alive while chunks keep arriving
  }
}

async function append(req, job) {
  const out = createWriteStream(job.file, { flags: 'a' })
  let n = 0
  try {
    for await (const c of req) {
      if ((n += c.length) > CHUNK || job.received + n > job.size) throw fail(413, 'chunk too large')
      if (!out.write(c)) await new Promise((r) => out.once('drain', r))
    }
    await new Promise((r, e) => out.end((err) => (err ? e(err) : r())))
  } catch (e) {
    // a chunk cut off halfway must not leave its bytes behind, or the retry would land after them
    await new Promise((r) => out.destroy() && out.once('close', r))
    await truncate(job.file, job.received).catch(() => {})
    throw e
  }
  job.received = (await stat(job.file)).size
  return { received: job.received }
}

/** POST /api/upload/<id>/done: process in the background; poll with GET. CDN uploads sign in again here,
 *  so the farcaster.xyz token only lives for the minutes the upload needs. */
export async function done(req, id, { site, node }) {
  const job = jobs.get(id)
  if (!job || job.state !== 'receiving') throw fail(404, 'unknown upload')
  if (job.received !== job.size) throw fail(400, 'upload incomplete')
  // ponytail: tabs loaded before 0.5.0 don't sign /done, so their files stay on our volume; drop this after a while
  if (job.cdn && !req.headers['x-auth-request']) job.cdn = false
  let token
  if (job.cdn) {
    const auth = await signedBy(req, job.fid, node)
    if (auth.signer !== job.signer) throw fail(401, 'signature does not match this upload')
    token = await fcToken(auth)
    if (!token) throw fail(502, "farcaster.xyz didn't accept the upload, try again")
  }
  // a second /done may have started while we were signing in
  if (jobs.get(id) !== job || job.state !== 'receiving') throw fail(409, 'upload already finishing')
  job.state = 'sending'
  sends(async () => {
    const body = await readFile(job.file)
    if (!looksLike(job.type, body)) throw fail(415, "That file doesn't look like the image or video it claims to be.")
    if (job.cdn) job.url = await toCdn(job, body, token)
    else {
      if (used(job.fid) + body.length > DAILY_LOCAL_PER_FID || mediaBytes + body.length > MEDIA_CAP) throw fail(429, 'Upload limit reached for today.')
      const name = `${createHash('sha256').update(body).digest('hex').slice(0, 24)}.${EXT[job.type]}`
      await mkdir(MEDIA, { recursive: true })
      await rename(job.file, join(MEDIA, name))
      quota.set(job.fid, { day: today(), bytes: used(job.fid) + body.length })
      mediaBytes += body.length
      job.url = `${site}/m/${name}`
    }
    job.state = 'ready'
  })
    .catch((e) => {
      if (!e.status) console.error('upload', id, e)
      job.state = 'failed'
      job.error = e.status ? e.message : 'Upload failed'
    })
    .finally(() => {
      token = undefined
      job.endedAt = Date.now()
      return rm(job.file, { force: true }).catch(() => {})
    })
  return status(id)
}

export function status(id) {
  const j = jobs.get(id)
  if (!j) throw fail(404, 'unknown upload')
  return { state: j.state, received: j.received, size: j.size, url: j.url, error: j.error }
}
