# Piarium native recovery journal

Status: delivered; cross-platform and external-writer coverage continue to harden

Last updated: 2026-08-31

## Decision

Piarium owns combined conversation and file rollback through the selected versioned
`piarium.workspace-recovery` Host service. Pi remains authoritative for its append-only conversation
tree. The official provider is the statically distributed, replaceable
`piarium.builtin.recovery` extension; it is not a Pi package or a separately published application
package.

The recovery unit is an affected-file change set. A message checkpoint is not a complete manifest of
the workspace and does not schedule a background archive.

`pi-workspace-history` and `pi-wtf` are ordinary optional Pi packages. They are neither provisioned nor
consulted by Piarium's native rollback path.

## Why the full-workspace transaction model was removed

The first native implementation represented every turn as a complete flat workspace manifest. Even an
incremental turn copied every prior manifest row into a new revision. Establishing the first baseline
read and hashed the entire workspace; restore preparation created another complete safety snapshot and
restore verification captured the workspace again. A data-heavy workspace therefore paid O(total file
count + total bytes) for a no-op message.

Global maintenance, clone/new-workspace fallback, Git inspection, full-manifest planning, staging, and a
multi-step conversation/files saga then placed exceptional recovery concerns on every normal message
rollback. Durable operation records could also grow with the complete workspace.

Mature editors use a narrower unit:

- VS Code captures a file baseline when that file is first edited in a request and records file
  operations afterward;
- JetBrains Local History records old content at VFS mutation boundaries and groups those events into
  change sets;
- Zed delegates whole-tree structural sharing to Git and consequently cannot provide the same feature
  outside a repository.

Piarium follows the first two patterns and keeps Git out of the authority path.

## Product semantics

### Conversation rollback

Conversation-only rollback branches Pi's native session tree and restores editable user text/images.
It never waits for or modifies workspace history.

### Combined rollback

Returning to a user message removes that message and later entries from the active branch, then reverses
the exact file change sets bound to those entries. Returning to an assistant message keeps that turn and
reverses only later turns.

When all affected paths still equal their recorded after-state, combined rollback executes directly.
The normal UI does not open a restore planner.

The chooser appears only when:

- the user selected **always ask**;
- an affected path was edited again or has an unsaved buffer;
- the turn contains unjournalled external/shell changes.

It offers the relevant decision only: restore the affected paths, return the conversation alone, or
cancel. There is no normal new-workspace mode.

### Redo

Before applying the inverse change set, Piarium records the current state of those affected paths. That
small safety set drives operation compensation and explicit undo/redo. No full safety snapshot is
created.

## Capture protocol

The Web Host advertises `HostHandshakeParams.capabilities.workspaceMutationJournal`. A Pi worker enables
the bridge only when this value is explicitly true, so other Pi Hosts and the VS Code companion cannot
be left waiting for an acknowledgement they do not implement.

When enabled, Piarium supplies same-name custom definitions for Pi's built-in `write` and `edit` tools.
They reuse Pi's original schemas, rendering, validation, and execution. Only the execution boundary is
wrapped:

```text
tool execute
  -> workspace.mutation.request(before, absolute path)
  -> Host stores path before-image and acknowledges
  -> original Pi tool executes
  -> workspace.mutation.request(after, outcome)
  -> Host stores final path state and acknowledges
  -> tool result continues
```

Requests are isolated by request ID and tool-call ID. A provider failure acknowledges `false` and lets
the tool continue; the turn checkpoint becomes incomplete instead of breaking the agent. Session
replacement or worker disposal releases all pending requests.

The first before-image and final after-image are authoritative when one path is written repeatedly in a
turn. A write that returns the file to its original state removes its change record.

## Turn binding and branch selection

Each accepted user entry creates a checkpoint and binding keyed by the broker execution ID. The broker
retains that execution correlation from prompt acceptance through `agent_start`, tool activity, and
`agent_settled`; prompt acknowledgement is not agent completion.

Recovery navigation preparation returns `removedEntryIds` for the current branch. Combined recovery
loads only checkpoints whose user or assistant entry is in that set. Recovery to another non-ancestor
branch is conversation-only until a forward file journal exists for that branch.

## Path state and storage

