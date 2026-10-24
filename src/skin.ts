// Winamp 2 skins for the profile Winamp (src/amp.tsx). A skin (.wsz) is a zip of BMP sprite sheets and a few .txt
// files; they come from the Winamp Skin Museum (skins.webamp.org), whose files and API answer any origin. Where the
// sprites sit follows Webamp (github.com/captbaritone/webamp, MIT).

/** The Winamp 2.91 base skin; it fills in any sheet a skin leaves out, as Winamp did. */
export const BASE = '5e4f10275dcb1fb211d4a8b4f1bda236'
export const skinFile = (md5: string) => `https://r2.webampskins.org/skins/${md5}.wsz`
export const skinShot = (md5: string) => `https://r2.webampskins.org/screenshots/${md5}.png`

/** The files in a zip by lower-case name without folders (some skins keep theirs in one), each read on demand. */
export function unzip(buf: ArrayBuffer) {
  const v = new DataView(buf)
  const b = new Uint8Array(buf)
  let e = b.length - 22
  while (e >= 0 && v.getUint32(e, true) !== 0x06054b50) e--
  if (e < 0) throw new Error('Not a skin file.')
  const files = new Map<string, () => Promise<Uint8Array>>()
  // the central directory has the true sizes (the local headers may leave them to a trailing descriptor)
  for (let i = 0, p = v.getUint32(e + 16, true), n = v.getUint16(e + 10, true); i < n && v.getUint32(p, true) === 0x02014b50; i++) {
    const method = v.getUint16(p + 10, true)
    const size = v.getUint32(p + 20, true)
    const nameLen = v.getUint16(p + 28, true)
    const local = v.getUint32(p + 42, true)
    const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nameLen)).split(/[\\/]/).pop()!.toLowerCase()
    p += 46 + nameLen + v.getUint16(p + 30, true) + v.getUint16(p + 32, true)
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true)
    const data = b.subarray(start, start + size)
    if (!name || files.has(name) || (method !== 0 && method !== 8)) continue
    files.set(name, async () => (method ? new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer()) : data))
  }
  return files
}

const latin1 = (d?: Uint8Array) => (d ? new TextDecoder('windows-1252').decode(d) : '')
const hex = (s?: string) => (s && /^#?[0-9a-f]{6}$/i.test(s.trim()) ? `#${s.trim().replace('#', '')}` : undefined)

/** PLEDIT.TXT: the playlist's colors and font. */
export function pledit(s: string) {
  const kv = new Map(s.split(/\r?\n/).map((l) => l.split('=')).filter((p) => p.length > 1).map(([k, v]) => [k.trim().toLowerCase(), v.trim()]))
  return {
    normal: hex(kv.get('normal')) || '#00ff00', current: hex(kv.get('current')) || '#ffffff',
    bg: hex(kv.get('normalbg')) || '#000000', sel: hex(kv.get('selectedbg')) || '#0000c6', font: (kv.get('font') || 'Arial').replace(/[^\w ]/g, ''),
  }
}

/** VISCOLOR.TXT: the visualizer's 24 colors ("r,g,b, // comment" a line), or nothing when it isn't one. */
export function viscolor(s: string) {
  const c = s.split(/\r?\n/).map((l) => l.match(/^\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)).filter((m) => m).map((m) => `rgb(${m![1]},${m![2]},${m![3]})`)
  return c.length >= 18 ? c : undefined
}

export const SHEETS = ['main', 'cbuttons', 'titlebar', 'shufrep', 'posbar', 'volume', 'balance', 'numbers', 'nums_ex', 'playpaus', 'monoster', 'text', 'pledit', 'eqmain', 'eq_ex'] as const
type Sheet = (typeof SHEETS)[number]
// the playlist's edges repeat, and a background can only repeat a whole image, so these are cut out of PLEDIT.BMP
const TILES = { top: [127, 0, 25, 20], left: [0, 42, 12, 29], right: [31, 42, 20, 29], bottom: [179, 0, 25, 38], plshade: [72, 57, 25, 14] } as const
export type Skin = { img: Partial<Record<Sheet | keyof typeof TILES, string>>; pl: ReturnType<typeof pledit>; vis: string[]; eqLine: string[] }

// the equalizer's curve takes its color at each height from a 1×19 strip in EQMAIN.BMP
const strip = async (bmp: Blob) => {
  const c = new OffscreenCanvas(1, 19)
  const g = c.getContext('2d')!
  g.drawImage(await createImageBitmap(bmp), 115, 294, 1, 19, 0, 0, 1, 19)
  const d = g.getImageData(0, 0, 1, 19).data
  return Array.from({ length: 19 }, (_, i) => `rgb(${d[i * 4]},${d[i * 4 + 1]},${d[i * 4 + 2]})`)
}

const cut = async (bmp: Blob, [x, y, w, h]: readonly number[]) => {
  const im = await createImageBitmap(bmp)
  const c = new OffscreenCanvas(w, h)
  c.getContext('2d')!.drawImage(im, x, y, w, h, 0, 0, w, h)
  return URL.createObjectURL(await c.convertToBlob())
}

/** An RLE-compressed BMP (BI_RLE8 or BI_RLE4) as RGBA pixels, top row first. Chrome won't decode some of these
 *  (TEXT.BMP in the XP skin, for one), and pixels a file skips show in the palette's first color, as on Windows. */
export function unrle(d: Uint8Array) {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength)
  const [w, h0, bpp, comp] = [v.getInt32(18, true), v.getInt32(22, true), v.getUint16(28, true), v.getUint32(30, true)]
  const h = Math.abs(h0)
  const four = comp === 2
  if (comp !== 1 && comp !== 2 || w <= 0 || w > 4096 || h > 4096 || bpp !== (four ? 4 : 8)) return null
  const pal = 14 + v.getUint32(14, true)
  const n = v.getUint32(46, true) || 1 << bpp
  const rgb = (c: number) => (c < n ? [d[pal + c * 4 + 2], d[pal + c * 4 + 1], d[pal + c * 4]] : [0, 0, 0])
  const px = new Uint8ClampedArray(w * h * 4)
  const [r0, g0, b0] = rgb(0)
  for (let k = 0; k < px.length; k += 4) (px[k] = r0), (px[k + 1] = g0), (px[k + 2] = b0), (px[k + 3] = 255)
  let x = 0
  let y = 0
  const put = (c: number) => {
    if (x < w && y < h) {
      const k = ((h0 > 0 ? h - 1 - y : y) * w + x) * 4
      ;[px[k], px[k + 1], px[k + 2]] = rgb(c)
    }
    x++
  }
  for (let i = v.getUint32(10, true); i + 1 < d.length;) {
    const [count, c] = [d[i++], d[i++]]
    if (count) for (let j = 0; j < count; j++) put(four ? (j & 1 ? c & 15 : c >> 4) : c)
    else if (c === 0) (x = 0), y++
    else if (c === 1) break
    else if (c === 2) (x += d[i++]), (y += d[i++])
    else {
      // a literal run, padded to a whole 16-bit word
      for (let j = 0; j < c; j++) put(four ? (j & 1 ? d[i + (j >> 1)] & 15 : d[i + (j >> 1)] >> 4) : d[i + j])
      const len = four ? Math.ceil(c / 2) : c
      i += len + (len & 1)
    }
  }
  return { w, h, px }
}

