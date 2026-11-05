// Pinned casts (server/pins.mjs; not the mini app dock's pins in ui.tsx): each profile's one pinned cast, read from our
// server and kept here, so the profile and the ⋯ menu agree right after a pin or unpin.
import { useEffect, useState } from 'preact/hooks'
import { forget, once } from './api.ts'

const known = new Map<number, string | null>()
// bumped by every local change, so an older read landing late doesn't undo it
const changed = new Map<number, number>()
const subs = new Set<() => void>()
const tell = () => subs.forEach((f) => f())
const url = (fid: number) => `/api/pin/${fid}`

/** A cast hash as pins keep it: 0x and lowercase (the node's feeds give bare hex). */
export const pinKey = (hash: string) => '0x' + hash.replace(/^0x/i, '').toLowerCase()

/** What the profile's list leaves out under its pinned cast: the pin, once it's drawn on top (`settled`, the pin that was)
 *  or known to be gone. Until then, and when reading it failed, the list keeps it, so a failed read never hides it. */
export const listSkip = (pin: string | null | undefined, settled: string | null) => (pin && settled === pin ? pin : null)

/** The profile's pinned cast hash, null when it has none, undefined until it's been read (or while reading it fails). */
export const pinnedCast = (fid: number) => known.get(fid)

/** Reads the profile's pin (kept a few minutes, like the node's answers). A read that fails isn't kept, so the next one
 *  asks again, and it leaves the pin as it was (undefined if never read), not "none". */
export function readPin(fid: number): Promise<string | null | undefined> {
  const v = changed.get(fid) || 0
  return once(url(fid), () => fetch(url(fid)).then((r) => {
    if (!r.ok) throw new Error(`pin ${r.status}`)
    return r.json()
  }).then((j) => (typeof j?.hash === 'string' ? j.hash : null)))
    .then((h) => {
      if ((changed.get(fid) || 0) === v && known.get(fid) !== h) known.set(fid, h), tell()
      return known.get(fid) ?? null
    }, () => known.get(fid))
}

/** What the server now says after a pin or unpin by this browser. */
export function setPinnedCast(fid: number, hash: string | null) {
  changed.set(fid, (changed.get(fid) || 0) + 1)
  forget(url(fid))
  known.set(fid, hash)
  tell()
}

/** The profile's pinned cast hash, read on first use and redrawn when it changes; fid 0 reads nothing. */
export function usePinnedCast(fid: number): string | null | undefined {
  const [, redraw] = useState(0)
  useEffect(() => {
    if (!fid) return
    const f = () => redraw((x) => x + 1)
    subs.add(f)
    readPin(fid)
    return () => void subs.delete(f)
  }, [fid])
  return fid ? known.get(fid) : undefined
}
