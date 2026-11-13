import { useEffect, useRef, useState } from 'preact/hooks'
import { account, accounts, findUsers, get, go, idOf, loadUsers, myUser, posting, users, type Account, type Cast, type User } from './api.ts'
import { lang, t } from './i18n.ts'
import { GifPicker } from './gifs.tsx'
import { castText, embedRoom, format, n, isImg, isVid, linkify, markdown, holdsPicture, pictureSpot, pictureToken, postMedia, remap, sentFiles, settlePicture, textLinks, TYPING_MENTION, withGif, type Format } from './shared.ts'
import { ago, Avatar, fetchCast, handle, Icon, LinkCard, Media, Menu, nameOf, P, QuoteCard, RichText, toast, w } from './ui.tsx'
import type { Draft, Scheduled, ThreadStart } from './write.ts'
import { findChannels, getChannel, isMember, urlOf, type Channel } from './channels.ts'

type Attachment = { id: number; preview: string; video: boolean; url?: string; err?: string; stage?: 'uploading' | 'processing'; pct?: number; left?: number }
const bytes = (s: string) => new TextEncoder().encode(s).length

const userOf = (a: Account): User => (a.fid && users.get(a.fid)) || { fid: a.fid || 0, username: a.username }
// a cast of ours to reply to that the node may not have yet: what the composer shows and replies to
const standIn = (hash: string, text: string, author: User, at: number) =>
  ({ hash, text, timestamp: new Date(at).toISOString(), author, embeds: [], reactions: { likes_count: 0, recasts_count: 0 }, replies: { count: 0 } }) as Cast

/** Which signed-in account a cast or reply goes out as; another one is used for this cast only, without switching. */
function AsPicker({ value, set }: { value: Account; set: (a: Account) => void }) {
  const [open, setOpen] = useState(false)
  const [, force] = useState(0)
  const list = accounts.filter((a) => a.done && a.fid)
  useEffect(() => void loadUsers(list.map((a) => a.fid!)).then(() => force((x) => x + 1)), [])
  if (list.length < 2) return null
  const u = userOf(value)
  return (
    <span class="wrap-menu as-picker">
      <button type="button" class="as-btn" aria-haspopup="menu" aria-label={t('Posting as @{name}', { name: handle(u) })} title={t('Posting as @{name}', { name: handle(u) })} onClick={() => setOpen(!open)}>
        <Avatar u={u} size={28} link={false} /><Icon d="M6 9l6 6 6-6" size={14} />
      </button>
      {open && (
        <Menu close={() => setOpen(false)}>
          <div class="menu-label muted">{t('Post as')}</div>
          {list.map((a) => (
            <button role="menuitemradio" aria-checked={idOf(a) === idOf(value)} onClick={() => (set(a), setOpen(false))}>
              <Avatar u={userOf(a)} size={24} link={false} /><span class="wname">@{handle(userOf(a))}</span>{idOf(a) === idOf(value) && <Icon d={P.check} />}
            </button>
          ))}
        </Menu>
      )}
    </span>
  )
}

function ChannelPicker({ value, set, fid }: { value?: string; set: (v?: string) => void; fid?: number }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [list, setList] = useState<Channel[]>([])
  // farcaster.xyz leaves non-members' casts out of a members-only channel
  const [closed, setClosed] = useState(false)
  useEffect(() => {
    if (!open) return
    const t = setTimeout(() => findChannels(q.trim(), 8).then(setList), q.trim() ? 250 : 0)
    return () => clearTimeout(t)
  }, [q, open])
  useEffect(() => {
    setClosed(false)
    let on = true
    value && fid && getChannel(value).then(async (c) => c && !c.open && !(await isMember(c.id, fid)) && on && (setClosed(true), toast(t('Only members can cast in /{id}, so farcaster.xyz won\'t show this there.', { id: c.id }))))
    return () => void (on = false)
  }, [value, fid])
  return (
    <span class="wrap-menu">
      <button class={`chip${value ? ' on' : ''}`} onClick={() => setOpen(!open)} aria-haspopup="menu" title={closed ? t('Only members can cast in /{id}, so farcaster.xyz won\'t show this there.', { id: value! }) : undefined}><Icon d={P.hash} size={14} />{value ? `/${value}` : t('Channel')}{closed && ' 🔒'}</button>
      {open && (
        <Menu class="picker" close={() => setOpen(false)}>
          <input autoFocus value={q} onInput={(e) => setQ(e.currentTarget.value)} placeholder={t('Search channels')} aria-label={t('Search channels')} />
          {value && <button onClick={() => (set(undefined), setOpen(false))}>{t('No channel')}</button>}
          {list.map((c) => <button onClick={() => (set(c.id), setOpen(false), setQ(''))}>/{c.id}<small>{c.open ? n(c.followers) : `🔒 ${n(c.followers)}`}</small></button>)}
        </Menu>
      )}
    </span>
  )
}

// pics: pictures being uploaded into the text (Markdown mode's picture button), each at its `token` until it's done;
// `put` is what went into the text for it, made from the `alt` selection
type Part = { id: number; text: string; files: Attachment[]; pics: (Attachment & { token: string; put: string; alt: string })[] }
const LIMIT = 1024 // casts over 320 bytes go out as long casts, which allow up to 1024
const newPart = (): Part => ({ id: Math.random(), text: '', files: [], pics: [] })

