// A profile page as search engines see it: its description, ProfilePage JSON-LD, and the profile header with the
// latest casts as plain HTML inside #app (a <section>, which the app never renders at its top, so Preact drops it
// whole on start instead of reusing its nodes).
import { castText, n, sized } from '../src/shared.ts'
import removed from '../src/removed.json' with { type: 'json' }

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim()
const DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

/** At most `max` characters, cut between words with "…" when it's longer. */
export function clip(s, max) {
  const cps = [...flat(s)]
  if (cps.length <= max) return cps.join('')
  const cut = cps.slice(0, max).join('')
  // the last whole word that leaves room for the "…"; one endless word is cut where it must be
  const at = cut.slice(0, -1).search(/\s\S*$/)
  return (at > 0 ? cut.slice(0, at) : [...cut].slice(0, -1).join('')).replace(/[\s,;:.–—-]+$/, '') + '…'
}

/** Their fname, or nothing for an account that has none ("fid:123"). */
export const fname = (u) => (u.username && !u.username.startsWith('fid:') ? u.username : null)
export const nameOf = (u) => flat(u.display_name) || fname(u) || `!${u.fid}`
export const pathOf = (u) => `/u/${fname(u) || u.fid}`
/** Accounts taken down for everyone (removed.json) and ones without a name stay out of search. */
export const hidden = (u) => removed.fids.includes(u.fid) || !fname(u)

/** Up to 160 characters: the bio, then followers and a nudge to read their casts. */
export function describe(u) {
  const f = u.follower_count || 0
  const tail = `${n(f)} ${f === 1 ? 'follower' : 'followers'} on Farcaster. Read @${fname(u) || u.fid}'s latest casts on Quilcast.`
  const room = 159 - tail.length
  const bio = room >= 24 ? clip(u.profile?.bio?.text, room) : ''
  return clip(bio ? `${bio}${/[.!?…]$/.test(bio) ? '' : '.'} ${tail}` : `${nameOf(u)} has ${tail}`, 160)
}

/** schema.org ProfilePage for Google's profile results. */
export function ld(u, url) {
  const name = fname(u)
  const x = (u.verified_accounts || []).filter((a) => a?.platform === 'x' && /^\w{1,15}$/.test(a.username)).map((a) => `https://x.com/${a.username}`)
  const person = {
    '@type': 'Person', name: nameOf(u), ...(name && { alternateName: `@${name}` }), identifier: String(u.fid), url,
    ...(flat(u.profile?.bio?.text) && { description: flat(u.profile.bio.text) }), ...(u.pfp_url && { image: sized(u.pfp_url, 'w=400') }),
    ...(name && { sameAs: [`https://farcaster.xyz/${name}`, ...x] }),
    interactionStatistic: { '@type': 'InteractionCounter', interactionType: 'https://schema.org/FollowAction', userInteractionCount: u.follower_count || 0 },
    agentInteractionStatistic: { '@type': 'InteractionCounter', interactionType: 'https://schema.org/FollowAction', userInteractionCount: u.following_count || 0 },
  }
  return { '@context': 'https://schema.org', '@type': 'ProfilePage', url, ...(u.registered_at && { dateCreated: u.registered_at }), mainEntity: person }
}

/** The profile header and up to ten latest casts, each linking to its own page, in the app's own classes. */
export function body(u, casts) {
  const name = esc(nameOf(u))
  const at = esc(fname(u) || `!${u.fid}`)
  const f = u.follower_count || 0
  const items = casts.filter((c) => /^(0x)?[0-9a-f]{40}$/.test(c?.hash) && !removed.casts.includes(c.hash)).slice(0, 10).map((c) => {
    const d = new Date(c.timestamp)
    const when = isNaN(d) ? '' : `<span class="dot">·</span><a href="/c/${c.hash}"><time datetime="${d.toISOString()}">${DAY.format(d)}</time></a>`
    return `<article class="cast"><div class="body"><header><span class="name">${name}</span><span class="handle">@${at}</span>${when}</header>` +
      `${c.parent_hash ? '<div class="replying">Reply</div>' : ''}<p class="text">${esc(castText(c))}</p></div></article>`
  })
  const pfp = u.pfp_url && /^https:\/\//.test(u.pfp_url) ? `<span class="avatar ssr-pfp"><img src="${esc(sized(u.pfp_url, 'w=176'))}" alt="" width="72" height="72" referrerpolicy="no-referrer" /></span>` : ''
  const bio = u.profile?.bio?.text ? `<p class="text">${esc(u.profile.bio.text)}</p>` : ''
  return `<section class="ssr"><main class="col"><div class="profile">${pfp}<h1>${name}</h1><div class="handle">@${at}</div>${bio}` +
    `<div class="counts"><span><b>${n(u.following_count || 0)}</b> following</span><span><b>${n(f)}</b> ${f === 1 ? 'follower' : 'followers'}</span></div></div>` +
    (items.length ? `<h2>Latest casts</h2>${items.join('')}` : '') + '</main></section>'
}
