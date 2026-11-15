# Quilcast WASM

Quilcast written in Rust and compiled to WebAssembly, served at [wasm.quilcast.com](https://wasm.quilcast.com) next to the TypeScript app at quilcast.com (which, with the phone apps, stays as it is). It reads from the Hypersnap node directly, signs its messages in the browser, and uses quilcast.com's own server for `/api/*` (link previews, the image proxy), exactly as the TypeScript app does.

## How it works

- **The module decides everything.** App state, routing, every request, protobuf encoding, signing and every page are Rust (`src/`). There is no JS UI framework and no wasm-bindgen: the module is a plain `wasm32-unknown-unknown` build.
- **It draws the page as elements, not pixels.** Views build a tree of nodes (`src/view.rs`), and `src/dom.rs` compares it with the one on the page and writes the difference as a short list of operations. Drawing with the DOM rather than a canvas keeps what the browser does for free: text selection, find in page, the screen reader, the keyboard, autofill, and typing with an IME (composition, the caret and spellcheck happen in real `<textarea>`s the module never interrupts).
- **The shell is small and fixed.** `web/shell.js` (about 350 lines) applies those operations, forwards events and reaches the browser APIs wasm can't call by itself: `fetch` (with the headers the module names, such as the signature on requests to Quilcast's server), `localStorage`, IndexedDB, WebCrypto, history, timers, the files picked for a cast (which the module reads in pieces) and the browser's image decoder (to draw a photo again without its EXIF). It never parses markup (no `innerHTML`): elements, attributes and text are set one by one, so nothing a cast says can become HTML or script.
- **Keys stay in the browser.** The recovery phrase signs one KEY_ADD (Hypersnap's gasless signers, no transaction) and is then forgotten: it is never stored. The key it adds is a non-extractable WebCrypto Ed25519 key kept in IndexedDB, so the page can sign with it but nothing can read it out; in browsers without Ed25519 in WebCrypto, a raw key sealed with AES-GCM under a non-extractable key instead. Signing out revokes the key with a KEY_REMOVE it signs itself.
- **The same bytes as quilcast.com.** `src/fc.rs` is a port of `src/fc.ts`; its tests check casts, reactions, follows, KEY_ADD (with its EIP-712 signatures) and KEY_REMOVE byte for byte against vectors the TypeScript encoders produce (`vectors.mjs`), and the phrase derives the same custody address.
- **Served by the same server.** `server/index.mjs` serves `wasm/dist` for the host `wasm.quilcast.com` (`WASM_HOST`), with its own CSP: `script-src 'self' 'wasm-unsafe-eval'` (to compile the module) and no inline scripts or styles, and nothing may frame it.

## Build and test

```sh
rustup target add wasm32-unknown-unknown
cd wasm && cargo test && sh build.sh     # wasm/dist
node wasm/vectors.mjs                    # the vectors fc.rs tests against
npm run build && node --test e2e/wasm.test.mjs   # the app in WebKit against a stand-in node
WASM_HOST=localhost npm start            # then open http://localhost:3000
```

The Dockerfile builds it in a stage of its own (`rust:1.99-slim`), and CI runs the Rust tests, the build and `e2e/wasm.test.mjs`.

## What it does so far

The ticket's goal is everything quilcast.com does, shipped in stages. The list below follows the README's "What it does" and says where each part stands. Stage 1 brought reading, signing in and the basic writes; stage 2 added channels, the lists of people, Browse as, anonymous mode, mutes, blocks and reports; stage 3 adds what the composer does beyond text (pictures, videos and GIFs, @mention suggestions, drafts, scheduled casts) and pinned casts.

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
| The spam filter (spam.quilcast.com labels) | ⏳ |
| Attach photos, videos and GIFs; @mention autocomplete | ✅ (photos are drawn again by the browser at 2048 px at most, so their EXIF is gone; videos lose their metadata boxes, as on quilcast.com. Files are kept on Quilcast's server, which is where quilcast.com puts them too for an account whose recovery phrase it doesn't keep) |
| Threads, the emoji and sticker pickers in the composer | ⏳ (a thread saved as a draft on quilcast.com opens, posts and schedules here, but a new one can't be written yet) |
| Several accounts per browser | ⏳ |
| Push notifications | ⏳ |
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
| Profile editing, key export and the rest of Settings | ⏳ |
| Quilcast as a mini app, share cards and meta tags per page, RSS | ⏳ (every page has the same meta tags; RSS stays on quilcast.com) |
| Reproducible build hashes (`build.json`, `scripts/verify.mjs`) | ⏳ (`wasm/dist` isn't in them yet) |
