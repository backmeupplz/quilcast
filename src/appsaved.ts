// Which address a mini app is saved under in Mini apps, and whether it's saved already (miniapp.tsx addApp, context).
// An app opened as a cast action (castShareUrl) has the cast in its address (castHash/castFid/viewerFid, ui.tsx
// runAction), so that address is different on every cast: it's saved once, at its home, and known by its origin.

export const SHARE_PARAMS = ['castHash', 'castFid', 'viewerFid']

const parse = (u?: string) => {
  try {
    return u ? new URL(u) : undefined
  } catch {}
}

/** Where a cast action's Mini apps entry opens: the manifest's homeUrl when it's https on the app's own origin,
 *  else the castShareUrl it was opened at, without the cast. */
export function shareHome(url: string, homeUrl?: string) {
  const at = new URL(url)
  const home = parse(homeUrl)
  if (home?.protocol === 'https:' && home.origin === at.origin) return home.href
  for (const p of SHARE_PARAMS) at.searchParams.delete(p)
  return at.href
}

/** A one-click cast action an app asks to add (miniapp.tsx addCastAction, public/developers/cast-actions.html), checked:
 *  https on the app's own origin, a name of 1 to 30 characters, a placeholder of at most 40. null when it isn't one. */
export function oneClick(o: any, origin: string) {
  const name = typeof o?.name === 'string' ? o.name.replace(/\s+/g, ' ').trim() : ''
  const placeholder = o?.placeholder == null ? '' : typeof o.placeholder === 'string' ? o.placeholder.replace(/\s+/g, ' ').trim() : null
  const url = typeof o?.url === 'string' && o.url.length <= 1024 ? parse(o.url) : undefined
  if (!name || [...name].length > 30 || placeholder == null || [...placeholder].length > 40 || url?.protocol !== 'https:' || url.origin !== origin) return null
  return { url: url.href, name, ...(placeholder && { placeholder }) }
}

/** What a one-click action's POST carries, signed as a JSON Farcaster Signature: the tap, bound to its own URL and time,
 *  so it can't pass as a webhook event or as a tap on another action. */
export const oneClickPayload = (url: string, cast: { hash: string; fid: number }, input?: string, notificationDetails?: { url: string; token: string }, now = Date.now()) => ({
  type: 'cast_action', url, cast: { hash: '0x' + cast.hash.replace(/^0x/, ''), fid: cast.fid },
  ...(input != null && { input }), ...(notificationDetails && { notificationDetails }), timestamp: now,
})

/** Whether the app is in Mini apps: a cast action by its origin (one entry per app), any other app by its address. */
export function isSaved(saved: { url: string }[], app: { url: string; origin: string; share?: boolean }) {
  return saved.some((s) => (app.share ? parse(s.url)?.origin === app.origin : s.url === app.url))
}
