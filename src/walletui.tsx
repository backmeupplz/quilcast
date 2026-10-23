// The Quilcast wallet's pages: /wallet (address, balances and NFTs of the wallet picked in its switcher) and the
// Wallets section of Settings (create, import, rename, back up, remove). Keys live in src/vault.ts; mini apps sign
// with them through src/miniapp.tsx. Balances and NFTs come from Blockscout's public explorers, read in the browser.
import { useEffect, useState } from 'preact/hooks'
import { read, save, safeUrl } from './api.ts'
import { t } from './i18n.ts'
import { Header, Icon, Menu, P, shell, Tabs, toast } from './ui.tsx'
import { logoOf, tokensOn } from './tokens.ts'
import { SendSheet, SwapSheet } from './walletmove.tsx'
import { activeWallet, addWallet, newPhrase, parseSecret, removeWallet, renameWallet, revealWallet, setActive, walletList, type WalletEntry } from './vault.ts'

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

/** Re-render when wallets are added, removed, renamed or switched. */
function useWallets() {
  const [, force] = useState(0)
  useEffect(() => {
    const f = () => force((x) => x + 1)
    addEventListener('wallets', f)
    return () => removeEventListener('wallets', f)
  }, [])
  return walletList()
}

/** Picking a wallet here also makes it the one mini apps offer first. */
const pick = (w: WalletEntry) => (setActive(w.id), save('quilcast:wallet', `quilcast:${w.id}`))

// --- balances and NFTs ---

// each chain's coin balance comes from its public RPC; tokens and NFTs from its Blockscout explorer
// (logos are LI.FI's)
const LOGO = 'https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/'
export const CHAINS = [
  { id: 8453, name: 'Base', host: 'base.blockscout.com', symbol: 'ETH', rpc: 'https://mainnet.base.org', logo: LOGO + 'base.svg' },
  { id: 1, name: 'Ethereum', host: 'eth.blockscout.com', symbol: 'ETH', rpc: 'https://ethereum-rpc.publicnode.com', logo: LOGO + 'ethereum.svg' },
  { id: 10, name: 'Optimism', host: 'explorer.optimism.io', symbol: 'ETH', rpc: 'https://mainnet.optimism.io', logo: LOGO + 'optimism.svg' },
  { id: 42161, name: 'Arbitrum', host: 'arbitrum.blockscout.com', symbol: 'ETH', rpc: 'https://arb1.arbitrum.io/rpc', logo: LOGO + 'arbitrum.svg' },
  { id: 137, name: 'Polygon', host: 'polygon.blockscout.com', symbol: 'POL', rpc: 'https://polygon-bor-rpc.publicnode.com', logo: LOGO + 'polygon.svg' },
]

/** A token's logo with its chain's in the corner. A token the explorer has no picture for (or a broken one), and
 *  each chain's coin, gets LI.FI's; the first letter stands in until then. */
export function Coin({ chain, address, symbol, src }: { chain: number; address?: string; symbol: string; src?: string }) {
  const [url, setUrl] = useState(src)
  const lifi = () => logoOf(chain, address).then((u) => setUrl(u && u !== src ? u : undefined))
  useEffect(() => void (setUrl(src), src || lifi()), [chain, address, src])
  const c = CHAINS.find((c) => c.id === chain)
  return (
    <span class="coin">
      {url ? <img class="token-icon" src={url} alt="" loading="lazy" referrerpolicy="no-referrer" onError={() => (url === src ? lifi() : setUrl(undefined))} /> : <span class="token-icon">{symbol[0]}</span>}
      {c && <img class="coin-chain" src={c.logo} alt="" title={c.name} referrerpolicy="no-referrer" />}
    </span>
  )
}
// `raw` is the exact balance in base units, for sending all of it
export type Holding = { chain: string; chainId: number; address?: `0x${string}`; decimals: number; raw: bigint; symbol: string; name: string; icon?: string; amount: number; usd: number }
type Nft = { chain: string; name: string; image?: string; big?: string; collection: string }

// an explorer that hangs is skipped after a while, so one slow chain can't hold up the rest
const getJson = (u: string) => fetch(u, { signal: AbortSignal.timeout(25e3) }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
const units = (v: string, d: number) => Number(BigInt(v || '0')) / 10 ** d

const coinBalance = (rpc: string, address: string) =>
  fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [address, 'latest'] }), signal: AbortSignal.timeout(15e3) })
    .then((r) => r.json()).then((j) => BigInt(j.result))
