// Farcaster and Base mini apps. Each runs in a sandboxed iframe on its own origin and talks to us with
// postMessage, in the Comlink shape the official SDK (@farcaster/miniapp-sdk) speaks. Only the calls in
// `calls` are answered, with checked arguments; anything else is refused. Wallet requests go to the
// person's browser wallets (EIP-6963 for Ethereum, Wallet Standard for Solana), after the checks in
// guard.ts. Several apps can be open at once: one shows, the rest wait in the dock with their iframes alive.
import { render, type ComponentChildren } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { formatUnits, parseUnits } from 'viem'
import { arbitrum, base, baseSepolia, celo, degen, mainnet, monad, optimism, polygon, unichain, zora } from 'viem/chains'
import { lang, t } from './i18n.ts'
import { account, getUser, go, myUser, read, safeUrl, save, setAccount, type Cast, type User } from './api.ts'
import { base58, hex } from './fc.ts'
import { checkWallet, READS, rpcError, SIGNS, signInCheck, siwf, tokenCall, typedRisk, UNLIMITED, WALLET_READS } from './guard.ts'
import { castText, LOGO } from './shared.ts'
import { allowance, approveTx, parseToken, quote, tokenInfo, transferTx, USDC, type Token, type TokenId } from './tokens.ts'
import { askPush, channelOf, fetchCast, handle, Icon, Img, isPinned, Menu, P, shell, toast, togglePin, unfurl } from './ui.tsx'
import { custodyOf, signEvent } from './write.ts'

const QUILCAST_FID = 3356316
// viem's default Polygon RPC now wants a key, so Polygon reads and sends go through publicnode
const POLYGON = { ...polygon, rpcUrls: { default: { http: ['https://polygon-bor-rpc.publicnode.com'] } } }
const CHAINS = Object.fromEntries([base, optimism, mainnet, arbitrum, POLYGON, celo, zora, unichain, monad, degen, baseSepolia].map((c) => [c.id, c]))

// --- Ethereum wallets ---

type Provider = { request: (a: { method: string; params?: unknown }) => Promise<any>; on?: (e: string, f: (x: any) => void) => void }
type Wallet = { name: string; icon: string; key: string; provider: Provider; address?: string; local?: string }
// declared before the wallet listeners below: extensions announce synchronously, while this module still loads
let update = () => {}
const wallets: Wallet[] = []
const add = (name: string, icon: string, key: string, provider: Provider) => {
  if (wallets.some((w) => w.provider === provider)) return
  const w: Wallet = { name: name.slice(0, 40) || 'Wallet', icon: /^data:image\//.test(icon) ? icon : '', key, provider }
  wallets.push(w)
  // the person switched accounts in the wallet: apps using it follow
  provider.on?.('accountsChanged', (list: string[]) => {
    w.address = typeof list?.[0] === 'string' ? list[0].toLowerCase() : undefined
    for (const app of apps) if (app.wallet === w && app.connected) w.address ? emitEth(app, 'accountsChanged', [[w.address]]) : disconnect(app, false)
    update()
  })
  update()
}
addEventListener('eip6963:announceProvider', (e) => {
  const { info, provider } = (e as CustomEvent).detail || {}
  if (typeof provider?.request === 'function' && info) add(String(info.name || ''), String(info.icon || ''), String(info.rdns || info.name || ''), provider)
})
dispatchEvent(new Event('eip6963:requestProvider'))
// wallets older than EIP-6963 only set window.ethereum
const anyWallet = () => {
  const p = (window as any).ethereum
  if (!wallets.length && typeof p?.request === 'function') add(p.isRabby ? 'Rabby' : p.isMetaMask ? 'MetaMask' : t('Browser wallet'), '', 'injected', p)
  return wallets.length > 0
}

// --- Solana wallets (Wallet Standard: Phantom, Solflare, Backpack, MetaMask…) ---

type SolWallet = { name: string; icon: string; chains: string[]; accounts: { address: string }[]; features: Record<string, any> }
const solWallets: SolWallet[] = []
const registerSol = (...ws: SolWallet[]) => {
  for (const w of ws) if (w?.features?.['standard:connect'] && Array.isArray(w.chains) && w.chains.some((c) => String(c).startsWith('solana:')) && !solWallets.includes(w)) solWallets.push(w)
  update()
  return () => {}
}
addEventListener('wallet-standard:register-wallet', (e) => {
  try {
    ;(e as CustomEvent).detail?.({ register: registerSol })
  } catch {}
})
dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: { register: registerSol } }))

// one wallet request at a time, so a chain switch and the request after it can't interleave with another app's
let line: Promise<unknown> = Promise.resolve()
const serial = <T,>(f: () => Promise<T>) => {
  const p = line.then(f)
  line = p.catch(() => {})
  return p
}

// what each app origin was allowed: its Ethereum wallet, its Solana wallet, the camera and microphone
const allowed = (k: 'connected' | 'solana' | 'media') => read<Record<string, string>>(`quilcast:${k}`, {})
const allow = (k: 'connected' | 'solana' | 'media', origin: string, v: string | null) => {
  const all = allowed(k)
  v === null ? delete all[origin] : (all[origin] = v)
  save(`quilcast:${k}`, all)
}
const remembered = (app: App) => {
  const k = allowed('connected')
  return Object.hasOwn(k, app.origin) ? wallets.find((w) => w.key === k[app.origin]) : undefined
}

// --- open apps ---

export type AppMeta = { url: string; name?: string; icon?: string; splash?: string; bg?: string }
type Notice = { notificationId: string; title: string; body: string }
type Ask = { title: string; body: string; yes: string; extra?: () => ComponentChildren; at: number; done: (ok: boolean) => void }
type App = {
  id: number; url: string; origin: string; host: string; name: string; icon?: string; bg?: string
  cast?: Cast; embed?: string; from?: string; notification?: Notice; frame?: HTMLIFrameElement; ready: boolean
  wallet?: Wallet; connected: boolean; chain: number; sol?: { wallet: SolWallet; account: { address: string } }; media: boolean
  button?: { text: string; loading: boolean; disabled: boolean; hidden: boolean }; back: boolean
  ask?: Ask; waiting?: string; uuid: string
}
const apps: App[] = []
let shown: number | null = null
let ids = 0
let root: HTMLElement | undefined

const show = (app: App | null) => ((shown = app?.id ?? null), update())
const narrow = () => matchMedia('(max-width: 699px)').matches

/** Open a mini app, or bring it forward if it's already open. */
export function launch(m: AppMeta, ctx: { cast?: Cast; embed?: string; from?: string; notification?: Notice } = {}) {
  const url = safeUrl(m.url)
  if (!url?.startsWith('https://')) return toast("That mini app isn't on a secure (https) address.")
  const { origin, host } = new URL(url)
  // our own pages (Quilcast's mini app embeds) just open here; framed with allow-same-origin they could read our keys
  if (origin === location.origin || host === 'quilcast.com') return go(url.slice(origin.length) || '/')
  const open = apps.find((a) => a.url === url)
  if (open) return show(open)
  if (!root) render(<Host />, (root = document.body.appendChild(document.createElement('div'))))
  const bg = /^#[0-9a-f]{3,8}$/i.test(m.bg || '') ? m.bg : undefined
  const app: App = {
    id: ++ids, url, origin, host, name: (m.name || host).slice(0, 60), icon: safeUrl(m.splash) || safeUrl(m.icon), bg, ...ctx,
    ready: false, connected: false, chain: base.id, media: Object.hasOwn(allowed('media'), origin), back: false, uuid: crypto.randomUUID(),
  }
  app.wallet = remembered(app) || wallets.find((w) => w.key === read('quilcast:wallet', '')) || wallets[0]
  apps.push(app)
  show(app)
}

