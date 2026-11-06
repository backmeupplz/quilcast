// Campaign links (#480): a promo link opens quilcast.com/?utm_campaign=<campaign>. The campaign stays in this browser
// only (for 30 days), and if this browser's first sign-in comes meanwhile, our server hears it once and adds one to that
// campaign's count for the day (server/stats.mjs), keeping nothing about the account.
const KEY = 'quilcast:campaign'
const JOINED = 'quilcast:joined'
const KEEP = 30 * 864e5
export const CAMPAIGN = /^[A-Za-z0-9_-]{1,64}$/

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/** Keep the campaign of the link this page was opened from; a newer link's replaces it. `had`: this browser holds a
 *  signed-in account already (from before sign-ins were marked), so no sign-in here is a first one. */
export function keepCampaign(search: string, had = false, store: Store = localStorage, now = Date.now()) {
  if (had) store.setItem(JOINED, '1')
  const c = new URLSearchParams(search).get('utm_campaign')
  if (c && CAMPAIGN.test(c)) store.setItem(KEY, JSON.stringify({ c, at: now }))
}

/** A sign-in finished; `before` is whether this browser held a signed-in account already. Answers the campaign to send
 *  when it's the browser's first sign-in, and from then on no sign-in here is a first one. */
export function firstSignIn(before: boolean, store: Store = localStorage, now = Date.now()) {
  const first = !before && !store.getItem(JOINED)
  let kept: { c?: unknown; at?: unknown } | null = null
  try {
    kept = JSON.parse(store.getItem(KEY) || 'null')
  } catch {}
  store.setItem(JOINED, '1')
  store.removeItem(KEY)
  const c = kept?.c
  return first && typeof c === 'string' && CAMPAIGN.test(c) && typeof kept!.at === 'number' && now - kept!.at < KEEP ? c : null
}
