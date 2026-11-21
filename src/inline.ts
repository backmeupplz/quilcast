// Inline mini app embeds (fc:miniapp:inline, public/developers/inline-embeds.html): a mini app's small view, run in its
// cast's card (ui.tsx InlineApp) instead of the whole app. It speaks the same Comlink wire as a full app (miniapp.tsx),
// but only a few calls are answered here; anything else tells it to open the app. Kept apart from miniapp.tsx so a feed
// with a poll in it doesn't load the wallets.
import { account, go, myUser, safeUrl, type Cast, type User } from './api.ts'
import { castText } from './shared.ts'
import { siwf } from './guard.ts'
import { signSiwf } from './signin.ts'
import { custodyOf } from './write.ts'
import { channelOf, handle, requireAccount, toast } from './ui.tsx'
import { t } from './i18n.ts'

export const QUILCAST_FID = 3356316
// a phone, upright or on its side (layout.test.ts); the Quilcast apps are phones however wide they are (an unfolded
// iPhone Duo has the sidebar)
export const narrow = () => matchMedia('(max-width: 559px), (max-width: 699px) and (max-height: 599px)').matches
export const inApp = navigator.userAgent.includes('QuilcastApp/')
export const userCtx = (u: User) => ({ fid: u.fid, username: u.username?.startsWith('fid:') ? undefined : u.username, displayName: u.display_name, pfpUrl: u.pfp_url })
export const castCtx = (c: Cast) => ({
  author: userCtx(c.author), hash: '0x' + c.hash.replace(/^0x/, ''), parentHash: c.parent_hash || undefined, parentFid: c.parent_author?.fid || undefined,
  timestamp: Date.parse(c.timestamp), text: castText(c), embeds: c.embeds.flatMap((e) => e.url ?? []), channelKey: channelOf(c.parent_url),
})

/** What the card draws over the frame: a question with a yes button, or a wait. */
export type Say = { title: string; body?: string; yes?: string; at?: number; done?: (ok: boolean) => void } | null
type Inline = {
  frame: HTMLIFrameElement; origin: string; host: string; name: string
  // the cast it's in and its embed (the app's link); none in the composer, where it's a preview
  cast?: Cast; embed: string; app: { url: string; name?: string; icon?: string; splash?: string; bg?: string }
  say: (s: Say) => void; stop?: () => void; asking?: boolean
}
const frames = new Set<Inline>()

/** Answer `i.frame`'s calls until the returned function is called (the card went away). */
export function attach(i: Inline) {
  frames.add(i)
  return () => (frames.delete(i), i.stop?.(), i.say(null))
}

// one prompt at a time, as for a whole app (miniapp.tsx ask): another while one is up is refused
const ask = (i: Inline, title: string, body: string, yes: string) =>
  new Promise<boolean>((resolve) => {
    if (i.asking) return resolve(false)
    i.asking = true
    i.say({ title, body, yes, at: Date.now(), done: (ok) => ((i.asking = false), i.say(null), resolve(ok)) })
  })

// a call that takes the person somewhere always asks in its card first, so a view can't move the app, open another
// app or a tab, by itself. No tap shortcut: a view can focus itself, so a tap anywhere would look like one on it (#774)
const leaving = (i: Inline, where: string) => ask(i, t('Open this link?'), where, t('Open'))
// what the composer's preview may call: it's not the cast yet, and no one taps it
const PREVIEW = new Set(['context', 'ready', 'getCapabilities', 'getChains'])

// argument checks shared with a whole app's calls (miniapp.tsx)
export const linkArg = (raw: any) => {
  const u = safeUrl(raw)
  if (!u) throw new Error('That is not a web link.')
  return u
}
export const hashArg = (o: any) => {
  const h = String(o?.hash || '').replace(/^0x/, '')
  if (!/^[0-9a-f]{40}$/i.test(h)) throw new Error('Invalid cast hash.')
  return h
}
export const fidArg = (o: any): number => {
  if (!Number.isSafeInteger(o?.fid) || o.fid <= 0) throw new Error('Invalid fid.')
  return o.fid
}

/** A Comlink call from a frame, or null when it isn't one. Plain values only: no proxies (MessagePorts) or other handlers. */
export function parseCall(d: any): { id: string; type: unknown; name: string; args: unknown[] } | null {
  if (!d || typeof d !== 'object' || typeof d.id !== 'string' || !Array.isArray(d.path) || d.path.length !== 1) return null
  return { id: d.id, type: d.type, name: String(d.path[0]), args: (Array.isArray(d.argumentList) ? d.argumentList : []).map((v: any) => (v?.type === 'RAW' ? v.value : undefined)) }
}

