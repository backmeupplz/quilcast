// Copied from backmeupplz/poidh public/miniapp.js.
// Farcaster mini app guest side, without @farcaster/miniapp-sdk: the host speaks Comlink over postMessage
// (an iframe on web, window.ReactNativeWebView in the mobile apps). Loaded only when framed.
const rn = window.ReactNativeWebView
const pending = new Map()
const listeners = {}
export const events = new EventTarget()

function onMessage(d) {
  if (typeof d === 'string') try { d = JSON.parse(d) } catch { return }
  if (!d || typeof d !== 'object') return
  if (d.type === 'frameEthProviderEvent') return (listeners[d.event] || []).forEach((f) => f(...(d.params || [])))
  if (d.type === 'frameEvent') return events.dispatchEvent(new CustomEvent(d.event?.event || 'unknown', { detail: d.event }))
  const p = pending.get(d.id)
  if (!p) return
  pending.delete(d.id)
  if (d.type === 'HANDLER') p.reject(new Error(d.value?.value?.message || 'mini app host error'))
  else p.resolve(d.value)
}
if (rn) {
  document.addEventListener('FarcasterFrameCallback', (e) => onMessage(e.data))
  document.addEventListener('FarcasterFrameEthProviderEvent', (e) => onMessage({ type: 'frameEthProviderEvent', ...e.data }))
  document.addEventListener('FarcasterFrameEvent', (e) => onMessage({ type: 'frameEvent', event: e.data }))
} else addEventListener('message', (e) => e.source === window.parent && onMessage(e.data))

function call(type, name, ...args) {
  const id = crypto.randomUUID()
  const msg = { id, type, path: [name], argumentList: args.map((value) => ({ type: 'RAW', value })) }
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    rn ? rn.postMessage(JSON.stringify(msg)) : window.parent.postMessage(msg, '*')
  })
}
const apply = (name, ...args) => call('APPLY', name, ...args)

let rpcId = 0
export const provider = {
  async request({ method, params }) {
    const req = { jsonrpc: '2.0', id: ++rpcId, method, params }
    let res
    try {
      res = await apply('ethProviderRequestV2', req)
    } catch (e) {
      if (/apply/i.test(e.message)) return apply('ethProviderRequest', req) // old hosts
      throw e
    }
    if (res?.error) throw Object.assign(new Error(res.error.message || 'wallet error'), { code: res.error.code })
    return res?.result
  },
  on: (ev, f) => (listeners[ev] ||= []).push(f),
  removeListener: (ev, f) => (listeners[ev] = (listeners[ev] || []).filter((g) => g !== f)),
}

// resolves to the host's context ({user, client, location}) or null when we're not in a mini app
export async function detect() {
  if (!rn && window === window.parent) return null
  return Promise.race([call('GET', 'context').catch(() => null), new Promise((r) => setTimeout(() => r(null), 1500))])
}

export const ready = () => apply('ready', {}).catch(() => {})
export const openUrl = (url) => apply('openUrl', url).catch(() => window.open(url, '_blank'))
export const setBack = (visible) => apply('updateBackState', { visible }).catch(() => {})
export const composeCast = (o) => apply('composeCast', o).catch(() => null)
export const addMiniApp = () => apply('addMiniApp').catch(() => null)
