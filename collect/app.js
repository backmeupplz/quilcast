// Collect = QuilcastCollect.collect(castHash) on Base: the cast's 1/1, free but for gas. /c/<hash> (or ?cast=<hash>)
// picks the cast; once someone has it, the page shows who (their Farcaster profile when the node knows their address),
// and its owner can share it: the link's picture is the NFT with their name (server/index.mjs collectPage).
const CONTRACT = '0x5961d6a95f140b40cb993190e9dc5076f0830d3e'
const BASE = 8453
const RPC = 'https://mainnet.base.org'
const SITE = 'https://quilcast.com'
const NODE = 'https://haatz.quilibrium.com'
const APP = 'https://collect.quilcast.com/'
const SEL = { collect: '0x306cfaf1', ownerOf: '0x6352211e', totalSupply: '0x18160ddd' }

const $ = (s) => document.querySelector(s)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const q = new URLSearchParams(location.search)
// /c/<hash>; ?cast= is how Quilcast first opened it, ?castHash= a cast shared to the app from a Farcaster client
const hash = (location.pathname.match(/^\/c\/(?:0x)?([0-9a-f]{40})$/i)?.[1] || (q.get('cast') || q.get('castHash'))?.replace(/^0x/i, ''))?.toLowerCase()
let mini = null
let meta = null
let owner = null

async function rpc(method, params) {
  const r = await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()
  if (r.error) throw Object.assign(new Error(r.error.message), { revert: r.error.code === 3 || /revert/i.test(r.error.message) })
  return r.result
}
const call = (data) => rpc('eth_call', [{ to: CONTRACT, data }, 'latest'])
/** The cast's owner, or null while nobody has collected it. */
const ownerOf = () => call(SEL.ownerOf + hash.padStart(64, '0')).then((r) => '0x' + r.slice(-40), (e) => (e.revert ? null : Promise.reject(e)))

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
  $('#lead').textContent = 'This cast has been collected. Each cast can be collected only once.'
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
      await p.request({ method: 'eth_sendTransaction', params: [{ from: a, to: CONTRACT, data: SEL.collect + hash.padEnd(64, '0') }] })
      status('Collecting…')
      // poll the contract rather than the receipt, so smart wallets (whose "hash" may be a bundle id) work too
      for (let i = 0; !(owner = await ownerOf()); i++) {
        if (i > 60) throw new Error('This is taking long. Check your wallet, then reload this page.')
        await sleep(2000)
      }
    }
    const mine = owner.toLowerCase() === a.toLowerCase()
    status(mine ? 'You collected this cast. It is in your wallet.' : 'Someone collected this cast just before you.', !mine)
    $('#share').hidden = !mine
    await showOwner(owner)
  } catch (e) {
    status(e.code === 4001 || /reject|denied|cancel/i.test(e.message) ? 'Cancelled.' : e.message, true)
  } finally {
    btn.disabled = false
  }
}

function share() {
  const who = meta?.attributes?.find((x) => x.trait_type === 'Author')?.value
  const text = `I collected ${who ? `this cast by ${who}` : 'this cast'} on Quilcast Collect`
  // one embed: the cast's page here, which shows the NFT and opens this app on it. The owner in the link makes it a
  // new address for clients that cached the page's card from before it was collected (the server ignores it).
  const embeds = [`${APP}c/${hash}${owner ? `?by=${owner.slice(2, 10).toLowerCase()}` : ''}`]
  if (mini) return mini.composeCast({ text, embeds })
  const q = new URLSearchParams({ text })
  embeds.forEach((e) => q.append('embeds[]', e))
  window.open(`https://farcaster.xyz/~/compose?${q}`, '_blank', 'noopener')
}

/** The wallet this page already has, without asking for one. */
const connected = () => (mini ? mini.provider : window.ethereum)?.request({ method: 'eth_accounts' }).then((a) => a?.[0]?.toLowerCase(), () => undefined)

async function showCast() {
  $('#cast').hidden = false
  const id = BigInt('0x' + hash).toString()
  $('#art').src = `${SITE}/nft/0x${hash}.png`
  $('#cast-link').href = `${SITE}/c/${hash}`
  $('#opensea').href = `https://opensea.io/item/base/${CONTRACT}/${id}`
  $('#contract').href = `https://basescan.org/token/${CONTRACT}?a=${id}`
  meta = await fetch(`${SITE}/nft/0x${hash}`).then((r) => (r.ok ? r.json() : null)).catch(() => null)
  if (!meta) return status("This cast couldn't be found.", true)
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
  $('#contract2').href = `https://basescan.org/token/${CONTRACT}`
  const n = Number(BigInt(await call(SEL.totalSupply)))
  $('#count').textContent = `${n.toLocaleString('en-US')} ${n === 1 ? 'cast' : 'casts'} collected so far`
}

/** A pasted link (Farcaster, Quilcast or a bare hash) → the cast's own page; the server finds its full hash. */
async function find(e) {
  e.preventDefault()
  const out = $('#find-status')
  $('#find-go').disabled = true
  out.className = ''
  out.textContent = 'Looking for the cast…'
  try {
    const r = await fetch(`/api/cast?url=${encodeURIComponent($('#link').value)}`)
    const j = await r.json().catch(() => ({}))
    if (!j.hash) throw new Error(r.status === 429 ? 'Too many lookups. Try again in a minute.' : "That link isn't a cast we can find.")
    location.assign(`/c/${j.hash}`)
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
/^[0-9a-f]{40}$/.test(hash || '') ? showCast() : showHome().catch(() => {})
