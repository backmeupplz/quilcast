// Sticker packs, Telegram style (server/stickers.mjs): the picker in the composer and in messages, and the pages at
// /stickers (your packs, a new one, a Telegram import) and /stickers/<id> (a pack: add it, share it, change your own).
// A sticker goes out as a picture at quilcast.com/st/<pack>/<hash>.webp; ui.tsx draws those as stickers.
import { useEffect, useState } from 'preact/hooks'
import { account, getUser, go, type User } from './api.ts'
import { t, tn } from './i18n.ts'
import { stickerUrl } from './shared.ts'
import { handle, Header, Icon, P, shell, stop, toast, userPath } from './ui.tsx'
import { stickerOp } from './write.ts'

type Sticker = { h: string; e: string }
type Pack = { id: string; fid: number; title: string; stickers: Sticker[] }
type Job = { id: string; pack: string; total: number; done: number; failed: number; finished: boolean }

const src = (p: string, h: string) => `/st/${p}/${h}.webp`
const shareLink = (id: string) => `https://stickers.quilcast.com/${id}`
const getJson = (u: string) => fetch(u).then((r) => (r.ok ? r.json() : null)).catch(() => null)

// the account's packs, asked once (one request for every embed on a page) and kept in step with what's changed here
let mine: Pack[] | null = null
let asking: Promise<Pack[]> | null = null
const myPacks = (fresh = false): Promise<Pack[]> => {
  if (!account?.fid) return Promise.resolve([])
  if (mine && !fresh) return Promise.resolve(mine)
  if (!asking || fresh) asking = getJson(`/api/stickers/${account.fid}`).then((l) => (mine = (l as Pack[] | null) || mine || []))
  return asking
}
const changed = () => myPacks(true).then(() => dispatchEvent(new Event('stickers')))
function useMine() {
  const [l, setL] = useState<Pack[] | null>(mine)
  useEffect(() => {
    const f = () => myPacks().then(setL)
    f()
    addEventListener('stickers', f)
    return () => removeEventListener('stickers', f)
  }, [])
  return l
}
// Telegram imports this tab started, by pack, so its page shows how they're going
const jobs = new Map<string, Job>()

/** No packs yet: what stickers are and where to get them (or, signed out, to join first). */
const Empty = ({ go: open, title = t('No stickers yet'), about = t('No sticker packs yet. Make one, import one from Telegram, or add one someone shared.'), action = t('Get stickers') }: { go?: () => void; title?: string; about?: string; action?: string }) => (
  <div class="stk-empty">
    <span class="stk-empty-ico"><Icon d={P.sticker} size={30} /></span>
    <b>{title}</b>
    <p>{about}</p>
    {open && <button class="btn small" onClick={open}>{action}</button>}
  </div>
)

/** The composer's and messages' sticker picker: a tab per pack the account has. `manage` leaves for /stickers (the
 *  composer closes itself first, as it sits over the page). */
export function StickerPicker({ pick, close, manage = () => (close(), go('/stickers')) }: { pick: (url: string) => void; close: () => void; manage?: () => void }) {
  // empty packs get no tab
  const packs = useMine()?.filter((x) => x.stickers.length)
  const [at, setAt] = useState(0)
  const p = packs?.[Math.min(at, packs.length - 1)]
  return (
    <div class="lk-edit-body lk-gifs stk-pick">
      <div class="lk-gifs-head">
        <div class="stk-tabs" role="tablist">
          {packs?.map((x, i) => (
            <button role="tab" aria-selected={x === p} class={x === p ? 'on' : ''} title={x.title} aria-label={x.title} onClick={() => setAt(i)}>
              <img src={src(x.id, x.stickers[0].h)} alt="" />
            </button>
          ))}
        </div>
        {!!packs?.length && <button class="icon-btn" aria-label={t('Manage stickers')} title={t('Manage stickers')} onClick={manage}><Icon d={P.gear} /></button>}
        <button class="btn ghost small" onClick={close}>{t('Back')}</button>
      </div>
      {!packs ? <div class="spinner" /> : !p ? <Empty go={manage} /> : (
        <div class="stk-grid">{p.stickers.map((s) => <button aria-label={s.e || t('Sticker')} title={s.e} onClick={() => pick(stickerUrl(p.id, s.h))}><img src={src(p.id, s.h)} alt="" loading="lazy" /></button>)}</div>
      )}
    </div>
  )
}

