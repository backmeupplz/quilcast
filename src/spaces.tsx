// Spaces: farcaster.xyz's live audio rooms. Rooms, roles and the stage live on farcaster.xyz (its /v1/audio-room
// API, reached through /api/space, see server/spaces.mjs), the audio goes over LiveKit with the room token `join`
// returns, and live events (reactions, raised hands, stage invites, role changes, the end) come over farcaster.xyz's
// websocket. A Space's chat is the replies to its root cast, so people on any client can join in.
// One Space plays at a time; it keeps playing while you browse, with a bar at the bottom to get back to it.
import { render } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { Room as LiveKit, RoomEvent, Track, type RemoteTrack } from 'livekit-client'
import { account, get, go, type Cast, type User } from './api.ts'
import { t, tn } from './i18n.ts'
import { ago, Avatar, CastCard, fetchCast, Header, Icon, Menu, nameOf, P, shell, Tabs, toast } from './ui.tsx'
import { spaceToken } from './write.ts'

type Role = 'host' | 'cohost' | 'speaker' | 'listener'
type SpaceUser = { fid: number; username?: string; displayName?: string; pfp?: { url?: string }; pfpUrl?: string }
export type Room = {
  id: string; title?: string; description?: string; host: SpaceUser; hostFid?: number; state: 'scheduled' | 'live' | 'ended' | string
  startedAt?: string; scheduledAt?: string; listenerCount?: number; participantCount?: number; rsvpCount?: number
  rootCastHash?: string; recordingEnabled?: boolean; viewerContext?: { rsvped?: boolean }
}
type Participant = { user: SpaceUser; role: Role; handRaised?: boolean; pendingInvite?: { role: Role; inviterFid: number } | null }

const userOf = (u: SpaceUser): User => ({ fid: u.fid, username: u.username, display_name: u.displayName, pfp_url: u.pfp?.url || u.pfpUrl })
const stage = (r: Role) => r === 'host' || r === 'cohost' || r === 'speaker'
const leads = (r?: Role) => r === 'host' || r === 'cohost'
const REACTIONS = ['👏', '🔥', '😂', '❤️', '💯', '🙏']

// --- farcaster.xyz's API, through our relay ---

class NoAccess extends Error {}
const NO_ACCESS = () => t("Spaces run on farcaster.xyz, and it only lets in accounts it has a key for. Sign in to farcaster.xyz or the Farcaster app once with this account, then come back.")

async function api<T = any>(op: string, body?: object, query?: Record<string, string | number>, retry = true): Promise<T> {
  const token = await spaceToken()
  const r = await fetch(`/api/space/${op}${query ? `?${new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]))}` : ''}`, {
    method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, ...(body && { 'content-type': 'application/json' }) }, body: body && JSON.stringify(body),
    keepalive: op === 'leave',
  })
  const j = await r.json().catch(() => ({}))
  const msg: string = j.errors?.[0]?.message || j.error || ''
  if (r.status === 400 || r.status === 401 || r.status === 403) {
    // an old token is swapped for a new one once; a fresh one that's still refused means farcaster.xyz won't have this account
    if (/invalid token|authentication required|warpcast signer/i.test(msg)) {
      if (retry) return spaceToken(true).then(() => api(op, body, query, false))
      throw new NoAccess(NO_ACCESS())
    }
  }
  if (!r.ok) throw new Error(msg || t('farcaster.xyz said no ({status}).', { status: r.status }))
  return j.result
}

const listLive = () => api<{ rooms: Room[] }>('live', undefined, { limit: 30 }).then((r) => r.rooms || [])
const listScheduled = () => api<{ rooms: Room[] }>('scheduled', undefined, { limit: 30 }).then((r) => r.rooms || [])
const getRoom = (id: string) => api<{ room: Room }>('room', undefined, { roomId: id }).then((r) => r.room)
const getParticipants = (id: string) => api<{ participants: Participant[] }>('participants', undefined, { roomId: id }).then((r) => r.participants || [])

// --- the Space you're in ---

type Session = {
  room: Room; role: Role; lk: LiveKit; ws?: WebSocket; timers: ReturnType<typeof setInterval>[]
  participants: Participant[]; speaking: Set<number>; muted: boolean; hand: boolean; floating: { id: number; emoji: string }[]
  joining?: boolean; closed?: boolean; missing?: number
}
let session: Session | null = null
let root: HTMLElement | undefined
const changed = () => dispatchEvent(new Event('space'))

