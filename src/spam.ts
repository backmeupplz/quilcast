// Spam scores from spam.quilcast.com (a Laya model reads every new cast; its own repo, quilcast-spam). Casts at or
// over the threshold get a "Spam 97%" label, or are hidden when Settings → Spam says Hide.
import { settings, type Cast } from './api.ts'

const API = 'https://spam.quilcast.com/scores'
// scores by hash; one the service hasn't scored yet stays out, so it's asked for again next time it loads
const scores = new Map<string, number>()

/** Asks for the scores of casts not asked about yet. Never throws, and gives up after a second and a half. */
export async function checkSpam(casts: Cast[]) {
  const want = [...new Set(casts.flatMap((c) => [c, ...(c.up || [])]).map((c) => c.hash).filter((h) => !scores.has(h)))]
  for (let i = 0; i < want.length; i += 100) {
    try {
      const r = await fetch(API + '?h=' + want.slice(i, i + 100).join(','), { signal: AbortSignal.timeout(1500) })
      for (const [h, s] of Object.entries(await r.json())) if (typeof s === 'number') scores.set(h, s)
    } catch {
      return
    }
  }
}

/** Percent (0-100) when the cast scores at or over the threshold, else null. */
export function spamOf(c: Cast) {
  const s = scores.get(c.hash)
  return s != null && s * 100 >= spamAt() ? Math.round(s * 100) : null
}
export const spamAt = () => settings.spamAt ?? 90
export const hidesSpam = (c: Cast) => settings.spam === 'hide' && spamOf(c) != null
