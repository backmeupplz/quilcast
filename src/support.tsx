// A profile's Supporters tab: tip or join them through Sendclap (walletmove.tsx support), who supports them and whom
// they support. Sendclap keeps the records (sendclap.com/api/v1/farcaster/<fid>); a page there is made on the first payment.
import { useEffect, useState } from 'preact/hooks'
import { account, loadUsers, users, type User } from './api.ts'
import { t } from './i18n.ts'
import { handle, requireAccount, shell, toast, UserRow } from './ui.tsx'
import { SENDCLAP } from './write.ts'

type Row = { fid: number; tier: string | null; monthly_cents: number; tips_cents: number; sub_id: number | null; wallet: string | null }
type Info = { page: string | null; contract: `0x${string}`; tiers: { name: string; description: string; price: number }[]; supporters: Row[]; supporting: Row[] }

const TIPS = [1, 5, 20]
const dollars = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
const what = (r: Row) => [
  r.tier && t('{tier} · {price}/mo', { tier: r.tier, price: dollars(r.monthly_cents / 100) }),
  r.tips_cents > 0 && t('Tipped {amount}', { amount: dollars(r.tips_cents / 100) }),
].filter(Boolean).join(' · ')

export function SupportTab({ u, self }: { u: User; self: boolean }) {
  const [info, setInfo] = useState<Info | null | false>(null)
  const [round, setRound] = useState(0)
  // a payment takes two taps (the first arms it), since the Quilcast wallet signs without asking
  const [armed, setArmed] = useState('')
  const [busy, setBusy] = useState('')
  useEffect(() => {
    let live = true
    setInfo(null)
    fetch(`${SENDCLAP}/api/v1/farcaster/${u.fid}`).then((r) => (r.ok ? r.json() : Promise.reject())).then(async (j: Info) => {
      await loadUsers([...j.supporters, ...j.supporting].slice(0, 100).map((r) => r.fid))
      if (live) setInfo(j)
    }).catch(() => live && setInfo(false))
    return () => void (live = false)
  }, [u.fid, round])

  const act = async (key: string, run: () => Promise<unknown>, done: string) => {
    if (busy || !requireAccount()) return
    if (armed !== key) return setArmed(key)
    setArmed('')
    setBusy(key)
    try {
      await run()
      shell.toast(done)
      setRound((r) => r + 1)
    } catch (e: any) {
      toast(e.message)
    } finally {
      setBusy('')
    }
  }
  const wm = () => import('./walletmove.tsx')
  const name = handle(u)
  const pay = (key: string, label: string, ask: string, run: () => Promise<unknown>, done: string, cls = 'btn small') => (
    <button type="button" class={`${cls}${armed === key ? ' armed' : ''}`} disabled={!!busy} onClick={() => act(key, run, done)}>
      {busy === key ? t('Paying…') : armed === key ? ask : label}
    </button>
  )

  if (info === null) return <div class="spinner" />
  if (!info) return <div class="note">{t("Couldn't load supporters. Try again later.")}</div>
  const list = (rows: Row[], mine: boolean) => rows.filter((r) => users.has(r.fid)).map((r) => (
    <UserRow u={users.get(r.fid)!} action={
      <span class="support-what">
        {what(r)}
        {mine && r.sub_id && (
          <button type="button" class="link-btn" disabled={!!busy} onClick={() => act(`c${r.sub_id}`, () => wm().then((m) => m.cancelSupport(info.contract, r.sub_id!, r.wallet)), t('Membership canceled.'))}>
            {armed === `c${r.sub_id}` ? t('Cancel it?') : t('Cancel')}
          </button>
        )}
      </span>
    } />
  ))

  return (
    <div class="support">
      {!self && (
        <section class="support-offer">
          <p class="note">{t('Support @{name} with USDC on Base. It goes straight to their wallet through Sendclap, which keeps 1%.', { name })}</p>
          <div class="support-btns">
            {info.tiers.map((tier) => pay(`m${tier.name}`, t('{tier} · {price}/mo', { tier: tier.name, price: dollars(tier.price) }), t('Join for {price} a month?', { price: dollars(tier.price) }),
              () => wm().then((m) => m.support(u, { type: 'membership', tier: tier.name }, t('Join @{name}', { name }))), t('You support @{name} now.', { name })))}
          </div>
          <div class="support-btns">
            {TIPS.map((a) => pay(`t${a}`, t('Tip {amount}', { amount: dollars(a) }), t('Send {amount}?', { amount: dollars(a) }),
              () => wm().then((m) => m.support(u, { type: 'tip', amount: a }, t('Tip @{name} {amount}', { name, amount: dollars(a) }))), t('Tipped @{name} {amount}', { name, amount: dollars(a) }), 'btn ghost small'))}
          </div>
        </section>
      )}
      <h3 class="support-h">{t('Supporters')}</h3>
      {info.supporters.length ? list(info.supporters, false) : <div class="note">{t('No supporters yet.')}</div>}
      <h3 class="support-h">{t('Supporting')}</h3>
      {info.supporting.length ? list(info.supporting, self && account?.fid === u.fid) : <div class="note">{t('Not supporting anyone yet.')}</div>}
      {info.page && <p class="note"><a href={info.page} target="_blank" rel="noopener noreferrer">{t('@{name} on Sendclap', { name })}</a></p>}
    </div>
  )
}