/** Runs a call and posts its result back, or its error as Comlink throws one: also when `post` throws on the result
 *  (it can't be cloned). A throw while posting the error is dropped. */
export function answer(id: string, call: () => unknown, post: (m: unknown) => void) {
  const p = new Promise((r) => r(call()))
  p.then((value) => post({ id, type: 'RAW', value }))
    .catch((err) => post({ id, type: 'HANDLER', name: 'throw', value: { isError: true, value: { message: String(err?.message || err), name: 'Error' } } }))
    .catch(() => {})
  return p
}

const calls: Record<string, (i: Inline, ...a: any[]) => unknown> = {
  ready: () => {},
  getCapabilities: () => ['actions.ready', 'actions.signIn', 'actions.openUrl', 'actions.openMiniApp', 'actions.viewCast', 'actions.viewProfile'],
  getChains: () => [],
  async signIn(i, o: any = {}) {
    if (document.hidden || !i.cast) return { error: { type: 'rejected_by_user' } }
    // someone signed out goes to /join only once they agree in the card
    if (!account?.done && !(await leaving(i, `${location.host}/join`))) return { error: { type: 'rejected_by_user' } }
    if (!requireAccount()) return { error: { type: 'rejected_by_user' } }
    const a = account!, me = myUser()!
    const custody = await custodyOf(a)
    const draft = () => siwf({ origin: i.origin, address: custody.address, fid: a.fid!, nonce: o.nonce, notBefore: o.notBefore, expirationTime: o.expirationTime })
    // checked before asking, so a bad request never shows a prompt
    draft()
    const ok = await ask(i, t('Sign in to {site}?', { site: i.name }), t('{host} will know you as @{name} (fid {fid}). This signs a sign-in message with your account.', { host: i.host, name: handle(me), fid: me.fid }), t('Sign in'))
    if (!ok) return { error: { type: 'rejected_by_user' } }
    // the wait is a prompt too: another one asked for meanwhile is refused, so it can't hide this one's Cancel
    const wait = async <T,>(f: () => Promise<T>) => {
      i.asking = true
      i.say({ title: a.wallet ? t('Check your wallet') : t('Signing…'), done: () => i.stop?.() })
      try {
        return await f()
      } finally {
        i.asking = false
        i.say(null)
      }
    }
    return signSiwf(i, custody, draft(), { wait, toast, update: () => {} })
  },
  async openUrl(i, raw: unknown) {
    const u = linkArg(typeof raw === 'string' ? raw.trim() : (raw as any)?.url)
    if (await leaving(i, u)) open(u, '_blank', 'noopener,noreferrer')
  },
  // the whole app, as its card's button opens it, or another app
  async openMiniApp(i, o: any = {}) {
    const u = linkArg(o?.url)
    if (!(await leaving(i, u)) || !requireAccount()) return
    const m = await import('./miniapp.tsx')
    u === i.app.url ? m.launch(i.app, { cast: i.cast, embed: i.embed }) : m.launchUrl(u, i.host)
  },
  async viewCast(i, o) {
    const h = hashArg(o)
    if (await leaving(i, `${location.host}/c/${h}`)) go(`/c/${h}`)
  },
  async viewProfile(i, o) {
    const fid = fidArg(o)
    if (await leaving(i, `${location.host}/u/${fid}`)) go(`/u/${fid}`)
  },
}

const context = (i: Inline) => {
  const me = account?.done && myUser()
  return {
    client: { platformType: narrow() || inApp ? 'mobile' : 'web', clientFid: QUILCAST_FID, added: false, safeAreaInsets: { top: 0, bottom: 0, left: 0, right: 0 }, inline: true },
    // none for someone not signed in
    ...(me && { user: userCtx(me) }),
    // none in the composer's preview
    ...(i.cast && { location: { type: 'cast_embed', embed: i.embed, cast: castCtx(i.cast) } }),
    features: { haptics: false },
  }
}

addEventListener('message', (e) => {
  const i = [...frames].find((x) => x.frame.contentWindow && x.frame.contentWindow === e.source)
  const c = i && e.origin === i.origin && parseCall(e.data)
  if (!i || !c) return
  const { name, type } = c
  answer(c.id, () =>
    !i.cast && !PREVIEW.has(name) ? Promise.reject(new Error(`${i.name} can't use ${name} in a preview.`))
      : type === 'GET' && name === 'context' ? context(i)
      : type === 'APPLY' && Object.hasOwn(calls, name) ? calls[name](i, ...c.args)
        : Promise.reject(new Error(`In the cast, ${i.name} can't use ${name}. Open the app for that.`)),
  // a card gives no answer for a result it can't send
  (m) => {
    try {
      i.frame.contentWindow?.postMessage(m, i.origin)
    } catch {}
  })
})