/** Open a link as a mini app, using its embed metadata (name, icon, splash) when it has some. */
export async function launchUrl(url: string, from?: string, notification?: Notice) {
  const d = await unfurl(url)
  launch(d?.app ? { ...d.app, icon: d.icon, url: notification ? url : d.app.url } : { url: d?.url || url, name: d?.title, icon: d?.icon }, { from, notification })
}

function close(app: App) {
  app.ask?.done(false)
  apps.splice(apps.indexOf(app), 1)
  if (shown === app.id) shown = null
  update()
}
const reload = (app: App) => app.frame && ((app.ready = false), (app.frame.src = app.url), update())

const post = (app: App, m: unknown) => {
  try {
    app.frame?.contentWindow?.postMessage(m, app.origin)
  } catch {}
}
const emit = (app: App, event: Record<string, unknown>) => post(app, { type: 'frameEvent', event })
const emitEth = (app: App, event: string, params: unknown[]) => post(app, { type: 'frameEthProviderEvent', event, params })

/** Prompts (wallet or ours) only for the app on screen, so one in the background can't pose as the one you're using. */
const foreground = (app: App) => {
  if (shown !== app.id || document.hidden) throw rpcError(4100, `Open ${app.name} to continue.`)
}
/** Ask the person something on top of the app; resolves true for the yes button. */
const ask = (app: App, a: Omit<Ask, 'done' | 'at'>) =>
  new Promise<boolean>((resolve) => {
    if (app.ask) return resolve(false)
    app.ask = { ...a, at: Date.now(), done: (ok) => ((app.ask = undefined), update(), resolve(ok)) }
    update()
  })
async function waitFor<T>(app: App, label: string, f: () => Promise<T>) {
  app.waiting = label
  update()
  try {
    return await f()
  } finally {
    app.waiting = undefined
    update()
  }
}
const declined = () => rpcError(4001, 'You declined.')

// --- the Ethereum wallet the app sees ---

async function useWallet(app: App, w: Wallet) {
  const [a] = await waitFor(app, t('Check {wallet}', { wallet: w.name }), () => serial(() => w.provider.request({ method: 'eth_requestAccounts' })))
  if (typeof a !== 'string') throw rpcError(4001, 'The wallet shared no address.')
  w.address = a.toLowerCase()
  app.wallet = w
  app.connected = true
  save('quilcast:wallet', w.key)
  allow('connected', app.origin, w.key)
  emitEth(app, 'accountsChanged', [[w.address]])
  update()
  return [w.address]
}

/** `forget` drops the app's permission too; a wallet that just locked keeps it. */
function disconnect(app: App, forget = true) {
  forget && allow('connected', app.origin, null)
  app.connected = false
  emitEth(app, 'accountsChanged', [[]])
  update()
}

/** The person picked another wallet for this app. */
const pick = (app: App, w: Wallet) => (app.connected ? useWallet(app, w).catch((e) => toast(e.message)) : ((app.wallet = w), update()))

async function accounts(app: App) {
  // an app allowed before gets the address back without a prompt, if the wallet still shares it with us
  const w = !app.connected && remembered(app)
  if (w) {
    const [a] = await serial(() => w.provider.request({ method: 'eth_accounts' })).catch(() => [])
    if (typeof a === 'string') (w.address = a.toLowerCase()), (app.wallet = w), (app.connected = true), update()
  }
  return app.connected && app.wallet?.address ? [app.wallet.address] : []
}

const WalletIcon = ({ w }: { w?: { icon: string } }) => (w?.icon ? <img class="wallet-icon" src={w.icon} alt="" /> : <Icon d={P.wallet} size={16} />)
/** A list to choose a wallet from, for the connect prompts. */
function Choose<W extends { name: string; icon: string }>({ list, value, set }: { list: W[]; value?: W; set: (w: W) => void }) {
  const [, force] = useState(0)
  return (
    <div class="accounts">
      {list.map((w) => (
        <button class={`acct${w === value ? ' on' : ''}`} aria-pressed={w === value} onClick={() => (set(w), force((x) => x + 1))}>
          <WalletIcon w={w} /><span><b>{w.name}</b></span>{w === value && list.length > 1 && <Icon d={P.check} />}
        </button>
      ))}
    </div>
  )
}

async function connect(app: App) {
  if (app.connected && app.wallet?.address) return [app.wallet.address]
  foreground(app)
  if (!anyWallet()) throw rpcError(4100, 'No wallet found in this browser. Install one like MetaMask or Rabby.')
  const known = remembered(app)
  if (known) return useWallet(app, known)
  app.wallet ||= wallets[0]
  const ok = await ask(app, {
    title: t('Connect a wallet to {name}?', { name: app.name }), yes: t('Connect'),
    body: t('{host} will see your wallet address and can ask your wallet to sign or send. Your wallet asks you each time.', { host: app.host }),
    extra: () => <Choose list={wallets} value={app.wallet} set={(w) => (app.wallet = w)} />,
  })
  if (!ok || !app.wallet) throw declined()
  return useWallet(app, app.wallet)
}

const toHex = (n: number) => '0x' + n.toString(16)
const chainOf = (v: unknown) => {
  if (typeof v !== 'string' || !/^0x[0-9a-f]{1,12}$/i.test(v)) throw rpcError(-32602, 'Invalid chain id.')
  return parseInt(v, 16)
}
const live = (app: App) => {
  const w = app.connected ? app.wallet : undefined
  if (!w?.address) throw rpcError(4100, 'Connect a wallet first.')
  return w
}

/** Put the wallet on `chain` before it signs or sends; each app keeps its own chain. */
async function align(w: Wallet, chain: number) {
  if (Number(await w.provider.request({ method: 'eth_chainId' })) === chain) return
  try {
    await w.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: toHex(chain) }] })
  } catch (e: any) {
    const c = CHAINS[chain]
    if (!c || (e?.code !== 4902 && !/unrecognized|unknown chain|not been added/i.test(e?.message))) throw e
    await w.provider.request({ method: 'wallet_addEthereumChain', params: [{ chainId: toHex(c.id), chainName: c.name, nativeCurrency: c.nativeCurrency, rpcUrls: c.rpcUrls.default.http, blockExplorerUrls: c.blockExplorers && [c.blockExplorers.default.url] }] })
  }
}

