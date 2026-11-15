// Quilcast WASM's shell: it loads the module (app.wasm, built from wasm/src) and hands it the browser. Everything the
// app does and draws is decided in the module; this file only applies its page operations, forwards events, and
// reaches the APIs wasm can't call by itself (fetch, storage, WebCrypto, history, timers). No markup is ever parsed.
const root = document.getElementById('app')
const nodes = new Map([[0, root]])
const enc = new TextEncoder()
const dec = new TextDecoder()
let mem, ex
let busy = false
const waiting = []

const str = (p, l) => dec.decode(new Uint8Array(mem.buffer, p, l))
const bytes = (p, l) => new Uint8Array(mem.buffer, p, l).slice()
// bytes handed to the module go into memory it allocates (and frees)
const give = (b) => {
  const p = ex.q_alloc(b.length)
  new Uint8Array(mem.buffer, p, b.length).set(b)
  return p
}
const pack = (v) => {
  if (v == null) return -1n
  const b = typeof v === 'string' ? enc.encode(v) : v
  return (BigInt(give(b)) << 32n) | BigInt(b.length)
}
// calls into the module never nest: an event that fires while it runs (a focused node taken off the page blurs) waits
function call(f) {
  if (busy) return void waiting.push(f)
  busy = true
  try {
    f()
  } catch (e) {
    crash(e)
  } finally {
    busy = false
  }
  if (waiting.length) call(waiting.shift())
}
function crash(e) {
  console.error(e)
  const p = document.createElement('p')
  p.className = 'crash'
  p.textContent = 'Something went wrong. Reload the page to start again.'
  document.body.append(p)
}
const done = (id, code, b = new Uint8Array()) => call(() => ex.q_done(id, code, give(b), b.length))
const send = (f, s) => {
  const b = enc.encode(s)
  f(give(b), b.length)
}

// --- the page ---

const SVG = new Set(['svg', 'path', 'circle', 'g'])
const TYPES = ['', 'click', 'input', 'submit', 'keydown', 'change']
const seen = new IntersectionObserver((es) => {
  for (const e of es) if (e.isIntersecting && e.target.qid !== undefined) call(() => send((p, l) => ex.q_event(e.target.qid, 6, p, l), ''))
}, { rootMargin: '800px 0px' })

function listen(id, kind) {
  const el = nodes.get(id)
  if (kind === 6) return void ((el.qid = id), seen.observe(el))
  el.addEventListener(TYPES[kind], (e) => {
    if (kind === 1) {
      // a link or control inside a clickable card does its own thing
      const inner = e.target.closest?.('a,button,input,textarea,select,label,video')
      if (inner && inner !== el && el.contains(inner)) return
      e.stopPropagation()
    }
    if (kind === 3) e.preventDefault()
    let v = ''
    if (kind === 2 || kind === 5) v = el.type === 'checkbox' || el.type === 'radio' ? String(el.checked) : el.value
    // files picked: kept here, the module hears what they are and reads them in pieces (file_read)
    if (kind === 5 && el.type === 'file') (v = JSON.stringify([...el.files].map(keepFile))), (el.value = '')
    // where the caret is (in UTF-16 units), for @mention suggestions
    if (kind === 2 && el.hasAttribute('data-caret')) v = `${el.selectionStart ?? v.length}|${v}`
    if (kind === 4) {
      if (e.isComposing) return
      v = e.key + (e.ctrlKey || e.metaKey ? '+mod' : '')
      if (v === 'Enter+mod') e.preventDefault()
      // Backspace in an empty post takes the post away and moves the focus up: it mustn't then delete there too
      if (v === 'Backspace' && el.value === '') e.preventDefault()
    }
    call(() => send((p, l) => ex.q_event(id, kind, p, l), v))
  })
  // a post's caret, wherever it moves (a click, the arrow keys, the focus coming back), is told as its input is, so
  // an emoji goes where it is and the module knows which post is being written
  if (kind === 2 && el.hasAttribute('data-caret')) {
    const tell = () => call(() => send((p, l) => ex.q_event(id, kind, p, l), `${el.selectionStart ?? el.value.length}|${el.value}`))
    el.addEventListener('focus', tell)
    el.addEventListener('click', tell)
    el.addEventListener('keyup', (e) => /^(Arrow|Home|End|Page)/.test(e.key) && tell())
  }
}