// The iOS and Android apps may ask for a store rating once a few casts and replies went out: they count them and decide
// (ios/Quilcast/RatingPrompt.swift, android/app/src/play/…/RatingPrompt.java). A browser or a Farcaster client has no
// such bridge. Not after a send failed this session, and only once the cast's page is up.
let failed = false
const sent = () => {
  if (failed || !navigator.userAgent.includes('QuilcastApp/')) return
  const g = window as unknown as { webkit?: { messageHandlers?: { requestReview?: { postMessage(m: null): void } } }; QuilcastApp?: { requestReview(): void } }
  setTimeout(() => (g.webkit?.messageHandlers?.requestReview?.postMessage(null), g.QuilcastApp?.requestReview()), 2000)
}
// a picture still uploading will take this many bytes of the post once its URL is in (an imagedelivery.net one is ~95)
const PIC = 100
const used = (p: { text: string; pics: unknown[] }) => bytes(p.text) + p.pics.length * PIC
// how the keyboard shortcuts read on this device
const MOD = /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? '⌘' : 'Ctrl+'
const fmtLeft = (s?: number) => (s === undefined || !isFinite(s) ? '' : ' · ' + (s < 60 ? t('{n}s left', { n: Math.max(1, Math.round(s)) }) : t('{n} min left', { n: Math.round(s / 60) })))
const Busy = ({ f }: { f: Attachment }) => (
  <span class="att-busy">
    <span class="spinner small" />
    <span class="att-stage">{f.stage === 'processing' ? (f.video ? t('Processing video…') : t('Finishing…')) : t('Uploading {pct}%', { pct: f.pct ?? 0 }) + fmtLeft(f.left)}</span>
    {f.stage !== 'processing' && <span class="att-bar"><i style={{ width: `${f.pct ?? 0}%` }} /></span>}
  </span>
)

