# Rust kernel client and storage boundary

The Application Host owns one `KernelClient` for its lifetime. `KernelClient.start()` spawns the
real `piarium-kernel` executable, performs the build/protocol/epoch/grant handshake, and keeps the private
length-framed stdin/stdout transport separate from stderr. The kernel reports a compiled build identity and
target; packaged Hosts verify the adjacent manifest, executable SHA-256 and actual PE/ELF/Mach-O architecture before spawning it. Large blob
uploads and branch create/write batches use ordered chunks through a single-envelope request/response handoff; `AbortSignal` cancellation
stops admission or the active kernel operation. `stop()` sends the ordered shutdown request and waits for the
child to exit. A missing executable, protocol mismatch, malformed response, revoked grant, or child exit is
an explicit Host failure; it never selects the old backend as a fallback.

## Responsibility table

| Resource | Current authority | Kernel boundary in R0/R1 |
| --- | --- | --- |
| Thread/Run product catalog | TS `ThreadRegistry` | remains TS; kernel receives an actor/grant and operation IDs |
| Pi sessions, models, credentials, extensions | Pi worker/native Pi | remains Pi; kernel never reads provider secrets |
| Unsaved editor buffers and grouped undo | Document Registry | remains Registry; surface receipts are not kernel text authority |
| Knowledge graph/vector stores | TriviumDB + TS adapters | remains the existing single writer |
| Working roots, immutable nodes, blobs, revisions, pins, GC | Rust kernel SQLite/object store | Production `KernelStorageAdapter` uses actor-scoped `branch.*`, paged roots and CAS; no TS WorkingState catalog write |
| Product records and object references (results, drafts, verification/review, retrieval artifact/receipt) | Rust kernel typed `domain_records`/`domain_record_refs` | `storage.record.*` is the only production reference/record writer; object reads require branch/pin/record/temporary-owner identity |
| Recovery operation/checkpoint records | Rust kernel typed `domain_records`/`domain_record_refs`, TS recovery engine for file/apply orchestration | Checkpoints, turns, mutations, combined operations, operation-file phases and retention refs are flushed through the kernel; the SQL-shaped view is transient only |
| Public API and policy | TS Application Host | adapter only; no generic SQL or arbitrary disk method |

Every product-domain call uses an immutable `KernelGrantHandle` obtained for the session/Thread/Run. The
client's Host-management grant is limited to startup, health, grant management and explicit global maintenance;
it is not silently substituted for an actor grant. Rust resolves workspace ownership from the durable resource
(`branch`, `pin`, `operation`, `recovery`, stream or object owner) and applies path scopes to all expanded
entries. Blob bytes can only be read through a branch/pin path that resolves to the requested hash, or through
the exact temporary owner returned to the uploading grant. `KernelClient.scoped(handle)` injects that same explicit handle into each
domain method; it is not a mutable global identity.

R0 is wired from `application-host/index.ts` for Web/serve and Electron's embedded Host. Electron
stages the executable outside `app.asar`; Web packaging stages it in the package `kernel/` directory.
The private storage root is `<PIARIUM_DATA_DIR>/kernel/<hostId>`, with an OS-held owner lock (the
diagnostic record is not the lock) preventing two Hosts from writing it at once. A process epoch
invalidates transient handles after restart; exact Host generation is bound into each grant.

R1 uses SHA-256 content objects, Rust-typed path states, streamed batch-built immutable roots with a persistent
AVL child index, copy-on-write path updates, CAS on `writeRevision`, explicit fixed revisions, explicit
pins, idempotent `operationId`s, explicit operation/temporary-owner release, recovery roots, and reachability GC. Publish always binds
the expected root and write revision. Objects are streamed through SHA-256, flushed and installed before
a SQLite transaction publishes their references. GC records logical release and durable pending file cleanup;
cleanup failures remain visible and are retried on the next owner start. `branch.read` only expands entries when
explicitly requested; ordinary reads walk the root or selected paths. D-256 adds deep health checks for reachable
nodes and objects.

The shared wire source is `kernel/protocol/schema.json`; it generates both the TypeScript client shapes and Rust boundary DTOs. Regenerate with
`node scripts/generate-kernel-protocol.mjs` and check drift with
`node scripts/generate-kernel-protocol.mjs --check`. Request, cancel, and ordered data frames have
separate envelopes, and Rust rejects unknown envelope/method fields before dispatch. The current storage format is v6; startup validates
its schema fingerprint plus the complete table/index/column shape and never upgrades or repairs a mismatched catalog.

The old TS `WorkingStateStore` remains only for legacy/unit fixtures. Application Host production
assembly uses `KernelStorageAdapter` and `KernelWorkingStateStore`; it keeps a short-lived root
projection for product algorithms but never serializes a catalog/trie or opens the kernel SQLite.
Recovery file/apply orchestration is still TS (R2), while checkpoint, turn, mutation, combined operation and
operation-file rows use the typed kernel record API. A kernel failure is surfaced; production does not fall back
to a physical recovery SQLite catalog or the old WorkingState writer.

The Windows release child-process acceptance path is `packages/web/application-host/lib/kernel/kernel-client.test.ts`;
the current run covers the original R0/R1 invariants plus typed record/reference ownership and record-bound object reads.
The production adapter longitudinal path is assembled in `application-host/index.ts` and uses one scoped grant per
workspace/purpose (or a supplied actor resolver), never the Host-management grant for domain calls.