/** Re-render when the Space you're in changes. */
function useSession() {
  const [, force] = useState(0)
  useEffect(() => {
    const f = () => force((x) => x + 1)
    addEventListener('space', f)
    return () => removeEventListener('space', f)
  }, [])
  return session
}

const fidOf = (identity: string) => Number(identity.match(/\d+/)?.[0]) || 0
const me = () => session?.participants.find((p) => p.user.fid === account?.fid)

/** Join a live Space: listen right away, on stage if you host or were invited up. */
export async function join(id: string) {
  if (session?.room.id === id) return
  if (session) await leave()
  const lk = new LiveKit({ adaptiveStream: false, dynacast: false })
  const s: Session = { room: { id, state: 'live', host: { fid: 0 } }, role: 'listener', lk, timers: [], participants: [], speaking: new Set(), muted: true, hand: false, floating: [], joining: true }
  session = s
  changed()
  try {
    // the browser only starts audio from a click, so this runs inside one
    lk.startAudio().catch(() => {})
    await connect(s)
    mountBar()
    listen(s)
    refresh(s)
    s.timers.push(setInterval(() => heartbeat(s), 10e3), setInterval(() => refresh(s), 5e3))
    addEventListener('pagehide', pagehide)
  } catch (e) {
    if (session === s) session = null
    lk.disconnect().catch(() => {})
    changed()
    throw e
  }
}

/** Get a room token for your current role and connect (again, after a role change: a listener's token can't publish). */
async function connect(s: Session) {
  const r = await api<{ wsUrl: string; token: string; role?: Role; room: Room }>('join', { roomId: s.room.id })
  if (s.closed) return
  s.room = r.room
  s.role = r.role || 'listener'
  const lk = s.lk
  if (lk.state !== 'disconnected') await lk.disconnect()
  lk.removeAllListeners()
  lk.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
    if (track.kind !== Track.Kind.Audio) return
    const el = track.attach()
    el.dataset.space = ''
    document.body.appendChild(el)
  })
  lk.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => track.detach().forEach((el) => el.remove()))
  lk.on(RoomEvent.ActiveSpeakersChanged, (ps) => ((s.speaking = new Set(ps.map((p) => fidOf(p.identity)))), changed()))
  lk.on(RoomEvent.Disconnected, () => void (!s.closed && !s.joining && session === s && toast('Lost the connection to the Space.')))
  await lk.connect(r.wsUrl, r.token, { autoSubscribe: true })
  s.joining = false
  s.muted = true
  // the mic comes on in the background (a permission prompt mustn't hold up the room), and only in a tab you're
  // looking at: browsers hold the mic back from hidden tabs, so someone brought up while away unmutes themselves
  if (stage(s.role)) document.visibilityState === 'visible' ? void mic(s, true) : toast("You're on stage. Unmute to talk.")
  changed()
}

async function mic(s: Session, on: boolean) {
  try {
    // a browser that never answers the mic request would otherwise leave the button stuck
    await Promise.race([s.lk.localParticipant.setMicrophoneEnabled(on), new Promise((_, no) => setTimeout(() => no(new Error('microphone timed out')), 10e3))])
    s.muted = !on
  } catch (e) {
    console.warn('[spaces] microphone', e)
    // a late answer must not open a mic the button says is off
    s.lk.localParticipant.setMicrophoneEnabled(false).catch(() => {})
    s.muted = true
    toast("Quilcast can't use your microphone. Allow it in the browser's site settings.")
  }
  changed()
}

