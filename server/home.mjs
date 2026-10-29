// The home page as a signed-out visitor first sees it: the app's shell around the trending feed, as plain HTML inside
// #app, in the app's own markup (src/app.tsx Home, src/ui.tsx CastCard), so it paints before the script loads and
// search engines read it. The app starts from the same casts and link previews (the JSON next to it, ui.tsx seed),
// clears #app and draws the same page in the same frame. Keep this in step with those components.
import { boxOf, castOf, castText, designId, embedLayout, isImg, isVid, LOGO, n, P, poster, safeUrl, shortUrl, sized, IMG_SIZES, spaceOf, srcsetOf, themeId, TOKENS, toUrl, viaUs, vidBoxOf, X_LOGO } from '../src/shared.ts'
import removed from '../src/removed.json' with { type: 'json' }

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const ownHosts = ['quilcast.com']
const isSpace = (c) => (c.embeds || []).some((e) => /^https:\/\/(farcaster\.xyz|warpcast\.com)\/~\/spaces\//.test(e?.url || ''))
const gone = (c) => removed.fids.includes(c.author?.fid) || removed.casts.includes(c.hash)
/** Trending as the app keeps it (app.tsx trendy, minus casts taken down for everyone). */
// the app's "Show more" goes under text its 10-line fold cuts (ui.tsx Folded); this runs right after each cast's text
// is parsed, before it can paint. Its hash is in the CSP (server/index.mjs).
export const FOLD = `(function(s){var p=s.previousElementSibling;p.scrollHeight>p.clientHeight+1&&s.insertAdjacentHTML('beforebegin','<button class="show-more">Show more</button>')})(document.currentScript)`
export const trending = (casts) => casts.filter((c) => c?.author && /^[0-9a-fx]+$/i.test(c.hash || '') && !c.parent_hash && !isSpace(c) && !gone(c))

// what the page carries for the app leaves out the accounts' addresses, which no card shows (the feed's own load
// brings the full casts a moment later)
const OUT = ['verified_addresses', 'verifications', 'custody_address', 'auth_addresses']
const leanUser = (u) => u && Object.fromEntries(Object.entries(u).filter(([k]) => !OUT.includes(k)))
export const lean = (c) => ({ ...c, author: leanUser(c.author), mentioned_profiles: c.mentioned_profiles?.map(leanUser) })

const urlsOf = (c) => (c.embeds || []).flatMap((e) => safeUrl(e?.url) ?? [])
const ownPath = (u) => {
  const x = u && new URL(u)
  return x && ownHosts.includes(x.host) ? x.pathname : ''
}
const linked = (u) => castOf(ownPath(safeUrl(u)))
const quotesOf = (c) => [...new Set([...(c.embeds || []).flatMap((e) => (/^(0x)?[0-9a-f]{40}$/i.test(e?.cast_id?.hash || '') ? [e.cast_id.hash.replace(/^0x/, '').toLowerCase()] : [])), ...urlsOf(c).flatMap((u) => linked(u) || [])])]
const linksOf = (c) => urlsOf(c).filter((u) => !isImg(u) && !isVid(u) && !linked(u) && !spaceOf(u))

/** What the cards need beforehand (ui.tsx warm): link previews, quoted casts and lone images' sizes. */
export function wants(casts) {
  const links = new Set(), quotes = new Set(), lone = new Set()
  for (const c of casts) {
    const imgs = urlsOf(c).filter(isImg)
    if (imgs.length === 1) lone.add(sized(imgs[0], 'w=1200'))
    // a video's shape is its poster's (ui.tsx warm)
    for (const u of urlsOf(c)) if (isVid(u) && poster(u)) lone.add(u)
    for (const u of linksOf(c)) {
      const path = ownPath(u)
      if (!/^\/(design|theme)\//.test(path)) links.add(u)
    }
    for (const h of quotesOf(c)) quotes.add(h)
  }
  return { links: [...links], quotes: [...quotes], lone: [...lone] }
}

const uname = (u) => (u.username && !u.username.startsWith('fid:') ? u.username : undefined)
const handle = (u) => uname(u) || `!${u.fid}`
const nameOf = (u) => u.display_name || handle(u)
const userPath = (u) => `/u/${uname(u) || u.fid}`
const channelOf = (u) => u?.match(/(?:warpcast\.com|farcaster\.xyz)\/~\/channel\/([^/?#]+)/)?.[1]
const plural = (x, one, many) => `${n(x)} ${x === 1 ? one : many}`

/** The page's #app contents and the stylesheet for its sizes (the CSP allows no style attributes), from `d`:
 *  { casts, got: { 'u:<url>': preview, 'c:<hash>': cast }, shapes: { <url>: [w, h] } }. */
export function body(d, version, now = Date.now()) {
  const rules = new Map()
  // the app sets these sizes as style attributes; here they are classes in a <style> the page's CSP lets in by hash
  const cls = (decl) => rules.get(decl) || (rules.set(decl, `s${rules.size}`), rules.get(decl))
  const ago = (t) => {
    const s = (now - new Date(t).getTime()) / 1000
    if (s < 60) return 'now'
    if (s < 3600) return `${Math.floor(s / 60)}m`
    if (s < 86400) return `${Math.floor(s / 3600)}h`
    if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`
    return new Date(t).toLocaleDateString('en', { month: 'short', day: 'numeric', year: s > 300 * 86400 ? 'numeric' : undefined, timeZone: 'UTC' })
  }
  const icon = (d, size = 18, fill = false) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="${fill ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"></path></svg>`
  const logo = (size) => `<svg viewBox="0 0 32 32" width="${size}" height="${size}" aria-hidden="true"><rect width="32" height="32" rx="9" fill="var(--accent)"></rect><path d="${LOGO}" fill="#fff"></path></svg>`
  // `set`: the picture's srcset (ui.tsx Media). The page's first picture, the largest thing on a phone's first screen
  // (when it's in the first two casts, else it's further down), comes ahead of the rest and through quilcast.com
  // (shared.ts viaUs), over the page's own connection; `lead` tells the app to ask for it the same way, `meta` the
  // head's script to ask for it first (index.html). Still lazy: a browser with its own account never shows this page. `low`: a link preview's pictures (other sites', often huge
  // for their box) come after the casts' own (ui.tsx Img)
  let first = true
  let lead = null
  let meta = ''
  const img = (src, k = '', set, low) => {
    const top = set && first && (first = false, true)
    if (top) (lead = src), (src = viaUs(src)), (set = viaUs(set)), (meta = `<meta name="quilcast:lead" content="${esc(set)}" data-sizes="${IMG_SIZES}">`)
    // the others wait (data-src) until the first one is on screen: index.html's head script lets them load then
    const at = top ? '' : 'data-'
    return `<img${k ? ` class="${k}"` : ''} alt="" loading="lazy"${top ? ' fetchpriority="high"' : low ? ' fetchpriority="low"' : ''} referrerpolicy="no-referrer" ${at}src="${esc(src.replace(/^http:\/\//i, 'https://'))}"` +
      `${set ? ` ${at}srcset="${esc(set)}" sizes="${IMG_SIZES}"` : ''}>`
  }
  const rich = (text, k = 'text') => `<p class="${k}" dir="auto">${text.split(TOKENS).map((p, i) => {
    if (i % 2 === 0) return esc(p)
    if (p[0] === '@') return `<a href="/u/${esc(p.slice(1))}">${esc(p)}</a>`
    if (p[0] === '/') return `<span class="chan-ref">${esc(p)}</span>`
    const u = safeUrl(toUrl(p))
    return u ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer nofollow">${esc(shortUrl(p))}</a>` : esc(p)
  }).join('')}</p>`
  const avatar = (u, size = 40, link = true) => {
    const pfp = safeUrl(u.pfp_url)
    // `low`: after the casts' pictures (avatars come from the CDN's own connection, and are the smallest thing here)
    const inner = pfp ? img(sized(pfp, 'anim=false,w=144'), '', '', true) : `<span>${esc([...(u.display_name || u.username || '?')][0])}</span>`
    const k = cls(`width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px`)
    return link ? `<a class="avatar ${k}" href="${esc(userPath(u))}" aria-label="${esc(nameOf(u))}">${inner}</a>` : `<span class="avatar ${k}">${inner}</span>`
  }
  const media = (given, images) => {
    const urls = given.flatMap((u) => safeUrl(u) ?? [])
    const imgs = images ? urls : urls.filter(isImg)
    const shown = imgs.slice(0, 4)
    const shape = boxOf(shown.length === 1 ? d.shapes[sized(shown[0], 'w=1200')] : null)
    const box = shape ? cls(shape) : ''
    return (imgs.length ? `<div class="imgs n${shown.length}">${shown.map((u, i) => `<button class="img" aria-label="Open image ${i + 1} of ${imgs.length}">${img(sized(u, 'w=1200'), box, (shape || shown.length > 1) && srcsetOf(u))}${i === 3 && imgs.length > 4 ? `<span class="more-imgs">+${imgs.length - 4}</span>` : ''}</button>`).join('')}</div>` : '') +
      // as Chrome and Safari draw it (they play HLS themselves); Firefox's app swaps in its play button
      urls.filter(isVid).map((u) => `<div class="vid${vidBoxOf(d.shapes[u]) ? ` shaped ${cls(vidBoxOf(d.shapes[u]))}` : ''}"><video src="${esc(u)}"${poster(u) ? ` data-poster="${esc(poster(u))}"` : ''} controls="" preload="none" playsinline=""></video></div>`).join('')
  }
  const quote = (hash) => {
    const c = d.got[`c:${hash}`]
    if (!c) return '<div class="quote skeleton"></div>'
    if (gone(c)) return '<div class="quote muted">Hidden by your mutes.</div>'
    const urls = urlsOf(c)
    const thumb = urls.find(isImg) || poster(urls.find(isVid))
    const text = castText(c).trim()
    return `<a class="quote" href="/c/${esc(c.hash)}"><div class="meta">${avatar(c.author, 18, false)}<b>${esc(nameOf(c.author))}</b><span>@${esc(handle(c.author))} · ${ago(c.timestamp)}</span></div>` +
      `<div class="qbody${text ? '' : ' bare'}">${text ? rich(text, 'text clamp') : ''}${thumb ? img(sized(thumb, 'w=1200'), 'qimg') : ''}</div></a>`
  }
  const tweet = (t) => {
    const video = safeUrl(t.video)
    const av = safeUrl(t.author?.avatar)
    return `<div class="tweet" role="link" tabindex="0"><div class="tw-head">${av ? img(av, 'tw-av', '', true) : ''}<b>${esc(t.author?.name)}</b>` +
      `<svg class="tw-x" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="${X_LOGO}" fill="currentColor"></path></svg><span class="handle">@${esc(t.author?.handle)}</span>` +
      `${t.at ? `<span class="handle tw-at">· ${ago(t.at * 1000)}</span>` : ''}</div>` +
      (t.text ? rich(t.text.replace(/\s*https:\/\/t\.co\/\S+$/, ''), 'text tw-text') : '') + (t.photos?.length ? media(t.photos) : '') +
      (!t.photos?.length && video ? `<div class="tw-video">${img(video, '', '', true)}<span class="play">${icon(P.play, 24, true)}</span></div>` : '') +
      (t.quote ? `<div class="tw-quote"><b>${esc(t.quote.name)}</b> <span class="handle">@${esc(t.quote.handle)}</span><p>${esc(t.quote.text)}</p></div>` : '') +
      `<div class="tw-stats"><span>${plural(t.replies || 0, 'reply', 'replies')}</span><span>${plural(t.reposts || 0, 'repost', 'reposts')}</span><span>${plural(t.likes || 0, 'like', 'likes')}</span></div></div>`
  }
  const link = (u) => {
    const path = ownPath(u)
    if ((/^\/design\//.test(path) && designId(path)) || (/^\/theme\//.test(path) && themeId(path))) return '<div class="quote skeleton"></div>'
    if (castOf(path)) return quote(castOf(path))
    const p = d.got[`u:${u}`]
    if (p?.tweet) return tweet(p.tweet)
    const image = safeUrl(p?.image)
    if (image && p.image === p.url) return media([image], true)
    const ico = safeUrl(p?.icon)
    return `<a class="linkcard${image ? ' big' : ''}" href="${esc(u)}" target="_blank" rel="noopener noreferrer nofollow">${image ? img(sized(image, 'w=1200'), 'lc-img', '', true) : ''}` +
      `<span class="lc-text"><span class="lc-site">${ico ? img(ico, '', '', true) : ''}${esc(new URL(u).hostname.replace(/^www\./, ''))}</span>` +
      `${p?.title ? `<b class="lc-title">${esc(p.title)}</b>` : ''}${p?.description ? `<span class="lc-desc">${esc(p.description)}</span>` : ''}</span>${p?.button ? `<span class="lc-btn">${esc(p.button)}</span>` : ''}</a>`
  }
  const space = (id) => `<a class="space-card" href="/spaces/${esc(id)}"><span class="space-card-top">${icon(P.mic)}<small>Space</small></span><b>Live audio Space</b><small>Listen on Quilcast</small></a>`
  const embeds = (c) => {
    const urls = urlsOf(c)
    const spaces = [...new Set(urls.flatMap((u) => spaceOf(u) || []))]
    const links = linksOf(c)
    const cards = spaces.map(space).join('') + links.map(link).join('')
    const { strip, compact } = embedLayout(urls, spaces.length + links.length)
    return (strip ? `<div class="strip">${media(urls)}</div>` : media(urls)) + (compact ? `<div class="cards">${cards}</div>` : cards) + quotesOf(c).map(quote).join('')
  }
  const count = (x) => `<span>${x ? n(x) : ''}</span>`
  const cast = (c) => {
    const ch = channelOf(c.parent_url)
    return `<article class="cast" data-href="/c/${esc(c.hash)}"><div class="rail">${avatar(c.author)}</div><div class="body"><header>` +
      `<a class="name" href="${esc(userPath(c.author))}">${esc(nameOf(c.author))}</a><span class="handle">@${esc(handle(c.author))}</span><span class="dot">·</span>` +
      `<time datetime="${esc(c.timestamp)}">${ago(c.timestamp)}</time>${ch ? `<span class="chan">/${esc(ch)}</span>` : ''}</header>` +
      `<div>${rich(castText(c), 'text fold')}<script>${FOLD}</script></div>${embeds(c)}` +
      `<footer><button class="act" aria-label="Reply">${icon(P.reply)}${count(c.replies?.count)}</button>` +
      `<span class="wrap-menu"><button class="act rc" aria-label="Recast or quote" aria-haspopup="menu">${icon(P.recast)}${count(c.reactions?.recasts_count)}</button></span>` +
      `<button class="act lk" aria-label="Like">${icon(P.like)}${count(c.reactions?.likes_count)}</button><button class="act" aria-label="Share">${icon(P.share)}</button>` +
      `<span class="wrap-menu"><button class="act" aria-label="More" aria-haspopup="menu">${icon(P.more)}</button></span></footer></div></article>`
  }
  const cards = d.casts.map((c, i) => ((first &&= i < 2), cast(c))).join('')
  const nav = [['/', 'Home', P.home], ['/search', 'Search', P.search], ['/join', 'Join', P.user], ['/settings', 'Settings', P.gear]]
  const ico = (p) => `<span class="ico">${icon(p, 22)}</span>`
  // the page can paint before it has all arrived, so whatever sits beside or over the column comes before it, and the
  // column (the casts) last, growing downwards; .ssr-home .extra's order puts the aside back on the right
  const html = `<div class="app ssr-home"><nav class="side" aria-label="Main"><a class="brand" href="/">${logo(30)}<span>Quilcast</span></a>` +
    nav.filter(([h]) => h !== '/join').map(([h, label, p]) => `<a class="navlink${h === '/' ? ' on' : ''}" href="${h}">${ico(p)}<span>${label}</span></a>`).join('') +
    `<a class="btn cast-btn" href="/join" aria-label="Join">${icon(P.user)}<span>Join</span></a></nav>` +
    `<aside class="extra"><a class="searchbox" href="/search">${icon(P.search, 16)}<span>Search people and casts</span></a><div class="about"><b>About Quilcast</b>` +
    `<p>A small, open Farcaster client that reads from and posts to Quilibrium's Hypersnap network, with your keys kept in your browser.</p>` +
    `<p class="foot">v${esc(version)} · <a href="https://github.com/backmeupplz/quilcast" target="_blank" rel="noopener">Source</a></p><p class="foot ogre-only"><a href="/shrek/credits.html" target="_blank">Shrek credits</a></p></div></aside>` +
    `<nav class="tabbar" aria-label="Main">${nav.map(([h, label, p]) => `<a class="${h === '/' ? 'on' : ''}" href="${h}" aria-label="${label}">${ico(p)}</a>`).join('')}</nav>` +
    `<main class="col"><div class="phead"><div class="phead-row"><a class="brand only-mobile" href="/" aria-label="Quilcast home">${logo(26)}</a><h1>Home</h1></div></div>` +
    `<div class="banner"><div><b>Farcaster without the middlemen</b><p>Quilcast talks straight to the Hypersnap network, and your keys never leave this browser.</p></div><a class="btn small" href="/join">Join</a></div>` +
    `${cards}<div></div></main></div>`
  // with no first picture to wait for, nothing waits
  return { html: lead ? html : html.replace(/ data-(src|srcset|poster)=/g, ' $1='), css: [...rules].map(([decl, k]) => `#app .${k}{${decl}}`).join(''), lead, meta }
}
