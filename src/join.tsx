import { generateMnemonic, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { useEffect, useRef, useState } from 'preact/hooks'
import { account, accounts, get, getUser, go, idOf, setAccount, settings, USER_DATA, type Account } from './api.ts'
import { balance, fidOf, register, registerPrice } from './eth.ts'
import { address, custodyKey, fnameProof } from './fc.ts'
import { t } from './i18n.ts'
import { custodyOf, ensureSigner, setUserData } from './write.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const eth = (wei: bigint) => (Number(wei) / 1e18).toFixed(6).replace(/\.?0+$/, '')
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,15}$/

// likes and recasts load in the background once the account is set; the feed doesn't wait for them
const finish = async (a: Account) => {
  const u = await getUser(a.fid!).catch(() => null)
  // the account as ensureSigner saved it, with its new key
  const saved = accounts.find((x) => idOf(x) === idOf(a)) || a
  setAccount({ ...saved, username: a.username || u?.username, done: true })
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
        <span>{t('Pick a username and register it on Optimism for about twenty cents of ETH.')}</span>
      </button>
      <button class="choice" onClick={() => go('/join/signin')}>
        <b>{t('I already have an account')}</b>
        <span>{t('Sign in with the recovery phrase from Warpcast, Quorum or any other Farcaster app.')}</span>
      </button>
      <button class="choice" onClick={() => go('/join/wallet')}>
        <b>{t('Use a wallet')}</b>
        <span>{t('Connect MetaMask, Rabby or another wallet that owns a Farcaster account, or create one paid from it. The wallet keeps its keys and you approve each signature.')}</span>
      </button>
    </div>
  )
}

