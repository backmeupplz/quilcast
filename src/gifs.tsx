// The Tenor GIF search (server/shrek.mjs gifs) that profile looks, themes and the composer pick from. Its own module
// so the composer doesn't load profile looks for it.
import { useEffect, useRef, useState } from 'preact/hooks'
import { t } from './i18n.ts'
import { isImg, isLookImg } from './shared.ts'
import { Img } from './ui.tsx'

type Gif = { url: string; preview: string; title: string; cast?: string }

/** `cast` picks the GIF a cast embeds instead of the one a look takes; `start` is searched while the box is empty. */
export function GifPicker({ pick, close, stickers, cast, start = 'sparkle' }: { pick: (url: string) => void; close: () => void; stickers?: boolean; cast?: boolean; start?: string }) {
  const [q, setQ] = useState('')
  const [list, setList] = useState<Gif[] | null>(null)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => input.current?.focus(), [])
  useEffect(() => {
    let live = true
    const t = setTimeout(() => {
      setList(null)
      fetch(`/api/gifs?q=${encodeURIComponent(q.trim() || start)}${stickers ? '&stickers=1' : ''}`).then((r) => r.json()).then((l) => live && setList(Array.isArray(l) ? l : []), () => live && setList([]))
    }, 350)
    return () => ((live = false), clearTimeout(t))
  }, [q, stickers])
  const urlOf = (g: Gif) => (cast ? g.cast : g.url)
  const shown = list?.filter((g) => (cast ? isImg(g.cast || '') && isLookImg(g.cast) : isLookImg(g.url)))
  return (
    <div class="lk-edit-body lk-gifs">
      <div class="lk-gifs-head">
        <input ref={input} value={q} placeholder={stickers ? t('Search stickers') : t('Search GIFs')} aria-label={stickers ? t('Search stickers') : t('Search GIFs')} onInput={(e) => setQ(e.currentTarget.value)} />
        <button class="btn ghost small" onClick={close}>{t('Back')}</button>
      </div>
      {!shown ? <div class="spinner" /> : !shown.length ? <p class="hint">{t('No GIFs found.')}</p> : (
        <div class="lk-gif-grid">{shown.map((g) => <button onClick={() => pick(urlOf(g)!)} aria-label={g.title || t('GIF')}><Img src={g.preview} /></button>)}</div>
      )}
      <p class="hint">{stickers ? t('Stickers from Tenor.') : t('GIFs from Tenor.')}</p>
    </div>
  )
}
