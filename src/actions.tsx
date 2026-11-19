// /actions: cast actions, the mini apps with a castShareUrl that every cast's ⋯ menu lists (ui.tsx runAction).
// /composer-actions: composer actions, the mini apps with a composerActionUrl that the composer's apps button lists
// (compose.tsx runAction). The official ones are actions.json and composer-actions.json (developers send a pull request,
// see public/developers/); any other is added by its link, and /actions?add=<host> (or
// /composer-actions?add=<host>) is how a developer shares theirs.
import { useEffect, useState } from 'preact/hooks'
import { t } from './i18n.ts'
import { AppIcon, castActions, composerActions, Header, saveActions, saveComposerActions, sameApp, toast, type CastAction } from './ui.tsx'
import castOfficial from './actions.json' with { type: 'json' }
import composerOfficial from './composer-actions.json' with { type: 'json' }

// what differs between the two pages
const KINDS = {
  cast: {
    field: 'castShareUrl', list: castActions, save: saveActions, official: castOfficial as CastAction[], doc: '/developers/cast-actions',
    none: (host: string) => t('{host} has no cast action.', { host }), title: () => t('Cast actions'),
    hint: () => t('Actions show up in the ⋯ menu under every cast. Each one is a mini app that opens with the cast.'),
    added: (name: string) => t('Added {name} to the ⋯ menu', { name }), removed: (name: string) => t('Removed {name} from the ⋯ menu', { name }),
    warn: () => t('Quilcast hasn\'t reviewed this action. It sees the cast you use it on and can ask for your wallet, like any mini app.'), make: () => t('Make your own cast action'),
  },
  composer: {
    field: 'composerActionUrl', list: composerActions, save: saveComposerActions, official: composerOfficial as CastAction[], doc: '/developers/composer-actions',
    none: (host: string) => t('{host} has no composer action.', { host }), title: () => t('Composer actions'),
    hint: () => t('Composer actions show up under the apps button in the composer. Each one is a mini app that opens with your draft and fills it in.'),
    added: (name: string) => t('Added {name} to the composer', { name }), removed: (name: string) => t('Removed {name} from the composer', { name }),
    warn: () => t('Quilcast hasn\'t reviewed this action. It sees the draft you open it from and can ask for your wallet, like any mini app.'), make: () => t('Make your own composer action'),
  },
}

/** The action a site's farcaster.json declares, or an error saying why there's none. */
async function actionOf(link: string, k: (typeof KINDS)[keyof typeof KINDS]): Promise<CastAction> {
  let origin: string
  try {
    origin = new URL(/^https?:\/\//i.test(link) ? link : `https://${link}`).origin
  } catch {
    throw new Error(t('That isn\'t a link.'))
  }
  const host = new URL(origin).host
  if (!origin.startsWith('https://') || origin === location.origin) throw new Error(k.none(host))
  const m = await fetch(`/api/manifest?origin=${encodeURIComponent(origin)}`).then((r) => r.json(), () => null)
  if (!m?.[k.field]) throw new Error(k.none(host))
  return { url: m[k.field], name: m.name || host, icon: m.iconUrl, description: m.description }
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

export function Actions({ composer }: { composer?: boolean }) {
  const k = composer ? KINDS.composer : KINDS.cast
  const [mine, setMine] = useState(k.list)
  const [link, setLink] = useState(() => new URLSearchParams(location.search).get('add') || '')
  const [found, setFound] = useState<CastAction | null>(null)
  const [busy, setBusy] = useState(false)
  const has = (a: CastAction) => mine.some((x) => sameApp(x.url, a.url))
  const toggle = (a: CastAction) => {
    const next = has(a) ? mine.filter((x) => !sameApp(x.url, a.url)) : [...mine, a]
    k.save(next)
    setMine(next)
    const name = a.name || new URL(a.url).host
    toast(has(a) ? k.removed(name) : k.added(name))
  }
  const find = async () => {
    if (!link.trim()) return
    setBusy(true)
    setFound(null)
    await actionOf(link.trim(), k).then(setFound, (e) => toast(e.message))
    setBusy(false)
  }
  // a shared link (?add=<host>) looks the action up at once; adding it still takes a tap
  useEffect(() => void find(), [])
  const others = mine.filter((a) => !k.official.some((o) => sameApp(o.url, a.url)))
  return (
    <>
      <Header title={k.title()} />
      <div class="settings">
        <p class="hint">{k.hint()}</p>
        {k.official.length > 0 && <h2 class="apps-h">{t('Official')}</h2>}
        {k.official.map((a) => <Row a={a} on={has(a)} toggle={() => toggle(a)} />)}
        {others.length > 0 && <h2 class="apps-h">{t('Added by link')}</h2>}
        {others.map((a) => <Row a={a} on toggle={() => toggle(a)} />)}
        <h2 class="apps-h">{t('Add by link')}</h2>
        <div class="app-open">
          <input value={link} onInput={(e) => setLink(e.currentTarget.value)} onKeyDown={(e) => e.key === 'Enter' && find()} placeholder={t('The action\'s site, like example.com')} aria-label={t('Action link')} inputMode="url" />
          <button class="btn small" onClick={find} disabled={busy || !link.trim()}>{busy ? t('Working…') : t('Look up')}</button>
        </div>
        {found && <Row a={found} on={has(found)} toggle={() => toggle(found)} />}
        {found && !k.official.some((o) => sameApp(o.url, found.url)) && <p class="hint warn">{k.warn()}</p>}
        <p class="hint"><a href={k.doc} target="_blank" rel="noopener">{k.make()}</a></p>
      </div>
    </>
  )
}