async function publicRpc(chain: number, method: string, params: unknown[]) {
  const c = CHAINS[chain]
  if (!c) throw rpcError(4901, 'Quilcast has no RPC for that chain.')
  const r = await (await fetch(c.rpcUrls.default.http[0], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()
  if (r.error) throw rpcError(typeof r.error.code === 'number' ? r.error.code : -32603, String(r.error.message || 'RPC error'))
  return r.result
}

async function setChain(app: App, id: number, method: string, params: unknown[]) {
  // chains we know switch on our side; others exist only in the wallet, so it has to agree
  if (!CHAINS[id]) {
    foreground(app)
    const w = live(app)
    await waitFor(app, t('Check {wallet}', { wallet: w.name }), () => serial(() => w.provider.request({ method, params })))
  }
  if (app.chain !== id) (app.chain = id), emitEth(app, 'chainChanged', [toHex(id)])
  return null
}

/** A Sign-In message for another site than the app's own: the person decides. */
const confirmSite = (app: App, site: string) =>
  ask(app, { title: t('Sign in to {site}?', { site }), yes: t('Continue'), body: t('{host} wants your wallet to sign you in to {site}, which is a different site. Continue only if you trust {name} with your account there.', { host: app.host, site, name: app.name }) })

async function eth(app: App, r: any): Promise<unknown> {
  const method = r?.method
  const params = Array.isArray(r?.params) ? r.params : []
  if (typeof method !== 'string') throw rpcError(-32600, 'Invalid request.')
  if (method === 'eth_chainId') return toHex(app.chain)
  if (method === 'net_version') return String(app.chain)
  if (method === 'eth_accounts') return accounts(app)
  if (method === 'eth_requestAccounts') return connect(app)
  if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return setChain(app, chainOf(params[0]?.chainId), method, [params[0]])
  if (READS.has(method) && CHAINS[app.chain]) return publicRpc(app.chain, method, params)
  if (!READS.has(method) && !SIGNS.has(method) && !WALLET_READS.has(method)) throw rpcError(4200, `Quilcast doesn't let mini apps use ${method}.`)
  const w = live(app)
  if (w.local) return local(app, w, method, params)
  if (WALLET_READS.has(method)) return serial(() => w.provider.request({ method, params }))
  // signing, sending, and reads on a chain only the wallet knows
  foreground(app)
  const site = SIGNS.has(method) ? checkWallet(app.host, w.address!, method, params) : undefined
  if (site && !(await confirmSite(app, site))) throw declined()
  return waitFor(app, t('Check {wallet}: {host} asked for this', { wallet: w.name, host: app.host }), () => serial(async () => (await align(w, app.chain), w.provider.request({ method, params }))))
}

// --- the Quilcast wallet (src/vault.ts): keys kept in this browser, so Quilcast asks before each signature ---

const vault = () => import('./vault.ts')
/** The wallets from Settings, listed first (so a new app offers them first), each with a provider that only answers
 *  who it is; signing goes through local() with the app in hand, to ask on top of it. */
async function syncLocal() {
  const list = (await vault()).walletList()
  for (const w of wallets.filter((x) => x.local && !list.some((e) => e.id === x.local))) {
    wallets.splice(wallets.indexOf(w), 1)
    for (const app of apps) if (app.wallet === w) app.connected ? disconnect(app, true) : (app.wallet = undefined)
  }
  list.forEach((e, i) => {
    const had = wallets.find((x) => x.local === e.id)
    if (had) return void (had.name = e.name)
    const address = e.address.toLowerCase()
    const provider: Provider = {
      request: async ({ method }) => {
        if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [address]
        throw rpcError(4200, "The Quilcast wallet can't do that here.")
      },
    }
    wallets.splice(i, 0, { name: e.name, icon: LOGO_ICON, key: `quilcast:${e.id}`, provider, address, local: e.id })
  })
  update()
}
addEventListener('wallets', () => void syncLocal())

const batches = new Map<string, { chain: number; hashes: `0x${string}`[] }>()
const textOf = (m: string) => {
  if (!/^0x([0-9a-f]{2})*$/i.test(m)) return m
  const s = new TextDecoder('utf-8', { fatal: false }).decode(Uint8Array.from(m.slice(2).match(/../g) || [], (h) => parseInt(h, 16)))
  // bytes that aren't text (control characters, or not UTF-8 at all) stay hex
  return /[\u0000-\u0008\u000e-\u001f\ufffd]/.test(s) ? m : s
}
const Preview = ({ rows, text, warn }: { rows: [string, string][]; text?: string; warn?: string }) => (
  <div class="sign-preview">
    {warn && <p class="warn">{warn}</p>}
    {rows.map(([k, v]) => <div class="sign-row"><span>{k}</span><b>{v}</b></div>)}
    {text && <pre>{text.length > 4000 ? text.slice(0, 4000) + '…' : text}</pre>}
  </div>
)

async function local(app: App, w: Wallet, method: string, params: any[]): Promise<unknown> {
  const chain = CHAINS[app.chain]
  if (method === 'wallet_getCapabilities') return {}
  if (method === 'wallet_getCallsStatus') {
    const c = batches.get(String(params[0]))
    if (!c) throw rpcError(5730, 'Unknown call batch.')
    const receipts = await Promise.all(c.hashes.map((h) => publicRpc(c.chain, 'eth_getTransactionReceipt', [h])))
    const done = receipts.every(Boolean)
    return { version: '2.0.0', id: params[0], chainId: toHex(c.chain), atomic: false, status: done ? (receipts.every((r: any) => r.status === '0x1') ? 200 : 500) : 100, receipts: done ? receipts : [] }
  }
  if (method === 'wallet_watchAsset') return true
  if (!chain) throw rpcError(4901, "The Quilcast wallet doesn't work on that chain.")
  foreground(app)
  const site = SIGNS.has(method) ? checkWallet(app.host, w.address!, method, params) : undefined
  if (site && !(await confirmSite(app, site))) throw declined()
  const wallet: [string, string] = [t('Wallet'), `${w.name} · ${short(w.address!)}`]
  const money = (v: unknown) => `${formatUnits(BigInt((v as string) || 0), chain.nativeCurrency.decimals)} ${chain.nativeCurrency.symbol}`
  const ok = (title: string, rows: [string, string][], o: { text?: string; warn?: string; yes?: string } = {}) =>
    ask(app, { title, body: t('{host} asks the Quilcast wallet for this. Only approve what you expect.', { host: app.host }), yes: o.yes || t('Sign'), extra: () => <Preview rows={[wallet, ...rows]} text={o.text} warn={o.warn} /> })
  const take = t('This lets someone else take your tokens without asking again.')
  const m = await vault()
  if (method === 'personal_sign') {
    const msg = String(params[0] ?? '')
    const text = textOf(msg)
    // bytes that aren't text (a hash, say) can be a signature for anything
    const blind = text === msg && /^0x./i.test(msg)
    if (!(await ok(t('Sign a message?'), [], { text, warn: blind ? t("This message can't be read. Only sign it if you know exactly what it is.") : undefined }))) throw declined()
    return (await m.signerOf(w.local!)).signMessage({ message: /^0x([0-9a-f]{2})*$/i.test(msg) ? { raw: msg as `0x${string}` } : msg })
  }
  if (method === 'eth_signTypedData_v4') {
    const data = typeof params[1] === 'string' ? JSON.parse(params[1]) : params[1]
    const { EIP712Domain: _, ...types } = data?.types || {}
    // the domain's name is whatever the app wrote, so it's shown as the contract's name next to its address, not as a site
    const d = data?.domain || {}
    const risk = typedRisk(data)
    const rows: [string, string][] = [
      [t('Contract'), [d.name, d.verifyingContract && short(String(d.verifyingContract))].filter(Boolean).join(' · ') || '?'],
      ...(d.chainId !== undefined ? [[t('Network'), CHAINS[Number(d.chainId)]?.name || String(d.chainId)] as [string, string]] : []),
      [t('Type'), String(data?.primaryType)],
      ...(risk?.spender ? [[t('Approves'), short(risk.spender)] as [string, string]] : []),
    ]
    const warn = risk?.kind === 'permit' ? take : risk?.kind === 'listing' ? t('This puts your NFTs up for sale. Check the price before you sign.') : undefined
    if (!(await ok(t('Sign this data?'), rows, { text: JSON.stringify(data?.message, null, 2), warn }))) throw declined()
    return (await m.signerOf(w.local!)).signTypedData({ domain: data.domain, types, primaryType: data.primaryType, message: data.message })
  }
  const send = async (txs: { to?: string; data?: string; value?: string; gas?: string }[]) => {
    const { createWalletClient, http } = await import('viem')
    const client = createWalletClient({ account: await m.signerOf(w.local!), chain, transport: http(chain.rpcUrls.default.http[0]) })
    const hashes: `0x${string}`[] = []
    for (const tx of txs) hashes.push(await client.sendTransaction({ chain, to: tx.to as `0x${string}`, data: tx.data as `0x${string}` | undefined, value: BigInt(tx.value || 0), ...(tx.gas && { gas: BigInt(tx.gas) }) }))
    return hashes
  }
  // a token call is spelled out (who gets what, who may take what), since "68 bytes" hides an unlimited approval
  const describe = async (tx: { to?: string; data?: string; value?: string }): Promise<{ rows: [string, string][]; warn?: string }> => {
    const c = tokenCall(tx.data)
    const value: [string, string][] = c && !BigInt(tx.value || 0) ? [] : [[t('Amount'), money(tx.value)]]
    if (!c || (c.kind === 'approveAll' && !c.args[1]))
      return { rows: [[t('To'), tx.to ? short(tx.to) : t('New contract')], ...value, ...(tx.data && tx.data !== '0x' ? [[t('Data'), t('{n} bytes', { n: (tx.data.length - 2) / 2 })] as [string, string]] : [])] }
    const at = String(c.kind === 'approve2' ? c.args[0] : tx.to)
    const tk = await info({ chain: app.chain, address: at as `0x${string}` }).catch(() => null)
    // an approval this big is for everything you'll ever hold; a transfer's number is what moves (an NFT's id, say)
    const amount = (n: unknown, cap = false) => (cap && (n as bigint) >= UNLIMITED ? t('Unlimited') : tk ? fmt(n as bigint, tk) : String(n))
    const token: [string, string] = [t('Token'), tk ? `${tk.symbol} · ${short(at)}` : short(at)]
    const [a, b, n] = c.kind === 'approve2' ? c.args.slice(1) : c.args
    if (c.kind === 'transfer') return { rows: [token, [t('Sends'), amount(b)], [t('To'), short(String(a))], ...value] }
    if (c.kind === 'move') return { rows: [token, [t('Sends'), amount(n)], [t('From'), short(String(a))], [t('To'), short(String(b))], ...value] }
    // an approval of 0 takes one back
    return { rows: [token, [t('Approves'), short(String(a))], [t('Up to'), c.kind === 'approveAll' ? t('Unlimited') : amount(b, true)], ...value], warn: c.kind === 'approveAll' || (b as bigint) > 0n ? take : undefined }
  }
  if (method === 'eth_sendTransaction') {
    const tx = params[0] || {}
    const { rows, warn } = await describe(tx)
    if (!(await ok(t('Send this transaction?'), [[t('Network'), chain.name], ...rows], { warn, yes: t('Send') }))) throw declined()
    return (await waitFor(app, t('Sending…'), () => send([tx])))[0]
  }
  if (method === 'wallet_sendCalls') {
    const list: any[] = Array.isArray(params[0]?.calls) ? params[0].calls : []
    if (!list.length) throw rpcError(-32602, 'No calls.')
    if (params[0]?.chainId && Number(params[0].chainId) !== app.chain) throw rpcError(4901, 'Switch to that chain first.')
    const each = await Promise.all(list.map(describe))
    const rows = each.flatMap((d, i) => d.rows.map(([k, v]) => [`${i + 1}. ${k}`, v] as [string, string]))
    if (!(await ok(list.length > 1 ? t('Send {n} transactions?', { n: list.length }) : t('Send this transaction?'), [[t('Network'), chain.name], ...rows], { warn: each.find((d) => d.warn)?.warn, yes: t('Send') }))) throw declined()
    const hashes = await waitFor(app, t('Sending…'), () => send(list))
    const id = crypto.randomUUID()
    batches.set(id, { chain: app.chain, hashes })
    return { id }
  }
  throw rpcError(4200, "The Quilcast wallet can't do that here.")
}

// --- Solana ---

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b))
const unb64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))

