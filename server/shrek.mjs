// Ogre mode's GIFs (src/ogre.ts, src/style.css): picked at random from Tenor's Shrek searches each time the server
// starts, so every deploy brings new ones. The page asks for /shrek/<slot>, which redirects to the pick.
import { safeGet, UA } from './net.mjs'

const SEARCHES = ['shrek', 'shrek-dancing', 'shrek-meme', 'shrek-funny', 'shrek-roar']
const SLOTS = { dance: 'corner', card: 'right column', roar: 'when ogre mode turns on' }

// what ogre mode shipped with, for when Tenor can't be reached
export let picks = {
  dance: { url: 'https://media.tenor.com/qcv-b7FwOSkAAAA1/shrek-dancing.webp', page: 'https://tenor.com/view/shrek-dancing-gif-12235152568353831209', title: 'Shrek dancing' },
  card: { url: 'https://media.tenor.com/z_BAugpQD-8AAAA1/shrek-shrek-meme.webp', page: 'https://tenor.com/view/shrek-shrek-meme-butterfly-peace-peacefull-gif-14983547128042754031', title: 'Shrek with butterflies' },
  roar: { url: 'https://media.tenor.com/FYo0d-3JCz8AAAAx/roar-breathe.webp', page: 'https://tenor.com/view/roar-breathe-shrek-shrek-meme-angry-gif-1552110711277685567', title: 'Shrek roaring' },
}

/** The animated Shrek GIFs in one Tenor search page, which carries its results as JSON in a store-cache script. */
export function parse(html) {
  const json = html.match(/<script id="store-cache"[^>]*>([\s\S]*?)<\/script>/)?.[1]
  if (!json) return []
  const searches = Object.values(JSON.parse(json).universal?.search || {})
  return searches.flatMap((s) => s.results || []).flatMap((g) => {
    const desc = String(g.content_description || '').toLowerCase()
    const f = g.media_formats || {}
    // a still image is a few KB of webp; skip other characters and anything heavy for a corner of the page
    const webp = [f.webp, f.tinywebp].find((x) => x?.size > 40e3 && x.size < 1.2e6 && /^https:\/\/media\d?\.tenor\.com\//.test(x.url))
    // and caption memes ("… says …"): random text on the page could say anything
    if (!webp || !desc.includes('shrek') || /donkey|fiona|baby|woman|man |girl|boy|says|saying|words|written|text/.test(desc)) return []
    return [{ url: webp.url, page: g.itemurl, title: g.content_description }]
  })
}

/** Pick new GIFs; keeps the current ones if Tenor fails. */
export async function shuffle() {
  const pages = await Promise.allSettled(SEARCHES.map((q) => safeGet(`https://tenor.com/search/${q}-gifs`, { max: 4e6, timeout: 10e3, headers: { 'user-agent': UA } })))
  const seen = new Set()
  const pool = pages.flatMap((p) => (p.status === 'fulfilled' && p.value.status === 200 ? parse(p.value.body.toString()) : [])).filter((g) => !seen.has(g.url) && seen.add(g.url))
  if (pool.length < 3) return console.error('shrek: Tenor gave', pool.length, 'GIFs, keeping the old ones')
  const pick = () => pool.splice(Math.floor(Math.random() * pool.length), 1)[0]
  picks = { dance: pick(), card: pick(), roar: pick() }
}

/** Credits for whatever is showing right now. */
export const credits = () => `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Shrek credits · Quilcast</title>
<h1>Shrek credits</h1>
<p>Ogre mode on Quilcast embeds GIFs from <a href="https://tenor.com">Tenor</a>, picked at random from its Shrek searches each time Quilcast is deployed; they load from Tenor's servers. Shrek is a character of DreamWorks Animation; this is a fan homage, not affiliated with or endorsed by DreamWorks.</p>
<ul>
  <li><a href="https://tenor.com/view/shrekerutuf-transparentshrek-greenshrektransparent-skibdiohioshreksigma-gif-3081716645127001146">Shrek's face</a> (logo, like button, background)</li>
${Object.entries(picks).map(([slot, g]) => `  <li><a href="${esc(g.page)}">${esc(g.title)}</a> (${SLOTS[slot]})</li>`).join('\n')}
  <li><a href="https://commons.wikimedia.org/wiki/File:Shrek_logo.svg">Shrek logo</a>, public domain, via Wikimedia Commons</li>
</ul>
<p><a href="/">Back to Quilcast</a></p>
`
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)
