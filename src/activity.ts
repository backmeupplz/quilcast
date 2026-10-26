// A wallet's recent transactions, as Blockscout's explorers list them (/api/v2/addresses/<a>/transactions), for the
// Activity tab of Quorum mode's wallet panel (walletui.tsx). Only what the list itself says: the coin moved, the method
// called, who it went between, and whether it went through.

export type Activity = {
  chain: number
  hash: string
  // ms; a transaction still waiting has no block, so no time yet
  at: number
  status: 'ok' | 'failed' | 'pending'
  method: string
  // sent by this address (else received)
  out: boolean
  // the chain's coin moved, in whole coins
  amount: number
  from: string
  to: string
}

const addr = (x: any) => (typeof x?.hash === 'string' ? x.hash.toLowerCase() : '')
const coins = (v: unknown) => {
  try {
    return Number(BigInt(String(v || '0'))) / 1e18
  } catch {
    return 0
  }
}

/** One explorer page of transactions for `me` on `chain`; anything malformed is left out. */
export function toActivity(chain: number, me: string, page: any): Activity[] {
  const self = me.toLowerCase()
  return (Array.isArray(page?.items) ? page.items : []).flatMap((x: any): Activity[] => {
    if (typeof x?.hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(x.hash)) return []
    const at = Date.parse(x.timestamp) || 0
    // no status yet is still waiting only while the result says so (or says nothing); dropped or replaced never lands
    const status = x.status === 'ok' ? 'ok' : x.status === 'error' ? 'failed' : !x.result || x.result === 'pending' ? 'pending' : 'failed'
    const from = addr(x.from)
    const to = addr(x.to) || addr(x.created_contract)
    // the method's name when the explorer decoded it, else what it was: a plain transfer, a contract call, a deploy
    const method = typeof x.method === 'string' && x.method && !/^0x/.test(x.method) ? x.method
      : !x.to && x.created_contract ? 'Deploy'
        : Array.isArray(x.transaction_types) && x.transaction_types.includes('contract_call') ? 'Contract call' : 'Transfer'
    return [{ chain, hash: x.hash.toLowerCase(), at, status, method, out: from === self, amount: coins(x.value), from, to }]
  })
}

/** Newest first, the ones still waiting on top. */
export const newest = (list: Activity[]) => [...list].sort((a, b) => +(b.status === 'pending') - +(a.status === 'pending') || b.at - a.at)

/** The Activity search: a method (as shown, in `also`), an address or a hash, in part. */
export const matches = (a: Activity, q: string, ...also: string[]) => {
  const s = q.trim().toLowerCase()
  return !s || [a.method, a.hash, a.from, a.to, ...also].some((x) => x.toLowerCase().includes(s))
}
