// Profile effects (Look.fx): snow, confetti, fireflies and the like, drawn on one canvas over the profile. Every
// effect is a few numbers for the one small particle engine below, so nothing a profile owner writes ever runs.
import type { Fx } from './shared.ts'

type Mode = 'fall' | 'rise' | 'twinkle' | 'wander' | 'across' | 'streak' | 'burst' | 'trail'
type Preset = {
  name: string; mode: Mode
  draw: 'dot' | 'glow' | 'rect' | 'line' | 'ring' | string[] // a list is characters or emoji
  n: number // how many on a 1000×1000 screen (fewer on a phone)
  size: [number, number]; speed: [number, number]
  colors?: string[]; sway?: number; spin?: number; slant?: number; g?: number; alpha?: number; life?: [number, number]
  tail?: number // characters trailing behind, fading (a canvas faded frame by frame never quite clears, so trails are drawn)
  pulse?: boolean
  flash?: boolean // lightning
}

const BRIGHT = ['#ff3f8e', '#ffd23f', '#3fd0ff', '#7cff6b', '#b46bff', '#ff8a3d']
const KANA = [...'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン01']
export const PRESETS: Record<Fx, Preset> = {
  snow: { name: 'Snow', mode: 'fall', draw: 'dot', n: 140, size: [1.5, 4], speed: [30, 80], sway: 18, colors: ['#ffffff'], alpha: 0.9 },
  flakes: { name: 'Snowflakes', mode: 'fall', draw: ['❄', '❅', '❆'], n: 40, size: [12, 26], speed: [30, 70], sway: 30, spin: 1, colors: ['#ffffff', '#dff3ff'] },
  rain: { name: 'Rain', mode: 'fall', draw: 'line', n: 160, size: [12, 22], speed: [600, 900], slant: 0.12, colors: ['#a9bde6'], alpha: 0.6 },
  storm: { name: 'Thunderstorm', mode: 'fall', draw: 'line', n: 260, size: [16, 30], speed: [900, 1300], slant: 0.3, colors: ['#9fb2d9'], alpha: 0.6, flash: true },
  leaves: { name: 'Autumn leaves', mode: 'fall', draw: ['🍂', '🍁'], n: 22, size: [18, 32], speed: [40, 90], sway: 60, spin: 1.5 },
  sakura: { name: 'Cherry blossoms', mode: 'fall', draw: ['🌸'], n: 30, size: [12, 22], speed: [30, 70], sway: 70, spin: 2 },
  confetti: { name: 'Confetti', mode: 'fall', draw: 'rect', n: 120, size: [6, 12], speed: [80, 160], sway: 25, spin: 4, colors: BRIGHT },
  hearts: { name: 'Floating hearts', mode: 'rise', draw: ['💖', '💕', '💗', '❤️'], n: 22, size: [14, 28], speed: [30, 70], sway: 25 },
  bubbles: { name: 'Bubbles', mode: 'rise', draw: 'ring', n: 35, size: [6, 22], speed: [30, 80], sway: 20, colors: ['#ffffff', '#cdf3ff'], alpha: 0.75 },
  stars: { name: 'Twinkling stars', mode: 'twinkle', draw: ['✦', '✧', '⋆'], n: 60, size: [8, 18], speed: [0, 0], colors: ['#fff6c2', '#ffffff', '#ffd84d'] },
  glitter: { name: 'Glitter', mode: 'twinkle', draw: 'dot', n: 160, size: [1, 2.5], speed: [0, 0], colors: ['#ff8ad8', '#ffe066', '#ffffff', '#8ae8ff'] },
  fireflies: { name: 'Fireflies', mode: 'wander', draw: 'glow', n: 30, size: [2, 3.5], speed: [10, 30], colors: ['#e8ff6a', '#ffe066'], pulse: true },
  embers: { name: 'Embers', mode: 'rise', draw: 'glow', n: 70, size: [1.2, 3], speed: [30, 90], sway: 30, colors: ['#ff7a1a', '#ff3d00', '#ffc24d'], life: [2, 6] },
  bokeh: { name: 'Bokeh', mode: 'wander', draw: 'dot', n: 18, size: [20, 60], speed: [5, 15], colors: ['#ff9ad5', '#9ad8ff', '#fff19a', '#b8ff9a'], alpha: 0.18 },
  meteors: { name: 'Shooting stars', mode: 'streak', draw: 'line', n: 4, size: [70, 140], speed: [500, 800], colors: ['#ffffff'] },
  fireworks: { name: 'Fireworks', mode: 'burst', draw: 'line', n: 3, size: [6, 10], speed: [0, 0], g: 300, colors: BRIGHT },
  matrix: { name: 'Matrix code', mode: 'fall', draw: KANA, n: 40, size: [14, 18], speed: [80, 200], colors: ['#3cff6e'], tail: 12 },
  money: { name: 'Make it rain', mode: 'fall', draw: ['💸', '💵', '💰'], n: 20, size: [18, 30], speed: [70, 140], sway: 30, spin: 1.5 },
  pizza: { name: 'Pizza', mode: 'fall', draw: ['🍕'], n: 18, size: [18, 32], speed: [60, 120], sway: 20, spin: 2 },
  balloons: { name: 'Balloons', mode: 'rise', draw: ['🎈'], n: 14, size: [24, 40], speed: [40, 80], sway: 15 },
  bats: { name: 'Bats', mode: 'across', draw: ['🦇'], n: 10, size: [18, 32], speed: [60, 140], sway: 14 },
  ghosts: { name: 'Ghosts', mode: 'rise', draw: ['👻'], n: 10, size: [20, 34], speed: [20, 50], sway: 40, alpha: 0.8 },
  spooky: { name: 'Spooky', mode: 'fall', draw: ['🎃', '🕸️', '💀', '🕷️'], n: 18, size: [16, 30], speed: [40, 90], sway: 30, spin: 1 },
  butterflies: { name: 'Butterflies', mode: 'wander', draw: ['🦋'], n: 10, size: [18, 28], speed: [30, 60] },
  notes: { name: 'Music notes', mode: 'rise', draw: ['🎵', '🎶'], n: 18, size: [14, 26], speed: [30, 70], sway: 30 },
  emoji: { name: 'Emoji rain', mode: 'fall', draw: ['😂', '🔥', '💯', '✨', '😍', '🥳', '👀'], n: 24, size: [16, 30], speed: [60, 130], sway: 15, spin: 1 },
  trail: { name: 'Sparkle cursor', mode: 'trail', draw: ['✦', '✧', '⋆'], n: 0, size: [8, 16], speed: [0, 0], g: 60, colors: ['#ffd84d', '#ffffff', '#ff8ad8'], life: [0.5, 1.1] },
}

