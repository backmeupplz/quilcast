// Farcaster Articles: FIP "Cast Format and Chained Casts" (farcasterxyz/protocol discussion 278, Snapchain's
// CastAddBody.format_version and .chain). An article is a chain of casts by one author: each says where it sits
// (`chain`: the first cast's id, its index from 0 and the number of casts) and that its text is article Markdown
// (`format_version` 1). The cast at index 0 holds the title on its first line, then an optional empty line and the
// opening; its one embed, if any, is the cover image. Each later cast holds whole blocks of text, then embeds of one
// kind. Clients that don't know articles see a thread, as each cast replies to the one before it.
//
// Hypersnap's /v2 casts carry both (`format_version`, `chain`) since farcasterorg/hypersnap#69; on a node from before,
// or a cast not read from its message (a search result), they're left out and read from the node's /v1 messages
// (castById, castsByFid).
// Shared by the app (api.ts, ui.tsx, articles.tsx) and the server (index.mjs, home.mjs, profile.mjs).
import { castText, isImg, isVid, MAX_EMBEDS, safeUrl, unmarkdown } from './shared.ts'

/** format_version 1: article Markdown (shared.ts articleHtml). */
export const ARTICLE = 1
/** MAX_CHAIN_PARTS: a chain has at most 100 casts. */
export const MAX_PARTS = 100
/** The bytes a cast's text may take without Farcaster Pro (a long cast); every part stays within it. */
export const PART_BYTES = 1024
/** A URL embed takes at most 256 bytes; a longer link stays in the text. */
const URL_BYTES = 256

export type CastId = { fid: number; hash: string }
export type Chain = { root?: CastId; index: number; count: number }
export type Embed = { url?: string; cast_id?: CastId }
/** A cast as the node's /v1 API has it, with what an article needs. `hash` is 40 lowercase hex digits without 0x;
 *  `at` is its Farcaster timestamp (seconds from 2021-01-01). */
export type Part = { fid: number; hash: string; at: number; text: string; mentions: number[]; positions: number[]; embeds: Embed[]; format: number; chain?: Chain }

const bytes = (s: string) => new TextEncoder().encode(s).length
const hash40 = (s: unknown) => (typeof s === 'string' && /^(0x)?[0-9a-f]{40}$/i.test(s) ? s.replace(/^0x/, '').toLowerCase() : undefined)
// Hypersnap writes native FIDs (2^32 and up) as strings, and protobuf JSON can write any uint64 as one
const uint = (v: unknown) => {
  const x = typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : v
  return typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 ? x : undefined
}
const castId = (x: any): CastId | undefined => {
  const fid = uint(x?.fid)
  const hash = hash40(x?.hash)
  return fid && hash ? { fid, hash } : undefined
}

/** The FIP's chain rules (nodes only check them once the feature is active, so readers check them again): at most 100
 *  casts, an index below 100 and below `count` when it's set, no root at index 0, and the author's own cast as root
 *  otherwise. A chain that breaks one is left out, so the cast reads as an ordinary one. */
function chainOf(c: any, fid: number): Chain | undefined {
  if (!c || typeof c !== 'object') return
  // protobuf JSON leaves out zeros
  const index = c.index == null ? 0 : uint(c.index)
  const count = c.count == null ? 0 : uint(c.count)
  if (index === undefined || count === undefined || count > MAX_PARTS || index >= MAX_PARTS || (count > 0 && index >= count)) return
  if (index === 0) return c.root ? undefined : { index, count }
  const root = castId(c.root)
  return root && root.fid === fid ? { root, index, count } : undefined
}

/** A /v1 message as a Part, or null when it isn't a cast. */
export function fromNode(m: any): Part | null {
  const d = m?.data
  const b = d?.castAddBody
  if (d?.type !== 'MESSAGE_TYPE_CAST_ADD' || !b || typeof b !== 'object') return null
  const fid = uint(d.fid)
  const hash = hash40(m.hash)
  if (!fid || !hash) return null
  const embeds: Embed[] = (Array.isArray(b.embeds) ? b.embeds : []).flatMap((e: any): Embed[] => {
    if (typeof e?.url === 'string') return [{ url: e.url }]
    const id = castId(e?.castId)
    return id ? [{ cast_id: id }] : []
  })
  const nums = (a: unknown) => (Array.isArray(a) ? a.map(uint).filter((x): x is number => x !== undefined) : [])
  return {
    fid, hash, at: uint(d.timestamp) || 0, text: typeof b.text === 'string' ? b.text : '', mentions: nums(b.mentions), positions: nums(b.mentionsPositions),
    embeds, format: uint(b.formatVersion) || 0, chain: chainOf(b.chain, fid),
  }
}

