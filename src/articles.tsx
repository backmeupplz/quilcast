// Writing a Farcaster Article (article.ts): a title, a cover, a Markdown body, a preview as readers will see it, and
// Publish, which sends the article as its chain of casts (write.ts postArticle). The draft is kept in this browser as
// it's typed, and so is how far a publish got, so one cut off partway goes on from there instead of starting over.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { account, go, myUser, read, save } from './api.ts'
import { splitArticle, type Outgoing, type Part } from './article.ts'
import { t } from './i18n.ts'
import { ArticleView, Header, Icon, Img, P, toast, w } from './ui.tsx'

type Kept = { title: string; cover?: string; body: string; parts?: Outgoing[]; sent?: string[]; fid?: number }
const keyOf = () => `quilcast:article:${account?.fid}`

/** The article as it would go out, or the reason it can't. */
function plan(k: Kept): { parts: Outgoing[]; err?: undefined } | { parts?: undefined; err: string } {
  try {
    return { parts: splitArticle(k) }
  } catch (e: any) {
    return { err: e.message }
  }
}

export function ArticleEditor() {
  const [k, setK] = useState<Kept>(() => {
    const kept = read<Kept>(keyOf(), { title: '', body: '' })
    // a publish that stopped partway goes on only as the account that started it
    return kept.fid && kept.fid !== account?.fid ? { title: kept.title, cover: kept.cover, body: kept.body } : kept
  })
  const [preview, setPreview] = useState(false)
  const [busy, setBusy] = useState<'' | 'cover' | 'picture' | 'publish'>('')
  const box = useRef<HTMLTextAreaElement>(null)
  const coverPick = useRef<HTMLInputElement>(null)
  const picturePick = useRef<HTMLInputElement>(null)
  // a publish that stopped partway keeps the casts it planned, so the rest go out as planned
  const locked = !!k.sent?.length
  const set = (x: Partial<Kept>) => setK((was) => ({ ...was, ...x }))
  // once it's out, the draft goes (a render still to come from the last part sent mustn't bring it back)
  const finished = useRef(false)
  useEffect(() => void (!finished.current && save(keyOf(), k)), [k])
  const out = useMemo(() => (k.parts ? { parts: k.parts } : plan(k)), [k])
  const upload = async (file: File | undefined, what: 'cover' | 'picture') => {
    if (!file) return
    setBusy(what)
    try {
      const url = await (await w()).upload(file)
      if (what === 'cover') set({ cover: url })
      else {
        // the picture goes on a line of its own where the caret is now (a picture on its own line is an embed), into
        // the text as it is now, with what was typed while it uploaded
        setK((was) => {
          const at = Math.min(box.current ? box.current.selectionEnd : was.body.length, was.body.length)
          const before = was.body.slice(0, at)
          const after = was.body.slice(at)
          return { ...was, body: `${before}${before && !before.endsWith('\n') ? '\n' : ''}![](${url})${after.startsWith('\n') ? '' : '\n'}${after}` }
        })
      }
    } catch (e: any) {
      toast(e.message)
    }
    setBusy('')
  }
  const publish = async () => {
    if (!out.parts || busy) return
    const parts = out.parts
    setBusy('publish')
    try {
      const hashes = await (await w()).postArticle(parts, k.sent, (sent) => set({ parts, sent, fid: account?.fid }))
      finished.current = true
      save(keyOf(), null)
      go(`/c/${hashes[0]}`)
    } catch (e: any) {
      toast(e.message)
      setBusy('')
    }
  }
  // the preview is the article page itself, from the casts as they'd go out
  const shown = useMemo(() => {
    if (!preview || !out.parts) return null
    const me = myUser()!
    const parts: Part[] = out.parts.map((p, i) => ({ fid: me.fid, hash: String(i).padStart(40, '0'), at: 0, text: p.text, mentions: [], positions: [], embeds: p.embeds.map((url) => ({ url })), format: 1, chain: { index: i, count: out.parts.length } }))
    const c = { hash: parts[0].hash, text: parts[0].text, timestamp: new Date().toISOString(), author: me, embeds: parts[0].embeds, reactions: { likes_count: 0, recasts_count: 0 }, replies: { count: 0 } }
    return <ArticleView c={c} root={parts[0]} given={{ parts, complete: true, texts: parts.map((p) => p.text) }} />
  }, [preview, out])
  return (
    <>
      <Header title={t('New article')} />
      <div class="article-editor">
        <input class="ae-title" dir="auto" placeholder={t('Title')} aria-label={t('Title')} value={k.title} disabled={locked} onInput={(e) => set({ title: e.currentTarget.value })} />
        {k.cover ? (
          <div class="ae-cover">
            <Img src={k.cover} />
            {!locked && <button class="btn ghost small" onClick={() => set({ cover: undefined })}>{t('Remove')}</button>}
          </div>
        ) : (
          <button class="btn ghost small ae-add" disabled={locked || !!busy} onClick={() => coverPick.current?.click()}><Icon d={P.image} size={16} />{busy === 'cover' ? t('Uploading…') : t('Cover image')}</button>
        )}
        <input ref={coverPick} type="file" accept="image/*" hidden onChange={(e) => (upload(e.currentTarget.files?.[0], 'cover'), (e.currentTarget.value = ''))} />
        <input ref={picturePick} type="file" accept="image/*,video/mp4,video/webm,video/quicktime" hidden onChange={(e) => (upload(e.currentTarget.files?.[0], 'picture'), (e.currentTarget.value = ''))} />
        <div class="ae-tools">
          {!preview && <button class="btn ghost small" disabled={locked || !!busy} onClick={() => picturePick.current?.click()}><Icon d={P.image} size={16} />{busy === 'picture' ? t('Uploading…') : t('Picture')}</button>}
          <button class="btn ghost small" aria-pressed={preview} onClick={() => setPreview(!preview)}>{preview ? t('Edit') : t('Preview')}</button>
        </div>
        {preview ? shown || <div class="note">{out.err && t(out.err)}</div> : (
          <textarea ref={box} class="ae-body" dir="auto" rows={16} value={k.body} disabled={locked} aria-label={t('New article')}
            placeholder={t('Write your article. Markdown works: # headings, **bold**, _italic_, - lists, > quotes and |tables|.')} onInput={(e) => set({ body: e.currentTarget.value })} />
        )}
        {locked && <div class="note">{t('Only {n} of {total} casts went out. Publish again to send the rest.', { n: k.sent!.length, total: k.parts!.length })}</div>}
        <div class="ae-foot">
          <span class="muted">{out.parts ? t('Casts to publish: {n}', { n: out.parts.length }) : k.title.trim() ? t(out.err) : ''}</span>
          {locked && <button class="btn ghost" disabled={!!busy} onClick={() => setK({ title: '', body: '' })}>{t('Discard')}</button>}
          <button class="btn" disabled={!out.parts || !!busy} onClick={publish}>{busy === 'publish' ? t('Posting…') : t('Publish')}</button>
        </div>
      </div>
    </>
  )
}
