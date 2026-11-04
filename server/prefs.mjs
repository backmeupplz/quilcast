// Theme sync (src/prefs.ts, Settings → Sync themes): one JSON file per FID in <data>/prefs, private to the account.
//   GET /api/prefs/<fid>   the account's theme settings or null, signed "quilcast-prefs-read:<fid>:<ts>:" (empty body)
//   PUT /api/prefs/<fid>   replace them, signed "quilcast-prefs:<fid>:<ts>:<body>"
// Both are signed by one of the account's Farcaster keys (x-key, x-ts, x-sig), like mutes.
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cleanPrefs } from '../src/shared.ts'
import { fail, parseJson, readText } from './net.mjs'
import { keySigned } from './looks.mjs'

let dir = ''
export const loadPrefs = (dataDir) => mkdir((dir = join(dataDir, 'prefs')), { recursive: true })
const file = (fid) => join(dir, `${fid}.json`)

export async function getPrefs(req, fid, node) {
  await keySigned(req, 'quilcast-prefs-read', fid, '', node)
  return cleanPrefs(await readFile(file(fid), 'utf8').then(JSON.parse, () => null))
}

/** The account's theme settings go; whether it had them. */
export const dropPrefs = (fid) => rm(file(fid)).then(() => true, () => false)

export async function putPrefs(req, fid, node) {
  const body = await readText(req, 20e3)
  await keySigned(req, 'quilcast-prefs', fid, body, node)
  const p = cleanPrefs(parseJson(body))
  if (!p) throw fail(400, 'bad prefs')
  await writeFile(file(fid) + '.tmp', JSON.stringify(p))
  await rename(file(fid) + '.tmp', file(fid))
  return p
}
