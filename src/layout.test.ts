// Phones get the tab bar, and from 560px (an unfolded iPhone Duo is 669 points wide, or 585 beside a strip down its
// edge) the sidebar, unless the screen is too short for the sidebar's rail (a phone on its side): every rule that tells
// them apart, in the styles and in miniapp.tsx, has to draw the line in the same place, or a size in between gets half of
// each layout.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8')
const phone = '(max-width: 559px), (max-width: 699px) and (max-height: 599px)'
const wide = '(min-width: 700px), (min-width: 560px) and (min-height: 600px)'

test('the phone layout ends in the same place everywhere', () => {
  const css = read('./style.css')
  const count = (q: string) => css.split(`@media ${q} {`).length - 1
  assert.ok(count(phone) >= 9, 'the tab bar and what sits around it switch together')
  assert.ok(count(wide) >= 5, 'and so does what sits beside the sidebar')
  const rest = css.split(`@media ${phone} {`).join('').split(`@media ${wide} {`).join('')
  const widths = [...rest.matchAll(/\((max|min)-width: (\d+)px\)/g)].map(([, edge, px]) => Number(px) + (edge === 'min' ? -1 : 0))
  // (600px is where dialogs fill the screen)
  assert.deepEqual(widths.filter((w) => w > 500 && w < 1099 && w !== 600), [], 'no other line between a phone and the sidebar')
  assert.ok(read('./miniapp.tsx').includes(`const narrow = () => matchMedia('${phone}').matches`))
})