function apply(p, l) {
  const v = new DataView(mem.buffer, p, l)
  let i = 0
  let focus
  // textareas whose text the module changed in this pass: one keeps its caret where the module says even if it has
  // the focus already (a mention picked with a button that doesn't take the focus)
  const valued = new Set()
  const u32 = () => ((i += 4), v.getUint32(i - 4, true))
  const s = () => {
    const n = u32()
    i += n
    return dec.decode(new Uint8Array(mem.buffer, p + i - n, n))
  }
  while (i < l) {
    const op = v.getUint8(i++)
    const id = u32()
    switch (op) {
      case 1: {
        const tag = s()
        nodes.set(id, SVG.has(tag) ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag))
        break
      }
      case 2:
        nodes.set(id, document.createTextNode(s()))
        break
      case 3: {
        const n = s()
        const val = s()
        if (n === 'autofocus') focus = nodes.get(id)
        else nodes.get(id).setAttribute(n, val)
        break
      }
      case 4:
        nodes.get(id).removeAttribute(s())
        break
      case 5:
        nodes.get(id).data = s()
        break
      case 6: {
        const el = nodes.get(id)
        const n = u32()
        for (let k = 0; k < n; k++) {
          const c = nodes.get(u32())
          const at = el.childNodes[k]
          if (at !== c) el.insertBefore(c, at || null)
        }
        while (el.childNodes.length > n) el.lastChild.remove()
        break
      }
      case 7: {
        const el = nodes.get(id)
        if (el?.qid !== undefined) seen.unobserve(el)
        nodes.delete(id)
        break
      }
      case 8:
        listen(id, v.getUint8(i++))
        break
      case 9: {
        const n = s()
        const val = s()
        const el = nodes.get(id)
        if (n === 'checked') el.checked = val === 'true'
        else if (el[n] !== val) {
          el[n] = val
          if (n === 'value') valued.add(el)
        }
        break
      }
      default:
        throw new Error(`bad op ${op}`)
    }
  }
  // one the module puts the focus on gets its caret back where the module says (after an emoji or a mention)
  if (focus?.isConnected && (document.activeElement !== focus || valued.has(focus))) {
    focus.focus()
    const at = focus.getAttribute('data-sel')
    if (at !== null && focus.setSelectionRange) focus.setSelectionRange(+at, +at)
  }
}

// --- the key vault: IndexedDB, values sealed with AES-GCM under a key the browser made non-extractable ---

const db = new Promise((ok, no) => {
  const r = indexedDB.open('quilcast-wasm', 1)
  r.onupgradeneeded = () => r.result.createObjectStore('v')
  r.onsuccess = () => ok(r.result)
  r.onerror = () => no(r.error)
})
const tx = (mode, f) =>
  db.then((d) => new Promise((ok, no) => {
    const t = d.transaction('v', mode)
    const r = f(t.objectStore('v'))
    t.oncomplete = () => ok(r.result)
    t.onerror = () => no(t.error)
  }))
