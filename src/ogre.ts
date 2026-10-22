// ogre mode: five taps in a row on the big pfp on /u/borodutch turn the app into a swamp (the looks live in style.css under [data-ogre])
export const OGRE_FID = 1356
const KEY = 'quilcast:ogre'
const root = document.documentElement
const on = () => 'ogre' in root.dataset
const set = (v: boolean) => (corner(v), v ? (root.dataset.ogre = '') : delete root.dataset.ogre)

// All Star plays in ogre mode, from the 0:37 mark where the music starts (the video opens with a skit). It comes from
// YouTube's embed in a hidden frame, so the GIF stays; browsers allow sound only after a tap or key on the page, so
// it waits for the first one. The button by the corner GIF stops and starts it, and stopping is remembered.
const SONG = 'https://www.youtube-nocookie.com/embed/L_jWHffIx5E?autoplay=1&start=37&playsinline=1&loop=1&playlist=L_jWHffIx5E'
const MUTE = 'quilcast:allstar-off'
let dj: HTMLElement | null = null
function corner(v: boolean) {
  if (!v) return disarm(), dj?.remove(), (dj = null)
  if (dj) return
  const box = (dj = document.createElement('div'))
  box.className = 'dj'
  const b = document.createElement('button')
  box.append(b)
  document.body.append(box)
  b.onclick = () => {
    const on = !box.querySelector('iframe')
    play(on)
    try {
      on ? localStorage.removeItem(MUTE) : localStorage.setItem(MUTE, '1')
    } catch {}
  }
  let off = false
  try {
    off = localStorage.getItem(MUTE) === '1'
  } catch {}
  // turning ogre mode on is a tap already
  play(false)
  if (!off) navigator.userActivation?.isActive ? play(true) : (addEventListener('pointerdown', first, true), addEventListener('keydown', first, true))
}
function play(v: boolean) {
  if (!dj) return
  disarm()
  dj.querySelector('iframe')?.remove()
  if (v) {
    const f = document.createElement('iframe')
    f.src = SONG
    f.title = 'Smash Mouth - All Star'
    f.allow = 'autoplay; encrypted-media'
    // the page sends no referrer, and YouTube's player refuses to play without one
    f.referrerPolicy = 'strict-origin-when-cross-origin'
    dj.prepend(f)
  }
  dj.querySelector('button')!.textContent = v ? '■\uFE0E Stop' : '▶\uFE0E All Star'
}
// the first tap or key anywhere starts it, unless it's on the button, which decides for itself
const first = (e: Event) => dj && !dj.contains(e.target as Node) && play(true)
const disarm = () => (removeEventListener('pointerdown', first, true), removeEventListener('keydown', first, true))
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
