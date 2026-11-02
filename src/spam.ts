// Spam scores from spam.quilcast.com (a Laya model reads every new cast and account; its own repo, quilcast-spam).
// Casts at or over the threshold get a "Spam 97%" label, or are hidden when Settings → Spam says Hide; accounts get
// "Spam account 92%", and Settings → Spam accounts → Hide takes their casts and replies out everywhere.
import { settings, type Cast } from './api.ts'

const API = 'https://spam.quilcast.com/'
// scores by cast hash and by fid; one the service hasn't scored yet stays out, so it's asked for again next time
const scores = new Map<string, number>()
const accounts = new Map<number, number>()

/** Asks `path` for the keys not known yet, 100 at a time, into `into`. Never throws; gives up after 1.5 s. */
async function ask<K extends string | number>(path: string, keys: K[], into: Map<K, number>) {
  const want = [...new Set(keys.filter((k) => k != null && !into.has(k)))]
  for (let i = 0; i < want.length; i += 100) {
    try {
      const r = await fetch(API + path + want.slice(i, i + 100).join(','), { signal: AbortSignal.timeout(1500) })
      for (const [k, s] of Object.entries(await r.json())) if (typeof s === 'number') into.set((typeof want[0] === 'number' ? +k : k) as K, s)
    } catch {
      return
    }
  }
}

/** Scores for these casts (and the conversation above them) and for their authors. */
export async function checkSpam(casts: Cast[]) {
  const all = casts.flatMap((c) => [c, ...(c.up || [])])
  await Promise.all([ask('scores?h=', all.map((c) => c.hash), scores), checkAccounts(all.map((c) => c.author?.fid))])
}
export const checkAccounts = (fids: number[]) => ask('users?fid=', fids, accounts)

/** Percent (0-100) when the cast scores at or over the threshold, else null. */
export function spamOf(c: Cast) {
  const s = scores.get(c.hash)
  return s != null && s * 100 >= spamAt() ? Math.round(s * 100) : null
}
/** Percent when the account scores at or over the threshold, else null. */
export function spamAccountOf(fid?: number) {
  const s = fid == null ? undefined : accounts.get(fid)
  return s != null && s * 100 >= spamAt() ? Math.round(s * 100) : null
}
export const spamAt = () => settings.spamAt ?? 70
export const hidesSpam = (c: Cast) =>
  (settings.spam === 'hide' && spamOf(c) != null) || (settings.spamAccounts === 'hide' && spamAccountOf(c.author?.fid) != null)
