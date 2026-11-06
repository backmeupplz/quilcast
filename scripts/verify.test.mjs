// scripts/verify.mjs against a small fake site: what passes, and each way a server could slip in other code
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, beforeEach, test } from 'node:test'
import { FOLD } from '../server/home.mjs'
import { cspProblems, digest, scripts, verify } from './verify.mjs'

const sha = (s) => createHash('sha256').update(s).digest('hex')
const b64 = (s) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`
const HEAD = 'var x=1'
const INDEX = `<!doctype html><html><head><script>${HEAD}</script><script type="application/ld+json">{"a":1}</script><link rel="stylesheet" href="/assets/a.css"></head><body><div id="app"></div><script type="module" src="/assets/a.js"></script></body></html>`
const dist = mkdtempSync(join(tmpdir(), 'verify-'))
mkdirSync(join(dist, 'assets'))
writeFileSync(join(dist, 'index.html'), INDEX)
writeFileSync(join(dist, 'about.html'), '<!doctype html><p>About</p>')
writeFileSync(join(dist, 'assets/a.js'), 'console.log("app")')
writeFileSync(join(dist, 'assets/a.css'), 'p{color:red}')
writeFileSync(join(dist, 'sw.js'), 'self.onpush=()=>{}')
execFileSync(process.execPath, [fileURLToPath(new URL('./manifest.mjs', import.meta.url)), dist], { stdio: 'ignore' })
const build = JSON.parse(readFileSync(join(dist, 'build.json'), 'utf8'))

// the fake site; each test may change what it serves
let site
const reset = () => (site = { csp: `default-src 'self'; script-src 'self' ${b64(HEAD)} ${b64(FOLD)}`, page: INDEX, type: 'text/html; charset=utf-8', headers: {}, files: {}, published: {} })
const listen = (s) => new Promise((ok) => s.listen(0, '127.0.0.1', () => ok(`http://127.0.0.1:${s.address().port}`)))
const server = createServer((q, r) => {
  const path = new URL(q.url, 'http://x').pathname
  if (site.csp) r.setHeader('content-security-policy', site.csp)
  if (path in site.files) return r.end(site.files[path])
  if (path === '/' || path === '/settings') return r.writeHead(200, { 'content-type': site.type, ...site.headers }).end(site.page)
  try {
    const body = readFileSync(join(dist, path === '/about' ? 'about.html' : path))
    r.writeHead(200, path === '/about' ? { 'content-type': 'text/html; charset=utf-8' } : {}).end(body)
  } catch {
    r.writeHead(404).end()
  }
})
const base = await listen(server)
// CI's published builds
const store = createServer((q, r) => {
  const body = site.published[new URL(q.url, 'http://x').pathname.slice(1)]
  body ? r.end(body) : r.writeHead(404).end()
})
const bases = [(await listen(store)) + '/']
after(() => (server.close(), store.close()))
beforeEach(reset)
const check = (o = {}) => verify({ site: base, dist, ...o })

test('build.json: every file but the HTML and itself, the inline scripts the CSP allows, and an id of both', () => {
  assert.deepEqual(Object.keys(build.files).sort(), ['/assets/a.css', '/assets/a.js', '/sw.js'])
  assert.equal(build.files['/assets/a.js'], sha('console.log("app")'))
  assert.deepEqual(build.inline, [sha(HEAD), sha(FOLD)].sort())
  assert.equal(build.build, digest(build))
  assert.notEqual(digest({ ...build, files: { ...build.files, '/sw.js': sha('x') } }), build.build)
})

test('a site serving the build passes, against a build of your own', async () => {
  const v = await check()
  assert.deepEqual(v.problems, [])
  assert.ok(v.ok)
})

