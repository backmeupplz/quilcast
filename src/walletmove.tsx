// Sending and swapping from the Quilcast wallet. Swaps and bridges are one screen: LI.FI (keyless) compares DEX
// aggregators and bridges (Uniswap, KyberSwap, 1inch, Across, Stargate, Relay…) and returns one transaction to its own
// contract, which tokens.ts checks before anything is signed. Keys are decrypted from src/vault.ts only to sign.
import { useEffect, useState } from 'preact/hooks'
import { createPublicClient, createWalletClient, formatUnits, http, parseUnits, type Chain } from 'viem'
import { arbitrum, base, mainnet, optimism, polygon } from 'viem/chains'
import { getUser, type User } from './api.ts'
import { t } from './i18n.ts'
import { Icon, P, toast } from './ui.tsx'
import { allowance, approveTx, quote, tokensOn, transferStatus, transferTx, type ListedToken, type Quote } from './tokens.ts'
import { signerOf, type WalletEntry } from './vault.ts'
import { CHAINS, Coin, type Holding } from './walletui.tsx'

const VIEM: Record<number, Chain> = { 8453: base, 1: mainnet, 10: optimism, 42161: arbitrum, 137: polygon }
// our RPC per chain (viem's default for Polygon now wants a key)
const rpcOf = (chain: number) => CHAINS.find((c) => c.id === chain)!.rpc
const pub = (chain: number) => createPublicClient({ chain: VIEM[chain], transport: http(rpcOf(chain)) })
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const num = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: n >= 1 ? 4 : 6 })
const usd = (n?: number) => (n === undefined ? '' : n > 0 && n < 0.01 ? '< $0.01' : n.toLocaleString(undefined, { style: 'currency', currency: 'USD' }))
// a holding as the token helpers know it
const tid = (h: Holding) => ({ chain: h.chainId, address: h.address })
export const explorer = (chain: number, hash: string) => `${VIEM[chain].blockExplorers!.default.url}/tx/${hash}`

async function send(w: WalletEntry, chain: number, tx: { to: string; data?: string; value?: string; gas?: string }) {
  const client = createWalletClient({ account: await signerOf(w.id), chain: VIEM[chain], transport: http(rpcOf(chain)) })
  return client.sendTransaction({ chain: VIEM[chain], to: tx.to as `0x${string}`, data: tx.data as `0x${string}` | undefined, value: BigInt(tx.value || 0), ...(tx.gas && { gas: BigInt(tx.gas) }) })
}
const mined = (chain: number, hash: `0x${string}`) => pub(chain).waitForTransactionReceipt({ hash, timeout: 180e3 })

/** All of a coin minus what the network fee could cost (`gas` units at today's price, with room to spare). */
async function spendable(h: Holding, gas: bigint) {
  if (h.address) return h.raw
  const fee = (await pub(h.chainId).getGasPrice()) * gas * 2n
  const keep = fee > 10n ** 13n ? fee : 10n ** 13n
  return h.raw > keep ? h.raw - keep : 0n
}

/** An address, a Farcaster @username (their verified address) or an ENS name. */
async function recipient(s: string): Promise<{ address: `0x${string}`; who: string }> {
  s = s.trim()
  if (/^0x[0-9a-f]{40}$/i.test(s)) return { address: s.toLowerCase() as `0x${string}`, who: short(s) }
  if (!s.startsWith('@') && /^[a-z0-9-]+(\.[a-z0-9-]+)*\.eth$/i.test(s)) {
    const a = await pub(1).getEnsAddress({ name: s.toLowerCase() }).catch(() => null)
    if (!a) throw new Error(t('{name} has no address.', { name: s }))
    return { address: a.toLowerCase() as `0x${string}`, who: `${s} (${short(a)})` }
  }
  const name = s.replace(/^@/, '')
  if (!/^[a-z0-9][a-z0-9.-]{0,40}$/i.test(name)) throw new Error('Enter an address, an ENS name or a Farcaster @username.')
  const u = (await getUser(name).catch(() => null)) as (User & { verified_addresses?: { primary?: { eth_address?: string }; eth_addresses?: string[] } }) | null
  if (!u) throw new Error(t('No one goes by @{name}.', { name }))
  const a = u.verified_addresses?.primary?.eth_address || u.verified_addresses?.eth_addresses?.[0]
  if (!a) throw new Error(t('@{name} has no verified Ethereum address.', { name: u.username || name }))
  return { address: a.toLowerCase() as `0x${string}`, who: `@${u.username} (${short(a)})` }
}

