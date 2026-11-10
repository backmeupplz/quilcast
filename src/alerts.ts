// Push notifications for your own accounts' activity (Settings → Notifications; server/alerts.mjs): replies, mentions,
// quotes, likes, recasts and follows reach this device with Quilcast closed. Each account is signed up with its own
// key, so nobody can sign up for someone else's, and picks its own kinds. What's on is kept here (api.ts alertsKept)
// with the subscription it was signed up with and the settings last sent, so a subscription the browser replaced, a
// changed language or spam setting, or a sign-up the server lost is sent again on the next start. Signing out turns it
// off (api.ts forgetAlerts).
import { accounts, ALERTS, alertsKept, flushAlertsOff, forgetAlerts, read, save, settings, type Account } from './api.ts'
import { lang } from './i18n.ts'
import { spamAt } from './spam.ts'
import { APP_PUSH, pushSubscription } from './ui.tsx'

export const KINDS = ['replies', 'mentions', 'quotes', 'likes', 'recasts', 'follows'] as const
export type Kind = (typeof KINDS)[number]
const kindsOf = (xs: unknown): Kind[] => (Array.isArray(xs) ? KINDS.filter((k) => xs.includes(k)) : [...KINDS])

/** Whether this browser can get push notifications at all (not in iOS Safari outside the Home Screen, nor in our apps). */
export const canPush = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
const current = async () => (await navigator.serviceWorker?.getRegistration('/sw.js'))?.pushManager.getSubscription() ?? null

/** The accounts that get them here, with their kinds: signed up with the subscription this browser still has. */
export async function alertsOn() {
  const sub = await current().catch(() => null)
  return new Map(Object.entries(alertsKept().on).flatMap(([fid, v]): [number, Kind[]][] => (sub && v.endpoint === sub.endpoint ? [[Number(fid), kindsOf(v.kinds)]] : [])))
}

// what the server is told besides the subscription; the spam this browser hides (Settings → Spam) stays out too
const settingsFor = (kinds: Kind[]) => ({ kinds, lang, spam: { casts: settings.spam === 'hide', accounts: settings.spamAccounts === 'hide', at: spamAt() } })

async function signUp(a: Account, sub: PushSubscription, kinds: Kind[], background: boolean) {
  const s = settingsFor(kinds)
  await import('./write.ts').then((m) => m.saveAlerts(a, JSON.stringify({ subscription: sub.toJSON(), ...s }), background))
  const k = alertsKept()
  save(ALERTS, { ...k, on: { ...k.on, [a.fid!]: { endpoint: sub.endpoint, kinds, sent: JSON.stringify(s) } } })
}

/** Turn `a`'s notifications on (with the kinds it had, else all) or off for this browser. From a click: ask for the
 *  permission (askPush) first. */
export async function setAlerts(a: Account, on: boolean) {
  if (!on) return forgetAlerts(a.fid)
  // from before mini apps' push had its own flag, a subscription meant they were on: that stays so once alerts use it too
  if (read<boolean | null>(APP_PUSH, null) === null) save(APP_PUSH, !!(await current().catch(() => null)))
  await signUp(a, await pushSubscription(), kindsOf(alertsKept().on[a.fid!]?.kinds), false)
}

/** New kinds for `a`, from a click. */
export async function setKinds(a: Account, kinds: Kind[]) {
  const sub = await current()
  if (sub) await signUp(a, sub, kinds, false)
}

let spamTimer: ReturnType<typeof setTimeout> | undefined
/** The spam settings changed: every account on here is told, once the slider stops. */
export const spamChanged = () => {
  clearTimeout(spamTimer)
  spamTimer = setTimeout(() => refreshAlerts().catch(() => {}), 1500)
}

/** On each start (and when settings change): sign-outs still waiting go out, accounts this browser no longer holds
 *  go, and an account whose subscription the browser replaced, whose settings changed or that the server lost is
 *  signed up again. In the background, so only with the key each account has now. */
export async function refreshAlerts() {
  await flushAlertsOff()
  if (!canPush() || Notification.permission !== 'granted') return
  const sub = await current().catch(() => null)
  for (const [fid, v] of Object.entries(alertsKept().on)) {
    const a = accounts.find((x) => x.done && x.fid === Number(fid))
    if (!a) {
      await forgetAlerts(Number(fid))
      continue
    }
    if (!sub) continue
    const kinds = kindsOf(v.kinds)
    if (v.endpoint === sub.endpoint && v.sent === JSON.stringify(settingsFor(kinds))) {
      // the server's answer is null once it dropped the sign-up, and other settings when it lost a change; a failed
      // request leaves it be
      const known = await fetch(`/api/alerts/${fid}/state`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: v.endpoint }) }).then((r) => (r.ok ? r.json() : true), () => true)
      if (known === true || (known && JSON.stringify(known) === v.sent)) continue
    }
    if (!(await import('./write.ts')).hasKey(a)) continue
    // a replaced subscription: the server stops pushing to the old one
    if (v.endpoint !== sub.endpoint) {
      const k = alertsKept()
      save(ALERTS, { ...k, off: [...k.off.filter(([f, e]) => f !== Number(fid) || e !== v.endpoint), [Number(fid), v.endpoint]] })
      // before the new one, which the server could refuse while the account has as many browsers as it takes
      await flushAlertsOff()
    }
    await signUp(a, sub, kinds, true).catch(() => {})
  }
}