/** A sheet as an image the browser can show: as it is, or decoded here when the browser can't; null if neither. */
async function image(d: Uint8Array): Promise<Blob | null> {
  const b = new Blob([d as BlobPart], { type: 'image/bmp' })
  if (await createImageBitmap(b).then((im) => (im.close(), true), () => false)) return b
  const r = d[0] === 0x42 && d[1] === 0x4d && d.length > 58 ? unrle(d) : null
  if (!r) return null
  const c = new OffscreenCanvas(r.w, r.h)
  c.getContext('2d')!.putImageData(new ImageData(r.px, r.w, r.h), 0, 0)
  return c.convertToBlob()
}

async function read(md5: string): Promise<Skin> {
  const r = await fetch(skinFile(md5))
  if (!r.ok) throw new Error("Couldn't load the skin.")
  const files = unzip(await r.arrayBuffer())
  const get = (n: string) => files.get(n)?.()
  const img: Skin['img'] = {}
  const blobs: Partial<Record<Sheet, Blob>> = {}
  await Promise.all(SHEETS.map(async (s) => {
    const d = await get(`${s}.bmp`)
    // a sheet that can't be read at all is left to the base skin, like a missing one
    const b = d && (await image(d))
    if (b) img[s] = URL.createObjectURL((blobs[s] = b))
  }))
  const pl = blobs.pledit
  const base = md5 !== BASE && SHEETS.some((s) => s !== 'nums_ex' && !img[s]) ? await loadSkin(BASE) : null
  for (const s of SHEETS) if (s !== 'nums_ex') img[s] ||= base?.img[s]
  // (the page's CSP doesn't let it fetch its own blob: URLs, so the tiles come from the bytes)
  for (const k of Object.keys(TILES) as (keyof typeof TILES)[]) img[k] = pl ? await cut(pl, TILES[k]) : base!.img[k]
  return {
    img,
    pl: pledit(latin1(await get('pledit.txt'))),
    vis: viscolor(latin1(await get('viscolor.txt'))) || base?.vis || (await loadSkin(BASE)).vis,
    eqLine: blobs.eqmain ? await strip(blobs.eqmain) : base?.eqLine || (await loadSkin(BASE)).eqLine,
  }
}

const skins = new Map<string, Promise<Skin>>()
/** A skin from the museum, read once; one that won't load (gone, not a skin) falls back to the base skin. */
export function loadSkin(md5 = BASE): Promise<Skin> {
  if (!skins.has(md5)) skins.set(md5, read(md5).catch((e) => (skins.delete(md5), md5 === BASE ? Promise.reject(e) : loadSkin(BASE))))
  return skins.get(md5)!
}

export type MuseumSkin = { md5: string; filename: string; nsfw?: boolean }
const gql = (query: string, variables: object) =>
  fetch('https://api.webamp.org/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) })
    .then((r) => r.json()).then((j) => { if (j.errors) throw new Error(j.errors[0].message); return j.data })
/** Skins in the museum's own order (the official ones first), or matching a search; never the ones marked NSFW. */
export const museum = async (q: string, offset: number): Promise<MuseumSkin[]> =>
  q
    ? (await gql('query($q:String!,$o:Int){search_classic_skins(query:$q,first:24,offset:$o,nsfw:false){md5 filename}}', { q, o: offset })).search_classic_skins
    : (await gql('query($o:Int){skins(first:24,offset:$o,sort:MUSEUM){nodes{md5 filename nsfw}}}', { o: offset })).skins.nodes.filter((s: MuseumSkin) => !s.nsfw)
