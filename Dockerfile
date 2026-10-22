FROM node:24.22.1-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# the version bump in package.json reruns this every release; the cache mount keeps it offline
RUN --mount=type=cache,target=/root/.npm npm ci --prefer-offline --no-audit --no-fund
COPY . .
# the server tests start the real server, which serves dist/, so build first
RUN npm run build && npm test

# the runtime's own install, built alongside: browser-only packages (viem, hls.js, preact…) are devDependencies, so
# this keeps just what server/ imports. Pruning the full install instead took ~4 minutes on the Easypanel host
# (npm moves every removed file, and each move copies it in the build's overlay filesystem).
FROM node:24.22.1-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --prefer-offline --no-audit --no-fund

FROM node:24.22.1-slim
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY --from=build /app/dist dist
COPY server server
# the server imports the helpers it shares with the app as TypeScript (Node strips the types)
COPY package.json ./
COPY src/shared.ts src/
ENV PORT=3000
EXPOSE 3000
# the media volume (/data) is owned by uid 1000
USER node
CMD ["node", "server/index.mjs"]
