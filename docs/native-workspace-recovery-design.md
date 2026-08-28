# Piarium native workspace recovery

Status: proposed target architecture; supersedes plugin-backed workspace recovery after implementation

Last updated: 2026-08-28

## 1. Decision

Piarium will own workspace checkpoints and recovery as an Application Host capability.

Pi remains authoritative for its append-only conversation tree. Piarium becomes authoritative for the
physical workspace timeline and for coordinating a conversation navigation with a workspace restore.
No Pi package is required for either capability.

`pi-workspace-history` and `pi-wtf` remain ordinary optional Pi packages. They are removed from the
foundational auto-provisioning set and are not treated as Piarium recovery authorities. Piarium does
not import or migrate their private history.

This replaces the recovery role that Piarium previously assembled from those packages; it does not
clone every feature of either package. Model-assisted typo correction, prompt diagnosis/rewriting,
custom `wtf.json` command words, and destructive in-place Pi session JSONL rewriting are outside the
native recovery product scope. Users may still install `pi-wtf` for those independent commands.

The product terms are:

- **conversation rollback**: navigate the Pi session tree and restore the editable user message;
- **workspace restore**: materialize a recorded workspace snapshot without changing the Pi tree;
- **combined rollback**: coordinate both operations through one durable recovery operation;
- **checkpoint**: a named or turn-bound pointer to an immutable workspace snapshot;
- **safety checkpoint**: a checkpoint of the current state created before an in-place restore;
- **restore into a new workspace**: materialize a snapshot beside the current workspace and leave the
  current directory untouched.

This replaces the current design in which a loaded plugin is assumed to make combined recovery safe.

## 2. Why the current design is rejected

The current provider uses a separate bare Git repository and restores through `git reset --hard` plus
`git clean`. It does not change the user's real Git branch, but it still rewrites the working directory.
That model is not a general workspace transaction:

- Git does not model empty directories, complete filesystem metadata, all symlink/reparse semantics,
  ignored local state, locked files, or special files;
- a directory can be invisible to the dirty check and still make `git clean` fail;
- loading the package is currently treated as proof that a target snapshot is restorable;
- plugin command fallback does not expose a structured plan, exact failure, transaction ID, or
  deterministic rollback result;
- the plugin's release line targets an older Pi SDK and can evolve independently of Piarium's required
  product semantics;
- one plugin hook cannot coordinate dirty editor buffers, other sessions, PTYs, tasks, Git operations,
  remote clients, and host crash recovery.

Piarium already has the correct privileged boundary: the Application Host owns workspace identity,
revisioned Documents APIs, filesystem watch, trust checks, and crash-recovery journals. The new system
extends that authority instead of creating another renderer store or Pi-worker-private database.

## 3. Product semantics

### 3.1 Conversation rollback

Conversation rollback stays Pi-native. It branches or resets the Pi session leaf through the SDK and
does not invoke workspace hooks. It is available for every Pi session, including unbound/general chat.

### 3.2 Workspace restore

A workspace restore targets one immutable Piarium snapshot. It does not modify Pi session history.
It can run in place only when the Host can establish the required writer and snapshot guarantees.
Otherwise the safe default is to materialize a new sibling workspace.

### 3.3 Combined rollback

Combined rollback resolves the target Pi entry to its bound before/after workspace snapshot, prepares
the workspace operation, and only then navigates the Pi tree. A failure never silently becomes
conversation-only. The result reports which side changed and how recovery completed.

### 3.4 Snapshot-to-entry mapping

- returning to a user entry selects the snapshot captured immediately before that turn;
- returning to an assistant entry selects the stable snapshot captured after that turn;
- an entry without a ready snapshot can still use conversation-only rollback;
- an unbound session never claims file recovery;
- restoring a snapshot creates a new workspace revision. It never rewrites history or pretends time
  moved backwards.

## 4. Non-negotiable invariants

1. **No project-Git authority.** Workspace recovery never requires, resets, cleans, commits to, or
   rewrites the project's real Git repository.
2. **No hidden partial coverage.** Every snapshot records what was included, excluded, unstable, or
   unsupported. Only known-absent paths may be deleted during restore.
