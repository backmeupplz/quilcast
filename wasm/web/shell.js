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
    if (kind === 4) {
      if (e.isComposing) return
      v = e.key + (e.ctrlKey || e.metaKey ? '+mod' : '')
      if (v === 'Enter+mod') e.preventDefault()
    }
    call(() => send((p, l) => ex.q_event(id, kind, p, l), v))
  })
}

function apply(p, l) {
  const v = new DataView(mem.buffer, p, l)
  let i = 0
  let focus
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
        else if (el[n] !== val) el[n] = val
        break
      }
      default:
        throw new Error(`bad op ${op}`)
    }
  }
  if (focus?.isConnected) focus.focus()
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

const q = {
  ops: apply,
  fetch(id, mp, ml, up, ul, bp, bl, cp, cl) {
    const method = str(mp, ml)
    const url = str(up, ul)
    const ct = str(cp, cl)
    const body = bl ? bytes(bp, bl) : undefined
    fetch(url, { method, body, headers: ct ? { 'content-type': ct } : undefined, referrerPolicy: 'no-referrer' })
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
}

// same-origin links move inside the app instead of loading the page again
document.addEventListener('click', (e) => {
  const a = e.target.closest?.('a')
  if (!a || a.target || a.origin !== location.origin || a.pathname.startsWith('/api/') || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button || e.defaultPrevented) return
  e.preventDefault()
  call(() => send((p, l) => ex.q_nav(p, l, 0), a.pathname + a.search))
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
