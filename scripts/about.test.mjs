// The About page and llms.txt give the composer's attachment limit (MAX_EMBEDS), so the site doesn't promise less than the app takes
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { MAX_EMBEDS } from '../src/shared.ts'

const pub = new URL('../public/', import.meta.url)
const read = (path) => readFileSync(new URL(path, pub), 'utf8')
const words = { 4: 'four' }

test('About and llms.txt name the composer limit', () => {
  const limit = `up to ${words[MAX_EMBEDS]} photos, videos or GIFs per cast (a quoted cast takes one of the ${words[MAX_EMBEDS]})`
  for (const page of ['about.html', 'llms.txt']) {
    assert.ok(read(page).includes(limit), `${page} says "${limit}"`)
    assert.doesNotMatch(read(page), /two photos/, page)
  }
})

// each translation's "four" (the case its limit line uses), next to GIF
const four = {
  ar: 'أربع', de: 'vier', es: 'cuatro', fr: 'quatre', hi: 'चार', id: 'empat', it: 'quattro', ja: '4点', ko: '네 개', nl: 'vier', pl: 'czterema',
  'pt-br': 'quatro', 'pt-pt': 'quatro', ru: 'четырёх', sv: 'fyra', th: 'สี่', tr: 'dört', uk: 'чотирьох', vi: 'bốn', 'zh-hans': '四项', 'zh-hant': '四項',
}

test('every translated About page gives the same limit', () => {
  const langs = readdirSync(pub, { withFileTypes: true }).filter((d) => d.isDirectory() && /^[a-z]{2}(-[a-z]+)?$/.test(d.name)).map((d) => d.name)
  assert.deepEqual(langs.sort(), Object.keys(four).sort())
  assert.equal(MAX_EMBEDS, 4, 'the translations say four')
  for (const lang of langs) {
    const line = read(`${lang}/about.html`).split('\n').find((l) => /GIF/i.test(l))
    assert.ok(line?.includes(four[lang]), `${lang}: ${line}`)
    assert.doesNotMatch(line, /Ã|â€/, `${lang}: UTF-8 read as Latin-1`)
  }
})
