// Who put each file on the media volume (upload.mjs): deleting an account only takes files it alone uploaded, and
// never one before the legacy list (every file there before 0.40.0) has been written.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const media = await mkdtemp(join(tmpdir(), 'qc-owners-'))
process.env.MEDIA_DIR = media
// production as 0.36–0.39 left it: fid 7's list names a file someone else uploaded first (a re-upload replaced it and
// recorded only fid 7), and there is no legacy list yet
const theirs = `${'a'.repeat(24)}.png`
await writeFile(join(media, theirs), 'x')
await mkdir(join(media, 'owners'))
await writeFile(join(media, 'owners', '7'), theirs + '\n')
const { dropMedia, loadOwners, ownerMap } = await import('./upload.mjs')

test('without the legacy list nothing is deleted, and it is written by the next try', { skip: process.getuid?.() === 0 && 'root reads any directory' }, async () => {
  // the volume can't be listed: the legacy list can't be written, so the file 0.36–0.39 says is fid 7's alone stays
  await chmod(media, 0o311)
  try {
    await loadOwners()
    assert.ok(!existsSync(join(media, 'owners', 'legacy')))
    const owners = await ownerMap()
    assert.deepEqual([...owners.get(theirs)], [7])
    assert.deepEqual(await dropMedia(7, [theirs], new Set([theirs])), { media: 0, skipped: 1, unready: true })
  } finally {
    await chmod(media, 0o755)
  }
  assert.ok(existsSync(join(media, theirs)))
  // fid 7's list stays for a later try
  assert.equal(await readFile(join(media, 'owners', '7'), 'utf8'), theirs + '\n')

  // once it can be listed, the next owner change writes the legacy list first, and the file is nobody's alone
  assert.deepEqual(await dropMedia(7, [theirs], new Set([theirs])), { media: 0, skipped: 1 })
  assert.equal(await readFile(join(media, 'owners', 'legacy'), 'utf8'), theirs + '\n')
  // (fid 7 is off it now, its account deleted)
  assert.deepEqual([...(await ownerMap()).get(theirs)], ['legacy'])
  assert.ok(existsSync(join(media, theirs)))
  assert.ok(!existsSync(join(media, 'owners', '7')))
})

test('a name that is no media file, or one fid 7 does not own, is never deleted', async () => {
  await writeFile(join(media, 'owners', '9'), `${'b'.repeat(24)}.png\n`)
  await writeFile(join(media, `${'b'.repeat(24)}.png`), 'y')
  assert.deepEqual(await dropMedia(7, ['../owners/9', `${'b'.repeat(24)}.png`], new Set()), { media: 0, skipped: 2 })
  assert.ok(existsSync(join(media, `${'b'.repeat(24)}.png`)) && existsSync(join(media, 'owners', '9')))
})
