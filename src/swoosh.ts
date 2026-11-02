// The tip's sound (ui.tsx CastCard), made on the spot with Web Audio so there's no file to load: noise through a
// band-pass sweeping up with a rising tone under it, so a held Like swooshes up; done() ends it with a chime,
// stop() (let go early) fades it out.
let ctx: AudioContext | undefined
const quiet = { stop() {}, done() {} }

export function swoosh(ms: number) {
  try {
    ctx ||= new AudioContext()
  } catch {
    return quiet
  }
  const a = ctx, t = a.currentTime, end = t + ms / 1000
  void a.resume()
  const out = a.createGain()
  out.connect(a.destination)
  out.gain.setValueAtTime(0.0001, t)
  out.gain.exponentialRampToValueAtTime(0.3, end)
  const buf = a.createBuffer(1, a.sampleRate, a.sampleRate), d = buf.getChannelData(0)
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
  const noise = a.createBufferSource()
  noise.buffer = buf
  noise.loop = true
  const band = a.createBiquadFilter()
  band.type = 'bandpass'
  band.Q.value = 5
  band.frequency.setValueAtTime(250, t)
  band.frequency.exponentialRampToValueAtTime(5000, end)
  noise.connect(band).connect(out)
  const tone = a.createOscillator(), soft = a.createGain()
  tone.type = 'triangle'
  tone.frequency.setValueAtTime(160, t)
  tone.frequency.exponentialRampToValueAtTime(900, end)
  soft.gain.value = 0.2
  tone.connect(soft).connect(out)
  noise.start(t)
  tone.start(t)
  const fade = (s: number) => {
    const n = a.currentTime
    out.gain.cancelScheduledValues(n)
    out.gain.setValueAtTime(Math.max(out.gain.value, 0.0001), n)
    out.gain.exponentialRampToValueAtTime(0.0001, n + s)
    noise.stop(n + s)
    tone.stop(n + s)
  }
  return {
    stop: () => fade(0.08),
    done: () => {
      fade(0.3)
      // two bright notes a beat apart (G6, C7)
      ;[1568, 2093].forEach((f, i) => {
        const o = a.createOscillator(), g = a.createGain(), s = a.currentTime + i * 0.08
        o.frequency.value = f
        g.gain.setValueAtTime(0.0001, s)
        g.gain.exponentialRampToValueAtTime(0.25, s + 0.01)
        g.gain.exponentialRampToValueAtTime(0.0001, s + 0.6)
        o.connect(g).connect(a.destination)
        o.start(s)
        o.stop(s + 0.6)
      })
    },
  }
}
