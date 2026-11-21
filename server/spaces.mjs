// /api/space/<op>: farcaster.xyz Spaces (live audio rooms). Like direct casts (dm.mjs) they aren't on the
// Farcaster network, and farcaster.xyz's API only answers its own site, so the browser's calls pass through here.
// The browser holds a farcaster.xyz session token minted from a custody-signed request (write.ts spaceToken); it
// rides along on each call and is never kept or logged, and only these endpoints are reachable. The audio itself
// goes straight from the browser to LiveKit with the room token `join` returns, and live events come over
// farcaster.xyz's websocket (spaces.tsx).
import { fail, readJson as json } from './net.mjs'
import { fcCall, relay } from './upload.mjs'

const OPS = {
  live: ['GET', '/v1/audio-rooms', ['limit', 'cursor']],
  scheduled: ['GET', '/v1/audio-rooms/scheduled', ['limit', 'cursor']],
  room: ['GET', '/v1/audio-room', ['roomId']],
  participants: ['GET', '/v1/audio-room/participants', ['roomId', 'includePast']],
  create: ['POST', '/v1/audio-rooms'],
  update: ['POST', '/v1/audio-room/update'],
  start: ['POST', '/v1/audio-room/start-scheduled'],
  end: ['POST', '/v1/audio-room/end'],
  rsvp: ['POST', '/v1/audio-room/rsvp'],
  join: ['POST', '/v1/audio-room/join'],
  leave: ['POST', '/v1/audio-room/leave'],
  heartbeat: ['POST', '/v1/audio-room/heartbeat'],
  speaking: ['POST', '/v1/audio-room/speaker-activity'],
  hand: ['POST', '/v1/audio-room/raise-hand'],
  reaction: ['POST', '/v1/audio-room/reaction'],
  accept: ['POST', '/v1/audio-room/accept-stage-invite'],
  decline: ['POST', '/v1/audio-room/decline-stage-invite'],
  invite: ['POST', '/v1/audio-room/accept-speaker'],
  uninvite: ['POST', '/v1/audio-room/cancel-stage-invite'],
  unstage: ['POST', '/v1/audio-room/remove-speaker'],
  role: ['POST', '/v1/audio-room/moderate-role'],
  remove: ['POST', '/v1/audio-room/remove-participant'],
}

/** Relay one call; resolves { status, body } with farcaster.xyz's own answer. */
export async function space(req, op, url) {
  // the custody-signed login request travels in a body, so it never sits in a URL (or a proxy's log)
  if (op === 'token') {
    if (req.method !== 'POST') throw fail(405, 'POST only')
    const { authRequest, bearer } = await json(req)
    const { timestamp, expiresAt } = authRequest?.params || {}
    if (authRequest?.method !== 'generateToken' || !Number.isSafeInteger(timestamp) || !Number.isSafeInteger(expiresAt) || typeof bearer !== 'string' || !/^eip191:[\w+/=]{80,200}$/.test(bearer)) throw fail(400, 'bad signature')
    const r = await fcCall('PUT', '/v2/onboarding-state', bearer, JSON.stringify({ authRequest }))
    const token = r.body?.result?.token
    return token?.secret ? { status: 200, body: { secret: token.secret, expiresAt: token.expiresAt ?? expiresAt } } : r
  }
  return relay(OPS, req, op, url, { cap: 200, missing: () => fail(401, 'Turn on Spaces first.') })
}