async function useSol(app: App, w: SolWallet) {
  const r: any = await waitFor(app, t('Check {wallet}', { wallet: w.name }), () => w.features['standard:connect'].connect())
  const acct = r?.accounts?.[0] || w.accounts?.[0]
  if (typeof acct?.address !== 'string') throw rpcError(4001, 'The wallet shared no address.')
  app.sol = { wallet: w, account: acct }
  allow('solana', app.origin, w.name)
  update()
  return { publicKey: acct.address }
}

async function sol(app: App, r: any) {
  const method = r?.method
  if (method === 'connect') {
    if (app.sol) return { publicKey: app.sol.account.address }
    foreground(app)
    if (!solWallets.length) throw new Error('No Solana wallet found in this browser. Install one like Phantom.')
    const k = allowed('solana')
    const known = Object.hasOwn(k, app.origin) && solWallets.find((w) => w.name === k[app.origin])
    if (known) return useSol(app, known)
    let w = solWallets[0]
    const ok = await ask(app, { title: t('Connect a Solana wallet to {name}?', { name: app.name }), yes: t('Connect'), body: t('{host} will see your Solana address and can ask your wallet to sign. Your wallet asks you each time.', { host: app.host }), extra: () => <Choose list={solWallets} value={w} set={(x) => (w = x)} /> })
    if (!ok) throw declined()
    return useSol(app, w)
  }
  foreground(app)
  const s = app.sol
  if (!s) throw rpcError(4100, 'Connect a Solana wallet first.')
  const feature = (name: string) => s.wallet.features[name] || Promise.reject(rpcError(4200, `${s.wallet.name} can't do that.`))
  const label = t('Check {wallet}: {host} asked for this', { wallet: s.wallet.name, host: app.host })
  if (method === 'signMessage') {
    const text = String(r.params?.message ?? '').slice(0, 10000)
    const site = signInCheck(app.host, text)
    if (site && !(await confirmSite(app, site))) throw declined()
    const [out] = await waitFor(app, label, async () => (await feature('solana:signMessage')).signMessage({ account: s.account, message: new TextEncoder().encode(text) }))
    return { signature: base58(out.signature) }
  }
  const tx = r.params?.transaction
  if (typeof tx !== 'string' || tx.length > 20000) throw new Error('Invalid transaction.')
  const transaction = unb64(tx)
  if (method === 'signTransaction') {
    const [out] = await waitFor(app, label, async () => (await feature('solana:signTransaction')).signTransaction({ account: s.account, transaction, chain: 'solana:mainnet' }))
    return { signedTransaction: b64(out.signedTransaction) }
  }
  if (method === 'signAndSendTransaction') {
    const [out] = await waitFor(app, label, async () => (await feature('solana:signAndSendTransaction')).signAndSendTransaction({ account: s.account, transaction, chain: 'solana:mainnet' }))
    return { signature: base58(out.signature) }
  }
  throw rpcError(4200, `Quilcast doesn't support ${method}.`)
}

