// "Browse as" (#490): Home shows another account's Following feed, read from public data, at `/?as=<username|fid>`.
// Nothing is signed as them: likes, recasts and replies stay the signed-in user's, and signed out they lead to Join.
import type { User } from './api.ts'

/** Who `?as=` asks for: a FID or a username (fnames and ENS names), else null. */
export function asOf(search: string): string | null {
  const v = new URLSearchParams(search).get('as')?.trim().replace(/^@/, '').toLowerCase()
  return v && /^(\d{1,10}|[a-z0-9][a-z0-9._-]{0,63})$/.test(v) ? v : null
}

/** The page that browses as `u`. It goes by FID for a nameless account (its username is "fid:N") and for an
 *  all-digit username, which `?as=` would read as a FID. */
export const browsePath = (u: User) => `/?as=${encodeURIComponent(u.username && !u.username.startsWith('fid:') && !/^\d+$/.test(u.username) ? u.username.toLowerCase() : String(u.fid))}`

// the last few accounts browsed as, newest first, with what a chip needs to draw them
export type Recent = { fid: number; username?: string; display_name?: string; pfp_url?: string }
export const RECENTS = 5
/** The kept list as read back from storage, whatever's there. */
export const recentsOf = (v: unknown): Recent[] => (Array.isArray(v) ? v.filter((r) => r && Number.isInteger(r.fid) && r.fid > 0).slice(0, RECENTS) : [])
export const remember = (list: unknown, u: User): Recent[] =>
  [{ fid: u.fid, username: u.username, display_name: u.display_name, pfp_url: u.pfp_url }, ...recentsOf(list).filter((r) => r.fid !== u.fid)].slice(0, RECENTS)

/** Whether a reply to `to`'s cast belongs in `viewer`'s Following feed: `viewer` follows `to` (or is `to`). `said` is the
 *  node's viewer_context.following, which is about the signed-in user (`me`), so it only counts when that's the viewer. */
export async function repliesFit(to: number, viewer: number | undefined, me: number | undefined, said: boolean | undefined, follows: (to: number, viewer: number) => Promise<boolean>) {
  if (!viewer) return false
  if (to === viewer) return true
  return (viewer === me ? said : undefined) ?? (await follows(to, viewer))
}
