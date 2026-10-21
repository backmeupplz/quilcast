FROM node:24.22.1-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# the server tests start the real server, which serves dist/, so build first
RUN npm run build && npm test && npm prune --omit=dev

FROM node:24.22.1-slim
WORKDIR /app
COPY --from=build /app/node_modules node_modules
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