// the coin's price when the explorer can't be reached
const coinPrice = (chain: number) => tokensOn(chain).then((l) => l.find((x) => !x.address)?.usd || 0, () => 0)

/** Explorers that couldn't be reached on the last load, per address, so the page can say what may be missing. */
export const unreachable = new Map<string, string[]>()

async function holdings(address: string): Promise<Holding[]> {
  const missed: string[] = []
  const per = await Promise.all(CHAINS.map(async (c) => {
    const api = `https://${c.host}/api/v2/addresses/${address}`
    const [raw, me, tokens] = await Promise.all([coinBalance(c.rpc, address).catch(() => null), getJson(api).catch(() => null), getJson(`${api}/tokens?type=ERC-20`).catch(() => null)])
    if (!tokens) missed.push(c.name)
    const out: Holding[] = []
    const wei = raw ?? (me ? BigInt(me.coin_balance || 0) : 0n)
    const eth = Number(wei) / 1e18
    if (eth > 0) out.push({ chain: c.name, chainId: c.id, decimals: 18, raw: wei, symbol: c.symbol, name: c.symbol, amount: eth, usd: eth * (Number(me?.exchange_rate) || (await coinPrice(c.id))) })
    // tokens nobody prices or the explorer flags are almost always airdropped spam
    for (const i of tokens?.items || []) {
      const tk = i.token || {}
      if (!tk.exchange_rate || (tk.reputation && tk.reputation !== 'ok')) continue
      const amount = units(i.value, Number(tk.decimals || 18))
      // and dust worth less than a cent is just noise
      if (amount * Number(tk.exchange_rate) >= 0.01) out.push({ chain: c.name, chainId: c.id, address: String(tk.address_hash).toLowerCase() as `0x${string}`, decimals: Number(tk.decimals || 18), raw: BigInt(i.value), symbol: String(tk.symbol || '?').slice(0, 12), name: String(tk.name || ''), icon: safeUrl(tk.icon_url), amount, usd: amount * Number(tk.exchange_rate) })
    }
    return out
  }))
  unreachable.set(address, missed)
  return per.flat().sort((a, b) => b.usd - a.usd)
}

async function nfts(address: string): Promise<Nft[]> {
  const per = await Promise.all(CHAINS.map(async (c) => {
    const j = await getJson(`https://${c.host}/api/v2/addresses/${address}/nft?type=ERC-721,ERC-1155`).catch(() => null)
    return (j?.items || []).flatMap((i: any): Nft[] => {
      if (i.token?.reputation && i.token.reputation !== 'ok') return []
      const raw = String(i.image_url || i.metadata?.image || '')
      const path = ipfsPath(raw)
      const big = path ? GATEWAYS[0] + path : safeUrl(raw)
      return [{ chain: c.name, name: String(i.metadata?.name || `#${String(i.id).slice(0, 12)}`), collection: String(i.token?.name || ''), big, image: safeUrl(i.thumbnails?.['250x250']) || (path ? raw : big) }]
    })
  }))
  return per.flat()
}

// public IPFS gateways rate-limit hard, so an image that fails on one is tried on the next
const GATEWAYS = ['https://ipfs.io/ipfs/', 'https://dweb.link/ipfs/', 'https://gateway.pinata.cloud/ipfs/', 'https://w3s.link/ipfs/']
const ipfsPath = (u: string) => {
  const m = u.match(/^ipfs:\/\/(?:ipfs\/)?(.+)$/) || u.match(/^https:\/\/[^/]+\/ipfs\/(.+)$/) || u.match(/^https:\/\/(\w{46,})\.ipfs\.[^/]+(\/.*)?$/)
  return m && (m[2] !== undefined ? m[1] + (m[2] || '') : m[1])
}
function NftImage({ src }: { src: string }) {
  const path = ipfsPath(src)
  const [i, setI] = useState(0)
  const url = path ? GATEWAYS[i] && GATEWAYS[i] + path : i === 0 ? src : undefined
  return url ? <img src={url} alt="" loading="lazy" referrerpolicy="no-referrer" onError={() => setI(i + 1)} /> : <span class="nft-blank" />
}

const fmt = (n: number, max = 4) => n.toLocaleString(undefined, { maximumFractionDigits: n >= 1 ? Math.min(max, 2) : max })
const usd = (n: number) => n.toLocaleString(undefined, { style: 'currency', currency: 'USD' })

