// Mini apps that wait in the dock go to sleep: their frame is unloaded (a third-party page's scripts, timers, sockets
// and memory all go with it) and the dock keeps their icon. Tapping one loads it again from its splash, like a fresh
// open. miniapp.tsx decides which apps are busy (a prompt, a wallet request, camera and mic) and never puts those down.

/** How long an app waits in the dock before it sleeps. */
export const IDLE = 5 * 60_000
/** How many apps stay awake in the dock besides the one on screen: fewer on a phone, which kills a page that holds too much. */
export const awake = (phone: boolean) => (phone ? 1 : 3)

export type Napper = { id: number; asleep?: boolean; hidAt?: number }

/** The apps to put to sleep: every hidden one that isn't busy once it has waited `IDLE`, or right away when `all`
 *  (the page went to the background on a phone), and past `keep` the ones used longest ago. */
export function sleepers<T extends Napper>(apps: T[], shown: number | null, now: number, keep: number, busy: (a: T) => boolean, all = false): T[] {
  // most recently hidden first; one that was never hidden (it opened behind another) counts as hidden now
  const waiting = apps.filter((a) => a.id !== shown && !a.asleep && !busy(a)).sort((a, b) => (b.hidAt ?? now) - (a.hidAt ?? now))
  return waiting.filter((a, i) => all || i >= keep || now - (a.hidAt ?? now) >= IDLE)
}