// --- tokens ---

const amountOk = (v: unknown) => typeof v === 'string' && /^\d{1,78}$/.test(v) && BigInt(v) > 0n
const info = (t: TokenId) => {
  const c = CHAINS[t.chain]
  if (!c) throw new Error('Quilcast has no RPC for that chain.')
  return tokenInfo((m, p) => publicRpc(t.chain, m, p), t, c.nativeCurrency)
}
const fmt = (n: bigint, t: Token) => `${Number(formatUnits(n, t.decimals)).toLocaleString(lang, { maximumFractionDigits: 6 })} ${t.symbol}`
const Field = ({ label, value, set, ph }: { label: string; value: string; set: (v: string) => void; ph?: string }) => (
  <label class="field"><span>{label}</span><input value={value} placeholder={ph} onInput={(e) => set(e.currentTarget.value.trim())} /></label>
)

/** Wait until a transaction is mined, so the next one (a swap after its approval) sees it. */
async function mined(chain: number, hash: string) {
  for (let i = 0; i < 60; i++) {
    const r = await publicRpc(chain, 'eth_getTransactionReceipt', [hash]).catch(() => null)
    if (r) return r.status === '0x1' ? r : Promise.reject(new Error('The approval failed on chain.'))
    await new Promise((x) => setTimeout(x, 2000))
  }
  throw new Error('The approval is taking too long.')
}

const sendOn = (app: App, w: Wallet, chain: number, tx: { to: string; data: string; value: string; gas?: string }) => {
  // the same rules as any request from the app (no Farcaster contracts)
  checkWallet(app.host, w.address!, 'eth_sendTransaction', [{ from: w.address, ...tx }])
  return waitFor(app, t('Check {wallet}', { wallet: w.name }), () => serial(async () => (await align(w, chain), w.provider.request({ method: 'eth_sendTransaction', params: [{ from: w.address, ...tx }] })))) as Promise<string>
}
const failed = (e: any, kind: 'send_failed' | 'swap_failed') =>
  e?.code === 4001 ? { success: false, reason: 'rejected_by_user' } : { success: false, reason: kind, error: { error: kind, message: String(e?.message || e).slice(0, 300) } }

async function sendToken(app: App, o: any = {}) {
  foreground(app)
  try {
    const tk = await info(parseToken(o.token ?? 'eip155:8453/slip44:60'))
    let to = typeof o.recipientAddress === 'string' && /^0x[0-9a-f]{40}$/i.test(o.recipientAddress) ? o.recipientAddress.toLowerCase() : ''
    let who = to
    if (!to && Number.isSafeInteger(o.recipientFid) && o.recipientFid > 0) {
      const u = (await getUser(o.recipientFid)) as User & { verified_addresses?: { primary?: { eth_address?: string }; eth_addresses?: string[] } }
      to = u.verified_addresses?.primary?.eth_address || u.verified_addresses?.eth_addresses?.[0] || ''
      if (!to) throw new Error(t('@{name} has no verified Ethereum address.', { name: handle(u) }))
      who = `@${handle(u)} (${to.slice(0, 6)}…${to.slice(-4)})`
    }
    const form = { amount: amountOk(o.amount) ? formatUnits(BigInt(o.amount), tk.decimals) : '', to }
    const ok = await ask(app, {
      title: t('Send {symbol}?', { symbol: tk.symbol }), yes: t('Send'),
      body: who
        ? t('{host} asked to send {symbol} on {chain} to {who}. Your wallet asks you to confirm.', { host: app.host, symbol: tk.symbol, chain: CHAINS[tk.chain].name, who })
        : t('{host} asked to send {symbol} on {chain}. Your wallet asks you to confirm.', { host: app.host, symbol: tk.symbol, chain: CHAINS[tk.chain].name }),
      extra: () => <>{!who && <Field label={t('To (address)')} value={form.to} set={(v) => (form.to = v)} ph="0x…" />}<Field label={t('Amount ({symbol})', { symbol: tk.symbol })} value={form.amount} set={(v) => (form.amount = v)} ph="0.0" /></>,
    })
    if (!ok) return { success: false, reason: 'rejected_by_user' }
    if (!/^0x[0-9a-f]{40}$/i.test(form.to)) throw new Error('That address is not valid.')
    const amount = parseUnits(form.amount || '0', tk.decimals)
    if (amount <= 0n) throw new Error('Enter an amount.')
    await connect(app)
    return { success: true, send: { transaction: await sendOn(app, live(app), tk.chain, transferTx(tk, form.to, amount)) } }
  } catch (e: any) {
    e?.code !== 4001 && toast(e.message)
    return failed(e, 'send_failed')
  }
}

async function swapToken(app: App, o: any = {}) {
  foreground(app)
  try {
    const buyId = o.buyToken ? parseToken(o.buyToken) : undefined
    const sellId = o.sellToken ? parseToken(o.sellToken) : { chain: buyId?.chain ?? base.id }
    const buyAt = buyId || (USDC[sellId.chain] ? { chain: sellId.chain, address: USDC[sellId.chain] } : null)
    if (!buyAt) throw new Error('Pick a token to buy.')
    const [sell, buy] = await Promise.all([info(sellId), info(buyAt)])
    const [from] = await connect(app)
    let amount = amountOk(o.sellAmount) ? BigInt(o.sellAmount) : 0n
    if (!amount) {
      const form = { amount: '' }
      if (!(await ask(app, { title: t('Swap {sell} for {buy}', { sell: sell.symbol, buy: buy.symbol }), yes: t('Get a quote'), body: t('How much {symbol} do you want to sell?', { symbol: sell.symbol }), extra: () => <Field label={t('Amount ({symbol})', { symbol: sell.symbol })} value={form.amount} set={(v) => (form.amount = v)} ph="0.0" /> })))
        return { success: false, reason: 'rejected_by_user' }
      amount = parseUnits(form.amount || '0', sell.decimals)
      if (amount <= 0n) throw new Error('Enter an amount.')
    }
    const q = await waitFor(app, t('Finding a swap route…'), () => quote(sell, buy, amount, from))
    const ok = await ask(app, {
      title: t('Swap {sell} for {buy}?', { sell: sell.symbol, buy: buy.symbol }), yes: t('Swap'),
      body: t('Sell {sell} and get about {buy} (at least {min}), routed by LI.FI. {host} asked for this swap; your wallet asks you to confirm.', { sell: fmt(amount, sell), buy: fmt(q.toAmount, buy), min: fmt(q.toAmountMin, buy), host: app.host }),
    })
    if (!ok) return { success: false, reason: 'rejected_by_user' }
    const w = live(app)
    const transactions: string[] = []
    // a token needs an approval for exactly this amount first, to LI.FI's contract only
    if (sell.address && (await allowance((m, p) => publicRpc(sell.chain, m, p), sell, from)) < amount) {
      transactions.push(await sendOn(app, w, sell.chain, approveTx(sell, amount)))
      await waitFor(app, t('Waiting for the approval…'), () => mined(sell.chain, transactions[0]))
    }
    transactions.push(await sendOn(app, w, sell.chain, q.tx))
    return { success: true, swap: { transactions } }
  } catch (e: any) {
    e?.code !== 4001 && toast(e.message)
    return failed(e, 'swap_failed')
  }
}

