// Collect = QuilcastCollect.collect(castHash) on Base, the cast's 1/1, or QuilcastCards.collect(fid), a profile's
// trading card: free but for gas. /c/<hash> (or ?cast=<hash>) picks a cast, /p/<fid> (or ?fid=) a profile; once
// someone has it, the page shows who (their Farcaster profile when the node knows their address), and its owner can
// share it: the link's picture is the NFT with their name (server/index.mjs collectPage).
const CONTRACT = '0x5961d6a95f140b40cb993190e9dc5076f0830d3e'
const CARDS = '0x6acfccd110900d86b2aead4b7c4c9e1673669f13'
const BASE = 8453
const RPC = 'https://mainnet.base.org'
const SITE = 'https://quilcast.com'
const NODE = 'https://haatz.quilibrium.com'
const APP = 'https://collect.quilcast.com/'
const SEL = { ownerOf: '0x6352211e', totalSupply: '0x18160ddd' }

const $ = (s) => document.querySelector(s)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const q = new URLSearchParams(location.search)
// /c/<hash>; ?cast= is how Quilcast first opened it, ?castHash= a cast shared to the app from a Farcaster client
const hash = (location.pathname.match(/^\/c\/(?:0x)?([0-9a-f]{40})$/i)?.[1] || (q.get('cast') || q.get('castHash'))?.replace(/^0x/i, ''))?.toLowerCase()
const fid = Number(location.pathname.match(/^\/p\/(\d{1,10})$/)?.[1] || q.get('fid')?.match(/^\d{1,10}$/)?.[0]) || 0
/** What this page collects: the cast or the profile's card, its contract, token id (hex) and words. */
const it = fid
  ? { to: CARDS, id: fid.toString(16), token: String(fid), mint: '0xce3f865f' + fid.toString(16).padStart(64, '0'), meta: `${SITE}/nft/card/${fid}`, art: `${SITE}/nft/card/${fid}.png`, path: `p/${fid}`, view: `${SITE}/u/${fid}`, noun: 'card', viewText: 'View the profile' }
  : /^[0-9a-f]{40}$/.test(hash || '')
    ? { to: CONTRACT, id: hash, token: BigInt('0x' + hash).toString(), mint: '0x306cfaf1' + hash.padEnd(64, '0'), meta: `${SITE}/nft/0x${hash}`, art: `${SITE}/nft/0x${hash}.png`, path: `c/${hash}`, view: `${SITE}/c/${hash}`, noun: 'cast', viewText: 'View the cast' }
    : null
let mini = null
let meta = null
let owner = null

async function rpc(method, params) {
  const r = await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()
  if (r.error) throw Object.assign(new Error(r.error.message), { revert: r.error.code === 3 || /revert/i.test(r.error.message) })
  return r.result
}
const call = (data, to = it?.to || CONTRACT) => rpc('eth_call', [{ to, data }, 'latest'])
/** Its owner, or null while nobody has collected it. */
const ownerOf = () => call(SEL.ownerOf + it.id.padStart(64, '0')).then((r) => '0x' + r.slice(-40), (e) => (e.revert ? null : Promise.reject(e)))

function status(text, err = false) {
  $('#status').textContent = text
  $('#status').className = err ? 'err' : ''
}
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`

async function showOwner(a) {
  owner = a
  $('#collect').hidden = true
  $('#owner').hidden = false
  $('#owner-name').textContent = short(a)
  $('#owner-name').href = `https://basescan.org/address/${a}`
  $('#owner-pfp').hidden = true
  $('#title').textContent = 'Collected'
  $('#lead').textContent = `This ${it.noun} has been collected. Each ${it.noun} can be collected only once.`
  const u = await fetch(`${NODE}/v2/farcaster/user/bulk-by-address?addresses=${a}`).then((r) => r.json()).then((j) => (j.users || j[a])?.[0]).catch(() => null)
  if (!u?.username) return
  $('#owner-name').textContent = `${u.display_name || u.username} (@${u.username})`
  $('#owner-name').href = `${SITE}/u/${encodeURIComponent(u.username)}`
  if (u.pfp_url) Object.assign($('#owner-pfp'), { src: u.pfp_url, hidden: false })
}

async function wallet() {
  const p = mini ? mini.provider : window.ethereum
  if (!p) throw new Error('No wallet here. Open this page in Quilcast, Farcaster or a wallet app.')
  const [a] = await p.request({ method: 'eth_requestAccounts' })
  if (Number(await p.request({ method: 'eth_chainId' })) !== BASE)
    await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x' + BASE.toString(16) }] })
  return { p, a }
}