// --- /wallet ---

export function WalletPage() {
  const list = useWallets()
  const w = activeWallet()
  const [adding, setAdding] = useState(false)
  const [tab, setTab] = useState<'tokens' | 'nfts'>(() => read('quilcast:walletTab', 'tokens'))
  const [move, setMove] = useState<{ kind: 'send' | 'swap'; holdings: Holding[] } | null>(null)
  // after a send or swap the balances are read again
  const [round, setRound] = useState(0)
  const [opening, setOpening] = useState('')
  const open = (kind: 'send' | 'swap') => (setOpening(kind), load(w!.address).then((holdings) => setMove({ kind, holdings }), () => toast("Balances couldn't be loaded. Try again in a bit.")).finally(() => setOpening('')))
  const refresh = () => (cache.delete(w!.address), setRound((r) => r + 1))
  const sent = () => setTimeout(refresh, 4000)
  return (
    <>
      <Header title={t('Wallet')} action={list.length > 0 && <Switcher list={list} w={w!} add={() => setAdding(true)} />} />
      {!w ? (
        <div class="wallet-empty">
          <Icon d={P.wallet} size={40} />
          <h2>{t('Your Quilcast wallet')}</h2>
          <p>{t('Create a wallet or bring one in with its recovery phrase or private key. Mini apps can then use it alongside any wallet extension you have.')}</p>
          <button class="btn" onClick={() => setAdding(true)}>{t('Add a wallet')}</button>
        </div>
      ) : (
        <>
          <Summary key={w.address + round} w={w} />
          <div class="wallet-actions">
            <button class="btn" onClick={() => open('send')} disabled={!!opening}><Icon d="M12 19V5M5 12l7-7 7 7" size={16} />{opening === 'send' ? t('Loading…') : t('Send')}</button>
            <button class="btn" onClick={() => open('swap')} disabled={!!opening}><Icon d="M7 4v13M3 13l4 4 4-4M17 20V7M21 11l-4-4-4 4" size={16} />{opening === 'swap' ? t('Loading…') : t('Swap')}</button>
            <button class="btn ghost" onClick={() => navigator.clipboard.writeText(w.address).then(() => toast('Address copied'))}><Icon d="M12 5v14M5 12l7 7 7-7" size={16} />{t('Receive')}</button>
          </div>
          <div class="wallet-tabs">
            <Tabs tabs={[['tokens', t('Tokens')], ['nfts', t('NFTs')]]} value={tab} set={(x) => (setTab(x), save('quilcast:walletTab', x))} />
            <button class="icon-btn" aria-label={t('Refresh')} title={t('Refresh')} onClick={refresh}><Icon d="M21 12a9 9 0 1 1-2.6-6.4L21 8M21 3v5h-5" /></button>
          </div>
          {tab === 'tokens' ? <Tokens key={w.address + round} address={w.address} /> : <Nfts key={w.address + round} address={w.address} />}
          {move?.kind === 'send' && <SendSheet w={w} holdings={move.holdings} close={() => setMove(null)} sent={sent} />}
          {move?.kind === 'swap' && <SwapSheet w={w} holdings={move.holdings} close={() => setMove(null)} sent={sent} />}
        </>
      )}
      {adding && <AddWallet close={() => setAdding(false)} />}
    </>
  )
}

function Switcher({ list, w, add }: { list: WalletEntry[]; w: WalletEntry; add: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <span class="wrap-menu">
      <button class="wallet-switch" aria-haspopup="menu" onClick={() => setOpen(!open)}><span>{w.name}</span><Icon d="M6 9l6 6 6-6" size={16} /></button>
      {open && (
        <Menu class="right wallet-menu" close={() => setOpen(false)}>
          {list.map((x) => <button role="menuitemradio" aria-checked={x.id === w.id} onClick={() => (setOpen(false), pick(x))}><span class="wname">{x.name}</span><small>{short(x.address)}</small>{x.id === w.id && <Icon d={P.check} />}</button>)}
          <button role="menuitem" onClick={() => (setOpen(false), add())}><Icon d={P.plus} />{t('Add a wallet')}</button>
        </Menu>
      )}
    </span>
  )
}

