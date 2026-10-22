// ogre mode: five taps in a row on the big pfp on /u/borodutch turn the app into a swamp (the looks live in style.css under [data-ogre])
export const OGRE_FID = 1356
const KEY = 'quilcast:ogre'
const root = document.documentElement
const on = () => 'ogre' in root.dataset
const set = (v: boolean) => (corner(v), v ? (root.dataset.ogre = '') : delete root.dataset.ogre)

// the dancing Shrek in the corner plays All Star: a tap swaps the GIF for the official video, embedded from YouTube
// (its player has to stay visible, so the song never plays from a hidden one); turning ogre mode off removes it all
const SONG = 'https://www.youtube-nocookie.com/embed/L_jWHffIx5E?autoplay=1&playsinline=1&loop=1&playlist=L_jWHffIx5E'
let dj: HTMLElement | null = null
function corner(v: boolean) {
  if (!v) return dj?.remove(), (dj = null)
  if (dj) return
  const box = (dj = document.createElement('div'))
  box.className = 'dj'
  const b = document.createElement('button')
  const label = () => (b.textContent = box.classList.contains('on') ? '■ Stop' : '▶\uFE0E All Star')
  b.onclick = () => {
    if (box.classList.toggle('on')) {
      const f = document.createElement('iframe')
      f.src = SONG
      f.title = 'Smash Mouth - All Star'
      f.allow = 'autoplay; encrypted-media; picture-in-picture'
      // the page sends no referrer, and YouTube's player refuses to play without one
      f.referrerPolicy = 'strict-origin-when-cross-origin'
      box.prepend(f)
    } else box.querySelector('iframe')?.remove()
    label()
  }
  label()
  box.append(b)
  document.body.append(box)
}
try {
  set(localStorage.getItem(KEY) === '1')
} catch {}

let taps = 0
let timer = 0
// a random Shrek GIF from Tenor (server/shrek.mjs); the query makes each turn-on fetch a new one
let roar = ''

/** Count a tap on the pfp. Taps more than half a second apart start over. */
export function ogreTap(el: Element) {
  clearTimeout(timer)
  const left = 5 - ++taps
  hit(el, left ? String(left) : on() ? 'ogre mode off' : 'OGRE MODE!')
  // fetch the roar early so it's ready on the last tap
  if (left === 2 && !on()) new Image().src = roar = `/shrek/roar?${Date.now()}`
  if (!left) {
    taps = 0
    set(!on())
    if (on()) {
      const img = document.createElement('img')
      img.className = 'roar'
      img.src = roar
      img.alt = ''
      // on a timer, not animationend: with reduced motion the animation never runs (style.css), so it would never end
      setTimeout(() => img.remove(), 2200)
      document.body.append(img)
    }
    try {
      localStorage.setItem(KEY, on() ? '1' : '')
    } catch {}
    return
  }
  timer = setTimeout(() => (taps = 0), 500)
}

// a number that floats up off the pfp and fades, like damage over a mob in a game
function hit(el: Element, text: string) {
  const r = el.getBoundingClientRect()
  const s = document.createElement('span')
  s.className = 'hit'
  s.textContent = text
  s.style.left = `${r.left + r.width / 2 + Math.random() * 24 - 12}px`
  s.style.top = `${r.top}px`
  setTimeout(() => s.remove(), 900)
  document.body.append(s)
}
