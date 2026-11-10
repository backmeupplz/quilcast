import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

// just enough IndexedDB for keys.ts (as in keys.test.ts): one store, transactions completing after their last request
const vault = new Map<string, any>()
const db = {
  createObjectStore() {},
  transaction() {
    const t: any = {}
    let open = 0
    const run = (f: () => unknown) => {
      const r: any = {}
      open++
      setTimeout(() => {
        r.result = f()
        r.onsuccess?.()
        if (--open === 0) setTimeout(() => open === 0 && t.oncomplete?.())
      })
      return r
    }
    t.objectStore = () => ({ get: (k: string) => run(() => vault.get(k)), put: (v: unknown, k: string) => run(() => void vault.set(k, v)), delete: (k: string) => run(() => void vault.delete(k)) })
    return t
  },
}
const store = new Map<string, string>()
const replaced: string[] = []
const A = '0x' + 'a'.repeat(40)
const B = '0x' + 'b'.repeat(40)
store.set('quilcast:accounts', JSON.stringify([{ custody: A, fid: 7, done: true }, { custody: B, fid: 8, done: true }]))
store.set('quilcast:current', A)
Object.assign(globalThis, {
  addEventListener: () => {}, dispatchEvent: () => true,
  localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) },
  indexedDB: { open: () => { const r: any = { result: db }; setTimeout(() => (r.onupgradeneeded?.(), r.onsuccess?.())); return r } },
  // the window a tapped notification for @8 opened, while @7 was the current account
  location: { href: 'https://quilcast.test/notifications?x=1&as-fid=8#top', origin: 'https://quilcast.test', pathname: '/notifications', search: '?x=1&as-fid=8', hash: '#top' },
  history: { state: null, replaceState: (_s: unknown, _t: string, p: string) => void replaced.push(p) },
})

test("a window opened from a notification starts as the notification's account, and the parameter leaves the address", async () => {
  const api = await import('./api.ts')
  assert.equal(api.account?.fid, 8)
  assert.equal(store.get('quilcast:current'), B)
  assert.deepEqual(replaced, ['/notifications?x=1#top'])
})

test('as-fid picks only a signed-in account here, and always leaves the address', async () => {
  const { notifiedAs } = await import('./api.ts')
  const list = [{ custody: A, fid: 7, done: true }, { custody: B, fid: 9, done: false }] as any
  assert.equal(notifiedAs('https://q.test/u/x', list), null)
  assert.deepEqual(notifiedAs('https://q.test/u/x?as-fid=7', list), { id: A, path: '/u/x' })
  // not signed in here (unknown, or still being set up), or not an FID: the app starts as before
  for (const v of ['5', '9', '', '07', '7.0', '-7', '1e1', 'x']) assert.deepEqual(notifiedAs(`https://q.test/c/1?a=b&as-fid=${v}`, list), { id: null, path: '/c/1?a=b' }, v)
})

// public/sw.js, run as the service worker with no Quilcast window open
const tap = async (data: unknown) => {
  const on: Record<string, (e: any) => void> = {}
  const opened: string[] = []
  const self = {
    location: { origin: 'https://quilcast.test' },
    addEventListener: (t: string, f: (e: any) => void) => void (on[t] = f),
    clients: { matchAll: async () => [], openWindow: async (h: string) => void opened.push(h) },
  }
  vm.runInNewContext(readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), { self, URL, MessageChannel, setTimeout, clearTimeout, Date, Number, String })
  let done: Promise<unknown> = Promise.resolve()
  on.notificationclick({ notification: { close() {}, data }, waitUntil: (p: Promise<unknown>) => void (done = p) })
  await done
  return opened
}

test("a tap with Quilcast closed opens the page as the notification's account; a mini app's opens as before", async () => {
  assert.deepEqual(await tap({ url: '/notifications', fid: 8 }), ['https://quilcast.test/notifications?as-fid=8'])
  assert.deepEqual(await tap({ url: '/c/0xabc?x=1', fid: 8 }), ['https://quilcast.test/c/0xabc?x=1&as-fid=8'])
  assert.deepEqual(await tap({ url: '/u/dwr' }), ['https://quilcast.test/u/dwr'])
  assert.deepEqual(await tap({ url: '/apps?n=3', fid: 8 }), ['https://quilcast.test/apps?n=3'])
})