function Summary({ w }: { w: WalletEntry }) {
  const copy = () => navigator.clipboard.writeText(w.address).then(() => toast('Address copied'))
  return (
    <div class="wallet-top">
      <button class="wallet-addr" onClick={copy} title={t('Copy address')}><code>{short(w.address)}</code><Icon d="M8 8h12v12H8zM4 16V4h12" size={15} /></button>
      <Total key={w.address} address={w.address} />
    </div>
  )
}

// one load per address per visit, shared by the total and the list
const cache = new Map<string, Promise<Holding[]>>()
export const load = (a: string) => cache.get(a) || (cache.set(a, holdings(a).catch((e) => (cache.delete(a), Promise.reject(e)))), cache.get(a)!)

function Total({ address }: { address: string }) {
  const [sum, setSum] = useState<number | null>(null)
  useEffect(() => void load(address).then((h) => setSum(h.reduce((n, x) => n + x.usd, 0)), () => {}), [address])
  return <b class="wallet-total">{sum === null ? '…' : usd(sum)}</b>
}

function Tokens({ address }: { address: string }) {
  const [h, setH] = useState<Holding[] | null>(null)
  const [err, setErr] = useState(false)
  useEffect(() => void load(address).then(setH, () => setErr(true)), [address])
  if (err) return <div class="note">{t("Balances couldn't be loaded. Try again in a bit.")}</div>
  if (!h) return <div class="spinner" />
  const missed = unreachable.get(address) || []
  const warn = missed.length > 0 && <p class="hint warn pad">{t("Couldn't reach the explorer for {chains}, so tokens there may be missing. Refresh to try again.", { chains: missed.join(', ') })}</p>
  if (!h.length) return <>{warn}<div class="note">{t('Nothing here yet. Copy the address above to receive tokens on Base, Ethereum, Optimism, Arbitrum or Polygon.')}</div></>
  return (
    <>
      {warn}
      {h.map((x) => (
        <div class="row token-row">
          <Coin chain={x.chainId} address={x.address} symbol={x.symbol} src={x.icon} />
          <span class="row-main"><b>{x.symbol}</b><span class="row-sub">{x.chain}</span></span>
          <span class="row-meta">{usd(x.usd)}<small>{fmt(x.amount)} {x.symbol}</small></span>
        </div>
      ))}
    </>
  )
}

function Nfts({ address }: { address: string }) {
  const [list, setList] = useState<Nft[] | null>(null)
  useEffect(() => void nfts(address).then(setList, () => setList([])), [address])
  if (!list) return <div class="spinner" />
  if (!list.length) return <div class="note">{t('No NFTs yet.')}</div>
  const big = list.filter((n) => n.big).map((n) => n.big!)
  return (
    <div class="nft-grid">
      {list.map((n) => (
        <button class="nft" onClick={() => n.big && shell.view(big, big.indexOf(n.big))} title={`${n.name} · ${n.collection}`}>
          {n.image ? <NftImage src={n.image} /> : <span class="nft-blank" />}
          <b>{n.name}</b>
          <small>{n.collection} · {n.chain}</small>
        </button>
      ))}
    </div>
  )
}

// --- Settings → Wallets ---

export function WalletSettings() {
  const list = useWallets()
  const [adding, setAdding] = useState(false)
  return (
    <div class="wallet-list">
      {list.map((w) => <WalletRow w={w} />)}
      <button class="btn ghost small" onClick={() => setAdding(true)}><Icon d={P.plus} />{t('Add a wallet')}</button>
      <p class="hint">{t('Mini apps can use these alongside any wallet extension; Quilcast asks you before each signature or transaction.')}</p>
      {adding && <AddWallet close={() => setAdding(false)} />}
    </div>
  )
}

function WalletRow({ w }: { w: WalletEntry }) {
  const [secret, setSecret] = useState('')
  const [open, setOpen] = useState(false)
  const rename = () => {
    const name = prompt(t('Wallet name'), w.name)
    name && renameWallet(w.id, name)
  }
  const reveal = async () => (secret ? setSecret('') : setSecret(await revealWallet(w.id).catch((e) => (toast(e.message), ''))))
  const remove = () => confirm(t('Remove {name} from this browser? Without its recovery phrase or key you lose access to what it holds.', { name: w.name })) && removeWallet(w.id)
  return (
    <div class="wallet-row">
      <div class="setting">
        <span class="wallet-name"><b>{w.name}</b><code class="muted">{short(w.address)}</code></span>
        <span class="wrap-menu">
          <button class="icon-btn" aria-label={t('More')} aria-haspopup="menu" onClick={() => setOpen(!open)}><Icon d={P.more} /></button>
          {open && (
            <Menu class="right" close={() => setOpen(false)}>
              <button role="menuitem" onClick={() => (setOpen(false), rename())}>{t('Rename')}</button>
              <button role="menuitem" onClick={() => (setOpen(false), reveal())}>{secret ? t('Hide the backup') : w.kind === 'phrase' ? t('Show recovery phrase') : t('Show private key')}</button>
              <button role="menuitem" class="danger" onClick={() => (setOpen(false), remove())}>{t('Remove')}</button>
            </Menu>
          )}
        </span>
      </div>
      {secret && <><p class="hint warn">{t('Anyone who sees this can take everything in the wallet.')}</p><code class="phrase">{secret}</code></>}
    </div>
  )
}

