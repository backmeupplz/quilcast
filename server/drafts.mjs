// Drafts (src/write.ts listDrafts): one file per draft in <data>/drafts/<fid>, each sealed in the browser with a key
// only the account's custody can make, so this server keeps ciphertext it can't read.
//   GET /api/drafts/<fid>   [{ id, box }], signed "quilcast-drafts-read:<fid>:<ts>:" (empty body)
//   PUT /api/drafts/<fid>   { id, box } saves one, { id, box: null } deletes it, signed "quilcast-drafts:<fid>:<ts>:<body>"
// Both are signed by one of the account's Farcaster keys (x-key, x-ts, x-sig), like mutes.
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fail, parseJson, readText } from './net.mjs'
import { keySigned } from './looks.mjs'

const MAX = 200
let dir = ''
export const loadDrafts = (dataDir) => mkdir((dir = join(dataDir, 'drafts')), { recursive: true })
const ID = /^[0-9a-f-]{36}$/

export async function getDrafts(req, fid, node) {
  await keySigned(req, 'quilcast-drafts-read', fid, '', node)
  const ids = await readdir(join(dir, String(fid))).catch(() => [])
  const all = await Promise.all(ids.filter((id) => ID.test(id)).map(async (id) => ({ id, box: await readFile(join(dir, String(fid), id), 'utf8').catch(() => '') })))
  return all.filter((d) => d.box)
}

/** Every draft of the account goes; how many there were. */
export async function dropDrafts(fid) {
  const at = join(dir, String(fid))
  const n = (await readdir(at).catch(() => [])).filter((id) => ID.test(id)).length
  await rm(at, { recursive: true, force: true })
  return n
}

export async function putDraft(req, fid, node) {
  const body = await readText(req, 70e3)
  await keySigned(req, 'quilcast-drafts', fid, body, node)
  const { id, box } = parseJson(body) || {}
  if (!ID.test(id) || (box !== null && !(typeof box === 'string' && /^[\w+/=]+\.[\w+/=]+$/.test(box) && box.length <= 64e3))) throw fail(400, 'bad draft')
  const at = join(dir, String(fid))
  if (box === null) return await rm(join(at, id), { force: true }), { id }
  await mkdir(at, { recursive: true })
  const ids = await readdir(at)
  if (!ids.includes(id) && ids.filter((x) => ID.test(x)).length >= MAX) throw fail(400, 'Too many drafts. Delete some first.')
  await writeFile(join(at, id + '.tmp'), box)
  await rename(join(at, id + '.tmp'), join(at, id))
  return { id }
}