type Done = { chain: number; hash: string; bridge?: { to: number } }

function Sheet({ title, close, back, children }: { title: string; close: () => void; back?: () => void; children: any }) {
  return (
    <div class="modal" onClick={(e) => e.target === e.currentTarget && close()}>
      <div class="sheet wallet-form mv">
        <div class="move-top">
          {back && <button type="button" class="icon-btn" aria-label={t('Back')} onClick={back}><Icon d={P.back} /></button>}
          <h2>{title}</h2>
          <button type="button" class="icon-btn" aria-label={t('Close')} onClick={close}><Icon d={P.x} /></button>
        </div>
        {children}
      </div>
    </div>
  )
}

/** Sends and swaps on their way, newest first, kept while the page is open, so they can still be followed once their
 *  sheet is closed (Quorum mode's wallet panel shows them). 'pending' fires when one moves on. */
export type Pending = Done & { from: string; label: string; state: string; over: boolean; failed?: boolean }
export const pending: Pending[] = []

function track(d: Done & { from: string; label: string }): Pending {
  const p: Pending = { ...d, state: t('Waiting for the network…'), over: false }
  pending.unshift(p)
  pending.splice(10)
  const set = (state: string, over = false, failed = false) => ((p.state = state), (p.over = over), (p.failed = failed), dispatchEvent(new Event('pending')))
  set(p.state)
  mined(d.chain, d.hash as `0x${string}`).then((r) => {
    if (r.status !== 'success') return set(t('The transaction failed on chain.'), true, true)
    if (!d.bridge) return set(t('Done.'), true)
    const to = VIEM[d.bridge.to].name
    set(t('Sent. Waiting for it to arrive on {chain}…', { chain: to }))
    // a bridge finishes on the other chain; LI.FI knows when (asked for up to an hour)
    const poll = async (left: number) => {
      const s = await transferStatus(d.hash, d.chain, d.bridge!.to).catch(() => ({ status: 'PENDING' }))
      if (s.status === 'DONE') set(t('Arrived on {chain}.', { chain: to }), true)
      else if (s.status === 'FAILED') set(t('The bridge reported a problem. Check the transaction on the explorer.'), true, true)
      else if (!left) set(t('Still waiting. Check the transaction on the explorer.'), true)
      else setTimeout(() => poll(left - 1), 10e3)
    }
    poll(360)
  }, () => set(t('Still waiting. Check the transaction on the explorer.'), true))
  return p
}

function Sent({ d, close }: { d: Pending; close: () => void }) {
  const [, force] = useState(0)
  useEffect(() => {
    const f = () => force((x) => x + 1)
    addEventListener('pending', f)
    return () => removeEventListener('pending', f)
  }, [])
  return (
    <div class="move-done">
      <p>{d.state}</p>
      <a class="btn ghost small" href={explorer(d.chain, d.hash)} target="_blank" rel="noopener noreferrer">{t('View on explorer')}</a>
      <button class="btn mv-go" onClick={close}>{t('Close')}</button>
    </div>
  )
}

const priceOf = (h: Holding) => (h.amount ? h.usd / h.amount : 0)
const coinOf = (h: Holding) => ({ chain: h.chainId, address: h.address, symbol: h.symbol, src: h.icon })
const amountNum = (v: string) => Number(v) || 0
const overOf = (v: string, h: Holding) => {
  try {
    return parseUnits(v.trim() || '0', h.decimals) > h.raw
  } catch {
    return false
  }
}

