// Theme sync (Settings → Sync themes): the worn theme, the theme library, light or dark, holiday themes and Quorum
// mode, kept with the account on our server (server/prefs.mjs, signed with its Farcaster key), so every device it's
// signed in on that syncs wears the same. Each change here goes up at once and is stamped; a device whose stamp
// differs from the server's takes the server's.
import { account, read, save, saveSettings, settings } from './api.ts'
import { cleanPrefs, type Prefs } from './shared.ts'
import { keepLibrary, library, theme, toast, wear } from './ui.tsx'
import { fetchPrefs, savePrefs } from './write.ts'

export const AT = 'quilcast:themeAt'
const mine = (at = read(AT, 0)): Prefs =>
  ({ theme, library: library(), mode: settings.theme as Prefs['mode'], holidays: settings.holidays !== false, quorum: !!settings.quorum, at })
function take(p: Prefs) {
  const quorum = !!settings.quorum !== p.quorum
  settings.theme = p.mode, settings.holidays = p.holidays, settings.quorum = p.quorum, saveSettings(), save(AT, p.at)
  keepLibrary(p.library, true)
  wear(p.theme, true, true)
  // Quorum mode is CSS under :root[data-quorum] and its own shell (app.tsx applyTheme)
  p.quorum ? (document.documentElement.dataset.quorum = '') : delete document.documentElement.dataset.quorum
  quorum && dispatchEvent(new Event('quorum'))
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

/** Settings turned sync on: the newer of this device's and the account's settings wins. On a tie (neither changed
 *  since sync came out) the one wearing a theme does, so turning it on never takes a theme off for the plain app.
 *  Either way the libraries are joined, so no device loses a theme it kept. */
export async function turnOn(): Promise<'took' | 'sent'> {
  const got = cleanPrefs(await fetchPrefs(true))
  const at = read(AT, 0)
  if (!got) return await savePrefs(mine()), 'sent'
  const took = got.at > at || (got.at === at && (!!got.theme || !theme))
  const lib = took ? [...got.library, ...library()] : [...library(), ...got.library]
  if (took) take({ ...got, library: lib })
  else keepLibrary(lib, true)
  // a newer stamp, so the account's other devices take the joined result
  const p = mine(Math.max(Date.now(), got.at + 1))
  save(AT, p.at)
  await savePrefs(p)
  return took ? 'took' : 'sent'
}
