// Draws a Telegram animated sticker (.tgs: gzipped Lottie JSON) into PAM frames for img2webp, with ThorVG's software
// renderer (WebAssembly, no browser). Runs as its own process (server/stickers.mjs spawns it), so a slow or broken
// sticker never blocks the server.
//   node server/tgs.mjs <in.tgs> <out dir> <size>   prints "<frame ms>" and writes 0000.pam, 0001.pam, …
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'

const [input, out, side] = [process.argv[2], process.argv[3], Number(process.argv[4]) || 320]
const DIST = new URL('../node_modules/@thorvg/webcanvas/dist/', import.meta.url).pathname
// ThorVG's software renderer hands each frame to a canvas's putImageData; this canvas only keeps it
let frame
globalThis.ImageData = class { constructor(data, width, height) { Object.assign(this, { data, width, height }) } }
globalThis.HTMLCanvasElement = class { width = 0; height = 0; style = {}; getContext() { return { putImageData: (img) => (frame = img), clearRect() {} } } }
// and it loads its .wasm with fetch, which Node can't do for a file
const web = globalThis.fetch
globalThis.fetch = async (u, o) => (String(u).endsWith('.wasm') ? new Response(readFileSync(String(u).replace(/^file:\/\//, '')), { headers: { 'content-type': 'application/wasm' } }) : web(u, o))
const { default: ThorVG } = await import('@thorvg/webcanvas')
const TVG = await ThorVG.init({ renderer: 'sw', locateFile: (f) => join(DIST, f) })

const raw = readFileSync(input)
const json = (raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw, { maxOutputLength: 8e6 }) : raw).toString('utf8')
const canvas = new TVG.Canvas(new HTMLCanvasElement(), { width: side, height: side, enableDevicePixelRatio: false })
const anim = new TVG.LottieAnimation()
anim.load(json)
const info = anim.info()
if (!info?.totalFrames || !info.fps) throw new Error('not a Lottie animation')
anim.picture.size(side, side)
canvas.add(anim.picture)
// 30 frames a second at most (Telegram's are 60), 10 seconds at most
const step = Math.max(1, Math.round(info.fps / 30))
const total = Math.min(info.totalFrames, info.fps * 10)
const head = Buffer.from(`P7\nWIDTH ${side}\nHEIGHT ${side}\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n`)
let n = 0
for (let f = 0; f < total; f += step) {
  anim.frame(f)
  canvas.update().render()
  writeFileSync(join(out, `${String(n++).padStart(4, '0')}.pam`), Buffer.concat([head, Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength)]))
}
process.stdout.write(String(Math.round((1000 * step) / info.fps)))
