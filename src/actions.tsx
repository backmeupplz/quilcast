// /actions: cast actions, the mini apps with a castShareUrl that every cast's ⋯ menu lists (ui.tsx runAction).
// The official list is actions.json (developers send a pull request, see public/developers/cast-actions.html); any
// other is added by its link, and /actions?add=<host> is how a developer shares theirs.
import { useEffect, useState } from 'preact/hooks'
import { t } from './i18n.ts'
import { AppIcon, castActions, Header, saveActions, sameApp, toast, type CastAction } from './ui.tsx'
import official from './actions.json' with { type: 'json' }

/** The action a site's farcaster.json declares, or an error saying why there's none. */
async function actionOf(link: string): Promise<CastAction> {
  let origin: string
  try {
    origin = new URL(/^https?:\/\//i.test(link) ? link : `https://${link}`).origin
  } catch {
    throw new Error(t('That isn\'t a link.'))
  }
  const host = new URL(origin).host
  if (!origin.startsWith('https://') || origin === location.origin) throw new Error(t('{host} has no cast action.', { host }))
  const m = await fetch(`/api/manifest?origin=${encodeURIComponent(origin)}`).then((r) => r.json(), () => null)
  if (!m?.castShareUrl) throw new Error(t('{host} has no cast action.', { host }))
  return { url: m.castShareUrl, name: m.name || host, icon: m.iconUrl, description: m.description }
}

function Row({ a, on, toggle }: { a: CastAction; on: boolean; toggle: () => void }) {
  return (
    <div class="app-row">
      <div class="app-main">
        <AppIcon src={a.icon} name={a.name} />
        <span><b>{a.name}</b><small>{a.description ? `${a.description} · ` : ''}{new URL(a.url).host}</small></span>
      </div>
      <button class={`btn small${on ? ' ghost' : ''}`} onClick={toggle}>{on ? t('Remove') : t('Add')}</button>
    </div>
  )
}

export function Actions() {
  const [mine, setMine] = useState(castActions)
  const [link, setLink] = useState(() => new URLSearchParams(location.search).get('add') || '')
  const [found, setFound] = useState<CastAction | null>(null)
  const [busy, setBusy] = useState(false)
  const has = (a: CastAction) => mine.some((x) => sameApp(x.url, a.url))
  const toggle = (a: CastAction) => {
    const next = has(a) ? mine.filter((x) => !sameApp(x.url, a.url)) : [...mine, a]
    saveActions(next)
    setMine(next)
    const name = a.name || new URL(a.url).host
    toast(has(a) ? t('Removed {name} from the ⋯ menu', { name }) : t('Added {name} to the ⋯ menu', { name }))
  }
  const find = async () => {
    if (!link.trim()) return
    setBusy(true)
    setFound(null)
    await actionOf(link.trim()).then(setFound, (e) => toast(e.message))
    setBusy(false)
  }
  // a shared link (/actions?add=<host>) looks the action up at once; adding it still takes a tap
  useEffect(() => void find(), [])
  const others = mine.filter((a) => !official.some((o) => sameApp(o.url, a.url)))
  return (
    <>
      <Header title={t('Cast actions')} />
      <div class="settings">
        <p class="hint">{t('Actions show up in the ⋯ menu under every cast. Each one is a mini app that opens with the cast.')}</p>
        <h2 class="apps-h">{t('Official')}</h2>
        {official.map((a) => <Row a={a} on={has(a)} toggle={() => toggle(a)} />)}
        {others.length > 0 && <h2 class="apps-h">{t('Added by link')}</h2>}
        {others.map((a) => <Row a={a} on toggle={() => toggle(a)} />)}
        <h2 class="apps-h">{t('Add by link')}</h2>
        <div class="app-open">
          <input value={link} onInput={(e) => setLink(e.currentTarget.value)} onKeyDown={(e) => e.key === 'Enter' && find()} placeholder={t('The action\'s site, like example.com')} aria-label={t('Action link')} inputMode="url" />
          <button class="btn small" onClick={find} disabled={busy || !link.trim()}>{busy ? t('Working…') : t('Look up')}</button>
        </div>
        {found && <Row a={found} on={has(found)} toggle={() => toggle(found)} />}
        {found && !official.some((o) => sameApp(o.url, found.url)) && <p class="hint warn">{t('Quilcast hasn\'t reviewed this action. It sees the cast you use it on and can ask for your wallet, like any mini app.')}</p>}
        <p class="hint"><a href="/developers/cast-actions" target="_blank" rel="noopener">{t('Make your own cast action')}</a></p>
      </div>
    </>
  )
}
