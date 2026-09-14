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

| Resource | Current authority | Kernel boundary through R2 |
| --- | --- | --- |
| Thread/Run product catalog | TS `ThreadRegistry` | remains TS; kernel receives an actor/grant and operation IDs |
| Pi sessions, models, credentials, extensions | Pi worker/native Pi | remains Pi; kernel never reads provider secrets |
| Unsaved editor buffers and grouped undo | Document Registry | remains Registry; surface receipts are not kernel text authority |
| Knowledge graph/vector stores | TriviumDB + TS adapters | remains the existing single writer |
| Working roots, immutable nodes, blobs, revisions, pins, GC | Rust kernel SQLite/object store | Production `KernelStorageAdapter` uses actor-scoped `branch.*`, paged roots and CAS; no TS WorkingState catalog write |
| Product records and object references (results, drafts, verification/review, retrieval artifact/receipt) | Rust kernel typed `domain_records`/`domain_record_refs` | `working.*` owns fixed result/draft/verification/review records; retrieval uses exact record identities; branch metadata is stored atomically with the branch rather than as a generic record |
| Recovery checkpoint/turn/mutation records | Rust kernel typed recovery tables and references | Production checkpoint/turn/mutation use `KernelRecoveryStore` directly |
| Combined Recovery/Integration/agent-mutation journal | Rust kernel typed recovery operations/files | Production consumers await Rust phase/terminal CAS; TS coordinates Registry receipts but does not persist a second journal |
| Canonical workspace file resources and controlled disk mutation | Rust kernel `fileResources` | Documents-authorized roots, exact/subtree leases, typed capture, conditional apply, mkdir/remove/rename and restart reconciliation; Documents/Files/Recovery/Integration and production `fs.lock` share this authority |
| Public API and policy | TS Application Host | adapter only; no generic SQL or arbitrary disk method |

Session-facing root/path calls use an immutable `KernelGrantHandle` obtained for the exact session/Thread/Run. Cross-Thread Host lifecycle work uses an explicit workspace `storage.maintenance` grant; it never borrows an arbitrary live session. The
client's Host-management grant is limited to startup, health, grant management and explicit global maintenance;
it is not silently substituted for an actor grant. Rust resolves workspace ownership from the durable resource
(`branch`, `pin`, `operation`, `recovery`, stream or object owner) and applies path scopes to all expanded
entries. Blob bytes can only be read through a branch/pin path that resolves to the requested hash, or through
the exact temporary owner returned to the uploading grant. `KernelClient.scoped(handle)` injects that same explicit handle into each
domain method; it is not a mutable global identity.

R0 is wired from `application-host/index.ts` for Web/serve and Electron's embedded Host. Electron
stages the executable outside `app.asar`; Web packaging stages it in the package `kernel/` directory.
The private storage root is `<PIARIUM_DATA_DIR>/kernel/<hostId>`, with an OS-held owner lock (the
diagnostic record is not the lock) preventing two Hosts from writing it at once. Built-in Recovery shares
this root and reports `application-data` with `storageManagement: false`; it is not independently relocatable.
The public recovery v5 location methods remain available to replacement providers that advertise storage
management, but they do not move this kernel authority. A process epoch invalidates transient handles after
restart; Host, authority, worker generation, session, Thread and Run identity are bound into actor grants.

R1 uses SHA-256 content objects, Rust-typed path states, streamed batch-built immutable roots with a persistent
AVL child index, copy-on-write path updates, CAS on `writeRevision`, explicit fixed revisions, explicit
pins, idempotent `operationId`s, explicit operation/temporary-owner release, recovery roots, and reachability GC. Publish always binds
the expected root and write revision. Objects are streamed through SHA-256, flushed and installed before
a SQLite transaction publishes their references. GC records logical release and durable pending file cleanup;
cleanup failures remain visible and are retried on the next owner start. `branch.read` only expands entries when
explicitly requested; ordinary reads walk the root or selected paths. D-256 adds deep health checks for reachable
nodes and objects.

