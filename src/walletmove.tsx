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
import { CHAINS, type Holding } from './walletui.tsx'

const VIEM: Record<number, Chain> = { 8453: base, 1: mainnet, 10: optimism, 42161: arbitrum, 137: polygon }
// our RPC per chain (viem's default for Polygon now wants a key)
const rpcOf = (chain: number) => CHAINS.find((c) => c.id === chain)!.rpc
const pub = (chain: number) => createPublicClient({ chain: VIEM[chain], transport: http(rpcOf(chain)) })
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const label = (h: Holding) => `${h.symbol} · ${h.chain} (${num(h.amount)})`
const num = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: n >= 1 ? 4 : 6 })
const usd = (n?: number) => (n === undefined ? '' : n > 0 && n < 0.01 ? '< $0.01' : n.toLocaleString(undefined, { style: 'currency', currency: 'USD' }))
// a holding as the token helpers know it
const tid = (h: Holding) => ({ chain: h.chainId, address: h.address })
const explorer = (chain: number, hash: string) => `${VIEM[chain].blockExplorers!.default.url}/tx/${hash}`

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

function Sheet({ title, close, children }: { title: string; close: () => void; children: any }) {
  return (
    <div class="modal" onClick={(e) => e.target === e.currentTarget && close()}>
      <div class="sheet wallet-form">
        <div class="move-top"><h2>{title}</h2><button type="button" class="icon-btn" aria-label={t('Close')} onClick={close}><Icon d={P.x} /></button></div>
        {children}
      </div>
    </div>
  )
}

function Sent({ d, close }: { d: Done; close: () => void }) {
  const [state, setState] = useState(t('Waiting for the network…'))
  useEffect(() => {
    let live = true
    mined(d.chain, d.hash as `0x${string}`).then((r) => {
      if (!live) return
      if (r.status !== 'success') return setState(t('The transaction failed on chain.'))
      if (!d.bridge) return setState(t('Done.'))
      setState(t('Sent. Waiting for it to arrive on {chain}…', { chain: VIEM[d.bridge.to].name }))
      // a bridge finishes on the other chain; LI.FI knows when
      const poll = async () => {
        const s = await transferStatus(d.hash, d.chain, d.bridge!.to).catch(() => ({ status: 'PENDING' }))
        if (!live) return
        if (s.status === 'DONE') setState(t('Arrived on {chain}.', { chain: VIEM[d.bridge!.to].name }))
        else if (s.status === 'FAILED') setState(t('The bridge reported a problem. Check the transaction on the explorer.'))
        else setTimeout(poll, 10e3)
      }
      poll()
    }, () => live && setState(t('Still waiting. Check the transaction on the explorer.')))
    return () => void (live = false)
  }, [d.hash])
  return (
    <div class="move-done">
      <p>{state}</p>
      <a class="btn ghost small" href={explorer(d.chain, d.hash)} target="_blank" rel="noopener noreferrer">{t('View on explorer')}</a>
      <button class="btn" onClick={close}>{t('Close')}</button>
    </div>
  )
}