/** The first cast of an article. */
export const isArticle = (p: Part | null | undefined): p is Part & { chain: Chain } => !!p && p.format === ARTICLE && p.chain?.index === 0
/** A later cast of a chain (classify tells whether its chain is an article). */
export const isArticlePart = (p: Part | null | undefined): p is Part & { chain: Chain & { root: CastId } } => !!p?.chain?.root

/** A /v2 cast as a Part, from the fields a node with farcasterorg/hypersnap#69 adds (`format_version`, `chain` with a
 *  bare hex root hash); undefined when they're left out (an older node, a search result), so the node's /v1 API has
 *  to be asked. The text is the node's, without its mentions, which `mentioned_profiles_ranges` puts back (partText). */
export function fromV2(c: any): Part | undefined {
  const format = uint(c?.format_version)
  const fid = uint(c?.author?.fid)
  const hash = hash40(c?.hash)
  const time = Date.parse(c?.timestamp)
  if (format === undefined || !fid || !hash || !Number.isFinite(time)) return
  const embeds: Embed[] = (Array.isArray(c.embeds) ? c.embeds : []).flatMap((e: any): Embed[] => {
    if (typeof e?.url === 'string') return [{ url: e.url }]
    const id = castId(e?.cast_id)
    return id ? [{ cast_id: id }] : []
  })
  // a mention is where its range starts (its end is the same); one the node couldn't name still counts
  const ranges: any[] = Array.isArray(c.mentioned_profiles_ranges) ? c.mentioned_profiles_ranges : []
  const named: any[] = Array.isArray(c.mentioned_profiles) ? c.mentioned_profiles : []
  const mentions: number[] = [], positions: number[] = []
  ranges.forEach((r, i) => {
    const at = uint(r?.start), who = uint(named[i]?.fid)
    if (at !== undefined && who !== undefined) mentions.push(who), positions.push(at)
  })
  return { fid, hash, at: Math.round((time - FARCASTER_EPOCH) / 1000), text: typeof c.text === 'string' ? c.text : '', mentions, positions, embeds, format, chain: chainOf(c.chain, fid) }
}
/** Farcaster timestamps count seconds from 2021-01-01. */
const FARCASTER_EPOCH = Date.UTC(2021, 0, 1)

/** What a Part says by itself: it when it's an article's first cast or a later part in article Markdown, null when it's
 *  neither, undefined when its chain's first cast has to say (classify). */
export const partNow = (x: Part | null | undefined): Part | null | undefined =>
  isArticle(x) ? x : !isArticlePart(x) ? null : x.format === ARTICLE ? x : undefined

/** `m` (a /v1 message) as an article's first cast or a later part, or null. A part says it's in article Markdown;
 *  one that doesn't (the FIP only says it SHOULD) is one when its first cast is an article, which `get` asks for. */
export const classify = (get: (path: string) => Promise<any>, m: any) => classifyPart(get, fromNode(m))

/** `x` as an article's first cast or a later part, or null (classify). `v2`: `x` came from a /v2 cast with its format
 *  fields (fromV2), so its first cast is asked for the same way, and through /v1 only when the node leaves them out. */
