# Language services

Application-host supervisor for language servers. Spawn, JSON-RPC, diagnostics, and feature
requests stay in this module. Renderers never spawn language servers.

## Entrypoints

- `supervisor.js`: `createLanguageSupervisor({ documents, spawn, pathModule, env, isTrusted })`
- `jsonrpc.js`: Content-Length framed JSON-RPC client/server
- `routes.js`: authenticated `/api/language/*` routes and SSE events
- `capability.js`: `workspace.language` Host capability
- `fixture-server.js` / `typescript-server.js`: test servers, not production providers

## Status

Each `(workspaceId, languageId)` session is `absent`, `starting`, `ready`, `degraded`, or `failed`.
A crash or failure affects only that session. Stale diagnostics and completions whose
`documentVersion` does not match the open document are dropped.

Project-provided (`source: 'workspace'`) commands run only when `isTrusted(root)` is true.
Production Web sets `isTrusted` to false. There is no HTTP route that registers providers.

## Routes

- `POST /api/language/status|sync|feature|restart|dispose-workspace`
- `GET /api/language/events?workspaceId=` SSE (credentials in headers). Payloads must not include file bodies.

Application-host endpoint/workspace switch disposes sessions. Electron reuses this Web host.
VS Code webviews report language services as `absent` and do not spawn.