3. **No silent scope fallback.** A requested combined restore either completes both sides, remains
   unchanged, or returns an explicit recoverable partial-operation state.
4. **No tree switch before file decision.** Pi conversation navigation is not committed until the
   workspace target is prepared and the durable restore decision is known.
5. **Every in-place restore has a safety checkpoint.** The current physical state is pinned before any
   visible file mutation.
6. **Recovery operations are idempotent.** A Host restart resumes the recorded decision; it does not
   guess whether to start over.
7. **Old writers cannot overwrite a restored workspace through Piarium APIs.** Controlled mutations
   carry a workspace epoch/fencing token and stale epochs are rejected.
8. **Uncontrolled writers are reported truthfully.** A logical lease is not described as an operating-
   system lock. When they cannot be drained, Piarium defaults to a new workspace.
9. **Snapshots are immutable and content verified.** A ready snapshot references only durable,
   hash-verified objects.
10. **Retention follows reachability.** Named checkpoints, session bindings, restore targets, safety
    checkpoints, and unfinished operations cannot be collected by a simple last-N policy.
11. **No speculative product limits.** File count, file size, duration, and storage limits are not
    invented without measurements. Storage pressure, progress, cancellation, and configurable policy
    are preferred to silent omission.

## 5. Ownership and process model

```text
Pi session worker
  Pi SessionManager tree
  turn lifecycle + controlled tool writer scopes
          |
          | typed session/turn/navigation protocol
          v
Application Host
  Workspace Recovery Coordinator        <- single semantic owner
  Workspace Tracker + writer epochs
  Snapshot/CAS Store + operation WAL
  DocumentAuthority + task/terminal/Git participants
          |
          | authenticated WorkspaceRecoveryAPI + events
          v
Web / Electron / mobile / IDE shell / VS Code companion
  replaceable Recovery UI, preview, progress, conflict resolution
```

The coordinator runs where the filesystem lives. A mobile client is only a control surface. A remote
Piarium Host stores and restores its own workspaces. Snapshot identity is scoped by
`{authorityId, workspaceId}`; a same-looking path on another Host is unrelated.

The coordinator is part of the fixed recovery kernel. Snapshot storage, native filesystem snapshot
acceleration, repository inspection, and UI can be extended through versioned Piarium services, but no
extension bypasses the coordinator's transaction, path, trust, or fencing invariants.

## 6. Core data model

### 6.1 Workspace identity

```ts
interface WorkspaceRecoveryIdentity {
  authorityId: string;       // stable Application Host identity
  workspaceId: string;       // existing Host workspace UUID
  canonicalRoot: string;     // Host-only realpath, never a public identity
  filesystemProfile: string; // local/SMB/SSH/container plus negotiated capabilities
}
```

The Host revalidates the root realpath and trust boundary on every operation. Aliases, junctions, and
Windows short paths do not create another workspace identity.

### 6.2 Snapshot

```ts
interface WorkspaceSnapshot {
  id: string;
  workspaceId: string;
  sequence: number;                // monotonic physical observation order
  parentSnapshotId: string | null; // logical state ancestry
  manifestHash: string;
  policyRevision: string;
  consistency: 'point-in-time' | 'validated' | 'unstable' | 'incomplete';
  coverage: SnapshotCoverage;
  createdAt: string;
  source: 'baseline' | 'turn-before' | 'turn-after' | 'manual' | 'safety' | 'restore';
  restoredFrom?: string;
}
```

`sequence` is linear because one physical workspace has one observed state order. `parentSnapshotId`
can branch after a restore. The Pi conversation tree remains a separate DAG.

### 6.3 Manifest entry

Each path is one of:

- regular file, with a content object reference;
- directory, including an empty directory;
- symbolic link, storing the raw link target without following it;
- Windows junction/reparse point, represented explicitly;
- hardlink member, with an optional link-group identity;
- unsupported special object, recorded as unsupported rather than ignored.

Portable metadata includes file kind, bytes, executable/mode bits, read-only flags, symlink target,
sparse ranges when available, and a versioned platform metadata envelope for ACL/xattr/ADS/file flags.
The manifest records four coverage states: `present`, `known-absent`, `excluded-unknown`, and
`unstable`. Restore never deletes an existing `excluded-unknown` path.