export async function classifyPart(get: (path: string) => Promise<any>, x: Part | null, v2 = false): Promise<Part | null> {
  const now = partNow(x)
  if (now !== undefined) return now
  const { fid, hash } = (x as Part & { chain: Chain & { root: CastId } }).chain.root
  const key = `${fid}:${hash}`
  // each root is asked about once; one the node doesn't have (yet) is a failure, so nothing is kept from it
  let is = roots.get(key)
  if (!is) {
    const v1 = async () => fromNode(await get(`/v1/castById?fid=${fid}&hash=0x${hash}`))
    is = (v2 ? get(`/v2/farcaster/cast?identifier=${hash}&type=hash`).then((r) => (r?.cast ? fromV2(r.cast) : null) ?? v1()) : v1()).then((root) => {
      // (never shown: a failed lookup)
      if (!root) throw new RangeError('no such cast')
      return isArticle(root) && root.fid === fid && root.hash === hash
    })
    if (roots.size >= 2000) roots.delete(roots.keys().next().value!)
    roots.set(key, is)
    is.catch(() => roots.get(key) === is && roots.delete(key))
  }
  return (await is) ? x : null
}
const roots = new Map<string, Promise<boolean>>()

type Shown = { text?: string; parent_hash?: string | null; parent_author?: { fid: number | null }; author?: { fid: number }; embeds?: Embed[]; replies?: { count?: number } }
/** Whether a cast from the /v2 API, without format_version and chain (fromV2), could be part of an article, so it's
 *  worth asking the node: the first cast of one is a cast that isn't a reply, whose text is one line or a line and
 *  an empty line, with at most the cover for an embed, and that the next cast replies to; a later cast replies to
 *  the author's own cast. */
export function maybeArticle(c: Shown) {
  if (c.parent_hash) return !!c.author && c.parent_author?.fid === c.author.fid
  const lines = (c.text || '').split('\n', 2)
  const embeds = c.embeds || []
  // a title alone that nothing replies to is most casts, and as an article it's only its title; a title and an empty
  // line (an opening follows) is rare enough to ask about without replies
  return !!lines[0].trim() && bytes(lines[0]) <= 320 && (lines.length === 1 ? c.replies?.count !== 0 : !lines[1]) && embeds.length <= 1 && !embeds[0]?.cast_id
}

/** The title (the first line of the first cast) and the opening (what follows its empty line). */
export function headOf(text: string) {
  const nl = text.indexOf('\n')
  return { title: (nl < 0 ? text : text.slice(0, nl)).trim(), opening: nl < 0 ? '' : text.slice(nl + 1).replace(/^\n/, '') }
}
/** The opening as a card shows it: its text, less the lines that are embeds ([$N], a link alone on a line). */
export const cardOpening = (opening: string, embeds: Embed[] = []) =>
  segments(opening, embeds).flatMap((s) => ('text' in s ? [s.text] : [])).join('\n')
/** The opening as plain words for a share preview or a crawler: cardOpening without its Markdown (unmarkdown), an
 *  escaped character as itself and a line's carrying-on backslash gone. */
export function plainOpening(opening: string, embeds: Embed[] = []) {
  const ESC = '\\*_~+[]'
  // escapes are held as private-use characters while unmarkdown reads the rest, so they stay the characters they are
  const held = cardOpening(opening, embeds).replace(/[\ue000-\ue006]/g, '\ufffd').replace(/(?<!\\)((?:\\\\)*)\\$/gm, '$1')
    .replace(/\\([\\*_~+[\]])/g, (_, c: string) => String.fromCharCode(0xe000 + ESC.indexOf(c)))
  return unmarkdown(held).replace(/[\ue000-\ue006]/g, (c) => ESC[c.charCodeAt(0) - 0xe000])
}
/** The cover: the first cast's one URL embed. */
export const coverOf = (embeds: Embed[] = []) => (embeds.length === 1 ? safeUrl(embeds[0].url) : undefined)

/** Whether `a` replaces `b` at the same index: the later timestamp, then the greater hash (as unsigned bytes, which
 *  lowercase hex compares the same as), as for any cast. */
const later = (a: Part, b: Part) => a.at > b.at || (a.at === b.at && a.hash > b.hash)

export type Article = { parts: (Part | undefined)[]; complete: boolean }
/** The FIP's reading rules (section 5) over `casts`, the author's casts from the root's timestamp on: the root, then at
 *  each index the latest cast by the same author whose root it is and whose count is the root's. A missing index is
 *  undefined. `complete`: every index below the count has a cast (a count of 0 is a chain still growing, complete as
 *  far as it goes). */