/** farcaster.xyz's live events for this room: reactions, hands, invites, role changes and the end. */
function listen(s: Session) {
  if (s.closed) return
  const ws = (s.ws = new WebSocket('wss://ws.farcaster.xyz/stream'))
  ws.onopen = async () => {
    ws.send(JSON.stringify({ messageType: 'authenticate', data: `Bearer ${await spaceToken()}` }))
    ws.send(JSON.stringify({ messageType: 'audio_room_subscribe', data: { roomId: s.room.id } }))
  }
  ws.onmessage = (e) => {
    let m: { messageType?: string; payload?: any }
    try {
      m = JSON.parse(e.data)
    } catch {
      return
    }
    const p = m.payload || {}
    if (p.roomId && p.roomId !== s.room.id) return
    if (m.messageType === 'audio-room-reaction' && p.emoji) float(s, p.emoji)
    else if (m.messageType === 'audio-room-ended') end(s, t('This Space has ended.'))
    else if (m.messageType === 'audio-room-speaker-changed' && p.fid === account?.fid && p.role && p.role !== s.role) promote(s)
    else if (m.messageType?.startsWith('audio-room-')) refresh(s)
  }
  ws.onclose = () => void (!s.closed && setTimeout(() => listen(s), 2000))
}

const float = (s: Session, emoji: string) => {
  const f = { id: Math.random(), emoji }
  s.floating = [...s.floating.slice(-12), f]
  changed()
  setTimeout(() => ((s.floating = s.floating.filter((x) => x !== f)), changed()), 3000)
}

/** Your role changed (invited up, made co-host, moved back to the audience): reconnect with a token for it. */
async function promote(s: Session) {
  if (s.joining) return
  s.joining = true
  try {
    await connect(s)
  } catch (e: any) {
    s.joining = false
    toast(e.message)
  }
  refresh(s)
}

async function refresh(s: Session) {
  try {
    const [ps, room] = await Promise.all([getParticipants(s.room.id), getRoom(s.room.id)])
    if (s.closed) return
    s.participants = ps
    s.room = room
    if (room.state === 'ended') return end(s, t('This Space has ended.'))
    const mine = ps.find((p) => p.user.fid === account?.fid)
    // the role farcaster.xyz now lists differs from the one we connected with (in case the websocket missed it)
    if (mine && mine.role !== s.role && !s.joining) return promote(s)
    // two lists in a row without you (one can be read just before your join lands)
    s.missing = mine || s.joining ? 0 : (s.missing || 0) + 1
    if (s.missing > 1) return end(s, t('You were removed from this Space.'))
    s.hand = !!mine?.handRaised
    changed()
  } catch {}
}

const heartbeat = (s: Session) => api('heartbeat', { roomId: s.room.id, activeSpeakerFids: [...s.speaking] }).catch(() => {})

function teardown(s: Session) {
  s.closed = true
  s.timers.forEach(clearInterval)
  s.ws?.close()
  s.lk.disconnect().catch(() => {})
  document.querySelectorAll('audio[data-space]').forEach((el) => el.remove())
  removeEventListener('pagehide', pagehide)
  if (session === s) session = null
  changed()
}
const end = (s: Session, why: string) => (s.closed || toast(why), teardown(s))
const pagehide = () => session && api('leave', { roomId: session.room.id }).catch(() => {})

export async function leave() {
  const s = session
  if (!s) return
  teardown(s)
  await api('leave', { roomId: s.room.id }).catch(() => {})
}

const act = (f: () => Promise<unknown>) => f().then(() => session && refresh(session), (e) => toast(e.message))

// --- pages ---

/** /spaces: what's live, what's coming up, and starting your own. */
export function Spaces() {
  const [tab, setTab] = useState<'live' | 'upcoming'>('live')
  const [rooms, setRooms] = useState<Room[] | null>(null)
  const [err, setErr] = useState('')
  const [creating, setCreating] = useState(false)
  useEffect(() => {
    setRooms(null)
    setErr('')
    ;(tab === 'live' ? listLive() : listScheduled()).then(setRooms, (e) => setErr(e.message))
  }, [tab])
  return (
    <>
      <Header title={t('Spaces')} action={<button class="btn small" onClick={() => setCreating(true)} disabled={!!err}><Icon d={P.plus} />{t('Start a Space')}</button>} />
      <Tabs tabs={[['live', t('Live now')], ['upcoming', t('Upcoming')]]} value={tab} set={setTab} />
      {err ? <div class="note">{err}</div> : !rooms ? <div class="spinner" /> : rooms.length ? rooms.map((r) => <SpaceRow r={r} />) : <div class="note">{tab === 'live' ? t('Nobody is live right now.') : t('Nothing is scheduled yet.')}</div>}
      <p class="hint pad">{t('Spaces are live audio rooms on farcaster.xyz. Anyone can listen; the host invites people up to speak.')}</p>
      {creating && <Create close={() => setCreating(false)} />}
    </>
  )
}

