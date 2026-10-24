// Skins are zips from the Winamp Skin Museum: the reader has to find files by name in any folder or case, inflate
// them, and the two text files have to come out as colors.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deflateRawSync } from 'node:zlib'
import { pledit, unzip, viscolor } from './skin.ts'

// a zip as skins come: one file stored, one deflated, in a folder, with a data descriptor's zero sizes locally
function zip(files: [string, string, boolean][]) {
  const parts: Buffer[] = []
  const dir: Buffer[] = []
  let at = 0
  for (const [name, text, deflate] of files) {
    const raw = Buffer.from(text)
    const data = deflate ? deflateRawSync(raw) : raw
    const n = Buffer.from(name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(deflate ? 8 : 0, 8)
    local.writeUInt16LE(n.length, 26)
    const c = Buffer.alloc(46)
    c.writeUInt32LE(0x02014b50, 0)
    c.writeUInt16LE(deflate ? 8 : 0, 10)
    c.writeUInt32LE(data.length, 20)
    c.writeUInt32LE(raw.length, 24)
    c.writeUInt16LE(n.length, 28)
    c.writeUInt32LE(at, 42)
    parts.push(local, n, data)
    dir.push(c, n)
    at += 30 + n.length + data.length
  }
  const cd = Buffer.concat(dir)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(at, 16)
  const b = Buffer.concat([...parts, cd, end])
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.length) as ArrayBuffer
}

test('unzip finds files by lower-case name in any folder and inflates them', async () => {
  const f = unzip(zip([['MySkin/MAIN.BMP', 'stored', false], ['MySkin/PlEdit.txt', '[Text]\r\nNormal=#00FF00\r\n'.repeat(20), true]]))
  assert.deepEqual([...f.keys()], ['main.bmp', 'pledit.txt'])
  assert.equal(new TextDecoder().decode(await f.get('main.bmp')!()), 'stored')
  assert.equal(new TextDecoder().decode(await f.get('pledit.txt')!()), '[Text]\r\nNormal=#00FF00\r\n'.repeat(20))
  assert.throws(() => unzip(new ArrayBuffer(10)))
})

test('PLEDIT.TXT and VISCOLOR.TXT become colors, with defaults for what is missing or broken', () => {
  assert.deepEqual(pledit('[Text]\r\nnormal=00ff00\r\nCurrent=#FFFFFF\r\nNormalBG=red;x\r\nFont=Arial"};\r\n'), { normal: '#00ff00', current: '#FFFFFF', bg: '#000000', font: 'Arial' })
  const v = viscolor(Array.from({ length: 24 }, (_, i) => `${i},${i}, ${i}, // color ${i}`).join('\n'))!
  assert.equal(v.length, 24)
  assert.equal(v[2], 'rgb(2,2,2)')
  assert.equal(viscolor('nope'), undefined)
})
