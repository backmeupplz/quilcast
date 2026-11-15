# Quilcast WASM

Quilcast written in Rust and compiled to WebAssembly, served at [wasm.quilcast.com](https://wasm.quilcast.com) next to the TypeScript app at quilcast.com (which, with the phone apps, stays as it is). It reads from the Hypersnap node directly, signs its messages in the browser, and uses quilcast.com's own server for `/api/*` (link previews, the image proxy), exactly as the TypeScript app does.

## How it works

- **The module decides everything.** App state, routing, every request, protobuf encoding, signing and every page are Rust (`src/`). There is no JS UI framework and no wasm-bindgen: the module is a plain `wasm32-unknown-unknown` build.
- **It draws the page as elements, not pixels.** Views build a tree of nodes (`src/view.rs`), and `src/dom.rs` compares it with the one on the page and writes the difference as a short list of operations. Drawing with the DOM rather than a canvas keeps what the browser does for free: text selection, find in page, the screen reader, the keyboard, autofill, and typing with an IME (composition, the caret and spellcheck happen in real `<textarea>`s the module never interrupts).
- **The shell is small and fixed.** `web/shell.js` (about 270 lines) applies those operations, forwards events and reaches the browser APIs wasm can't call by itself: `fetch`, `localStorage`, IndexedDB, WebCrypto, history and timers. It never parses markup (no `innerHTML`): elements, attributes and text are set one by one, so nothing a cast says can become HTML or script.
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

This is the first stage. The ticket's goal is everything quilcast.com does; the list below follows the README's "What it does" and says where each part stands.

| quilcast.com feature | WASM |
| --- | --- |
| Following and Trending feeds, threads, profiles with casts and replies tabs | ✅ (feeds load more as you scroll; a reply links to the cast it answers rather than drawing its parents above it) |
| Cast, reply, quote, like, recast, follow, delete your own casts | ✅ (mentions resolved to FIDs; links in the text become embeds) |
| Sign in with an existing recovery phrase | ✅ |
| Notifications | ✅ list of likes, recasts, follows, replies, mentions and quotes (not grouped, no unread dot) |
| Search for people and casts | ✅ |
| Rich link previews (`/api/unfurl`) and pictures through `/api/img` | ✅ (no X post cards or mini app launch cards yet) |
| Quoted casts, pictures, video | ✅ (HLS plays only where the browser plays it natively) |
| Light and dark, node URL, sign out (Settings) | ✅ |
| Post into a channel, channel pages, the Channels directory | ⏳ (channel links open on quilcast.com) |
| Attach photos, videos and GIFs; @mention autocomplete | ⏳ |
| Who liked, recast or quoted a cast | ⏳ |
| Browse as someone else, anonymous mode | ⏳ |
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
| Mutes, blocks and reports | ⏳ |
| Drafts, scheduled casts, Articles, pinned casts | ⏳ |
| Profile editing, key export and the rest of Settings | ⏳ |
| Quilcast as a mini app, share cards and meta tags per page, RSS | ⏳ (every page has the same meta tags; RSS stays on quilcast.com) |
| Reproducible build hashes (`build.json`, `scripts/verify.mjs`) | ⏳ (`wasm/dist` isn't in them yet) |
