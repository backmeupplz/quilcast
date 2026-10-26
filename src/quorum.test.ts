// Quorum mode restyles every page, and with it off Quilcast has to look exactly as before: every rule in style.css's
// Quorum sections must only reach the page under :root[data-quorum], or through markup only Quorum mode draws (q-*).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

/** Each style rule's selector chain (outer @media/@supports preludes and nesting parents included), in order. */
function rules(css: string) {
  const out: string[][] = []
  const stack: string[] = []
  let buf = ''
  for (const ch of css.replace(/\/\*[\s\S]*?\*\//g, '')) {
    if (ch === '{') stack.push(buf.trim()), (buf = '')
    else if (ch === '}') {
      // a block with declarations of its own (or none at all) is a rule; keyframes' steps aren't selectors
      if (buf.includes(':') || !buf.trim()) if (!stack.some((s) => s.startsWith('@keyframes'))) out.push([...stack])
      stack.pop()
      buf = ''
    } else if (ch === ';' && !stack.length) buf = ''
    else buf += ch
  }
  return out.filter((chain) => !chain.at(-1)!.startsWith('@'))
}

/** A selector list's selectors (commas inside :is(), :has() and the like don't split it). */
function split(list: string) {
  const out = ['']
  let depth = 0
  for (const ch of list) {
    depth += ch === '(' ? 1 : ch === ')' ? -1 : 0
    if (ch === ',' && !depth) out.push('')
    else out[out.length - 1] += ch
  }
  return out.map((s) => s.trim())
}

/** The selector without its :not(…) parts: what's inside one says where a rule does *not* apply. */
function bare(sel: string) {
  let out = ''
  for (let i = 0; i < sel.length; i++) {
    if (!sel.startsWith(':not(', i)) {
      out += sel[i]
      continue
    }
    let depth = 0
    for (i += 4; i < sel.length; i++) if ((depth += sel[i] === '(' ? 1 : sel[i] === ')' ? -1 : 0) === 0) break
  }
  return out
}

// markup only Quorum mode renders: q-* classes, and the expand button that's only in its mini app title bar;
// #wallets is only a scroll margin for the Settings link the docked wallet has
const scoped = (sel: string) => {
  const s = bare(sel)
  return s.includes('[data-quorum]') || /\.q-[a-z]/.test(s) || /\.only-wide\b/.test(s) || s === '#wallets'
}
/** The rules that could reach the page with Quorum mode off. */
const loose = (css: string) =>
  rules(css).filter((chain) => {
    const own = chain.filter((s) => !s.startsWith('@'))
    // a nested rule is scoped when its parent is; otherwise each selector in its list has to be
    if (own.length > 1 && own.slice(0, -1).some(scoped)) return false
    return !split(own.at(-1)!).every(scoped)
  }).map((c) => c.join(' > '))

const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8')
const quorum = css.slice(css.indexOf('/* ---------- Quorum mode (Settings)'))

test('style.css has its Quorum sections, and the checker sees their rules', () => {
  const all = rules(quorum)
  assert.ok(all.length > 200, `only ${all.length} rules found`)
  assert.ok(all.some((c) => c.join(' ').includes('.q-msg')))
  assert.ok(all.some((c) => c.join(' ').includes('.btn')))
})

test('the checker flags rules that would apply with Quorum mode off', () => {
  const css = `.btn { a: b } :root:not([data-quorum]) .btn { a: b } .btn:not(.q-x) { a: b } @media (x) { .tabbar a { a: b } }
    .q-a, .btn { a: b } :root[data-quorum] .ok { a: b } :where(:root[data-quorum]) { & .ok { a: b } } .q-ok :is(a, b) { a: b }
    @keyframes q-x { from { opacity: 0 } }`
  assert.deepEqual(loose(css), ['.btn', ':root:not([data-quorum]) .btn', '.btn:not(.q-x)', '@media (x) > .tabbar a', '.q-a, .btn'])
})

test('every Quorum mode rule is scoped to Quorum mode, so Quilcast is unchanged with it off', () => {
  assert.deepEqual(loose(quorum), [])
})
