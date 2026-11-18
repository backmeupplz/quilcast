// A profile's Supporters tab: join a tier or tip through Sendclap (walletmove.tsx support), who supports them and whom
// they support, and casts that share it. Sendclap keeps the records (sendclap.com/api/v1/farcaster/<fid>); a page there
// is made on the first payment.
import { useEffect, useState } from 'preact/hooks'
import { account, loadUsers, users, type User } from './api.ts'
import { t, tn } from './i18n.ts'
import { Avatar, handle, Icon, nameOf, P, requireAccount, shell, toast, userPath } from './ui.tsx'
import { SENDCLAP } from './write.ts'

type Row = { fid: number; tier: string | null; monthly_cents: number; tips_cents: number; sub_id: number | null; wallet: string | null }
type Tier = { name: string; description: string; price: number; interval: string }
type Info = { page: string | null; claimed: boolean; tiers: Tier[]; supporters: Row[]; supporting: Row[] }

/** Your own Sendclap page: claim it with an email (Sendclap mails a link) to log in there and change the page, tiers and
 *  payout wallet; once claimed, a way there. */
function Claim({ claimed }: { claimed: boolean }) {
  const [email, setEmail] = useState('')
  const [state, setState] = useState<'' | 'busy' | 'sent'>('')
  if (claimed) return <p class="sp-claim">{t('Your Sendclap page is yours to edit.')} <a href={`${SENDCLAP}/dashboard`} target="_blank" rel="noopener noreferrer">{t('Open the dashboard')}</a></p>
  if (state === 'sent') return <p class="sp-claim">{t('Check {email} for a link to claim your Sendclap page.', { email })}</p>
  const send = (e: Event) => {
    e.preventDefault()
    setState('busy')
    import('./write.ts').then((w) => w.sendclapClaim(email.trim())).then(() => setState('sent'), (err) => (toast(err.message), setState('')))
  }
  return (
    <form class="sp-claim" onSubmit={send}>
      <p>{t('Claim your Sendclap page to log in there, see every payment and change your tiers or the wallet that gets paid.')}</p>
      <span class="sp-claim-row">
        <input type="email" required value={email} placeholder="you@example.com" aria-label={t('Email')} autoComplete="email" onInput={(e) => setEmail(e.currentTarget.value)} />
        <button type="submit" class="btn ghost small" disabled={state === 'busy'}>{t('Send link')}</button>
      </span>
    </form>
  )
}

const TIPS = [1, 5, 20]
const dollars = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
const perMonth = (cents: number) => t('{price}/mo', { price: dollars(cents / 100) })
// Sendclap's standard tiers, in the reader's language; a tier named otherwise shows as it is
const STANDARD: Record<string, () => [string, string]> = {
  Fan: () => [t('Fan'), t('A small thank-you every month.')],
  Supporter: () => [t('Supporter'), t('Keep the casts coming.')],
  Patron: () => [t('Patron'), t('Back their work in a big way.')],
}
const tierName = (name: string) => STANDARD[name]?.()[0] ?? name
const tierText = (tier: Tier) => STANDARD[tier.name]?.()[1] ?? tier.description
const okTip = (v: string) => /^\d{1,5}(\.\d{1,2})?$/.test(v.trim()) && Number(v) >= 1 && Number(v) <= 10000

/** A cast about supporting `who`, with their profile's Supporters tab as its link. */
const shareCast = (who: User, text: string) => shell.compose({ text, embeds: [`${location.origin}${userPath(who)}?tab=supporters`] })
// says the tier, and tells readers they can do the same for anyone
const supportLine = (who: User, r: Pick<Row, 'tier' | 'tips_cents' | 'monthly_cents'>) => `${r.tier
  ? t('I support @{name} as a {tier} ({price}/mo) 👏', { name: handle(who), tier: tierName(r.tier), price: dollars(r.monthly_cents / 100) })
  : t('I tipped @{name} {amount} 👏', { name: handle(who), amount: dollars(r.tips_cents / 100) })}\n\n${t('You can support anyone on Farcaster too: open their profile on Quilcast and pick Supporters.')}`

