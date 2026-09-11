# Documents module

Application-host authority for revisioned workspace documents, file watches, and crash-recovery journals.

This module is the application-host authority for revisioned workspace documents, file watches, and crash-recovery journals.

Text editors and workspace text helpers consume DocumentsAPI. `FilesAPI` remains browse/binary/CRUD, and `WorkspaceAPI` remains project/tree/git/upload. Neither exposes a duplicate text read/write shape.

## Entrypoints

- `authority.js`: `createDocumentAuthority(options)` — workspace identity, revisioned read/write/move/delete, watch, recovery journals, immutable agent-input snapshots, and `applyAgentSurfaceWrite` (the shared root-session plan that edits a live Registry buffer or returns the disk sentinel). When durable mutation storage is bound, mixed surface/disk writes persist an `agent-mutation` recovery operation before the first write. `inspectWorkspace(workspaceId)` returns `{ workspaceId, hostId, root }` for trusted host collaborators (search and language). It is not a renderer DocumentsAPI method.
- `surface-mutation.js` — classifies snapshot-owned vs disk paths, applies text edits against the fixed snapshot, writes editor-canonical text through `requestSurfaceOperation`, and compensates a mixed batch with one undo that reuses the apply `operationId`. UI `bufferHash` is compared only to the normalized editor identity, never to serialized snapshot bytes.
- `line-ending.js` — detect / normalize / serialize editor line endings so Registry buffers stay LF while snapshots keep the file's original endings.
- `agent-mutation-operation.js` — durable `agent-mutation` kind on the existing recovery catalog. It records intent, per-path before/after identity, and phase; compensation and startup reconcile use observable state only. This is not an Integration operation.
- `surface-snapshot-store.js` — content-hash-deduplicated in-memory copies of one input surface's dirty buffers, including encoding/BOM metadata, editor `bufferHash`, `lineEnding`, and content serialized with its original line endings so consumers can reproduce save bytes. Pending snapshots become active only after Pi accepts the input; replacement, rollback, session drop, and Host disposal release content references. The internal clone operation lets Thread dispatch copy a validated snapshot into persistent WorkingState; it is not a renderer route.
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
- `POST /api/documents/surface-operation/read|complete`
- `GET /api/documents/watch?workspaceId=` (SSE; credentials stay in headers, not the URL)
- `POST /api/documents/recovery/list|read|write|delete`

Watch events carry resource metadata only. Agent-input capture bodies use the authenticated Documents POST channel. Runtime worker requests receive only an opaque snapshot reference or unavailable dirty paths; file bodies are not written to logs, event payloads, or URLs.

Thread Integration uses Host-directed surface capture/apply/undo requests. The dirty-owner connection carries the request ID; the authenticated surface-operation routes carry bodies and receipts. Authority checks owner registration, generation, workspace and document identity. Integration persists its intent before dispatch and only completes after a valid receipt; caller-provided paths cannot acknowledge a write. Confirmed own writes update matching active agent-input sources. An uncertain dispatched write invalidates those paths, so reads cannot silently return either the old draft or old disk. Ordinary later user edits still do not mutate an already captured input.

## Persistence

Workspace IDs live under `{PIARIUM_DATA_DIR}/documents/workspaces.json` and are scoped to this application host. Converting a filesystem path into an ID performs the current root-admission check once; later operations use that persisted host registration instead of re-reading mutable project selection settings. They still canonicalize the root at use time, reject a changed filesystem identity, enforce resource containment, and fail with `workspace-unavailable` while the root is inaccessible. Loading this registry never touches workspace storage: a deleted or disconnected root keeps its workspace ID and cannot prevent other registrations from loading. Recovery journals live under `{PIARIUM_DATA_DIR}/document-recovery/{hostId}/...`. Agent-input snapshots themselves are deliberately Host-memory state: they survive a renderer/surface disconnect, but Host restart makes an unconsumed opaque ref unavailable rather than reading current disk as the old draft. A Thread created from one first copies its content into the separately persistent WorkingState store. Another host must not inherit the same-path selections.

Electron reuses this Web host in-process. It does not add a generic filesystem preload IPC.
