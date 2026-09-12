# Rust kernel client and storage boundary

The Application Host owns one `KernelClient` for its lifetime. `KernelClient.start()` spawns the
real `piarium-kernel` executable, performs the build/protocol/epoch/grant handshake, and keeps the private
length-framed stdin/stdout transport separate from stderr. Large blob uploads use ordered data chunks with
backpressure; `AbortSignal` cancellation stops admission or the active kernel operation. `stop()` sends the
ordered shutdown request and waits for the child to exit. A missing executable, protocol mismatch, malformed
response, revoked grant, or child exit is an explicit Host failure; it never selects the old backend as a fallback.

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
The private storage root is `<PIARIUM_DATA_DIR>/kernel/<hostId>`, with an OS-held owner lock (the
diagnostic record is not the lock) preventing two Hosts from writing it at once. A process epoch
invalidates transient handles after restart; exact Host generation is bound into each grant.

R1 uses SHA-256 content objects, Rust-typed path states, batch-built immutable roots with a persistent
AVL child index, copy-on-write path updates, CAS on `writeRevision`, explicit fixed revisions, explicit
pins, idempotent `operationId`s, recovery roots, and reachability GC. Objects are fsynced and renamed before
a SQLite transaction publishes their references. GC records logical release and durable pending file cleanup;
cleanup failures remain visible and are retried on the next owner start. `branch.read` only expands entries when
explicitly requested; ordinary reads walk the root or selected paths. D-256 adds deep health checks for reachable
nodes and objects.

The shared wire source is `kernel/protocol/schema.json`; regenerate with
`node scripts/generate-kernel-protocol.mjs` and check drift with
`node scripts/generate-kernel-protocol.mjs --check`. Request, cancel, and ordered data frames have
separate envelopes, and Rust rejects unknown envelope/method fields before dispatch.

The existing TS WorkingState/Recovery modules remain the historical product adapters until their
consumer-by-consumer cutover is complete. They must not be described as a second Rust writer; new
kernel-domain calls are the production migration seam and are covered by the real child-process test.
