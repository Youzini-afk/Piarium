# Workspace search

Host-owned file-name and content search. The renderer never spawns ripgrep or walks the workspace.

## Entrypoints

- `content.js`: `createWorkspaceContentSearch({ documents, spawn, pathModule, env })` — cancellable content search over a resolved workspace root.
- `routes.js`: `registerWorkspaceSearchRoutes(app, deps)` — authenticated search routes.

## Routes

- `GET /api/find/file` — cancellable relative file-name hits for `FilesAPI.search`. Callers may request a result count; omitting it does not silently truncate the search. Failures are HTTP errors, not an empty array.
- `POST /api/workspace/search/content` — discriminated content search:
  - `ready` with hits
  - `empty` when the query is valid and matched nothing
  - `cancelled` when the client disconnects or aborts
  - `failure` with a message when the workspace or ripgrep is unavailable

Web clients request `application/x-ndjson`: natural ripgrep stdout batches are delivered as they arrive,
HTTP backpressure pauses stdout, and a terminal result frame closes the search. JSON callers and Host
capabilities retain the complete-result form. A result count is applied only when the caller explicitly
requests one.

Content search never maps spawn/workspace failure to zero results. File bodies are not logged. Electron reuses this Web host.

## Capability

Host extensions call `workspace.search` / `searchContent`. Isolated renderers do not spawn search tools.
