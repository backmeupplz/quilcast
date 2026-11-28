# Every release bumps the version in both manifests; blanking it here keeps the installs below cached
# until a dependency actually changes.
FROM node:24.22.3-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530 AS manifests
WORKDIR /app
COPY package.json package-lock.json ./
RUN node -e 'const fs = require("fs"); for (const f of ["package.json", "package-lock.json"]) { const j = JSON.parse(fs.readFileSync(f)); j.version = "0.0.0"; if (j.packages) j.packages[""].version = "0.0.0"; fs.writeFileSync(f, JSON.stringify(j)) }'

# stickers (server/stickers.mjs) are made with ffmpeg (a static build: it has libvpx, which Telegram's video stickers
# need for their alpha) and libwebp's img2webp; the tests make some too, so the build has them as well
FROM mwader/static-ffmpeg:7.1.1@sha256:11a44711684c0b9f754c047dcd64235b8b52deab251bd0e0a86f22faa160749c AS ffmpeg
FROM node:24.22.3-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530 AS media
RUN apt-get update && apt-get install -y --no-install-recommends webp && rm -rf /var/lib/apt/lists/*
COPY --from=ffmpeg /ffmpeg /usr/local/bin/

# Quilcast WASM (wasm/, served at wasm.quilcast.com): Rust compiled to WebAssembly, nothing else (wasm/build.sh). Its own
# stage, so the image only rebuilds it when wasm/ changes
FROM rust:1.100-slim@sha256:24516ae4487ab804e3db145c93f7240e58e225587ab9b7c62ea31a218727bf67 AS wasm
WORKDIR /w
RUN rustup target add wasm32-unknown-unknown
COPY wasm/Cargo.toml wasm/Cargo.lock wasm/build.sh wasm/
COPY wasm/src wasm/src
COPY wasm/web wasm/web
# the files outside wasm/ that build.sh copies into wasm/dist; server/image.test.mjs checks that each one is copied here
COPY public/favicon.svg public/icon.png public/apple-touch-icon.png public/sw.js public/
# the casts and accounts taken down for everyone, which the module builds in (wasm/src/mutes.rs)
COPY src/removed.json src/
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/w/wasm/target sh wasm/build.sh

FROM media AS build
WORKDIR /app
COPY --from=manifests /app ./
RUN --mount=type=cache,target=/root/.npm npm ci --prefer-offline --no-audit --no-fund
COPY . .
# the server tests start the real server, which serves dist/, so build first. Then gather what the runtime
# needs into /out, so the image gets one layer for it instead of one per COPY.
# The server imports the helpers it shares with the app as TypeScript (Node strips the types); server/image.test.mjs
# checks that every src/ file the server imports is copied here.
RUN npm run build && npm test \
  && mkdir -p /out/src && cp -r dist server collect actions package.json /out/ && cp -r src/shared.ts src/fx.ts src/article.ts src/fc.ts src/keys.ts src/removed.json src/locales /out/src/

# the runtime's own install, built alongside: browser-only packages (viem, hls.js, preact…) are devDependencies, so
# this keeps just what server/ imports. Pruning the full install instead took ~4 minutes on the Easypanel host
# (npm moves every removed file, and each move copies it in the build's overlay filesystem).
FROM node:24.22.3-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530 AS deps
WORKDIR /app
COPY --from=manifests /app ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --prefer-offline --no-audit --no-fund

FROM media
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY --from=build /out ./
COPY --from=wasm /w/wasm/dist wasm/dist
ENV PORT=3000
EXPOSE 3000
# the media volume (/data) is owned by uid 1000; a new empty volume (quilcast.crosspost's) takes this owner from the image.
# Both services only run node, so the npm bundled with the base image goes (its brace-expansion and undici get CVEs
# that no Node release has fixed yet)
RUN mkdir -p /data && chown node:node /data && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
USER node
CMD ["node", "server/index.mjs"]
