// /api/dm/<op>: farcaster.xyz direct casts. They aren't on the Farcaster network and farcaster.xyz's API
// only answers its own site, so the browser's requests pass through here. The browser holds a token that
// opens its direct casts and nothing else (minted from a custody-signed message, see write.ts); it rides
// along on each request and is never kept or logged, and only these endpoints are reachable. Live updates
// don't come through here: the browser listens on farcaster.xyz's websocket itself (dms.ts).
import { fail, readJson as json } from './net.mjs'
import { fcCall, relay } from './upload.mjs'

const OPS = {
  nonce: ['GET', '/v2/get-dc-nonce'],
  inbox: ['GET', '/v2/direct-cast-inbox', ['category', 'filter', 'cursor', 'limit']],
  conversation: ['GET', '/v2/direct-cast-conversation', ['conversationId']],
  messages: ['GET', '/v2/direct-cast-conversation-messages', ['conversationId', 'cursor', 'limit']],
  // sending goes through the newer /fc API, which takes this token (direct-cast-send wants a full session)
  send: ['PUT', '/fc/message'],
  read: ['POST', '/v2/direct-cast-mark-read'],
  category: ['POST', '/v2/direct-cast-conversation-categorization'],
  mute: ['POST', '/v2/direct-cast-conversation-notifications'],
  ttl: ['POST', '/v2/direct-cast-conversation-message-ttl'],
}

/** Relay one call; resolves { status, body } with farcaster.xyz's own answer. */
export async function dm(req, op, url) {
  // the token exchange takes the signed message in a body, so it never sits in a URL (or a proxy's log)
  if (op === 'token') {
    if (req.method !== 'POST') throw fail(405, 'POST only')
    const { message, signature } = await json(req)
    if (typeof message !== 'string' || message.length > 2000 || !/^0x[0-9a-f]{130}$/i.test(signature)) throw fail(400, 'bad signature')
    return fcCall('GET', `/v2/get-dc-auth-token?${new URLSearchParams({ message, signature })}`)
  }
  return relay(OPS, req, op, url, { cap: 2000, missing: op !== 'nonce' && (() => fail(401, 'Open messages first.')) })
}
