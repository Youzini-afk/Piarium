# syntax=docker/dockerfile:1
ARG RUNTIME_BASE_IMAGE=ghcr.io/youzini-afk/openchamber-runtime-base:main

FROM oven/bun:1.3.14 AS base
WORKDIR /app

FROM base AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY bun-patches ./bun-patches
COPY patches ./patches
COPY fix-deprecation.js ./
COPY packages/ui/package.json ./packages/ui/
COPY packages/web/package.json ./packages/web/
COPY packages/electron/package.json ./packages/electron/
COPY packages/mobile/package.json ./packages/mobile/
COPY packages/vscode/package.json ./packages/vscode/
RUN bun install --frozen-lockfile --ignore-scripts \
  && node ./fix-deprecation.js \
  && node ./node_modules/patch-package/index.js

FROM deps AS builder
WORKDIR /app
COPY . .
RUN PIARIUM_LOW_MEMORY_BUILD=1 bun run build:web

FROM ${RUNTIME_BASE_IMAGE} AS runtime
WORKDIR /home/openchamber

ENV NODE_ENV=production

COPY scripts/docker-entrypoint.sh /home/openchamber/openchamber-entrypoint.sh

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/web/node_modules ./packages/web/node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/packages/web/package.json ./packages/web/package.json
COPY --from=builder /app/packages/web/bin ./packages/web/bin
COPY --from=builder /app/packages/web/server ./packages/web/server
COPY --from=builder /app/packages/web/dist ./packages/web/dist

EXPOSE 3000

ENTRYPOINT ["sh", "/home/openchamber/openchamber-entrypoint.sh"]
