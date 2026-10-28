# python3 scripts/shots/raw.py <base url> <out dir> <network file> <language> [target ...]
# One headless Chrome: the five store screens (home feed, a MySpace-style profile, the mini apps directory, the theme
# picker, the home feed in the Vaporwave theme) in one UI language at each target's CSS viewport (layout.py), as
# <out>/<language>/<css w>x<css h>/<n>.png. The page runs as the iOS app (its user agent), signed out.
# The first run records every fetch/XHR answer in <network file>; later runs answer the same requests from it (and add
# any they hadn't seen), so every language and size shows the same casts; pick.py chooses the home feed's casts. Run it against `npm run build && npm start`, sequentially.
# Needs Python websockets (user site-packages, so no -I) and Google Chrome.
import asyncio, base64, json, os, subprocess, sys, tempfile, time, urllib.request
import websockets
from layout import TARGETS, frame

base, out, netfile, lang = sys.argv[1:5]
targets = sys.argv[5:] or list(TARGETS)
port = 9400 + (os.getpid() % 500)
prof = tempfile.mkdtemp(prefix='shots-chrome-')
chrome = subprocess.Popen(['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '--headless=new', f'--remote-debugging-port={port}',
                           f'--user-data-dir={prof}', '--use-mock-keychain', '--no-first-run', '--remote-allow-origins=*', '--hide-scrollbars',
                           f'--lang={lang}', 'about:blank'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
SETTINGS = {'lang': lang, 'theme': 'light'}
PROFILE = 'kenny'  # the MySpace-style profile: a well-known account with a look made in Quilcast
UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 QuilcastApp/1.0.1 (iOS)'
net = json.load(open(netfile)) if os.path.exists(netfile) else {}
record = not net
# images and fonts settle before each shot: every <img> on screen has loaded and decoded (or 15 s went by)
ON_SCREEN = '[...document.images].filter((i) => { const r = i.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && r.width > 0 })'
SETTLE = f'''new Promise((ok) => {{ const t0 = Date.now(); const f = () => {{ const imgs = {ON_SCREEN}; if (imgs.every((i) => i.complete && i.naturalWidth > 0) || Date.now() - t0 > 15000) ok(imgs.length); else setTimeout(f, 200) }}; f() }})'''
UNLOADED = f'{ON_SCREEN}.filter((i) => !(i.complete && i.naturalWidth > 0)).map((i) => i.src.slice(0, 100))'
# the build keeps only -webkit-backdrop-filter, which Chrome ignores, so the tab bar would show the feed under it
# sharp; the iPhone's blurred 88% bar looks solid, so the shots draw it solid (on the element: the CSP blocks <style>)
SOLID_BARS = "document.querySelectorAll('.tabbar').forEach((n) => n.style.setProperty('background', 'var(--bar, var(--bg))', 'important')); 1"
problems = []


def key(req):
    return req['method'] + ' ' + req['url'] + (' ' + req['postData'] if req.get('postData') else '')


async def main():
    tabs = None
    for _ in range(80):
        time.sleep(0.25)
        try:
            tabs = json.load(opener.open(f'http://127.0.0.1:{port}/json'))
            if any(t['type'] == 'page' for t in tabs):
                break
        except Exception:
            pass
    page = next(t for t in tabs if t['type'] == 'page')
    async with websockets.connect(page['webSocketDebuggerUrl'], proxy=None, max_size=None) as ws:
        n, waiting, live = 0, {}, set()

        async def send(method, params={}):
            nonlocal n
            n += 1
            i = n
            waiting[i] = asyncio.get_running_loop().create_future()
            await ws.send(json.dumps({'id': i, 'method': method, 'params': params}))
            try:
                return await waiting[i]
            finally:
                del waiting[i]

        async def paused(p):
            req, rid = p['request'], p['requestId']
            k = key(req)
            if 'responseStatusCode' in p:  # response stage: keep the answer, let it through
                if p['responseStatusCode'] < 400:
                    body = await send('Fetch.getResponseBody', {'requestId': rid})
                    if 'result' in body:
                        r = body['result']
                        # the body comes decoded, so it goes back without its encoding and length
                        headers = [h for h in p.get('responseHeaders', []) if h['name'].lower() not in ('content-encoding', 'content-length')]
                        net[k] = {'status': p['responseStatusCode'], 'headers': headers,
                                  'body': r['body'] if r['base64Encoded'] else base64.b64encode(r['body'].encode()).decode()}
                await send('Fetch.continueRequest', {'requestId': rid})
            elif k in net:
                a = net[k]
                await send('Fetch.fulfillRequest', {'requestId': rid, 'responseCode': a['status'], 'responseHeaders': a['headers'], 'body': a['body']})
            else:  # not recorded yet: fetch it and keep its answer for the next runs
                live.add(k)
                await send('Fetch.continueRequest', {'requestId': rid, 'interceptResponse': True})

        async def reader():
            async for raw in ws:
                m = json.loads(raw)
                if 'id' in m and m['id'] in waiting:
                    waiting[m['id']].set_result(m)
                elif m.get('method') == 'Fetch.requestPaused':
                    asyncio.create_task(paused(m['params']))

        task = asyncio.create_task(reader())

        async def js(expr):
            r = await send('Runtime.evaluate', {'expression': expr, 'returnByValue': True, 'awaitPromise': True})
            return r.get('result', {}).get('result', {}).get('value')

        async def go(path, wait):
            await send('Page.navigate', {'url': base + path})
            await asyncio.sleep(wait)

        async def shot(dest, name):
            await js(SETTLE)
            await js('document.fonts.ready.then(() => 1)')
            await asyncio.sleep(0.8)
            await js('getSelection()?.removeAllRanges(); 1')  # a tap can leave a name selected
            await js(SOLID_BARS)
            await asyncio.sleep(0.2)
            bad = await js(UNLOADED)
            if not (await js('location.href') or '').startswith(base):  # the app didn't load (e.g. the server went away)
                problems.append(f'{dest}/{name}.png: not the app: ' + str(await js('location.href')))
            if bad:
                problems.append(f'{dest}/{name}.png: images not loaded: {bad}')
            s = await send('Page.captureScreenshot', {'format': 'png'})
            open(os.path.join(dest, f'{name}.png'), 'wb').write(base64.b64decode(s['result']['data']))

        stage = 'Response' if record else 'Request'
        await send('Fetch.enable', {'patterns': [{'urlPattern': '*', 'resourceType': t, 'requestStage': stage} for t in ('XHR', 'Fetch')]})
        await send('Network.setUserAgentOverride', {'userAgent': UA})
        report = {}
        for target in targets:
            f = frame(target)
            dest = os.path.join(out, lang, f"{f['css']}x{f['css_h']}")
            os.makedirs(dest, exist_ok=True)
            mobile = f['css'] < 700
            await send('Emulation.setDeviceMetricsOverride', {'width': f['css'], 'height': f['css_h'], 'deviceScaleFactor': f['scale'], 'mobile': mobile})
            await send('Emulation.setTouchEmulationEnabled', {'enabled': mobile})
            await go('/', 1.5)
            await js(f'localStorage.clear(); localStorage.setItem("quilcast:settings", {json.dumps(json.dumps(SETTINGS))}); 1')
            wait = 9 if record else 5
            await go('/', wait)
            await shot(dest, '1')
            await go('/u/' + PROFILE, wait)
            await shot(dest, '2')
            await go('/apps', wait)
            await shot(dest, '3')
            await go('/settings', wait - 1)
            # the theme picker on its built-in tab, scrolled to the top of the screen
            await js("document.querySelector('.th-tabs button:nth-child(2)')?.click(); 1")
            await asyncio.sleep(1.5)
            await js("document.querySelector('.th-now')?.scrollIntoView({ block: 'start' }); scrollBy(0, -115); 1")
            await asyncio.sleep(1)
            await shot(dest, '4')
            await js("[...document.querySelectorAll('.th-row')].find((r) => r.querySelector('.th-name b')?.textContent === 'Vaporwave')?.querySelector('.btns .btn')?.click(); 1")
            await asyncio.sleep(1)
            report[target] = await js("!!localStorage.getItem('quilcast:theme')")
            await asyncio.sleep(1.5)
            await go('/', wait + 1)
            await shot(dest, '5')
        task.cancel()
        if record and not any('/feed/trending' in k for k in net):
            sys.exit(f'no home feed came through from {base}; nothing recorded')
        if record or live:
            json.dump(net, open(netfile + '.tmp', 'w'))
            os.replace(netfile + '.tmp', netfile)
        print(json.dumps({'lang': lang, 'vaporwave': report, 'problems': problems, 'recorded': len(net) if record else None, 'live': sorted(live)[:8], 'live_count': len(live)}))
        if problems or not all(report.values()):
            sys.exit(1)


try:
    asyncio.run(asyncio.wait_for(main(), 600))
finally:
    chrome.kill()