A path state is one of:

- missing;
- regular file with SHA-256 content object, byte length, and mode;
- directory with mode;
- symbolic link with its raw target and mode;
- explicitly unsupported.

The catalog stores checkpoint metadata, per-path before/after states, turn bindings, and compact recovery
operations. It does not store one row for every workspace path at every turn. Large files are streamed;
there is no arbitrary product file-size cutoff. Cost is paid only when a touched path actually needs a
before/after object.

Storage location resolution remains:

| Mode | Location |
| --- | --- |
| application data | provider storage below `PIARIUM_DATA_DIR` |
| workspace local | `<workspace>/.piarium/recovery/v1` |
| workspace adjacent | `<workspace-parent>/.piarium-recovery/<workspaceId>/v1` |
| custom | `<selected-root>/<authorityId>/<workspaceId>/v1` |

Project choice overrides the global default. Verified transfer switches the registry only after the
destination catalog and objects are readable. Cleanup walks object references and removes unreachable
content. Deleting workspace history remains an explicit destructive action.

## Restore algorithm

For every affected path, preparation folds chronological turn changes into:

- `target`: the earliest before-state;
- `expected`: the latest after-state.

Preparation hashes only those current paths and reports content or dirty-buffer conflicts. Apply
rechecks each path immediately before mutation, stores its safety state, atomically replaces the path,
and verifies the target identity. The operation record advances after each path.

If a later path fails, or Pi rejects the expected conversation leaf, Piarium restores already-applied
paths from the safety set when their current identity still matches the attempted target. A concurrent
external edit is never overwritten by compensation; the operation becomes `needs-attention` with the
exact path. No global workspace maintenance bit survives a crash.

On Host startup, a planned operation stays inert. An interrupted file operation is compensated from its
recorded affected-path safety set before new recovery work is accepted.

## External and shell boundary

A generic native process can choose paths dynamically and bypass Piarium APIs. Portable filesystem
watchers report those changes after the write and cannot recreate bytes that were never observed before
the write. Piarium therefore does not claim exact combined rollback for an unjournalled `bash`, terminal,
Git, extension, or unrelated-process change. The watcher records the affected path and marks that turn
incomplete; conversation-only rollback remains immediate.

Improving this boundary requires a real mechanism—Documents/VFS pre-write integration, a tool-declared
mutation intent, a copy-on-write filesystem provider, or operating-system interception. Reintroducing a
full turn-start scan is not an acceptable fallback.

## Replaceability

The service contract is version 4. A replacement provider implements the same checkpoint, mutation,
combined recovery, operation, and storage-management methods. Fixed Host code owns workspace identity,
path containment, the negotiated Pi tool boundary, and Pi conversation navigation. Provider code owns
the catalog, content objects, change-set folding, conflict policy, and UI contributions.

Version 4 adds: per-file `operation_files` phase tracking (pending → apply-intent → target-observed →
compensate-intent → safety-observed, with needs-attention as a blocking terminal), crash-window
reconciliation in `resumeUnfinished` that compares on-disk state against target/safety before deciding
to abort or compensate, confirmed-conflict-only `overwrite-confirmed` policy, scoped workspace-history
deletion via row-level SQL instead of removing the storage root, and a read-only
`inspectRecoveryJournalCatalog` path for status and inspection that never runs migrations or schema
writes.

Provider selection remains revisioned and scope-aware. Disabling a provider removes file recovery but
never removes Pi-native conversation rollback.

## Verification

Required evidence is based on affected paths, not synthetic full-workspace archives:

- a no-op turn opens, settles, and rolls back without reading any workspace file;
- a large workspace with one touched file reads only that file;
- repeated writes retain the first before-image and final after-image;
- later user edits produce a per-path conflict and are not overwritten under `abort`;
- explicit overwrite stores a redo state before replacing the affected path;
- interrupted multi-path apply compensates only completed paths;
- stale Pi leaf navigation compensates files and does not report success;
- unjournalled shell paths produce an incomplete checkpoint rather than a scan;
- Windows replacement, Unicode/case paths, symlinks, read-only files, and locked paths retain explicit
  tested outcomes;
- storage migration verifies before switching and cleanup never removes a referenced object.
