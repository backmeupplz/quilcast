// Quilcast as a Farcaster mini app (#660): who the client says is using it. Nothing here can sign as them. The
// client's wallet is usually not the account's custody (that stays with the recovery phrase in the Farcaster app),
// and keys that Farcaster's own signer approvals add on Optimism no longer reach Hypersnap since its fork. So the
// client's word only names the person: to show their feed right away, read from public data, and to point them to
// the recovery phrase sign-in instead of a second, empty account.
import { useEffect, useState } from 'preact/hooks'
import type { User } from './api.ts'

/** In a Farcaster client's frame or webview (app.tsx loads inapp.ts only there). */
export const inHost = () => typeof window !== 'undefined' && (window.parent !== window || 'ReactNativeWebView' in window)

/** The FID a mini app context names, 0 when it names none. The client's say-so, unverified: only good for public reads. */
export function fidOfContext(c: unknown): number {
  const f = (c as { user?: { fid?: unknown } } | null | undefined)?.user?.fid
  return typeof f === 'number' && Number.isSafeInteger(f) && f > 0 ? f : 0
}

/** Whom the host card offers: the client's account, unless it's signed in here already. */
export const offered = (u: User | null, signedIn: { fid?: number; done?: boolean }[]) => (u && !signedIn.some((a) => a.done && a.fid === u.fid) ? u : null)

let host: Promise<User | null> | undefined
/** The account the client is signed in to, as Hypersnap knows it. Null outside a mini app, when the client doesn't
 *  say, or when the node doesn't know the FID (one registered on Optimism after the fork). Only a found account is
 *  kept: a client slow to say who it is, or a node that didn't answer, is asked again on the next page. */
export function hostUser(): Promise<User | null> {
  if (!inHost()) return Promise.resolve(null)
  if (host) return host
  const p: Promise<User | null> = import('./inapp.ts')
    .then((m) => m.hostFid())
    .then(async (fid) => (fid ? (await import('./api.ts')).getUser(fid) : null))
    .catch(() => null)
    .then((u) => {
      if (!u && host === p) host = undefined
      return u
    })
  return (host = p)
}

/** hostUser() for a component: null until (and unless) the client names someone. */
export function useHost() {
  const [u, setU] = useState<User | null>(null)
  useEffect(() => {
    let live = true
    hostUser().then((x) => live && setU(x))
    return () => void (live = false)
  }, [])
  return u
}
