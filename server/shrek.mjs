// Ogre mode's GIFs (src/ogre.ts, src/style.css): a pool read from Tenor's Shrek searches when the server starts and
// every 6 hours. The page asks for /shrek/<slot>, which redirects to a random one each time.
import { safeGet, UA } from './net.mjs'

const SEARCHES = ['shrek', 'shrek-dancing', 'shrek-meme', 'shrek-funny', 'shrek-roar']

// what ogre mode shipped with, for when Tenor can't be reached
let pool = [
  { url: 'https://media.tenor.com/qcv-b7FwOSkAAAA1/shrek-dancing.webp', page: 'https://tenor.com/view/shrek-dancing-gif-12235152568353831209', title: 'Shrek dancing' },
  { url: 'https://media.tenor.com/z_BAugpQD-8AAAA1/shrek-shrek-meme.webp', page: 'https://tenor.com/view/shrek-shrek-meme-butterfly-peace-peacefull-gif-14983547128042754031', title: 'Shrek with butterflies' },
  { url: 'https://media.tenor.com/FYo0d-3JCz8AAAAx/roar-breathe.webp', page: 'https://tenor.com/view/roar-breathe-shrek-shrek-meme-angry-gif-1552110711277685567', title: 'Shrek roaring' },
]
export const pick = () => pool[Math.floor(Math.random() * pool.length)].url

/** The GIFs in one Tenor search page, which carries its results as JSON in a store-cache script. */
const results = (html) => {
  const json = html.match(/<script id="store-cache"[^>]*>([\s\S]*?)<\/script>/)?.[1]
  if (!json) return []
  return Object.values(JSON.parse(json).universal?.search || {}).flatMap((s) => s.results || [])
}
const TENOR = /^https:\/\/media\d?\.tenor\.com\//

/** The animated Shrek GIFs in one Tenor search page. */
export function parse(html) {
  return results(html).flatMap((g) => {
    const desc = String(g.content_description || '').toLowerCase()
    const f = g.media_formats || {}
    // a still image is a few KB of webp; skip other characters and anything heavy for a corner of the page
    const webp = [f.webp, f.tinywebp].find((x) => x?.size > 40e3 && x.size < 1.2e6 && TENOR.test(x.url))
    // and caption memes ("… says …"): random text on the page could say anything
    if (!webp || !desc.includes('shrek') || /donkey|fiona|baby|woman|man |girl|boy|says|saying|words|written|text/.test(desc)) return []
    return [{ url: webp.url, page: g.itemurl, title: g.content_description }]
  })
}

/** Profile looks' GIF picker (src/looks.tsx): one Tenor search page, as { url, preview, w, h }; the GIF itself
 *  stays under 4 MB, the size profile looks take (server/looks.mjs). `stickers` searches Tenor's stickers, which
 *  have see-through backgrounds. */
export async function gifs(q, stickers = false) {
  const r = await safeGet(`https://tenor.com/search/${encodeURIComponent(q.replace(/\s+/g, '-'))}-gifs${stickers ? '?format=stickers' : ''}`, { max: 4e6, timeout: 10e3, headers: { 'user-agent': UA } })
  // a failure throws, so the search isn't cached and gets tried again
  if (r.status !== 200) throw new Error(`tenor ${r.status}`)
  return results(r.body.toString()).flatMap((g) => {
    const f = g.media_formats || {}
    const big = (stickers ? [f.webp_transparent, f.gif_transparent] : [f.webp, f.gif]).find((x) => x?.size < 4e6 && TENOR.test(x.url))
    const small = (stickers ? [f.tinywebp_transparent, f.tinygif_transparent] : [f.tinywebp, f.tinygif]).find((x) => x?.url && TENOR.test(x.url))
    return big && small ? [{ url: big.url, preview: small.url, w: big.dims?.[0] || 1, h: big.dims?.[1] || 1, title: String(g.content_description || '').slice(0, 100) }] : []
  })
}

/** Refill the pool from Tenor; keeps the old one if Tenor fails. */
export async function refresh() {
  const pages = await Promise.allSettled(SEARCHES.map((q) => safeGet(`https://tenor.com/search/${q}-gifs`, { max: 4e6, timeout: 10e3, headers: { 'user-agent': UA } })))
  const seen = new Set()
  const found = pages.flatMap((p) => (p.status === 'fulfilled' && p.value.status === 200 ? parse(p.value.body.toString()) : [])).filter((g) => !seen.has(g.url) && seen.add(g.url))
  if (found.length < 3) return console.error('shrek: Tenor gave', found.length, 'GIFs, keeping the old ones')
  pool = found
}

/** Credits for everything ogre mode may show. */
export const credits = () => `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Shrek credits · Quilcast</title>
<h1>Shrek credits</h1>
<p>Ogre mode on Quilcast embeds GIFs from <a href="https://tenor.com">Tenor</a>, a random one from this list each time; they load from Tenor's servers. Shrek is a character of DreamWorks Animation; this is a fan homage, not affiliated with or endorsed by DreamWorks.</p>
<ul>
  <li><a href="https://tenor.com/view/shrekerutuf-transparentshrek-greenshrektransparent-skibdiohioshreksigma-gif-3081716645127001146">Shrek's face</a> (logo, like button, background)</li>
${pool.map((g) => `  <li><a href="${esc(g.page)}">${esc(g.title)}</a></li>`).join('\n')}
  <li><a href="https://www.youtube.com/watch?v=L_jWHffIx5E">Smash Mouth - All Star</a>, the official video, played in YouTube's embedded player</li>
  <li><a href="https://commons.wikimedia.org/wiki/File:Shrek_logo.svg">Shrek logo</a>, public domain, via Wikimedia Commons</li>
</ul>
<p><a href="/">Back to Quilcast</a></p>
`
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)
