// Deleting an account (Settings → Delete account, src/write.ts deleteServerData): everything this server keeps for a FID.
//   DELETE /api/account/<fid>   signed "quilcast-delete:<fid>:<ts>:" (empty body) by one of the account's Farcaster keys
// A big account has many casts to read, and no request may outlive the proxy's 60 s, so the work runs in the background:
// the first call starts it, and each call (signed again) waits up to 20 s and answers { state: 'running' } until it can
// answer { state: 'done', … }. Running it again later is safe: what's gone stays gone.
// What goes: the profile look, mutes, drafts, translations kept of its casts (read from the node, never from the
// browser), and the photos and videos only this account put on our volume (upload.mjs keeps who). A file someone else
// uploaded too, a theme's picture, or one from before uploads were recorded stays: `kept` counts those among the files
// the account uploaded or its casts and profile link to, so the app can say so (and point to email).
import { dropDrafts } from './drafts.mjs'
import { dropLook, keySigned } from './looks.mjs'
import { dropMutes } from './mutes.mjs'
import { fail, fetchJson, gate } from './net.mjs'
import { dropTranslations } from './translate.mjs'
import { dropMedia, EXT, ownerMap } from './upload.mjs'

const MAX_CASTS = 500e3
const jobs = new Map()
// each one reads every page of an account's casts, so only two at a time
const runs = gate(2, 100)
const down = () => fail(502, "Couldn't read your casts from the Farcaster node. Try again.")
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** `run`: the browser's id for this deletion (?run=), so a reply lost on the way is answered again while a new deletion
 *  starts afresh; a running one is joined whatever it says. */
export async function deleteAccount(req, fid, run_, { node, site }) {
  await keySigned(req, 'quilcast-delete', fid, '', node)
  const id = /^[\w-]{1,64}$/.test(run_ || '') ? run_ : ''
  let job = jobs.get(fid)
  if (!job || (job.state !== 'running' && (job.run !== id || !id || Date.now() - job.at > 600e3))) {
    job = { state: 'running', run: id }
    const end = (o) => Object.assign(job, o, { at: Date.now() })
    job.p = runs(() => run(fid, node, site)).then((r) => end({ state: 'done', result: r }), (e) => end({ state: 'failed', error: e }))
    jobs.set(fid, job)
  }
  let timer
  await Promise.race([job.p, new Promise((ok) => (timer = setTimeout(ok, 20e3)))])
  clearTimeout(timer)
  if (job.state === 'running') return { state: 'running' }
  if (job.state === 'failed') {
    if (jobs.get(fid) === job) jobs.delete(fid)
    throw job.error
  }
  return { state: 'done', ...job.result }
}

async function run(fid, node, site) {
  // the /m/ files this account's casts and profile link to, and its casts' hashes (for their translations)
  const re = new RegExp(`${esc(site)}/m/([0-9a-f]{24}\\.(?:${Object.values(EXT).join('|')}))(?![\\w.])`, 'g')
  const linked = new Set()
  const see = (s) => {
    for (const [, name] of String(s ?? '').matchAll(re)) linked.add(name)
  }
  const hashes = []
  for (let token = ''; ; ) {
    const r = await fetchJson(`${node}/v1/castsByFid?fid=${fid}&pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`, 20e3).catch(() => null)
    if (!Array.isArray(r?.messages)) throw down()
    for (const m of r.messages) {
      if (m.hash) hashes.push(m.hash)
      see(JSON.stringify(m.data?.castAddBody ?? null))
    }
    if (hashes.length > MAX_CASTS) throw fail(413, 'This account has too many casts to delete here. Write to support@borodutch.com.')
    if (!r.nextPageToken || !r.messages.length) break
    token = r.nextPageToken
  }
  const ud = await fetchJson(`${node}/v1/userDataByFid?fid=${fid}`, 20e3).catch(() => null)
  if (!Array.isArray(ud?.messages)) throw down()
  for (const m of ud.messages) see(m.data?.userDataBody?.value)

  const owners = await ownerMap()
  const seen = new Set()
  const gone = []
  for (const [name, who] of owners) if (who.has(fid)) seen.add(name), who.size === 1 && gone.push(name)
  const { media, skipped, unready } = await dropMedia(fid, gone, seen)
  // the files can't be told apart yet (upload.mjs logged why): stop here, so the app keeps the keys for a later try
  if (unready) throw fail(503, "Quilcast's server is still deleting your data. Try again in a few minutes.")
  // what stays that may be its own: its uploads someone else (or a theme) has too, and files from before uploads were
  // recorded that it linked; another account's files it only linked aren't its to ask about
  const kept = new Set([...seen].filter((name) => !gone.includes(name)).concat([...linked].filter((name) => owners.get(name)?.has('legacy')))).size + skipped
  const [look, mutes, drafts, translations] = [await dropLook(fid), await dropMutes(fid), await dropDrafts(fid), await dropTranslations(hashes)]
  return { media, kept, look, mutes, drafts, translations }
}
