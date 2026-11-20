// Poll: a composer action (quilcast.com/developers/composer-actions). Opened from the composer, it takes the draft's
// text as the question, keeps the poll on our server (server/poll.mjs) and fills the post with the question and the
// poll's link. That link (/p/<id>) is a mini app embed: people sign in with Farcaster to vote, once per FID, and then
// see the results. Opened anywhere else, composeCast opens that client's composer instead.
import { status } from '/cast.js'
import { composeCast, detect, ready, signIn } from '/miniapp.js'

const $ = (s) => document.querySelector(s)
const ctx = await detect()
ready()
const id = location.pathname.match(/^\/p\/([0-9a-f]{12})$/)?.[1]
const draft = ctx?.location?.type === 'composer' ? ctx.location.draft : null

const api = async (path, body) => {
  const r = await fetch(path, body && { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error || 'Something went wrong. Try again.')
  return j
}

// --- making one ---

if (!id) {
  $('#make').hidden = false
  // the box's maxlength doesn't hold what's set here, and the server keeps no more than this; a longer post stays as it
  // is (its text isn't sent back) and the question is written fresh
  if ((draft?.text || '').length <= 320) $('#question').value = draft?.text || ''
  if (!draft) $('#put').textContent = 'Cast this poll'
}
$('#make').onsubmit = async (e) => {
  e.preventDefault()
  // a cast holds 4 embeds, a quote among them, and the post's own come first
  if (draft && (draft.embeds?.length || 0) + (draft.quote ? 1 : 0) >= 4) return status('This post has no room for another link. Take out an attachment first.', true)
  const question = $('#question').value.trim()
  const options = [...document.querySelectorAll('.option')].map((i) => i.value.trim()).filter(Boolean)
  if (!question) return status('Write a question.', true)
  if (options.length < 2) return status('Write at least 2 options.', true)
  $('#put').disabled = true
  status('')
  try {
    const p = await api('/api/poll', { question, options })
    await composeCast(draft?.text?.length > 320 ? { embeds: [p.url] } : { text: question, embeds: [p.url] })
    // Quilcast closes a composer action once it fills the post in; another client's composer has it now
    if (!draft) status('Done. The poll is in your cast.')
  } catch (err) {
    status(err.message, true)
  } finally {
    $('#put').disabled = false
  }
}

// --- voting ---

// per account: one browser can sign in as several
const mineKey = `poll:${id}:${ctx?.user?.fid}`
const remembered = () => {
  try {
    return localStorage.getItem(mineKey)
  } catch {}
}
function results(p, mine) {
  const total = p.votes.reduce((a, b) => a + b, 0)
  const box = $('#results')
  box.replaceChildren(...p.options.map((o, i) => {
    const pct = total ? Math.round((p.votes[i] / total) * 100) : 0
    const row = document.createElement('div')
    row.className = `bar${i === mine ? ' mine' : ''}`
    row.style.setProperty('--pct', `${pct}%`)
    const name = document.createElement('span'), n = document.createElement('b')
    name.textContent = i === mine ? `✓ ${o}` : o
    n.textContent = `${pct}%`
    row.append(name, n)
    return row
  }))
  const sum = document.createElement('p')
  sum.className = 'muted small'
  sum.textContent = total === 1 ? '1 vote' : `${total} votes`
  box.append(sum)
  box.hidden = false
  $('#choices').hidden = true
}

async function cast(p, i, buttons) {
  for (const b of buttons) b.disabled = true
  status('')
  try {
    // the sign-in is the vote: its nonce names this poll and the option (server/poll.mjs vote). Custody only, which is
    // what the server checks.
    const nonce = id + i + crypto.randomUUID().replace(/-/g, '').slice(0, 12)
    const r = await signIn({ nonce, acceptAuthAddress: false }).catch(() => null)
    const s = r?.result || (r?.signature && r)
    // declined, or the wallet failed (some hosts throw for both): the buttons stay for another try
    if (!r || r.error?.type === 'rejected_by_user') return status('Voting takes a sign-in, so each account votes once.', true)
    // a host that can't sign anyone in can't vote here either, so it gets the results
    if (!s) return results(p), status('This app can’t sign you in, so you can’t vote here.', true)
    const v = await api(`/api/poll/${id}/vote`, { message: s.message, signature: s.signature })
    try {
      localStorage.setItem(mineKey, String(v.voted))
    } catch {}
    results(v, v.voted)
    if (v.already) status('You already voted in this poll.')
  } catch (err) {
    status(err.message, true)
  } finally {
    for (const b of buttons) b.disabled = false
  }
}

if (id) {
  try {
    const p = await api(`/api/poll/${id}`)
    $('#poll').hidden = false
    $('#q').textContent = p.question
    const mine = remembered()
    // voting needs a Farcaster app to sign in with; a plain visit sees the results
    if (mine !== undefined && mine !== null) results(p, Number(mine))
    else if (!ctx) results(p), status('Open this poll in a Farcaster app to vote.')
    else {
      const buttons = p.options.map((o, i) => {
        const b = document.createElement('button')
        b.type = 'button'
        b.textContent = o
        b.onclick = () => cast(p, i, buttons)
        return b
      })
      $('#choices').replaceChildren(...buttons)
    }
  } catch (err) {
    status(err.message, true)
  }
}
