// An error while the app starts or first draws would leave the page empty (and dark, with a dark theme) with nothing
// to say why: it says what happened instead, with a button that reloads. Before the app's code is in, index.html's
// head script does the same (in English) when that code fails to load or run
import { t } from './i18n.ts'

/** Cover the page with the error and a Reload button. */
export function crashed(e: unknown) {
  console.error(e)
  if (document.querySelector('.crash')) return
  const box = document.createElement('div')
  box.className = 'crash'
  box.setAttribute('role', 'alert')
  const p = document.createElement('p')
  p.textContent = t('Something went wrong and Quilcast stopped. Reloading the page usually fixes it.')
  const why = document.createElement('code')
  why.textContent = e instanceof Error ? e.message : String(e)
  const b = document.createElement('button')
  b.className = 'btn'
  b.textContent = t('Reload')
  b.onclick = () => location.reload()
  box.append(p, why, b)
  ;(document.body || document.documentElement).append(box)
}

/** The app is on screen (index.html's head script stops listening): an error before it wasn't fatal after all. */
export function started() {
  document.documentElement.dataset.up = ''
  document.querySelector('.crash')?.remove()
}
