# Workspace search

Host-owned file-name and content search. The renderer never spawns ripgrep or walks the workspace.

## Entrypoints

- `content.js`: `createWorkspaceContentSearch({ documents, spawn, pathModule, env })` — cancellable content search over a resolved workspace root.
- `routes.js`: `registerWorkspaceSearchRoutes(app, deps)` — authenticated search routes.

## Routes

- `GET /api/find/file` — relative file-name hits for `FilesAPI.search`. Failures are HTTP errors, not an empty array.
- `POST /api/workspace/search/content` — discriminated content search:
  - `ready` with hits
  - `empty` when the query is valid and matched nothing
  - `cancelled` when the client disconnects or aborts
  - `failure` with a message when the workspace or ripgrep is unavailable

Content search never maps spawn/workspace failure to zero results. File bodies are not logged. Electron reuses this Web host.

## Capability

Host extensions call `workspace.search` / `searchContent`. Isolated renderers do not spawn search tools.
