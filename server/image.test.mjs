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

// The wasm stage builds wasm/dist from only the files it copies, so a file build.sh or the module reads from outside
// wasm/ that it doesn't copy passes CI (which builds from the whole tree) and then fails the image build for both hosts.
test("the image's wasm stage copies every file outside wasm/ that wasm/build.sh and the module read", () => {
  const stage = read('Dockerfile').match(/^FROM [^\n]* AS wasm\n([\s\S]*?)(?=^FROM )/m)?.[1]
  assert.ok(stage, "the Dockerfile's wasm stage")
  const copied = [...stage.matchAll(/^COPY (?!--from)(.+)$/gm)].flatMap((m) => m[1].trim().split(/\s+/).filter((t) => !t.startsWith('--')).slice(0, -1))
  const has = (f) => copied.some((c) => f === c || f.startsWith(c.replace(/\/?$/, '/')))
  const wasm = new URL('wasm/', root)
  const outside = (from, rel) => new URL(rel, from).pathname.slice(root.pathname.length)
  const needed = [...read('wasm/build.sh').matchAll(/(?<=\s)\.\.\/[^\s;|&)"']+/g)].map((m) => outside(wasm, m[0]))
  const src = new URL('wasm/src/', root)
  for (const f of readdirSync(src, { recursive: true }).filter((f) => f.endsWith('.rs'))) {
    const file = new URL(f, src)
    for (const m of readFileSync(file, 'utf8').matchAll(/include_(?:str|bytes)!\("([^"]+)"\)/g)) needed.push(outside(file, m[1]))
  }
  assert.ok(needed.some((f) => f.startsWith('public/')), 'build.sh copies files from public/')
  for (const f of needed.filter((f) => !f.startsWith('wasm/'))) assert.ok(has(f), `wasm/build.sh or the module reads ${f}, which the Dockerfile's wasm stage doesn't copy`)
})