export function assemble(root: Part & { chain: Chain }, casts: Part[]): Article {
  const count = root.chain.count
  const best = new Map<number, Part>()
  for (const c of casts) {
    const ch = c.chain
    if (!ch?.root || c.fid !== root.fid || ch.root.fid !== root.fid || ch.root.hash !== root.hash || ch.count !== count) continue
    if (count > 0 && ch.index >= count) continue
    const was = best.get(ch.index)
    if (!was || later(c, was)) best.set(ch.index, c)
  }
  const n = count > 0 ? count : Math.max(0, ...best.keys()) + 1
  const parts = [root, ...Array.from({ length: n - 1 }, (_, i) => best.get(i + 1))]
  return { parts, complete: parts.every(Boolean) }
}

/** The article that starts at `root`, read from the node: the author's casts from the root's timestamp on, page by
 *  page (at most `pages` of 100), until the chain is complete. `get` answers a node path with its JSON. */
export async function loadArticle(get: (path: string) => Promise<any>, root: Part & { chain: Chain }, pages = 5): Promise<Article> {
  const casts: Part[] = []
  let token = ''
  for (let i = 0; i < pages; i++) {
    const r = await get(`/v1/castsByFid?fid=${root.fid}&startTimestamp=${root.at}&pageSize=100${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`)
    for (const m of r?.messages || []) {
      const p = fromNode(m)
      if (p) casts.push(p)
    }
    token = r?.nextPageToken || ''
    // a later cast at an index would replace that part; parts go out together, so the pages after a complete chain
    // are the author's other casts
    if (!token || (root.chain.count > 0 && assemble(root, casts).complete)) break
  }
  return assemble(root, casts)
}

/** A part's text with its mentions put back (castText), for display. `name` gives an FID's username. */
export const partText = (p: Part, name: (fid: number) => string | undefined) =>
  castText({ text: p.text, mentioned_profiles: p.mentions.map((fid) => ({ username: name(fid) })), mentioned_profiles_ranges: p.positions.map((at) => ({ start: at, end: at })) }, true)

export type Segment = { text: string } | { embeds: Embed[] }
// a line that is only a link: a link preview
const LONE_LINK = /^https?:\/\/\S+$/
// [$N]: the cast's Nth embed, where the text has it (Farcaster's own articles write these)
const PLACE = /^\[\$(\d{1,2})\]$/
const oddSlashes = (l: string) => (l.match(/\\+$/)?.[0].length || 0) % 2 === 1
/** A part as its reader shows it: its text in pieces, with its embeds where `[$N]` puts them and links alone on a line
 *  as link previews, then the rest of its embeds (less those in `skip`: the cover). Lines in code and LaTeX blocks,
 *  and lines a backslash carries on, stay text. */
export function segments(text: string, embeds: Embed[], skip: number[] = []): Segment[] {
  const out: Segment[] = []
  const used = new Set(skip)
  let buf: string[] = []
  const flush = () => buf.length && (out.push({ text: buf.join('\n') }), (buf = []))
  const put = (e: Embed) => {
    flush()
    const last = out[out.length - 1]
    if (last && 'embeds' in last) last.embeds.push(e)
    else out.push({ embeds: [e] })
  }
  let fence = ''
  let goesOn = false
  for (const l of text ? text.split('\n') : []) {
    if (fence) {
      buf.push(l)
      if (l === fence) fence = ''
      continue
    }
    const was = goesOn
    goesOn = oddSlashes(l)
    const m = l.match(PLACE)
    if (!was && m && +m[1] >= 1 && +m[1] <= embeds.length && !used.has(+m[1] - 1)) used.add(+m[1] - 1), put(embeds[+m[1] - 1])
    else if (!was && LONE_LINK.test(l) && safeUrl(l)) put({ url: l })
    else {
      if (!was) fence = l.match(/^(`{3,})[^`]*$/)?.[1] || (l === '$$' ? '$$' : '')
      buf.push(l)
    }
  }
  flush()
  embeds.forEach((e, i) => !used.has(i) && put(e))
  return out
}

// --- writing one ---