test("against CI's published build: passes and names the commit; an unpublished or mislabelled build fails", async () => {
  site.published[`${build.build}.json`] = JSON.stringify({ ...build, commit: 'c0ffee' })
  const v = await check({ dist: undefined, bases })
  assert.ok(v.ok, v.problems.join())
  assert.equal(v.commit, 'c0ffee')
  site.published = {}
  assert.match((await check({ dist: undefined, bases })).problems[0], /never published build/)
  site.published[`${build.build}.json`] = JSON.stringify({ ...build, files: {} })
  await assert.rejects(check({ dist: undefined, bases }), /doesn't hash to its name/)
})

test('a changed file fails, even when build.json is changed to match', async () => {
  site.files['/assets/a.js'] = 'steal()'
  site.files['/build.json'] = JSON.stringify({ ...build, files: { ...build.files, '/assets/a.js': sha('steal()') } })
  const v = await check()
  assert.ok(!v.ok)
  assert.ok(v.problems.includes("/assets/a.js isn't the build's"))
  assert.ok(v.problems.some((p) => /says it runs build/.test(p)))
})

test("a file of the build the site doesn't have fails", async () => {
  const mine = mkdtempSync(join(tmpdir(), 'verify-'))
  writeFileSync(join(mine, 'build.json'), JSON.stringify({ ...build, files: { ...build.files, '/gone.js': sha('x') } }))
  const v = await check({ dist: mine })
  assert.ok(v.problems.includes('/gone.js: 404'))
})

test('a page with another script fails: inline, from elsewhere, from an unknown file, or the build\'s file with a query', async () => {
  for (const [extra, want] of [
    ['<script>steal()</script>', /an inline script that isn't the build's: "steal\(\)"/],
    ['<script src="https://evil.example/x.js"></script>', /loads https:\/\/evil\.example\/x\.js, which isn't a file of the build/],
    ['<script src="/assets/b.js"></script>', /loads http:\/\/127\.0\.0\.1:\d+\/assets\/b\.js, which isn't/],
    ['<script src="/assets/a.js?v=2"></script>', /assets\/a\.js\?v=2, which isn't/],
    // an empty query is another address to a browser, though URL.search reads it as ""
    ['<script src="/assets/a.js?"></script>', /assets\/a\.js\?, which isn't a file of the build/],
    ['<link rel="stylesheet" href="/assets/a.css?">', /assets\/a\.css\?, which isn't a file of the build/],
    ['<template id="app-js"><link rel="modulepreload" href="//evil.example/m.js"></template>', /evil\.example\/m\.js, which isn't/],
    ['<link rel="stylesheet" href="/x.css">', /x\.css, which isn't/],
    // a browser reads rel in any case, split at any ASCII space
    ['<link rel="StyleSheet" href="https://evil.example/x.css">', /evil\.example\/x\.css, which isn't/],
    ['<link rel="icon\tstylesheet" href="https://evil.example/y.css">', /evil\.example\/y\.css, which isn't/],
    ['<link rel="icon\nMODULEPRELOAD" href="https://evil.example/m.js">', /evil\.example\/m\.js, which isn't/],
    ['<script src="/assets/a.js">steal()</script>', /never have/],
  ]) {
    site.page = INDEX.replace('</head>', extra + '</head>')
    const v = await check()
    assert.ok(!v.ok, extra)
    assert.ok(v.problems.some((p) => p.startsWith('/: ') && want.test(p)), `${extra}: ${v.problems}`)
    assert.ok(v.problems.some((p) => p.startsWith('/settings: ')), extra)
  }
})

// pages that read one way to a loose parser and another to a browser, which runs /evil.js from the site (the CSP's 'self'
// allows it): only the tag forms Quilcast's pages use pass (Astra's review of #476)
test('a page that hides a script from a lax reading fails', async () => {
  const asset = '/assets/a.js'
  for (const extra of [
    `<script type="module" data-x=' src="${asset}"' src="/evil.js"></script>`,
    `<script data-x=' type=application/json' src="/evil.js"></script>`,
    `<script data-x=" src=${asset}" src="/evil.js"></script>`,
    `<script/src="/evil.js">${FOLD}</script>`,
    `<svg><script href="/evil.js">${FOLD}</script></svg>`,
    `<SCRIPT src="${asset}"></SCRIPT>`,
    `<script src=${asset}></script>`,
    `<script src="${asset}" src="/evil.js"></script>`,
    `<script type="importmap">{"imports":{}}</script>`,
    `<script src="/evil.js">`,
    '<!--<script type="application/json">--><script src="/evil.js"></script>',
    '<?<script type="application/json">><script src="/evil.js"></script>',
    '<base href="/evil/">',
    '<iframe src="/evil.html"></iframe>',
    '<iframe srcdoc="&lt;script src=/evil.js&gt;&lt;/script&gt;"></iframe>',
    '<object data="/evil.svg"></object>',
    '<meta http-equiv="refresh" content="0;url=/evil.html">',
    "<meta http-equiv='Refresh' content='0;url=/evil.html'>",
    // a browser decodes these but the check doesn't: it asks for /assets/%61.js, not the a.js it checked, and refreshes
    '<script type="module" src="/assets/%61.js"></script>',
    '<link rel="stylesheet" href="/assets/%61.css">',
    '<meta http-equiv="&#82;efresh" content="0;url=/evil.html">',
    '<link rel="&#115;tylesheet" href="/evil.css">',
    '<link rel="stylesheet" href="/assets/&#97;.css">',
    // a <meta> that could refresh or pick another encoding, in any form a browser takes as one
    '<META http-equiv="refresh" content="0;url=/evil.html">',
    '<meta/http-equiv="refresh" content="0;url=/evil.html">',
    '<meta content=">" http-equiv="refresh">',
    '<meta charset="iso-2022-jp">',
    '<meta charset=iso-2022-jp>',
    '<meta charset="utf-8" charset="iso-2022-jp">',
  ]) {
    site.page = INDEX.replace('</head>', extra + '</head>')
    const v = await check()
    assert.ok(!v.ok, extra)
    assert.ok(v.problems.some((p) => p.startsWith('/: ')), `${extra}: ${v.problems}`)
  }
})

test('a page that redirects, isn\'t UTF-8 HTML, comes zstd-compressed or sends a Refresh fails', async () => {
  site.headers = { refresh: '0;url=/evil.html' }
  assert.ok((await check()).problems.some((p) => /\/: a Refresh header/.test(p)))
  reset()
  // a rules file from 'self' has Chrome prerender /evil and run its inline script; a Link can prerender or preload
  // other files too (Astra's review of #476)
  for (const [headers, want] of [
    [{ 'speculation-rules': '"/rules.json"' }, /^\/: a Speculation-Rules header/],
    [{ link: '</evil>; rel=prerender' }, /^\/: a Link header/],
    [{ link: '</assets/a.js>; rel=modulepreload' }, /^\/: a Link header/],
  ]) {
    site.headers = headers
    const v = await check()
    assert.ok(!v.ok && v.problems.some((p) => want.test(p)), `${JSON.stringify(headers)}: ${v.problems}`)
  }
  reset()
  site.type = 'text/html; charset=utf-16le'
  site.page = Buffer.from(INDEX.replace('</head>', '<script src="/evil.js"></script></head>'), 'utf16le')
  assert.ok((await check()).problems.some((p) => /\/: not plain UTF-8 HTML/.test(p)))
  reset()
  site.page = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(INDEX, 'utf16le')])
  assert.ok((await check()).problems.some((p) => /\/: not plain UTF-8 HTML/.test(p)))
  reset()
  // a browser takes a non-ASCII space before "charset" as no charset and goes by the page's <meta>: there an ISO-2022-JP
  // escape turns "<scr\x1b(Bipt" into a script tag that has no "<script" in its bytes (Astra's re-review of #476)
  for (const type of ['text/html;\u00a0charset=utf-8', 'text/html; \u00a0charset=utf-8']) {
    site.type = type
    site.page = INDEX.replace('<head>', '<head><meta charset="iso-2022-jp">').replace('</head>', '<scr\x1b(Bipt src="/evil.js"></script></head>')
    const v = await check()
    assert.ok(v.problems.some((p) => /\/: not plain UTF-8 HTML/.test(p)), `${type}: ${v.problems}`)
    assert.ok(v.problems.some((p) => /iso-2022-jp/.test(p)), `${type}: ${v.problems}`)
    site.page = INDEX
    assert.ok((await check()).problems.some((p) => /\/: not plain UTF-8 HTML/.test(p)), type)
  }
  reset()
  site.page = INDEX.replace('</head>', '<scr\x1b(Bipt src="/evil.js"></script></head>')
  assert.ok((await check()).problems.some((p) => /\/: not plain UTF-8 HTML/.test(p)))
  reset()
  site.type = 'text/html;\tcharset=UTF-8'
  site.page = INDEX.replace('<head>', '<head><meta charset="UTF-8" />')
  assert.deepEqual((await check()).problems, [])
  reset()
  // older Nodes hand zstd over still compressed, so the check would read nothing where a browser runs scripts
  site.headers = { 'content-encoding': 'zstd' }
  assert.ok((await check()).problems.some((p) => /\/: sent as zstd/.test(p)))
  reset()
  // a page the check can't read as HTML from its first byte doesn't pass for having no scripts in sight
  site.page = '\ufeff' + INDEX
  assert.ok((await check()).problems.some((p) => /\/: not plain UTF-8 HTML/.test(p)))
  reset()
  const r = createServer((q, res) => (q.url === '/' ? res.writeHead(302, { location: base + '/' }) : res.writeHead(404)).end())
  const other = await listen(r)
  try {
    const v = await verify({ site: other, dist, pages: ['/'] })
    assert.ok(v.problems.some((p) => /^\/: 302/.test(p)), String(v.problems))
  } finally {
    r.close()
  }
})

test("a CSP that would run other scripts fails, and so does none; a page's data scripts are fine", async () => {
  site.csp = `script-src 'self' 'unsafe-inline'`
  assert.ok((await check()).problems.includes("/: the CSP lets more scripts run: script-src-elem 'unsafe-inline'"))
  site.csp = ''
  assert.ok((await check()).problems.some((p) => /no Content-Security-Policy/.test(p)))
  reset()
  site.page = INDEX.replace('</body>', '<script type="application/json" id="boot">{"x":"\\u003cb>"}</script></body>')
  assert.ok((await check()).ok)
  site.page = INDEX.replace('</body>', '<script type="application/json" id="boot">{"x":"<b>"}</script></body>')
  assert.ok((await check()).problems.some((p) => /with markup in it/.test(p)))
})

test('cspProblems: script-src, its default-src fallback, the -elem/-attr overrides, and several policies', () => {
  const inline = [sha(HEAD)]
  assert.deepEqual(cspProblems(`default-src 'self' ${b64(HEAD)}`, inline), [])
  assert.deepEqual(cspProblems(`script-src 'SELF' ${b64(HEAD)}; style-src *`, inline), [])
  assert.deepEqual(cspProblems(`script-src 'self' ${b64('other')}`, inline), [`the CSP lets more scripts run: script-src-elem ${b64('other')}`, `the CSP lets more scripts run: script-src-attr ${b64('other')}`])
  assert.deepEqual(cspProblems("script-src 'self'; script-src-elem https:", inline), ['the CSP lets more scripts run: script-src-elem https:'])
  assert.deepEqual(cspProblems("img-src *", inline), ["the CSP doesn't limit scripts (script-src-elem)", "the CSP doesn't limit scripts (script-src-attr)"])
  // the first of a repeated directive counts, as in browsers
  assert.deepEqual(cspProblems("script-src 'self'; script-src *", inline), [])
  // a script has to pass every policy, so one strict one is enough
  assert.deepEqual(cspProblems("script-src *, script-src 'self'", inline), [])
  assert.equal(cspProblems("script-src *, script-src 'unsafe-eval'", inline).length, 2)
  // a browser splits at ASCII spaces only, so a no-break space hides this script-src from it (Astra's re-review of #476)
  assert.match(cspProblems("default-src * 'unsafe-inline';\u00a0script-src 'self'", inline)[0], /other than printable ASCII/)
  assert.match(cspProblems("script-src 'self'\u00a0'unsafe-inline'", inline)[0], /other than printable ASCII/)
  assert.deepEqual(cspProblems(`\tscript-src\t'self'\t${b64(HEAD)}\t`, inline), [])
})

test('a CSP with a non-ASCII space fails the page, as Chrome then runs inline handlers', async () => {
  site.csp = "default-src * 'unsafe-inline';\u00a0script-src 'self'"
  assert.ok((await check()).problems.some((p) => /^\/: the CSP has a character other than printable ASCII/.test(p)))
})

test('"http-equiv" as text in a page (a cast, a bio) passes; as an attribute of a <meta> it fails', async () => {
  site.page = INDEX.replace('<div id="app"></div>', '<div id="app"><p>try &#60;meta http-equiv="refresh"&#62; or http-equiv=refresh</p></div>').replace('</body>', '<script type="application/json" id="boot">{"t":"http-equiv \\u003cmeta"}</script></body>')
  assert.deepEqual((await check()).problems, [])
  site.page = INDEX.replace('<head>', '<head><meta name="description" content="a http-equiv=&quot;refresh&quot; > b" />')
  assert.deepEqual((await check()).problems, [])
})

test('/build.json is asked for past any cache', async () => {
  const seen = []
  const s = createServer((q, r) => (seen.push(q.url), r.writeHead(404).end()))
  const at = await listen(s)
  try {
    await verify({ site: at, dist, pages: [] })
  } finally {
    s.close()
  }
  assert.match(seen.find((u) => u.startsWith('/build.json')), /^\/build\.json\?t=\d+$/)
})

test("a site whose /build.json is a page, not a manifest, says it publishes none", async () => {
  site.files['/build.json'] = INDEX
  const v = await check({ dist: undefined, bases })
  assert.ok(!v.ok)
  assert.match(v.problems[0], /\/build\.json: 200, but no build manifest/)
  // JSON that isn't a manifest either (typeof null is 'object')
  site.files['/build.json'] = '{"files":null,"inline":[]}'
  assert.match((await check({ dist: undefined, bases })).problems[0], /\/build\.json: 200, but no build manifest/)
  // against a build of your own it's checked all the same
  assert.deepEqual((await check()).problems, [])
})

test('the CLI runs when started through a symlink (macOS /tmp is /private/tmp) instead of exiting 0 unchecked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'verify-sym-'))
  mkdirSync(join(dir, 'real'))
  symlinkSync(join(dir, 'real'), join(dir, 'link'))
  // a downloaded copy on its own (it imports nothing of the repo), reached through a linked directory and a linked file
  copyFileSync(fileURLToPath(new URL('./verify.mjs', import.meta.url)), join(dir, 'real', 'verify.mjs'))
  symlinkSync(join(dir, 'real', 'verify.mjs'), join(dir, 'v.mjs'))
  for (const script of [join(dir, 'real', 'verify.mjs'), join(dir, 'link', 'verify.mjs'), join(dir, 'v.mjs')]) {
    const r = spawnSync(process.execPath, [script, '--bogus'], { encoding: 'utf8' })
    assert.equal(r.status, 2, script)
    assert.match(r.stderr, /^usage: node verify\.mjs/, script)
  }
})

test('scripts: inline ones by text, others by address, data left out, the links that load code or styles', () => {
  const s = scripts(`<script>a()</script><script type="module" crossorigin src="/a.js"></script><script type="application/ld+json">{}</script><script type="application/json" id="boot">{"x":"\\u003c"}</script><link rel="icon" href="/i.svg" type="image/svg+xml" /><link rel="preconnect" href="https://x.example" crossorigin /><link rel="alternate" type="application/rss+xml" title="a &#38; b" href="https://x.example/rss" /><link rel="modulepreload" crossorigin href="/m.js"><link rel="stylesheet" crossorigin href="/s.css"><script>if (a<b) x('<button>b</button>')</script>`)
  assert.deepEqual(s, { inline: ['a()', `if (a<b) x('<button>b</button>')`], srcs: ['/a.js', '/m.js', '/s.css'], odd: [] })
  assert.deepEqual(scripts('<script type="application/json"><b></script>').odd, ['<script type="application/json"> with markup in it'])
})
