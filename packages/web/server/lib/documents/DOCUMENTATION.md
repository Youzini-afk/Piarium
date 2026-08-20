# Documents module

Application-host authority for revisioned workspace documents, file watches, and crash-recovery journals.

This module is independent of `FilesAPI` / `WorkspaceAPI` text editors. Existing Files UI continues to use `/api/fs/*` until a later phase migrates those consumers.

## Entrypoints

- `authority.js`: `createDocumentAuthority(options)` — workspace identity, revisioned read/write/move/delete, watch, recovery journals.
- `routes.js`: `registerDocumentRoutes(app, { documents, uiAuthController })` — authenticated `/api/documents/*` routes.
- `capability.js`: `createDocumentsCapabilityHandler(authority)` — resource-scoped `workspace.documents` Host capability.
- `contract-fixtures.js`: shared Web/VS Code contract tests.

## Routes

- `POST /api/documents/workspace/resolve`
- `POST /api/documents/read`
- `POST /api/documents/write`
- `POST /api/documents/move`
- `POST /api/documents/delete`
- `GET /api/documents/watch?workspaceId=` (SSE; credentials stay in headers, not the URL)
- `POST /api/documents/recovery/list|read|write|delete`

Watch events carry resource metadata only. File bodies are not written to logs, event payloads, or URLs.

## Persistence

Workspace IDs live under `{PIARIUM_DATA_DIR}/documents/workspaces.json` and are scoped to this application host. Recovery journals live under `{PIARIUM_DATA_DIR}/document-recovery/{hostId}/...`. Another host must not inherit the same-path selections.

Electron reuses this Web host in-process. It does not add a generic filesystem preload IPC.