export function SupportTab({ u, self }: { u: User; self: boolean }) {
  const [info, setInfo] = useState<Info | null | false>(null)
  const [round, setRound] = useState(0)
  // a payment takes two taps (the first arms it for a few seconds), since the Quilcast wallet signs without asking
  const [armed, setArmed] = useState('')
  const [busy, setBusy] = useState('')
  const [custom, setCustom] = useState('')
  // the cast offered right after a payment
  const [paid, setPaid] = useState('')
  useEffect(() => {
    let live = true
    setInfo(null)
    fetch(`${SENDCLAP}/api/v1/farcaster/${u.fid}`).then((r) => (r.ok ? r.json() : Promise.reject())).then(async (j: Info) => {
      await loadUsers([...j.supporters, ...j.supporting].slice(0, 100).map((r) => r.fid))
      if (live) setInfo(j)
    }).catch(() => live && setInfo(false))
    return () => void (live = false)
  }, [u.fid, round])

  const act = async (key: string, run: () => Promise<unknown>, done: string, share = '') => {
    if (busy || !requireAccount()) return
    if (armed !== key) {
      setArmed(key)
      setTimeout(() => setArmed((a) => (a === key ? '' : a)), 4000)
      return
    }
    setArmed('')
    setBusy(key)
    try {
      await run()
      shell.toast(done)
      setPaid(share)
      setRound((r) => r + 1)
    } catch (e: any) {
      toast(e.message)
    } finally {
      setBusy('')
    }
  }
  const wm = () => import('./walletmove.tsx')
  const name = handle(u)
  const label = (key: string, idle: string, ask: string) => (busy === key ? t('Paying…') : armed === key ? ask : idle)
  const btn = (key: string, idle: string, ask: string, run: () => Promise<unknown>, done: string, cls: string, share = '') => (
    <button type="button" class={`${cls}${armed === key ? ' armed' : ''}`} disabled={!!busy && busy !== key} onClick={() => act(key, run, done, share)}>{label(key, idle, ask)}</button>
  )

  if (info === null) return <div class="spinner" />
  if (!info) return <p class="sp-empty">{t("Couldn't load supporters. Try again later.")}</p>
  const cancel = (r: Row, cls = 'link-btn') => r.sub_id && btn(`c${r.sub_id}`, t('Cancel'), t('Cancel it?'), () => wm().then((m) => m.cancelSupport(r.sub_id!, r.wallet)), t('Membership canceled.'), cls)
  const mine = !self && account?.fid ? info.supporters.find((r) => r.fid === account!.fid) : undefined
  const monthly = info.supporters.reduce((s, r) => s + r.monthly_cents, 0)
  const summary = [tn(info.supporters.length, '{n} supporter', '{n} supporters'), monthly > 0 && perMonth(monthly)].filter(Boolean).join(' · ')
  const rank = (tier: string | null) => info.tiers.findIndex((x) => x.name === tier)
  const tip = (amount: number, key: string, idle: string, cls: string) => btn(key, idle, t('Send {amount}?', { amount: dollars(amount) }),
    () => wm().then((m) => m.support(u, { type: 'tip', amount }, t('Tip @{name} {amount}', { name, amount: dollars(amount) }))),
    t('Tipped @{name} {amount}', { name, amount: dollars(amount) }), cls, supportLine(u, { tier: null, tips_cents: amount * 100, monthly_cents: 0 }))

  const row = (r: Row, own: boolean) => {
    const p = users.get(r.fid)!
    const sub = [r.tier && perMonth(r.monthly_cents), r.tips_cents > 0 && t('Tipped {amount}', { amount: dollars(r.tips_cents / 100) })].filter(Boolean).join(' · ')
    return (
      <div class="row has-action sp-row">
        <a class="row-link" href={userPath(p)}>
          <Avatar u={p} link={false} />
          <span class="row-main">
            <span class="row-top"><b>{nameOf(p)}</b><span class="handle">@{handle(p)}</span></span>
            <span class="row-sub">{sub}</span>
          </span>
        </a>
        {r.tier && <span class={`sp-badge sp-t${rank(r.tier)}`}>{tierName(r.tier)}</span>}
        {own && (
          <span class="sp-acts">
            <button type="button" class="icon-btn" aria-label={t('Share as a cast')} title={t('Share as a cast')} onClick={() => shareCast(p, supportLine(p, r))}><Icon d={P.share} size={18} /></button>
            {cancel(r)}
          </span>
        )}
      </div>
    )
  }

  return (
    <div class="sp">
      <section class="sp-offer">
        <div class="sp-head">
          <h3>{self ? t('Your supporters') : t('Support @{name}', { name })}</h3>
          <span class="sp-sum">{summary}</span>
        </div>
        {paid && (
          <div class="sp-paid">
            <span>{t('Done.')}</span>
            <button type="button" class="btn small" onClick={() => (shareCast(u, paid), setPaid(''))}>{t('Share as a cast')}</button>
          </div>
        )}
        {self ? (
          <>
            <div class="sp-ask">
              <p>{t('Anyone can join your tiers or tip you here, in USDC on Base.')}</p>
              <button type="button" class="btn small" onClick={() => shareCast(u, t('You can support me on Quilcast 👏'))}>{t('Ask for support')}</button>
            </div>
            <Claim claimed={info.claimed} />
          </>
        ) : (
          <>
            <div class="sp-tiers">
              {info.tiers.map((tier, i) => {
                const on = mine?.tier === tier.name
                return (
                  <div class={`sp-tier sp-t${i}${on ? ' on' : ''}`}>
                    <span class="sp-tname">{tierName(tier.name)}</span>
                    <b class="sp-price">{perMonth(tier.price * 100)}</b>
                    <span class="sp-desc">{tierText(tier)}</span>
                    {on ? (
                      <span class="sp-mine">
                        <span class="sp-joined"><Icon d={P.check} size={16} />{t('Joined')}</span>
                        <button type="button" class="link-btn" onClick={() => shareCast(u, supportLine(u, mine!))}>{t('Share')}</button>
                        {cancel(mine!)}
                      </span>
                    ) : btn(`m${tier.name}`, mine?.tier ? t('Switch') : t('Join'), t('Join for {price} a month?', { price: dollars(tier.price) }),
                      // switching joins the new tier first, then ends the old one, so there's no gap
                      () => wm().then(async (m) => {
                        await m.support(u, { type: 'membership', tier: tier.name }, t('Join @{name}', { name }), tier)
                        if (mine?.sub_id) await m.cancelSupport(mine.sub_id, mine.wallet)
                      }), t('You support @{name} now.', { name }), 'btn small', supportLine(u, { tier: tier.name, tips_cents: 0, monthly_cents: tier.price * 100 }))}
                  </div>
                )
              })}
            </div>
            <div class="sp-tips">
              <span class="sp-label">{t('Send a tip')}</span>
              {TIPS.map((a) => tip(a, `t${a}`, dollars(a), 'btn ghost small'))}
              <span class="sp-custom">
                <input inputMode="decimal" placeholder="$" value={custom} aria-label={t('Other amount')} onInput={(e) => setCustom(e.currentTarget.value.replace(',', '.').replace(/^\$/, ''))} />
                {okTip(custom) ? tip(Number(custom), `t${custom}`, t('Tip'), 'btn ghost small') : <button type="button" class="btn ghost small" disabled>{t('Tip')}</button>}
              </span>
            </div>
          </>
        )}
        {(!self || info.page) && (
          <p class="sp-fine">
            {!self && t('USDC on Base, straight to their wallet. Sendclap keeps 1%.')}
            {!self && info.page && ' · '}
            {info.page && <a href={info.page} target="_blank" rel="noopener noreferrer">{t('@{name} on Sendclap', { name })}</a>}
          </p>
        )}
      </section>
      <h3 class="sp-h">{t('Supporters')}<span>{info.supporters.length || ''}</span></h3>
      {info.supporters.filter((r) => users.has(r.fid)).map((r) => row(r, false))}
      {!info.supporters.length && <p class="sp-empty">{self ? t('No supporters yet.') : t('Be the first to support @{name}.', { name })}</p>}
      <h3 class="sp-h">{t('Supporting')}<span>{info.supporting.length || ''}</span></h3>
      {info.supporting.filter((r) => users.has(r.fid)).map((r) => row(r, self && account?.fid === u.fid))}
      {self ? <p class="sp-empty">{t('To support someone, open their profile and pick Supporters.')}</p>
        : !info.supporting.length && <p class="sp-empty">{t('Not supporting anyone yet.')}</p>}
    </div>
  )
}
