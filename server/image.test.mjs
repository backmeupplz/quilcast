// The runtime image holds only the src/ files the Dockerfile copies, so a server import of any other src/ file
// passes every test here and then stops the deployed server from starting.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'

const root = new URL('..', import.meta.url)
const read = (p) => readFileSync(new URL(p, root), 'utf8')

test('the image copies every src/ file the server and the files it imports from src/ import', () => {
  const copied = read('Dockerfile').match(/cp -r (src\/[^&\n]*?) \/out\/src\//)?.[1].split(/\s+/)
  assert.ok(copied, 'the Dockerfile copy of src/ files')
  const has = (f) => copied.some((c) => f === c || f.startsWith(c.replace(/\/?$/, '/')))
  const imports = (file, text) =>
    [...text.matchAll(/(?:from|import\()\s*['"](\.{1,2}\/[^'"]+)['"]/g)].map((m) => new URL(m[1], new URL(file, root)).pathname.slice(root.pathname.length))
  const todo = readdirSync(new URL('server', root)).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs')).map((f) => `server/${f}`)
  const seen = new Set()
  while (todo.length) {
    const file = todo.pop()
    if (seen.has(file)) continue
    seen.add(file)
    // a whole folder (src/locales/) is imported by name at runtime
    for (const dep of imports(file, file.endsWith('/') ? '' : read(file))) {
      if (!dep.startsWith('src/')) continue
      assert.ok(has(dep), `${file} imports ${dep}, which the Dockerfile doesn't copy into the image`)
      if (/\.(ts|mjs|js)$/.test(dep)) todo.push(dep)
    }
  }
})