/** The token button inside a box: its logo and symbol, or a call to pick one. */
const TokenBtn = ({ c, open }: { c?: { chain: number; address?: string; symbol: string; src?: string }; open: () => void }) => (
  <button type="button" class={`mv-token${c ? '' : ' none'}`} onClick={open}>
    {c && <Coin {...c} />}<b>{c ? c.symbol : t('Select token')}</b><Icon d="M6 9l6 6 6-6" size={16} />
  </button>
)

/** What's paid or sent: a big amount, the token, its dollar value and the balance with a Max that leaves room for the fee. */
function PayBox({ label, h, value, set, gas, pick }: { label: string; h: Holding; value: string; set: (v: string) => void; gas: bigint; pick: () => void }) {
  const max = async () => set(formatUnits(await spendable(h, gas), h.decimals))
  const over = overOf(value, h)
  return (
    <div class={`mv-box${over ? ' over' : ''}`}>
      <span class="mv-label">{label}</span>
      <div class="mv-main">
        <input class="mv-amt" value={value} onInput={(e) => set(e.currentTarget.value.replace(',', '.'))} inputMode="decimal" placeholder="0" aria-label={t('Amount')} autoFocus />
        <TokenBtn c={coinOf(h)} open={pick} />
      </div>
      <div class="mv-sub">
        <span>{usd(amountNum(value) * priceOf(h)) || '$0.00'}</span>
        <span>{t('Balance: {n}', { n: num(h.amount) })}<button type="button" class="mv-max" onClick={max}>{t('Max')}</button></span>
      </div>
    </div>
  )
}

