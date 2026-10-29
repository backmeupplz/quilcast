import { useEffect, useRef, useState } from 'preact/hooks'
import { account, accounts, findUsers, get, go, idOf, LINK_RE, loadUsers, myUser, toUrl, users, type Account, type Cast, type User } from './api.ts'
import { t } from './i18n.ts'
import { GifPicker } from './gifs.tsx'
import { castText, embedRoom, isImg, isVid, postMedia, withGif } from './shared.ts'
import { ago, Avatar, channelUrl, fetchCast, handle, Icon, LinkCard, Media, Menu, nameOf, P, QuoteCard, toast, w } from './ui.tsx'
import type { Draft } from './write.ts'

type Attachment = { id: number; preview: string; video: boolean; url?: string; err?: string; stage?: 'uploading' | 'processing'; pct?: number; left?: number }
const bytes = (s: string) => new TextEncoder().encode(s).length

const userOf = (a: Account): User => (a.fid && users.get(a.fid)) || { fid: a.fid || 0, username: a.username }

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

function ChannelPicker({ value, set }: { value?: string; set: (v?: string) => void }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [list, setList] = useState<{ id: string; member_count?: number }[]>([])
  useEffect(() => {
    if (!q.trim()) return setList([])
    const t = setTimeout(() => get('/v2/farcaster/channel/search', { q: q.trim(), limit: 8 }).then((r) => setList(r.channels), () => {}), 250)
    return () => clearTimeout(t)
  }, [q])
  return (
    <span class="wrap-menu">
      <button class={`chip${value ? ' on' : ''}`} onClick={() => setOpen(!open)} aria-haspopup="menu"><Icon d={P.hash} size={14} />{value ? `/${value}` : t('Channel')}</button>
      {open && (
        <Menu class="picker" close={() => setOpen(false)}>
          <input autoFocus value={q} onInput={(e) => setQ(e.currentTarget.value)} placeholder={t('Search channels')} aria-label={t('Search channels')} />
          {value && <button onClick={() => (set(undefined), setOpen(false))}>{t('No channel')}</button>}
          {list.map((c) => <button onClick={() => (set(c.id), setOpen(false), setQ(''))}>/{c.id}<small>{c.member_count ?? ''}</small></button>)}
        </Menu>
      )}
    </span>
  )
}

type Part = { id: number; text: string; files: Attachment[] }
const LIMIT = 1024 // casts over 320 bytes go out as long casts, which allow up to 1024
const newPart = (): Part => ({ id: Math.random(), text: '', files: [] })

// The iOS and Android apps may ask for a store rating once a few casts and replies went out: they count them and decide
// (ios/Quilcast/RatingPrompt.swift, android/app/src/play/…/RatingPrompt.java). A browser or a Farcaster client has no
// such bridge. Not after a send failed this session, and only once the cast's page is up.
let failed = false
const sent = () => {
  if (failed || !navigator.userAgent.includes('QuilcastApp/')) return
  const g = window as unknown as { webkit?: { messageHandlers?: { requestReview?: { postMessage(m: null): void } } }; QuilcastApp?: { requestReview(): void } }
  setTimeout(() => (g.webkit?.messageHandlers?.requestReview?.postMessage(null), g.QuilcastApp?.requestReview()), 2000)
}
const linksIn = (text: string) => [...new Set((text.match(LINK_RE) || []).map(toUrl))]
const fmtLeft = (s?: number) => (s === undefined || !isFinite(s) ? '' : ' · ' + (s < 60 ? t('{n}s left', { n: Math.max(1, Math.round(s)) }) : t('{n} min left', { n: Math.round(s / 60) })))

/** One post of a thread: text with @mention autocomplete, its attachments and the links it will embed. */
function PartEditor({ part, set, first, last, quote, embeds = [], focus, onFocus, attach, placeholder, remove }: {
  part: Part; set: (p: Partial<Part>) => void; first: boolean; last: boolean; quote?: Cast; embeds?: string[]
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
    const t = setTimeout(() => setLinks(linksIn(part.text)), 600)
    return () => clearTimeout(t)
  }, [part.text])
  const findToken = (el: HTMLTextAreaElement) => {
    const m = el.value.slice(0, el.selectionStart).match(/(?:^|\s)@([a-z0-9][a-z0-9.-]*)$/i)
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
  const slots = embedRoom(part.files.length, first ? +!!quote + embeds.length : 0)
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
              {!f.url && !f.err && (
                <span class="att-busy">
                  <span class="spinner small" />
                  <span class="att-stage">{f.stage === 'processing' ? (f.video ? t('Processing video…') : t('Finishing…')) : t('Uploading {pct}%', { pct: f.pct ?? 0 }) + fmtLeft(f.left)}</span>
                  {f.stage !== 'processing' && <span class="att-bar"><i style={{ width: `${f.pct ?? 0}%` }} /></span>}
                </span>
              )}
              {f.err && <span class="att-err">{t(f.err)}</span>}
              <button class="att-x" aria-label={t('Remove')} onClick={() => set({ files: part.files.filter((x) => x.id !== f.id) })}><Icon d={P.x} size={14} /></button>
            </div>
          ))}
        </div>
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

