# Every release bumps the version in both manifests; blanking it here keeps the installs below cached
# until a dependency actually changes.
FROM node:24.22.1-slim AS manifests
WORKDIR /app
COPY package.json package-lock.json ./
RUN node -e 'const fs = require("fs"); for (const f of ["package.json", "package-lock.json"]) { const j = JSON.parse(fs.readFileSync(f)); j.version = "0.0.0"; if (j.packages) j.packages[""].version = "0.0.0"; fs.writeFileSync(f, JSON.stringify(j)) }'

FROM node:24.22.1-slim AS build
WORKDIR /app
COPY --from=manifests /app ./
RUN --mount=type=cache,target=/root/.npm npm ci --prefer-offline --no-audit --no-fund
COPY . .
# the server tests start the real server, which serves dist/, so build first. Then gather what the runtime
# needs into /out, so the image gets one layer for it instead of one per COPY.
# The server imports the helpers it shares with the app as TypeScript (Node strips the types).
RUN npm run build && npm test \
  && mkdir -p /out/src && cp -r dist server package.json /out/ && cp src/shared.ts src/fx.ts /out/src/

# the runtime's own install, built alongside: browser-only packages (viem, hls.js, preact…) are devDependencies, so
# this keeps just what server/ imports. Pruning the full install instead took ~4 minutes on the Easypanel host
# (npm moves every removed file, and each move copies it in the build's overlay filesystem).
FROM node:24.22.1-slim AS deps
WORKDIR /app
COPY --from=manifests /app ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --prefer-offline --no-audit --no-fund

FROM node:24.22.1-slim
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY --from=build /out ./
ENV PORT=3000
EXPOSE 3000
# the media volume (/data) is owned by uid 1000
USER node
CMD ["node", "server/index.mjs"]
