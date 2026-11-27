// iOS's keyboard (in Safari and in the iPhone app) covers the page rather than shrinking it, and WebKit scrolls the part
// it leaves down to the cursor: a dialog filling the screen (.modal, style.css) had its top row, with Cancel and Cast,
// pushed up off the screen and its toolbar under the keyboard (#944). While the keyboard is up, phone dialogs keep to
// that part instead, with no room for the home indicator under it. Not while zoomed in, where the part moves under a
// finger. The keyboard shows in the part's height against the layout's (clientHeight): panned to the page's end, the
// part's bottom meets the layout's and WebKit's innerHeight drops to the part's. Plain JS: ios/QuilcastTests runs this
// file in the app's web view.
{
  const v = window.visualViewport, s = document.documentElement.style
  let last = ''
  const fit = () => {
    const now = v && Math.abs(v.scale - 1) < 0.01 && v.height < document.documentElement.clientHeight - 1 ? `${v.offsetTop}px ${v.height}px` : ''
    if (now === last) return
    const [top = '', height = ''] = (last = now).split(' ')
    s.setProperty('--vv-top', top)
    s.setProperty('--vv-height', height)
    s.setProperty('--vv-inset-bottom', now && '0px')
  }
  v?.addEventListener('resize', fit)
  addEventListener('resize', fit)
  v?.addEventListener('scroll', fit)
  fit()
}
