// Everything secret Quilcast keeps in this browser lives here, in IndexedDB, never in localStorage: recovery phrases,
// tokens and the Quilcast wallet's keys are sealed with AES-GCM under one key the browser made non-extractable, and
// Farcaster signing keys are non-extractable Ed25519 keys themselves. Page code can use them, but nothing can read the
// keys out, so a script, an extension or a dump of the page's storage gets ciphertext and key handles, not keys.
// ponytail: browsers write these keys into the profile on disk, so a copied profile still opens them; a lock (passkey
// or password) would fix that at the cost of an unlock prompt, which a social app can't ask for every visit

export type Ed = { pub: Uint8Array; sign: (m: Uint8Array) => Promise<Uint8Array> }

export const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const unhex = (s: string) => Uint8Array.from(s.match(/../g) || [], (x) => parseInt(x, 16))

let opened: Promise<IDBDatabase> | undefined
const db = () =>
  (opened ||= new Promise<IDBDatabase>((resolve, reject) => {
    // a browser whose storage never answers mustn't hold the app up
    const late = setTimeout(() => reject(new Error(`IndexedDB did not open`)), 4000)
    const r = indexedDB.open('quilcast-vault', 1)
    r.onupgradeneeded = () => r.result.createObjectStore('kv')
    r.onsuccess = () => (clearTimeout(late), resolve(r.result))
    r.onerror = () => (clearTimeout(late), reject(r.error))
  }).catch((e) => ((opened = undefined), Promise.reject(e))))

/** One request in its own transaction; resolves once the transaction has committed. */
export async function kv<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const d = await db()
  return new Promise((resolve, reject) => {
    const t = d.transaction('kv', mode, { durability: 'strict' })
    const r = f(t.objectStore('kv'))
    t.oncomplete = () => resolve(r.result)
    t.onerror = t.onabort = () => reject(t.error || r.error)
  })
}

// made once, by whichever tab gets there first: the read and the write share one transaction, so two tabs starting
// together can't each store their own (the loser's sealed secrets would never open again)
let sealing: Promise<CryptoKey> | undefined
const sealKey = () =>
  (sealing ||= crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']).then(async (fresh) => {
    const d = await db()
    return new Promise<CryptoKey>((resolve, reject) => {
      const t = d.transaction('kv', 'readwrite', { durability: 'strict' })
      const s = t.objectStore('kv')
      let key = fresh
      const r = s.get('seal')
      r.onsuccess = () => (r.result ? (key = r.result) : s.put(fresh, 'seal'))
      t.oncomplete = () => resolve(key)
      t.onerror = t.onabort = () => reject(t.error)
    })
  }).catch((e) => ((sealing = undefined), Promise.reject(e))))

export async function seal(name: string, secret: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await sealKey(), new TextEncoder().encode(secret))
  await kv('readwrite', (s) => s.put({ iv, data }, name))
}
export async function unseal(name: string): Promise<string | undefined> {
  const box = await kv<{ iv: Uint8Array<ArrayBuffer>; data: ArrayBuffer } | undefined>('readonly', (s) => s.get(name))
  return box && new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: box.iv }, await sealKey(), box.data))
}
export const drop = (name: string) => kv('readwrite', (s) => s.delete(name))

// --- an account's secrets: each on its own, so a tab only ever writes the ones it changed ---

export const SECRETS = ['phrase', 'dm', 'fcx', 'inbox'] as const
export type Secrets = { phrase?: string; dm?: string; fcx?: { secret: string; exp: number }; inbox?: string }
const at = (id: string, f: string) => `a:${id}:${f}`

/** What the vault holds for the account `id`. */
export async function secretsOf(id: string): Promise<Secrets> {
  const out: Record<string, unknown> = {}
  for (const f of SECRETS) {
    // a value that won't decrypt is skipped; storage that won't answer throws, so nothing counts as missing by mistake
    const v = await unseal(at(id, f)).catch((e) => (e?.name === 'OperationError' ? undefined : Promise.reject(e)))
    if (v !== undefined) out[f] = JSON.parse(v)
  }
  return out
}
/** Seal one secret (undefined removes it). It counts as kept only once the vault gives the same value back. */
export async function keep(id: string, f: keyof Secrets, v: unknown) {
  if (v === undefined) return void (await drop(at(id, f)))
  const s = JSON.stringify(v)
  await seal(at(id, f), s)
  if ((await unseal(at(id, f))) !== s) throw new Error(`vault read back something else`)
}

// --- Farcaster signing keys ---

const ED = { name: 'Ed25519' }
// WebCrypto takes a raw Ed25519 private key only wrapped as PKCS#8
const PKCS8 = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]
const noble = () => import('@noble/curves/ed25519.js').then((m) => m.ed25519)

/** A new signing key in the vault, or `raw` (hex, a key from before 0.22) moved in. Browsers without WebCrypto Ed25519
 *  keep the raw key sealed instead. Either way it's read back and made to sign before anyone relies on it. */
export async function newEd(raw?: string): Promise<Ed> {
  let pub: Uint8Array
  try {
    const pair = raw ? undefined : ((await crypto.subtle.generateKey(ED, false, ['sign', 'verify'])) as CryptoKeyPair)
    const key = pair ? pair.privateKey : await crypto.subtle.importKey('pkcs8', Uint8Array.from([...PKCS8, ...unhex(raw!)]), ED, false, ['sign'])
    pub = pair ? new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)) : (await noble()).getPublicKey(unhex(raw!))
    await kv('readwrite', (s) => s.put({ key }, `ed:${hex(pub)}`))
  } catch {
    const ed = await noble()
    const priv = raw ? unhex(raw) : ed.utils.randomSecretKey()
    pub = ed.getPublicKey(priv)
    await seal(`ed:${hex(pub)}`, hex(priv))
  }
  const k = await edKey(hex(pub))
  const probe = crypto.getRandomValues(new Uint8Array(32))
  if (!k || !(await noble()).verify(await k.sign(probe), probe, pub)) throw new Error(`vault lost the key`)
  return k
}

const eds = new Map<string, Promise<Ed | undefined>>()
/** The signing key whose public key is `pub` (hex), if this browser has it. */
export function edKey(pub: string) {
  if (!eds.has(pub)) eds.set(pub, loadEd(pub).then((k) => (k || eds.delete(pub), k), (e) => (eds.delete(pub), Promise.reject(e))))
  return eds.get(pub)!
}
async function loadEd(pub: string): Promise<Ed | undefined> {
  const e = await kv<{ key?: CryptoKey } | undefined>('readonly', (s) => s.get(`ed:${pub}`))
  if (!e) return
  if (e.key) return { pub: unhex(pub), sign: async (m) => new Uint8Array(await crypto.subtle.sign(ED, e.key!, new Uint8Array(m))) }
  const [priv, ed] = [unhex((await unseal(`ed:${pub}`))!), await noble()]
  return { pub: unhex(pub), sign: async (m) => ed.sign(m, priv) }
}
export const dropEd = (pub: string) => (eds.delete(pub), drop(`ed:${pub}`))