/** The warning shown wherever a phrase or key goes in. */
const Disclaimer = () => (
  <div class="wallet-warning">
    <b>{t('Be careful with keys')}</b>
    <p>{t('Quilcast is a third-party Farcaster client (yes, the one with Ogre mode and Japanese web mode), not an official Farcaster app. Anyone with a recovery phrase or private key can take everything in its wallet, so only add one you are willing to use here.')}</p>
    <p>{t('Quilcast encrypts it with a key your browser keeps sealed, which no one can copy out of this browser. It never leaves this device: it is not sent to our server or anyone else.')}</p>
  </div>
)

function AddWallet({ close }: { close: () => void }) {
  const [mode, setMode] = useState<'import' | 'create'>('import')
  const [secret, setSecret] = useState('')
  const [made] = useState(newPhrase)
  const [name, setName] = useState('')
  const [index, setIndex] = useState(1)
  const [ok, setOk] = useState(false)
  const [busy, setBusy] = useState(false)
  const parsed = mode === 'create' ? { kind: 'phrase' as const, secret: made } : parseSecret(secret)
  const submit = async (e: Event) => {
    e.preventDefault()
    // only the Add button, with the risk ticked (a stray submit must never add a wallet unseen)
    if (!parsed || !ok) return
    setBusy(true)
    try {
      const w = await addWallet(name, parsed.kind, parsed.secret, parsed.kind === 'phrase' ? Math.max(0, index - 1) : 0)
      pick(w)
      toast('Wallet added')
      close()
    } catch (e: any) {
      toast(e.message)
      setBusy(false)
    }
  }
  return (
    <div class="modal" onClick={(e) => e.target === e.currentTarget && close()}>
      <form class="sheet wallet-form" onSubmit={submit} autocomplete="off">
        <h2>{t('Add a wallet')}</h2>
        <Tabs tabs={[['import', t('Import')], ['create', t('Create new')]]} value={mode} set={(m) => (setMode(m), setOk(false))} />
        <input value={name} onInput={(e) => setName(e.currentTarget.value)} placeholder={t('Name (optional)')} aria-label={t('Wallet name')} maxLength={40} />
        {mode === 'import' ? (
          <>
            <textarea value={secret} onInput={(e) => setSecret(e.currentTarget.value)} placeholder={t('Recovery phrase or private key')} aria-label={t('Recovery phrase or private key')} rows={3} spellcheck={false} autocapitalize="off" autocorrect="off" autocomplete="off" data-gramm="false" data-lt-active="false" />
            {secret.trim() && !parsed && <p class="hint warn">{t("That isn't a valid recovery phrase or private key.")}</p>}
            {parsed?.kind === 'phrase' && <label class="wallet-index">{t('Account number')}<input type="number" min={1} max={100} value={index} onInput={(e) => setIndex(Math.max(1, Number(e.currentTarget.value) || 1))} /></label>}
          </>
        ) : (
          <>
            <p class="hint">{t('Write these 12 words down and keep them somewhere safe. They are the only way back into this wallet if this browser loses it.')}</p>
            <code class="phrase">{made}</code>
          </>
        )}
        <Disclaimer />
        <label class="check"><input type="checkbox" checked={ok} onChange={(e) => setOk(e.currentTarget.checked)} />{mode === 'create' ? t('I wrote the words down and understand the risk') : t('I understand the risk')}</label>
        <div class="sheet-btns">
          <button type="button" class="btn ghost" onClick={close}>{t('Cancel')}</button>
          <button class="btn" disabled={busy || !ok || !parsed}>{busy ? t('Working…') : t('Add wallet')}</button>
        </div>
      </form>
    </div>
  )
}
