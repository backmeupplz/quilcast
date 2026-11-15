# Quilcast WASM

Quilcast written in Rust and compiled to WebAssembly, served at [wasm.quilcast.com](https://wasm.quilcast.com) next to the TypeScript app at quilcast.com (which, with the phone apps, stays as it is). It reads from the Hypersnap node directly, signs its messages in the browser, and uses quilcast.com's own server for `/api/*` (link previews, the image proxy), exactly as the TypeScript app does.

## How it works

- **The module decides everything.** App state, routing, every request, protobuf encoding, signing and every page are Rust (`src/`). There is no JS UI framework and no wasm-bindgen: the module is a plain `wasm32-unknown-unknown` build.
- **It draws the page as elements, not pixels.** Views build a tree of nodes (`src/view.rs`), and `src/dom.rs` compares it with the one on the page and writes the difference as a short list of operations. Drawing with the DOM rather than a canvas keeps what the browser does for free: text selection, find in page, the screen reader, the keyboard, autofill, and typing with an IME (composition, the caret and spellcheck happen in real `<textarea>`s the module never interrupts).
- **The shell is small and fixed.** `web/shell.js` (about 400 lines) applies those operations, forwards events and reaches the browser APIs wasm can't call by itself: `fetch` (with the headers the module names, such as the signature on requests to Quilcast's server), `localStorage`, IndexedDB, WebCrypto, history, timers, push notifications (the permission, the subscription, and the taps the service worker passes on), the files picked for a cast (which the module reads in pieces) and the browser's image decoder (to draw a photo again without its EXIF). It never parses markup (no `innerHTML`): elements, attributes and text are set one by one, so nothing a cast says can become HTML or script.
- **Keys stay in the browser.** The recovery phrase signs one KEY_ADD (Hypersnap's gasless signers, no transaction) and is then forgotten: it is never stored. The key it adds is a non-extractable WebCrypto Ed25519 key kept in IndexedDB, so the page can sign with it but nothing can read it out; in browsers without Ed25519 in WebCrypto, a raw key sealed with AES-GCM under a non-extractable key instead. Signing out revokes the key with a KEY_REMOVE it signs itself.
- **The same bytes as quilcast.com.** `src/fc.rs` is a port of `src/fc.ts`; its tests check casts, reactions, follows, KEY_ADD (with its EIP-712 signatures) and KEY_REMOVE byte for byte against vectors the TypeScript encoders produce (`vectors.mjs`), and the phrase derives the same custody address.
- **Served by the same server.** `server/index.mjs` serves `wasm/dist` (with quilcast.com's own service worker, `public/sw.js`, for push notifications) for the host `wasm.quilcast.com` (`WASM_HOST`), with its own CSP: `script-src 'self' 'wasm-unsafe-eval'` (to compile the module) and no inline scripts or styles, and nothing may frame it.

## Build and test

```sh
rustup target add wasm32-unknown-unknown
cd wasm && cargo test && sh build.sh     # wasm/dist
node wasm/vectors.mjs                    # the vectors fc.rs tests against
node wasm/emoji.mjs                      # src/emoji.txt, the emoji picker's list, from unicode-emoji-json
npm run build && node --test e2e/wasm.test.mjs   # the app in WebKit against a stand-in node
WASM_HOST=localhost npm start            # then open http://localhost:3000
```

The Dockerfile builds it in a stage of its own (`rust:1.99-slim`), and CI runs the Rust tests, the build and `e2e/wasm.test.mjs`.

## What it does so far

The ticket's goal is everything quilcast.com does, shipped in stages. The list below follows the README's "What it does" and says where each part stands. Stage 1 brought reading, signing in and the basic writes; stage 2 added channels, the lists of people, Browse as, anonymous mode, mutes, blocks and reports; stage 3 added what the composer does beyond text (pictures, videos and GIFs, @mention suggestions, drafts, scheduled casts) and pinned casts; stage 4 added writing threads, the emoji and sticker pickers, four embeds a cast, and the spam filter; stage 5 added several accounts per browser and editing your profile; stage 6 adds push notifications.

| quilcast.com feature | WASM |
| --- | --- |
| Following and Trending feeds, threads, profiles with casts and replies tabs | ✅ (feeds load more as you scroll; a reply links to the cast it answers rather than drawing its parents above it) |
| Cast, reply, quote, like, recast, follow, delete your own casts | ✅ (mentions resolved to FIDs; links in the text become embeds) |
| Post into a channel, channel pages, the Channels directory (and Search's Channels tab) | ✅ (casts go under each channel's real parent URL, old-style ones included; the composer warns before casting into a members-only channel you're not in) |
| Who liked, recast or quoted a cast; followers and following lists | ✅ |
| Browse as someone else, with the last five offered again | ✅ (read-only, from public data; your own mutes and blocks still apply) |
| Anonymous mode: follow people on this device, a merged Following feed, export, import, and following them once signed in | ✅ (the merged feed has their casts but not yet their recasts) |
| Mute or block people for a day, a week, a month or for good; mute words; report a cast or a person | ✅ (the same list as quilcast.com, kept on Quilcast's server signed with this browser's key, or in this browser when signed out; casts in `src/removed.json` stay hidden) |
| Sign in with an existing recovery phrase | ✅ |
| Notifications | ✅ list of likes, recasts, follows, replies, mentions and quotes, without muted or blocked people (not grouped, no unread dot) |
| Search for people and casts | ✅ (not yet a profile's own search button) |
| Rich link previews (`/api/unfurl`) and pictures through `/api/img` | ✅ (no X post cards or mini app launch cards yet) |
| Quoted casts, pictures, video | ✅ (HLS plays only where the browser plays it natively) |
| Light and dark, node URL, sign out (Settings) | ✅ |
| The spam filter (spam.quilcast.com labels) | ✅ ("Spam 97%" and "Spam account 92%" labels on casts and profiles, Settings → Spam to hide spam casts or spam accounts' casts, the threshold, and Not spam in the ⋯ menus; with Hide on, a cast waits up to 1.5 s for its score before it's drawn, as on quilcast.com) |
| Attach photos, videos and GIFs; @mention autocomplete | ✅ (four a cast, a quoted cast taking one; photos are drawn again by the browser at 2048 px at most, so their EXIF is gone; videos lose their metadata boxes, as on quilcast.com. Files are kept on Quilcast's server, which is where quilcast.com puts them too for an account whose recovery phrase it doesn't keep) |
| Threads, the emoji and sticker pickers in the composer | ✅ (+ adds a post after the one being written, each with its own pictures and @mentions; Backspace in an empty post takes it out; Post all sends them as replies, one after another, and one that fails leaves only what didn't go out. The emoji list is quilcast.com's, built into the module; stickers come from the account's packs) |
| Sticker pack pages (make a pack, import one from Telegram, share and add packs) and pack link cards | ⏳ (stickers in casts show as stickers and open their pack on quilcast.com) |
| The composer's Markdown mode (formatting buttons, pictures inside the text) | ⏳ |
| Several accounts per browser | ✅ (Settings → Accounts lists them, switches between them and adds one with its recovery phrase; each keeps its own key, mutes and drafts key, and signing out of one revokes only its key and hands over to the next. Signing in again to an account already here switches to it rather than adding a second key) |
| Push notifications | ✅ (Settings → Notifications turns them on for each account here and picks the kinds; each account is signed up with its own key, as on quilcast.com, and the same service worker shows them. Tapping one opens the cast or profile in an open window, switching to that account, or in a new one that starts as it. A failed scheduled cast's opens the composer's Scheduled list. Signing out stops them. The subscription is this site's own, so quilcast.com and wasm.quilcast.com each count as a browser of their own) |
| Create a new account, sign in with an external wallet | ⏳ |
| Messages (direct casts) | ⏳ |
| Spaces | ⏳ |
| Wallet (send, swap, bridge) | ⏳ |
| Mini apps (dock, notifications, wallet providers) | ⏳ |
| Profile looks and the Winamp | ⏳ |
| App themes (with Quorum import and export), Quorum mode | ⏳ |
| 22 languages, translations | ⏳ (English only) |
| Drafts | ✅ (sealed in the browser with the same key quilcast.com makes from the custody, so drafts open on either; this browser makes it while signing in with the recovery phrase, so a session from before stage 3 has to sign in again for drafts) |
| Scheduled casts | ✅ (signed here for their time and handed to Quilcast's server, as quilcast.com does; listed, edited and cancelled in the composer) |
| Pinned casts | ✅ (pin and unpin your own casts; a profile shows its pin on top) |
| Articles | ⏳ |
| Profile editing | ✅ (Settings → Profile: the photo, drawn again by the browser and uploaded like a cast's, the name, bio and website, each sent as its own USER_DATA_ADD signed here) |
| Key export and the rest of Settings | ⏳ (Quilcast WASM never keeps the recovery phrase, so there is nothing to export yet) |
| Quilcast as a mini app, share cards and meta tags per page, RSS | ⏳ (every page has the same meta tags; RSS stays on quilcast.com) |
| Reproducible build hashes (`build.json`, `scripts/verify.mjs`) | ⏳ (`wasm/dist` isn't in them yet) |
