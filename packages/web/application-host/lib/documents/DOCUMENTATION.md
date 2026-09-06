# Documents module

Application-host authority for revisioned workspace documents, file watches, and crash-recovery journals.

This module is the application-host authority for revisioned workspace documents, file watches, and crash-recovery journals.

Text editors and workspace text helpers consume DocumentsAPI. `FilesAPI` remains browse/binary/CRUD, and `WorkspaceAPI` remains project/tree/git/upload. Neither exposes a duplicate text read/write shape.

## Entrypoints

- `authority.js`: `createDocumentAuthority(options)` — workspace identity, revisioned read/write/move/delete, watch, recovery journals, and immutable agent-input snapshots. `inspectWorkspace(workspaceId)` returns `{ workspaceId, hostId, root }` for trusted host collaborators (search and language). It is not a renderer DocumentsAPI method.
- `surface-snapshot-store.js` — content-hash-deduplicated in-memory copies of one input surface's dirty buffers. Pending snapshots become active only after Pi accepts the input; replacement, rollback, session drop, and Host disposal release content references.
- `routes.js`: `registerDocumentRoutes(app, { documents, uiAuthController })` — authenticated `/api/documents/*` routes.
- `capability.js`: `createDocumentsCapabilityHandler(authority)` — resource-scoped `workspace.documents` Host capability.
- `contract-fixtures.js`: shared Web/VS Code contract tests.

## Routes

- `POST /api/documents/workspace/resolve`
- `POST /api/documents/read`
- `POST /api/documents/write`
- `POST /api/documents/move`
- `POST /api/documents/delete`
- `POST /api/documents/dirty/publish|clear|barrier/ack`
- `POST /api/documents/agent-input/capture|release`
- `GET /api/documents/watch?workspaceId=` (SSE; credentials stay in headers, not the URL)
- `POST /api/documents/recovery/list|read|write|delete`

Watch events carry resource metadata only. Agent-input capture bodies use the authenticated Documents POST channel. Runtime worker requests receive only an opaque snapshot reference or unavailable dirty paths; file bodies are not written to logs, event payloads, or URLs.

## Persistence

Workspace IDs live under `{PIARIUM_DATA_DIR}/documents/workspaces.json` and are scoped to this application host. Converting a filesystem path into an ID performs the current root-admission check once; later operations use that persisted host registration instead of re-reading mutable project selection settings. They still canonicalize the root at use time, reject a changed filesystem identity, enforce resource containment, and fail with `workspace-unavailable` while the root is inaccessible. Loading this registry never touches workspace storage: a deleted or disconnected root keeps its workspace ID and cannot prevent other registrations from loading. Recovery journals live under `{PIARIUM_DATA_DIR}/document-recovery/{hostId}/...`. Agent-input snapshots are deliberately Host-memory state: they survive a renderer/surface disconnect, but Host restart makes the opaque ref unavailable rather than reading current disk as the old draft. Another host must not inherit the same-path selections.

Electron reuses this Web host in-process. It does not add a generic filesystem preload IPC.
