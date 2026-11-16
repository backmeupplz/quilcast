// Train casts (shared.ts TRAIN) post from your own account with one tap, so the first time someone joins a train, or
// switches on the composer's train toggle, Quilcast explains that first (TrainSheet in ui.tsx). Once they go on, this
// browser remembers it and never asks again; Cancel posts nothing and asks again next time.

const KEY = 'quilcast:train-told'

/** Whether this browser was told how trains work and went on. */
export const trainTold = () => {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

/** Shows the explanation and settles with whether the person went on; TrainSheet sets it once it's on the page. Until
 *  then nothing can be explained, so nothing goes out. */
export const trainSheet = { ask: (_kind: 'join' | 'start'): Promise<boolean> => Promise.resolve(false) }

/** Whether a train cast may go out: at once when this browser was told before, else after the explanation. */
export async function trainOk(kind: 'join' | 'start') {
  if (trainTold()) return true
  const ok = await trainSheet.ask(kind)
  if (ok) {
    try {
      localStorage.setItem(KEY, '1')
    } catch {}
  }
  return ok
}