function Create({ wallet }: { wallet?: string }) {
  const [name, setName] = useState('')
  const [display, setDisplay] = useState('')
  const [state, setState] = useState<'' | 'checking' | 'free' | 'taken' | 'bad'>('')
  useEffect(() => {
    if (!name) return setState('')
    if (!NAME_RE.test(name)) return setState('bad')
    setState('checking')
    const t = setTimeout(() => fetch(`https://fnames.farcaster.xyz/transfers/current?name=${name}`).then((r) => setState(r.status === 404 ? 'free' : 'taken'), () => setState('')), 350)
    return () => clearTimeout(t)
  }, [name])
  const go = async () => {
    const phrase = wallet ? '' : generateMnemonic(wordlist)
    // a phrase account is known by its custody address, never by the phrase
    setAccount({ phrase, wallet, custody: phrase ? address(await custodyKey(phrase)) : undefined, username: name, display: display.trim() || name })
  }
  return (
    <div class="join">
      <h1>{t('Pick your name')}</h1>
      {wallet && <p class="lede">{t('No Farcaster account belongs to {address} yet. Pick a name and the wallet pays the registration on Optimism.', { address: short(wallet) })}</p>}
      <label>{t('Username')}
        <div class="prefix"><span>@</span><input value={name} onInput={(e) => setName(e.currentTarget.value.toLowerCase().trim())} placeholder={t('yourname')} maxLength={16} autoFocus autocapitalize="none" spellcheck={false} /></div>
        <small class={state === 'free' ? 'ok' : state === 'taken' || state === 'bad' ? 'warn' : ''}>
          {{ '': t('Lowercase letters, numbers and dashes, up to 16 characters.'), checking: t('Checking…'), free: t('@{name} is available.', { name }), taken: t('@{name} is already taken.', { name }), bad: t('Use lowercase letters, numbers and dashes, starting with a letter or number.') }[state]}
        </small>
      </label>
      <label>{t('Display name')}<input value={display} onInput={(e) => setDisplay(e.currentTarget.value)} placeholder={t('Your Name')} maxLength={32} /></label>
      <button class="btn wide" disabled={state !== 'free'} onClick={go}>{t('Continue')}</button>
    </div>
  )
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

/** The FID whose custody address this is: Hypersnap first (fast), Optimism when the node doesn't know it.
 *  A wrong FID can't sign in anyway: the network only takes a key signed by that FID's custody address. */
async function fidFor(addr: string) {
  const u = (await get('/v2/farcaster/user/custody-address', { custody_address: addr }).catch(() => null))?.user
  return typeof u?.fid === 'number' && u.fid > 0 && String(u.custody_address).toLowerCase() === addr.toLowerCase() ? u.fid : fidOf(settings.rpc, addr)
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
  // a wallet without a Farcaster account can register one
  if (none) return <Create wallet={none} />
  const connect = f.run(async (step) => {
    step(0)
    const addr = await (await import('./wallet.ts')).connect()
    step(1)
    const fid = await fidFor(addr)
    fid ? await enter({ phrase: '', wallet: addr, fid, done: true }, step) : setNone(addr)
  })
  return (
    <div class="join">
      <h1>{t('Use a wallet')}</h1>
      <p class="lede">{t('Connect the wallet that owns your Farcaster account. Quilcast never sees its keys: the wallet approves a signing key for this browser, and after that it asks only when something needs the account itself, like claiming a username or signing in to a mini app.')}</p>
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

// Funding, registration and first-time setup. Every step is re-derived from the
// chain and the node, so a reload resumes wherever it stopped.
function Setup() {
  const a = account!
  const [addr, setAddr] = useState('')
  const [need, setNeed] = useState<bigint | null>(null)
  const [bal, setBal] = useState<bigint | null>(null)
  const [step, setStep] = useState(a.fid ? 'setup' : 'fund')
  const [err, setErr] = useState('')
  const [saved, setSaved] = useState(false)
  const [quit, setQuit] = useState(0)
  const [price, setPrice] = useState(0n)
  const [paying, setPaying] = useState(false)
  const retry = useRef<() => void>(undefined)

  useEffect(() => {
    let live = true
    let sent = false
    ;(async () => {
      const key = a.wallet ? undefined : await custodyKey(a.phrase)
      const custody = await custodyOf(a)
      const addr = custody.address
      setAddr(addr)
      while (live && !account!.fid) {
        try {
          const fid = await fidOf(settings.rpc, addr)
          if (fid) {
            setAccount({ ...account!, fid })
            break
          }
          const [p, b] = await Promise.all([registerPrice(settings.rpc), balance(settings.rpc, addr)])
          // ~0.0001 ETH today; anything far above that means a wrong or hostile RPC
          if (p <= 0n || p > 10n ** 16n) throw new Error('The registration price from the Optimism RPC looks wrong. Check the RPC in settings.')
          const want = (p * 102n) / 100n
          setPrice(want)
          setNeed(want + 10n ** 13n)
          setBal(b)
          // a phrase account pays as soon as the funds arrive; a wallet pays when its owner presses Register
          if (key && b >= want + 10n ** 13n && !sent) {
            setStep('register')
            await register(settings.rpc, key, want)
            sent = true
          }
        } catch (e: any) {
          setErr(e.message)
        }
        await sleep(4000)
      }
      if (!live) return
      setStep('setup')
      setErr('')
      // the node needs to see the on-chain registration before it accepts a signer
      for (let i = 0; live; i++) {
        try {
          const acc = account!
          // a wallet asks its owner for each signature, so ask only once the node knows the new FID
          if (acc.wallet)
            while (live && !(await getUser(acc.fid!).then((u) => String(u.custody_address).toLowerCase() === acc.wallet, () => false))) await sleep(3000)
          if (!acc.signer) await ensureSigner(acc)
          if (acc.username && !(await getUser(acc.fid!).then((u) => u.username === acc.username, () => false))) {
            const proof = await fetch(`https://fnames.farcaster.xyz/transfers/current?name=${acc.username}`).then((r) => r.json())
            if (!proof.transfer || proof.transfer.to !== acc.fid) {
              const timestamp = Math.floor(Date.now() / 1000)
              const r = await fetch('https://fnames.farcaster.xyz/transfers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: acc.username, from: 0, to: acc.fid, fid: acc.fid, timestamp, ...(await fnameProof(acc.username, timestamp, custody)) }) })
              if (!r.ok) throw new Error(t("Couldn't claim @{name}: {reason}", { name: acc.username, reason: (await r.json().catch(() => ({}))).code || r.status }))
            }
            await setUserData(USER_DATA.USERNAME, acc.username)
            if (acc.display) await setUserData(USER_DATA.DISPLAY, acc.display)
          }
          await finish(acc)
          return
        } catch (e: any) {
          if (account!.wallet) {
            // no automatic retries: each would ask the wallet again
            setErr(e.message)
            await new Promise<void>((r) => (retry.current = r))
            setErr('')
            continue
          }
          // early attempts fail until the node indexes the new fid and fname, so stay quiet for a bit
          if (i > 6) setErr(e.message)
          await sleep(5000)
        }
      }
    })()
    return () => void (live = false)
  }, [])

  const copy = (s: string) => navigator.clipboard.writeText(s)
  const pay = async () => {
    setErr('')
    setPaying(true)
    try {
      await (await import('./wallet.ts')).register(addr, price)
      setStep('register')
    } catch (e: any) {
      setErr(e.message)
    }
    setPaying(false)
  }
  return (
    <div class="join">
      <h1>{step !== 'fund' ? t('Setting up your account') : a.wallet ? t('Register @{name}', { name: a.username! }) : t('Fund @{name}', { name: a.username! })}</h1>
      {step === 'fund' && a.wallet && (
        <section class="card">
          <p class="muted">{t('Registering a Farcaster ID costs a small fee on Optimism, which includes a year of storage. Your wallet {address} pays it, and then signs a key for this browser and your username.', { address: short(a.wallet) })}</p>
          <div class="kv"><span>{t('Fee')}</span><b>{need === null ? '…' : `${eth(price)} ETH`}</b></div>
          <div class="kv"><span>{t('Network')}</span><b>Optimism (OP Mainnet)</b></div>
          {bal !== null && need !== null && bal < need && <p class="warn">{t('The wallet has {balance} ETH on Optimism. It needs about {need} ETH including gas.', { balance: eth(bal), need: eth(need) })}</p>}
          <button class="btn wide" disabled={need === null || paying} onClick={pay}>{paying ? t('Confirm in your wallet…') : t('Register')}</button>
        </section>
      )}
      {step === 'fund' && !a.wallet && (
        <>
          <section class="card">
            <h2>{t('1. Save your recovery phrase')}</h2>
            <p class="muted">{t('These words are your account. Quilcast keeps them in this browser only, so write them down somewhere safe. They also work in Quorum and Warpcast.')}</p>
            <code class="phrase">{a.phrase}</code>
            <label class="check"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.currentTarget.checked)} /> {t('I saved my recovery phrase')}</label>
          </section>
          <section class={`card${saved ? '' : ' dim'}`}>
            <h2>{t('2. Send ETH on Optimism')}</h2>
            <p class="muted">{t('Registering a Farcaster ID costs a small fee paid on the Optimism network, which includes a year of storage. Send at least the amount below to your new address from any wallet or exchange that supports Optimism.')}</p>
            {saved && (
              <>
                <div class="kv"><span>{t('Amount')}</span><b>{need === null ? '…' : `${eth(need)} ETH`}</b>{need !== null && <button class="link-btn" onClick={() => copy(eth(need))}>{t('Copy')}</button>}</div>
                <div class="kv"><span>{t('Address')}</span><code>{addr || '…'}</code>{addr && <button class="link-btn" onClick={() => copy(addr)}>{t('Copy')}</button>}</div>
                <div class="kv"><span>{t('Network')}</span><b>Optimism (OP Mainnet)</b></div>
                {need !== null && addr && <a class="btn ghost wide" href={`ethereum:${addr}@10?value=${need}`}>{t('Open in a wallet app')}</a>}
                <p class="waiting"><span class="pulse" /> {bal === null ? t('Checking balance…') : t('Balance {balance} ETH. Waiting for funds…', { balance: eth(bal) })}</p>
              </>
            )}
          </section>
        </>
      )}
      {step !== 'fund' && (
        <section class="card">
          <ol class="steps">
            <li class={step === 'register' ? 'now' : 'done'}>{t('Registering your Farcaster ID on Optimism')}</li>
            <li class={step === 'setup' ? 'now' : ''}>{t('Adding a signing key for this browser and claiming @{name}', { name: a.username! })}</li>
          </ol>
          <p class="muted">
            {a.wallet ? t('Your wallet will ask for three signatures: two add the signing key and one claims the username.') + ' ' : ''}
            {t('This usually takes under a minute. You can keep this tab open or come back later, and Quilcast will pick up where it left off.')}
          </p>
        </section>
      )}
      {err && <p class="warn">{t(err)}</p>}
      {err && a.wallet && step === 'setup' && <button class="btn wide" onClick={() => retry.current?.()}>{t('Try again')}</button>}
      {step === 'fund' && a.wallet && <button class="link-btn" onClick={() => setAccount(null)}>{t('Start over')}</button>}
      {step === 'fund' && !a.wallet && bal === 0n && (
        <button class="link-btn danger" onClick={() => (!quit ? setQuit(Date.now()) : Date.now() - quit > 1000 && setAccount(null))}>
          {quit ? t('Delete this recovery phrase? Only if you sent nothing to it') : t('Start over')}
        </button>
      )}
    </div>
  )
}
