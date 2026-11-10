// Shows the notifications the server pushes: mini apps' (server/notify.mjs), which open Quilcast at /apps?n=<id> and
// from there the app at the page the notification points to, and the account's own activity (server/alerts.mjs),
// which open the cast, the profile or Notifications: in a Quilcast window that's already open when the app in it
// answers (src/app.tsx), else in a new one. A tagged one (likes on a cast adding up) replaces the one before it.
self.addEventListener('push', (e) => {
  let d = {}
  try {
    d = e.data.json()
  } catch {}
  const tag = typeof d.tag === 'string' ? d.tag.slice(0, 200) : undefined
  e.waitUntil(self.registration.showNotification(String(d.title || 'Quilcast'), { body: String(d.body || ''), icon: d.icon || '/apple-touch-icon.png', tag, renotify: !!tag, data: { url: String(d.url || '/apps'), fid: Number.isSafeInteger(d.fid) ? d.fid : undefined } }))
})

// the first of `clients` with the app in it (a static page like /privacy has no app to answer), asked all at once;
// only that one is then told to open the page. Within 400 ms, as Firefox allows opening a window only within a
// second of the tap.
const withApp = (clients, wait = 400) => new Promise((ok) => {
  const until = Date.now() + wait
  const t = setTimeout(() => ok(null), wait)
  for (const c of clients) {
    const ch = new MessageChannel()
    ch.port1.onmessage = () => (clearTimeout(t), ok(c))
    c.postMessage({ probe: true, until }, [ch.port2])
  }
})

self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const url = new URL(e.notification.data?.url || '/apps', self.location.origin)
  // only our own pages
  if (url.origin !== self.location.origin) return
  e.waitUntil((async () => {
    // a mini app's notification opens a new window, as before
    if (!url.pathname.startsWith('/apps')) {
      const open = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).filter((c) => new URL(c.url).origin === url.origin)
      const took = open.length ? await withApp(open) : null
      if (took) {
        took.postMessage({ open: url.pathname + url.search, fid: e.notification.data?.fid })
        return took.focus()
      }
      // a new window starts as the notification's account (src/api.ts notifiedAs), not whichever was last current
      const fid = e.notification.data?.fid
      if (Number.isSafeInteger(fid) && fid > 0) url.searchParams.set('as-fid', String(fid))
    }
    await self.clients.openWindow(url.href)
  })())
})
