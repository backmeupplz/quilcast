// Theme sync (Settings → Sync themes): the worn theme, light or dark and holiday themes, kept with the account on our
// server (server/prefs.mjs, signed with its Farcaster key), so every device it's signed in on that syncs wears the same.
// Each change here goes up at once and is stamped; a device whose stamp differs from the server's takes the server's.
import { account, read, save, saveSettings, settings } from './api.ts'
import { cleanPrefs, type Prefs } from './shared.ts'
import { theme, toast, wear } from './ui.tsx'
import { fetchPrefs, savePrefs } from './write.ts'

export const AT = 'quilcast:themeAt'
const mine = (at = read(AT, 0)): Prefs => ({ theme, mode: settings.theme as Prefs['mode'], holidays: settings.holidays !== false, at })
function take(p: Prefs) {
  settings.theme = p.mode, settings.holidays = p.holidays, saveSettings(), save(AT, p.at)
  wear(p.theme, true, true)
  dispatchEvent(new Event('prefs'))
}

/** This device's settings go up (after a change here, already stamped). */
export const push = (p = mine()) => savePrefs(p).catch((e) => toast(e.message))

let last = 0
/** Take the account's settings if another device changed them; at most every 30 s. */
export async function pull() {
  if (!settings.syncThemes || !account?.done || Date.now() - last < 30e3) return
  last = Date.now()
  const got = cleanPrefs(await fetchPrefs().catch(() => null))
  if (got && got.at !== read(AT, 0)) take(got)
}

/** Settings turned sync on: the newer of this device's and the account's wins. On a tie (neither changed since sync
 *  came out) the one wearing a theme does, so turning it on never takes a theme off for the plain app. */
export async function turnOn(): Promise<'took' | 'sent'> {
  const got = cleanPrefs(await fetchPrefs(true))
  const at = read(AT, 0)
  if (got && (got.at > at || (got.at === at && (got.theme || !theme)))) return take(got), 'took'
  // a newer stamp, so the account's other devices take this one
  const p = mine(got ? Math.max(Date.now(), got.at + 1) : at)
  save(AT, p.at)
  await savePrefs(p)
  return 'sent'
}