const when = (r: Room) => (r.scheduledAt ? new Date(r.scheduledAt).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '')

function SpaceRow({ r }: { r: Room }) {
  return (
    <a class="row space-row" href={`/spaces/${r.id}`}>
      <Avatar u={userOf(r.host)} link={false} />
      <span class="row-main">
        <span class="row-top"><b>{r.title || t('Untitled Space')}</b></span>
        <span class="row-sub">{nameOf(userOf(r.host))}{r.state === 'scheduled' ? ` · ${when(r)}` : ''}</span>
      </span>
      <span class="row-meta">{r.state === 'live' ? <><i class="live-pill">{t('Live')}</i><small>{tn(r.listenerCount || 0, '{n} listening', '{n} listening')}</small></> : r.state === 'scheduled' ? <small>{tn(r.rsvpCount || 0, '{n} interested', '{n} interested')}</small> : <small>{t('Ended')}</small>}</span>
    </a>
  )
}

function Create({ close }: { close: () => void }) {
  const [title, setTitle] = useState('')
  const [about, setAbout] = useState('')
  const [later, setLater] = useState(false)
  const [at, setAt] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e: Event) => {
    e.preventDefault()
    setBusy(true)
    try {
      const scheduledAt = later && at ? new Date(at).toISOString() : undefined
      const r = await api<{ room?: Room } & Room>('create', { title: title.trim(), ...(about.trim() && { description: about.trim() }), ...(scheduledAt && { scheduledAt }) })
      const room = r.room || r
      close()
      if (!scheduledAt) await join(room.id)
      go(`/spaces/${room.id}`)
    } catch (e: any) {
      toast(e.message)
      setBusy(false)
    }
  }
  return (
    <div class="modal" onClick={(e) => e.target === e.currentTarget && close()}>
      <form class="sheet space-form" onSubmit={submit}>
        <h2>{t('Start a Space')}</h2>
        <input value={title} onInput={(e) => setTitle(e.currentTarget.value)} placeholder={t('What do you want to talk about?')} aria-label={t('Title')} maxLength={100} required autoFocus />
        <textarea value={about} onInput={(e) => setAbout(e.currentTarget.value)} placeholder={t('More about it (optional)')} aria-label={t('Description')} maxLength={500} rows={3} />
        <label class="check"><input type="checkbox" checked={later} onChange={(e) => setLater(e.currentTarget.checked)} />{t('Schedule it for later')}</label>
        {later && <input type="datetime-local" value={at} onInput={(e) => setAt(e.currentTarget.value)} aria-label={t('Start time')} required min={new Date(Date.now() - new Date().getTimezoneOffset() * 60e3).toISOString().slice(0, 16)} />}
        <div class="sheet-btns">
          <button type="button" class="btn ghost" onClick={close}>{t('Cancel')}</button>
          <button class="btn" disabled={busy || !title.trim()}>{busy ? t('Working…') : later ? t('Schedule') : t('Go live')}</button>
        </div>
        {!later && <p class="hint">{t('You go live right away, with your microphone on.')}</p>}
      </form>
    </div>
  )
}

