# Runtime Implementation Map

## Shared UI

- `packages/ui/src/lib/pi-runtime/client.ts`: Pi runtime connection, endpoint-aware client, and surface configuration.
- `packages/ui/src/lib/runtime-fetch.ts`: runtime HTTP URL resolution and auth while preserving `Request` fidelity.
- `packages/ui/src/lib/runtime-url.ts`: browser/realtime URL construction.
- `packages/ui/src/lib/runtime-auth.ts`: bearer state and short-lived URL-token minting.
- `packages/ui/src/lib/api/types.ts`: shared `RuntimeAPIs` contract.
- `packages/ui/src/contexts/RuntimeAPIProvider.tsx`: React provider and runtime API wrappers.
- `packages/ui/src/hooks/useRuntimeAPIs.ts`: React consumption path.

## Web And Server

- `packages/web/src/runtimeConfig.ts`: initializes runtime URL/auth and web APIs.
- `packages/web/src/api/index.ts`: composes web `RuntimeAPIs`.
- `packages/web/server/lib/platform/routes-runtime.js`: installs Piarium route families and the Pi runtime HTTP bridge.
- `packages/web/server/lib/pi-runtime/broker.js`: owns Web access to the Pi runtime broker.
- `packages/web/server/lib/ui-auth/ui-auth.js`: session and URL-token route gates.

Explicit Piarium routes must register before broad fallback middleware.

## VS Code

- `packages/vscode/webview/main.tsx`: webview fetch routing and local-route handling.
- `packages/vscode/webview/api/index.ts`: webview `RuntimeAPIs` composition.
- `packages/vscode/webview/api/bridge.ts`: request, session-message, and SSE bridge helpers.
- `packages/vscode/webview/piRuntimeTransport.ts`: webview Pi runtime transport.
- `packages/vscode/src/piRuntime.ts`: extension-host Pi runtime process and transport ownership.
- `packages/vscode/src/bridge-*-runtime.ts`: owning native/local handlers.

## Runtime Switching

`packages/ui/src/lib/runtime-switch.ts` updates endpoint/auth state and emits the runtime-change event. App roots reconnect SDK clients and reset runtime-scoped stores/transports.

Review every cache keyed only by session ID, directory, URL, or entity ID. Add runtime identity when local and remote runtimes can collide.

## Tests To Prefer

- HTTP/request fidelity: `packages/ui/src/lib/runtime-fetch.test.ts`
- URL/auth: `packages/ui/src/lib/runtime-url.test.ts`, `runtime-auth.test.ts`
- Server auth: `packages/web/server/lib/ui-auth/ui-auth.test.js`
- Route registration: `packages/web/server/lib/platform/core-routes.test.js`
- Preview proxy: `packages/web/server/lib/preview/proxy-runtime.test.js`
- VS Code bridge: `packages/vscode/webview/api/bridge.test.ts`
- VS Code Pi runtime transport: `packages/vscode/webview/piRuntimeTransport.test.ts`

Also run focused tests beside new runtime implementations and validation required by each affected workspace.
