// Messages: farcaster.xyz's direct casts, drawn from the state in dms.ts, which the websocket keeps current.
import { Fragment } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { account, myUser, safeUrl, settings, type User } from './api.ts'
import { autoDelete, compact, details, load, loadChat, lookup, mute, read, sameDay, send, store, subscribe, unread, type Box, type Convo, type Msg, type Person } from './dms.ts'
import { lang, t, tn } from './i18n.ts'
import { isImg, sized } from './shared.ts'
import { ago, Avatar, handle, Header, Icon, Img, Menu, nameOf, P, RichText, shell, Tabs, toast, userPath, w } from './ui.tsx'

const person = (p?: Person): User => ({ fid: p?.fid || 0, username: p?.username, display_name: p?.displayName, pfp_url: p?.pfp?.url })
const who = (p?: Person) => (p?.fid && p.fid === account!.fid ? t('You') : p?.username ? `@${p.username}` : p?.displayName || t('Someone'))
// only the first letter: German nouns keep their capitals ("nach einem Tag")
const lower = (s: string) => s.charAt(0).toLocaleLowerCase(lang) + s.slice(1)
const when = (t: number) => new Date(t).toLocaleString(lang, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const MUTED = `${P.bell}M3 3l18 18`
const TTL: [number | 'Infinity', string][] = [['Infinity', 'Never'], [1, 'After a day'], [7, 'After a week'], [30, 'After 30 days'], [365, 'After a year']]
// image links in a message show as images; the rest stays text
const partsOf = (m: Msg) => {
  const pics: string[] = []
  if (m.isDeleted) return { pics, text: m.message }
  const text = m.message.replace(/\S+/g, (t) => (isImg(t) && safeUrl(t) ? (pics.push(safeUrl(t)!), '') : t)).replace(/ {2,}/g, ' ').trim()
  return { pics, text }
}

/** Group events carry numbers (FIDs, days) in `message`; say what happened instead. */
function describe(m: Msg) {
  const by = who(m.senderContext)
  const to = who(m.actionTargetUserContext)
  const self = m.actionTargetUserContext?.fid === m.senderContext?.fid
  switch (m.type) {
    case 'group_membership_addition': return self ? t('{name} joined', { name: to }) : t('{by} added {name}', { by, name: to })
    case 'group_membership_removal': return self ? t('{name} left', { name: to }) : t('{by} removed {name}', { by, name: to })
    case 'group_name_change': return t('{by} renamed the group to {title}', { by, title: m.message })
    case 'pin_message': return t('{by} pinned a message', { by })
    case 'message_ttl_change': {
      if (m.message === 'Infinity') return t('{by} turned off auto-delete', { by })
      const label = TTL.find(([d]) => String(d) === m.message)?.[1]
      return t('{by} set messages to auto-delete {when}', { by, when: label ? lower(t(label)) : tn(Number(m.message), 'after {n} day', 'after {n} days') })
    }
    default: return m.message || m.type.replace(/_/g, ' ')
  }
}
const preview = (m: Msg, group: boolean) => {
  if (m.type !== 'text') return describe(m)
  if (m.isDeleted) return t('Message deleted')
  const text = partsOf(m).text || t('Image')
  return m.senderFid === account!.fid ? t('You: {text}', { text }) : group ? t('{name}: {text}', { name: who(m.senderContext), text }) : text
}

// the other person in a 1:1, else the group
const face = (c: Convo) => {
  const other = c.isGroup ? undefined : c.viewerContext.counterParty || c.participants?.find((p) => p.fid !== account!.fid)
  return other ? { name: nameOf(person(other)), user: person(other), one: true } : { name: c.name || t('Group'), user: { fid: 0, display_name: c.name || t('Group'), pfp_url: c.photoUrl }, one: false }
}
function useStore() {
  const [, force] = useState(0)
  useEffect(() => subscribe(() => force((x) => x + 1)), [])
}

/** The inbox, or one conversation when `id` is given. */
export function Messages({ id }: { id?: string }) {
  if (!account?.done) return <><Header title={t('Messages')} /><div class="note">{t('Sign in to read your messages.')}</div></>
  if (!account.dm) return <Connect />
  // Quorum mode: Quorum's two panes, the conversations beside the open one (one at a time on narrow screens)
  if (settings.quorum) {
    return (
      <div class={`q-dms${id ? ' open' : ''}`}>
        <div class="q-dm-list"><Inbox /></div>
        <div class="q-dm-main">{id ? <Chat key={id} id={id} /> : <div class="q-empty"><Icon d={P.mail} size={56} /><p>{t("What's on your mind today?")}</p></div>}</div>
      </div>
    )
  }
  return id ? <Chat key={id} id={id} /> : <Inbox />
}

function Connect() {
  const [busy, setBusy] = useState(false)
  const open = async () => {
    setBusy(true)
    try {
      await (await w()).connectMessages()
    } catch (e: any) {
      toast(e.message)
      setBusy(false)
    }
  }
  return (
    <>
      <Header title={t('Messages')} />
      <div class="join">
        <p class="lede">{t("Messages are farcaster.xyz's direct casts, which aren't on the Farcaster network itself. Quilcast opens them with a key from farcaster.xyz that reads and sends your messages and does nothing else.")}</p>
        <p class="muted">{account!.wallet ? t('Your wallet signs for that key once.') : t('Your recovery phrase signs for it here, with no prompt.')} {t("farcaster.xyz only talks to its own site, so messages pass through Quilcast's server on the way; it doesn't keep them. As on farcaster.xyz, they aren't end-to-end encrypted.")}</p>
        <button class="btn wide" disabled={busy} onClick={open}>{busy ? (account!.wallet ? t('Check your wallet…') : t('Opening…')) : t('Open messages')}</button>
      </div>
    </>
  )
}

type Tab = 'inbox' | 'unread' | 'requests' | 'muted'
const EMPTY: Record<Tab, string> = { inbox: 'No messages yet. Start one from someone’s profile.', unread: 'Nothing unread.', requests: 'No message requests.', muted: 'No muted conversations.' }
// Unread and Requests are lists farcaster.xyz filters; Inbox and Muted are views of the inbox (muted has no filter there)
const BOX: Record<Tab, Box> = { inbox: 'default', unread: 'unread', requests: 'request', muted: 'default' }
const MATCH: Record<Tab, (c: Convo) => boolean> = {
  inbox: (c) => !c.viewerContext.muted,
  unread: (c) => unread(c) && !c.viewerContext.muted,
  requests: () => true,
  muted: (c) => !!c.viewerContext.muted,
}

function Inbox() {
  useStore()
  const [tab, setTab] = useState<Tab>('inbox')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const box = BOX[tab]
  const list = store.lists[box]
  // the unread list is small and gives the tab its count, so it comes along
  useEffect(() => void (list.items || load(box).catch((e) => setErr(e.message)), store.lists.unread.items || load('unread').catch(() => {})), [box])
  const shown = list.items?.filter(MATCH[tab])
  const unreadN = (store.lists.unread.items || store.lists.default.items)?.filter(MATCH.unread).length
  // infinite scroll: whenever the end of the list is near the screen, the next page loads. It's re-armed after every
  // render, so pages that add nothing to this tab (Muted) keep loading until the screen fills or the list ends.
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!list.items || !list.more || busy || err) return
    const o = new IntersectionObserver((e) => {
      if (!e[0].isIntersecting) return
      o.disconnect()
      setBusy(true)
      load(box, true).catch((e) => setErr(e.message)).finally(() => setBusy(false))
    }, { rootMargin: '600px' })
    end.current && o.observe(end.current)
    return () => o.disconnect()
  })
  return (
    <>
      {/* (in Quorum mode the list is a pane beside the conversation, with nowhere to go back to) */}
      <Header title={t('Messages')} back={!settings.quorum}>
        <Tabs tabs={[['inbox', t('Inbox')], ['unread', unreadN ? t('Unread · {n}', { n: unreadN }) : t('Unread')], ['requests', store.requestsCount ? t('Requests · {n}', { n: store.requestsCount }) : t('Requests')], ['muted', t('Muted')]]} value={tab} set={setTab} />
      </Header>
      {err && <div class="note">{t("Couldn't load messages: {error}", { error: t(err) })} <button class="link-btn" onClick={() => (setErr(''), list.items || load(box).catch((e) => setErr(e.message)))}>{t('Retry')}</button></div>}
      {!shown && !err && <div class="spinner" />}
      {shown?.length === 0 && !list.more && <div class="note">{t(EMPTY[tab])}</div>}
      {shown?.map((c) => <Row key={c.conversationId} c={c} />)}
      {/* Muted can only be found by looking through the whole inbox, which can take a while */}
      {busy && (tab === 'muted' ? <div class="note">{t('Looking through your conversations for muted ones… {n} checked', { n: list.items?.length || 0 })}</div> : <div class="spinner" />)}
      <div ref={end} />
    </>
  )
}

