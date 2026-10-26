// Quorum mode (Settings): Quilcast laid out like Quilibrium's Quorum app (github.com/QuilibriumNetwork/quorum-desktop
// and its upcoming feed): a sidebar of sections, the feed in the middle, search and apps on the right, and the wallet
// docked on the right beside an open mini app. app.tsx draws the sidebar and picks these; the look is CSS under
// :root[data-quorum] (style.css), and themes still recolor all of it.
import { useEffect, useState } from 'preact/hooks'
import { account, go, myUser, read, save, settings } from './api.ts'
import { t } from './i18n.ts'
import type { AppMeta } from './miniapp.tsx'
import { AppIcon, Avatar, Icon, launchApp, loadListed, P, pinned, sameApp, shell, worn } from './ui.tsx'

// --- the wallet panel: open or not, remembered ---
// it comes back open only where it docks beside the page: on a phone, or in a Quilcast opened as a mini app (same
// storage), it would cover everything
let open = read('quilcast:walletPanel', false) && matchMedia('(min-width: 1100px)').matches
export const setWalletOpen = (on: boolean) => ((open = on), save('quilcast:walletPanel', on), dispatchEvent(new Event('walletpanel')))

/** Re-render when the wallet panel opens or closes. */
export function useWalletOpen() {
  const [on, setOn] = useState(open)
  useEffect(() => {
    const f = () => setOn(open)
    addEventListener('walletpanel', f)
    return () => removeEventListener('walletpanel', f)
  }, [])
  return on
}

// "/" opens search, like Quorum's shortcut badge says, unless someone is typing
addEventListener('keydown', (e) => {
  if (!settings.quorum || e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return
  const el = e.target as HTMLElement | null
  if (el?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"], .modal')) return
  e.preventDefault()
  location.pathname === '/search' ? document.querySelector<HTMLInputElement>('.col .searchbox input')?.focus() : go('/search')
})

/** The right column: search, and the apps you keep (or the directory's top ones) a tap away. */
export function QuorumAside({ search }: { search: boolean }) {
  const [top, setTop] = useState<AppMeta[]>([])
  const [, force] = useState(0)
  useEffect(() => {
    const f = () => force((x) => x + 1)
    addEventListener('dock', f)
    return () => removeEventListener('dock', f)
  }, [])
  // pinned first, then the ones added from inside them
  const kept = [...pinned(), ...read<AppMeta[]>('quilcast:apps', [])].filter((a, i, all) => all.findIndex((b) => sameApp(a.url, b.url)) === i)
  useEffect(() => void (!kept.length && loadListed().then((l) => setTop(l.slice(0, 9)))), [kept.length])
  const apps = (kept.length ? kept : top).slice(0, 9)
  return (
    <aside class="extra q-extra">
      {search && (
        <a class="searchbox q-search" href="/search" aria-keyshortcuts="/">
          <Icon d={P.search} size={16} />
          <span>{t('Search the network')}</span>
          <kbd title={t('Shortcut: {key}', { key: '/' })} aria-hidden="true">/</kbd>
        </a>
      )}
      <section class="q-card">
        <div class="q-card-h"><b>{t('Apps')}</b><a href="/apps">{t('Manage apps')}</a></div>
        {apps.length > 0 ? (
          <div class="q-apps">
            {apps.map((a) => (
              <button onClick={() => launchApp(a)} title={a.name}>
                <AppIcon src={a.icon} name={a.name} />
                <small>{a.name || new URL(a.url).host}</small>
              </button>
            ))}
          </div>
        ) : (
          <p class="hint">{t('Mini apps you add or pin show up here.')}</p>
        )}
      </section>
    </aside>
  )
}

/** "What's on your mind?" over the feed; it opens the composer. */
export function QuorumCompose() {
  const me = account?.done ? myUser() : null
  if (!me) return null
  return (
    <div class="q-compose">
      <Avatar u={me} size={40} link={false} />
      <button class="q-compose-in" onClick={() => shell.compose()}>{t("What's on your mind?")}</button>
      <button class="btn small" onClick={() => shell.compose()}>{t('Post')}</button>
    </div>
  )
}

/** Quorum's sun and moon switch in the sidebar: Settings' light or dark, without System. A theme that picks its own
 *  wins over it (ui.tsx wear), so it's off while one is worn. */
export function LightDark({ set }: { set: (mode: 'light' | 'dark') => void }) {
  const [, force] = useState(0)
  useEffect(() => {
    const f = () => force((x) => x + 1)
    const os = matchMedia('(prefers-color-scheme: dark)')
    os.addEventListener('change', f)
    addEventListener('theme', f)
    return () => (os.removeEventListener('change', f), removeEventListener('theme', f))
  }, [])
  const dark = (document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) === 'dark'
  const fixed = !!worn?.base
  const tip = (label: string) => (fixed ? t('Your theme picks its own; this counts when you wear none.') : label)
  return (
    <div class="q-mode" role="group" aria-label={t('Light or dark')}>
      <button class={dark ? '' : 'on'} aria-pressed={!dark} aria-label={t('Light')} title={tip(t('Light'))} disabled={fixed} onClick={() => set('light')}><Icon d={P.sun} size={16} /></button>
      <button class={dark ? 'on' : ''} aria-pressed={dark} aria-label={t('Dark')} title={tip(t('Dark'))} disabled={fixed} onClick={() => set('dark')}><Icon d={P.moon} size={16} /></button>
    </div>
  )
}