/** /spaces/<id>: a Space's stage, its audience, the controls, and its chat. */
export function SpaceRoom({ id }: { id: string }) {
  const s = useSession()
  const here = s?.room.id === id ? s : null
  const [room, setRoom] = useState<Room | null>(null)
  const [people, setPeople] = useState<Participant[]>([])
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const load = () => Promise.all([getRoom(id), getParticipants(id).catch(() => [])]).then(([r, ps]) => (setRoom(r), setPeople(ps)), (e) => setErr(e.message))
  useEffect(() => {
    setRoom(null)
    setErr('')
    load()
    // not in it: refresh the audience now and then, so the page isn't a still
    const timer = setInterval(() => session?.room.id === id || load(), 15e3)
    return () => clearInterval(timer)
  }, [id])
  const r = here?.room.state ? here.room : room
  const ps = here ? here.participants : people
  if (err) return <><Header title={t('Space')} /><div class="note">{err}</div></>
  if (!r || !r.host?.fid) return <><Header title={t('Space')} /><div class="spinner" /></>
  const hosting = account?.fid === (r.hostFid ?? r.host.fid)
  const run = async (f: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await f()
      await load()
    } catch (e: any) {
      toast(e.message)
    }
    setBusy(false)
  }
  const mine = here && me()
  return (
    <>
      <Header title={t('Space')} />
      <section class="space">
        <div class="space-head">
          {r.state === 'live' && <i class="live-pill">{t('Live')}</i>}
          {r.recordingEnabled && <i class="rec-pill">{t('Recording')}</i>}
          <h2>{r.title || t('Untitled Space')}</h2>
          {r.description && <p>{r.description}</p>}
          <small>{r.state === 'scheduled' ? when(r) : r.state === 'live' && r.startedAt ? t('Started {when}', { when: ago(r.startedAt) }) : r.state === 'ended' ? t('This Space has ended.') : ''}</small>
        </div>
        {r.state === 'scheduled' && (
          <div class="space-controls">
            {hosting ? (
              <>
                <button class="btn" disabled={busy} onClick={() => run(async () => (await api('start', { roomId: r.id }), await join(r.id)))}>{t('Go live now')}</button>
                <button class="btn ghost" disabled={busy} onClick={() => run(() => api('end', { roomId: r.id }))}>{t('Cancel the Space')}</button>
              </>
            ) : (
              <button class={`btn${r.viewerContext?.rsvped ? ' ghost' : ''}`} disabled={busy} onClick={() => run(() => api('rsvp', { roomId: r.id, rsvped: !r.viewerContext?.rsvped }))}>{r.viewerContext?.rsvped ? t("You're interested") : t("I'm interested")}</button>
            )}
            <small>{tn(r.rsvpCount || 0, '{n} interested', '{n} interested')}</small>
          </div>
        )}
        {r.state === 'live' && (
          <>
            <People ps={ps} r={r} viewer={here?.role} speaking={here?.speaking} />
            {here ? <Controls s={here} /> : (
              <div class="space-controls">
                <button class="btn" disabled={busy || !!s?.joining} onClick={() => run(() => join(r.id))}>{s?.joining && s.room.id === r.id ? t('Joining…') : t('Listen')}</button>
              </div>
            )}
            {mine?.pendingInvite && <Invite s={here!} role={mine.pendingInvite.role} />}
          </>
        )}
      </section>
      {r.rootCastHash && <Chat hash={r.rootCastHash} live={r.state === 'live'} />}
      {here && <div class="floats" aria-hidden="true">{here.floating.map((f) => <span key={f.id} style={{ left: `${10 + ((f.id * 80) % 80)}%` }}>{f.emoji}</span>)}</div>}
    </>
  )
}

function People({ ps, r, viewer, speaking }: { ps: Participant[]; r: Room; viewer?: Role; speaking?: Set<number> }) {
  const order: Role[] = ['host', 'cohost', 'speaker']
  const up = ps.filter((p) => stage(p.role)).sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role))
  const down = ps.filter((p) => !stage(p.role)).sort((a, b) => +!!b.handRaised - +!!a.handRaised || +!!b.pendingInvite - +!!a.pendingInvite)
  return (
    <>
      <div class="space-stage">{up.map((p) => <Person p={p} r={r} viewer={viewer} talking={speaking?.has(p.user.fid)} />)}</div>
      {down.length > 0 && <h3 class="space-h">{tn(down.length, '{n} listener', '{n} listeners')}</h3>}
      <div class="space-crowd">{down.map((p) => <Person p={p} r={r} viewer={viewer} small />)}</div>
    </>
  )
}

const ROLE = (r: Role) => ({ host: t('Host'), cohost: t('Co-host'), speaker: t('Speaker'), listener: t('Listener') })[r]

