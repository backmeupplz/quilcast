// Remind me: a notification brings the cast back after as long as the person picks. It's the standard mini app
// notification flow, cast-action sized: the token comes from the host (context.client.notificationDetails when they're
// already on, or addMiniApp, which asks), this page hands it to our server with the cast and the time
// (server/remind.mjs), and the server POSTs the notification to the token's URL when it's due. Tapping the
// notification opens this page again with ?reminder=1, which offers the cast.
import { start, status } from '/cast.js'
import { addCastAction, addMiniApp, capabilities, close, viewCast } from '/miniapp.js'

const $ = (s) => document.querySelector(s)
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`
// 90 minutes reads as such, not as 1.5 hours
const human = (min) => (min % 10080 === 0 ? plural(min / 10080, 'week') : min % 1440 === 0 ? plural(min / 1440, 'day') : min % 60 === 0 ? plural(min / 60, 'hour') : plural(min, 'minute'))

const { cast, framed, ctx } = await start()
const hash = cast && '0x' + String(cast.hash).replace(/^0x/, '')
let notify = ctx?.client?.notificationDetails

if (!cast) status('Open this from a cast’s ⋯ menu in Quilcast.', true)
else if (new URLSearchParams(location.search).has('reminder') || ctx?.location?.type === 'notification') {
  status('Here’s the cast you asked to be reminded about.')
  $('#view').hidden = !framed
} else if (!framed) status('Open this from a cast’s ⋯ menu in Quilcast to set a reminder.', true)
else {
  $('#pick').hidden = false
  // a host with one-click cast actions can put a duration in the ⋯ menu itself (server/remind.mjs oneClickReminder)
  if ((await capabilities()).includes?.('actions.addCastAction')) $('#menu').hidden = false
}

/** Notification details, asking to turn them on (addMiniApp) when they aren't yet; null when they stay off. */
async function notifications() {
  if (!notify) {
    const r = await addMiniApp()
    notify = r?.result?.notificationDetails || r?.notificationDetails
  }
  return notify || null
}

const ENTRIES = {
  '1d': { name: 'Remind me in 1 day', url: `${location.origin}/api/action?in=1d` },
  '1w': { name: 'Remind me in 1 week', url: `${location.origin}/api/action?in=1w` },
  ask: { name: 'Remind me in…', url: `${location.origin}/api/action`, placeholder: '3 days, 2 hours, 1 week' },
}
async function addToMenu(k) {
  status('')
  // a one-click reminder needs a token to come back with, so notifications go on first
  if (!(await notifications())) return status('Reminders come as notifications, so Remind me needs them on.', true)
  const r = await addCastAction(ENTRIES[k])
  if (r?.added) status(`Added. “${ENTRIES[k].name}” is in the ⋯ menu under every cast.`)
  else if (r?.reason === 'limit') status('The ⋯ menu already has all the Remind me entries it can take.', true)
  else if (r?.reason !== 'rejected_by_user') status('That couldn’t be added here.', true)
}
for (const b of document.querySelectorAll('[data-add]')) b.onclick = () => addToMenu(b.dataset.add)

async function remind(min) {
  if (!(Number.isInteger(min) && min >= 1 && min <= 525600)) return status('Enter a whole number, from a minute to a year.', true)
  const buttons = document.querySelectorAll('#pick button')
  for (const b of buttons) b.disabled = true
  status('')
  try {
    // adds Remind me to the person's apps with notifications on; the result has the token when they're on
    if (!(await notifications())) return status('Reminders come as notifications, so Remind me needs them on. Tap a time to try again.', true)
    const at = Date.now() + min * 60e3
    const r = await fetch('/api/remind', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: notify.token, url: notify.url, hash, fid: cast.author.fid, author: cast.author.username, text: cast.text, at }),
    })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(j.error === 'bad time' ? 'Pick a time from a minute to a year away.' : r.status === 429 || r.status === 503 ? 'Too many reminders right now. Try again in a few minutes.' : 'The reminder wasn’t saved. Try again.')
    $('#pick').hidden = true
    const when = new Date(at).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    status(`Done. I’ll remind you in ${human(min)}, on ${when}.`)
    $('#done').hidden = false
  } catch (e) {
    status(e.message || 'The reminder wasn’t saved. Try again.', true)
  } finally {
    for (const b of buttons) b.disabled = false
  }
}

for (const b of document.querySelectorAll('[data-min]')) b.onclick = () => remind(Number(b.dataset.min))
$('#other').onsubmit = (e) => (e.preventDefault(), remind(Number($('#count').value) * Number($('#unit').value)))
$('#view').onclick = () => viewCast(hash).catch((e) => status(e.message, true))
$('#done').onclick = close