The working result/draft/verification/review boundary has generated `working.*` DTOs and Rust domain methods.
Rust validates nested documents, explicit branch identity, published root/revision and root-diff `changedPaths`; malformed
or mismatched records are rejected. Drafts are dedicated fixed branches. Result release removes dependent records and its
revision atomically while independent pins retain the root. Full state is read through scoped root/path methods rather than
durable `baseStates/pathStates` payloads or a Host-side compatibility projection.

The shared wire source is `kernel/protocol/schema.json`; it generates both the TypeScript client shapes and Rust boundary DTOs. Regenerate with
`node scripts/generate-kernel-protocol.mjs` and check drift with
`node scripts/generate-kernel-protocol.mjs --check`. Request, cancel, and ordered data frames have
separate envelopes, and Rust rejects unknown envelope/method fields before dispatch. The current storage/catalog format is v9; startup validates
its schema fingerprint plus the complete table/index/column shape and never upgrades or repairs a mismatched catalog.

The old TS `WorkingStateStore` remains only for unit fixtures. Application Host production assembly uses
`KernelStorageAdapter` and kernel root/path/range APIs for branch reads, writes, pins, history, materializer/delete and result consumers.
Virtual publish pins one exact root through diff/read/publish, and scoped subtree reads are filtered in Rust before paging.
Combined Recovery/Integration/agent-mutation uses `KernelRecoveryStore` directly; intent and file/terminal CAS are awaited before
side effects or public completion. The old local SQLite recovery engine is a test helper and is unreachable from production imports.
There is no transient close-time flush, WorkingState fallback, or optional durable dual-write path.

R2 adds `fileResources` without exposing a generic arbitrary-filesystem escape hatch. The Host registers a
Documents-authorized canonical execution root for an owning/execution workspace pair, then Rust resolves every
relative path against that root and the caller grant. Exact/subtree leases are the production overlap gate.
`file.capture` returns typed missing/file/directory/symlink/unsupported state and installs regular-file bytes as
kernel content objects; `file.apply` is conditional on an expected state and can consume only an authorized
object owner. `file.mkdir`, `file.remove`, and `file.rename` use the same root and lease authority. Started file
operations persist intent before the side effect and are reconciled on root registration after restart; an
unprovable state stays conflict/attention rather than being guessed complete. Recovery maintenance object-owner
rebind is restricted to same-workspace owners created by a `recovery.maintenance` grant.

Production Documents write/move/delete, workspace-scoped Files CRUD, Recovery/Integration disk apply and
compensation, and Harness `fs.lock` use this boundary. Piarium-mode Pi `write`/`edit`/`apply_patch` routes real
disk/surface work through Host `document.surfaceWrite`; if that Host mutation backend is unavailable the worker
fails rather than falling back to its own disk writer. Document Registry still owns unsaved buffers and grouped
undo. Workspace/Git/bulk adapters that are not yet native Rust operations register exact/subtree writers with
the same gate.

R3 extends the same file-resource authority to baseline and managed execution directories. `file.scan` pages
Host-admitted filesystem inventories while excluding `.git`/`.piarium`; `file.capture` installs the selected
body bytes as same-grant objects so WorkingState branch creation can consume them without owner rebinding.
WorkingState recaptures the selected paths before publishing a baseline or materialized result and refuses a
mixed view when content, metadata, or inventory changes. Git still supplies staged/unstaged/untracked, index
mode, dirty-content identity, and real filter/EOL semantics; frozen capture scopes are merged with Git changes.

