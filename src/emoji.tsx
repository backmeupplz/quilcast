// The composer's emoji picker. Its own module so the emoji list, which is most of its weight, only loads when
// someone opens it, the way the GIF search does (src/gifs.tsx).
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import byGroup from 'unicode-emoji-json/data-by-group.json'
import { t } from './i18n.ts'

type Entry = { emoji: string; name: string; slug: string }
type Group = { name: string; slug: string; emojis: Entry[] }
const GROUPS = byGroup as unknown as Group[]
const ALL = GROUPS.flatMap((g) => g.emojis)

export function EmojiPicker({ pick, close }: { pick: (emoji: string) => void; close: () => void }) {
  const [q, setQ] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const body = useRef<HTMLDivElement>(null)
  useEffect(() => input.current?.focus(), [])
  // the names are the dataset's, which is English; a search in another language finds nothing rather than misleading
  const needle = q.trim().toLowerCase()
  const found = useMemo(() => (needle ? ALL.filter((e) => e.name.includes(needle) || e.slug.includes(needle)).slice(0, 180) : null), [needle])
  const jump = (slug: string) => body.current?.querySelector(`[data-group="${slug}"]`)?.scrollIntoView({ block: 'start' })

  return (
    <div class="lk-edit-body lk-emoji">
      <div class="lk-gifs-head">
        <input ref={input} value={q} placeholder={t('Search emoji')} aria-label={t('Search emoji')} onInput={(e) => setQ(e.currentTarget.value)} />
        <button class="btn ghost small" onClick={close}>{t('Back')}</button>
      </div>
      {!found && (
        <nav class="emoji-tabs" role="tablist">
          {GROUPS.map((g) => (
            <button type="button" role="tab" aria-label={g.name} title={g.name} onClick={() => jump(g.slug)}>{g.emojis[0].emoji}</button>
          ))}
        </nav>
      )}
      <div class="emoji-body" ref={body}>
        {found
          ? found.length
            ? <div class="emoji-grid">{found.map((e) => <button key={e.slug} type="button" aria-label={e.name} title={e.name} onClick={() => pick(e.emoji)}>{e.emoji}</button>)}</div>
            : <p class="hint">{t('No emoji found.')}</p>
          : GROUPS.map((g) => (
              <div class="emoji-grid" key={g.slug} data-group={g.slug}>
                {g.emojis.map((e) => <button key={e.slug} type="button" aria-label={e.name} title={e.name} onClick={() => pick(e.emoji)}>{e.emoji}</button>)}
              </div>
            ))}
      </div>
    </div>
  )
}