const idbGet = (k) => tx('readonly', (s) => s.get(k))
const idbPut = (k, v) => tx('readwrite', (s) => s.put(v, k))
const idbDel = (k) => tx('readwrite', (s) => s.delete(k))
let aes
const sealer = () =>
  (aes ||= idbGet('aes').then((k) => k || crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']).then((k) => idbPut('aes', k).then(() => k))))
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

// --- files picked for a cast, kept here by id; the module reads them in pieces and drops them when done ---
const files = new Map()
const urls = new Map()
let fileIds = 0
function keepFile(f) {
  files.set(++fileIds, f)
  return { id: fileIds, type: f.type, size: f.size, name: f.name || '' }
}

const q = {
  ops: apply,
  fetch(id, mp, ml, up, ul, bp, bl, cp, cl) {
    const method = str(mp, ml)
    const url = str(up, ul)
    // headers come as lines of "name: value"; a line that is only a value is the content type
    const headers = {}
    for (const line of str(cp, cl).split('\n')) {
      const i = line.indexOf(': ')
      if (i > 0) headers[line.slice(0, i)] = line.slice(i + 2)
      else if (line) headers['content-type'] = line
    }
    const body = bl ? bytes(bp, bl) : undefined
    fetch(url, { method, body, headers, referrerPolicy: 'no-referrer' })
      .then(async (r) => [r.status, new Uint8Array(await r.arrayBuffer())])
      .catch(() => [0, new Uint8Array()])
      .then(([status, b]) => done(id, status, b))
  },
  store_get: (kp, kl) => pack(localStorage.getItem(str(kp, kl))),
  store_set: (kp, kl, vp, vl) => {
    try {
      localStorage.setItem(str(kp, kl), str(vp, vl))
    } catch {}
  },
  store_del: (kp, kl) => localStorage.removeItem(str(kp, kl)),
  vault_get(id, kp, kl) {
    const k = str(kp, kl)
    Promise.all([sealer(), idbGet('x:' + k)])
      .then(([key, box]) => (box ? crypto.subtle.decrypt({ name: 'AES-GCM', iv: box.iv }, key, box.ct) : Promise.reject()))
      .then((b) => done(id, 1, new Uint8Array(b)), () => done(id, 0))
  },
  vault_set(id, kp, kl, vp, vl) {
    const k = str(kp, kl)
    const v = bytes(vp, vl)
    const iv = crypto.getRandomValues(new Uint8Array(12))
    sealer()
      .then((key) => crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, v))
      .then((ct) => idbPut('x:' + k, { iv, ct }))
      .then(() => done(id, 1), (e) => (console.error(`vault: ${e?.name}: ${e?.message}`), done(id, 0)))
  },
  vault_del: (kp, kl) => void idbDel('x:' + str(kp, kl)).catch(() => {}),
  // the signing key: a non-extractable Ed25519 key, so the page can sign with it but nothing can read it out
  ed_new(id) {
    crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])
      .then(async (k) => {
        const pub = new Uint8Array(await crypto.subtle.exportKey('raw', k.publicKey))
        await idbPut('ed:' + hex(pub), k)
        return pub
      })
      .then((pub) => done(id, 1, pub), (e) => (console.error(`key: ${e?.name}: ${e?.message}`), done(id, 0)))
  },
  ed_sign(id, pp, pl, mp, ml) {
    const pub = hex(bytes(pp, pl))
    const m = bytes(mp, ml)
    idbGet('ed:' + pub)
      .then((k) => (k ? crypto.subtle.sign({ name: 'Ed25519' }, k.privateKey, m) : Promise.reject()))
      .then((s) => done(id, 1, new Uint8Array(s)), () => done(id, 0))
  },
  ed_drop: (pp, pl) => void idbDel('ed:' + hex(bytes(pp, pl))).catch(() => {}),
  random(p, l) {
    for (let o = 0; o < l; o += 65536) crypto.getRandomValues(new Uint8Array(mem.buffer, p + o, Math.min(65536, l - o)))
  },
  now: () => Date.now(),
  nav: (up, ul, replace) => history[replace ? 'replaceState' : 'pushState'](null, '', str(up, ul)),
  back: () => history.back(),
  location: () => pack(location.pathname + location.search),
  timer: (id, ms) => void setTimeout(() => done(id, 1), ms),
  log: (p, l) => console.error(str(p, l)),
  title: (p, l) => void (document.title = str(p, l)),
  scroll: (y) => scrollTo(0, y),
  scroll_top: () => scrollY,
  confirm: (p, l) => (confirm(str(p, l)) ? 1 : 0),
  copy: (p, l) => void navigator.clipboard?.writeText(str(p, l)).catch(() => {}),
  origin: () => pack(location.origin),
  file_read(id, f, off, len) {
    const b = files.get(f)
    if (!b) return void done(id, 0)
    b.slice(off, off + len).arrayBuffer().then((a) => done(id, 1, new Uint8Array(a)), () => done(id, 0))
  },
  file_drop(f) {
    if (urls.has(f)) URL.revokeObjectURL(urls.get(f))
    urls.delete(f)
    files.delete(f)
  },
  file_url(f) {
    if (!files.has(f)) return -1n
    if (!urls.has(f)) urls.set(f, URL.createObjectURL(files.get(f)))
    return pack(urls.get(f))
  },
  // a photo drawn again by the browser's own decoder at 2048 px at most, so its EXIF (place, device) is gone and it
  // stands the right way up: JPEG, or PNG when a pixel is see-through (src/write.ts shrink)
  shrink(id, f) {
    const file = files.get(f)
    if (!file) return void done(id, 0)
    createImageBitmap(file)
      .then((img) => {
        const k = Math.min(1, 2048 / Math.max(img.width, img.height))
        const c = Object.assign(document.createElement('canvas'), { width: Math.round(img.width * k), height: Math.round(img.height * k) })
        const ctx = c.getContext('2d', { willReadFrequently: true })
        ctx.drawImage(img, 0, 0, c.width, c.height)
        const px = file.type === 'image/jpeg' ? null : ctx.getImageData(0, 0, c.width, c.height).data
        let alpha = false
        for (let i = 3; px && i < px.length && !alpha; i += 4) alpha = px[i] < 255
        return new Promise((ok, no) => c.toBlob((b) => (b ? ok(b) : no()), alpha ? 'image/png' : 'image/jpeg', 0.88))
      })
      .then((b) => done(id, 1, enc.encode(JSON.stringify(keepFile(b)))), () => done(id, 0))
  },
  // a datetime-local value read as local time, and a time written back as one (kind 1) or for reading (kind 0)
  time_parse(p, l) {
    const t = new Date(str(p, l)).getTime()
    return Number.isFinite(t) ? t : -1
  },
  time_text(ms, kind) {
    const d = new Date(ms)
    const two = (n) => String(n).padStart(2, '0')
    return pack(kind ? `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}` : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }))
  },
  // AES-GCM keys made from bytes the module derives once (the drafts key), kept non-extractable in IndexedDB
  aes_import(id, kp, kl, rp, rl) {
    const k = str(kp, kl)
    crypto.subtle.importKey('raw', bytes(rp, rl), 'AES-GCM', false, ['encrypt', 'decrypt'])
      .then((key) => idbPut('aes:' + k, key))
      .then(() => done(id, 1), () => done(id, 0))
  },
  aes_has(id, kp, kl) {
    idbGet('aes:' + str(kp, kl)).then((key) => done(id, key ? 1 : 0), () => done(id, 0))
  },
  // sealed: the 12-byte IV, then the ciphertext; opened: from the same
  aes_seal(id, kp, kl, dp, dl) {
    const d = bytes(dp, dl)
    const iv = crypto.getRandomValues(new Uint8Array(12))
    idbGet('aes:' + str(kp, kl))
      .then((key) => (key ? crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, d) : Promise.reject()))
      .then((ct) => {
        const out = new Uint8Array(12 + ct.byteLength)
        out.set(iv)
        out.set(new Uint8Array(ct), 12)
        done(id, 1, out)
      }, () => done(id, 0))
  },
  aes_open(id, kp, kl, dp, dl) {
    const d = bytes(dp, dl)
    idbGet('aes:' + str(kp, kl))
      .then((key) => (key && d.length > 12 ? crypto.subtle.decrypt({ name: 'AES-GCM', iv: d.subarray(0, 12) }, key, d.subarray(12)) : Promise.reject()))
      .then((b) => done(id, 1, new Uint8Array(b)), () => done(id, 0))
  },
  aes_drop: (kp, kl) => void idbDel('aes:' + str(kp, kl)).catch(() => {}),
  // push notifications (src/alerts.rs): what the browser has, the permission prompt (straight from a click, which
  // Firefox requires) and the subscription, made through the service worker (sw.js, the same as quilcast.com's)
  push_get(id) {
    if (!('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window)) return void done(id, 0)
    navigator.serviceWorker.getRegistration('/sw.js')
      .then((r) => r?.pushManager.getSubscription())
      .catch(() => null)
      .then((sub) => done(id, 1, enc.encode(JSON.stringify({ perm: Notification.permission, sub: sub ? sub.toJSON() : null }))))
  },
  push_ask(id) {
    if (!('Notification' in window)) return void done(id, 0)
    Notification.requestPermission().then((p) => done(id, p === 'granted' ? 1 : 0), () => done(id, 0))
  },
  push_sub(id, kp, kl) {
    const key = bytes(kp, kl)
    // a browser without a reachable push service never answers, so this gives up instead of spinning forever
    const timeout = new Promise((_, no) => setTimeout(() => no(new Error("This browser's push service didn't answer. Try again in a minute.")), 20000))
    const sub = navigator.serviceWorker.register('/sw.js')
      .then((reg) => navigator.serviceWorker.ready.then(() => reg.pushManager.getSubscription().then((had) => had || reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }))))
    Promise.race([sub, timeout]).then((s) => done(id, 1, enc.encode(JSON.stringify(s.toJSON()))), (e) => done(id, 0, enc.encode(String(e?.message || ''))))
  },
}

