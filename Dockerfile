# syntax=docker/dockerfile:1
ARG RUNTIME_BASE_IMAGE=ghcr.io/youzini-afk/piarium-runtime-slim:main

FROM --platform=$BUILDPLATFORM oven/bun:1.3.14 AS builder
WORKDIR /app
ARG PIARIUM_SOURCE_REVISION

# Keep dependency installation cacheable while still presenting every Bun
# workspace manifest required by the frozen monorepo lockfile.
COPY package.json bun.lock ./
COPY bun-patches ./bun-patches
COPY patches ./patches
COPY fix-deprecation.js ./
COPY packages/electron/package.json ./packages/electron/package.json
COPY packages/extension-builtins/package.json ./packages/extension-builtins/package.json
COPY packages/extension-cli/package.json ./packages/extension-cli/package.json
COPY packages/extension-contract/package.json ./packages/extension-contract/package.json
COPY packages/extension-host/package.json ./packages/extension-host/package.json
COPY packages/extension-loader/package.json ./packages/extension-loader/package.json
COPY packages/extension-react/package.json ./packages/extension-react/package.json
COPY packages/extension-sdk/package.json ./packages/extension-sdk/package.json
COPY packages/extension-surface/package.json ./packages/extension-surface/package.json
COPY packages/mobile/package.json ./packages/mobile/package.json
COPY packages/pi-host/package.json ./packages/pi-host/package.json
COPY packages/protocol/package.json ./packages/protocol/package.json
COPY packages/runtime-broker/package.json ./packages/runtime-broker/package.json
COPY packages/runtime-client/package.json ./packages/runtime-client/package.json
COPY packages/ui/package.json ./packages/ui/package.json
COPY packages/vscode/package.json ./packages/vscode/package.json
COPY packages/vscode/runtime/package.json ./packages/vscode/runtime/package.json
COPY packages/web/package.json ./packages/web/package.json
RUN bun install --frozen-lockfile --ignore-scripts \
  && node ./fix-deprecation.js \
  && node ./node_modules/patch-package/index.js

COPY . .
RUN PIARIUM_SOURCE_REVISION="${PIARIUM_SOURCE_REVISION}" \
  bun run build:cloud-runtime -- --output /app/artifacts/cloud-runtime --no-archive

# This stage runs on TARGETPLATFORM. Installing the canonical runtime tree here
# ensures native production dependencies match the image architecture instead
# of the builder architecture.
FROM ${RUNTIME_BASE_IMAGE} AS runtime
WORKDIR /home/piarium/app

ENV HOME=/home/piarium \
  NODE_ENV=production \
  PIARIUM_DATA_DIR=/home/piarium/.config/piarium \
  PIARIUM_WORKSPACE_ROOT=/home/piarium/workspaces

COPY --from=builder --chown=piarium:piarium /app/artifacts/cloud-runtime/ ./
RUN --mount=type=cache,target=/home/piarium/.cache/bun,uid=1000,gid=1000 \
  bun install --production --frozen-lockfile --cache-dir=/home/piarium/.cache/bun \
  && node --input-type=module -e "import { createRequire } from 'node:module'; const broker = await import('./packages/web/node_modules/@piarium/runtime-broker/dist/index.js'); if (typeof broker.resolveBundledPiHostEntry !== 'function') throw new Error('Piarium runtime broker is missing resolveBundledPiHostEntry'); const entry = broker.resolveBundledPiHostEntry(); if (typeof entry !== 'string' || entry.length === 0) throw new Error('Piarium host entry did not resolve'); const require = createRequire(new URL('./packages/web/package.json', import.meta.url)); const pty = require('node-pty'); if (typeof pty.spawn !== 'function') throw new Error('node-pty is unavailable'); require.resolve('sherpa-onnx-node');"

COPY --chmod=0755 scripts/docker-entrypoint.sh /usr/local/bin/piarium-entrypoint

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=5 \
  CMD curl --fail --silent --show-error http://127.0.0.1:3000/health || exit 1

ENTRYPOINT ["/usr/local/bin/piarium-entrypoint"]
CMD ["node", "packages/web/bin/cli.js", "serve", "--foreground"]