// packs shown in casts, by id, so a feed asks for each once
const shown = new Map<string, Promise<Pack | null>>()

/** A sticker pack's link in a cast (ui.tsx LinkCard): its first stickers playing, its name, and Add stickers. */
export function PackEmbed({ id }: { id: string }) {
  const [p, setP] = useState<Pack | null | undefined>(undefined)
  const packs = useMine()
  useEffect(() => {
    if (!shown.has(id)) shown.set(id, getJson(`/api/stickers/pack/${id}`))
    shown.get(id)!.then(setP)
  }, [id])
  if (p === undefined) return <div class="stk-embed" aria-busy="true" />
  if (!p) return null
  const owner = account?.fid === p.fid
  const saved = !!packs?.some((x) => x.id === p.id)
  const add = (e: MouseEvent) => {
    e.stopPropagation()
    if (!account?.done) return go(`/stickers/${p.id}`)
    stickerOp({ op: saved ? 'unsave' : 'save', pack: p.id }).then(changed, (err) => toast(err.message))
  }
  return (
    <div class="stk-embed" onClick={(e) => e.stopPropagation()}>
      <a class="stk-embed-strip" href={`/stickers/${p.id}`} onClick={stop} aria-label={p.title}>
        {p.stickers.slice(0, 4).map((s) => <img src={src(p.id, s.h)} alt="" loading="lazy" />)}
      </a>
      <div class="stk-embed-foot">
        <a class="stk-embed-meta" href={`/stickers/${p.id}`} onClick={stop}>
          <b>{p.title}</b>
          <small class="muted">{t('Sticker pack')} · {tn(p.stickers.length, '{n} sticker', '{n} stickers')}</small>
        </a>
        {owner
          ? <a class="btn ghost small" href={`/stickers/${p.id}`} onClick={stop}>{t('Open')}</a>
          : <button class={`btn small${saved ? ' ghost' : ''}`} onClick={add}><Icon d={saved ? P.check : P.plus} size={16} />{saved ? t('Added') : t('Add stickers')}</button>}
      </div>
    </div>
  )
}

/** A picture or video file's bytes as base64, for the 'add' op. */
const base64 = (f: File) => new Promise<string>((ok, no) => {
  const r = new FileReader()
  r.onload = () => ok(String(r.result).replace(/^data:[^,]*,/, ''))
  r.onerror = () => no(new Error("Couldn't read that file."))
  r.readAsDataURL(f)
})

/** Starts a Telegram import (into `pack`, or a new pack) and opens the pack it fills. */
async function importTg(url: string, pack?: string) {
  const r = await stickerOp({ op: 'import', url: url.trim(), ...(pack && { pack }) })
  jobs.set(r.pack.id, r.job)
  changed()
  if (!pack) go(`/stickers/${r.pack.id}`)
  dispatchEvent(new Event('sticker-job'))
}

/** A card with an icon, a title, a line about it and its form. */
const Card = ({ icon, title, about, onSubmit, children }: { icon: string; title: string; about: string; onSubmit?: () => void; children: any }) => (
  <form class="stk-card" onSubmit={(e) => (e.preventDefault(), onSubmit?.())}>
    <div class="stk-card-head"><span class="stk-card-ico"><Icon d={icon} /></span><b>{title}</b></div>
    <p class="muted">{about}</p>
    {children}
  </form>
)

function TgImport({ pack }: { pack?: string }) {
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const run = () => (setBusy(true), importTg(url, pack).then(() => setUrl(''), (e) => toast(e.message)).finally(() => setBusy(false)))
  return (
    <Card icon={P.link} title={pack ? t('Add stickers from a Telegram pack') : t('Import a Telegram sticker pack')} about={t('Paste its link. Animated and video stickers stay animated.')} onSubmit={() => url.trim() && !busy && run()}>
      <div class="stk-row">
        <input value={url} placeholder="t.me/addstickers/…" aria-label={t('Telegram sticker pack link')} inputMode="url" autoComplete="off" onInput={(e) => setUrl(e.currentTarget.value)} />
        <button class="btn small" disabled={!url.trim() || busy}>{busy ? t('Importing…') : t('Import')}</button>
      </div>
    </Card>
  )
}

