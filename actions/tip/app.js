// Tip: USDC on Base to the cast's author, through the host's sendToken (Quilcast asks the person to confirm, then
// their wallet does). The host finds the author's verified address from recipientFid.
import { start, status } from '/cast.js'
import { composeCast, sendToken } from '/miniapp.js'

const USDC = 'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const $ = (s) => document.querySelector(s)

const { cast, viewer, framed } = await start()
const who = cast && (cast.author.username ? `@${cast.author.username}` : `fid ${cast.author.fid}`)
if (!cast) status('Open this from a cast’s ⋯ menu in Quilcast.', true)
else if (!framed) status('Open this from a cast’s ⋯ menu in Quilcast to send a tip.', true)
else if (viewer && viewer === cast.author.fid) status('That’s your own cast.', true)
else {
  $('#who').textContent = who
  $('#tip').hidden = false
}

async function tip(usd) {
  if (!(usd > 0 && usd <= 10000)) return status('Enter an amount in dollars.', true)
  for (const b of document.querySelectorAll('button')) b.disabled = true
  status('')
  try {
    const r = await sendToken({ token: USDC, amount: String(Math.round(usd * 1e6)), recipientFid: cast.author.fid })
    if (r?.success) {
      status(`Sent ${who} $${usd}. Thank you!`)
      $('#note').hidden = false
    } else if (r?.reason !== 'rejected_by_user') status(r?.error?.message || 'The tip didn’t go through.', true)
  } catch (e) {
    status(e.message || 'The tip didn’t go through.', true)
  }
  for (const b of document.querySelectorAll('button')) b.disabled = false
}

for (const b of document.querySelectorAll('[data-usd]')) b.onclick = () => tip(Number(b.dataset.usd))
$('#other').onsubmit = (e) => (e.preventDefault(), tip(Number($('#amount').value)))
$('#note').onclick = () => composeCast({ text: 'Tipped you 💸', parent: { type: 'cast', hash: cast.hash } })