Path keys preserve case and Unicode spelling while a filesystem-profile-specific comparison key
detects collisions. Case-only renames, Windows reserved names, non-UTF-8 POSIX paths, and cross-platform
metadata loss are resolved during plan preparation, not halfway through materialization.

### 6.4 Turn binding and provenance

```ts
interface RecoveryTurnBinding {
  runtimeKey: string;
  sessionId: string;
  userEntryId: string;
  assistantEntryId?: string;
  beforeSnapshotId: string;
  afterSnapshotId?: string;
  activeWriterScopes: string[];
  provenance: 'caused-by' | 'observed-during' | 'overlapped';
}
```

Only mutations mediated by a Host participant can be labelled `caused-by`. Shell, plugin, external
process, VS Code, or other-session changes are at most `observed-during`. Time correlation is never
presented as certain causality.

## 7. Snapshot capture

### 7.1 Shared baseline

The first file-capable session for a workspace establishes one shared baseline. Later sessions reuse
the workspace timeline instead of creating their own repository or copying the tree again.

When combined recovery is the selected policy, the first mutating prompt waits until its before
snapshot is ready. The composer shows capture progress and cancellation. Conversation-only prompts do
not need to wait.

### 7.2 Watcher-assisted verified scan

`fs.watch` is a cache-invalidation aid, not the source of truth. Capture uses:

1. register the watcher and record its event sequence;
2. walk the complete declared scope;
3. read each candidate with before/after stat validation;
4. hash and store new or invalidated content;
5. replay watcher invalidations that arrived during the scan;
6. rescan invalidated subtrees until stable or explicitly cancelled;
7. if the watcher reports reset/overflow/gap, invalidate the affected tree and rescan;
8. publish the Merkle manifest only after every referenced object is durable.

A filesystem snapshot provider may raise consistency to `point-in-time`. Without one, a stable,
validated scan is reported as `validated`; a continuously changing file becomes `unstable` and blocks
an unreviewed in-place restore.

### 7.3 Turn boundaries

- **Before turn:** reconcile ambient changes, publish/reuse a stable snapshot, then bind it to the user
  entry before Pi can mutate the workspace.
- **During turn:** track controlled writer scopes and watcher invalidations.
- **After turn:** wait for the Pi run and owned foreground writers to settle, reconcile the tree, and
  publish the after snapshot. Background processes remain explicit active writers.

An agent turn may complete even if capture fails, but its file checkpoint is `incomplete`; Piarium does
not claim combined rollback for that entry.

## 8. Mutation observation and writer fencing

The current code has several direct filesystem paths. Delivery must converge Piarium-controlled
mutations on a workspace mutation participant:

- DocumentAuthority text writes/moves/deletes;
- legacy `/api/fs/*`, workspace create/move/delete/upload/extract, and external-access mutations;
- Pi built-in write/edit operations through injected Host-backed operations;
- Git, tasks, terminal, language operations, and Pi tools through owner-scoped writer registration;
- VS Code bridge writes where the VS Code extension host owns the workspace.

Shells and arbitrary extensions can still write directly. Their process trees are registered as
writer scopes when Piarium starts them, while watcher evidence remains the fallback for descendants or
unrelated programs.

Every controlled mutation carries `{workspaceId, epoch, owner}`. Starting a restore advances the
workspace epoch after participants drain. A stale editor autosave, recovery journal, task, or worker
write is rejected instead of overwriting the restored state.

A workspace lease therefore fences cooperating participants only. If an uncontrolled writer is active
or observed during preparation, in-place restore is downgraded to explicit review or new-workspace
materialization.

## 9. Content and metadata storage

The default store lives below:

```text
<PIARIUM_DATA_DIR>/recovery/v1/<authorityId>/<workspaceId>/
  catalog.sqlite
  objects/
  operations/
  staging/
```

The catalog owns snapshots, manifests, bindings, pins, writer epochs, refcounts, and operation state.
Large immutable bytes live in a content-addressed object store. Object identity uses SHA-256 over the
uncompressed content; compression is an internal storage decision and is verified on read.

