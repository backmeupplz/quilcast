// Runs after `vite build` (npm run build): writes dist/build.json, the build's fingerprint for scripts/verify.mjs.
// It holds the SHA-256 of every file in dist/ the server sends as it is (all but the HTML, which the server fills in per
// page) and of the inline scripts its pages may run, the ones its CSP allows by hash: index.html's head script and the
// home page's "Show more" (server/home.mjs FOLD). The build is the same on any machine (a Mac's matches the Dockerfile's),
// so anyone can rebuild a commit and compare.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FOLD } from '../server/home.mjs'
import { digest } from './verify.mjs'

const dist = process.argv[2] || fileURLToPath(new URL('../dist/', import.meta.url))
const sha = (b) => createHash('sha256').update(b).digest('hex')
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]))

const files = {}
const inline = new Set([sha(FOLD)])
for (const f of walk(dist).sort()) {
  const path = '/' + relative(dist, f).split(sep).join('/')
  // macOS's Finder litters folders with .DS_Store, which a clean checkout doesn't have
  if (path === '/build.json' || path.endsWith('/.DS_Store')) continue
  // the same inline scripts the server finds (server/index.mjs INLINE_JS); typed ones (JSON-LD) never run
  if (path.endsWith('.html')) for (const [, js] of readFileSync(f, 'utf8').matchAll(/<script>([^<]*)<\/script>/g)) inline.add(sha(js))
  else files[path] = sha(readFileSync(f))
}
const build = { version: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version, files, inline: [...inline].sort() }
writeFileSync(join(dist, 'build.json'), JSON.stringify({ build: digest(build), ...build }, null, 1) + '\n')
console.log(`dist/build.json: build ${digest(build)}, ${Object.keys(files).length} files, ${inline.size} inline scripts`)
