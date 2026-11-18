// Spam check: what spam.quilcast.com's model thinks of the cast and of its author. A cast action with nothing to ask
// the user: it reads the cast from the query and shows two numbers.
import { start, status } from '/cast.js'

const API = 'https://spam.quilcast.com'
const $ = (s) => document.querySelector(s)

function score(el, s) {
  const b = el.querySelector('b')
  if (typeof s !== 'number') return (b.textContent = '—'), (b.className = ''), void (el.querySelector('small').textContent = 'Not scored yet')
  const pct = Math.round(s * 100)
  b.textContent = `${pct}%`
  b.className = pct >= 70 ? 'bad' : pct < 30 ? 'good' : ''
  el.querySelector('small').textContent = pct >= 70 ? 'Likely spam' : pct < 30 ? 'Looks fine' : 'Unsure'
}

const { cast } = await start()
if (!cast) status('Open this from a cast’s ⋯ menu in Quilcast.', true)
else {
  const hash = cast.hash.replace(/^0x/, '').toLowerCase()
  try {
    const [c, u] = await Promise.all([fetch(`${API}/scores?h=${hash}`).then((r) => r.json()), fetch(`${API}/users?fid=${cast.author.fid}`).then((r) => r.json())])
    score($('#cast-score'), c[hash])
    score($('#user-score'), u[cast.author.fid])
    $('#scores').hidden = false
  } catch {
    status('spam.quilcast.com didn’t answer. Try again in a bit.', true)
  }
}
