import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { renderAsync } from '@resvg/resvg-js'
import { loadStickers, pruning, stickerFile, stickerStill } from './stickers.mjs'

const svgPng = async (w, h, body) => (await renderAsync(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${body}</svg>`)).asPng()
// stickerStill's data URI as PNG bytes
const still = async (h) => {
  const uri = await stickerStill(h)
  if (uri === null) return null
  assert.match(uri, /^data:image\/png;base64,/)
  return Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64')
}
const size = (png) => [png.readUInt32BE(16), png.readUInt32BE(20)]
// a PNG's pixel as [r, g, b, a], drawn by resvg at its own size
async function rgba(png, x, y) {
  const [w, h] = size(png)
  const px = (await renderAsync(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><image href="data:image/png;base64,${png.toString('base64')}" width="${w}" height="${h}"/></svg>`)).pixels
  return [...px.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)]
}
// PNG frames on disk, for img2webp
const frameFiles = (tmp, w, h, bodies) =>
  Promise.all(bodies.map(async (body, i) => {
    const f = join(tmp, `${w}-${i}.png`)
    writeFileSync(f, await svgPng(w, h, body))
    return f
  }))

test('a sticker without a still (an animated WebP that came in as it is) gets one from its first frame, kept', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'stickers-test-'))
  await loadStickers(tmp)
  // two 200×120 frames, red then blue: img2webp makes them an animated WebP
  const frames = await frameFiles(tmp, 200, 120, ['<rect width="200" height="120" fill="#f00"/>', '<rect width="200" height="120" fill="#00f"/>'])
  const h = 'a'.repeat(24)
  execFileSync('img2webp', ['-lossless', '-loop', '0', '-d', '100', ...frames, '-o', stickerFile(h)], { stdio: 'ignore' })
  assert.ok(readFileSync(stickerFile(h)).includes('ANIM'))
  // two asks at once make it once
  const [png, again] = await Promise.all([still(h), still(h)])
  assert.equal(png.toString('latin1', 1, 4), 'PNG')
  assert.deepEqual(png, again)
  assert.deepEqual(size(png), [200, 120])
  assert.deepEqual((await rgba(png, 100, 60)).slice(0, 3), [255, 0, 0])
  assert.ok(existsSync(join(tmp, 'stickers', 'files', `${h}.png`)))
  // a still WebP without one is decoded as it is; a sticker that isn't there has none
  const s = 'b'.repeat(24)
  execFileSync('img2webp', ['-lossless', frames[1], '-o', stickerFile(s)], { stdio: 'ignore' })
  assert.deepEqual(size(await still(s)), [200, 120])
  assert.equal(await still('c'.repeat(24)), null)
  assert.equal(await stickerStill('../x'), null)
})

test("an animated sticker's first frame, which the encoder crops to what's drawn, is put back in its place on the whole canvas", async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'stickers-test-'))
  await loadStickers(tmp)
  // a small square off-center on a transparent 320 px canvas, then elsewhere
  const frames = await frameFiles(tmp, 320, 320, [[220, 200], [40, 60]].map(([x, y]) => `<rect x="${x}" y="${y}" width="60" height="60" fill="#f00"/>`))
  for (const [h, args] of [['d'.repeat(24), ['-lossless']], ['e'.repeat(24), ['-lossy', '-q', '75', '-m', '4']]]) {
    execFileSync('img2webp', [...args, '-loop', '0', '-d', '100', ...frames, '-o', stickerFile(h)], { stdio: 'ignore' })
    const png = await still(h)
    assert.deepEqual(size(png), [320, 320], args[0])
    const [r, g, b, a] = await rgba(png, 250, 230)
    assert.ok(r > 200 && g < 60 && b < 60 && a > 200, `${args[0]} ${[r, g, b, a]}`)
    assert.equal((await rgba(png, 70, 90))[3], 0, args[0])
    assert.equal((await rgba(png, 10, 10))[3], 0, args[0])
  }
})

test('stills kept of a cropped first frame (smaller than the canvas) go when the stickers load, and are made again whole', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'stickers-test-'))
  await loadStickers(tmp)
  const frames = await frameFiles(tmp, 320, 320, [[220, 200], [40, 60]].map(([x, y]) => `<rect x="${x}" y="${y}" width="60" height="60" fill="#f00"/>`))
  const [bad, good, plain] = ['1', '2', '3'].map((c) => c.repeat(24))
  for (const h of [bad, good]) execFileSync('img2webp', ['-lossless', '-loop', '0', '-d', '100', ...frames, '-o', stickerFile(h)], { stdio: 'ignore' })
  execFileSync('img2webp', ['-lossless', frames[0], '-o', stickerFile(plain)], { stdio: 'ignore' })
  const files = join(tmp, 'stickers', 'files')
  writeFileSync(join(files, `${bad}.png`), await svgPng(60, 60, '<rect width="60" height="60" fill="#f00"/>'))
  writeFileSync(join(files, `${good}.png`), await svgPng(320, 320, ''))
  // a still sticker's still is whatever toWebp made of it, never touched
  writeFileSync(join(files, `${plain}.png`), await svgPng(60, 60, ''))
  await loadStickers(tmp)
  assert.equal(await pruning, 1)
  assert.ok(!existsSync(join(files, `${bad}.png`)))
  assert.ok(existsSync(join(files, `${good}.png`)) && existsSync(join(files, `${plain}.png`)))
  assert.deepEqual(size(await still(bad)), [320, 320])
})