/** Amount field with a Max button that leaves room for the fee. */
function Amount({ h, value, set, gas }: { h?: Holding; value: string; set: (v: string) => void; gas: bigint }) {
  const max = async () => h && set(formatUnits(await spendable(h, gas), h.decimals))
  return (
    <div class="move-amount">
      <input value={value} onInput={(e) => set(e.currentTarget.value.replace(',', '.'))} inputMode="decimal" placeholder="0.0" aria-label={t('Amount')} />
      <button type="button" class="btn ghost small" onClick={max} disabled={!h}>{t('Max')}</button>
    </div>
  )
}

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
  const [review, setReview] = useState<{ address: `0x${string}`; who: string; amount: bigint } | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<Done | null>(null)
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
      setDone({ chain: h.chainId, hash: await send(w, h.chainId, transferTx(tid(h), review!.address, review!.amount)) })
      sent()
    } catch (e: any) {
      toast(e.shortMessage || e.message)
    }
    setBusy(false)
  }
  if (!holdings.length) return <Sheet title={t('Send')} close={close}><p class="hint">{t('This wallet has nothing to send yet.')}</p></Sheet>
  return (
    <Sheet title={t('Send')} close={close}>
      {done ? <Sent d={done} close={close} /> : review ? (
        <>
          <div class="sign-preview">
            <div class="sign-row"><span>{t('Amount')}</span><b>{formatUnits(review.amount, h.decimals)} {h.symbol}</b></div>
            <div class="sign-row"><span>{t('Network')}</span><b>{h.chain}</b></div>
            <div class="sign-row"><span>{t('To')}</span><b>{review.who}</b></div>
            <div class="sign-row"><span>{t('From')}</span><b>{w.name} · {short(w.address)}</b></div>
          </div>
          <p class="hint">{t('Transactions can’t be undone. Check the address.')}</p>
          <div class="sheet-btns">
            <button class="btn ghost" onClick={() => setReview(null)} disabled={busy}>{t('Back')}</button>
            <button class="btn" onClick={go} disabled={busy}>{busy ? t('Sending…') : t('Send')}</button>
          </div>
        </>
      ) : (
        <form class="move-form" onSubmit={check}>
          <label>{t('Token')}<select value={i} onChange={(e) => (setI(Number(e.currentTarget.value)), setAmt(''))}>{holdings.map((x, n) => <option value={n}>{label(x)}</option>)}</select></label>
          <label>{t('To')}<input value={to} onInput={(e) => setTo(e.currentTarget.value)} placeholder={t('0x…, name.eth or @username')} autocapitalize="off" autocorrect="off" spellcheck={false} /></label>
          <label>{t('Amount ({symbol})', { symbol: h.symbol })}<Amount h={h} value={amt} set={setAmt} gas={21000n} /></label>
          <div class="sheet-btns"><button class="btn" disabled={busy || !to.trim() || !amt}>{busy ? t('Checking…') : t('Review')}</button></div>
        </form>
      )}
    </Sheet>
  )
}

// --- swap and bridge ---

