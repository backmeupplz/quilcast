// The built stylesheet keeps the unprefixed backdrop-filter next to the -webkit- one. lightningcss drops a
// backdrop-filter that a -webkit-backdrop-filter follows, and Chrome (the web, the Android app's WebView) reads only
// the unprefixed one: the tab bar and the header lost their blur there (#240).
// Needs a build (dist/): npm run build && npm test
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { test } from 'node:test'

const dir = new URL('../dist/assets/', import.meta.url)
const css = (await Promise.all((await readdir(dir)).filter((f) => f.endsWith('.css')).map((f) => readFile(new URL(f, dir), 'utf8')))).join('\n')
// [selector, declarations] of every innermost rule of the minified CSS
const rules = [...css.matchAll(/([^{}]*)\{([^{}]*)\}/g)].map((m) => [m[1].trim(), m[2]])
const unprefixed = (decls) => decls.match(/(?:^|;)backdrop-filter:([^;]*)/)?.[1]

test('every -webkit-backdrop-filter in the build has an unprefixed backdrop-filter', () => {
  const withPrefix = rules.filter(([, d]) => /-webkit-backdrop-filter:/.test(d))
  assert.ok(withPrefix.length >= 4)
  for (const [sel, d] of withPrefix) assert.equal(unprefixed(d), d.match(/-webkit-backdrop-filter:([^;]*)/)[1], sel)
})

test('the tab bar and the page header blur in the build', () => {
  const blur = (sel) => rules.filter(([s]) => s.split(',').includes(sel)).map(([, d]) => unprefixed(d)).filter(Boolean)
  assert.ok(blur('.tabbar').some((v) => /^blur\(/.test(v)), '.tabbar')
  assert.ok(blur('.phead').some((v) => /blur\(/.test(v)), '.phead')
})