/** A pack in a list: its first stickers, name and count. */
const PackRow = ({ p }: { p: Pack }) => (
  <a class="stk-pack-row" href={`/stickers/${p.id}`}>
    <span class="stk-peek">{p.stickers.slice(0, 4).map((s) => <img src={src(p.id, s.h)} alt="" loading="lazy" />)}</span>
    <span class="stk-pack-meta"><b>{p.title}</b><small class="muted">{tn(p.stickers.length, '{n} sticker', '{n} stickers')}{p.fid === account?.fid ? '' : ` · ${t('added')}`}</small></span>
    <Icon d={P.chev} />
  </a>
)

function MyPacks() {
  const packs = useMine()
  const [title, setTitle] = useState('')
  const create = () => stickerOp({ op: 'create', title }).then((r) => (changed(), go(`/stickers/${r.pack.id}`)), (e) => toast(e.message))
  if (!account?.done) return <div class="stk-page"><Empty go={() => go('/join')} title={t('Stickers')} about={t('Sign in to make sticker packs and add the ones people share.')} action={t('Join')} /></div>
  return (
    <div class="stk-page">
      <div class="stk-cards">
        <Card icon={P.plus} title={t('New sticker pack')} about={t('Add your own pictures, GIFs and videos to it.')} onSubmit={create}>
          <div class="stk-row">
            <input value={title} maxLength={64} placeholder={t('Name')} aria-label={t('Name')} onInput={(e) => setTitle(e.currentTarget.value)} />
            <button class="btn small">{t('Create')}</button>
          </div>
        </Card>
        <TgImport />
      </div>
      <h2 class="stk-h">{t('Your sticker packs')}</h2>
      {!packs ? <div class="spinner" /> : !packs.length ? <p class="muted">{t('No sticker packs yet. Make one, import one from Telegram, or add one someone shared.')}</p> : (
        <div class="stk-list">{packs.map((p) => <PackRow p={p} />)}</div>
      )}
    </div>
  )
}