function TokenPick({ chain, value, set }: { chain: number; value?: ListedToken; set: (t: ListedToken) => void }) {
  const [list, setList] = useState<ListedToken[] | null>(null)
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  useEffect(() => void tokensOn(chain).then(setList, () => setList([])), [chain])
  const term = q.trim().toLowerCase()
  // the exact symbol first, then symbols starting with it, then the rest
  const rank = (x: ListedToken) => (x.symbol.toLowerCase() === term || x.address === term ? 0 : x.symbol.toLowerCase().startsWith(term) ? 1 : 2)
  const shown = (list || []).filter((x) => !term || x.symbol.toLowerCase().includes(term) || x.name.toLowerCase().includes(term) || x.address === term).sort((a, b) => rank(a) - rank(b)).slice(0, 40)
  return (
    <div class="token-pick">
      <button type="button" class="token-choice" onClick={() => setOpen(!open)} aria-expanded={open}>
        {value?.logo ? <img class="token-icon" src={value.logo} alt="" referrerpolicy="no-referrer" /> : <span class="token-icon">{value?.symbol[0] || '?'}</span>}
        <b>{value?.symbol || t('Pick a token')}</b><Icon d="M6 9l6 6 6-6" size={16} />
      </button>
      {open && (
        <div class="token-list">
          <input value={q} onInput={(e) => setQ(e.currentTarget.value)} placeholder={t('Search or paste an address')} aria-label={t('Search tokens')} autoFocus />
          {!list ? <div class="spinner" /> : shown.map((x) => (
            <button type="button" class="token-opt" onClick={() => (set(x), setOpen(false), setQ(''))}>
              {x.logo ? <img class="token-icon" src={x.logo} alt="" loading="lazy" referrerpolicy="no-referrer" /> : <span class="token-icon">{x.symbol[0]}</span>}
              <span><b>{x.symbol}</b><small>{x.name}</small></span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function SwapSheet({ w, holdings, close, sent }: { w: WalletEntry; holdings: Holding[]; close: () => void; sent: () => void }) {
  const [i, setI] = useState(0)
  const [amt, setAmt] = useState('')
  const h = holdings[i]
  const [toChain, setToChain] = useState(h?.chainId || 8453)
  const [buy, setBuy] = useState<ListedToken | undefined>()
  const [q, setQ] = useState<Quote | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState('')
  const [done, setDone] = useState<Done | null>(null)
  // something sensible to buy: USDC, or the chain's coin when selling USDC
  useEffect(() => {
    setBuy(undefined)
    tokensOn(toChain).then((l) => setBuy((b) => b || l.find((x) => x.symbol === (h?.symbol === 'USDC' && toChain === h.chainId ? (toChain === 137 ? 'POL' : 'ETH') : 'USDC')) || l[0]), () => {})
  }, [toChain])
  // a fresh quote a moment after the inputs settle
  useEffect(() => {
    setQ(null)
    setErr('')
    if (!h || !buy || !amt) return
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
      setDone({ chain: h.chainId, hash, ...(bridge && { bridge: { to: buy!.chain } }) })
      sent()
    } catch (e: any) {
      toast(e.shortMessage || e.message)
    }
    setBusy('')
  }
  const title = bridge ? t('Bridge') : t('Swap')
  if (!holdings.length) return <Sheet title={t('Swap')} close={close}><p class="hint">{t('This wallet has nothing to swap yet.')}</p></Sheet>
  const got = q && buy ? Number(formatUnits(q.toAmount, buy.decimals)) : 0
  const min = q && buy ? Number(formatUnits(q.toAmountMin, buy.decimals)) : 0
  const mins = q?.seconds ? Math.ceil(q.seconds / 60) : 0
  return (
    <Sheet title={title} close={close}>
      {done ? <Sent d={done} close={close} /> : (
        <div class="move-form">
          <label>{t('You pay')}<select value={i} onChange={(e) => (setI(Number(e.currentTarget.value)), setAmt(''), setToChain(holdings[Number(e.currentTarget.value)].chainId))}>{holdings.map((x, n) => <option value={n}>{label(x)}</option>)}</select></label>
          <Amount h={h} value={amt} set={setAmt} gas={700000n} />
          <label>{t('You get, on')}<select value={toChain} onChange={(e) => setToChain(Number(e.currentTarget.value))}>{CHAINS.map((c) => <option value={c.id}>{c.name}</option>)}</select></label>
          <TokenPick chain={toChain} value={buy} set={setBuy} />
          {err ? <p class="hint warn">{err}</p> : amt && buy && !q ? <p class="hint">{t('Finding the best route…')}</p> : q && buy && (
            <div class="sign-preview">
              <div class="sign-row"><span>{t('You get about')}</span><b>{num(got)} {buy.symbol} {q.toUsd ? `(${usd(q.toUsd)})` : ''}</b></div>
              <div class="sign-row"><span>{t('At least')}</span><b>{num(min)} {buy.symbol}</b></div>
              {q.tool && <div class="sign-row"><span>{t('Route')}</span><b>{q.tool}</b></div>}
              {q.feesUsd !== undefined && <div class="sign-row"><span>{t('Network and route fees')}</span><b>{usd(q.feesUsd)}</b></div>}
              {bridge && <div class="sign-row"><span>{t('Arrives in about')}</span><b>{mins <= 1 ? t('a minute') : t('{n} minutes', { n: mins })}</b></div>}
            </div>
          )}
          <p class="hint">{t('Routes come from LI.FI, which compares DEXes like Uniswap and KyberSwap and bridges like Across and Stargate.')}</p>
          <div class="sheet-btns"><button class="btn" onClick={go} disabled={!q || !!busy}>{busy || title}</button></div>
        </div>
      )}
    </Sheet>
  )
}