function viewToken(app: App, o: any = {}) {
  foreground(app)
  const t = parseToken(o.token)
  const c = CHAINS[t.chain]
  const site = c?.blockExplorers?.default.url
  if (!site) throw new Error('Quilcast has no explorer for that chain.')
  open(t.address ? `${site}/token/${t.address}` : site, '_blank', 'noopener,noreferrer')
}

// --- notifications ---

const api = async (path: string, body: object) => {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`)
  return j
}
const inboxSecret = () => {
  let a = account!
  if (!a.inbox) setAccount((a = { ...a, inbox: hex(crypto.getRandomValues(new Uint8Array(32))) }))
  return a.inbox!
}
const notifying = (origin: string) => !!account?.notify?.includes(origin)
const savedApps = () => read<AppMeta[]>('quilcast:apps', [])
export const manifestOf = (origin: string): Promise<{ name?: string; iconUrl?: string; webhook?: boolean } | null> =>
  fetch(`/api/manifest?origin=${encodeURIComponent(origin)}`).then((r) => r.json(), () => null)
const details = (m: AppMeta) => api('/api/notify/token', { inbox: inboxSecret(), origin: new URL(m.url).origin, name: m.name, icon: m.icon }) as Promise<{ token: string; url: string }>

/** Pushes to this browser for every app with notifications on (permission asked first, see askPush). */
export async function enablePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error("This browser can't show notifications.")
  if (Notification.permission !== 'granted' && (await askPush()) !== 'granted') throw new Error('Notifications are blocked for Quilcast in this browser. Allow them in the site settings (the icon left of the address).')
  const reg = await navigator.serviceWorker.register('/sw.js')
  await navigator.serviceWorker.ready
  const { key } = await (await fetch('/api/notify/vapid')).json()
  // a browser without a reachable push service never answers, so this gives up instead of spinning forever
  const timeout = new Promise<never>((_, no) => setTimeout(() => no(new Error("This browser's push service didn't answer. Try again in a minute.")), 20000))
  const sub = (await reg.pushManager.getSubscription()) || (await Promise.race([reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: unb64(key) }), timeout]))
  await api('/api/notify/push', { inbox: inboxSecret(), subscription: sub.toJSON() })
}
export async function disablePush() {
  const sub = await (await navigator.serviceWorker?.getRegistration('/sw.js'))?.pushManager.getSubscription()
  await sub?.unsubscribe()
  if (account?.inbox) await api('/api/notify/push', { inbox: account.inbox, subscription: null }).catch(() => {})
}

/** Turn an app's notifications on or off: a token from our server, handed to the app in a signed webhook event
 *  that our server delivers to the webhook in its manifest. The first time, this adds the on-chain app key. */
export async function setNotify(m: AppMeta, on: boolean, event?: 'miniapp_added' | 'miniapp_removed', wait?: (s: string) => void) {
  const origin = new URL(m.url).origin
  const d = on ? await details(m) : undefined
  const signed = await signEvent(on ? { event: event || 'notifications_enabled', notificationDetails: d } : { event: event || 'notifications_disabled' }, wait)
  const r = await api('/api/notify/event', { origin, event: signed })
  if (!on) await api('/api/notify/forget', { inbox: inboxSecret(), origin })
  setAccount({ ...account!, notify: on ? [...new Set([...(account!.notify || []), origin])] : (account!.notify || []).filter((o) => o !== origin) })
  if (on && r.status && (r.status < 200 || r.status >= 300)) toast(t('{name} answered {status} when turning notifications on.', { name: m.name || origin, status: r.status }))
  return d
}

// --- Farcaster actions ---

const userCtx = (u: User) => ({ fid: u.fid, username: u.username?.startsWith('fid:') ? undefined : u.username, displayName: u.display_name, pfpUrl: u.pfp_url })
const castCtx = (c: Cast) => ({
  author: userCtx(c.author), hash: '0x' + c.hash.replace(/^0x/, ''), parentHash: c.parent_hash || undefined, parentFid: c.parent_author?.fid || undefined,
  timestamp: Date.parse(c.timestamp), text: castText(c), embeds: c.embeds.flatMap((e) => e.url ?? []), channelKey: channelOf(c.parent_url),
})
const haptics = 'vibrate' in navigator

const context = async (app: App) => ({
  client: {
    platformType: narrow() ? 'mobile' : 'web', clientFid: QUILCAST_FID, added: savedApps().some((s) => s.url === app.url),
    notificationDetails: notifying(app.origin) ? await details(app).catch(() => undefined) : undefined, safeAreaInsets: { top: 0, bottom: 0, left: 0, right: 0 },
  },
  user: userCtx(myUser()!),
  location: app.notification ? { type: 'notification', notification: app.notification }
    : app.cast ? { type: 'cast_embed', embed: app.embed, cast: castCtx(app.cast) }
      : app.from ? { type: 'open_miniapp', referrerDomain: app.from } : { type: 'launcher' },
  features: { haptics, cameraAndMicrophoneAccess: true },
})

// on a phone the app covers the screen, so it steps aside for the cast or profile it opened
const leave = (app: App, path: string) => (narrow() && show(null), go(path))

async function compose(app: App, o: any = {}) {
  foreground(app)
  const embeds = (Array.isArray(o.embeds) ? o.embeds : []).slice(0, 2).flatMap((u: unknown) => safeUrl(String(u)) ?? [])
  const parent = typeof o.parent?.hash === 'string' ? await fetchCast(o.parent.hash) : undefined
  if (parent === null) throw new Error('That cast is unavailable.')
  const channel = typeof o.channelKey === 'string' && /^[a-z0-9-]{1,64}$/.test(o.channelKey) ? o.channelKey : undefined
  const text = typeof o.text === 'string' ? o.text.slice(0, 1024) : ''
  const hash = await new Promise<string | null>((onDone) => shell.compose({ text, embeds, parent, channel, onDone }))
  if (o.close) return close(app)
  return { cast: hash && { hash: '0x' + hash, text, embeds, parent: parent && { type: 'cast', hash: '0x' + parent.hash }, channelKey: channel } }
}

async function signIn(app: App, o: any = {}) {
  foreground(app)
  const a = account!
  const custody = await custodyOf(a)
  const me = myUser()!
  // checked before asking, so a bad request never shows a prompt
  const draft = () => siwf({ origin: app.origin, address: custody.address, fid: a.fid!, nonce: o.nonce, notBefore: o.notBefore, expirationTime: o.expirationTime })
  draft()
  if (!(await ask(app, { title: t('Sign in to {site}?', { site: app.name }), yes: t('Sign in'), body: t('{host} will know you as @{name} (fid {fid}). This signs a sign-in message with your account.', { host: app.host, name: handle(me), fid: me.fid }) })))
    return { error: { type: 'rejected_by_user' } }
  const message = draft()
  const sig = await waitFor(app, a.wallet ? t('Check your wallet') : t('Signing…'), () => custody.message(new TextEncoder().encode(message)))
  return { result: { message, signature: '0x' + hex(sig), authMethod: 'custody' } }
}

async function addApp(app: App) {
  foreground(app)
  // the spec has hosts check the domain's manifest before adding
  const m = await manifestOf(app.origin)
  if (!m) return { error: { type: 'invalid_domain_manifest' } }
  const meta = { url: app.url, name: app.name, icon: app.icon }
  const saved = savedApps().some((s) => s.url === app.url)
  let d: { url: string; token: string } | undefined
  if (saved && (notifying(app.origin) || !m.webhook)) d = notifying(app.origin) ? await details(meta).catch(() => undefined) : undefined
  else {
    const form = { notify: !!m.webhook }
    const ok = await ask(app, {
      title: t('Add {name} to your apps?', { name: app.name }), yes: t('Add'), body: t('It shows up under Mini apps, so you can open it again from there.'),
      extra: m.webhook ? () => <label class="check"><input type="checkbox" checked={form.notify} onChange={(e) => (form.notify = e.currentTarget.checked)} />{t('Notifications from {name}', { name: app.name })}</label> : undefined,
    })
    if (!ok) return emit(app, { event: 'miniapp_add_rejected', reason: 'rejected_by_user' }), { error: { type: 'rejected_by_user' } }
    // still inside the click, so the browser lets us ask
    const permission = form.notify ? askPush() : null
    saved || save('quilcast:apps', [meta, ...savedApps()])
    if (form.notify) {
      try {
        d = await waitFor(app, t('Turning on notifications…'), () => setNotify(meta, true, 'miniapp_added', (s) => ((app.waiting = s), update())))
        if ((await permission) === 'granted') enablePush().catch(() => {})
      } catch (e: any) {
        toast(e.message)
      }
    }
  }
  emit(app, { event: 'miniapp_added', notificationDetails: d })
  return { result: d ? { notificationDetails: d } : {} }
}

async function media(app: App) {
  foreground(app)
  if (app.media) return
  const ok = await ask(app, { title: t('Let {name} use your camera and microphone?', { name: app.name }), yes: t('Allow'), body: t("{host} reloads once to get access, and your browser asks you too. You can take it back from the app's menu.", { host: app.host }) })
  if (!ok) throw new Error('Camera and microphone access was declined.')
  allow('media', app.origin, '1')
  app.media = true
  // the frame's allow attribute only applies to its next page load
  update()
  reload(app)
}

function openUrl(app: App, raw: unknown) {
  foreground(app)
  const u = safeUrl(typeof raw === 'string' ? raw.trim() : (raw as any)?.url)
  if (!u) throw new Error('That is not a web link.')
  const x = new URL(u)
  // farcaster.xyz's compose links open our composer
  if (/^(www\.)?(warpcast\.com|farcaster\.xyz)$/.test(x.hostname) && x.pathname === '/~/compose')
    return compose(app, { text: x.searchParams.get('text') || '', embeds: x.searchParams.getAll('embeds[]'), channelKey: x.searchParams.get('channelKey') })
  open(u, '_blank', 'noopener,noreferrer')
}

const capabilities = () => [
  'wallet.getEthereumProvider', 'actions.ready', 'actions.openUrl', 'actions.close', 'actions.setPrimaryButton', 'actions.addMiniApp', 'actions.signIn', 'actions.viewCast',
  'actions.viewProfile', 'actions.composeCast', 'actions.openMiniApp', 'actions.viewToken', 'actions.sendToken', 'actions.swapToken', 'actions.requestCameraAndMicrophoneAccess', 'back',
  ...(solWallets.length ? ['wallet.getSolanaProvider'] : []), ...(haptics ? ['haptics.impactOccurred', 'haptics.notificationOccurred', 'haptics.selectionChanged'] : []),
]
const LOGO_ICON = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="9" fill="#6447f5"/><path d="${LOGO}" fill="#fff"/></svg>`)}`
// only the app on screen can buzz the phone
const buzz = (app: App, pattern: number | number[]) => void (shown === app.id && navigator.vibrate?.(pattern))
const IMPACT: Record<string, number> = { light: 10, soft: 10, medium: 20, rigid: 25, heavy: 35 }

const calls: Record<string, (app: App, ...a: any[]) => unknown> = {
  ready: (app) => void ((app.ready = true), update()),
  close: (app) => close(app),
  openUrl,
  openMiniApp: async (app, o) => {
    foreground(app)
    const u = safeUrl(o?.url)
    if (!u) throw new Error('That is not a web link.')
    await launchUrl(u, app.host)
  },
  viewCast: (app, o) => {
    const h = String(o?.hash || '').replace(/^0x/, '')
    if (!/^[0-9a-f]{40}$/i.test(h)) throw new Error('Invalid cast hash.')
    leave(app, `/c/${h}`)
  },
  viewProfile: (app, o) => {
    if (!Number.isSafeInteger(o?.fid) || o.fid <= 0) throw new Error('Invalid fid.')
    leave(app, `/u/${o.fid}`)
  },
  composeCast: compose,
  signIn,
  addMiniApp: addApp,
  addFrame: addApp,
  setPrimaryButton: (app, o) => {
    app.button = typeof o?.text === 'string' ? { text: o.text.slice(0, 40), loading: !!o.loading, disabled: !!o.disabled, hidden: !!o.hidden } : undefined
    update()
  },
  updateBackState: (app, o) => void ((app.back = !!o?.visible), update()),
  ethProviderRequestV2: (app, r) =>
    eth(app, r).then(
      (result) => ({ jsonrpc: '2.0', id: r?.id, result }),
      (e) => ({ jsonrpc: '2.0', id: r?.id, error: { code: typeof e?.code === 'number' ? e.code : -32603, message: String(e?.shortMessage || e?.message || 'Wallet error').slice(0, 500) } }),
    ),
  ethProviderRequest: eth,
  eip6963RequestProvider: (app) => emit(app, { event: 'eip6963:announceProvider', info: { uuid: app.uuid, name: 'Quilcast', icon: LOGO_ICON, rdns: 'com.quilcast' } }),
  solanaProviderRequest: sol,
  getCapabilities: capabilities,
  getChains: () => [...Object.keys(CHAINS).map((id) => `eip155:${id}`), ...(solWallets.length ? ['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'] : [])],
  impactOccurred: (app, t) => buzz(app, Object.hasOwn(IMPACT, t) ? IMPACT[t] : 15),
  notificationOccurred: (app, t) => buzz(app, t === 'success' ? [15, 60, 15] : t === 'warning' ? [30, 60, 30] : [50, 60, 50, 60, 50]),
  selectionChanged: (app) => buzz(app, 5),
  requestCameraAndMicrophoneAccess: media,
  viewToken,
  sendToken,
  swapToken,
  signManifest: () => ({ error: { type: 'rejected_by_user' } }),
}

addEventListener('message', (e) => {
  // only the app's own frame, still on the origin it was opened at
  const app = apps.find((a) => a.frame?.contentWindow && a.frame.contentWindow === e.source)
  const d = e.data
  if (!app || e.origin !== app.origin || !d || typeof d !== 'object' || typeof d.id !== 'string' || !Array.isArray(d.path) || d.path.length !== 1) return
  const name = String(d.path[0])
  // plain values only: no proxies (MessagePorts) or other Comlink handlers
  const args = (Array.isArray(d.argumentList) ? d.argumentList : []).map((v: any) => (v?.type === 'RAW' ? v.value : undefined))
  let out: unknown
  try {
    out = d.type === 'GET' && name === 'context' ? context(app)
      : d.type === 'APPLY' && Object.hasOwn(calls, name) ? calls[name](app, ...args)
        : Promise.reject(new Error(`Quilcast doesn't support ${name}.`))
  } catch (err) {
    out = Promise.reject(err)
  }
  const fail = (err: any) => post(app, { id: d.id, type: 'HANDLER', name: 'throw', value: { isError: true, value: { message: String(err?.message || err), name: 'Error' } } })
  Promise.resolve(out).then((value) => {
    try {
      app.frame?.contentWindow?.postMessage({ id: d.id, type: 'RAW', value }, app.origin)
    } catch (err) {
      fail(err)
    }
  }, fail)
})

