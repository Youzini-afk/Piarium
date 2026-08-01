# Transactional recovery core

The recovery core associates a Pi user turn with conversation positions and before/after workspace
snapshots. It is independent of the temporary desktop renderer so it can be connected directly to
the retained OpenChamber message actions and settings.

## User semantics

- `conversation`: navigate the Pi session tree without changing workspace files;
- `files`: restore the selected shadow-Git snapshot without moving the conversation;
- `both`: restore both under one journaled operation;
- every apply creates a safety snapshot and can be undone/redone;
- named checkpoints may restore files and, when a Pi leaf is recorded, conversation position;
- previews expire and are rejected if either the workspace tree or conversation leaf changes.

The OpenChamber-derived UI preference has three values: conversation only, conversation + files,
or always ask. Normal recovery starts from the existing per-message revert action. Detailed
history, diff review, named checkpoints, diagnostics, undo, and redo belong in the right sidebar or
settings, not in a mandatory central workflow.

## Storage and safety

- Workspace data is stored in an external shadow Git repository; the project's `.git` is never
  modified.
- Project ignores plus secret patterns (`.env*`, private keys, credentials) are excluded.
- Symlinks are recorded as links and never followed outside the workspace.
- A snapshot is bounded to 100,000 files, 50 MiB per file, and 1 GiB total.
- State and transaction journals use atomic same-volume replacement.
- A cross-process create-exclusive lease serializes writers and can recover a dead-owner PID.
- Retention is bounded to 200 turns, 50 named checkpoints, and 20 undo/redo frames per session;
  unreachable shadow-Git refs are pruned.
- An interrupted combined restore completes only if the conversation already reached the recorded
  target; otherwise files roll back to the safety state.

`pi-workspace-history` and `pi-wtf` overlap this ownership boundary. Piarium refuses native recovery
while either legacy recovery extension is active; their useful workflows are incorporated into
Piarium instead of allowing two engines to restore the same session and workspace.

## Verification

Automated tests cover ignored secrets, project-Git isolation, Unicode filenames, stale previews,
combined apply/undo/redo, interrupted transaction rollback, independent writer serialization, a
real Pi host recovery lifecycle, the compiled desktop broker, and Electron smoke.
