// A mini app's Quick Auth sign-in, once the person said yes: the custody address signs the SIWF message. Kept apart
// from miniapp.tsx so its waiting, cancelling and failing can be tested.
import { hex, type Custody } from './fc.ts'
import { rpcError } from './guard.ts'

type Host = { wait: <T>(f: () => Promise<T>) => Promise<T>; toast: (m: string) => void; update: () => void }

/** `app.stop` is the Cancel button on the wait. Resolves as signIn answers the app: the signature, or
 *  rejected_by_user when the person declined (in the wallet or with Cancel); other failures are shown, then thrown. */
export async function signSiwf(app: { stop?: () => void }, custody: Custody, message: string, h: Host) {
  // a wallet's answer can get lost on the way back (a WalletConnect phone that dropped the session), so the wait
  // has a Cancel button; a prompt cancelled here and failing later stays unseen
  let cancel = () => {}
  const stop = new Promise<never>((_, no) => (cancel = () => no(rpcError(4001, 'You declined.'))))
  app.stop = cancel
  try {
    const sig = await h.wait(() => {
      // Quick Auth checks the signature on Optimism, where a smart wallet has to sign it
      const signing = custody.message(new TextEncoder().encode(message), { chain: 10 })
      signing.catch(() => {})
      return Promise.race([signing, stop])
    })
    return { result: { message, signature: '0x' + hex(sig), authMethod: 'custody' } }
  } catch (e: any) {
    // declined in the wallet or cancelled here: the app hears what it hears when our own prompt is declined
    if (e?.code === 4001) return { error: { type: 'rejected_by_user' } }
    // many apps don't catch a failed Quick Auth and keep spinning, so the person sees why here
    h.toast(e.message)
    throw e
  } finally {
    // only its own Cancel: a sign-in asked for meanwhile keeps the one it put up
    if (app.stop === cancel) app.stop = undefined
    h.update()
  }
}