/** `text` and `embeds` prefill the first post (a mini app's composeCast); `onDone` hears the new hash, or null. */
export function Composer({ channel: initial, text = '', embeds = [], onDone, onClose: close, ...props }: { parent?: Cast; quote?: Cast; channel?: string; text?: string; embeds?: string[]; onDone?: (hash: string | null) => void; onClose: () => void }) {
  const [parts, setParts] = useState<Part[]>(() => [{ ...newPart(), text }])
  const onClose = (hash: string | null = null) => (onDone?.(hash), close())
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
  const canDraft = !onDone && !embeds.length
  const [draft, setDraft] = useState<string>()
  const [drafts, setDrafts] = useState(false)
  const [asking, setAsking] = useState(false)
  const snap = (ps: Part[], ch?: string) => JSON.stringify([ps.map((p) => [p.text, p.files.map((f) => f.url)]), ch])
  const base = useRef<string>(undefined)
  base.current ??= snap(parts, channel)
  const empty = parts.every((p) => !p.text.trim() && !p.files.length)
  const uploading = parts.some((p) => p.files.some((f) => !f.url && !f.err))
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
  const open = async (d: Draft) => {
    const [p, q] = await Promise.all([d.parent ? fetchCast(d.parent) : null, d.quote ? fetchCast(d.quote) : null])
    const ps = d.parts.map((x) => ({ ...newPart(), text: x.text, files: x.media.map((url) => ({ id: Math.random(), preview: url, video: isVid(url), url })) }))
    setCtx({ parent: p || undefined, quote: q || undefined })
    setParts(ps)
    setChannel(d.channel)
    setAs(accounts.find((a) => a.done && a.fid === d.as) || account!)
    setDraft(d.id)
    setActive(0)
    setDrafts(false)
    base.current = snap(ps, d.channel)
  }
  const update = (id: number, p: Partial<Part> | ((x: Part) => Partial<Part>)) =>
    setParts((ps) => ps.map((x) => (x.id === id ? { ...x, ...(typeof p === 'function' ? p(x) : p) } : x)))
  // after a failed send took the posts that went out, `active` may point past the end
  const at = parts[active] ? active : 0
  const cur = parts[at]
  const left = LIMIT - bytes(cur.text)
  const filled = (p: Part, i: number) => p.text.trim() || p.files.length || fixed(i)
  const ready = parts.every((p, i) => (filled(p, i) || (i > 0 && !p.text && !p.files.length)) && bytes(p.text) <= LIMIT && p.files.every((f) => f.url)) && filled(parts[0], 0)

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
  // a GIF is attached as it is, already at its URL
  const gif = (url: string) => {
    const part = cur
    update(part.id, (x) => ({ files: withGif(x.files, fixed(at), { id: Math.random(), preview: url, video: false, url }) }))
    setGifs(false)
  }
  const room = busy ? 0 : embedRoom(cur.files.length, fixed(at))
  const add = () => (setParts((ps) => [...ps, newPart()]), setActive(parts.length))
  const send = async () => {
    setBusy(true)
    const m = await w()
    let prev: { fid: number; hash: string } | undefined = parent && { fid: parent.author.fid, hash: parent.hash }
    let first = ''
    try {
      // a thread is the first cast plus each next one replying to the one before it
      for (const [i, p] of parts.entries()) {
        if (!filled(p, i)) continue
        const hash = await m.post(p.text.trim(), {
          parent: prev,
          channel: i === 0 && !parent && channel ? channelUrl(channel) : undefined,
          quote: i === 0 && quote ? { fid: quote.author.fid, hash: quote.hash } : undefined,
          media: postMedia(i === 0 ? embeds : [], p.files),
          as,
        })
        first ||= hash
        prev = { fid: as.fid!, hash }
        setParts((ps) => ps.filter((x) => x.id !== p.id))
      }
      onClose(first)
      if (draft) w().then((m) => m.dropDraft(draft)).catch(() => {})
      toast(parts.length > 1 ? 'Thread posted' : parent ? 'Reply sent' : 'Cast sent')
      // a mini app that asked for the cast stays on screen
      onDone || (go(`/c/${first}`), sent())
    } catch (e: any) {
      // whatever already went out is removed from the composer, so a retry continues the thread
      failed = true
      toast(e.message)
      setBusy(false)
    }
  }
  return (
    <div class="modal" onClick={leave}>
      <div class="sheet" tabIndex={-1} role="dialog" aria-label={parent ? t('Reply') : quote ? t('Quote cast') : t('New cast')} onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => (e.key === 'Escape' && (gifs ? setGifs(false) : drafts ? setDrafts(false) : leave()), (e.metaKey || e.ctrlKey) && e.key === 'Enter' && ready && !busy && send())}>
        <div class="sheet-top">
          <span class="sheet-left">
            <button class="link-btn" onClick={leave}>{t('Cancel')}</button>
            {canDraft && (empty || drafts) && !draft && <button class={`link-btn${drafts ? ' on' : ''}`} aria-pressed={drafts} onClick={() => setDrafts(!drafts)}>{t('Drafts')}</button>}
          </span>
          <AsPicker value={as} set={setAs} />
          <button class="btn" disabled={busy || !ready} onClick={send}>{busy ? t('Sending…') : parts.length > 1 ? t('Post all') : parent ? t('Reply') : t('Cast')}</button>
        </div>
        {asking && (
          <div class="draft-ask" role="alertdialog" aria-label={t('Save this as a draft?')}>
            <span>{t('Save this as a draft?')}</span>
            <button class="link-btn" onClick={() => onClose()}>{t('Discard')}</button>
            <button class="btn" disabled={busy || uploading} onClick={keep}>{t('Save draft')}</button>
          </div>
        )}
        {drafts && <DraftList open={open} close={() => setDrafts(false)} />}
        {parent && !drafts && (
          <div class="ctx">
            <Avatar u={parent.author} size={28} link={false} />
            <div><b>{nameOf(parent.author)}</b> <span class="handle">@{handle(parent.author)}</span><p>{castText(parent).slice(0, 200)}</p></div>
          </div>
        )}
        {gifs && <GifPicker cast start="trending" pick={gif} close={() => setGifs(false)} />}
        <div class="parts" hidden={gifs || drafts}>
          {parts.map((p, i) => (
            <PartEditor key={p.id} part={p} set={(x) => update(p.id, x)} first={i === 0} last={i === parts.length - 1} quote={quote} embeds={embeds} focus={i === at && !gifs && !drafts}
              onFocus={() => setActive(i)} attach={attach}
              remove={i > 0 ? () => (setParts((ps) => ps.filter((x) => x.id !== p.id)), setActive(i - 1)) : undefined}
              placeholder={i > 0 ? t('Add another post') : parent ? t('Reply to {name}', { name: `@${handle(parent.author)}` }) : quote ? t('Add a comment') : t("What's happening?")} />
          ))}
        </div>
        <div class="toolbar" hidden={gifs || drafts}>
          <input ref={pick} type="file" accept="image/*,video/mp4,video/webm,video/quicktime" multiple hidden onChange={(e) => (attach(e.currentTarget.files), (e.currentTarget.value = ''))} />
          <button class="icon-btn" aria-label={t('Add photo or video')} disabled={!room} onClick={() => pick.current?.click()}><Icon d={P.image} /></button>
          <button class="icon-btn" aria-label={t('Add a GIF')} title={t('Add a GIF')} disabled={!room} onClick={() => setGifs(true)}><Icon d={P.gif} /></button>
          {!parent && <ChannelPicker value={channel} set={setChannel} />}
          <span class={`count${left < 50 ? ' warn' : ''}`} title={bytes(cur.text) > 320 ? t('Long cast: up to 1024 characters') : t('Up to 320 characters, or 1024 as a long cast')}>
            {bytes(cur.text) > 280 ? left : ''}
          </span>
          <button class="icon-btn add-part" aria-label={t('Add another post to the thread')} disabled={!filled(cur, at)} onClick={add}><Icon d={P.plus} /></button>
        </div>
      </div>
    </div>
  )
}
