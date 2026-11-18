// What every Quilcast cast action starts with: the cast it was opened on. The share extension spec puts castHash,
// castFid and viewerFid in the query (there even before the SDK answers, and on a plain web visit); in a mini app
// host, context.location is { type: 'cast_share', cast } with the text and author too.
import { detect, ready } from './miniapp.js'

const NODE = 'https://haatz.quilibrium.com'
const $ = (s) => document.querySelector(s)

export async function start() {
  const q = new URLSearchParams(location.search)
  const hash = q.get('castHash')?.match(/^(?:0x)?([0-9a-f]{40})$/i)?.[1]?.toLowerCase()
  const fid = Number(q.get('castFid')) || 0
  const ctx = await detect()
  ready()
  let cast = ctx?.location?.type === 'cast_share' ? ctx.location.cast : null
  // opened from a link outside a mini app host: the node has the rest
  if (!cast && hash) cast = await fetch(`${NODE}/v2/farcaster/cast?type=hash&identifier=0x${hash}`).then((r) => r.json()).then((j) => j.cast && { hash: j.cast.hash, text: j.cast.text, author: { fid: j.cast.author.fid, username: j.cast.author.username, pfpUrl: j.cast.author.pfp_url } }, () => null)
  if (!cast && hash && fid) cast = { hash: '0x' + hash, text: '', author: { fid } }
  if (cast) show(cast)
  return { cast, viewer: ctx?.user?.fid || Number(q.get('viewerFid')) || 0, framed: !!ctx }
}

function show(c) {
  const box = $('#cast')
  if (!box) return
  const img = box.querySelector('img'), who = box.querySelector('b'), text = box.querySelector('p')
  if (c.author.pfpUrl && /^https:\/\//.test(c.author.pfpUrl)) img.src = c.author.pfpUrl
  else img.hidden = true
  who.textContent = c.author.username ? `@${c.author.username}` : `fid ${c.author.fid}`
  text.textContent = c.text || ''
  box.hidden = false
}

export function status(text, err = false) {
  $('#status').textContent = text
  $('#status').className = err ? 'err' : ''
}
