# Language services

Application-host supervisor for language servers. Spawn, JSON-RPC, diagnostics, and feature
requests stay in this module. Renderers never spawn language servers.

## Entrypoints

- `supervisor.js`: `createLanguageSupervisor({ documents, spawn, pathModule, env, isTrusted, hostViewIdleMs, hostViewDocumentLimit, now })`
- `language-view.js`: `createLanguageViewBinder({ documents, supervisor })` — binds one document in the
  Host-owned view to a named text identity (fixed editor draft or disk revision)
- `jsonrpc.js`: Content-Length framed JSON-RPC client/server
- `routes.js`: authenticated `/api/language/*` routes and SSE events, pinned to the `surface` view
- `capability.js`: `workspace.language` Host capability
- `fixture-server.js` / `typescript-server.js`: test servers, not production providers
- the distribution TypeScript/JavaScript provider is a brokered Piarium extension in
  `@piarium/extension-builtins`; its immutable `typescript-language-server` and TypeScript fallback are
  materialized on the first `workspace-match` activation, not registered directly in this module

## Views

A session is keyed by `(workspaceId, languageId, viewId)` because one server cannot be both the
editor's live buffer and an agent turn's fixed text (D-087):

- `surface` — owned by the renderer. Versions are the editor's `localEditRevision`, the process stops
  after the last editor document closes, and a replacement server is handed the current buffers.
- `agent` — owned by the Host. Versions are assigned per `(view, resource)`, each open document
  records the `contentRevision` it was synchronized from, and callers assert that revision with
  `expectedRevision`. It starts on the first Host request, closes least-recently-used documents past
  `hostViewDocumentLimit`, releases after `hostViewIdleMs`, and never replays documents on restart.

`inspectViews()` reports live processes, open documents, and idle time; `releaseIdleHostViews()` is the
explicit release. Both views emit `view` on status and diagnostics events, and the renderer routes
deliver only `surface`.

## Status

Each session is `absent`, `starting`, `ready`, `degraded`, or `failed`. A crash or failure affects only
that session. Stale diagnostics and completions whose `documentVersion` does not match the open
document are dropped; a `contentRevision` mismatch is `stale` with `reason: 'revision'`.

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