// --- UI ---

// an icon that fails to load falls back to the name's first letter
const AppIcon = ({ app }: { app: App }) =>
  app.icon ? <img class="app-icon" alt="" referrerpolicy="no-referrer" src={app.icon} onError={() => ((app.icon = undefined), update())} /> : <span class="app-icon">{[...app.name][0]}</span>
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

async function pickSol(app: App, w: SolWallet) {
  try {
    await useSol(app, w)
  } catch (e: any) {
    toast(e.message)
  }
}

function WalletMenu({ app }: { app: App }) {
  const [open, setOpen] = useState(false)
  if (!wallets.length && !solWallets.length) return null
  const on = app.connected && app.wallet?.address
  return (
    <span class="wrap-menu">
      <button class="wallet-btn" aria-haspopup="menu" aria-label={on ? t('Wallet {name}, {address}', { name: app.wallet!.name, address: on }) : t('Wallet')} onClick={() => setOpen(!open)}>
        <WalletIcon w={app.wallet} />{on && <span>{short(on)}</span>}
      </button>
      {open && (
        <Menu class="right" close={() => setOpen(false)}>
          {wallets.length > 0 && <div class="menu-label muted">{on ? t('{host} sees this wallet', { host: app.host }) : t('Wallet for this app')}</div>}
          {wallets.map((w) => <button role="menuitemradio" aria-checked={w === app.wallet} onClick={() => (setOpen(false), pick(app, w))}><WalletIcon w={w} /><span class="wname">{w.name}</span>{w === app.wallet && <Icon d={P.check} />}</button>)}
          {app.connected && <button role="menuitem" onClick={() => (setOpen(false), disconnect(app))}><Icon d={P.x} />{t('Disconnect')}</button>}
          {app.sol && solWallets.length > 0 && <div class="menu-label muted">Solana</div>}
          {app.sol && solWallets.map((w) => <button role="menuitemradio" aria-checked={w === app.sol?.wallet} onClick={() => (setOpen(false), pickSol(app, w))}><WalletIcon w={w} /><span class="wname">{w.name}</span>{w === app.sol?.wallet && <Icon d={P.check} />}</button>)}
        </Menu>
      )}
    </span>
  )
}