The first implementation may use streaming whole-file objects. Content-defined chunking, reflinks,
sparse-file preservation, or native copy-on-write stores are internal providers selected after real
break-even measurements. They do not change snapshot semantics.

The database and objects follow write-temp, fsync where supported, atomic same-volume rename, and
post-write verification. A snapshot is published only after its objects and manifest are durable.
Objects remain pinned while capture, restore, verification, export, or GC uses them.

Snapshot data can contain source, ignored files, and secrets. Desktop stores use user-only permissions
and may use an OS-backed encryption provider. Headless/cloud deployments may configure a Host key.
Encryption availability is reported; it is not confused with snapshot completeness.

## 10. Snapshot scope and Git

`.gitignore` is not a recovery policy. Ignored files may contain unique data or secrets, while dependency
caches may be reproducible. Piarium uses a separate, versioned recovery policy. Every exclusion and its
reason is stored with each snapshot and shown in review.

The default semantic scope is **workspace content**:

- include ignored and hidden files unless the recovery policy explicitly excludes them;
- include empty directories and portable metadata;
- exclude Piarium staging/storage artifacts;
- do not capture or rewrite VCS administrative stores such as `.git`, external common gitdirs, `.hg`,
  or `.svn` as ordinary directories.

Git state is a separate participant. Piarium records enough read-only context to explain the restore:
HEAD/ref, worktree/common-dir relationship, index/staged-change presence, submodules, sparse checkout,
and active merge/rebase/cherry-pick state. Normal file rollback does not move refs, rewrite commits, or
silently replace the index. Staged changes or shared worktree state can force review or clone restore.

For a Git project, safe new-workspace recovery prefers a new worktree at the current base and overlays
the target workspace-content snapshot. The original branch, index, and working directory remain intact.

## 11. Coordinated restore transaction

This is a durable coordinated state transition, not a claim of universal filesystem two-phase commit.

### 11.1 Plan

`prepareRestore`:

1. resolves the target entry and snapshot;
2. validates authority/workspace identity, trust, consistency, coverage, and object integrity;
3. captures writer scopes, current workspace epoch, Pi current leaf, and dirty surface buffers;
4. computes create/replace/delete/metadata/collision operations;
5. checks target-volume staging, free space, locked paths where the platform can report them, Git/index
   state, unsupported metadata, and concurrent sessions;
6. returns an immutable plan with exact conflicts, affected bytes/paths, consistency, and allowed
   execution modes.

The plan is expected-revision checked. Any workspace, snapshot, leaf, writer, dirty-buffer, policy, or
Host-generation change makes it stale.

### 11.2 Select in-place or new workspace

In-place execution requires:

- a ready target and ready safety checkpoint;
- no unresolved `unknown`, `unstable`, missing object, or path/metadata conflict;
- no unfenced controlled writer;
- no observed uncontrolled writer during preparation;
- dirty buffers and old crash journals resolved or safely branched;
- the same filesystem authority and a materialization path supported by its capability profile.

If any requirement is absent, the recommended action is a new sibling workspace. The user may review
weaker modes only when the plan can state their exact consequences; Piarium never hides the downgrade.

### 11.3 Durable operation states

```text
planned
  -> staged
  -> commit-decided
  -> applying-workspace
  -> workspace-verified
  -> navigating-conversation
  -> complete

any pre-decision failure -> aborted (no visible mutation)
post-decision interruption -> resume/roll forward from WAL
unresolvable post-decision failure -> needs-attention + pinned rescue state
```

Before `commit-decided`, all target content is staged and verified and the safety checkpoint is pinned.
After that durable decision, restart recovery rolls forward idempotently; it does not guess and replay
an inverse over new external writes. The workspace stays in maintenance mode until complete or moved to
an explicit rescue workflow.

When the filesystem can materialize an invisible new root and atomically switch it, that provider may
commit in one step. Otherwise files are replaced with target-directory temporary files and a durable
per-operation WAL. Readers are kept behind the Host maintenance gate, but Piarium does not claim that
uncooperative external readers cannot observe an intermediate state.

After workspace verification, the coordinator requests Pi conversation navigation with the expected
old leaf and operation ID. If the Pi worker rejects it, the coordinator materializes the safety
snapshot as a new committed recovery operation or offers the already-prepared target as a separate
workspace; it never reports a completed combined rollback with mismatched bindings.

