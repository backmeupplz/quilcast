import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { joinAsk, perPeriod } from './billing.ts'

// i18n.ts's t in English: the key with its {placeholders} filled
const t = (s: string, vars: Record<string, string | number> = {}) => s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m))
// and in German, from its language file
const de = JSON.parse(readFileSync(new URL('./locales/de.json', import.meta.url), 'utf8'))
const tDe = (s: string, vars?: Record<string, string | number>) => t(de[s] || s, vars)

test("a Sendclap tier's price says how often it's charged: yearly tiers read /yr, monthly ones stay /mo (#723)", () => {
  assert.equal(perPeriod(t, '$5', 'month'), '$5/mo')
  assert.equal(perPeriod(t, '$50', 'year'), '$50/yr')
  assert.equal(perPeriod(t, '$2', 'week'), '$2/wk')
  // a billing period we don't know never claims to be monthly
  assert.equal(perPeriod(t, '$9', 'fortnight'), '$9')
  assert.equal(perPeriod(t, '$9', ''), '$9')
  assert.equal(perPeriod(tDe, '$50', 'year'), '$50/Jahr')
  assert.equal(perPeriod(tDe, '$5', 'month'), '$5/Monat')
})

test('joining a tier asks with its own billing period (#723)', () => {
  assert.equal(joinAsk(t, '$5', 'month'), 'Join for $5 a month?')
  assert.equal(joinAsk(t, '$50', 'year'), 'Join for $50 a year?')
  assert.equal(joinAsk(t, '$2', 'week'), 'Join for $2 a week?')
  assert.equal(joinAsk(t, '$9', 'fortnight'), 'Join for $9?')
  assert.equal(joinAsk(tDe, '$50', 'year'), 'Für $50 im Jahr beitreten?')
})
