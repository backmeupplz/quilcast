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

/** Whether the app is in Mini apps: a cast action by its origin (one entry per app), any other app by its address. */
export function isSaved(saved: { url: string }[], app: { url: string; origin: string; share?: boolean }) {
  return saved.some((s) => (app.share ? parse(s.url)?.origin === app.origin : s.url === app.url))
}