Host startup resolves unfinished restore WAL before it starts session workers, editor journal replay,
autosave, tasks, or Git operations for that workspace.

## 12. Dirty buffers, crash journals, and concurrent sessions

Unsaved buffers are independent state. Restore preparation queries every connected Piarium surface:

- save against the captured revision;
- preserve the buffer as a recovery branch/safety attachment;
- discard after explicit confirmation;
- or cancel restore.

Autosave and document crash-journal replay carry the workspace epoch. A pre-restore epoch cannot write
after recovery. Offline clients reconnect into a normal three-way conflict instead of overwriting disk.

The physical workspace timeline is global. Multiple session turns can bind to it, but overlapping turns
cannot be assigned exclusive causality. Bindings record active writer scopes and provenance. A restore
that crosses another session's observed changes requires review or a new workspace.

Users who need independent concurrent agent work should use worktrees or separate workspace roots. This
is an isolation option, not a product ban on concurrent sessions.

## 13. Filesystem boundary rules

- Resolve every operation relative to the registered canonical root using no-follow traversal where the
  platform permits it.
- Capture a symlink itself; never follow it outside the workspace.
- Treat junctions, reparse points, mounts, and external volumes as separate capability roots.
- Create replacement files in the target directory/volume before rename.
- Preserve empty directories, case-only renames, executable/mode bits, read-only state, hardlink groups,
  sparse extents, and supported metadata.
- Report sockets, devices, FIFOs, unsupported ACL/xattr/ADS data, illegal destination names, and
  cross-platform normalization collisions before commit.
- Never delete a path that the target manifest does not mark `known-absent`.

Network filesystems, virtual filesystems, SSH backends, containers, and cross-volume roots advertise a
capability profile. They may be `validated`, `clone-only`, or unsupported for in-place restore; support
is based on observed semantics, not platform-name guesses.

## 14. Public contracts

The Application Host exposes one `WorkspaceRecoveryAPI`, separate from Pi worker recovery methods:

```ts
interface WorkspaceRecoveryAPI {
  status(workspaceId: string): Promise<WorkspaceRecoveryStatus>;
  listSnapshots(input: SnapshotQuery): Promise<SnapshotPage>;
  resolveEntry(input: SessionEntryRecoveryTarget): Promise<EntryRecoveryBinding>;
  createCheckpoint(input: CreateCheckpointInput): Promise<WorkspaceSnapshot>;
  diff(input: SnapshotDiffInput): Promise<SnapshotDiff>;
  prepareRestore(input: PrepareRestoreInput): Promise<RestorePlan>;
  applyRestore(input: ApplyRestoreInput): Promise<RestoreOperation>;
  cancelOperation(operationId: string): Promise<RestoreOperation>;
  getOperation(operationId: string): Promise<RestoreOperation>;
  pinSnapshot(input: SnapshotPinInput): Promise<SnapshotPinResult>;
  unpinSnapshot(input: SnapshotPinInput): Promise<SnapshotPinResult>;
  storageStatus(workspaceId?: string): Promise<RecoveryStorageStatus>;
}
```

Long work emits revisioned progress events. Typed failures distinguish stale plan, unavailable snapshot,
unstable coverage, dirty buffers, active writer, insufficient space, locked path, unsupported metadata,
missing object, navigation conflict, recovery in progress, and needs-attention.

Pi worker protocol gains expected-leaf conversation navigation and turn-binding events. The coordinator,
not the renderer, combines those with workspace operations.

The existing dead `CheckpointsAPI` DTO and plugin recovery bridge are replaced, not preserved as a
second implementation or compatibility facade.

## 15. User experience

The per-message revert action keeps the three preferences:

- conversation only;
- conversation and workspace;
- always ask.

For a bound workspace, the action shows target checkpoint readiness before execution. `both` is not a
provider guess. If capture is pending, the UI shows progress; if it is incomplete, it shows the exact
coverage problem and offers conversation-only or safe new-workspace recovery.

The Recovery panel becomes a workspace timeline:

