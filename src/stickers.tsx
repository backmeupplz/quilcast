// Sticker packs, Telegram style (server/stickers.mjs): the picker in the composer and in messages, and the pages at
// /stickers (your packs, a new one, a Telegram import) and /stickers/<id> (a pack: add it, share it, change your own).
// A sticker goes out as a picture at quilcast.com/st/<pack>/<hash>.webp; ui.tsx draws those as stickers.
import { useEffect, useState } from 'preact/hooks'
import { account, go } from './api.ts'
import { t, tn } from './i18n.ts'
import { stickerUrl } from './shared.ts'
import { Header, Icon, P, shell, toast } from './ui.tsx'
import { stickerOp } from './write.ts'

type Sticker = { h: string; e: string }
type Pack = { id: string; fid: number; title: string; stickers: Sticker[] }
type Job = { id: string; pack: string; total: number; done: number; failed: number; finished: boolean }

const src = (p: string, h: string) => `/st/${p}/${h}.webp`
const shareLink = (id: string) => `https://stickers.quilcast.com/${id}`
const getJson = (u: string) => fetch(u).then((r) => (r.ok ? r.json() : null)).catch(() => null)

// the account's packs, asked once and kept in step with what's changed here
let mine: Pack[] | null = null
const myPacks = async (fresh = false) => {
  if (!account?.fid) return []
  if (!mine || fresh) mine = ((await getJson(`/api/stickers/${account.fid}`)) as Pack[] | null) || mine || []
  return mine
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

/** The composer's and messages' sticker picker: a tab per pack the account has. */
export function StickerPicker({ pick, close }: { pick: (url: string) => void; close: () => void }) {
  // empty packs get no tab
  const packs = useMine()?.filter((x) => x.stickers.length)
  const [at, setAt] = useState(0)
  const p = packs?.[Math.min(at, packs.length - 1)]
  const manage = () => (close(), go('/stickers'))
  return (
    <div class="lk-edit-body lk-gifs stk-pick">
      <div class="lk-gifs-head">
        <div class="stk-tabs" role="tablist">
          {packs?.map((x, i) => (
            <button role="tab" aria-selected={x === p} class={x === p ? 'on' : ''} title={x.title} aria-label={x.title} onClick={() => setAt(i)}>
              {x.stickers[0] ? <img src={src(x.id, x.stickers[0].h)} alt="" /> : <Icon d={P.smile} />}
            </button>
          ))}
        </div>
        <button class="btn ghost small" onClick={manage}>{t('Manage')}</button>
        <button class="btn ghost small" onClick={close}>{t('Back')}</button>
      </div>
      {!packs ? <div class="spinner" /> : !p ? (
        <p class="hint">{t('No sticker packs yet. Make one, import one from Telegram, or add one someone shared.')} <button class="link" onClick={manage}>{t('Get stickers')}</button></p>
      ) : !p.stickers.length ? <p class="hint">{t('This pack is empty.')}</p> : (
        <div class="stk-grid">{p.stickers.map((s) => <button aria-label={s.e || t('Sticker')} onClick={() => pick(stickerUrl(p.id, s.h))}><img src={src(p.id, s.h)} alt={s.e} loading="lazy" /></button>)}</div>
      )}
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

function TgImport({ pack }: { pack?: string }) {
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const run = () => (setBusy(true), importTg(url, pack).then(() => setUrl(''), (e) => toast(e.message)).finally(() => setBusy(false)))
  return (
    <form class="stk-form" onSubmit={(e) => (e.preventDefault(), url.trim() && !busy && run())}>
      <label for={`tg-${pack || 'new'}`}>{pack ? t('Add stickers from a Telegram pack') : t('Import a Telegram sticker pack')}</label>
      <div class="stk-row">
        <input id={`tg-${pack || 'new'}`} value={url} placeholder="t.me/addstickers/…" inputMode="url" autoComplete="off" onInput={(e) => setUrl(e.currentTarget.value)} />
        <button class="btn small" disabled={!url.trim() || busy}>{busy ? t('Importing…') : t('Import')}</button>
      </div>
    </form>
  )
}

function MyPacks() {
  const packs = useMine()
  const [title, setTitle] = useState('')
  const create = () => stickerOp({ op: 'create', title }).then((r) => (changed(), go(`/stickers/${r.pack.id}`)), (e) => toast(e.message))
  if (!account?.done) return <p class="hint stk-page">{t('Sign in to make sticker packs and add the ones people share.')} <a href="/join">{t('Join')}</a></p>
  return (
    <div class="stk-page">
      <form class="stk-form" onSubmit={(e) => (e.preventDefault(), create())}>
        <label for="stk-new">{t('New sticker pack')}</label>
        <div class="stk-row">
          <input id="stk-new" value={title} maxLength={64} placeholder={t('Name')} onInput={(e) => setTitle(e.currentTarget.value)} />
          <button class="btn small">{t('Create')}</button>
        </div>
      </form>
      <TgImport />
      <h2 class="stk-h">{t('Your sticker packs')}</h2>
      {!packs ? <div class="spinner" /> : !packs.length ? <p class="hint">{t('No sticker packs yet. Make one, import one from Telegram, or add one someone shared.')}</p> : (
        <ul class="stk-list">
          {packs.map((p) => (
            <li><a href={`/stickers/${p.id}`}>
              <span class="stk-cover">{p.stickers[0] && <img src={src(p.id, p.stickers[0].h)} alt="" />}</span>
              <span><b>{p.title}</b><small class="muted">{tn(p.stickers.length, '{n} sticker', '{n} stickers')}{p.fid === account?.fid ? '' : ` · ${t('added')}`}</small></span>
            </a></li>
          ))}
        </ul>
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
  const load = () => getJson(`/api/stickers/pack/${id}`).then((x) => (setP(x), x && setName(x.title)))
  useEffect(() => void load(), [id])
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
  return (
    <>
      <Header title={p.title} />
      <div class="stk-page">
        <p class="muted">{tn(p.stickers.length, '{n} sticker', '{n} stickers')}</p>
        <div class="btns stk-actions">
          {account?.done && !owner && <button class={`btn small${saved ? ' ghost' : ''}`} onClick={() => op({ op: saved ? 'unsave' : 'save' })}>{saved ? t('Remove from my stickers') : t('Add to my stickers')}</button>}
          {!account?.done && <a class="btn small" href="/join">{t('Join to add these stickers')}</a>}
          <button class="btn ghost small" onClick={copy}><Icon d={P.link} />{t('Copy link')}</button>
          {account?.done && <button class="btn ghost small" onClick={() => shell.compose({ embeds: [shareLink(p.id)] })}><Icon d={P.quote} />{t('Cast')}</button>}
          {owner && <button class={`btn ghost small${edit ? ' on' : ''}`} onClick={() => (setEdit(!edit), setSure(false))}>{edit ? t('Done') : t('Edit')}</button>}
        </div>
        {job && !job.finished && <p class="hint">{t('Importing from Telegram: {done} of {total}…', { done: job.done + job.failed, total: job.total })}</p>}
        <div class="stk-grid big">
          {p.stickers.map((s) => (
            <span class="stk-cell">
              <img src={src(p.id, s.h)} alt={s.e} loading="lazy" />
              {edit && <button class="att-x" aria-label={t('Remove')} onClick={() => remove(s.h)}><Icon d={P.x} size={14} /></button>}
            </span>
          ))}
        </div>
        {owner && edit && (
          <div class="stk-edit">
            <form class="stk-form" onSubmit={(e) => (e.preventDefault(), op({ op: 'edit', title: name }))}>
              <label for="stk-name">{t('Name')}</label>
              <div class="stk-row"><input id="stk-name" value={name} maxLength={64} onInput={(e) => setName(e.currentTarget.value)} /><button class="btn small">{t('Save')}</button></div>
            </form>
            <label class="btn ghost small stk-file">
              <Icon d={P.plus} />{adding ? t('Adding…') : t('Add stickers')}
              <input type="file" accept="image/png,image/jpeg,image/gif,image/webp,video/webm" multiple disabled={adding} onChange={(e) => (add(e.currentTarget.files), (e.currentTarget.value = ''))} />
            </label>
            <p class="hint">{t('PNG, JPEG, GIF, WebP or WebM, up to 2 MB each. Animated ones stay animated.')}</p>
            <TgImport pack={p.id} />
            <button class="btn ghost small warn" onClick={del}>{sure ? t('Tap again to delete this pack') : t('Delete pack')}</button>
          </div>
        )}
      </div>
    </>
  )
}

export function StickersPage({ id }: { id?: string }) {
  return id ? <PackPage id={id} /> : <><Header title={t('Stickers')} /><MyPacks /></>
}
