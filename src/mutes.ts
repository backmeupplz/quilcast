// Mutes and blocks: people and words this account doesn't want to see. Farcaster has neither, so they're kept with
// the account on our server (server/mutes.mjs, signed with its key, so other devices get them) and in localStorage
// for the first paint. Without a finished account (anonymous mode, #491) they're kept in this browser only. A change
// fires 'mutes', which re-renders the app.
import { account, got, read, save, settings, type Cast } from './api.ts'
import { cleanMutes, isTrain, mutedText, quotesOf, wordsRe, type Mutes, type Timed } from './shared.ts'
import removedList from './removed.json' with { type: 'json' }
import { hidesSpam } from './spam.ts'

// the account's own list, or this device's anonymous one; signing in or out (which doesn't reload the page) switches
// between them, so the anonymous list never reaches an account's server list, nor the other way round
const keyOf = () => `quilcast:mutes:${account?.done ? account.fid : 'local'}`
let key = keyOf()
export let mutes: Mutes = cleanMutes(read(key, null))
// a change made here before the server answered wins over what it sends
let touched = false
const changed = () => (save(key, mutes), (re = undefined), dispatchEvent(new Event('mutes')))
try {
  addEventListener('account', () => {
    if (keyOf() === key) return
    key = keyOf()
    mutes = cleanMutes(read(key, null))
    touched = false
    re = undefined
    dispatchEvent(new Event('mutes'))
    syncMutes()
  })
} catch {}

/** Take the account's list from our server: another device may have changed it. */
export async function syncMutes() {
  if (!account?.done) return
  const k = key
  const got = await import('./write.ts').then((m) => m.fetchMutes()).catch(() => null)
  if (got && !touched && k === key) (mutes = cleanMutes(got)), changed()
}

/** Mute or block (`kind`) a person's FID or a word until `until` (ms; undefined is until lifted), or lift it (false).
 *  Saved here at once; the promise rejects if our server didn't take it. */
export function setMute(kind: keyof Mutes, v: string | number, until?: number | false) {
  touched = true
  if (typeof v === 'string') v = v.trim().toLowerCase()
  const rest = (mutes[kind] as Timed<unknown>[]).filter((x) => x.v !== v)
  mutes = cleanMutes({ ...mutes, [kind]: until === false ? rest : [...rest, { v, until }] })
  changed()
  return account?.done ? import('./write.ts').then((m) => m.saveMutes(mutes)) : Promise.resolve()
}

const on = (xs: Timed<unknown>[], v: unknown) => xs.find((x) => x.v === v && (!x.until || x.until > Date.now()))
/** The block on `fid`, if there is one running. */
export const blockOf = (fid?: number) => on(mutes.blocks, fid)
/** The mute on `fid`, if there is one running. */
export const muteOf = (fid?: number) => on(mutes.users, fid)

// the words' pattern, rebuilt when they change or a minute has passed (a timed one may have run out)
let re: { re: RegExp | null; at: number } | undefined
const words = () => (re && re.at > Date.now() - 60e3 ? re : (re = { re: wordsRe(mutes.words.filter((x) => !x.until || x.until > Date.now()).map((x) => x.v)), at: Date.now() })).re

// casts and accounts taken down for everyone after a report (see /terms): add them here and deploy
const removed: { fids: number[]; casts: string[] } = removedList

/** Whether Settings → Train casts hides this cast: a train (#698) or one of its cars, which are trains too. */
export const hidesTrain = (c: Cast) => settings.trains === 'hide' && isTrain(c)

// the casts `c` quotes that have loaded (warm() loads a feed's before it shows)
const quoted = (c: Cast) => quotesOf(c, account?.fid).flatMap((h) => (got.get(`c:${h}`) as Cast | null | undefined) || [])

/** Whether a cast stays out of sight: taken down for everyone (removed.json), someone muted or blocked wrote it, a muted
 *  word is in it, a site it links or a cast it quotes (mutedText), or it's spam or a
 *  train this browser hides. The account's own casts never do. `owner` is the profile being looked at, where a muted person's casts (and their spam and
 *  trains) still show. */
export function hides(c: Cast, owner?: number) {
  const fid = c.author?.fid
  if (removed.fids.includes(fid) || removed.casts.includes(c.hash)) return true
  if (fid === account?.fid) return false
  if (blockOf(fid)) return true
  if (fid === owner) return false
  return !!muteOf(fid) || !!words()?.test(mutedText(c, quoted(c))) || hidesSpam(c) || hidesTrain(c)
}
/** Whether a person's notifications and casts are muted or blocked. */
export const silenced = (fid?: number) => !!(muteOf(fid) || blockOf(fid))