function Person({ p, r, viewer, talking, small }: { p: Participant; r: Room; viewer?: Role; talking?: boolean; small?: boolean }) {
  const [open, setOpen] = useState(false)
  const u = userOf(p.user)
  const self = p.user.fid === account?.fid
  // hosts and co-hosts manage everyone but the host (and co-hosts can't touch each other)
  const can = leads(viewer) && !self && p.role !== 'host' && !(viewer === 'cohost' && p.role === 'cohost')
  const item = (label: string, f: () => Promise<unknown>) => <button role="menuitem" onClick={() => (setOpen(false), act(f))}>{label}</button>
  const body = { roomId: r.id, fid: p.user.fid }
  return (
    <span class={`person${small ? ' small' : ''}${talking ? ' talking' : ''} wrap-menu`}>
      <button class="person-btn" onClick={() => (can ? setOpen(!open) : go(`/u/${u.username || u.fid}`))} aria-haspopup={can ? 'menu' : undefined}>
        <Avatar u={u} size={small ? 44 : 64} link={false} />
        {p.handRaised && <i class="hand" title={t('Hand raised')}>✋</i>}
        <b>{nameOf(u)}</b>
        <small>{p.pendingInvite ? t('Invited') : stage(p.role) ? ROLE(p.role) : ''}</small>
      </button>
      {open && (
        <Menu close={() => setOpen(false)}>
          <button role="menuitem" onClick={() => (setOpen(false), go(`/u/${u.username || u.fid}`))}>{t('View profile')}</button>
          {p.role === 'listener' && !p.pendingInvite && item(p.handRaised ? t('Let them speak') : t('Invite to speak'), () => api('invite', { ...body, role: 'speaker' }))}
          {p.pendingInvite && item(t('Cancel the invite'), () => api('uninvite', body))}
          {p.role === 'speaker' && viewer === 'host' && item(t('Make co-host'), () => api('role', { ...body, role: 'cohost' }))}
          {p.role === 'cohost' && item(t('Make speaker'), () => api('role', { ...body, role: 'speaker' }))}
          {stage(p.role) && item(t('Move to the audience'), () => api('unstage', body))}
          {item(t('Remove from the Space'), () => api('remove', body))}
        </Menu>
      )}
    </span>
  )
}

function Controls({ s }: { s: Session }) {
  const [react, setReact] = useState(false)
  const hosting = s.role === 'host'
  return (
    <div class="space-controls">
      {stage(s.role) ? (
        <button class={`btn${s.muted ? ' ghost' : ''}`} onClick={() => mic(s, s.muted)} aria-pressed={!s.muted}>{s.muted ? t('Unmute') : t('Mute')}</button>
      ) : (
        <button class={`btn${s.hand ? '' : ' ghost'}`} aria-pressed={s.hand} onClick={() => act(() => api('hand', { roomId: s.room.id, raised: !s.hand }))}>✋ {s.hand ? t('Lower hand') : t('Raise hand')}</button>
      )}
      <span class="wrap-menu">
        <button class="btn ghost" aria-haspopup="menu" onClick={() => setReact(!react)} aria-label={t('React')}>😀</button>
        {react && (
          <Menu class="reactions" close={() => setReact(false)}>
            {REACTIONS.map((e) => <button role="menuitem" aria-label={e} onClick={() => (setReact(false), float(s, e), api('reaction', { roomId: s.room.id, emoji: e }).catch(() => {}))}>{e}</button>)}
          </Menu>
        )}
      </span>
      {stage(s.role) && !hosting && <button class="btn ghost" onClick={() => act(() => api('unstage', { roomId: s.room.id, fid: account!.fid }))}>{t('Leave the stage')}</button>}
      <button class="btn ghost" onClick={() => leave()}>{t('Leave')}</button>
      {hosting && <button class="btn danger" onClick={() => confirm(t('End this Space for everyone?')) && act(async () => (await api('end', { roomId: s.room.id }), teardown(s)))}>{t('End')}</button>}
    </div>
  )
}

function Invite({ s, role }: { s: Session; role: Role }) {
  return (
    <div class="space-invite" role="dialog" aria-label={t('Invitation')}>
      <b>{role === 'cohost' ? t("You're invited to co-host") : t("You're invited to speak")}</b>
      <p>{t('Your microphone turns on when you join the stage.')}</p>
      <div class="sheet-btns">
        <button class="btn ghost" onClick={() => act(() => api('decline', { roomId: s.room.id }))}>{t('Not now')}</button>
        <button class="btn" onClick={() => act(() => api('accept', { roomId: s.room.id }).then(() => promote(s)))}>{t('Join the stage')}</button>
      </div>
    </div>
  )
}

