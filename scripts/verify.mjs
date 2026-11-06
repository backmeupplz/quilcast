#!/usr/bin/env node
// Checks that a site serves exactly one build of Quilcast: every file of it byte for byte, only its scripts in the
// pages and nothing else there that could load code, and a CSP that blocks any other site's and any other inline
// script. README "Verify this build" says what that proves and what it doesn't.
//
//   node scripts/verify.mjs                      quilcast.com against the build CI published for its commit
//   node scripts/verify.mjs --dist dist          against a build of your own (git checkout <commit> && npm ci && npm run build)
//   node scripts/verify.mjs --site <url> --page /c/<hash>   another host, more pages
//
// One file with no dependencies (Node 18+), so it also runs on its own: download it from GitHub and run it.
// `npm run build` writes dist/build.json (scripts/manifest.mjs): the SHA-256 of every file the server sends as it is
// (all of dist/ but the HTML, which it fills in per page) and of the inline scripts its pages may run. On each push to
// main it builds, CI publishes that file to this repo's `builds` branch (scripts/publish-build.sh), which the mirror copies to GitHub.
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SITE = 'https://quilcast.com'
// where CI's builds are looked up, in this order: GitHub first, as it's run by someone else than quilcast.com
export const PUBLISHED = ['https://raw.githubusercontent.com/backmeupplz/quilcast/builds/', 'https://git.borodutch.com/backmeupplz/quilcast/raw/branch/builds/']
// the home page (drawn by the server), a page of the app, and a standalone page
export const PAGES = ['/', '/settings', '/about']

const sha = (b) => createHash('sha256').update(b).digest('hex')
/** A build's id: the hash of its file and inline-script hashes, in a fixed order. */
export const digest = ({ files, inline }) => sha(JSON.stringify({ files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1))), inline: [...inline].sort() }))