- turn-bound and named checkpoints;
- file count/bytes and changed-file diff;
- consistency and coverage;
- writer/concurrency provenance;
- current restore progress and durable operation state;
- safety and rescue checkpoints;
- storage health, pins, and GC reachability;
- an explicit “restore here” versus “open as new workspace” decision when required.

Agent and IDE shells use the same model. Mobile controls the remote Host. VS Code uses the same service
only when its extension host is the workspace authority; otherwise it remains a companion client and
does not create a second checkpoint store.

## 16. Extension points

Piarium extensions may provide versioned Host services for:

- point-in-time filesystem snapshot acceleration (VSS/APFS/Btrfs/ZFS/reflink-capable stores);
- alternative durable object storage;
- metadata capture/materialization for a filesystem profile;
- Git/worktree inspection and safe clone materialization;
- snapshot export/import;
- replacement Recovery UI.

Providers report consistency, volume, metadata, crash, and materialization capabilities. They never
commit a workspace or navigate Pi directly. The coordinator validates provider output and remains the
single semantic authority.

Pi packages may continue to implement their own `/undo` commands for Pi CLI users, but Piarium does not
auto-install them or interpret their private state as native checkpoints.

## 17. Retention and garbage collection

GC walks graph roots rather than deleting the oldest fixed count:

- active Pi entry bindings and retained session branches;
- named/user pins;
- current workspace head;
- restore source and target;
- safety/rescue checkpoints;
- unfinished operation WAL;
- exported snapshots still being read.

Unreachable manifests release object references; unreferenced objects are collected in a separate
generation that cannot race capture or restore. Missing/corrupt blobs mark affected snapshots
unrestorable and remain visible in diagnostics.

Storage policy is user/deployment configurable and pressure-aware. The product first measures real
workspace distributions, capture latency, deduplication, and free-space behavior before choosing any
default budget. Named and safety pins are never silently evicted.

Secure deletion is a distinct operation because snapshots may retain old secrets; deleting a session
label alone does not claim that every deduplicated object was physically erased.

## 18. Implementation phases

Each phase is complete, independently reviewable, and pushed before the next one.

### Phase 1 — Contract, catalog, and content store

- Introduce the Host-owned recovery package, workspace identity, snapshot/manifest/CAS schema,
  consistency/coverage model, pins, WAL records, and storage diagnostics.
- Implement immutable capture/list/read/diff for a direct test workspace.
- Replace the dead `CheckpointsAPI` contract rather than extending it.

Acceptance: snapshot round-trip preserves all supported path kinds and metadata; missing/malformed/
incomplete/corrupt state remains distinct; crash injection cannot publish a snapshot with missing blobs.

### Phase 2 — Workspace tracker and mutation participants

- Extend DocumentAuthority to a workspace mutation authority with epochs and owner scopes.
- Route official fs/workspace/external-access mutations through it.
- Inject Host-backed operations for Pi write/edit where supported.
- Register terminal, task, Git, Pi worker, and VS Code writer scopes.
- Implement watcher gap/overflow invalidation and validated capture.

Acceptance: every controlled write rejects a stale epoch; direct external writes are observed and force
reconciliation; no path silently falls outside the declared coverage.

### Phase 3 — Turn/checkpoint binding

- Add Pi turn-before, turn-after/settled, entry, leaf, and writer-generation protocol events.
- Create/reuse before snapshots before a mutating turn and stable after snapshots afterward.
- Persist bindings in the Host catalog, including overlap and provenance.
- Add named checkpoints through the same engine.

Acceptance: conversation branches and workspace snapshot ancestry remain independent; overlapping
sessions never receive false exclusive attribution; an unbound session cannot claim file recovery.

### Phase 4 — Restore planner and materializer

- Implement expected-revision plans, changed-file diff, coverage validation, dirty-buffer collection,
  Git/index inspection, lock/space/path preflight, safety checkpoints, staging, and new-workspace
  materialization.
- Implement in-place WAL and post-write verification without Pi navigation.

Acceptance: failure injection at every staging/apply/verify state either leaves the original untouched,
resumes the durable target decision, or produces a pinned needs-attention rescue state with exact paths.

### Phase 5 — Combined recovery coordinator

