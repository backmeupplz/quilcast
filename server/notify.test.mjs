import assert from 'node:assert/strict'
import { test } from 'node:test'
import { shareUrl } from './notify.mjs'

test("a cast action's castShareUrl counts only as https on the manifest's own origin", () => {
  const o = 'https://remind.example.com'
  assert.equal(shareUrl('https://remind.example.com/share?x=1', o), 'https://remind.example.com/share?x=1')
  for (const bad of ['https://evil.example.com/share', 'http://remind.example.com/share', 'https://remind.example.com:8443/', 'https://[bad', '/share', 42, undefined])
    assert.equal(shareUrl(bad, o), undefined, String(bad))
})