/** One post of a thread: text with @mention autocomplete, its attachments and the links it will embed. */
function PartEditor({ part, set, first, last, quote, embeds = [], focus, onFocus, attach, placeholder, remove, md }: {
  md: boolean; part: Part; set: (p: Partial<Part>) => void; first: boolean; last: boolean; quote?: Cast; embeds?: string[]
  focus: boolean; onFocus: () => void; attach: (files: FileList | null) => void; placeholder: string; remove?: () => void
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [tok, setTok] = useState<{ start: number; q: string } | null>(null)
  const [sug, setSug] = useState<User[]>([])
  const [sel, setSel] = useState(0)
  const [links, setLinks] = useState<string[]>([])
  useEffect(() => void (focus && ref.current?.focus()), [focus])
  // link previews follow the text once typing pauses
  useEffect(() => {
    const t = setTimeout(() => setLinks(textLinks(part.text)), 600)
    return () => clearTimeout(t)
  }, [part.text])
  const findToken = (el: HTMLTextAreaElement) => {
    const m = el.value.slice(0, el.selectionStart).match(TYPING_MENTION)
    setTok(m ? { start: el.selectionStart - m[1].length - 1, q: m[1].toLowerCase() } : null)
  }
  useEffect(() => {
    if (!tok) return setSug([])
    // only people with a username can be @mentioned
    const t = setTimeout(() => findUsers(tok.q).then((us) => (setSug(us.filter((u) => u.username && !u.username.startsWith('fid:')).slice(0, 6)), setSel(0)), () => {}), 200)
    return () => clearTimeout(t)
  }, [tok?.q])
  const mention = (u: User) => {
    const el = ref.current!
    const next = part.text.slice(0, tok!.start) + '@' + u.username + ' ' + part.text.slice(el.selectionStart)
    set({ text: next })
    setTok(null)
    const caret = tok!.start + u.username!.length + 2
    requestAnimationFrame(() => (el.focus(), el.setSelectionRange(caret, caret)))
  }
  const keys = (e: KeyboardEvent) => {
    // backspace in an empty post drops it, like X
    if (e.key === 'Backspace' && remove && !part.text && !part.files.length) return e.preventDefault(), remove()
    if (!sug.length || !tok) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') setSel((sel + (e.key === 'ArrowDown' ? 1 : sug.length - 1)) % sug.length)
    else if (e.key === 'Enter' || e.key === 'Tab') mention(sug[sel])
    else if (e.key === 'Escape') setTok(null)
    else return
    e.preventDefault()
    e.stopPropagation()
  }
  const grow = (el: HTMLTextAreaElement) => ((el.style.height = 'auto'), (el.style.height = el.scrollHeight + 'px'))
  useEffect(() => void (ref.current && grow(ref.current)), [part.text])
  // the link cards are the links castEmbeds sends: what's left after the attachments postMedia sends
  const slots = embedRoom(sentFiles(part.files, part.text), first ? +!!quote + embeds.length : 0)
  return (
    <div class={`part${last ? '' : ' threaded'}`} onClick={onFocus}>
      <div class="editor">
        {account && <Avatar u={myUser()!} size={36} link={false} />}
        <textarea ref={ref} dir="auto" value={part.text} rows={1} placeholder={placeholder}
          onInput={(e) => (set({ text: e.currentTarget.value }), findToken(e.currentTarget))}
          onKeyDown={keys} onClick={(e) => findToken(e.currentTarget)} onFocus={onFocus}
          onPaste={(e) => e.clipboardData?.files.length && (e.preventDefault(), attach(e.clipboardData.files))} />
        {remove && <button class="icon-btn part-x" aria-label={t('Remove this post')} onClick={(e) => (e.stopPropagation(), remove())}><Icon d={P.x} size={16} /></button>}
      </div>
      {tok && sug.length > 0 && (
        <div class="mentions" role="listbox">
          {sug.map((u, i) => (
            <button role="option" aria-selected={i === sel} class={i === sel ? 'on' : ''} onMouseDown={(e) => (e.preventDefault(), mention(u))}>
              <Avatar u={u} size={28} link={false} />
              <b>{nameOf(u)}</b><span class="handle">@{u.username}</span>
            </button>
          ))}
        </div>
      )}
      {part.files.length > 0 && (
        <div class="attachments">
          {part.files.map((f) => (
            <div class={`att${f.err ? ' bad' : ''}`}>
              {f.video ? <video src={f.preview} muted /> : <img src={f.preview} alt="" />}
              {!f.url && !f.err && <Busy f={f} />}
              {f.err && <span class="att-err">{t(f.err)}</span>}
              <button class="att-x" aria-label={t('Remove')} onClick={() => set({ files: part.files.filter((x) => x.id !== f.id) })}><Icon d={P.x} size={14} /></button>
            </div>
          ))}
        </div>
      )}
      {/* pictures on their way into the text; the x takes one out of it again */}
      {part.pics.length > 0 && (
        <div class="attachments">
          {part.pics.map((f) => (
            <div class="att">
              <img src={f.preview} alt="" />
              <Busy f={f} />
              <button class="att-x" aria-label={t('Remove')} onClick={() => set({ text: settlePicture(part.text, f.token, undefined, f.put, f.alt), pics: part.pics.filter((x) => x.id !== f.id) })}><Icon d={P.x} size={14} /></button>
            </div>
          ))}
        </div>
      )}
      {/* how the Markdown will look, in Markdown mode */}
      {md && part.text.trim() && (
        <div class="md-preview" aria-label={t('Preview')}><span class="md-label">{t('Preview')}</span><RichText text={part.text.trim()} /></div>
      )}
      {first && quote && <div class="embed-preview"><QuoteCard c={quote} /></div>}
      {first && embeds.map((u) => <div class="embed-preview">{isImg(u) || isVid(u) ? <Media urls={[u]} /> : <LinkCard u={u} />}</div>)}
      {links.slice(0, slots).map((u) => <div class="embed-preview"><LinkCard u={u} /></div>)}
    </div>
  )
}

/** The account's drafts (sealed on our server, write.ts), to pick one up again or delete it. */
function DraftList({ open, close }: { open: (d: Draft) => void; close: () => void }) {
  const [list, setList] = useState<Draft[] | null>(null)
  useEffect(() => void w().then((m) => m.listDrafts()).then(setList, (e) => (toast(e.message), close())), [])
  const drop = (d: Draft) => (setList((l) => l!.filter((x) => x.id !== d.id)), w().then((m) => m.dropDraft(d.id)).catch((e) => toast(e.message)))
  if (!list) return <div class="drafts"><span class="spinner" /></div>
  return (
    <div class="drafts">
      {!list.length && <p class="muted">{t('No drafts yet.')}</p>}
      {list.map((d) => (
        <div class="draft">
          <button class="draft-open" onClick={() => open(d)}>
            <span class="clamp">{d.parts[0]?.text.trim() || '…'}</span>
            <small class="muted">{[ago(d.at), d.parent ? t('Reply') : d.quote ? t('Quote cast') : '', d.channel && `/${d.channel}`, d.parts.some((p) => p.media.length) && '📎'].filter(Boolean).join(' · ')}</small>
          </button>
          <button class="icon-btn" aria-label={t('Delete draft')} onClick={(e) => ((e.currentTarget.closest('.sheet') as HTMLElement)?.focus(), drop(d))}><Icon d={P.x} size={16} /></button>
        </div>
      ))}
    </div>
  )
}

/** When a scheduled cast goes out, in the reader's language and timezone. */
const whenOf = (at: number) => new Date(at).toLocaleString(lang, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
/** "2026-11-13T14:05" in this timezone, as a datetime-local input takes it. */
const localInput = (at: number) => new Date(at - new Date(at).getTimezoneOffset() * 60e3).toISOString().slice(0, 16)

/** The account's scheduled casts (server/scheduled.mjs): waiting ones to edit or cancel, posted and failed ones to see. */
function ScheduledList({ as, open, close }: { as: Account; open: (s: Scheduled) => void; close: () => void }) {
  const [list, setList] = useState<Scheduled[] | null>(null)
  useEffect(() => void w().then((m) => m.listScheduled(as)).then(setList, (e) => (toast(e.message), close())), [as.fid])
  const drop = (s: Scheduled) =>
    w().then((m) => m.cancelScheduled(s.id, as)).then(
      (r) => (setList((l) => l!.filter((x) => x.id !== s.id)), r.was === 'posted' && s.status === 'scheduled' && toast('That cast was already sent.')),
      (e) => toast(e.message),
    )
  if (!list) return <div class="drafts"><span class="spinner" /></div>
  const state = (s: Scheduled) =>
    s.status === 'posted' ? t('Posted') : s.status === 'failed' ? t('Failed: {reason}', { reason: s.error || '' }) : s.status === 'posting' ? t('Sending…') : s.error ? t('Trying again: {reason}', { reason: s.error }) : ''
  // a thread whose first posts went out before it stopped (or while the node is tried again) says how far it got
  const part = (s: Scheduled) => s.status !== 'posted' && s.posted > 0 && t('{posted} of {total} posted', { posted: s.posted, total: s.hashes.length })
  return (
    <div class="drafts">
      {!list.length && <p class="muted">{t('No scheduled casts.')}</p>}
      {list.map((s) => (
        <div class={`draft${s.status === 'failed' ? ' failed' : ''}`}>
          {/* one the server is still sending, or trying again after its first posts went out, can't be changed */}
          <button class="draft-open" disabled={s.status === 'posting' || (s.status === 'scheduled' && s.posted > 0)} onClick={() => (s.status === 'posted' ? (close(), go(`/c/${s.hash}`)) : open(s))}>
            <span class="clamp">{s.draft?.parts[0]?.text.trim() || '…'}</span>
            <small class="muted">{[whenOf(s.at), (s.draft?.parts.length || 1) > 1 && t('Thread'), s.draft?.parent ? t('Reply') : s.draft?.quote ? t('Quote cast') : '', s.draft?.channel && `/${s.draft.channel}`, part(s), state(s)].filter(Boolean).join(' · ')}</small>
          </button>
          {part(s) && <button class="icon-btn" aria-label={t('See what was posted')} title={t('See what was posted')} onClick={() => (close(), go(`/c/${s.hash}`))}><Icon d={P.link} size={16} /></button>}
          {s.status !== 'posting' && (
            <button class="icon-btn" aria-label={s.status === 'scheduled' ? t('Cancel scheduled cast') : t('Remove from the list')} onClick={(e) => ((e.currentTarget.closest('.sheet') as HTMLElement)?.focus(), drop(s))}><Icon d={P.x} size={16} /></button>
          )}
        </div>
      ))}
      <p class="muted small">{t('Scheduled casts are signed on this device and wait on Quilcast’s server until their time. The server can read them but can’t change them or post anything else as you.')}</p>
    </div>
  )
}

/** `text` and `embeds` prefill the first post (a mini app's composeCast); `onDone` hears the new hash, or null. */
export function Composer({ channel: initial, text = '', embeds: given = [], onDone, onClose: close, scheduled: showScheduled = false, ...props }: { parent?: Cast; quote?: Cast; channel?: string; text?: string; embeds?: string[]; onDone?: (hash: string | null) => void; onClose: () => void; scheduled?: boolean }) {
  const [parts, setParts] = useState<Part[]>(() => [{ ...newPart(), text }])
  // where a send that failed partway left the thread (write.ts postThread): a retry goes on from the last cast that went
  // out instead of forking from the start again, and `root` is the thread's first cast. Opening a draft or a scheduled
  // cast starts over.
  const [cont, setCont] = useState<{ next: ThreadStart; root: string }>()
  // a mini app's links went out with the first post
  const embeds = cont ? [] : given
  // a mini app hears of its cast once that went out, even when the rest of the thread didn't
  const onClose = (hash: string | null = cont?.root ?? null) => (onDone?.(hash), close())
  // a draft picked up again brings its own cast to reply to or quote
  const [{ parent, quote }, setCtx] = useState({ parent: props.parent, quote: props.quote })
  // the first post's fixed embeds (a quote, a mini app's links) leave less room for attachments
  const fixed = (i: number) => (i === 0 ? +!!quote + embeds.length : 0)
  const [active, setActive] = useState(0)
  const [channel, setChannel] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [as, setAs] = useState<Account>(account!)
  const [gifs, setGifs] = useState(false)
  const pick = useRef<HTMLInputElement>(null)
  // drafts: the one being edited, its list on screen, and the "keep it?" question on closing. A mini app's composeCast
  // has none: its embeds are the app's, and the app hears what happened.
  const canDraft = !onDone && !given.length
  const [draft, setDraft] = useState<string>()
  const [drafts, setDrafts] = useState(false)
  const [asking, setAsking] = useState(false)
  // scheduling: the time picked (Unix ms), whether the picker shows, the list of scheduled casts, and the one being
  // edited (cancelled when this one is scheduled or posted instead)
  const [when, setWhen] = useState<number>()
  const [timing, setTiming] = useState(false)
  const [scheduledOpen, setScheduledOpen] = useState(showScheduled && canDraft)
  const [editing, setEditing] = useState<{ id: string; fid: number; status: Scheduled['status'] }>()
  // the failed thread being edited had its first `posted` of `total` posts go out: only the rest is in the composer,
  // or (`again`) all of it, to be posted a second time
  const [gone, setGone] = useState<{ posted: number; total: number; again: boolean }>()
  const snap = (ps: Part[], ch?: string) => JSON.stringify([ps.map((p) => [p.text, p.files.map((f) => f.url)]), ch])
  const base = useRef<string>(undefined)
  base.current ??= snap(parts, channel)
  const empty = parts.every((p) => !p.text.trim() && !p.files.length)
  const uploading = parts.some((p) => p.pics.length || holdsPicture(p.text) || p.files.some((f) => !f.url && !f.err))
  // closing with something new in it asks first; asked twice, it goes back to editing
  const leave = () => (asking ? setAsking(false) : canDraft && !busy && !empty && snap(parts, channel) !== base.current ? setAsking(true) : onClose())
  const keep = async () => {
    setBusy(true)
    try {
      const media = (p: Part) => p.files.flatMap((f) => (f.url ? [f.url] : []))
      await (await w()).saveDraft({ id: draft || crypto.randomUUID(), at: Date.now(), parts: parts.map((p) => ({ text: p.text, media: media(p) })), channel: parent ? undefined : channel, parent: parent?.hash, quote: quote?.hash, as: as.fid })
      toast('Draft saved')
      onClose()
    } catch (e: any) {
      toast(e.message)
      setBusy(false)
    }
  }
  // `stand` is the cast to reply to when the node can't find `d.parent` (yet)
  const open = async (d: Draft, stand?: Cast) => {
    const [p, q] = await Promise.all([d.parent ? fetchCast(d.parent) : null, d.quote ? fetchCast(d.quote) : null])
    const ps = d.parts.map((x) => ({ ...newPart(), text: x.text, files: x.media.map((url) => ({ id: Math.random(), preview: url, video: isVid(url), url })) }))
    setCtx({ parent: p || stand, quote: q || undefined })
    setCont(undefined)
    setGone(undefined)
    setParts(ps)
    setChannel(d.channel)
    setAs(accounts.find((a) => a.done && a.fid === d.as) || account!)
    setDraft(d.id)
    setActive(0)
    setDrafts(false)
    base.current = snap(ps, d.channel)
  }
  // a scheduled cast opens like a draft, with its time (a failed one too, to sign again, with a new key or time)
  const edit = async (s: Scheduled) => {
    if (!s.draft) return
    // a failed thread whose first posts went out opens with only the rest, replying to the last one out, so they go
    // out once; one whose posts can't be told apart opens whole, with a warning
    const rest = s.status === 'failed' ? (await w()).unsent(s) : null
    if (rest) {
      const hash = `0x${rest.parent}`
      const author = userOf(accounts.find((a) => a.done && a.fid === s.draft!.as) || as)
      await open({ ...s.draft, parts: rest.parts, parent: hash, channel: undefined, quote: undefined, id: '', at: s.at }, standIn(hash, rest.last, author, s.at))
    } else await open({ ...s.draft, id: '', at: s.at })
    setGone(s.status === 'failed' && s.posted > 0 ? { posted: s.posted, total: s.hashes.length, again: !rest } : undefined)
    setDraft(undefined)
    setEditing({ id: s.id, fid: as.fid!, status: s.status })
    setWhen(s.status === 'scheduled' ? s.at : undefined)
    setTiming(true)
    setScheduledOpen(false)
  }
  /** Once what replaces it went out or was scheduled, the edited one is cancelled (a failed one taken off the list).
   *  Only then: a replacement that fails leaves the original as it was. */
  const unschedule = async (m: typeof import('./write.ts'), e: NonNullable<typeof editing>) => {
    const r = await m.cancelScheduled(e.id, accounts.find((a) => a.done && a.fid === e.fid) || as).catch((err) => (toast(err.message), null))
    if (r?.was === 'posted' && e.status === 'scheduled') toast('That cast was already sent.')
  }
  const update = (id: number, p: Partial<Part> | ((x: Part) => Partial<Part>)) =>
    setParts((ps) => ps.map((x) => (x.id === id ? { ...x, ...(typeof p === 'function' ? p(x) : p) } : x)))
  // after a failed send took the posts that went out, `active` may point past the end
  const at = parts[active] ? active : 0
  const cur = parts[at]
  const left = LIMIT - used(cur)
  const filled = (p: Part, i: number) => p.text.trim() || p.files.length || fixed(i)
  const ready = parts.every((p, i) => (filled(p, i) || (i > 0 && !p.text && !p.files.length)) && bytes(p.text) <= LIMIT && p.files.every((f) => f.url) && !p.pics.length && !holdsPicture(p.text)) && filled(parts[0], 0)

  const attach = (list: FileList | null) => {
    const part = cur
    const room = embedRoom(part.files.length, fixed(at))
    for (const file of [...(list || [])].slice(0, room)) {
      const a: Attachment = { id: Math.random(), preview: URL.createObjectURL(file), video: file.type.startsWith('video/') }
      const patch = (p: Partial<Attachment>) => update(part.id, (x) => ({ files: x.files.map((f) => (f.id === a.id ? { ...f, ...p } : f)) }))
      update(part.id, (x) => ({ files: [...x.files, a] }))
      // upload() strips EXIF/GPS and video metadata before anything leaves the device
      w()
        .then((m) => m.upload(file, (stage, f, secs) => patch({ stage, pct: f === undefined ? undefined : Math.round(f * 100), left: secs })))
        .then((url) => patch({ url }), (e) => patch({ err: e.message }))
    }
  }
  // Markdown mode: the formatting buttons and a preview under each post. It comes on by itself once a post has
  // Markdown in it, and the toolbar's button turns it on or off.
  const [mdSet, setMd] = useState<boolean>()
  const md = mdSet ?? parts.some((p) => markdown(p.text.trim()) !== linkify(p.text.trim()))
  // the buttons keep the focus in the post (see md-tools' onMouseDown), so its selection is still there
  const fmt = (how: Format) => {
    const el = document.activeElement instanceof HTMLTextAreaElement ? document.activeElement : null
    const [next, a, b] = format(cur.text, el ? el.selectionStart : cur.text.length, el ? el.selectionEnd : cur.text.length, how)
    update(cur.id, () => ({ text: next }))
    if (el) requestAnimationFrame(() => (el.focus(), el.setSelectionRange(a, b)))
  }
  // Markdown mode's picture button: each picked image goes into the post at the caret, as ![selection](token) on a line
  // of its own, and its token turns into the uploaded URL once upload() is done (EXIF stripped, as for attachments). It
  // takes none of the attachments' room, and isn't embedded when the cast goes out (castEmbeds): other clients show the
  // ![](…) as it's typed.
  const picker = useRef<HTMLInputElement>(null)
  // where the caret was when the button was pressed; other pictures may finish while the file dialog is up, so it's
  // found again in the text as it is then (remap)
  const picAt = useRef<{ el: HTMLTextAreaElement | null; part: number; text: string; start: number; end: number } | null>(null)
  const pickPicture = () => {
    const el = document.activeElement instanceof HTMLTextAreaElement ? document.activeElement : null
    picAt.current = { el, part: cur.id, text: cur.text, start: el ? el.selectionStart : cur.text.length, end: el ? el.selectionEnd : cur.text.length }
    picker.current?.click()
  }
  const pictures = (list: FileList | null) => {
    const s = picAt.current
    const part = parts.find((p) => p.id === s?.part)
    const files = [...(list || [])].filter((f) => f.type.startsWith('image/'))
    if (!s || !part || !files.length) return
    let text = part.text
    let [a, b] = remap(s.text, s.start, s.end, text)
    const pics = files.map((file) => {
      const token = pictureToken()
      // not into the alt text of one still uploading: the new one goes after it (and so its put and alt are from there)
      ;[a, b] = pictureSpot(text, a, b)
      const was = a
      const alt = text.slice(a, b)
      ;[text, a, b] = format(text, a, b, { picture: token })
      const pic = { id: Math.random(), token, put: text.slice(was, a), alt, preview: URL.createObjectURL(file), video: false }
      const patch = (p: Partial<Attachment>) => update(part.id, (x) => ({ pics: x.pics.map((f) => (f.id === pic.id ? { ...f, ...p } : f)) }))
      const done = (url?: string) => {
        // setting the text moves a caret in it to the end, so one there is put back where it was
        const el = document.activeElement instanceof HTMLTextAreaElement && document.activeElement.value.includes(token) ? document.activeElement : null
        const at = el && ([el.value, el.selectionStart, el.selectionEnd] as const)
        update(part.id, (x) => ({ text: settlePicture(x.text, token, url, pic.put, pic.alt), pics: x.pics.filter((f) => f.id !== pic.id) }))
        if (el && at) requestAnimationFrame(() => document.activeElement === el && el.setSelectionRange(...remap(...at, el.value)))
      }
      w()
        .then((m) => m.upload(file, (stage, f, secs) => patch({ stage, pct: f === undefined ? undefined : Math.round(f * 100), left: secs })))
        .then((url) => done(url), (e) => (done(), toast(e.message)))
      return pic
    })
    update(part.id, (x) => ({ text, pics: [...x.pics, ...pics] }))
    if (s.el?.isConnected) requestAnimationFrame(() => (s.el!.focus(), s.el!.setSelectionRange(a, b)))
  }
  // ⌘B / Ctrl+B and ⌘I / Ctrl+I in a post: bold and italic, like the buttons. The letter is the one typed, or for a
  // layout without Latin letters (Russian, say) the key where B or I sits.
  const shortcut = (e: KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || !(e.target instanceof HTMLTextAreaElement)) return
    const k = /^[a-z]$/i.test(e.key) ? e.key.toLowerCase() : e.code.replace(/^Key/, '').toLowerCase()
    if (k === 'b' || k === 'i') e.preventDefault(), fmt({ mark: k === 'b' ? '**' : '*' })
  }
  // The emoji list is the heavy part, so the module only loads when the picker is opened.
  const [emoji, setEmoji] = useState<typeof import('./emoji.tsx') | null>(null)
  // Where the caret was, read on mousedown: by the time the click lands the focus has left the textarea, so an
  // emoji would otherwise go on the end. The textarea is only hidden while the picker is up, never unmounted,
  // so holding on to it is safe.
  const spot = useRef<{ el: HTMLTextAreaElement; text: string; start: number; end: number } | null>(null)
  const grabCaret = () => {
    const el = document.activeElement
    spot.current = el instanceof HTMLTextAreaElement ? { el, text: el.value, start: el.selectionStart, end: el.selectionEnd } : null
  }
  const openEmoji = () => import('./emoji.tsx').then(setEmoji, () => toast('Something went wrong and Quilcast stopped. Reloading the page usually fixes it.'))
  const insert = (ch: string) => {
    const s = spot.current
    // a picture may have finished uploading while the picker was up
    const [from, to] = s ? remap(s.text, s.start, s.end, cur.text) : [cur.text.length, cur.text.length]
    update(cur.id, (x) => ({ text: x.text.slice(0, from) + ch + x.text.slice(to) }))
    setEmoji(null)
    // back to the post with the caret after what was just put in
    if (s) {
      const caret = from + ch.length
      requestAnimationFrame(() => (s.el.focus(), s.el.setSelectionRange(caret, caret)))
    }
  }

  // a GIF is attached as it is, already at its URL
  const gif = (url: string) => {
    const part = cur
    update(part.id, (x) => ({ files: withGif(x.files, fixed(at), { id: Math.random(), preview: url, video: false, url }) }))
    setGifs(false)
  }
  // every attachment counts here, even one the text shows inline (not sent, see slots): the author may take that picture
  // out of the text again, and then all of them go out, never more than MAX_EMBEDS
  const room = busy ? 0 : embedRoom(cur.files.length, fixed(at))
  const add = () => (setParts((ps) => [...ps, newPart()]), setActive(parts.length))
  const send = async () => {
    if (when) return later(when)
    setBusy(true)
    const m = await w()
    const out = parts.flatMap((p, i) => (filled(p, i) ? [{ id: p.id, text: p.text.trim(), media: postMedia(i === 0 ? embeds : [], p.files, p.text) }] : []))
    // posts of this thread that went out before this send: a failed scheduled thread opened with only the rest, or an
    // earlier try here
    const before = gone && !gone.again ? gone.posted : 0
    let done = 0, root = cont?.root, next = cont?.next
    try {
      // a thread is the first cast plus each next one replying to the one before it; a retry goes on from the last cast out
      const start = next || { parent: parent && { fid: parent.author.fid, hash: parent.hash }, channel: !parent && channel ? await urlOf(channel) : undefined, quote: quote && { fid: quote.author.fid, hash: quote.hash }, as }
      await m.postThread(out, start, (hash, at, i) => {
        root ||= hash
        next = at
        done = i + 1
        setParts((ps) => ps.filter((x) => x.id !== out[i].id))
      })
    } catch (e: any) {
      failed = true
      toast(e.message)
      setBusy(false)
    }
    // once anything went out, the draft or scheduled cast this was opened from would send it again: it goes, and what is
    // left stays here (closing asks to keep it as a draft)
    if (done && draft) m.dropDraft(draft).catch(() => {})
    if (done && editing) unschedule(m, editing)
    if (done === out.length) {
      onClose(root!)
      toast(before + out.length > 1 ? 'Thread posted' : parent ? 'Reply sent' : 'Cast sent')
      // a mini app that asked for the cast stays on screen
      return onDone || (go(`/c/${root}`), sent())
    }
    if (!done) return
    // whatever went out was removed from the composer above; the rest replies to the last of it
    const last = (next as ThreadStart).parent!
    setCont({ next: next!, root: root! })
    setCtx({ parent: posting.get(last.hash) || standIn(last.hash, out[done - 1].text, userOf(as), Date.now()), quote: undefined })
    setChannel(undefined)
    // an empty post the send skipped would now be the first one, which can't be empty
    setParts((ps) => (ps.some((p) => p.text.trim() || p.files.length) ? ps.filter((p) => p.text.trim() || p.files.length) : ps))
    setGone({ posted: before + done, total: before + out.length, again: false })
    setDraft(undefined)
    setEditing(undefined)
  }
  // signed now for its time, then held by our server until then (write.ts schedule)
  const later = async (at: number) => {
    if (at < Date.now() + 60e3) return toast('Pick a time at least a minute from now.')
    setBusy(true)
    const m = await w()
    try {
      const posts = parts.flatMap((p, i) => (filled(p, i) ? [{ text: p.text.trim(), media: postMedia(i === 0 ? embeds : [], p.files, p.text) }] : []))
      const media = (p: Part) => p.files.flatMap((f) => (f.url ? [f.url] : []))
      // the same one again, edited, replaces it on the server at once (refused once it went out); another account's
      // is a new one, and the old one goes after
      const same = editing?.status === 'scheduled' && editing.fid === as.fid
      await m.schedule(posts, {
        parent: parent && { fid: parent.author.fid, hash: parent.hash },
        channel: !parent && channel ? await urlOf(channel) : undefined,
        quote: quote && { fid: quote.author.fid, hash: quote.hash },
        as,
        draft: { parts: parts.map((p) => ({ text: p.text, media: media(p) })), channel: parent ? undefined : channel, parent: parent?.hash, quote: quote?.hash, as: as.fid },
      }, at, same ? editing!.id : undefined)
      if (editing && !same) await unschedule(m, editing)
      if (draft) m.dropDraft(draft).catch(() => {})
      toast(t('Scheduled for {time}', { time: whenOf(at) }))
      onClose()
    } catch (e: any) {
      toast(e.message)
      setBusy(false)
    }
  }
  return (
    <div class="modal" onClick={leave}>
      <div class="sheet" tabIndex={-1} role="dialog" aria-label={parent ? t('Reply') : quote ? t('Quote cast') : t('New cast')} onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => (e.key === 'Escape' && (emoji ? setEmoji(null) : gifs ? setGifs(false) : drafts ? setDrafts(false) : scheduledOpen ? setScheduledOpen(false) : leave()), (e.metaKey || e.ctrlKey) && e.key === 'Enter' && ready && !busy && send(), shortcut(e))}>
        <div class="sheet-top">
          <span class="sheet-left">
            <button class="link-btn" onClick={leave}>{t('Cancel')}</button>
            {canDraft && (empty || drafts) && !draft && !editing && !scheduledOpen && <button class={`link-btn${drafts ? ' on' : ''}`} aria-pressed={drafts} onClick={() => setDrafts(!drafts)}>{t('Drafts')}</button>}
            {canDraft && (empty || scheduledOpen) && !draft && !editing && !drafts && <button class={`link-btn${scheduledOpen ? ' on' : ''}`} aria-pressed={scheduledOpen} onClick={() => setScheduledOpen(!scheduledOpen)}>{t('Scheduled')}</button>}
          </span>
          {/* a failed thread going on from its last post stays with the account that posted it */}
          {!(gone && !gone.again) && <AsPicker value={as} set={setAs} />}
          <button class="btn" disabled={busy || !ready} onClick={send}>{busy ? t('Sending…') : when ? t('Schedule') : parts.length > 1 ? t('Post all') : parent ? t('Reply') : t('Cast')}</button>
        </div>
        {asking && (
          <div class="draft-ask" role="alertdialog" aria-label={t('Save this as a draft?')}>
            <span>{t('Save this as a draft?')}</span>
            <button class="link-btn" onClick={() => onClose()}>{t('Discard')}</button>
            <button class="btn" disabled={busy || uploading} onClick={keep}>{t('Save draft')}</button>
          </div>
        )}
        {drafts && <DraftList open={open} close={() => setDrafts(false)} />}
        {scheduledOpen && <ScheduledList as={as} open={edit} close={() => setScheduledOpen(false)} />}
        {timing && !drafts && !scheduledOpen && (
          <div class="schedule-at">
            <Icon d={P.clock} size={18} />
            <input type="datetime-local" aria-label={t('Post at')} min={localInput(Date.now() + 120e3)} max={localInput(Date.now() + 30 * 86400e3)} value={when ? localInput(when) : ''}
              onInput={(e) => setWhen(e.currentTarget.value ? new Date(e.currentTarget.value).getTime() || undefined : undefined)} />
            <button class="link-btn" onClick={() => (setWhen(undefined), setTiming(false))}>{editing ? t('Post now instead') : t('Clear')}</button>
          </div>
        )}
        {gone && !drafts && !scheduledOpen && (
          <p class={`sent-note${gone.again ? ' warn' : ''}`} role={gone.again ? 'alert' : undefined}>
            {gone.again
              ? t('{posted} of {total} posts already went out. Sending this thread again posts them a second time.', { posted: gone.posted, total: gone.total })
              : t('{posted} of {total} posts already went out. The rest goes out as replies to the last one.', { posted: gone.posted, total: gone.total })}
          </p>
        )}
        {parent && !drafts && !scheduledOpen && (
          <div class="ctx">
            <Avatar u={parent.author} size={28} link={false} />
            <div><b>{nameOf(parent.author)}</b> <span class="handle">@{handle(parent.author)}</span><p>{castText(parent).slice(0, 200)}</p></div>
          </div>
        )}
        {gifs && <GifPicker cast start="trending" pick={gif} close={() => setGifs(false)} />}
        {emoji && <emoji.EmojiPicker pick={insert} close={() => setEmoji(null)} />}
        <div class="parts" hidden={gifs || drafts || scheduledOpen || !!emoji}>
          {parts.map((p, i) => (
            <PartEditor key={p.id} part={p} set={(x) => update(p.id, x)} first={i === 0} last={i === parts.length - 1} quote={quote} embeds={embeds} focus={i === at && !gifs && !drafts && !scheduledOpen && !emoji}
              onFocus={() => setActive(i)} attach={attach} md={md}
              remove={i > 0 ? () => (setParts((ps) => ps.filter((x) => x.id !== p.id)), setActive(i - 1)) : undefined}
              placeholder={i > 0 ? t('Add another post') : parent ? t('Reply to {name}', { name: `@${handle(parent.author)}` }) : quote ? t('Add a comment') : t("What's happening?")} />
          ))}
        </div>
        {md && (
          <div class="md-tools" hidden={gifs || drafts || scheduledOpen || !!emoji} onMouseDown={(e) => e.preventDefault()}>
            {([
              [t('Bold'), <b>B</b>, { mark: '**' }, 'B'], [t('Italic'), <i>I</i>, { mark: '*' }, 'I'], [t('Strikethrough'), <s>S</s>, { mark: '~~' }],
              [t('Code'), <Icon d={P.code} size={18} />, { mark: '`' }], [t('Link'), <Icon d={P.link} size={18} />, { link: t('link') }],
              [t('Heading'), <b>H</b>, { line: '## ' }], [t('Bulleted list'), <Icon d={P.list} size={18} />, { line: '- ' }],
              [t('Numbered list'), <Icon d={P.olist} size={18} />, { line: '1. ' }], [t('Quote'), <Icon d={P.quote} size={18} />, { line: '> ' }],
              [t('Table'), <Icon d={P.table} size={18} />, { table: t('Column') }],
            ] as [string, any, Format, string?][]).map(([label, face, how, key]) => (
              <button class="icon-btn" aria-label={label} aria-keyshortcuts={key && `${MOD === '⌘' ? 'Meta' : 'Control'}+${key}`} title={key ? `${label} (${MOD}${key})` : label} onClick={() => fmt(how)}>{face}</button>
            ))}
            <input ref={picker} type="file" accept="image/*" multiple hidden onChange={(e) => (pictures(e.currentTarget.files), (e.currentTarget.value = ''))} />
            <button class="icon-btn" aria-label={t('Image')} title={t('Image')} disabled={busy} onClick={pickPicture}><Icon d={P.image} size={18} /></button>
          </div>
        )}
        <div class="toolbar" hidden={gifs || drafts || scheduledOpen || !!emoji}>
          <input ref={pick} type="file" accept="image/*,video/mp4,video/webm,video/quicktime" multiple hidden onChange={(e) => (attach(e.currentTarget.files), (e.currentTarget.value = ''))} />
          <button class="icon-btn" aria-label={t('Add photo or video')} disabled={!room} onClick={() => pick.current?.click()}><Icon d={P.image} /></button>
          <button class="icon-btn" aria-label={t('Add a GIF')} title={t('Add a GIF')} disabled={!room} onClick={() => setGifs(true)}><Icon d={P.gif} /></button>
          <button class="icon-btn" aria-label={t('Add an emoji')} title={t('Add an emoji')} onMouseDown={grabCaret} onClick={openEmoji}><Icon d={P.smile} /></button>
          <button class={`icon-btn${md ? ' on' : ''}`} aria-label={t('Markdown')} title={t('Markdown')} aria-pressed={md} onClick={() => setMd(!md)}><Icon d={P.markdown} /></button>
          {canDraft && <button class={`icon-btn${timing ? ' on' : ''}`} aria-label={t('Schedule')} title={t('Schedule')} aria-pressed={timing} disabled={busy} onClick={() => (timing ? (setTiming(false), setWhen(undefined)) : (setTiming(true), setWhen((x) => x || Math.ceil((Date.now() + 3600e3) / 300e3) * 300e3)))}><Icon d={P.clock} /></button>}
          {!parent && <ChannelPicker value={channel} set={setChannel} fid={as.fid} />}
          <span class={`count${left < 50 ? ' warn' : ''}`} title={used(cur) > 320 ? t('Long cast: up to 1024 characters') : t('Up to 320 characters, or 1024 as a long cast')}>
            {used(cur) > 280 ? left : ''}
          </span>
          <button class="icon-btn add-part" aria-label={t('Add another post to the thread')} disabled={!filled(cur, at)} onClick={add}><Icon d={P.plus} /></button>
        </div>
      </div>
    </div>
  )
}
