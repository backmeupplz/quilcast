// Quilcast as a Farcaster mini app: inside a Farcaster or Base client's frame or webview. app.tsx loads this only
// there, so nobody else downloads the SDK.
import { sdk } from '@farcaster/miniapp-sdk'

// the client shows its splash screen until the first page is up
sdk.actions.ready()
// the client's back button walks our history
sdk.back.enableWebNavigation().catch(() => {})
// the client's wallet, for "Use a wallet" and for the mini apps Quilcast opens (src/wallet.ts and miniapp.tsx look here)
const w = window as unknown as { ethereum?: unknown }
w.ethereum ??= sdk.wallet.ethProvider
// a client's webview may not open new windows, so links out go through the client
window.open = ((u?: string | URL) => (u && void sdk.actions.openUrl(String(u)), null)) as typeof window.open
// (the link's own handlers run first, past any stopPropagation: a mini app card opens the app instead)
addEventListener('click', (e) => {
  const a = (e.target as Element).closest?.('a[target="_blank"]') as HTMLAnchorElement | null
  a?.addEventListener('click', (e) => void (!e.defaultPrevented && /^https?:/.test(a.href) && (e.preventDefault(), sdk.actions.openUrl(a.href))), { once: true })
}, true)
