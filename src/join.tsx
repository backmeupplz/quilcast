import { generateMnemonic, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { useEffect, useRef, useState } from 'preact/hooks'
import { account, accounts, get, getUser, go, idOf, setAccount, settings, USER_DATA, type Account } from './api.ts'
import { fidOf } from './eth.ts'
import { address, custodyKey, fnameProof } from './fc.ts'
import { t } from './i18n.ts'
import { isNative, nativeFid, registerNative } from './native.ts'
import { Choose } from './ui.tsx'
import type { Choice } from './wallet.ts'
import { custodyOf, ensureSigner, sendSignup, setUserData } from './write.ts'
import { firstSignIn } from './campaign.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// likes and recasts load in the background once the account is set; the feed doesn't wait for them
const finish = async (a: Account) => {
  const u = await getUser(a.fid!).catch(() => null)
  // the account as ensureSigner saved it, with its new key
  const saved = accounts.find((x) => idOf(x) === idOf(a)) || a
  const before = accounts.some((x) => x.done && idOf(x) !== idOf(a))
  setAccount({ ...saved, username: a.username || u?.username, done: true })
  // this browser's first sign-in, from a campaign's link: the campaign's count goes up by one
  const campaign = firstSignIn(before)
  if (campaign) sendSignup(campaign, saved).catch(() => {})
  go('/')
}

const Steps = ({ steps, at }: { steps: string[]; at: number }) => (
  <ol class="steps">{steps.map((s, i) => <li class={i < at ? 'done' : i === at ? 'now' : ''}>{s}</li>)}</ol>
)

// each step is its own path, so the header's back arrow and the browser's both return to the choices
export function Join({ step }: { step?: string }) {
  if (account && !account.done) return <Setup />
  if (step === 'create') return <Create />
  if (step === 'signin') return <SignIn />
  if (step === 'wallet') return <WalletIn />
  return (
    <div class="join">
      <h1>{account ? t('Add an account') : t('Join Farcaster on Hypersnap')}</h1>
      <p class="lede">{t('Quilcast is a small, open client that reads from and posts to the Hypersnap network that Quilibrium runs. There is no server in between, and your keys stay in this browser.')}</p>
      <button class="choice" onClick={() => go('/join/create')}>
        <b>{t('Create a new account')}</b>
        <span>{t('Pick a name and sign up for free. Your device does a few seconds of work instead of paying a fee.')}</span>
      </button>
      <button class="choice" onClick={() => go('/join/signin')}>
        <b>{t('I already have an account')}</b>
        <span>{t('Sign in with the recovery phrase from Warpcast, Quorum or any other Farcaster app.')}</span>
      </button>
      <button class="choice" onClick={() => go('/join/wallet')}>
        <b>{t('Use a wallet')}</b>
        <span>{t('Connect MetaMask, Rabby or another wallet that owns a Farcaster account, or create a free one with it. The wallet keeps its keys and you approve each signature.')}</span>
      </button>
    </div>
  )
}

// A new account is registered on Hypersnap itself (native.ts), free. It gets no fname: Farcaster's username server
// only takes names for FIDs on Optimism, so only a display name is asked for.
function Create({ wallet }: { wallet?: string }) {
  const [display, setDisplay] = useState('')
  const go = async () => {
    const phrase = wallet ? '' : generateMnemonic(wordlist)
    // a phrase account is known by its custody address, never by the phrase
    setAccount({ phrase, wallet, custody: phrase ? address(await custodyKey(phrase)) : undefined, display: display.trim() })
  }
  return (
    <div class="join">
      <h1>{t('Pick your name')}</h1>
      {wallet && <p class="lede">{t('No Farcaster account belongs to {address} yet. Pick a name, and the wallet signs a free registration.', { address: short(wallet) })}</p>}
      <label>{t('Display name')}<input value={display} onInput={(e) => setDisplay(e.currentTarget.value)} placeholder={t('Your Name')} maxLength={32} autoFocus /></label>
      <p class="muted">{t("New accounts don't get an @username yet, because Farcaster's username service only knows accounts registered on Optimism. Your display name and account number show instead.")}</p>
      <button class="btn wide" disabled={!display.trim()} onClick={go}>{t('Continue')}</button>
    </div>
  )
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

/** The FID whose custody address this is: Hypersnap first (fast), Optimism when the node doesn't know it.
 *  A wrong FID can't sign in anyway: the network only takes a key signed by that FID's custody address. */
async function fidFor(addr: string) {
  const u = (await get('/v2/farcaster/user/custody-address', { custody_address: addr }).catch(() => null))?.user
  return typeof u?.fid === 'number' && u.fid > 0 && String(u.custody_address).toLowerCase() === addr.toLowerCase() ? u.fid : (await nativeFid(addr).catch(() => 0)) || fidOf(settings.rpc, addr)
}

// the account exists: add a signing key for this browser, then load the profile
async function enter(a: Account, step: (i: number) => void) {
  step(2)
  await ensureSigner(a)
  step(3)
  await finish(a)
}

/** A sign-in in steps: `step(i)` marks progress, a throw shows its message, `at` is -1 when idle. */
function useFlow() {
  const [err, setErr] = useState('')
  const [at, setAt] = useState(-1)
  const run = (f: (step: (i: number) => void) => Promise<unknown>) => async () => {
    setErr('')
    try {
      await f(setAt)
    } catch (e: any) {
      setErr(e.message)
    }
    setAt(-1)
  }
  return { err, at, busy: at >= 0, run }
}
const Progress = ({ err, at, steps }: { err: string; at: number; steps: string[] }) => (
  <>
    {err && <p class="warn">{t(err)}</p>}
    {at >= 0 && <section class="card"><Steps steps={steps} at={at} /></section>}
  </>
)

const WALLET_IN = () => [t('Connecting your wallet'), t('Finding your Farcaster account'), t('Two signatures in your wallet add a signing key for this browser'), t('Loading your profile')]
function WalletIn() {
  const f = useFlow()
  const [none, setNone] = useState('')
  const [wallets, setWallets] = useState<Choice[]>([])
  const [pick, setPick] = useState<Choice>()
  const [pair, setPair] = useState<{ uri: string; img: string }>()
  // the wallets announce themselves while wallet.ts loads, so the list has to be in before the first click
  useEffect(() => void import('./wallet.ts').then((m) => (setWallets(m.choices()), setPick(m.choices()[0]))), [])
  // a wallet without a Farcaster account can register one
  if (none) return <Create wallet={none} />
  const connect = f.run(async (step) => {
    step(0)
    const w = await import('./wallet.ts')
    const addr = await w.connect(pick?.key, async (uri) => setPair(uri ? { uri, img: await w.qr(uri) } : undefined))
    step(1)
    const fid = await fidFor(addr)
    fid ? await enter({ phrase: '', wallet: addr, fid, done: true }, step) : setNone(addr)
  })
  return (
    <div class="join">
      <h1>{t('Use a wallet')}</h1>
      <p class="lede">{t('Connect the wallet that owns your Farcaster account. Quilcast never sees its keys: the wallet approves a signing key for this browser, and after that it asks only when something needs the account itself, like claiming a username or signing in to a mini app.')}</p>
      {wallets.length > 1 && !f.busy && <section class="card"><Choose list={wallets} value={pick} set={setPick} /></section>}
      {pair && (
        <section class="card pair">
          <img src={pair.img} alt={t('WalletConnect QR code')} />
          <p>{t('Scan this with the wallet on your phone, or open it in a wallet app on this device.')}</p>
          <a class="btn" href={pair.uri}>{t('Open in a wallet app')}</a>
        </section>
      )}
      <Progress {...f} steps={WALLET_IN()} />
      <button class="btn wide" disabled={f.busy} onClick={connect}>{f.busy ? t('Check your wallet…') : t('Connect wallet')}</button>
    </div>
  )
}

const SIGN_IN = () => [t('Reading your recovery phrase'), t('Finding your Farcaster account'), t('Adding a signing key for this browser'), t('Loading your profile')]
function SignIn() {
  const f = useFlow()
  const [phrase, setPhrase] = useState('')
  const signIn = f.run(async (step) => {
    const p = phrase.trim().toLowerCase().split(/\s+/).join(' ')
    if (!validateMnemonic(p, wordlist)) throw new Error("That doesn't look like a valid recovery phrase. Check the words and their order.")
    step(0)
    const addr = address(await custodyKey(p))
    step(1)
    const fid = await fidFor(addr)
    if (!fid) throw new Error('No Farcaster account belongs to this phrase.')
    await enter({ phrase: p, custody: addr, fid, done: true }, step)
  })
  return (
    <div class="join">
      <h1>{t('Sign in')}</h1>
      <p class="lede">{t('Enter the 12 or 24 word recovery phrase of your Farcaster account. Quilcast keeps it in this browser and uses it to add a signing key for this device.')}</p>
      <textarea rows={4} value={phrase} disabled={f.busy} onInput={(e) => setPhrase(e.currentTarget.value)} placeholder={t('apple banana cherry …')} autocapitalize="none" autocomplete="off" spellcheck={false} data-gramm="false" data-lt-active="false" />
      <Progress {...f} steps={SIGN_IN()} />
      <button class="btn wide" disabled={f.busy || !phrase.trim()} onClick={signIn}>{f.busy ? t('Signing in…') : t('Sign in')}</button>
    </div>
  )
}

const SETUP = () => [t('Doing the sign-up work on this device'), t('Registering your account on Hypersnap'), t('Adding a signing key for this browser'), t('Loading your profile')]

// Registration and first-time setup. Every step is re-derived from the node, so a reload resumes wherever it stopped.
function Setup() {
  const a = account!
  // a phrase account shows its phrase to save first; a wallet holds its own keys
  const [begun, setBegun] = useState(!!a.wallet || !!a.fid)
  const [saved, setSaved] = useState(false)
  const [at, setAt] = useState(a.fid ? 2 : 0)
  const [err, setErr] = useState('')
  const [quit, setQuit] = useState(0)
  const retry = useRef<() => void>(undefined)

  // a phrase registered on an earlier visit skips the phrase step
  useEffect(() => void (!begun && nativeFid(a.custody!).then((fid) => fid && (setAccount({ ...account!, fid }), setBegun(true)), () => {})), [])

  useEffect(() => {
    if (!begun) return
    const stop = new AbortController()
    ;(async () => {
      const custody = await custodyOf(a)
      for (let i = 0; !stop.signal.aborted; i++) {
        try {
          let acc = account!
          if (!acc.fid) {
            setAt(0)
            const fid = await registerNative(custody, (s) => setAt(s === 'work' ? 0 : 1), stop.signal)
            setAccount((acc = { ...account!, fid }))
            setErr('')
          }
          setAt(2)
          if (!acc.signer) await ensureSigner(acc)
          // set once: the node has it from then on
          if (acc.display && !(await getUser(acc.fid!).then((u) => u.display_name === acc.display, () => false))) await setUserData(USER_DATA.DISPLAY, acc.display)
          // an account started on Optimism before Hypersnap's fork still claims the fname it picked
          if (acc.username && !isNative(acc.fid) && !(await getUser(acc.fid!).then((u) => u.username === acc.username, () => false))) {
            const proof = await fetch(`https://fnames.farcaster.xyz/transfers/current?name=${acc.username}`).then((r) => r.json())
            if (!proof.transfer || proof.transfer.to !== acc.fid) {
              const timestamp = Math.floor(Date.now() / 1000)
              const r = await fetch('https://fnames.farcaster.xyz/transfers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: acc.username, from: 0, to: acc.fid, fid: acc.fid, timestamp, ...(await fnameProof(acc.username, timestamp, custody)) }) })
              if (!r.ok) throw new Error(t("Couldn't claim @{name}: {reason}", { name: acc.username, reason: (await r.json().catch(() => ({}))).code || r.status }))
            }
            await setUserData(USER_DATA.USERNAME, acc.username)
          }
          setAt(3)
          await finish(acc)
          return
        } catch (e: any) {
          if (stop.signal.aborted) return
          // an FID registered on Optimism after the fork never reaches Hypersnap: register this custody natively instead
          if (/unknown fid/i.test(e.message) && account!.fid && !isNative(account!.fid)) {
            setAccount({ ...account!, fid: undefined, signer: undefined, pub: undefined })
            continue
          }
          if (account!.wallet) {
            // no automatic retries: each would ask the wallet again
            setErr(e.message)
            await new Promise<void>((r) => (retry.current = r))
            setErr('')
            continue
          }
          // a registration's errors show right away; early setup attempts fail until the node has indexed the new FID
          if (!account!.fid || i > 6) setErr(e.message)
          await sleep(5000)
        }
      }
    })()
    return () => stop.abort()
  }, [begun])

  return (
    <div class="join">
      <h1>{t('Setting up your account')}</h1>
      {!begun && (
        <section class="card">
          <h2>{t('Save your recovery phrase')}</h2>
          <p class="muted">{t('These words are your account. Quilcast keeps them in this browser only, so write them down somewhere safe.')}</p>
          <code class="phrase">{a.phrase}</code>
          <label class="check"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.currentTarget.checked)} /> {t('I saved my recovery phrase')}</label>
          <button class="btn wide" disabled={!saved} onClick={() => setBegun(true)}>{t('Continue')}</button>
        </section>
      )}
      {begun && (
        <section class="card">
          <Steps steps={SETUP()} at={at} />
          <p class="muted">
            {a.wallet ? t('Your wallet will ask for three signatures: one registers the account and two add the signing key.') + ' ' : ''}
            {t('This usually takes under a minute. You can keep this tab open or come back later, and Quilcast will pick up where it left off.')}
          </p>
        </section>
      )}
      {err && <p class="warn">{t(err)}</p>}
      {err && a.wallet && <button class="btn wide" onClick={() => retry.current?.()}>{t('Try again')}</button>}
      {!begun && (
        <button class="link-btn danger" onClick={() => (!quit ? setQuit(Date.now()) : Date.now() - quit > 1000 && setAccount(null))}>
          {quit ? t('Delete this recovery phrase? Only if you sent nothing to it') : t('Start over')}
        </button>
      )}
      {begun && a.wallet && !account!.fid && <button class="link-btn" onClick={() => setAccount(null)}>{t('Start over')}</button>}
    </div>
  )
}
