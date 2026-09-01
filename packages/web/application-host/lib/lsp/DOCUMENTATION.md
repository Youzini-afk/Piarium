# Language services

Application-host supervisor for language servers. Spawn, JSON-RPC, diagnostics, and feature
requests stay in this module. Renderers never spawn language servers.

## Entrypoints

- `supervisor.js`: `createLanguageSupervisor({ documents, spawn, pathModule, env, isTrusted })`
- `jsonrpc.js`: Content-Length framed JSON-RPC client/server
- `routes.js`: authenticated `/api/language/*` routes and SSE events
- `capability.js`: `workspace.language` Host capability
- `fixture-server.js` / `typescript-server.js`: test servers, not production providers
- the distribution TypeScript/JavaScript provider is a brokered Piarium extension in
  `@piarium/extension-builtins`; its immutable `typescript-language-server` and TypeScript fallback are
  materialized on the first `workspace-match` activation, not registered directly in this module

## Status

Each `(workspaceId, languageId)` session is `absent`, `starting`, `ready`, `degraded`, or `failed`.
A crash or failure affects only that session. Stale diagnostics and completions whose
`documentVersion` does not match the open document are dropped. The provider process starts when the
first matching document is synchronized and stops after the last matching document closes.

Provider disable/reload clears its diagnostics and generation. Commands are executed only by the Host,
only for the provider/document generation that produced them, and only when the server declared that
command in `executeCommandProvider`.

Project-provided (`source: 'workspace'`) commands run only when `isTrusted(root)` is true.
Production Web sets `isTrusted` to false. There is no HTTP route that registers providers.

## Routes

- `POST /api/language/status|sync|feature|restart|dispose-workspace`; the feature route includes
  generation-bound `executeCommand`
- `GET /api/language/events?workspaceId=` SSE (credentials in headers). Payloads must not include file bodies.

Application-host endpoint/workspace switch disposes sessions. Electron reuses this Web host.
VS Code webviews report language services as `absent` and do not spawn.