// same-origin links move inside the app instead of loading the page again
document.addEventListener('click', (e) => {
  const a = e.target.closest?.('a')
  if (!a || a.target || a.origin !== location.origin || a.pathname.startsWith('/api/') || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button || e.defaultPrevented) return
  e.preventDefault()
  call(() => send((p, l) => ex.q_nav(p, l, 0), a.pathname + a.search))
})
// a tapped push notification (sw.js) asks whether the app is here (yes, while the worker still waits), then opens
// its page in this window as the account it was for
navigator.serviceWorker?.addEventListener('message', (e) => {
  if (e.data?.probe) return void (ex && Date.now() <= e.data.until && e.ports[0]?.postMessage(1))
  const path = e.data?.open
  if (!ex || typeof path !== 'string' || !/^\/(?!\/)/.test(path)) return
  const fid = Number.isSafeInteger(e.data.fid) ? e.data.fid : 0
  call(() => send((p, l) => ex.q_open(p, l, fid), path))
})
addEventListener('popstate', () => call(() => send((p, l) => ex.q_nav(p, l, 1), location.pathname + location.search)))
history.scrollRestoration = 'manual'

try {
  const { instance } = await WebAssembly.instantiateStreaming(fetch(new URL('app.wasm', import.meta.url)), { q })
  ex = instance.exports
  mem = ex.memory
  root.textContent = ''
  call(() => ex.q_start())
} catch (e) {
  crash(e)
}
