# Rust kernel client and storage boundary

The Application Host owns one `KernelClient` for its lifetime. `KernelClient.start()` spawns the
real `piarium-kernel` executable, performs the build/protocol/epoch handshake, and keeps the private
length-framed stdin/stdout transport separate from stderr. `stop()` sends the ordered shutdown request
and waits for the child to exit. A missing executable, protocol mismatch, malformed response, or child
exit is an explicit Host failure; it never selects the old backend as a fallback.

## Responsibility table

| Resource | Current authority | Kernel boundary in R0/R1 |
| --- | --- | --- |
| Thread/Run product catalog | TS `ThreadRegistry` | remains TS; kernel receives an actor/grant and operation IDs |
| Pi sessions, models, credentials, extensions | Pi worker/native Pi | remains Pi; kernel never reads provider secrets |
| Unsaved editor buffers and grouped undo | Document Registry | remains Registry; surface receipts are not kernel text authority |
| Knowledge graph/vector stores | TriviumDB + TS adapters | remains the existing single writer |
| Working roots, immutable nodes, blobs, revisions, pins, GC | Rust kernel SQLite/object store | R1 domain API (`branch.*`, `storage.*`) |
| Recovery operation/checkpoint records | Rust kernel operation API | R1 idempotent operation records and durable phases |
| Public API and policy | TS Application Host | adapter only; no generic SQL or arbitrary disk method |

R0 is wired from `application-host/index.ts` for Web/serve and Electron's embedded Host. Electron
stages the executable outside `app.asar`; Web packaging stages it in the package `kernel/` directory.
The private storage root is `<PIARIUM_DATA_DIR>/kernel/<hostId>`, with an owner file preventing two
Hosts from writing it at once. A process epoch invalidates transient handles after restart.

R1 uses SHA-256 content objects, batch-built immutable trie roots, copy-on-write path updates, CAS on
`writeRevision`, immutable published revisions, explicit pins, idempotent `operationId`s, recovery
records, and reachability GC. Objects are fsynced and renamed before a SQLite transaction publishes
their references. `branch.read` only expands entries when explicitly requested; ordinary reads walk the
root or selected paths.

The existing TS WorkingState/Recovery modules remain the historical product adapters until their
consumer-by-consumer cutover is complete. They must not be described as a second Rust writer; new
kernel-domain calls are the production migration seam and are covered by the real child-process test.
