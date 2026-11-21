// The train button's "choo choo" (ui.tsx CastCard board()): a steam whistle blown twice, made on the spot with Web
// Audio like the tip's swoosh (no file to load), and a little train crossing the screen with puffs of steam. Both run
// in the tap itself (iOS and the app shells only let sound start from one) and neither waits for anything, so the
// cast goes out at once. With reduced motion there's no train, only the sound.
import { audio, whiteNoise } from './swoosh.ts'

// the two blasts, [start, length] in seconds: a short "choo" and a longer one
export const BLASTS: [number, number][] = [[0, 0.3], [0.4, 0.55]]
// a whistle sounds a chord; these three (D5, F♯5, A5) scoop up into pitch and droop a little as the steam runs out
const CHORD = [587, 740, 880]

/** Blows the whistle twice; quiet where there's no Web Audio. */
export function choochoo() {
  const a = audio()
  if (!a) return
  try {
    const t = a.currentTime + 0.01
    const out = a.createGain()
    out.gain.value = 0.22
    out.connect(a.destination)
    // the steam: noise through a band-pass, under the chord
    const buf = whiteNoise(a)
    for (const [at, len] of BLASTS) {
      const s = t + at, end = s + len
      const env = a.createGain()
      env.gain.setValueAtTime(0.0001, s)
      env.gain.exponentialRampToValueAtTime(1, s + 0.04)
      env.gain.setValueAtTime(1, end - 0.08)
      env.gain.exponentialRampToValueAtTime(0.0001, end)
      env.connect(out)
      for (const f of CHORD) {
        const o = a.createOscillator(), g = a.createGain()
        o.type = 'triangle'
        o.frequency.setValueAtTime(f * 0.94, s)
        o.frequency.exponentialRampToValueAtTime(f, s + 0.06)
        o.frequency.setValueAtTime(f, end - 0.08)
        o.frequency.exponentialRampToValueAtTime(f * 0.97, end)
        g.gain.value = 0.25
        o.connect(g).connect(env)
        o.start(s)
        o.stop(end + 0.02)
      }
      const noise = a.createBufferSource(), band = a.createBiquadFilter(), g = a.createGain()
      noise.buffer = buf
      band.type = 'bandpass'
      band.frequency.value = 1800
      band.Q.value = 1.2
      g.gain.value = 0.35
      noise.connect(band).connect(g).connect(env)
      noise.start(s)
      noise.stop(end + 0.02)
    }
  } catch {
    // a sound that can't be made never stops the train
  }
}

const el = (tag: string, cls: string, text?: string) => {
  const e = document.createElement(tag)
  e.className = cls
  if (text) e.textContent = text
  return e
}

/** Drives a little train across the screen (style.css .choo) with `say` over it; does nothing with reduced motion.
 *  A new tap starts it over. */
export function runTrain(say: string) {
  if (typeof document === 'undefined' || matchMedia('(prefers-reduced-motion: reduce)').matches) return
  document.querySelector('.choo')?.remove()
  const box = el('div', 'choo'), train = el('div', 'choo-train'), steam = el('span', 'choo-steam')
  box.setAttribute('aria-hidden', 'true')
  steam.append(el('i', ''), el('i', ''), el('i', ''))
  // the emoji locomotive faces left, so it drives right to left with its cars behind it
  train.append(el('span', 'choo-say', say), steam, el('span', 'choo-cars', '🚂🚃🚃'))
  box.append(train)
  document.body.append(box)
  const done = () => box.remove()
  train.addEventListener('animationend', (e) => e.target === train && done())
  // in case the animation never runs (a hidden tab, styles not loaded)
  setTimeout(done, 3000)
}
