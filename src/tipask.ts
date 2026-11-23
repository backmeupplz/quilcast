// Holding Like tips the cast's author $1 (ui.tsx CastCard, walletmove.tsx tip). The first full hold in this browser
// explains that first (TipSheet in ui.tsx) and sends nothing unless the person taps Tip; after that, holds tip at once.
// The sheet and Settings → Wallets share one switch for the whole thing: off, holding Like works like a tap.

const TOLD = 'quilcast:tip-told', OFF = 'quilcast:hold-tip-off'
const get = (k: string) => {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}
const put = (k: string, on: boolean) => {
  try {
    on ? localStorage.setItem(k, '1') : localStorage.removeItem(k)
  } catch {}
}

/** Whether holding Like tips; on unless someone switched it off. */
export const holdTip = () => get(OFF) !== '1'
export const setHoldTip = (on: boolean) => put(OFF, !on)
/** Whether this browser was told how hold-to-tip works and went on to tip. */
export const tipTold = () => get(TOLD) === '1'

/** Shows the explanation (`from`: the wallet that pays, `to`: the author's name) and settles with whether to tip;
 *  TipSheet sets it once it's on the page. Until then nothing can be explained, so nothing is sent. */
export const tipSheet = { ask: (_o: { from: string; to: string }): Promise<boolean> => Promise.resolve(false) }

/** Whether a full hold may tip: never while switched off, at once once told, else after the explanation. */
export async function tipOk(o: { from: string; to: string }) {
  if (!holdTip()) return false
  if (tipTold()) return true
  // the sheet's switch may have been turned off before Tip
  const ok = (await tipSheet.ask(o)) && holdTip()
  if (ok) put(TOLD, true)
  return ok
}