function Row({ c }: { c: Convo }) {
  const { name, user } = face(c)
  const n = c.viewerContext.unreadCount || 0
  const m = c.lastMessage
  // Quorum's rows put the time at the far end and mark the open conversation
  const q = settings.quorum
  const on = q && location.pathname === `/messages/${c.conversationId}`
  return (
    <a class={`row${n ? ' unread' : ''}${on ? ' on' : ''}`} href={`/messages/${c.conversationId}`} aria-current={on ? 'page' : undefined}>
      <Avatar u={user} link={false} />
      <span class="row-main">
        <span class="row-top"><b>{name}</b>{c.viewerContext.muted && <Icon d={MUTED} size={14} />}{m && <span class="handle">{q ? ago(m.serverTimestamp) : `· ${ago(m.serverTimestamp)}`}</span>}</span>
        {m && <span class="row-sub">{preview(m, c.isGroup)}</span>}
      </span>
      {n > 0 && <span class={`unread-count${c.viewerContext.muted ? ' quiet' : ''}`}>{n}</span>}
    </a>
  )
}

// Quorum's message rows (quorum-desktop Message.tsx): a face, the name and the time over the first of a run, then
// compact rows with the time in the face's place; days are split by a dated line
const clock = (at: number) => new Date(at).toLocaleTimeString(lang, { hour: 'numeric', minute: '2-digit' })
function QRow({ m, head, mine }: { m: Msg; head: boolean; mine: boolean }) {
  if (m.type !== 'text') return <div class="q-msg-note">{describe(m)}</div>
  const { pics, text } = partsOf(m)
  const u = (mine && myUser()) || person(m.senderContext)
  return (
    <div class={`q-msg${head ? ' head' : ''}`}>
      {head ? <Avatar u={u} size={44} /> : <time class="q-msg-side" dateTime={new Date(m.serverTimestamp).toISOString()}>{clock(m.serverTimestamp)}</time>}
      <div class="q-msg-body">
        {head && <div class="q-msg-top"><a class="q-msg-name" href={userPath(u)}>{nameOf(u)}</a><time title={when(m.serverTimestamp)}>{clock(m.serverTimestamp)}</time></div>}
        {pics.map((p, i) => <button class={`dm-img ${m.state || ''}`} onClick={() => shell.view(pics, i)}><Img src={sized(p, 'w=600')} /></button>)}
        {(text || !pics.length) && <div class={`q-msg-text ${m.state || ''}`}>{m.isDeleted ? <i>{t('Message deleted')}</i> : <RichText text={text} />}</div>}
        {m.state && <small class={m.state === 'failed' ? 'warn' : 'msg-state'}>{m.state === 'failed' ? t('Not sent') : t('Sending…')}</small>}
      </div>
    </div>
  )
}
// "Today", "Yesterday", or the date, in the app's language
const dayLabel = (at: number) => {
  const back = sameDay(at, Date.now()) ? 0 : sameDay(at, Date.now() - 864e5) ? -1 : null
  if (back === null) return new Date(at).toLocaleDateString(lang, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  const s = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' }).format(back, 'day')
  return s[0].toLocaleUpperCase(lang) + s.slice(1)
}

// in groups, others' messages carry a name on the first of a run and a face on the last
function Bubble({ m, mine, group, name, face }: { m: Msg; mine: boolean; group: boolean; name?: Person; face?: Person }) {
  if (m.type !== 'text') return <div class="msg-note">{describe(m)}</div>
  const { pics, text } = partsOf(m)
  return (
    <div class={`msg${mine ? ' mine' : ''}`} title={when(m.serverTimestamp)}>
      {group && !mine && <span class="msg-face">{face && <Avatar u={person(face)} size={28} />}</span>}
      <div class="msg-col">
        {name && <span class="msg-who">{nameOf(person(name))}</span>}
        {pics.map((u, i) => <button class={`dm-img ${m.state || ''}`} onClick={() => shell.view(pics, i)}><Img src={sized(u, 'w=600')} /></button>)}
        {(text || !pics.length) && <div class={`bubble ${m.state || ''}`}>{m.isDeleted ? <i>{t('Message deleted')}</i> : <RichText text={text} />}</div>}
        {m.state && <small class={m.state === 'failed' ? 'warn' : 'msg-state'}>{m.state === 'failed' ? t('Not sent') : t('Sending…')}</small>}
      </div>
    </div>
  )
}

function Chat({ id }: { id: string }) {
  useStore()
  const me = account!.fid!
  const c = store.convos.get(id)
  const chat = store.chats.get(id)
  const msgs = chat?.msgs || []
  const [text, setText] = useState('')
  const [err, setErr] = useState('')
  const [menu, setMenu] = useState(false)
  const atBottom = useRef(true)
  useEffect(() => {
    // on screen, so what arrives here is read as it comes
    store.open = id
    lookup(id).then((c) => read(c.conversationId), () => setErr(t("This conversation isn't yours, or doesn't exist.")))
    loadChat(id).catch(() => {})
    const scroll = () => (atBottom.current = innerHeight + scrollY >= document.documentElement.scrollHeight - 120)
    const back = () => document.visibilityState === 'visible' && read(id)
    addEventListener('scroll', scroll, { passive: true })
    document.addEventListener('visibilitychange', back)
    return () => {
      if (store.open === id) store.open = ''
      removeEventListener('scroll', scroll)
      document.removeEventListener('visibilitychange', back)
    }
  }, [])
  // follow new messages while at the bottom
  const last = msgs.at(-1)?.messageId
  useEffect(() => void (atBottom.current && scrollTo(0, document.documentElement.scrollHeight)), [msgs.length, last])
  const earlier = async () => {
    const h = document.documentElement.scrollHeight
    atBottom.current = false
    await loadChat(id, true).catch((e) => toast(e.message))
    // keep the messages on screen where they were
    requestAnimationFrame(() => scrollBy(0, document.documentElement.scrollHeight - h))
  }
  const submit = () => {
    const message = text.trim()
    if (!message || !c) return
    setText('')
    atBottom.current = true
    send(c, message).catch((e) => toast(t("Couldn't send: {error}", { error: t(e.message) })))
  }
  const f = c && face(c)
  const muted = !!c?.viewerContext.muted
  const title = f && (
    <span class="chat-title">
      <Avatar u={f.user} size={28} link={f.one} />
      {f.one ? <a class="plain" href={userPath(f.user)}>{f.name}</a> : f.name}
      {/* Quorum's header: the name | the address (here, the handle) */}
      {settings.quorum && f.one && !handle(f.user).startsWith('!') && <span class="q-chat-sub">| @{handle(f.user)}</span>}
      {muted && <Icon d={MUTED} size={15} />}
    </span>
  )
  // settings for a conversation that exists (one with messages); auto-delete is read when the menu opens
  const action = c && msgs.length > 0 && (
    <span class="wrap-menu">
      <button class="icon-btn" aria-label={t('Conversation settings')} aria-haspopup="menu" onClick={() => (setMenu(!menu), !menu && c.messageTTLDays === undefined && details(c).catch(() => {}))}><Icon d={P.more} /></button>
      {menu && (
        <Menu class="right" close={() => setMenu(false)}>
          <button role="menuitem" onClick={() => (setMenu(false), mute(c, !muted).catch((e) => toast(e.message)))}><Icon d={muted ? P.bell : MUTED} />{muted ? t('Unmute') : t('Mute')}</button>
          <small class="menu-label">{t('Auto-delete messages')}</small>
          {TTL.map(([d, label]) => (
            <button role="menuitemradio" aria-checked={c.messageTTLDays === d} onClick={() => (setMenu(false), autoDelete(c, d).catch((e) => toast(e.message)))}>
              {t(label)}{c.messageTTLDays === d && <Icon d={P.check} />}
            </button>
          ))}
        </Menu>
      )}
    </span>
  )
  return (
    <>
      <Header title={title || t('Messages')} action={action} />
      <div class="dm">
        {err && <div class="note">{err}</div>}
        {c?.viewerContext.category === 'request' && <div class="banner"><div><b>{t('Message request')}</b><p>{t('Replying moves this conversation to your inbox.')}</p></div></div>}
        <div class="chat">
          {chat?.older && <button class="link-btn earlier" onClick={earlier}>{t('Earlier messages')}</button>}
          {settings.quorum ? msgs.map((m, i) => {
            const prev = msgs[i - 1]
            const day = !prev || !sameDay(prev.serverTimestamp, m.serverTimestamp)
            return (
              <Fragment key={m.messageId}>
                {day && <div class="q-day"><span>{dayLabel(m.serverTimestamp)}</span></div>}
                <QRow m={m} mine={m.senderFid === me} head={!compact(m, prev, day)} />
              </Fragment>
            )
          }) : msgs.map((m, i) => {
            const prev = msgs[i - 1]
            const next = msgs[i + 1]
            const gap = (a?: Msg, b?: Msg) => !a || !b || b.serverTimestamp - a.serverTimestamp > 3600e3
            // a run is one sender's text messages in a row, with no time break between them
            const same = (x?: Msg) => !!x && x.type === 'text' && x.senderFid === m.senderFid
            const group = !!c?.isGroup
            const theirs = group && m.senderFid !== me
            return (
              <Fragment key={m.messageId}>
                {gap(prev, m) && <div class="msg-note">{when(m.serverTimestamp)}</div>}
                <Bubble m={m} mine={m.senderFid === me} group={group}
                  name={theirs && (!same(prev) || gap(prev, m)) ? m.senderContext : undefined}
                  face={theirs && (!same(next) || gap(m, next)) ? m.senderContext : undefined} />
              </Fragment>
            )
          })}
          {!chat && !err && <div class="spinner" />}
          {chat && !msgs.length && f && <div class="note">{f.one ? t('This is the start of your conversation with {name}.', { name: f.name }) : t('No messages yet.')}</div>}
        </div>
        {!err && (settings.quorum ? (
          // Quorum's composer: one rounded box with the send arrow inside it
          <div class="dm-compose q-compose-box">
            <div class="q-composer">
              <textarea dir="auto" rows={1} value={text} placeholder={t('Message')} maxLength={1024} aria-label={t('Message')}
                onInput={(e) => setText(e.currentTarget.value)} onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), submit())} />
              <button class="q-send" aria-label={t('Send')} title={t('Send')} disabled={!text.trim() || !c} onClick={submit}><svg width="18" height="14" viewBox="0 0 100 80" aria-hidden="true"><path d="M0 80L25 40.4L0 0l100 40.4z" fill="currentColor" /></svg></button>
            </div>
          </div>
        ) : (
          <div class="dm-compose">
            <textarea dir="auto" rows={1} value={text} placeholder={t('Message')} maxLength={1024} aria-label={t('Message')}
              onInput={(e) => setText(e.currentTarget.value)} onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), submit())} />
            <button class="btn small" disabled={!text.trim() || !c} onClick={submit}>{t('Send')}</button>
          </div>
        ))}
      </div>
    </>
  )
}