`file.materialize` installs one immutable root through operation-specific staging and backup directories,
verifies every content object, reports actual reflink/copy counts, and reconciles an interrupted switch after
restart. Linux attempts FICLONE and macOS `clonefile`; unsupported filesystems use the formal byte-copy backend.
Windows acceptance currently proves copy only and therefore reports zero reflinks. Materialized Git execution
moves only linked-worktree metadata into the Rust-built body, runs `read-tree`/`add`/an internal baseline commit,
and propagates required filter failures without copying workspace bytes through TS. Native result roots replace
production mandatory side snapshots. Reclaim/discard/delete use kernel subtree removal and prune linked-worktree
metadata. `file.measure` reports actual block allocation on Unix; Windows leaves `allocatedBytes` null until a
verified physical-allocation backend exists. Legacy TS materializer/switch/snapshot code remains only as an
injectable test seam.

## Rust source ownership

The executable `main.rs` only invokes the library runtime. `lib.rs` owns crate assembly and `runtime.rs`
owns framed transport, handshake, request admission, cancellation, and authorized dispatch. A single
`storage::Storage` owns the SQLite connection, object root, process lock, cancellation state, and active
builders. Its implementation is divided into `core`, `operations`, `authority_store`, `objects`,
`state_tree`, `branches`, `recovery`, `file_resources`, `records`, `gc`, `maintenance`, and `dispatch` modules. These are
one transaction owner with bounded source visibility, not independent stores. Storage domains do not
open their own catalog connections or bypass dispatch identity checks.

The Windows release child-process acceptance path is `packages/web/application-host/lib/kernel/kernel-client.test.ts`;
the current run covers the original R0/R1 invariants, R2 file root/lease and conditional filesystem apply,
and R3 filesystem scan/measurement, immutable-root materialization, managed-directory lifecycle, and restart
reconciliation across the live-backup-before-promote failure window.
The production adapter longitudinal path is assembled in `application-host/index.ts`; actor-bound recovery calls
derive session identity from the persisted turn and use an explicit maintenance grant only for startup/list/GC
operations, never the Host-management grant for domain calls. `KernelRecoveryContentStore` is explicitly bound after adapter construction;
an unbound file store or Documents resource gate fails instead of writing the kernel object directory from TS or running without a gate.

## D-278 authority audit and acceptance boundary

The independent audit is recorded in [rust-kernel-audit.md](../../../../../docs/rust-kernel-audit.md).
R1 core storage cutover remains complete after GC/owner/pin repairs. R2/R3 retain their production primitives,
but full recovery/lifecycle acceptance is reopened: unresolved low-level file operations must become visible Host
state, and kernel promotion must be durably joined to Git executionBaseline and Thread Registry/view binding.
Do not treat a helper suite or an optional legacy seam as proof of that native transition.

Physical lease overlap now lives in Rust `storage/file_resource_leases.rs`, across all registered roots. Grant/root
ownership still authorizes access; directional coverage alone authorizes use of an existing lease. Both nested
Host gates and production Documents calls use `file.lease.check`; equal paths do not imply equal scopes.
Root and resolved canonical scope are revalidated. Started remove/rename operations reconcile rather than replay
irreversible actions; ambiguous directory operations remain pending. Fresh materialization refuses uncollected
content, and failed verification preserves live/backup. GC retains pending materialization roots and cancels stale
physical cleanup when a blob has been reinstalled. Old epoch query pins expire while explicit revision pins survive.

`managed-root-admission.ts` separates recorded Thread target ownership from Documents execution workspace identity.
Materialization requires a retained worktree and the existing ownership assertion, not a guessed application-data
prefix. Capture/settle/reclaim use the actual execution workspace. `file.scan` continuations carry an inventory
fingerprint and fail on drift; the implementation still rescans each page and makes no O(page) performance claim.

Run `bun run test:kernel` from the repository root (or invoke its script by absolute path). The dedicated command
requires a release binary and runs Node-only transport tests separately from Vitest authority/adapter/recovery tests.
CI uses `node scripts/test-kernel-authority.mjs --build` in the existing Linux/Windows jobs. Generic tests may skip
native cases in an unbuilt checkout; the dedicated acceptance command cannot silently skip them.
