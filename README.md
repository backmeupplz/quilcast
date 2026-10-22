# Quilcast

A small Farcaster client that runs in the browser and talks straight to the [Hypersnap](https://hypersnap.org) network that Quilibrium runs. Reads hit the public node's HTTP API, writes are protobuf messages signed in the browser and posted to `/v1/submitMessage`, and keys live in `localStorage`. The only server is a tiny static host that also gives shared links proper previews.

Live at **[quilcast.com](https://quilcast.com)**.

## What it does

- Following and trending feeds (top-level casts), threads with their parent casts, profiles with separate casts and replies tabs
- On a cast's page, the like, recast and quote counts open lists of who liked, recast or quoted it
- Notifications: grouped likes, recasts and follows plus replies, mentions and quotes, with an unread dot. Hypersnap leaves recasts and quotes out, so those are looked up for your 25 newest casts while the page is open
- Several accounts per browser, switched from the account menu (bottom left) or Settings
- Rich link previews (Open Graph and Farcaster mini app images) through `/api/unfurl`, and @mention autocomplete in the composer
- Search for people and for cast text
- Messages: farcaster.xyz direct casts. Inbox, Unread, Requests and Muted tabs, one-to-one and group chats (with faces and names, group events in words, images inline), muting, auto-delete, and a Message button on profiles. Updates arrive live over farcaster.xyz's websocket, so nothing polls, and conversations open instantly from memory. Direct casts aren't part of the Farcaster protocol, so the custody key signs farcaster.xyz's authorization once and Quilcast keeps a token that opens direct casts and nothing else. farcaster.xyz only answers its own site, so the server relays these calls without storing them. As on farcaster.xyz, they aren't end-to-end encrypted
- Cast, reply, quote, like, recast, follow, delete your own casts, post into a channel. A new cast shows as "Posting…" until the network has indexed it
- Attach up to two photos or videos per cast. Photos are re-encoded in the browser (≤2048 px JPEG, no EXIF). Uploads go through `/api/upload` to Farcaster's CDN the way Quorum does it, using a 10-minute farcaster.xyz token the browser signs with your custody key. Farcaster only gives upload URLs to accounts that have a Warpcast signer, so other accounts' files are stored on the server and served from `/m/<hash>`
- HLS video plays natively where the browser supports it and through hls.js (loaded on first play) in Firefox-based browsers
- Avatars and feed images load from Farcaster's image CDN at the size they're shown; the image viewer opens the original
- Create a new account: a recovery phrase is generated locally, you send about $0.20 of ETH on Optimism to it, and Quilcast registers the FID with `IdGateway.register`, adds a gasless Hypersnap signer (`KEY_ADD`) and claims your fname
- Sign in with an existing recovery phrase (the same derivation as Warpcast and Quorum, so phrases work across apps)
- Or use an external wallet (MetaMask, Rabby, OKX or whatever injects `window.ethereum`) as the custody address. The wallet signs the `KEY_ADD` (two EIP-712 signatures on chain 1), the fname proof and upload logins, and pays for registration on Optimism. Quilcast holds only the signer key it adds. viem drives the wallet and loads only when someone connects one
- Farcaster and Base mini apps: tapping a mini app's card in a cast opens the app inside Quilcast, and so does pasting its link under Mini apps, which keeps the apps you add and a Discover list (farcaster.xyz's top 100 mini apps through a cached `/api/apps`, with categories and search). Several can run at once: one shows, the rest wait in the dock with their state intact. They get the full SDK host: context, sign in with your Farcaster account, compose a cast, view casts and profiles, open other mini apps, primary button, back, add to your apps, haptics (vibration on phones), camera and microphone (once you allow it per app), and token actions (send, swap through LI.FI, view). Your own browser wallets are their Ethereum provider (EIP-6963) and Solana provider (Wallet Standard). With several wallets (MetaMask, Rabby, Plain…) you pick one when an app first connects, and the wallet button in the app's header switches it in one tap. Each app keeps its own chain
- Mini app notifications: the Farcaster webhook flow. Turning them on gives the app a token for this browser's inbox on our server (`/api/notify`), handed over in a signed event our server delivers to the webhook in the app's manifest. Notifications show under Notifications → Mini apps and as Web Push (encrypted per RFC 8291, VAPID, no library). Apps check the event's signing key against Farcaster's KeyRegistry, which Hypersnap's gasless signers aren't in, so the first time you turn notifications on Quilcast adds one on-chain key from your custody on Optimism (a cent or less); signing out removes it
- Profile looks, MySpace style: your profile page can get a background (color, or a tiled or full-screen GIF), text, link and box colors, borders, corners, a font, a name effect (rainbow, glow, glitter…), a banner, a mood, a profile song (a YouTube video visitors press play on), About me and Who I'd like to meet, interests, a Top 8 of friends and a GIF wall. Six ready-made layouts get you started. GIFs come from Tenor's search through `/api/gifs`, or you upload your own. Looks are stored on our server (`/api/look/<fid>`), only change profile pages, and anyone can turn them off in Settings
- Settings: profile (with photo upload), theme, profile looks on or off, recovery phrase and key export, node and Optimism RPC URLs, version

Channel pages aren't there because Hypersnap (and upstream Snapchain) can't list a channel's casts newest-first yet.

## How it fits together

| File | Role |
| --- | --- |
| `src/fc.ts` | Protobuf encoding, ed25519 message signing, EIP-712 (`KeyAdd`, `SignedKeyRequest`, fname proofs) |
| `src/eth.ts` | Optimism JSON-RPC, RLP and EIP-1559 signing for the one registration transaction |
| `src/api.ts` | Hypersnap reads and the locally stored account |
| `src/shared.ts` | Helpers the app and the server share: cast text with mentions, media checks, CDN image sizes |
| `src/write.ts` | Signed writes, loaded on demand so readers don't download the crypto |
| `src/wallet.ts` | External wallets through viem: connect, chain switching, typed data and message signing, the registration transaction |
| `src/app.tsx`, `src/join.tsx` | Preact UI |
| `server/index.mjs` | Serves `dist/` (brotli or gzip), fills in meta tags for `/c/<hash>` and `/u/<name>`, renders 1200×630 cast cards at `/og/c/<hash>.png` with resvg, serves `/m/` uploads |
| `server/upload.mjs` | `/api/upload`: Farcaster CDN relay with a local fallback |
| `src/dms.ts`, `src/messages.tsx`, `server/dm.mjs` | Messages: shared state and live updates, the pages, and the relay to farcaster.xyz's direct-cast endpoints (and nowhere else) |
| `server/unfurl.mjs` | `/api/unfurl`: Open Graph metadata for link previews, public hosts only |
| `src/looks.tsx`, `server/looks.mjs` | Profile looks: showing and editing them, and storing them (one JSON file per FID on the data volume) |

The message encoders are checked byte for byte against `@farcaster/core`, `viem` and Quilibrium's `quorum-shared`.

## Develop

```sh
npm install
PORT=3311 npm start   # API for uploads, after npm run build
npm run dev
npm test
npm run build && npm start   # production server on :3000
```

Your recovery phrase is stored unencrypted in this browser's `localStorage`. Anyone with access to your browser profile can take over the account, so treat it like a hot wallet.

## Security

- Keys never leave the browser. Pages are served with a strict CSP (`script-src 'self'`, no inline styles, Quilcast itself can't be framed) and `Referrer-Policy: no-referrer`.
- Links in casts and previews are untrusted, because the network only checks their length. Only public http(s) URLs get rendered.
- The server's own fetches (link previews, card images, video posters) only reach public hosts on ports 80 and 443. Every address is checked at connect time and again on each redirect, and size, time and pixel limits apply.
- Messages use a token farcaster.xyz scopes to direct casts. The relay passes it to a fixed list of direct-cast endpoints and never stores or logs it, or the messages. Besides the relay, the page only connects to `wss://ws.farcaster.xyz` for live updates.
- Mini apps run in sandboxed iframes on their own origin (never Quilcast's, which holds the keys). They can't navigate the page, use the camera, microphone or location, or reach anything but a fixed list of SDK calls with checked arguments. Your wallet sees every request as coming from quilcast.com, so Quilcast does the checks it can't (`src/guard.ts`): an app sees a wallet only after you allow it, may only ask for signatures and transactions while it's on screen, can't use blind `eth_sign` or permission calls, can't get a Sign-In with Ethereum message for another site signed, and can't touch your Farcaster account (Farcaster typed data, transactions to Farcaster's contracts, Farcaster login messages). Sign in with Farcaster always asks first and builds the message itself. A Sign-In with Ethereum or Solana message for another site than the app's own is shown to you first; ones for farcaster.xyz, warpcast.com and quilcast.com are refused. Swaps may only call (and approve exactly the amount to) LI.FI's contract. Camera and microphone reach an app's frame only after you allow that app. The notification server knows no identities: an inbox is a hashed secret held by one browser, pushes only go to browsers' push services, and webhook events are relayed only when signed by the key they name
- Signers get only the permissions Quilcast uses (casts, reactions, follows, profile), and they revoke themselves on sign-out.
- A profile look is settings, never CSS or HTML. `cleanLook` (`src/shared.ts`) keeps only known fields: colors as `#rrggbb`, numbers in range, fonts, effects and layouts from fixed lists, text with length limits that's shown as text, and images only from Tenor, Farcaster's image CDN and our uploads. The server runs it before storing a look and the app again before showing one. Saving needs a signature from one of the account's Farcaster keys, as listed by the node. Every image is fetched once and refused over 6 MB for the background, 4 MB otherwise, or 25 megapixels. A song has to be a YouTube video that may be embedded, and it only plays when the visitor presses play
- Before upload, photos are re-encoded and MP4/MOV metadata (location, device) is wiped. Uploads stored on the server are checked against their claimed type and served inert (`sandbox` CSP). Each signed upload request works only once.

Production runs from the `Dockerfile` on Easypanel.