/** The Space's chat: replies to its root cast, newest first. */
function Chat({ hash, live }: { hash: string; live: boolean }) {
  const [root, setRoot] = useState<Cast | null>(null)
  const [replies, setReplies] = useState<Cast[]>([])
  const load = () => get('/v2/farcaster/cast/conversation', { identifier: hash.replace(/^0x/, ''), type: 'hash', reply_depth: 1 }).then((r) => {
    const c: Cast = r.conversation?.cast
    if (!c) return
    setRoot(c)
    setReplies([...(c.direct_replies || [])].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)))
  }, () => fetchCast(hash).then(setRoot, () => {}))
  useEffect(() => {
    load()
    if (!live) return
    const timer = setInterval(load, 10e3)
    return () => clearInterval(timer)
  }, [hash, live])
  if (!root) return null
  return (
    <section class="space-chat">
      <div class="space-chat-top">
        <h3 class="space-h">{t('Chat')}</h3>
        {account?.done && <button class="btn small" onClick={() => shell.compose({ parent: root, onDone: (h) => void (h && setTimeout(load, 2000)) })}>{t('Say something')}</button>}
      </div>
      {replies.length ? replies.map((c) => <CastCard key={c.hash} c={c} />) : <div class="note">{t('No messages yet.')}</div>}
    </section>
  )
}

/** A Space linked in a cast. */
export function SpaceCard({ id }: { id: string }) {
  const [r, setR] = useState<Room | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => void getRoom(id).then(setR, () => {}), [id])
  const s = useSession()
  const here = s?.room.id === id
  const listen = async (e: Event) => {
    e.preventDefault()
    e.stopPropagation()
    setBusy(true)
    try {
      await join(id)
    } catch (err: any) {
      toast(err.message)
    }
    setBusy(false)
  }
  return (
    <a class="space-card" href={`/spaces/${id}`} onClick={(e) => e.stopPropagation()}>
      <span class="space-card-top">{r?.state === 'live' ? <i class="live-pill">{t('Live')}</i> : <Icon d={P.mic} />}<small>{t('Space')}</small></span>
      <b>{r?.title || t('Live audio Space')}</b>
      {r && <small>{nameOf(userOf(r.host))}{r.state === 'scheduled' ? ` · ${when(r)}` : r.state === 'live' ? ` · ${tn(r.listenerCount || 0, '{n} listening', '{n} listening')}` : ` · ${t('Ended')}`}</small>}
      {r?.state === 'live' && !here && <button class="btn small" disabled={busy} onClick={listen}>{busy ? t('Joining…') : t('Listen')}</button>}
      {here && <small class="on-air">{t("You're in this Space")}</small>}
    </a>
  )
}

// --- the bar at the bottom while a Space plays ---

function mountBar() {
  if (!root) render(<Bar />, (root = document.body.appendChild(document.createElement('div'))))
}

function Bar() {
  const s = useSession()
  const [, force] = useState(0)
  useEffect(() => {
    const f = () => force((x) => x + 1)
    addEventListener('popstate', f)
    return () => removeEventListener('popstate', f)
  }, [])
  if (!s || location.pathname === `/spaces/${s.room.id}`) return null
  const talking = [...s.speaking].map((fid) => s.participants.find((p) => p.user.fid === fid)).filter(Boolean)
  return (
    <div class="space-bar" role="region" aria-label={t('Space')}>
      <a href={`/spaces/${s.room.id}`} class="space-bar-main">
        <i class="live-pill">{t('Live')}</i>
        <span><b>{s.room.title || t('Space')}</b><small>{s.joining ? t('Joining…') : talking.length ? t('{name} is speaking', { name: nameOf(userOf(talking[0]!.user)) }) : nameOf(userOf(s.room.host))}</small></span>
      </a>
      {stage(s.role) && <button class="icon-btn" aria-label={s.muted ? t('Unmute') : t('Mute')} aria-pressed={!s.muted} onClick={() => mic(s, s.muted)}><Icon d={s.muted ? P.micOff : P.mic} /></button>}
      <button class="icon-btn" aria-label={t('Leave')} onClick={() => leave()}><Icon d={P.x} /></button>
    </div>
  )
}

export { NoAccess }
