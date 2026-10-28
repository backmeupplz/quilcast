# python3 scripts/shots/compose.py <raw dir> [locale ...]   (run from the repo root, after raw.py)
# Puts each raw shot under its locale's caption (`## Screenshot captions` in appstore/<locale>/listing.md, en-US in
# appstore/listing.md) at every store size, plus the 1024x500 feature graphic with its `## Feature graphic tagline`, in one
# headless Chrome, and checks every frame's layout in the page: the caption takes at most two lines, and every box stays
# 24 px or more from the edges and from the next box. Arabic is laid out right to left. Writes JPEGs to
#   appstore/screenshots/<locale>/<n>.jpg                     iPhone 6.9" (1320x2868)
#   appstore/screenshots/<locale>/duo-outer|duo-inner/<n>.jpg  iPhone Duo (1398x2034 and 2007x2853)
#   fastlane/metadata/android/<Play code>/images/{phone,sevenInch,tenInch}Screenshots/<n>.jpg and featureGraphic.jpg
# and prints a JSON report; exits 1 if any check fails.
# SHOTS_TARGETS='ios phone tab7 tab10' limits it to those sizes (layout.py), e.g. while one has no raw shots yet.
import asyncio, base64, html, json, os, re, subprocess, sys, tempfile, time, urllib.request
import websockets
from layout import TARGETS, LOCALES, frame