// A page is read the strict way, by the forms of tag Quilcast's pages use, not the way a browser reads HTML: every
// "<script" and "<link" in it, wherever it is (in a comment or an attribute too), has to be one of these, with values
// in double quotes, so no stretch of the page can read one way here and another in a browser.
const SCRIPT = /^<script((?: (?:type|src|crossorigin|id)(?:="[^"<>&]*")?)*)>$/
const LINK = /^<link((?: [a-z-]+(?:="[^"<>]*")?)*)(?: \/)?>$/
const ATTRS = / ([a-z-]+)(?:="([^"]*)")?/g
// script types a browser never runs
const DATA = new Set(['application/json', 'application/ld+json'])
// a <meta> is read the same strict way, as one could refresh to another page or pick another encoding for the page
const META = /<meta((?: [a-z-]+="[^"]*")*)(?: \/)?>/y
// what Quilcast's pages never have, as it could load or run a page or code the check doesn't see: a <base> moving where
// addresses lead, frames (one from this site runs with its keys), objects and embeds
const NEVER = /<(?:base|i?frame|object|embed|portal|fencedframe)/gi

/**
 * What in a page could run code: its inline scripts by text, the addresses of the scripts and styles it loads, and
 * anything in a form this check doesn't take (`odd`, which fails it).
 */
export function scripts(html) {
  const inline = []
  const srcs = []
  const odd = []
  for (const m of html.matchAll(/<(script|link)/gi)) {
    const close = html.indexOf('>', m.index)
    const tag = html.slice(m.index, close < 0 ? html.length : close + 1)
    const t = m[1] === 'script' ? tag.match(SCRIPT) : m[1] === 'link' ? tag.match(LINK) : null
    const attrs = new Map()
    for (const [, k, v] of t ? t[1].matchAll(ATTRS) : []) attrs.set(k, attrs.has(k) ? null : (v ?? ''))
    const no = (why = tag.slice(0, 100)) => odd.push(why)
    if (!t || [...attrs.values()].includes(null)) {
      no()
      continue
    }
    if (m[1] === 'link') {
      // a browser decodes character references ("&#115;tylesheet"), so what a link is and loads mustn't have any
      if ((attrs.get('rel') || '').includes('&')) {
        no()
        continue
      }
      // as a browser reads it: in any case, its words split at any ASCII space ("StyleSheet", "icon\tstylesheet")
      const rel = (attrs.get('rel') || '').toLowerCase().split(/[\t\n\f\r ]+/)
      if (rel.includes('stylesheet') || rel.includes('modulepreload') || rel.includes('preload')) {
        const href = attrs.get('href') ?? ''
        href.includes('&') ? no() : srcs.push(href)
      }
      continue
    }
    // a script's text runs to the first "</script" (a browser's may run on, past "<!--", never stop sooner); the text
    // has to be empty, data with no "<" or one of the build's own scripts, so a "<script" that a browser reads as no
    // tag at all (in a comment, say) can't hide what follows it
    const to = html.slice(close + 1).search(/<\/script/i)
    const end = close + 1 + to
    const body = html.slice(close + 1, end)
    const type = attrs.get('type')
    if (to < 0 || !html.startsWith('</script>', end)) no()
    else if (attrs.has('src')) (type === undefined || type === 'module') && body === '' ? srcs.push(attrs.get('src')) : no()
    // data holds no "<", so nothing can hide in it
    else if (DATA.has(type)) body.includes('<') && no(`${tag} with markup in it`)
    else if (type === undefined) inline.push(body)
    else no()
  }
  // a <meta> may say the page is UTF-8, never anything else, and has no http-equiv: only that makes it a refresh or a
  // policy, and a browser decodes "&#82;efresh" in its value. The text "http-equiv" in a cast or bio is no attribute
  for (const m of html.matchAll(/<meta/gi)) {
    META.lastIndex = m.index
    const t = META.exec(html)
    const attrs = new Map()
    for (const [, k, v] of t ? t[1].matchAll(ATTRS) : []) attrs.set(k, attrs.has(k) ? null : v)
    if (!t || [...attrs.values()].includes(null) || attrs.has('http-equiv') || (attrs.has('charset') && attrs.get('charset').toLowerCase() !== 'utf-8')) odd.push(html.slice(m.index, m.index + 100).split('>')[0] + '>')
  }
  for (const [m] of html.matchAll(NEVER)) odd.push(m)
  return { inline, srcs, odd }
}

/** What's wrong with a page's Content-Security-Policy, given the build's inline scripts: [] when it lets no script run
 *  but the site's own files and those inline scripts. */
export function cspProblems(header, inline) {
  if (!header) return ['no Content-Security-Policy, so the page could run scripts from anywhere']
  // a browser splits a policy at ASCII spaces only: to it "default-src *; script-src 'self'" has no script-src
  if (/[^\t\x20-\x7e]/.test(header)) return ['the CSP has a character other than printable ASCII, which a browser may read differently from this check']
  const ok = new Set(["'self'", "'none'", "'report-sample'", ...inline.map((h) => `'sha256-${Buffer.from(h, 'hex').toString('base64')}'`)])
  // several policies all apply, so one strict one is enough
  const verdicts = header.split(',').map((policy) => {
    const d = new Map()
    for (const part of policy.split(';')) {
      const [name, ...values] = part.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '').split(/[\t\n\f\r ]+/)
      if (name && !d.has(name.toLowerCase())) d.set(name.toLowerCase(), values)
    }
    const base = d.get('script-src') ?? d.get('default-src')
    const problems = []
    for (const [what, values] of [['script-src-elem', d.get('script-src-elem') ?? base], ['script-src-attr', d.get('script-src-attr') ?? base]]) {
      if (!values) problems.push(`the CSP doesn't limit scripts (${what})`)
      else for (const v of values) if (!ok.has(v.startsWith("'sha256-") ? v : v.toLowerCase())) problems.push(`the CSP lets more scripts run: ${what} ${v}`)
    }
    return [...new Set(problems)]
  })
  return verdicts.find((p) => !p.length) || verdicts[0]
}

async function get(url, { tries = 3, redirect = 'follow' } = {}) {
  for (let i = 1; ; i++) {
    try {
      return await fetch(url, { cache: 'no-store', redirect, signal: AbortSignal.timeout(60e3) })
    } catch (e) {
      if (i >= tries) throw new Error(`${url}: ${e.cause?.message || e.message}`)
      await new Promise((ok) => setTimeout(ok, 1000 * i))
    }
  }
}
const bytes = async (r) => Buffer.from(await r.arrayBuffer())

/** A build CI published, by its id; null when none is. */
export async function published(id, bases = PUBLISHED) {
  const errors = []
  for (const base of bases) {
    try {
      const r = await get(base + id + '.json')
      if (r.status === 404) continue
      if (!r.ok) throw new Error(`${base}: ${r.status}`)
      const build = JSON.parse(String(await bytes(r)))
      if (digest(build) !== id) throw new Error(`${base}${id}.json doesn't hash to its name`)
      return { ...build, from: base + id + '.json' }
    } catch (e) {
      errors.push(e.message)
    }
  }
  if (errors.length) throw new Error(`couldn't read the published builds: ${errors.join('; ')}`)
  return null
}

/**
 * Check `site` against a build: `dist` (a folder with build.json) or, without one, the build CI published that the site
 * says it runs. `log` gets a line per step. Resolves to { ok, problems, build, commit, version }.
 */
export async function verify({ site = SITE, dist, pages = PAGES, bases = PUBLISHED, log = () => {} } = {}) {
  site = site.replace(/\/+$/, '')
  const origin = new URL(site).origin
  const problems = []
  // what the site says it runs: only a pointer to the build to check against, as a server could say anything
  // past any cache (the server sends it no-cache), as an hour-old one names the build before the last deploy
  const r = await get(`${site}/build.json?t=${Date.now()}`)
  let said = null
  let status = r.status
  if (r.ok) {
    // a server from before builds were published sends its app page for any address
    try {
      said = JSON.parse(String(await bytes(r)))
    } catch {}
    if (!said?.files || typeof said.files !== 'object' || !Array.isArray(said?.inline)) (said = null), (status = `${r.status}, but no build manifest: the site doesn't publish which build it runs`)
  }
  const saidId = said && digest(said)
  log(said ? `${site} says it runs Quilcast ${said.version}, build ${saidId}` : `${site} doesn't say which build it runs (/build.json: ${status})`)
  let ref
  if (dist) {
    ref = JSON.parse(readFileSync(join(dist, 'build.json'), 'utf8'))
    log(`Checking it against your build in ${resolve(dist)}: Quilcast ${ref.version}, build ${digest(ref)}`)
    if (said && digest(ref) !== saidId) problems.push(`the site says it runs build ${saidId}, not ${digest(ref)}`)
  } else {
    if (!said) return { ok: false, problems: [`${site}/build.json: ${status}, so there's no published build to check against (a build of your own can be: --dist)`] }
    ref = await published(saidId, bases)
    if (!ref) return { ok: false, problems: [`CI never published build ${saidId}, so it wasn't built from a commit of the repo's main (or was deployed in the last few minutes: try again soon)`] }
    log(`CI built it from commit ${ref.commit} (${ref.from})`)
  }

  // every file, byte for byte, a few at a time
  const paths = Object.keys(ref.files)
  const queue = [...paths]
  let same = 0
  await Promise.all(Array.from({ length: 6 }, async () => {
    for (let path; (path = queue.shift()) !== undefined;) {
      try {
        const f = await get(site + encodeURI(path))
        if (!f.ok) problems.push(`${path}: ${f.status}`)
        else if (sha(await bytes(f)) !== ref.files[path]) problems.push(`${path} isn't the build's${path.startsWith('/assets/') ? '' : ' (files outside /assets/ may be cached for an hour: just after a deploy, try again later)'}`)
        else same++
      } catch (e) {
        problems.push(e.message)
      }
    }
  }))
  log(`${same} of ${paths.length} files match`)

  // the pages: only the build's scripts in them, and a CSP that keeps out any other site's and any other inline script.
  // A page may load a file only by the very address it was fetched at above: a browser doesn't decode "%61" in a path
  // before asking for it, so "/assets/%61.js" is another file to it than "/assets/a.js". Compare whole addresses (but the
  // fragment, which a browser never sends): "/assets/a.js?" has an empty .search yet is another address too
  const fetched = new Set(paths.map((path) => new URL(site + encodeURI(path)).href))
  const inline = new Set(ref.inline)
  for (const page of pages) {
    // a page is read as it arrives: not after a redirect, and only as UTF-8, the one way this check reads it
    const p = await get(site + page, { redirect: 'manual' }).catch((e) => ({ error: e.message }))
    if (p.error || p.status !== 200) {
      problems.push(`${page}: ${p.error || `${p.status} ${p.headers.get('location') || ''}`.trim()}`)
      continue
    }
    const before = problems.length
    // only encodings every Node this runs on decodes (older ones pass zstd through still compressed, unread)
    const encoding = (p.headers.get('content-encoding') || 'identity').trim().toLowerCase()
    if (!['identity', 'gzip', 'x-gzip', 'deflate', 'br'].includes(encoding)) {
      problems.push(`${page}: sent as ${encoding}, which the check can't be sure to read`)
      continue
    }
    const body = await bytes(p)
    // only ASCII spaces before "charset": a browser takes "text/html; charset=utf-8" as no charset at all and
    // goes by the page's <meta>, which scripts() allows only as UTF-8. No ESC byte either, which only other encodings
    // (ISO-2022-JP) use to switch what the bytes after it mean
    if (!/^text\/html;[ \t]*charset=utf-8$/i.test(p.headers.get('content-type') || '') || !/^<!doctype html>/i.test(String(body)) || body.includes(0x1b)) problems.push(`${page}: not plain UTF-8 HTML (${p.headers.get('content-type')}), which the check can't read the way a browser would`)
    // headers that send a browser to, prerender or preload a page or file the check doesn't see: Refresh,
    // Speculation-Rules (rules from 'self' that prerender a page, whose own scripts then run whatever the CSP) and any
    // Link (rel=prerender, modulepreload...). Quilcast's pages send none of them (Astra's review of #476)
    for (const [h, what] of [['refresh', 'a Refresh header'], ['speculation-rules', 'a Speculation-Rules header'], ['link', 'a Link header']]) {
      if (p.headers.has(h)) problems.push(`${page}: ${what}, which can load a page or file the check doesn't see`)
    }
    for (const c of cspProblems(p.headers.get('content-security-policy'), ref.inline)) problems.push(`${page}: ${c}`)
    const s = scripts(String(body))
    for (const js of s.inline) if (!inline.has(sha(js))) problems.push(`${page}: an inline script that isn't the build's: ${JSON.stringify(js.slice(0, 80))}`)
    for (const o of s.odd) problems.push(`${page}: ${JSON.stringify(o)}, which Quilcast's pages never have`)
    for (const src of s.srcs) {
      let u
      try {
        u = new URL(src, site + page)
      } catch {
        problems.push(`${page}: a broken address: ${JSON.stringify(src)}`)
        continue
      }
      const sent = new URL(u)
      sent.hash = ''
      if (u.origin !== origin || !fetched.has(sent.href)) problems.push(`${page}: loads ${u.href}, which isn't a file of the build`)
    }
    if (problems.length === before) log(`${page}: ${s.inline.length + s.srcs.length} scripts and styles, all the build's, and a CSP that blocks other sites' and inline scripts`)
  }
  return { ok: !problems.length, problems, build: saidId, commit: ref.commit, version: ref.version }
}

// Node realpaths the main module, so compare real paths: run through a symlink (macOS /tmp is /private/tmp), a plain
// resolve() never matched and the CLI exited 0 without checking anything.
const real = (p) => {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2)
  const opts = { pages: [...PAGES] }
  for (let i = 0; i < args.length; i++) {
    const [k, v] = [args[i], args[i + 1]]
    if (k === '--site' && v) (opts.site = v), i++
    else if (k === '--dist' && v) (opts.dist = v), i++
    else if (k === '--page' && v?.startsWith('/')) opts.pages.push(v), i++
    else {
      console.error('usage: node verify.mjs [--site https://quilcast.com] [--dist <your dist/>] [--page /path]...')
      process.exit(2)
    }
  }
  try {
    const v = await verify({ ...opts, log: (l) => console.log('  ' + l) })
    const site = (opts.site || SITE).replace(/\/+$/, '')
    if (v.ok) {
      console.log(`\nPASS: ${site} serves exactly ${opts.dist ? 'your build' : `the build of commit ${v.commit}`} (Quilcast ${v.version}).`)
      if (v.commit) console.log(`Its code: https://github.com/backmeupplz/quilcast/tree/${v.commit} (also https://git.borodutch.com/backmeupplz/quilcast/src/commit/${v.commit})`)
    } else console.log(`\nFAIL: ${site} doesn't serve exactly that build:\n${v.problems.map((p) => '  - ' + p).join('\n')}`)
    console.log('This checks what the site sent to this computer just now. What that proves and what it can\'t: README, "Verify this build".')
    process.exit(v.ok ? 0 : 1)
  } catch (e) {
    console.error(`couldn't check: ${e.message}`)
    process.exit(2)
  }
}