/** A list to pick from, inside the same sheet: a search box, optional chain chips, rows of tokens. */
function Pick<T>({ items, row, search, chains }: {
  items: T[] | null; row: (x: T) => { coin: Parameters<typeof Coin>[0]; name: string; right?: any; on?: boolean; pick: () => void }
  search: (x: T, term: string) => number; chains?: { value: number; set: (c: number) => void }
}) {
  const [q, setQ] = useState('')
  const term = q.trim().toLowerCase()
  // -1 hides a row; lower ranks come first
  const shown = (items || []).map((x, i) => ({ x, r: term ? search(x, term) : 0, i })).filter((a) => a.r >= 0).sort((a, b) => a.r - b.r || a.i - b.i).slice(0, 60)
  return (
    <div class="mv-pick">
      <input value={q} onInput={(e) => setQ(e.currentTarget.value)} placeholder={t('Search or paste an address')} aria-label={t('Search tokens')} autoFocus />
      {chains && (
        <div class="mv-chains">
          {CHAINS.map((c) => <button type="button" class={`chip${chains.value === c.id ? ' on' : ''}`} onClick={() => chains.set(c.id)}><img src={c.logo} alt="" referrerpolicy="no-referrer" />{c.name}</button>)}
        </div>
      )}
      <div class="mv-rows">
        {!items ? <div class="spinner" /> : !shown.length ? <p class="hint">{t('No tokens match.')}</p> : shown.map(({ x }) => {
          const r = row(x)
          return (
            <button type="button" class={`mv-row${r.on ? ' on' : ''}`} onClick={r.pick}>
              <Coin {...r.coin} />
              <span class="mv-row-main"><b>{r.coin.symbol}</b><small>{r.name}</small></span>
              {r.right && <span class="mv-row-right">{r.right}</span>}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** Holdings to send or sell, the biggest first (as the wallet lists them). */
const HoldingPick = ({ holdings, at, set }: { holdings: Holding[]; at: Holding; set: (i: number) => void }) => (
  <Pick items={holdings} row={(x) => ({
    coin: coinOf(x), name: `${x.name || x.symbol} · ${x.chain}`, on: x === at, pick: () => set(holdings.indexOf(x)),
    right: <>{usd(x.usd)}<small>{num(x.amount)}</small></>,
  })} search={(x, q) => (x.symbol.toLowerCase() === q || x.address === q ? 0 : x.symbol.toLowerCase().startsWith(q) ? 1 : x.symbol.toLowerCase().includes(q) || x.name.toLowerCase().includes(q) || x.chain.toLowerCase().includes(q) ? 2 : -1)} />
)

const amountOf = (v: string, h: Holding) => {
  let a: bigint
  try {
    a = parseUnits(v.trim() || '0', h.decimals)
  } catch {
    throw new Error('Enter an amount.')
  }
  if (a <= 0n) throw new Error('Enter an amount.')
  if (a > h.raw) throw new Error(t("That's more {symbol} than this wallet has.", { symbol: h.symbol }))
  return a
}

// --- send ---

export function SendSheet({ w, holdings, close, sent }: { w: WalletEntry; holdings: Holding[]; close: () => void; sent: () => void }) {
  const [i, setI] = useState(0)
  const [to, setTo] = useState('')
  const [amt, setAmt] = useState('')
  const [picking, setPicking] = useState(false)
  const [review, setReview] = useState<{ address: `0x${string}`; who: string; amount: bigint } | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<Pending | null>(null)
  const h = holdings[i]
  const check = async (e: Event) => {
    e.preventDefault()
    setBusy(true)
    try {
      const amount = amountOf(amt, h)
      setReview({ ...(await recipient(to)), amount })
    } catch (e: any) {
      toast(e.message)
    }
    setBusy(false)
  }
  const go = async () => {
    setBusy(true)
    try {
      setDone(track({ chain: h.chainId, hash: await send(w, h.chainId, transferTx(tid(h), review!.address, review!.amount)), from: w.address, label: t('Send {amount} {symbol}', { amount: num(Number(formatUnits(review!.amount, h.decimals))), symbol: h.symbol }) }))
      sent()
    } catch (e: any) {
      toast(e.shortMessage || e.message)
    }
    setBusy(false)
  }
  if (!holdings.length) return <Sheet title={t('Send')} close={close}><p class="hint">{t('This wallet has nothing to send yet.')}</p></Sheet>
  if (picking) return <Sheet title={t('Select token')} close={close} back={() => setPicking(false)}><HoldingPick holdings={holdings} at={h} set={(n) => (n !== i && (setI(n), setAmt('')), setPicking(false))} /></Sheet>
  const over = overOf(amt, h)
  return (
    <Sheet title={review && !done ? t('Review') : t('Send')} close={close} back={review && !done && !busy ? () => setReview(null) : undefined}>
      {done ? <Sent d={done} close={close} /> : review ? (
        <>
          <div class="mv-hero">
            <Coin {...coinOf(h)} />
            <b>{num(Number(formatUnits(review.amount, h.decimals)))} {h.symbol}</b>
            <span>{usd(Number(formatUnits(review.amount, h.decimals)) * priceOf(h))}</span>
          </div>
          <div class="mv-details">
            <div class="sign-row"><span>{t('To')}</span><b>{review.who}</b></div>
            <div class="sign-row"><span>{t('Network')}</span><b>{h.chain}</b></div>
            <div class="sign-row"><span>{t('From')}</span><b>{w.name} · {short(w.address)}</b></div>
          </div>
          <p class="hint">{t('Transactions can’t be undone. Check the address.')}</p>
          <button class="btn mv-go" onClick={go} disabled={busy}>{busy ? t('Sending…') : t('Send')}</button>
        </>
      ) : (
        <form class="move-form" onSubmit={check}>
          <PayBox label={t('You send')} h={h} value={amt} set={setAmt} gas={21000n} pick={() => setPicking(true)} />
          <label class="mv-box mv-to">
            <span class="mv-label">{t('To')}</span>
            <input value={to} onInput={(e) => setTo(e.currentTarget.value)} placeholder={t('0x…, name.eth or @username')} autocapitalize="off" autocorrect="off" spellcheck={false} />
          </label>
          <button class="btn mv-go" disabled={busy || !to.trim() || !amountNum(amt) || over}>
            {busy ? t('Checking…') : !amountNum(amt) ? t('Enter an amount') : over ? t('Not enough {symbol}', { symbol: h.symbol }) : !to.trim() ? t('Enter a recipient') : t('Review')}
          </button>
        </form>
      )}
    </Sheet>
  )
}

// --- swap and bridge ---

export function SwapSheet({ w, holdings, close, sent }: { w: WalletEntry; holdings: Holding[]; close: () => void; sent: () => void }) {
  const [i, setI] = useState(0)
  const [amt, setAmt] = useState('')
  const h = holdings[i]
  const [buy, setBuy] = useState<ListedToken | undefined>()
  // which list is open: what's paid, or what's bought (on the chain in its chips)
  const [picking, setPicking] = useState<'pay' | 'get' | null>(null)
  const [chain, setChain] = useState(h?.chainId || 8453)
  const [list, setList] = useState<ListedToken[] | null>(null)
  const [q, setQ] = useState<Quote | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState('')
  const [done, setDone] = useState<Pending | null>(null)
  // something sensible to buy at first: USDC, or the chain's coin when selling USDC
  useEffect(() => {
    if (!h) return
    tokensOn(h.chainId).then((l) => setBuy((b) => b || l.find((x) => x.symbol === (h.symbol === 'USDC' ? (h.chainId === 137 ? 'POL' : 'ETH') : 'USDC')) || l[0]), () => {})
  }, [])
  useEffect(() => void (picking === 'get' && (setList(null), tokensOn(chain).then(setList, () => setList([])))), [picking, chain])
  // a fresh quote a moment after the inputs settle
  useEffect(() => {
    setQ(null)
    setErr('')
    if (!h || !buy || !amountNum(amt)) return
    let amount: bigint
    try {
      amount = amountOf(amt, h)
    } catch (e: any) {
      return setErr(e.message)
    }
    if (buy.chain === h.chainId && buy.address === h.address) return setErr(t('Pick a different token to get.'))
    let live = true
    const timer = setTimeout(() => quote(tid(h), buy, amount, w.address).then((x) => live && setQ(x), (e) => live && setErr(e.message)), 500)
    return () => ((live = false), clearTimeout(timer))
  }, [i, amt, buy?.chain, buy?.address])
  const bridge = !!h && !!buy && buy.chain !== h.chainId
  // turning the pair around works when the wallet holds what it was buying
  const back = buy ? holdings.findIndex((x) => x.chainId === buy.chain && x.address === buy.address) : -1
  const flip = () => {
    if (back < 0) return
    setBuy({ chain: h.chainId, address: h.address, symbol: h.symbol, decimals: h.decimals, name: h.name, logo: h.icon, usd: priceOf(h) })
    setI(back)
    setAmt('')
  }
  const go = async () => {
    try {
      const amount = amountOf(amt, h)
      // a token needs an approval for exactly this amount first, to LI.FI's contract only
      if (h.address && (await allowance((m, p) => pub(h.chainId).request({ method: m as any, params: p as any }), tid(h), w.address)) < amount) {
        setBusy(t('Approving {symbol}…', { symbol: h.symbol }))
        await mined(h.chainId, await send(w, h.chainId, approveTx(tid(h), amount)))
      }
      setBusy(bridge ? t('Bridging…') : t('Swapping…'))
      // quotes go stale in a minute or two, so the one sent is fetched now
      const fresh = await quote(tid(h), buy!, amount, w.address)
      const hash = await send(w, h.chainId, fresh.tx)
      setDone(track({ chain: h.chainId, hash, ...(bridge && { bridge: { to: buy!.chain } }), from: w.address, label: t('Swap {amount} {from} for ≈ {got} {to}', { amount: num(Number(formatUnits(amount, h.decimals))), from: h.symbol, got: num(Number(formatUnits(fresh.toAmount, buy!.decimals))), to: buy!.symbol }) }))
      sent()
    } catch (e: any) {
      toast(e.shortMessage || e.message)
    }
    setBusy('')
  }
  const title = bridge ? t('Bridge') : t('Swap')
  if (!holdings.length) return <Sheet title={t('Swap')} close={close}><p class="hint">{t('This wallet has nothing to swap yet.')}</p></Sheet>
  if (picking === 'pay') return <Sheet title={t('You pay')} close={close} back={() => setPicking(null)}><HoldingPick holdings={holdings} at={h} set={(n) => (n !== i && (setI(n), setAmt('')), setPicking(null))} /></Sheet>
  if (picking === 'get') {
    const held = (x: ListedToken) => holdings.find((y) => y.chainId === x.chain && y.address === x.address)
    return (
      <Sheet title={t('You receive')} close={close} back={() => setPicking(null)}>
        <Pick items={list} chains={{ value: chain, set: setChain }} row={(x) => {
          const y = held(x)
          return { coin: { chain: x.chain, address: x.address, symbol: x.symbol, src: x.logo }, name: x.name, on: buy?.chain === x.chain && buy.address === x.address, pick: () => (setBuy(x), setPicking(null)), right: y && <>{usd(y.usd)}<small>{num(y.amount)}</small></> }
        }} search={(x, s) => (x.symbol.toLowerCase() === s || x.address === s ? 0 : x.symbol.toLowerCase().startsWith(s) ? 1 : x.symbol.toLowerCase().includes(s) || x.name.toLowerCase().includes(s) ? 2 : -1)} />
      </Sheet>
    )
  }
  const got = q && buy ? Number(formatUnits(q.toAmount, buy.decimals)) : 0
  const min = q && buy ? Number(formatUnits(q.toAmountMin, buy.decimals)) : 0
  const mins = q?.seconds ? Math.ceil(q.seconds / 60) : 0
  const finding = !!buy && !!amountNum(amt) && !q && !err
  return (
    <Sheet title={title} close={close}>
      {done ? <Sent d={done} close={close} /> : (
        <div class="move-form">
          <div class="mv-pair">
            <PayBox label={t('You pay')} h={h} value={amt} set={setAmt} gas={700000n} pick={() => setPicking('pay')} />
            <button type="button" class="mv-flip" onClick={flip} disabled={back < 0} aria-label={t('Swap the tokens around')}><Icon d="M12 5v14M5 12l7 7 7-7" size={18} /></button>
            <div class="mv-box">
              <span class="mv-label">{t('You receive')}</span>
              <div class="mv-main">
                <span class={`mv-amt${q ? '' : ' wait'}`}>{q ? num(got) : finding ? '…' : '0'}</span>
                <TokenBtn c={buy && { chain: buy.chain, address: buy.address, symbol: buy.symbol, src: buy.logo }} open={() => (setChain(buy?.chain || h.chainId), setPicking('get'))} />
              </div>
              <div class="mv-sub"><span>{q?.toUsd ? usd(q.toUsd) : ''}</span>{buy && <span>{CHAINS.find((c) => c.id === buy.chain)?.name}</span>}</div>
            </div>
          </div>
          {err && <p class="hint warn">{err}</p>}
          {q && buy && (
            <div class="mv-details">
              <div class="sign-row"><span>{t('Rate')}</span><b>1 {h.symbol} = {num(got / amountNum(amt))} {buy.symbol}</b></div>
              <div class="sign-row"><span>{t('At least')}</span><b>{num(min)} {buy.symbol}</b></div>
              {q.feesUsd !== undefined && <div class="sign-row"><span>{t('Network and route fees')}</span><b>{usd(q.feesUsd)}</b></div>}
              {q.tool && <div class="sign-row"><span>{t('Route')}</span><b>{q.tool}</b></div>}
              {bridge && <div class="sign-row"><span>{t('Arrives in about')}</span><b>{mins <= 1 ? t('a minute') : t('{n} minutes', { n: mins })}</b></div>}
            </div>
          )}
          <button class="btn mv-go" onClick={go} disabled={!q || !!busy}>
            {busy || (!buy ? t('Select token') : !amountNum(amt) ? t('Enter an amount') : overOf(amt, h) ? t('Not enough {symbol}', { symbol: h.symbol }) : err ? title : finding ? t('Finding the best route…') : title)}
          </button>
          <p class="hint mv-foot">{t('Routes come from LI.FI, which compares DEXes like Uniswap and KyberSwap and bridges like Across and Stargate.')}</p>
        </div>
      )}
    </Sheet>
  )
}