raw = os.path.abspath(sys.argv[1])
only = sys.argv[2:] or list(LOCALES)
repo = os.getcwd()
work = tempfile.mkdtemp(prefix='shots-frames-')
QUALITY = 82
INTER = os.path.join(repo, 'node_modules/@fontsource-variable/inter/files')
ICON = os.path.join(repo, 'fastlane/metadata/android/en-US/images/icon.png')
FONTS = "'InterVariable', -apple-system, 'Helvetica Neue', 'Hiragino Sans', 'PingFang SC', 'Apple SD Gothic Neo', 'Geeza Pro', 'Kohinoor Devanagari', 'Thonburi', sans-serif"
# per locale, so Chinese and Japanese captions get their own glyph shapes
CJK = {'zh-Hans': "'PingFang SC'", 'zh-Hant': "'PingFang TC'", 'ja': "'Hiragino Sans'", 'ko': "'Apple SD Gothic Neo'"}
FACES = ''.join(f"@font-face {{ font-family: 'InterVariable'; font-weight: 100 900; src: url('file://{INTER}/inter-{s}-wght-normal.woff2') format('woff2'); unicode-range: {r}; }}\n"
                for s, r in [('latin', 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD'),
                             ('latin-ext', 'U+0100-02AF, U+0304, U+0308, U+0329, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF'),
                             ('cyrillic', 'U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116'),
                             ('cyrillic-ext', 'U+0460-052F, U+1C80-1C88, U+20B4, U+2DE0-2DFF, U+A640-A69F, U+FE2E-FE2F'),
                             ('vietnamese', 'U+0102-0103, U+0110-0111, U+0128-0129, U+0168-0169, U+01A0-01A1, U+01AF-01B0, U+0300-0301, U+0303-0304, U+0308-0309, U+0323, U+0329, U+1EA0-1EF9, U+20AB')])
BG = 'linear-gradient(160deg, #5B3DF5 0%, #4527d6 45%, #2a1a8f 100%)'
CHECK = '''(() => {
  const W = innerWidth, H = innerHeight, out = []
  const box = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom } }
  const cap = document.querySelector('.cap')
  const lines = cap ? Math.round(cap.getBoundingClientRect().height / parseFloat(getComputedStyle(cap).lineHeight)) : 0
  const boxes = [...document.querySelectorAll('[data-box]')].map((el) => ({ n: el.dataset.box, ...box(el) }))
  for (const b of boxes) {
    if (b.l < 24 || b.t < 24 || W - b.r < 24 || H - b.b < 24) out.push(`${b.n} within 24 px of the edge`)
    if (b.r - b.l < 1 || b.b - b.t < 1) out.push(`${b.n} is empty`)
  }
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j]
    const gap = Math.max(b.l - a.r, a.l - b.r, b.t - a.b, a.t - b.b)
    if (gap < 24) out.push(`${a.n} and ${b.n} are ${Math.round(gap)} px apart`)
  }
  for (const el of document.querySelectorAll('[data-box]')) if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) out.push(`${el.dataset.box} overflows (${el.scrollWidth}x${el.scrollHeight} in ${el.clientWidth}x${el.clientHeight})`)
  // the text boxes hug their text: an inline-block as wide as its longest line
  for (const el of document.querySelectorAll('.cap, [data-box="name"]')) {
    const r = document.createRange(); r.selectNodeContents(el)
    // one rect per bidi run (Latin words in Arabic), so a line's width runs from its leftmost rect to its rightmost
    const half = parseFloat(getComputedStyle(el).lineHeight) / 2, rows = []
    for (const x of [...r.getClientRects()].sort((a, b) => a.top - b.top)) {
      const row = rows.find((y) => Math.abs(y.top - x.top) < half)
      if (row) { row.l = Math.min(row.l, x.left); row.r = Math.max(row.r, x.right) } else rows.push({ top: x.top, l: x.left, r: x.right })
    }
    const w = Math.max(...rows.map((y) => y.r - y.l))
    if (el.getBoundingClientRect().width - w > 2) out.push(`${el.dataset.box} is ${Math.round(el.getBoundingClientRect().width - w)} px wider than its text`)
  }
  return { problems: out, lines, font: cap ? parseFloat(getComputedStyle(cap).fontSize) : 0 }
})()'''
# shrink the caption until it takes at most two lines and fits its area
FIT = '''(() => { const c = document.querySelector('.cap'), area = document.querySelector('.area'); let f = parseFloat(getComputedStyle(c).fontSize)
  const lines = () => Math.round(c.getBoundingClientRect().height / parseFloat(getComputedStyle(c).lineHeight))
  while (f > 20 && (lines() > 2 || c.getBoundingClientRect().width > area.clientWidth || c.getBoundingClientRect().height > area.clientHeight)) { f -= 2; c.style.fontSize = f + 'px' }
  // a wrapped line leaves its box as wide as the area; narrowing it re-wraps balanced text (Arabic, Korean), so keep the
  // browser's own breaks as explicit lines and let the box hug the longest one
  const t = c.firstChild, s = t.data, r = document.createRange(), half = parseFloat(getComputedStyle(c).lineHeight) / 2, rows = ['']
  let top = null
  for (let i = 0; i < s.length; i++) {
    r.setStart(t, i); r.setEnd(t, i + 1)
    const y = r.getBoundingClientRect().top
    if (s[i].trim() && top !== null && y - top > half) rows.push('')
    if (s[i].trim() && (top === null || y - top > half)) top = y
    rows[rows.length - 1] += s[i]
  }
  c.textContent = rows.map((x) => x.trim()).join('\\n')
  c.style.whiteSpace = 'pre'
  return f })()'''


def sections(path):
    out, name = {}, None
    for line in open(path, encoding='utf8').read().split('\n'):
        m = re.match(r'^## (.+?)(?: \(max \d+\))?$', line)
        if m:
            name = m[1]
            out[name] = []
        elif name:
            out[name].append(line)
    return {k: '\n'.join(v).strip() for k, v in out.items()}


def texts(locale):
    s = sections(os.path.join(repo, 'appstore', 'listing.md' if locale == 'en-US' else f'{locale}/listing.md'))
    captions = [re.sub(r'^\d+\.\s*', '', c).strip() for c in s['Screenshot captions'].split('\n') if c.strip()]
    assert len(captions) == 5, f'{locale}: {len(captions)} captions'
    return captions, s['Feature graphic tagline']


def page(locale, rtl, body, W, H):
    lang = LOCALES[locale][0]
    fonts = (CJK[lang] + ', ' if lang in CJK else '') + FONTS
    return f'''<!doctype html><html lang="{lang}" dir="{'rtl' if rtl else 'ltr'}"><meta charset="utf-8"><style>{FACES}
html, body {{ margin: 0; width: {W}px; height: {H}px; overflow: hidden; }}
body {{ background: {BG}; font-family: {fonts}; color: #fff; position: relative; -webkit-font-smoothing: antialiased; }}
</style><body>{body}</body></html>'''


def shot_frame(target, locale, rtl, caption, img):
    f = frame(target)
    fs = round(f['W'] * (0.072 if target in ('ios', 'phone', 'duo-outer') else 0.058))
    lh = 1.4 if LOCALES[locale][0].startswith('zh') else 1.18  # PingFang's glyphs run taller than a 1.18 line
    body = f'''<div class="area" style="position:absolute; left:{f['m']}px; right:{f['m']}px; top:{round(f['m'] * 1.1)}px; height:{f['cap'] - round(f['m'] * 1.1)}px; display:flex; align-items:center; justify-content:center;">
<div class="cap" data-box="caption" style="display:inline-block; font-size:{fs}px; line-height:{lh}; font-weight:750; letter-spacing:-0.01em; text-align:center; text-wrap:balance; max-width:100%;">{html.escape(caption)}</div></div>
<img data-box="screenshot" src="file://{img}" style="position:absolute; left:{f['m']}px; top:{f['top']}px; width:{f['iw']}px; height:{f['ih']}px; border-radius:{round(f['iw'] * 0.045)}px; box-shadow:0 {round(f['m'] * 0.3)}px {round(f['m'] * 0.9)}px rgb(10 0 60 / 0.45); display:block;">'''
    return page(locale, rtl, body, f['W'], f['H'])


def feature(locale, rtl, tagline):
    body = f'''<div style="position:absolute; inset:0; display:flex; align-items:center; gap:52px; padding:0 72px; box-sizing:border-box;">
<img data-box="icon" src="file://{ICON}" style="width:180px; height:180px; border-radius:40px; box-shadow:0 18px 50px rgb(10 0 60 / 0.45); flex:none;">
<div class="area" style="flex:1; min-width:0; height:300px; display:flex; flex-direction:column; justify-content:center; align-items:flex-start; gap:28px;">
<div data-box="name" dir="ltr" style="display:inline-block; font-size:96px; line-height:1.25; font-weight:800; letter-spacing:-0.03em; font-family:'InterVariable', -apple-system, sans-serif;">Quilcast</div>
<div class="cap" data-box="tagline" style="display:inline-block; font-size:36px; line-height:1.3; font-weight:500; opacity:0.92; text-wrap:balance; max-width:100%;">{html.escape(tagline)}</div></div></div>'''
    return page(locale, rtl, body, 1024, 500)


def jobs():
    for loc in only:
        ui, play = LOCALES[loc]
        captions, tagline = texts(loc)
        rtl = ui == 'ar'
        for target in os.environ.get('SHOTS_TARGETS', '').split() or TARGETS:
            f = frame(target)
            for n in range(1, 6):
                img = os.path.join(raw, ui, f"{f['css']}x{f['css_h']}", f'{n}.png')
                if target == 'ios':
                    out = os.path.join(repo, 'appstore/screenshots', loc, f'{n}.jpg')
                elif target.startswith('duo'):
                    out = os.path.join(repo, 'appstore/screenshots', loc, target, f'{n}.jpg')
                else:
                    sub = {'phone': 'phoneScreenshots', 'tab7': 'sevenInchScreenshots', 'tab10': 'tenInchScreenshots'}[target]
                    out = os.path.join(repo, 'fastlane/metadata/android', play, 'images', sub, f'{n}.jpg')
                yield out, (target, f['W'], f['H']), shot_frame(target, loc, rtl, captions[n - 1], img), img
        yield os.path.join(repo, 'fastlane/metadata/android', play, 'images/featureGraphic.jpg'), ('feature', 1024, 500), feature(loc, rtl, tagline), None


port = 9900 + (os.getpid() % 50)
prof = tempfile.mkdtemp(prefix='shots-chrome-')
chrome = subprocess.Popen(['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '--headless=new', f'--remote-debugging-port={port}', f'--user-data-dir={prof}',
                           '--use-mock-keychain', '--no-first-run', '--remote-allow-origins=*', '--hide-scrollbars', '--allow-file-access-from-files', 'about:blank'],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
report, bad = [], 0


async def main():
    global bad
    tabs = None
    for _ in range(80):
        time.sleep(0.25)
        try:
            tabs = json.load(opener.open(f'http://127.0.0.1:{port}/json'))
            if any(t['type'] == 'page' for t in tabs):
                break
        except Exception:
            pass
    pg = next(t for t in tabs if t['type'] == 'page')
    async with websockets.connect(pg['webSocketDebuggerUrl'], proxy=None, max_size=None) as ws:
        n = 0

        async def send(method, params={}):
            nonlocal n
            n += 1
            await ws.send(json.dumps({'id': n, 'method': method, 'params': params}))
            while True:
                m = json.loads(await ws.recv())
                if m.get('id') == n:
                    return m

        async def js(expr):
            r = await send('Runtime.evaluate', {'expression': expr, 'returnByValue': True, 'awaitPromise': True})
            return r.get('result', {}).get('result', {}).get('value')

        size = None
        for i, (out, (kind, W, H), doc, img) in enumerate(jobs()):
            if img and not os.path.exists(img):
                report.append({'out': os.path.relpath(out, repo), 'problems': [f'missing raw shot {img}']})
                bad += 1
                continue
            if size != (W, H):
                await send('Emulation.setDeviceMetricsOverride', {'width': W, 'height': H, 'deviceScaleFactor': 1, 'mobile': False})
                size = (W, H)
            path = os.path.join(work, f'{i}.html')
            open(path, 'w', encoding='utf8').write(doc)
            await send('Page.navigate', {'url': 'file://' + path})
            for _ in range(50):
                await asyncio.sleep(0.1)
                if await js("document.readyState === 'complete' && [...document.images].every((i) => i.complete && i.naturalWidth)"):
                    break
            await js('document.fonts.ready.then(() => 1)')
            await js(FIT)
            r = await js(CHECK)
            if kind != 'feature' and r['lines'] > 2:
                r['problems'].append(f"caption takes {r['lines']} lines")
            r['out'] = os.path.relpath(out, repo)
            report.append({k: r[k] for k in ('out', 'problems', 'lines', 'font')})
            bad += bool(r['problems'])
            s = await send('Page.captureScreenshot', {'format': 'jpeg', 'quality': QUALITY, 'clip': {'x': 0, 'y': 0, 'width': W, 'height': H, 'scale': 1}})
            os.makedirs(os.path.dirname(out), exist_ok=True)
            open(out, 'wb').write(base64.b64decode(s['result']['data']))


try:
    asyncio.run(main())
finally:
    chrome.kill()
json.dump(report, open(os.path.join(work, 'report.json'), 'w'), ensure_ascii=False, indent=1)
print(json.dumps({'frames': len(report), 'failed': bad, 'report': os.path.join(work, 'report.json'), 'problems': [r for r in report if r['problems']][:20]}, ensure_ascii=False))
sys.exit(1 if bad else 0)
