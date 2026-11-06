import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'

export default defineConfig({
  // modules keep the path they're found at, so the build is the same wherever node_modules really is: CI's Mac runner
  // links it in from its cache, and following that link put the chunks' preload lists in another order than the
  // Dockerfile's build, which a reproducible build (README "Verify this build") can't have
  resolve: { preserveSymlinks: true },
  // uploads are served by `PORT=3311 npm start`; the dev server forwards to it
  server: { proxy: { '/api': 'http://localhost:3311', '/m/': 'http://localhost:3311' } },
  define: { __VERSION__: JSON.stringify(JSON.parse(readFileSync('package.json', 'utf8')).version) },
})
