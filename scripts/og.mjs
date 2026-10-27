// Share cards (1200×630) for the standalone pages (About and the legal pages), in Quilcast's look: the dark page
// with the purple glow, the feather icon, the page's title and one line about it. Renders each card with headless
// Chrome's own --screenshot and writes public/og-<page>.png; each page's og:image and twitter:image point at it.
// Usage: node scripts/og.mjs   (Chrome from CHROME_PATH or the usual places; commit the images it writes)
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const PAGES = [
  { file: 'about', title: 'About Quilcast', line: 'A small, open-source Farcaster client that talks straight to Hypersnap from your browser.' },
  { file: 'privacy', title: 'Privacy Policy', line: 'No accounts, no ads, no analytics. Here is everything that leaves your device.', glyph: '🔒' },
  { file: 'terms', title: 'Terms of Use', line: 'The rules for using Quilcast on the web and in the Quilcast apps.', glyph: '📜' },
  { file: 'safety', title: 'Child Safety Standards', line: 'Zero tolerance for child sexual abuse and exploitation on Quilcast.', glyph: '🛡️' },
  { file: 'delete', title: 'Delete your data', line: 'Quilcast has no accounts of its own. Here is how to remove what it keeps.', glyph: '🗑️' },
]

const chrome = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((f) => f && existsSync(f))
if (!chrome) throw new Error('No Chrome found: set CHROME_PATH')

const icon = `data:image/svg+xml;base64,${readFileSync('public/favicon.svg').toString('base64')}`
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
// About shows two casts, like the main card (public/og.png); the legal pages show a glyph
const casts = `<div class="casts">
  <div class="cast"><i style="background:linear-gradient(135deg,#ff9a6b,#ff5f8a)"></i><div><b>ada</b> <span>@ada · 2m</span>
    <p>Just cast this from a plain browser tab. The keys never left my laptop.</p><small>12 replies · 48 recasts · ♥ 310</small></div></div>
  <div class="cast"><i style="background:linear-gradient(135deg,#6bc5ff,#5b3df5)"></i><div><b>quill</b> <span>@quill · 5m</span>
    <p>Hypersnap node, a phrase and twenty cents of ETH on Optimism. That's the whole setup.</p><small>4 replies · 9 recasts · ♥ 87</small></div></div>
</div>`
const card = (p) => `<!doctype html><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0 }
  html, body { width: 1200px; height: 630px; overflow: hidden }
  body { color: #f3f2f8; font-family: Inter, -apple-system, "SF Pro Display", system-ui, sans-serif;
    background: radial-gradient(720px 540px at 88% 8%, rgba(91,61,245,.42), transparent 70%), radial-gradient(620px 520px at 0% 105%, rgba(91,61,245,.22), transparent 70%), #0b0a10 }
  main { position: absolute; inset: 0; padding: 72px 80px; display: flex; flex-direction: column; width: 720px }
  .icon { width: 88px; height: 88px; border-radius: 24px; box-shadow: 0 0 64px rgba(91,61,245,.6) }
  h1 { margin-top: auto; font-size: 80px; line-height: 1.02; letter-spacing: -2.5px; font-weight: 800 }
  main p { margin-top: 22px; font-size: 31px; line-height: 1.35; color: #bdbacb }
  .url { margin-top: 30px; font-size: 28px; font-weight: 650; color: #9d8cff }
  .glyph { position: absolute; right: 108px; top: 165px; width: 300px; height: 300px; border-radius: 72px; display: flex; align-items: center;
    justify-content: center; font-size: 136px; background: linear-gradient(160deg, #1d1a28, #131119); border: 1px solid #2b2839; box-shadow: 0 30px 80px rgba(0,0,0,.5) }
  .casts { position: absolute; right: -24px; top: 92px; width: 470px; display: flex; flex-direction: column; gap: 26px }
  .cast { display: flex; gap: 16px; padding: 22px 24px; border-radius: 22px; background: #17151f; border: 1px solid #2b2839; box-shadow: 0 24px 60px rgba(0,0,0,.45) }
  .cast:first-child { transform: rotate(-3deg) } .cast:last-child { transform: rotate(2deg); margin-left: 40px }
  .cast i { flex: none; width: 46px; height: 46px; border-radius: 50% }
  .cast b { font-size: 21px } .cast span { color: #8f8ca0; font-size: 19px }
  .cast p { margin: 6px 0 10px; font-size: 21px; line-height: 1.35 } .cast small { color: #8f8ca0; font-size: 17px }
</style><main>
  <img class="icon" src="${icon}" alt="">
  <h1>${esc(p.title)}</h1>
  <p>${esc(p.line)}</p>
  <div class="url">quilcast.com/${p.file}</div>
</main>${p.glyph ? `<div class="glyph">${p.glyph}</div>` : casts}`

for (const p of PAGES) {
  const out = resolve(`public/og-${p.file}.png`)
  execFileSync(chrome, ['--headless=new', '--hide-scrollbars', '--force-device-scale-factor=1', '--window-size=1200,630',
    `--screenshot=${out}`, `data:text/html;base64,${Buffer.from(card(p)).toString('base64')}`], { stdio: 'ignore' })
  console.log(`public/og-${p.file}.png`)
}
