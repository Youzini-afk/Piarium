---
name: ui-api-decoupling
description: Use when creating or modifying Piarium shared UI data access, `RuntimeAPIs`, Pi runtime protocol calls, runtime fetch/auth/URLs, authenticated browser assets, bridges, relays, runtime switching, or server API routes.
---

# Piarium UI API Decoupling

## Choose the owning path

| Need | Correct path |
|---|---|
| Pi session, package, provider, command, recovery, or config operation | `@piarium/protocol` through the Pi runtime client/broker/host. |
| Runtime-specific capability used by shared UI | Extend `RuntimeAPIs` and implement every applicable runtime. |
| Piarium Web/server capability | Explicit `/api/...` route consumed through `runtimeFetch`. |
| Browser-owned asset or realtime URL | Runtime URL resolver and the owning auth/relay transport. |
| Intentional external service | Plain `fetch`, with its external-origin contract explicit. |

Read `references/implementation-map.md` when locating implementations. Read `references/runtime-parity.md` before adding or changing a shared runtime capability. Read `references/browser-assets-and-auth.md` for browser assets, downloads, iframes, URL auth, or preview proxy work.

## Mandatory rules

1. Shared UI consumes `RuntimeAPIs`, Pi runtime clients, or `runtimeFetch`; it does not hardcode hosts, ports, credentials, or one runtime's transport.
2. Pi runtime operations use the Piarium protocol. Do not recreate removed OpenCode SDK/proxy contracts.
3. Resolve runtime endpoint, auth, and directory state at call time. Key caches by runtime identity where paths or IDs can collide.
4. Authoritative reads distinguish failure from successful empty state and preserve prior valid state on failure.
5. Runtime-specific privilege stays in Web server, Electron main/preload, VS Code extension host, or Pi host—not the renderer.
6. HTTP auth belongs to `runtimeFetch`; browser/realtime auth belongs to scoped URL/relay transports. Never put long-lived credentials in URLs.
7. Register explicit Piarium routes before broad fallback middleware.
8. Define Web, Electron, VS Code, hosted-mobile, and Capacitor behavior explicitly for shared contracts; a stable unsupported result is preferable to accidental fallthrough.

## Runtime switching

- Capture runtime identity with asynchronous work and reject stale completions after a switch.
- Reset or rebind endpoint-scoped stores, transports, directory state, and caches through the established switch lifecycle.
- Never reuse a home/workspace path learned from a previous host.

## Verification

Test request fidelity, auth, failure signaling, stale completions, runtime switching, and every applicable bridge/runtime. Static type-check and lint do not prove runtime parity.