function AppMenu({ app }: { app: App }) {
  const [open, setOpen] = useState(false)
  const item = (label: string, f: () => void) => <button role="menuitem" onClick={() => (setOpen(false), f())}>{label}</button>
  return (
    <span class="wrap-menu">
      <button class="icon-btn" aria-label={t('More')} aria-haspopup="menu" onClick={() => setOpen(!open)}><Icon d={P.more} /></button>
      {open && (
        <Menu class="right" close={() => setOpen(false)}>
          {item(isPinned(app.url) ? t('Unpin from the dock') : t('Pin to the dock'), () => togglePin(app))}
          {item(t('Reload'), () => reload(app))}
          {item(t('Copy link'), () => navigator.clipboard.writeText(app.url).then(() => toast('Link copied')))}
          {app.media && item(t('Take back camera and mic'), () => (allow('media', app.origin, null), (app.media = false), update(), reload(app)))}
          {app.sol && item(t('Disconnect Solana wallet'), () => (allow('solana', app.origin, null), (app.sol = undefined), update()))}
        </Menu>
      )}
    </span>
  )
}

function AskCard({ app }: { app: App }) {
  const a = app.ask!
  return (
    <div class="mini-ask" role="dialog" aria-label={a.title}>
      <div class="ask-card">
        <AppIcon app={app} />
        <b>{a.title}</b>
        <p>{a.body}</p>
        {a.extra?.()}
        <div class="btns">
          <button class="btn ghost small" onClick={() => a.done(false)}>{t('Cancel')}</button>
          {/* the yes button ignores clicks for its first second, so an app can't time a click (or the second half of a
              double-click it asked for) onto it */}
          <button class="btn small arm" onClick={() => Date.now() - a.at > 1000 && a.done(true)}>{a.yes}</button>
        </div>
      </div>
    </div>
  )
}

function Window({ app }: { app: App }) {
  const on = shown === app.id
  const b = app.button
  return (
    <section class={`mini${on ? '' : ' away'}`} aria-label={app.name} aria-hidden={!on}>
      <header class="mini-top">
        {app.back ? <button class="icon-btn" aria-label={t('Back')} onClick={() => emit(app, { event: 'back_navigation_triggered' })}><Icon d={P.back} /></button> : <AppIcon app={app} />}
        <span class="mini-name"><b>{app.name}</b><small>{app.host}</small></span>
        <WalletMenu app={app} />
        <AppMenu app={app} />
        <button class="icon-btn" aria-label={t('Minimize')} onClick={() => show(null)}><Icon d={P.min} /></button>
        <button class="icon-btn" aria-label={t('Close')} onClick={() => close(app)}><Icon d={P.x} /></button>
      </header>
      <div class="mini-body">
        {/* its own origin (never ours, see launch), no top navigation or location; camera and mic only once allowed */}
        <iframe ref={(el) => void (el && (app.frame = el))} src={app.url} title={app.name} allow={`clipboard-write; web-share${app.media ? '; camera; microphone' : ''}`}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
          // apps that never call ready() still show up after a while
          onLoad={() => setTimeout(() => void (app.ready || ((app.ready = true), update())), 5000)} />
        {!app.ready && <div class="splash" style={{ background: app.bg }}>{app.icon ? <Img src={app.icon} /> : <span class="spinner" />}</div>}
        {app.waiting && <div class="mini-wait" role="status"><span class="spinner small" />{app.waiting}</div>}
        {app.ask && <AskCard app={app} />}
      </div>
      {b && !b.hidden && <button class="btn mini-primary" disabled={b.disabled || b.loading} onClick={() => emit(app, { event: 'primary_button_clicked' })}>{b.loading ? <span class="spinner small" /> : b.text}</button>}
    </section>
  )
}

function Host() {
  const [, force] = useState(0)
  update = () => force((x) => x + 1)
  // the dock lives in the app shell (it also shows pinned apps before any is open); tell it what's open
  shell.dock = { apps: apps.map(({ id, url, name, icon }) => ({ id, url, name, icon })), shown, show: (id) => show(shown === id ? null : apps.find((a) => a.id === id) || null) }
  useEffect(() => void dispatchEvent(new Event('dock')))
  // the windows keep their order, so iframes never move in the DOM (moving one reloads it)
  return <>{apps.map((app) => <Window key={app.id} app={app} />)}</>
}

void syncLocal()
