// Outbound HTTP for URLs that come from users (link previews, card images, avatars): public
// hosts on ports 80/443 only. The address check runs inside the socket's DNS lookup, so the IP
// that gets checked is the IP we connect to (no DNS-rebinding window), and every redirect hop
// goes through the same path. Bodies are capped and the whole fetch has a deadline.
import { lookup } from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'

export const UA = 'Mozilla/5.0 (compatible; QuilcastBot/1.0; +https://quilcast.com) facebookexternalhit/1.1'

/** True for loopback, private, link-local, CGNAT/Tailscale, multicast, reserved and the IPv6 forms of them. */
export function blocked(ip) {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32) ||
      (a === 192 && (b === 168 || b === 0)) || (a === 198 && (b === 18 || b === 19))
  }
  const v = ip.toLowerCase()
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return blocked(mapped[1])
  // ::/96 compat and ::ffff: mapped (hex form), NAT64, 6to4, Teredo, ULA, link-local, multicast, docs, discard
  return v.startsWith('::') || v.startsWith('64:ff9b:') || v.startsWith('2002:') || v.startsWith('2001:0:') || v.startsWith('2001::') ||
    /^f[cd]/.test(v) || /^fe[89a-f]/.test(v) || v.startsWith('ff') || v.startsWith('2001:db8') || v.startsWith('100:')
}

function safeLookup(host, opts, cb) {
  lookup(host, { ...opts, all: true }, (err, addrs) => {
    if (err) return cb(err)
    if (!addrs.length || addrs.some((a) => blocked(a.address))) return cb(Object.assign(new Error(`${host} resolves to a non-public address`), { code: 'EBLOCKED' }))
    opts?.all ? cb(null, addrs) : cb(null, addrs[0].address, addrs[0].family)
  })
}

/** GET (or, with `method` and `body`, send to) a public URL. Resolves { status, type, body, url, truncated };
 *  rejects on anything not allowed. Only GETs follow redirects. */
export function safeGet(url, { max = 2e6, timeout = 6000, headers = {}, hops = 4, deadline = Date.now() + timeout, method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    let u
    try {
      u = new URL(url)
    } catch {
      return reject(new Error('bad url'))
    }
    const host = u.hostname.replace(/^\[|\]$/g, '')
    if (!/^https?:$/.test(u.protocol) || u.username || u.password || (u.port && u.port !== '80' && u.port !== '443') || (isIP(host) && blocked(host)))
      return reject(new Error('url not allowed'))
    const left = deadline - Date.now()
    if (left <= 0) return reject(new Error('timeout'))
    const req = (u.protocol === 'https:' ? https : http).request(u, { method, headers: { 'user-agent': UA, 'accept-encoding': 'identity', ...headers }, lookup: safeLookup, agent: false }, (res) => {
      const loc = res.headers.location
      if (method === 'GET' && res.statusCode >= 300 && res.statusCode < 400 && loc) {
        res.resume()
        clearTimeout(timer)
        if (!hops) return reject(new Error('too many redirects'))
        let next
        try {
          next = new URL(loc, u).href
        } catch {
          return reject(new Error('bad redirect'))
        }
        return safeGet(next, { max, headers, hops: hops - 1, deadline }).then(resolve, reject)
      }
      const chunks = []
      let n = 0
      const finish = (truncated) => (clearTimeout(timer), resolve({ status: res.statusCode, type: String(res.headers['content-type'] || ''), body: Buffer.concat(chunks), url: u.href, truncated }))
      res.on('data', (c) => {
        if (n + c.length > max) {
          chunks.push(c.subarray(0, max - n))
          n = max
          res.destroy()
          return finish(true)
        }
        n += c.length
        chunks.push(c)
      })
      res.on('end', () => finish(false))
      res.on('error', (e) => (clearTimeout(timer), reject(e)))
    })
    const timer = setTimeout(() => req.destroy(new Error('timeout')), left)
    req.on('error', (e) => (clearTimeout(timer), reject(e)))
    req.end(body)
  })
}

/** Type and pixel size of a PNG, GIF, WebP or JPEG from its header, or null when it's none of those. */
export function imageInfo(b) {
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a) return { type: 'image/png', w: b.readUInt32BE(16), h: b.readUInt32BE(20) }
  if (b.length > 10 && /^GIF8[79]a$/.test(b.toString('latin1', 0, 6))) return { type: 'image/gif', w: b.readUInt16LE(6), h: b.readUInt16LE(8) }
  if (b.length > 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const kind = b.toString('latin1', 12, 16)
    if (kind === 'VP8X') return { type: 'image/webp', w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) }
    if (kind === 'VP8L') return { type: 'image/webp', w: 1 + (b.readUInt32LE(21) & 0x3fff), h: 1 + ((b.readUInt32LE(21) >>> 14) & 0x3fff) }
    if (kind === 'VP8 ') return { type: 'image/webp', w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff }
    return null
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length; ) {
      if (b[i] !== 0xff) return null
      const m = b[i + 1]
      if (m === 0xff) i++
      else if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) i += 2
      else if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { type: 'image/jpeg', h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) }
      else i += 2 + b.readUInt16BE(i + 2)
    }
  }
  return null
}

/** JSON from a URL we trust (the node), or null on a non-2xx; gives up after `ms`. */
export const fetchJson = (url, ms = 5000) => fetch(url, { signal: AbortSignal.timeout(ms) }).then((r) => (r.ok ? r.json() : null))

/** Run at most `n` of these at once; callers past a queue of `wait` get a 503. */
export function gate(n, wait = 30) {
  let busy = 0
  const queue = []
  return async (fn) => {
    if (busy >= n) {
      if (queue.length >= wait) throw Object.assign(new Error('busy'), { status: 503 })
      await new Promise((r) => queue.push(r))
    }
    busy++
    try {
      return await fn()
    } finally {
      busy--
      queue.shift()?.()
    }
  }
}

/** Put `v` (a value or a promise) in a cache of at most `max` entries, oldest out first; a rejected promise drops out, so it's retried. */
export const keep = (map, max, k, v) => (map.size >= max && map.delete(map.keys().next().value), map.set(k, v), Promise.resolve(v).catch(() => map.delete(k)), v)

/** An error that carries the HTTP status to answer with. */
export const fail = (status, message) => Object.assign(new Error(message), { status })

/** A request's body as text, up to `max` characters. */
export async function readText(req, max = 16e3) {
  let s = ''
  for await (const c of req) if ((s += c).length > max) throw fail(413, 'too long')
  return s
}

/** A request's JSON body, up to `max` characters. */
export async function readJson(req, max = 16e3) {
  return parseJson(await readText(req, max))
}
export function parseJson(s) {
  try {
    return JSON.parse(s)
  } catch {
    throw fail(400, 'bad json')
  }
}
