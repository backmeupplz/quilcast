// RSS 2.0 feeds of an account's casts (/u/<name>/rss) and a channel's (/channel/<id>/rss), for feed readers. Each item
// is a cast: its link and guid are its page here, its title a short cut of its text, its description the text as the
// app shows it (shared.ts markdown, links absolute) with its pictures and links below.
import { castText, isImg, markdown, taggable, unmarkdown, urlsOf } from '../src/shared.ts'
import removed from '../src/removed.json' with { type: 'json' }
import { clip, fname, nameOf } from './profile.mjs'

// what XML 1.0 can't hold at all, even escaped (most C0 controls, U+FFFE and U+FFFF, half a surrogate pair), is dropped
const BAD = /[\0-\x08\x0b\x0c\x0e-\x1f￾￿]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g
const XML = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }
/** Text (or HTML) as XML character data or an attribute value. */
export const xml = (s) => String(s ?? '').replace(BAD, '').replace(/[&<>"']/g, (c) => XML[c])
const html = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const HASH = /^(0x)?[0-9a-f]{40}$/
const handle = (u) => (fname(u) ? `@${fname(u)}` : `!${u.fid}`)

/** A cast as HTML for a reader: its text with line breaks kept (the app shows it pre-wrap), then its pictures, links and
 *  quoted casts. Links the app keeps relative (/u/…, /channel/…, /api/img?…) point at `site`. */
export function castHtml(c, site) {
  // tags as Hypersnap indexed them, from the text without its mentions put back in (ui.tsx RichText)
  const text = markdown(castText(c, true), taggable(c.text || '')).split(/(<pre[\s\S]*?<\/pre>)/).map((p, i) => (i % 2 ? p : p.replace(/\n/g, '<br>'))).join('')
  const media = urlsOf(c).map((u) => (isImg(u) ? `<p><img src="${html(u)}" alt="" referrerpolicy="no-referrer"></p>` : `<p><a href="${html(u)}">${html(u)}</a></p>`))
  const quotes = (c.embeds || []).flatMap((e) => (HASH.test(e?.cast_id?.hash) ? [`<p><a href="${site}/c/${e.cast_id.hash}">Quoted cast</a></p>`] : []))
  return (text ? `<div>${text}</div>` : '').replace(/ (href|src)="\//g, (_, a) => ` ${a}="${site}/`) + media.join('') + quotes.join('')
}

/** The <item> for a cast. */
export function item(c, site) {
  const link = `${site}/c/${c.hash}`
  const u = c.author
  const who = u?.fid ? handle(u) : ''
  const title = clip(unmarkdown(castText(c)), 100) || (who ? `A cast by ${who}` : 'A cast')
  const d = new Date(c.timestamp)
  return '<item>' +
    `<title>${xml(title)}</title><link>${xml(link)}</link><guid isPermaLink="true">${xml(link)}</guid>` +
    (isNaN(d) ? '' : `<pubDate>${d.toUTCString()}</pubDate>`) +
    (u?.fid ? `<dc:creator>${xml(nameOf(u) === who ? who : `${nameOf(u)} (${who})`)}</dc:creator>` : '') +
    `<description>${xml(castHtml(c, site))}</description></item>`
}

/** The casts a feed shows, newest first: real hashes only, nothing taken down (`gone`, removed.json), and replies only
 *  when asked for. */
export const shown = (casts, { replies = false, max = 25, gone = removed } = {}) => (casts || [])
  .filter((c) => HASH.test(c?.hash) && !gone.casts.includes(c.hash) && !gone.fids.includes(c.author?.fid) && (replies || !c.parent_hash))
  .sort((a, b) => (Date.parse(b.timestamp) || 0) - (Date.parse(a.timestamp) || 0))
  .slice(0, max)

/** A whole RSS 2.0 document. `ttl` asks readers to come back no sooner than that many minutes. */
export function rss({ title, link, self, desc, image, casts, site, ttl = 15 }) {
  const img = typeof image === 'string' && /^https:\/\//.test(image) && image.length < 1024
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel>' +
    `<title>${xml(title)}</title><link>${xml(link)}</link><description>${xml(desc)}</description>` +
    `<atom:link href="${xml(self)}" rel="self" type="application/rss+xml" /><generator>Quilcast</generator><ttl>${ttl}</ttl>` +
    (img ? `<image><url>${xml(image)}</url><title>${xml(title)}</title><link>${xml(link)}</link></image>` : '') +
    casts.map((c) => item(c, site)).join('') +
    '</channel></rss>\n'
}
