# Affected-file recovery journal

Piarium message recovery is an operation journal, not a workspace archive.

## Normal turn path

1. A bound user turn creates one lightweight checkpoint row. No workspace path is read.
2. The Web Host negotiates `workspaceMutationJournal` with the Pi worker.
3. Pi's built-in `write` and `edit` tools are wrapped without changing their parameters or behavior.
   Before the original tool executes, the worker sends `workspace.mutation.request` and waits.
4. The recovery service resolves that one path, stores its old state and content-addressed bytes, then
   acknowledges the worker. The tool can now write.
5. After the tool returns or throws, the worker waits while Piarium records the final state. Repeated
   writes to one path preserve the first before-image and the last after-image.
6. Turn settlement compares watcher paths with the exact journal. An unchanged turn is a ready
   zero-path checkpoint. A path changed only by `bash`, a terminal, Git, or another uncontrolled process
   is reported as incomplete rather than triggering a full-workspace fallback.

New sessions, ordinary prompts, and unchanged turns therefore perform no recursive scan. Work scales
with the files actually written by the journalled tools.

## Restore path

Conversation navigation reports the entry IDs that will leave the active Pi branch. Piarium loads the
turn checkpoints bound to those entries and folds their path operations into:

- the expected current state for each affected path;
- the state to restore before the selected message.

Preparation hashes only those paths. Matching paths restore immediately. A later user edit or dirty
buffer becomes a path conflict and is the only normal reason to show the recovery chooser. Before any
write, Piarium stores the current version of the affected paths as the redo/compensation state. It does
not create a whole-workspace safety checkpoint or enter global maintenance mode.

The small SQLite operation record is durable. If file application or Pi navigation fails, Piarium
compensates only paths already changed by that operation. Startup resolves an interrupted operation
from those recorded paths; it never leaves the workspace locked while waiting for a conversation step.

Thread result integration uses the same selected storage, content objects, exact path-state capture,
conditional apply/compensation phases, and workspace lease through a trusted Host-only adapter. Its
`expected`, `target`, and `safety` states reference readable objects before `apply-intent` is committed.
Startup reconciles both conversation recovery and integration operations through these shared primitives;
integration does not create a second catalog under the workspace root.
For an agent-triggered merge, the final integration state and its safety-to-target changes are appended to
the active parent turn checkpoint in the same SQLite transaction. Normal conversation undo therefore uses
the existing checkpoint path; a missing parent binding prevents any integration write.

## Coverage boundary

`write` and `edit` have exact before/after coverage because Piarium pauses them at the mutation
boundary. A generic native process can modify unknown paths without a portable pre-write hook. Watcher
events identify those paths only after the change, so such a turn is explicitly incomplete for combined
rollback. Conversation-only rollback remains available.

An independent IDE local-history layer may later preserve more external changes as they pass through
Documents or editor VFS operations. It must not reintroduce a per-turn full scan or claim universal
shell rollback without a real copy-on-write or operating-system interception provider.

## Persistence

Each selected recovery provider owns the same user-configurable storage-location model:

- application data under `PIARIUM_DATA_DIR`;
- inside the workspace;
- beside the workspace;
- a custom directory.

The payload contains `catalog.sqlite`, `objects/`, and `staging/`. Content objects use SHA-256 over the
uncompressed bytes. Checkpoints store only affected-path state references. Location transfer verifies
the destination before switching authority; cleanup removes unreachable objects.
Working branches and every published Thread result own independent object references in this catalog,
so deleting recovery history cannot collect result or baseline content that a Thread still retains.
