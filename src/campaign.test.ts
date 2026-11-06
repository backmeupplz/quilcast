import assert from 'node:assert/strict'
import { test } from 'node:test'
import { firstSignIn, keepCampaign } from './campaign.ts'

const store = () => {
  const m = new Map<string, string>()
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }
}
const now = 1e12
const DAY = 864e5

test("a campaign link's campaign is sent with the browser's first sign-in, once", () => {
  const s = store()
  keepCampaign('?utm_source=bot&utm_medium=telegram&utm_campaign=p7-a&utm_content=a', false, s, now)
  assert.equal(firstSignIn(false, s, now + DAY), 'p7-a')
  // later sign-ins here aren't first ones, even from another campaign link
  keepCampaign('?utm_campaign=p8-b', false, s, now)
  assert.equal(firstSignIn(false, s, now), null)
})

test('no campaign: a bad name, a link with none, one kept over 30 days, or a browser that had an account', () => {
  for (const q of ['?utm_campaign=a%20b', '?utm_campaign=' + 'x'.repeat(65), '?utm_campaign=', '?utm_source=bot', '']) {
    const s = store()
    keepCampaign(q, false, s, now)
    assert.equal(firstSignIn(false, s, now), null, q)
  }
  let s = store()
  keepCampaign('?utm_campaign=old', false, s, now)
  assert.equal(firstSignIn(false, s, now + 30 * DAY), null)
  s = store()
  keepCampaign('?utm_campaign=p7-a', false, s, now)
  assert.equal(firstSignIn(true, s, now), null)
  // a browser that held an account before sign-ins were marked: its next one isn't a first one either
  s = store()
  keepCampaign('?utm_campaign=p7-a', true, s, now)
  assert.equal(firstSignIn(false, s, now), null)
  // and the campaign is gone with it
  assert.equal(s.m.size, 1)
  // a tampered value is ignored
  s = store()
  s.setItem('quilcast:campaign', '{"c":"a b","at":1e12}')
  assert.equal(firstSignIn(false, s, now), null)
  s = store()
  s.setItem('quilcast:campaign', 'not json')
  assert.equal(firstSignIn(false, s, now), null)
})

test('a newer campaign link replaces the one kept', () => {
  const s = store()
  keepCampaign('?utm_campaign=p7-a', false, s, now)
  keepCampaign('?utm_campaign=p7-b', false, s, now + 1)
  keepCampaign('?utm_campaign=bad%20one', false, s, now + 2)
  assert.equal(firstSignIn(false, s, now + 3), 'p7-b')
})