type Unit = { text: string } | { url: string; kind: 'media' | 'link' }
const PICTURE_LINE = /^!\[[^\]\n]*\]\(([^\s()]+)\)$/
const TABLE_DIVIDER = /^\|(?:\s*:?-+:?\s*\|)+\s*$/
/** The body as the blocks a cast may not split (a line, or lines a backslash joins, a code or LaTeX block, a table)
 *  and the embeds it turns into: a picture alone on its line, or a link alone on its line that fits an embed. */
function units(body: string): Unit[] {
  const lines = body.replace(/\r\n?/g, '\n').split('\n')
  const out: Unit[] = []
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    const fence = l.match(/^(`{3,})[^`]*$/)?.[1] || (l === '$$' ? '$$' : '')
    if (fence) {
      const end = lines.findIndex((x, j) => j > i && x === fence)
      const stop = end < 0 ? lines.length - 1 : end
      // an unclosed block is closed, so what follows the article's end can't be read into it
      out.push({ text: lines.slice(i, stop + 1).join('\n') + (end < 0 ? `\n${fence}` : '') })
      i = stop
      continue
    }
    if (l.startsWith('|') && TABLE_DIVIDER.test(lines[i + 1] || '')) {
      let j = i + 2
      while (j < lines.length && lines[j].startsWith('|')) j++
      out.push({ text: lines.slice(i, j).join('\n') })
      i = j - 1
      continue
    }
    const pic = l.trim().match(PICTURE_LINE)?.[1]
    const link = LONE_LINK.test(l.trim()) ? l.trim() : undefined
    const url = safeUrl(pic || link)
    if (url && bytes(url) <= URL_BYTES) {
      out.push({ url, kind: pic || isImg(url) || isVid(url) ? 'media' : 'link' })
      continue
    }
    // a line that reads as [$N] would show that cast's Nth embed, so it's written escaped
    let text = PLACE.test(l) ? `\\${l}` : l
    while (oddSlashes(text) && i + 1 < lines.length) text += '\n' + lines[++i]
    out.push({ text })
  }
  return out
}

/** Pieces of `s` that each take at most `room` bytes: at spaces, or anywhere in a word longer than that (`exact`:
 *  only at characters, keeping every space, for a line of code). */
