// Mutes and blocks (src/mutes.ts): one JSON file per FID in <data>/mutes, private to the account.
//   GET /api/mutes/<fid>   the list, signed "quilcast-mutes-read:<fid>:<ts>:" (empty body)
//   PUT /api/mutes/<fid>   replace it, signed "quilcast-mutes:<fid>:<ts>:<body>"
// Both are signed by one of the account's Farcaster keys (x-key, x-ts, x-sig), like profile looks.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cleanMutes } from '../src/shared.ts'
import { parseJson, readText } from './net.mjs'
import { keySigned } from './looks.mjs'

let dir = ''
export const loadMutes = (dataDir) => mkdir((dir = join(dataDir, 'mutes')), { recursive: true })
const file = (fid) => join(dir, `${fid}.json`)

export async function getMutes(req, fid, node) {
  await keySigned(req, 'quilcast-mutes-read', fid, '', node)
  return cleanMutes(await readFile(file(fid), 'utf8').then(JSON.parse, () => null))
}

export async function putMutes(req, fid, node) {
  const body = await readText(req, 300e3)
  await keySigned(req, 'quilcast-mutes', fid, body, node)
  const m = cleanMutes(parseJson(body))
  await writeFile(file(fid) + '.tmp', JSON.stringify(m))
  await rename(file(fid) + '.tmp', file(fid))
  return m
}
