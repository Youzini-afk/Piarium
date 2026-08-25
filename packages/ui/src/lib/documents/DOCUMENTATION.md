# Document Registry

Per-document editing state for Piarium workspace text files. High-frequency buffers live in this
external registry, not in Zustand or Local Storage.

- `registry.ts` — load/save/watch, dirty/conflict, in-flight save, recovery journals, Agent/disk source hints;
  concurrent first-open calls share one Host read
- `documentInstanceId` is internal and survives move/rename within one registry generation; editor engines
  use it for stable model identity without publishing workspace paths
- `applyEdits` accepts one captured local revision plus non-overlapping offset edits, advances the local
  revision once, and returns typed stale/invalid/unsupported results
- `prepareWorkspaceEdit` loads every target without committing, validates document versions/ranges and
  produces a reviewable before/after plan. `applyWorkspaceEdit` revalidates that plan and publishes all
  buffers before notifying any listener; disk writes remain explicit saves. Multi-file changes have one
  lifecycle-bound undo group. Resource create/rename/delete remains explicitly unsupported until the
  Host owns an atomic batch-mutation contract.
- Three-way conflict stores ancestor, buffer, and disk candidate; writes still use expected revision
- `session.ts` — one registry per bound `DocumentsAPI`
- `hooks.ts` — per-document React subscriptions
- `path.ts` — workspace-relative resource IDs
- `workspace-text.ts` — non-editor text read/write through DocumentsAPI

Files UI still owns tree and Agent tab navigation. Split groups, preview/pinned tabs, and per-view
cursor restore live in the Editor Workbench Kernel. Document records survive Profile/Settings
remounts until application-host endpoint switch. `FilesAPI` and `WorkspaceAPI` no longer expose
text read/write; editors and helpers use DocumentsAPI only.