async function collect() {
  const btn = $('#collect')
  btn.disabled = true
  try {
    status('Connecting your wallet…')
    const { p, a } = await wallet()
    let owner = await ownerOf()
    if (!owner) {
      status('Confirm the free mint in your wallet…')
      await p.request({ method: 'eth_sendTransaction', params: [{ from: a, to: it.to, data: it.mint }] })
      status('Collecting…')
      // poll the contract rather than the receipt, so smart wallets (whose "hash" may be a bundle id) work too
      for (let i = 0; !(owner = await ownerOf()); i++) {
        if (i > 60) throw new Error('This is taking long. Check your wallet, then reload this page.')
        await sleep(2000)
      }
    }
    const mine = owner.toLowerCase() === a.toLowerCase()
    status(mine ? `You collected this ${it.noun}. It is in your wallet.` : `Someone collected this ${it.noun} just before you.`, !mine)
    $('#share').hidden = !mine
    await showOwner(owner)
    // a card is kept as the profile was when it was collected: show that one
    if (mine && fid) $('#art').src = `${it.art}?v=${owner.slice(2, 10).toLowerCase()}`
  } catch (e) {
    status(e.code === 4001 || /reject|denied|cancel/i.test(e.message) ? 'Cancelled.' : e.message, true)
  } finally {
    btn.disabled = false
  }
}

function share() {
  const who = meta?.attributes?.find((x) => x.trait_type === (fid ? 'Profile' : 'Author'))?.value
  const text = fid
    ? `I collected ${who ? `${who}'s` : 'this'} card on Quilcast Collect`
    : `I collected ${who ? `this cast by ${who}` : 'this cast'} on Quilcast Collect`
  // one embed: its page here, which shows the NFT and opens this app on it. The owner in the link makes it a new
  // address for clients that cached the page's card from before it was collected (the server ignores it).
  const embeds = [`${APP}${it.path}${owner ? `?by=${owner.slice(2, 10).toLowerCase()}` : ''}`]
  if (mini) return mini.composeCast({ text, embeds })
  const q = new URLSearchParams({ text })
  embeds.forEach((e) => q.append('embeds[]', e))
  window.open(`https://farcaster.xyz/~/compose?${q}`, '_blank', 'noopener')
}

/** The wallet this page already has, without asking for one. */
const connected = () => (mini ? mini.provider : window.ethereum)?.request({ method: 'eth_accounts' }).then((a) => a?.[0]?.toLowerCase(), () => undefined)

async function showItem() {
  $('#cast').hidden = false
  $('#art').src = it.art
  $('#title').textContent = `Collect this ${it.noun}`
  $('#lead').textContent = fid
    ? "The first person to collect a profile's card owns it as a 1/1 NFT on Base, showing the profile as it is that day. Collecting is free; you only pay a fraction of a cent in gas."
    : 'The first person to collect a cast owns it as a 1/1 NFT on Base. Collecting is free; you only pay a fraction of a cent in gas.'
  $('#cast-link').href = it.view
  $('#cast-link').textContent = it.viewText
  $('#opensea').href = `https://opensea.io/item/base/${it.to}/${it.token}`
  $('#contract').href = `https://basescan.org/token/${it.to}?a=${it.token}`
  meta = await fetch(it.meta).then((r) => (r.ok ? r.json() : null)).catch(() => null)
  if (!meta) return status(`This ${fid ? 'profile' : 'cast'} couldn't be found.`, true)
  $('#art').alt = meta.name
  const owner = await ownerOf().catch(() => undefined)
  if (owner === undefined) return status("Base didn't answer. Try again in a moment.", true)
  if (!owner) return void ($('#collect').hidden = false)
  showOwner(owner)
  // its owner, back on the page, can share it again
  if ((await connected()) === owner.toLowerCase()) $('#share').hidden = false
}

async function showHome() {
  $('#home').hidden = false
  $('#collection').href = `https://opensea.io/assets/base/${CONTRACT}`
  $('#cards').href = `https://opensea.io/assets/base/${CARDS}`
  const [casts, cards] = await Promise.all([CONTRACT, CARDS].map((to) => call(SEL.totalSupply, to).then((r) => Number(BigInt(r)), () => 0)))
  $('#count').textContent = `${casts.toLocaleString('en-US')} ${casts === 1 ? 'cast' : 'casts'} and ${cards.toLocaleString('en-US')} ${cards === 1 ? 'card' : 'cards'} collected so far`
}

/** A pasted link (a cast or profile on Farcaster or Quilcast, a bare hash, @name) → its own page; the server finds it. */
async function find(e) {
  e.preventDefault()
  const out = $('#find-status')
  $('#find-go').disabled = true
  out.className = ''
  out.textContent = 'Looking…'
  try {
    const r = await fetch(`/api/find?url=${encodeURIComponent($('#link').value)}`)
    const j = await r.json().catch(() => ({}))
    if (!j.hash && !j.fid) throw new Error(r.status === 429 ? 'Too many lookups. Try again in a minute.' : "That isn't a cast or profile we can find.")
    location.assign(j.hash ? `/c/${j.hash}` : `/p/${j.fid}`)
  } catch (err) {
    out.textContent = err.message
    out.className = 'err'
    $('#find-go').disabled = false
  }
}

$('#collect').onclick = collect
$('#share').onclick = share
$('#find').onsubmit = find
// inside a Farcaster client (or Quilcast): talk to the host, so the wallet and casting go through it
if (window.ReactNativeWebView || window !== window.parent) {
  const m = await import('./miniapp.js')
  if (await m.detect()) {
    mini = m
    m.ready()
  }
}
it ? showItem() : showHome().catch(() => {})