function PackPage({ id }: { id: string }) {
  const [p, setP] = useState<Pack | null | undefined>(undefined)
  const [job, setJob] = useState<Job | undefined>(jobs.get(id))
  const [edit, setEdit] = useState(false)
  const [name, setName] = useState('')
  const [adding, setAdding] = useState(false)
  const [sure, setSure] = useState(false)
  const packs = useMine()
  const [maker, setMaker] = useState<User | null>(null)
  const load = () => getJson(`/api/stickers/pack/${id}`).then((x) => (setP(x), x && setName(x.title), x))
  useEffect(() => void load().then((x) => x && getUser(x.fid).then(setMaker, () => {})), [id])
  // an import this tab started: asked about every second until it's done, the pack redrawn as stickers arrive
  useEffect(() => {
    let live = true
    const tick = async () => {
      const j = jobs.get(id)
      if (!live || !j) return
      const now = ((await getJson(`/api/stickers/job/${j.id}`)) as Job | null) || { ...j, finished: true }
      jobs.set(id, now)
      setJob(now)
      await load()
      if (now.finished) {
        jobs.delete(id)
        changed()
        if (now.failed) toast(tn(now.failed, "{n} sticker couldn't be imported.", "{n} stickers couldn't be imported."))
      } else setTimeout(tick, 1000)
    }
    const start = () => (setJob(jobs.get(id)), tick())
    start()
    addEventListener('sticker-job', start)
    return () => ((live = false), removeEventListener('sticker-job', start))
  }, [id])
  if (p === undefined) return <><Header title={t('Stickers')} /><div class="spinner" /></>
  if (!p) return <><Header title={t('Stickers')} /><p class="hint stk-page">{t("That sticker pack doesn't exist anymore.")}</p></>
  const owner = account?.fid === p.fid
  const saved = !!packs?.some((x) => x.id === p.id)
  const op = (body: object) => stickerOp({ pack: p.id, ...body }).then((r) => (r.pack && setP(r.pack), changed(), r), (e) => (toast(e.message), null))
  const add = async (files: FileList | null) => {
    setAdding(true)
    for (const f of Array.from(files || [])) {
      if (f.size > 2e6) toast('A sticker can be 2 MB at most.')
      else await op({ op: 'add', image: await base64(f) })
    }
    setAdding(false)
  }
  const copy = () => navigator.clipboard.writeText(shareLink(p.id)).then(() => toast('Link copied'), () => toast("Couldn't copy the link."))
  const remove = (h: string) => op({ op: 'edit', stickers: p.stickers.map((s) => s.h).filter((x) => x !== h) })
  const del = () => (sure ? op({ op: 'delete' }).then((r) => r && go('/stickers')) : setSure(true))
  const running = job && !job.finished
  return (
    <>
      <Header title={t('Sticker pack')} />
      <div class="stk-page">
        <section class="stk-hero">
          <span class="stk-hero-cover">{p.stickers[0] ? <img src={src(p.id, p.stickers[0].h)} alt="" /> : <Icon d={P.sticker} size={34} />}</span>
          <div class="stk-hero-text">
            <h1>{p.title}</h1>
            <p class="muted">
              {tn(p.stickers.length, '{n} sticker', '{n} stickers')}
              {maker && <> · <a href={userPath(maker)}>{t('by {name}', { name: `@${handle(maker)}` })}</a></>}
            </p>
          </div>
        </section>
        <div class="stk-actions">
          {account?.done && !owner && <button class={`btn${saved ? ' ghost' : ''}`} onClick={() => op({ op: saved ? 'unsave' : 'save' })}>{saved ? t('Remove from my stickers') : t('Add to my stickers')}</button>}
          {!account?.done && <a class="btn" href="/join">{t('Join to add these stickers')}</a>}
          {owner && <button class={`btn${edit ? '' : ' ghost'}`} onClick={() => (setEdit(!edit), setSure(false))}><Icon d={edit ? P.check : P.pen} />{edit ? t('Done') : t('Edit')}</button>}
          <span class="stk-actions-end">
            {account?.done && <button class="icon-btn" aria-label={t('Cast')} title={t('Cast')} onClick={() => shell.compose({ embeds: [shareLink(p.id)] })}><Icon d={P.quote} /></button>}
            <button class="icon-btn" aria-label={t('Copy link')} title={t('Copy link')} onClick={copy}><Icon d={P.link} /></button>
          </span>
        </div>
        {running && (
          <div class="stk-progress" role="status">
            <progress max={job.total || 1} value={job.done + job.failed} />
            <small class="muted">{t('Importing from Telegram: {done} of {total}…', { done: job.done + job.failed, total: job.total })}</small>
          </div>
        )}
        {owner && edit && (
          <div class="stk-cards">
            <Card icon={P.pen} title={t('Name')} about={t('What the pack is called everywhere it shows.')} onSubmit={() => op({ op: 'edit', title: name })}>
              <div class="stk-row"><input value={name} maxLength={64} aria-label={t('Name')} onInput={(e) => setName(e.currentTarget.value)} /><button class="btn small">{t('Save')}</button></div>
            </Card>
            <Card icon={P.image} title={t('Add stickers')} about={t('PNG, JPEG, GIF, WebP or WebM, up to 2 MB each. Animated ones stay animated.')}>
              <label class="btn small stk-file">
                <Icon d={P.plus} />{adding ? t('Adding…') : t('Choose files')}
                <input type="file" accept="image/png,image/jpeg,image/gif,image/webp,video/webm" multiple disabled={adding} onChange={(e) => (add(e.currentTarget.files), (e.currentTarget.value = ''))} />
              </label>
            </Card>
            <TgImport pack={p.id} />
          </div>
        )}
        {p.stickers.length ? (
          <div class={`stk-grid big${edit ? ' editing' : ''}`}>
            {p.stickers.map((s) => (
              <span class="stk-cell" title={s.e}>
                <img src={src(p.id, s.h)} alt="" loading="lazy" />
                {edit && <button class="att-x" aria-label={t('Remove')} onClick={() => remove(s.h)}><Icon d={P.x} size={14} /></button>}
              </span>
            ))}
          </div>
        ) : !running && <Empty title={t('This pack is empty.')} about={owner ? t('Add pictures or import a Telegram pack to fill it.') : t('Its maker hasn\'t added any stickers yet.')} go={owner && !edit ? () => setEdit(true) : undefined} action={t('Add stickers')} />}
        {owner && edit && <button class="btn danger small stk-delete" onClick={del}><Icon d={P.trash} />{sure ? t('Tap again to delete this pack') : t('Delete pack')}</button>}
      </div>
    </>
  )
}

export function StickersPage({ id }: { id?: string }) {
  return id ? <PackPage id={id} /> : <><Header title={t('Stickers')} /><MyPacks /></>
}
