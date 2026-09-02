# Tunnels Module Documentation

## Purpose
This module contains tunnel provider orchestration for Piarium, including provider registry/service wiring, managed remote token config lifecycle, and tunnel HTTP route registration.

## Entrypoints and structure
- `packages/web/application-host/lib/tunnels/index.js`: tunnel service orchestration.
- `packages/web/application-host/lib/tunnels/executable-search.js`: cross-platform executable discovery, including Windows Store app aliases.
- `packages/web/application-host/lib/tunnels/registry.js`: provider registry.
- `packages/web/application-host/lib/tunnels/managed-config.js`: managed remote tunnel token/preset persistence runtime.
- `packages/web/application-host/lib/tunnels/install-help.js`: provider/platform install command metadata for missing tunnel dependencies.
- `packages/web/application-host/lib/tunnels/routes.js`: tunnel API route registration and request orchestration runtime.
- `packages/web/application-host/lib/tunnels/types.js`: tunnel constants, normalization, and shared type helpers.
- `packages/web/application-host/lib/tunnels/providers/cloudflare.js`: Cloudflare tunnel provider implementation.
- `packages/web/application-host/lib/tunnels/providers/ngrok.js`: Ngrok quick tunnel provider implementation.

## Public exports (routes.js)
- `createTunnelRoutesRuntime(dependencies)`: creates tunnel routes runtime and helpers.
- Returned API:
  - `registerRoutes(app)`
  - `startTunnelWithNormalizedRequest(request)`