function pieces(s: string, room: number, exact = false): string[] {
  const out: string[] = []
  let cur = ''
  for (const word of exact ? [s] : s.split(/(?<=\s)/)) {
    if (!exact && cur && bytes(cur + word) > room) out.push(cur.trimEnd()), (cur = '')
    if (!exact && bytes(word) <= room) {
      cur += word
      continue
    }
    for (const ch of word) {
      if (cur && bytes(cur + ch) > room) out.push(exact ? cur : cur.trimEnd()), (cur = '')
      cur += ch
    }
  }
  if (exact ? cur : cur.trim()) out.push(exact ? cur : cur.trimEnd())
  return out
}
// what starts a quote, a list item or a heading, which each piece of a long one starts with again
const MARKER = /^(?:> |(?: {2})*(?:- |\d{1,9}\. )|#{1,2} )/
/** A block too long for one cast, as several that each fit: a code or LaTeX block and a table by their lines (each
 *  piece its own block again, with its fences or header), anything else at spaces, each piece of a quote, list item or
 *  heading with its marker again. */
function cut(text: string, room: number): string[] {
  const lines = text.split('\n')
  const fence = lines[0].match(/^(`{3,})[^`]*$/)?.[1] || (lines[0] === '$$' ? '$$' : '')
  const table = !fence && lines[0].startsWith('|') && TABLE_DIVIDER.test(lines[1] || '')
  if (fence || table) {
    const open = fence ? lines[0] : lines.slice(0, 2).join('\n')
    const close = fence ? [fence] : []
    const inner = fence ? lines.slice(1, -1) : lines.slice(2)
    const make = (xs: string[]) => [open, ...xs, ...close].join('\n')
    const out: string[] = []
    let cur: string[] = []
    for (const x of inner) {
      if (cur.length && bytes(make([...cur, x])) > room) out.push(make(cur)), (cur = [])
      // a line longer than a cast is cut at characters (a table row's cells break, but nothing is lost)
      if (bytes(make([x])) > room) for (const piece of pieces(x, room - bytes(make([])) - 1, true)) out.push(make([piece]))
      else cur.push(x)
    }
    if (cur.length) out.push(make(cur))
    return out
  }
  const marker = text.match(MARKER)?.[0] || ''
  // a piece of a paragraph that starts like a block (or reads as [$N] or a lone link) would be read as one: a
  // backslash first keeps it a paragraph
  return pieces(text.slice(marker.length), room - bytes(marker) - 1).map((p, i) => (i && !marker && (BLOCKY.test(p) || PLACE.test(p) || LONE_LINK.test(p) || /^\\[^\\*_~+[\]\n]/.test(p)) ? `\\${p}` : marker + p))
}
const BLOCKY = /^(?:#{1,2} |>(?: |$)|(?: {2})*(?:- |\d{1,9}\. )|---\s*$|`{3,}|\$\$|\|)/

export type Outgoing = { text: string; embeds: string[] }
/** An article as the casts that carry it (FIP section 6): the first with the title, the opening (the body's first
 *  block, or a heading and the block after it) when it fits, and the cover; then each with whole blocks of text and
 *  then embeds of one kind (pictures and videos, or link previews), at most MAX_EMBEDS. Each text fits `room` bytes,
 *  and no cast is empty. Throws when there's no title, the cover's address is too long for an embed, or the article
 *  needs more than MAX_PARTS casts. */
export function splitArticle(a: { title: string; cover?: string; body: string }, room = PART_BYTES): Outgoing[] {
  const title = a.title.replace(/\s+/g, ' ').trim()
  if (!title) throw new Error('An article needs a title.')
  if (bytes(title) > Math.min(room, 320)) throw new Error('The title is too long.')
  const cover = safeUrl(a.cover)
  if (cover && bytes(cover) > URL_BYTES) throw new Error("The cover image's address is too long.")
  const all = units(a.body.trim())
  const isText = (u?: Unit): u is { text: string } => !!u && 'text' in u && !!u.text.trim()
  const heading = (u?: Unit) => isText(u) && /^#{1,2} /.test(u.text)
  // the opening: the first block, or a heading and the block after it (past an empty line between them)
  let text = title
  if (isText(all[0])) {
    const gap = heading(all[0]) && all[1] && 'text' in all[1] && !all[1].text && isText(all[2]) && !heading(all[2]) ? 1 : 0
    const next = all[1 + gap]
    const take = heading(all[0]) && isText(next) && !heading(next) ? 2 : 1
    const opening = [all[0], ...(take === 2 ? [next] : [])].map((u) => (u as { text: string }).text).join('\n')
    if (bytes(`${title}\n\n${opening}`) <= room) (text = `${title}\n\n${opening}`), all.splice(0, take === 2 ? 2 + gap : 1)
  }
  const out: Outgoing[] = [{ text, embeds: cover ? [cover] : [] }]
  let cur: { lines: string[]; embeds: string[]; kind?: string } = { lines: [], embeds: [] }
  // a cast of nothing but empty lines (the gap before a block too long to join it) isn't sent: the gap goes
  const done = () => (cur.lines.some((l) => l) || cur.embeds.length) && out.push({ text: cur.lines.join('\n'), embeds: cur.embeds })
  const next = () => (done(), (cur = { lines: [], embeds: [] }))
  for (const u of all) {
    if ('url' in u) {
      if (cur.embeds.length && (cur.kind !== u.kind || cur.embeds.length >= MAX_EMBEDS)) next()
      cur.embeds.push(u.url)
      cur.kind = u.kind
      continue
    }
    for (const piece of bytes(u.text) > room ? cut(u.text, room) : [u.text]) {
      // text after an embed starts a new cast, so readers (text, then embeds) keep the order
      if (cur.embeds.length || (cur.lines.length && bytes([...cur.lines, piece].join('\n')) > room)) next()
      cur.lines.push(piece)
    }
  }
  done()
  if (out.length > MAX_PARTS) throw new Error('This article is too long to publish.')
  // a table whose header alone is wider than a cast can't be cut to fit
  if (out.some((p) => bytes(p.text) > room)) throw new Error('A table in this article is too wide to publish.')
  return out
}
