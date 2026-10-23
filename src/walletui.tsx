// The Quilcast wallet's pages: /wallet (address, balances and NFTs of the wallet picked in its switcher) and the
// Wallets section of Settings (create, import, rename, back up, remove). Keys live in src/vault.ts; mini apps sign
// with them through src/miniapp.tsx. Balances and NFTs come from Blockscout's public explorers, read in the browser.
import { useEffect, useState } from 'preact/hooks'
import { read, save, safeUrl } from './api.ts'
import { t } from './i18n.ts'
import { Header, Icon, Menu, P, shell, Tabs, toast } from './ui.tsx'
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

const CHAINS = [
  { id: 8453, name: 'Base', host: 'base.blockscout.com', symbol: 'ETH' },
  { id: 1, name: 'Ethereum', host: 'eth.blockscout.com', symbol: 'ETH' },
  { id: 10, name: 'Optimism', host: 'explorer.optimism.io', symbol: 'ETH' },
  { id: 42161, name: 'Arbitrum', host: 'arbitrum.blockscout.com', symbol: 'ETH' },
  { id: 137, name: 'Polygon', host: 'polygon.blockscout.com', symbol: 'POL' },
]
type Holding = { chain: string; symbol: string; name: string; icon?: string; amount: number; usd: number }
type Nft = { chain: string; name: string; image?: string; big?: string; collection: string }

const getJson = (u: string) => fetch(u).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
const units = (v: string, d: number) => Number(BigInt(v || '0')) / 10 ** d

async function holdings(address: string): Promise<Holding[]> {
  const per = await Promise.all(CHAINS.map(async (c) => {
    const api = `https://${c.host}/api/v2/addresses/${address}`
    const [me, tokens] = await Promise.all([getJson(api).catch(() => null), getJson(`${api}/tokens?type=ERC-20`).catch(() => null)])
    const out: Holding[] = []
    const eth = me ? units(me.coin_balance, 18) : 0
    if (eth > 0) out.push({ chain: c.name, symbol: c.symbol, name: c.symbol, amount: eth, usd: eth * Number(me.exchange_rate || 0) })
    // tokens nobody prices or the explorer flags are almost always airdropped spam
    for (const i of tokens?.items || []) {
      const tk = i.token || {}
      if (!tk.exchange_rate || (tk.reputation && tk.reputation !== 'ok')) continue
      const amount = units(i.value, Number(tk.decimals || 18))
      // and dust worth less than a cent is just noise
      if (amount * Number(tk.exchange_rate) >= 0.01) out.push({ chain: c.name, symbol: String(tk.symbol || '?').slice(0, 12), name: String(tk.name || ''), icon: safeUrl(tk.icon_url), amount, usd: amount * Number(tk.exchange_rate) })
    }
    return out
  }))
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
          <Summary w={w} />
          <Tabs tabs={[['tokens', t('Tokens')], ['nfts', t('NFTs')]]} value={tab} set={(x) => (setTab(x), save('quilcast:walletTab', x))} />
          {tab === 'tokens' ? <Tokens key={w.address} address={w.address} /> : <Nfts key={w.address} address={w.address} />}
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
const load = (a: string) => cache.get(a) || (cache.set(a, holdings(a).catch((e) => (cache.delete(a), Promise.reject(e)))), cache.get(a)!)

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
  if (!h.length) return <div class="note">{t('Nothing here yet. Copy the address above to receive tokens on Base, Ethereum, Optimism, Arbitrum or Polygon.')}</div>
  return (
    <>
      {h.map((x) => (
        <div class="row token-row">
          {x.icon ? <img class="token-icon" src={x.icon} alt="" loading="lazy" referrerpolicy="no-referrer" /> : <span class="token-icon">{x.symbol[0]}</span>}
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
            <textarea value={secret} onInput={(e) => setSecret(e.currentTarget.value)} placeholder={t('Recovery phrase or private key')} aria-label={t('Recovery phrase or private key')} rows={3} spellcheck={false} autocapitalize="off" autocorrect="off" />
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