- Add expected-leaf Pi navigation and durable composite bindings.
- Coordinate prepared workspace operations with conversation navigation.
- Recover unfinished operations before session workers and document journals start.
- Add operation undo through safety/rescue checkpoints.

Acceptance: no successful response can pair a target conversation leaf with the wrong workspace
snapshot; worker crash, Host crash, disconnect, and stale completion preserve the durable decision.

### Phase 6 — Product UI and policy

- Rebuild per-message revert, chooser, Recovery panel, progress, preview, conflict resolution, storage,
  pins, rescue, and settings over `WorkspaceRecoveryAPI`.
- Share the behavior across Agent/IDE/Web/Electron/mobile and define truthful VS Code behavior.

Acceptance: no provider-derived fake availability, no generic error-only outcome, no silent downgrade,
and every long action remains observable and cancellable where its durable state permits cancellation.

### Phase 7 — Retire plugin-backed recovery

- Remove `pi-workspace-history` and `pi-wtf` from foundational provisioning.
- Remove workspace-history settings adapter, tree-hook fallback, recovery bridge v1, and old command-owned
  checkpoint paths from Piarium.
- Keep the packages ordinarily installable and independently usable by Pi CLI users.
- Rewrite architecture, recovery, deployment, diagnostics, and user documentation.

Acceptance: a clean Piarium install has complete native conversation/workspace recovery without those
packages; their presence cannot intercept Piarium's native combined transaction.

### Phase 8 — Cross-platform hardening and measured acceleration

- Run Windows/macOS/Linux local, cloud/container, remote, and mobile-hosted matrices.
- Add optional point-in-time/native COW, chunking, compression, and alternative storage providers only
  behind the same semantics.
- Calibrate storage and performance defaults from real high-percentile workspaces.

Acceptance: read-only/locked paths, long/case-only/Unicode names, symlink/junction races, watcher
overflow, SQLite WAL, Git worktrees/submodules, sparse files, disk pressure, cross-volume plans, dirty
buffers, overlapping sessions, and crash points have explicit tested outcomes.

## 19. Verification strategy

The core engine requires model- and fault-based tests, not only happy-path UI tests:

- property: capture A → arbitrary supported mutation → restore A equals manifest A;
- property: restore failure before commit decision leaves the visible workspace unchanged;
- property: restart from every WAL persistence point converges to the recorded decision;
- property: GC never deletes an object reachable from a binding, pin, safety snapshot, or operation;
- concurrency: overlapping Pi sessions, editor autosave, PTY, task, Git, and external writer;
- filesystem: file/dir swaps, empty dirs, symlink/junction, hardlink, sparse, readonly, ACL/xattr/ADS,
  Unicode/case/long path, locked file, mount and cross-volume boundaries;
- Git: linked worktrees, staged/conflicted index, submodules, LFS, sparse checkout, rebase/merge, GC;
- transport: remote disconnect, app reload, worker replacement, Host restart, stale events;
- scale: measured initial scan, turn reconciliation, CAS growth, restore staging, and GC on real high-end
  workspaces without relying on arbitrary small fixtures as product limits.

## 20. Settled decisions and measurements still required

Settled:

- Piarium owns workspace recovery; Pi owns conversation history.
- The Application Host, not the renderer or Pi worker, coordinates combined recovery.
- Git is neither the snapshot engine nor a workspace transaction mechanism.
- Watchers optimize invalidation but never prove completeness alone.
- Restore is a durable coordinated transition, not falsely advertised universal 2PC.
- Snapshot consistency and coverage are first-class user-visible facts.
- New-workspace recovery is the safe path when writers or filesystem semantics cannot be fenced.
- Piarium extensions may accelerate or store snapshots, but cannot bypass the coordinator.
- No old plugin-state migration or compatibility layer is retained.

Measurements before fixing defaults:

- whole-file versus chunked-object break-even;
- scan/hash concurrency by filesystem and workspace shape;
- storage growth and deduplication distribution;
- practical storage-pressure warnings and retention policy;
- which local filesystems can truthfully support point-in-time or root-swap materialization;
- the frequency of unstable files, watcher overflow, uncontrolled writers, and clone-only fallback.