type P = { x: number; y: number; vx: number; vy: number; v: number; s: number; a: number; va: number; ph: number; t: number; life: number; c: string; g: string; spark?: boolean }
const R = (a: number, b: number) => a + Math.random() * (b - a)
const any = <T>(l: T[]) => l[Math.floor(Math.random() * l.length)]
const EMOJI = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif'

/** Run an effect on a full-screen canvas; returns the function that stops it. */
export function start(canvas: HTMLCanvasElement, fx: Fx): () => void {
  const p = PRESETS[fx]
  if (!p || matchMedia('(prefers-reduced-motion: reduce)').matches) return () => {}
  const ctx = canvas.getContext('2d')!
  let W = 0, H = 0, raf = 0, last = performance.now(), flash = 0, bolt = last + R(3e3, 8e3)
  const ps: P[] = []
  const resize = () => {
    const dpr = Math.min(2, devicePixelRatio || 1)
    W = innerWidth, H = innerHeight
    canvas.width = W * dpr, canvas.height = H * dpr
    // a resized canvas forgets its settings
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
  }

  // a new particle; `first` ones are spread over the screen so the effect doesn't start empty
  const make = (first: boolean): P => {
    const v = R(...p.speed), s = R(...p.size)
    const q: P = { x: R(0, W), y: R(0, H), vx: 0, vy: 0, v, s, a: p.spin ? R(0, 6.3) : 0, va: (p.spin || 0) * R(-1, 1), ph: R(0, 6.3), t: 0, life: Infinity, c: any(p.colors || ['#fff']), g: typeof p.draw === 'string' ? '' : any(p.draw) }
    if (p.life) (q.life = R(...p.life)), first && (q.t = R(0, q.life))
    if (p.mode === 'fall') (q.vy = v), (q.vx = -v * (p.slant || 0)), (q.x = R(0, W + H * (p.slant || 0))), first || (q.y = -s * 2)
    // embers (with a life) start low on the screen; everything else rising starts just below it
    if (p.mode === 'rise') (q.vy = -v), first || (q.y = p.life ? R(H * 0.7, H + s) : H + s * 2)
    if (p.mode === 'twinkle') (q.life = R(1.5, 4)), (q.t = first ? R(0, q.life) : 0)
    if (p.mode === 'across') (q.vx = v), first || (q.x = -s * 2)
    // shooting stars and rockets wait a while (t < 0) before they go
    if (p.mode === 'streak') (q.x = R(W * 0.2, W * 1.2)), (q.y = R(-H * 0.1, H * 0.4)), (q.vx = -v * 0.8), (q.vy = v * 0.6), (q.life = R(0.6, 1.2)), (q.t = -R(0.3, 5))
    if (p.mode === 'burst') {
      const up = Math.sqrt(2 * p.g! * R(H * 0.45, H * 0.8))
      ;(q.x = R(W * 0.15, W * 0.85)), (q.y = H), (q.vy = -up), (q.life = up / p.g!), (q.t = -R(0, 2.5))
    }
    return q
  }
  const want = () => Math.round(p.n * Math.min(1.5, Math.max(0.4, (W * H) / 1e6)))

  const draw = (q: P, alpha: number) => {
    ctx.globalAlpha = alpha * (p.alpha ?? 1) * (p.pulse ? 0.3 + 0.7 * Math.abs(Math.sin(q.t * 1.3 + q.a)) : 1)
    const sway = p.sway ? Math.sin(q.ph + q.t * 1.6) * p.sway : 0
    const [x, y] = p.mode === 'across' ? [q.x, q.y + sway] : [q.x + sway, q.y]
    ctx.fillStyle = ctx.strokeStyle = q.c
    const d = p.draw
    if (d === 'dot' || d === 'glow' || d === 'ring') {
      if (d === 'glow') {
        const a = ctx.globalAlpha
        ctx.globalAlpha = a * 0.2
        ctx.beginPath(), ctx.arc(x, y, q.s * 3.5, 0, 6.29), ctx.fill()
        ctx.globalAlpha = a
      }
      ctx.beginPath(), ctx.arc(x, y, q.s, 0, 6.29)
      if (d !== 'ring') return ctx.fill()
      ctx.lineWidth = 1.2, ctx.stroke()
      ctx.beginPath(), ctx.arc(x - q.s * 0.35, y - q.s * 0.35, q.s * 0.25, 0, 6.29), ctx.fill()
    } else if (d === 'line') {
      const k = q.s / Math.hypot(q.vx, q.vy)
      ctx.lineWidth = 1.2, ctx.beginPath(), ctx.moveTo(x, y), ctx.lineTo(x - q.vx * k, y - q.vy * k), ctx.stroke()
    } else if (d === 'rect') {
      ctx.save(), ctx.translate(x, y), ctx.rotate(q.a), ctx.scale(1, Math.cos(q.t * 6 + q.ph))
      ctx.fillRect(-q.s / 2, -q.s / 4, q.s, q.s / 2)
      ctx.restore()
    } else if (p.tail) {
      // a column of characters on a grid, each row's character fixed, so the column seems to write itself downwards
      const a = ctx.globalAlpha, row = Math.floor(y / q.s), seed = (q.ph * 1e3) | 0
      ctx.font = `${q.s | 0}px ui-monospace, monospace`
      for (let k = 0; k < p.tail; k++) {
        ctx.globalAlpha = a * (1 - k / p.tail)
        ctx.fillText(k ? d[Math.abs(seed + (row - k) * 7) % d.length] : any(d), x, (row - k) * q.s)
      }
    } else {
      ctx.save(), ctx.translate(x, y), ctx.rotate(q.a)
      ctx.font = `${q.s | 0}px ${EMOJI}`
      ctx.fillText(q.g, 0, 0)
      ctx.restore()
    }
  }

  const tick = (now: number) => {
    raf = requestAnimationFrame(tick)
    const dt = Math.min(0.05, (now - last) / 1000)
    last = now
    ctx.clearRect(0, 0, W, H)
    if (p.mode !== 'trail') while (ps.length < want()) ps.push(make(true))
    for (let i = ps.length; i--;) {
      const q = ps[i]
      q.t += dt
      if (q.t < 0) continue
      if (p.mode === 'wander') (q.ph += R(-2, 2) * dt), (q.vx = Math.cos(q.ph) * q.v), (q.vy = Math.sin(q.ph) * q.v)
      if (p.g) q.vy += p.g * dt
      q.x += q.vx * dt, q.y += q.vy * dt, q.a += q.va * dt
      // things that drift around come back in on the other side
      if (p.mode === 'wander') (q.x = ((q.x + W + 240) % (W + 160)) - 80), (q.y = ((q.y + H + 240) % (H + 160)) - 80)
      if (p.mode === 'burst' && !q.spark && q.t >= q.life) {
        const c = any(p.colors!)
        for (let k = 0; k < 40; k++) {
          const a = R(0, 6.29), v = R(40, 220)
          ps.push({ ...q, vx: Math.cos(a) * v, vy: Math.sin(a) * v, t: 0, life: R(0.8, 1.6), c: Math.random() < 0.7 ? c : any(p.colors!), spark: true })
        }
        ps[i] = make(false)
        continue
      }
      const m = q.s * 2 + 60
      if (q.t > q.life || q.y > H + m || q.y < -m || (p.mode === 'across' && q.x > W + m) || (p.mode === 'streak' && q.x < -m)) {
        if (q.spark || p.mode === 'trail') ps.splice(i, 1)
        else ps[i] = make(false)
        continue
      }
      const left = q.life === Infinity ? 1 : 1 - q.t / q.life
      draw(q, p.mode === 'twinkle' ? Math.sin(Math.PI * (q.t / q.life)) : p.mode === 'burst' && !q.spark ? 1 : left)
    }
    if (p.flash) {
      if (now > bolt) (flash = 0.35), (bolt = now + R(5e3, 14e3))
      if (flash > 0.01) (ctx.globalAlpha = flash), (ctx.fillStyle = '#fff'), ctx.fillRect(0, 0, W, H), (flash *= 0.86)
    }
    ctx.globalAlpha = 1
  }

  // the sparkle trail follows the mouse or a finger
  const onMove = (e: PointerEvent) => {
    if (ps.length > 150) return
    for (let k = 0; k < 2; k++) {
      const q = make(false)
      ;(q.x = e.clientX + R(-6, 6)), (q.y = e.clientY + R(-6, 6)), (q.vx = R(-30, 30)), (q.vy = R(-40, 10)), (q.va = R(-3, 3)), ps.push(q)
    }
  }
  resize()
  addEventListener('resize', resize)
  if (p.mode === 'trail') addEventListener('pointermove', onMove, { passive: true })
  raf = requestAnimationFrame(tick)
  return () => {
    cancelAnimationFrame(raf)
    removeEventListener('resize', resize)
    removeEventListener('pointermove', onMove)
    ctx.clearRect(0, 0, W, H)
  }
}
