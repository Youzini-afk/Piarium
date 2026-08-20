# Editor Workbench Kernel

Shared editor groups, resource providers, commands, context keys, and panel model. Shells mount
this kernel; they do not own document buffers, disk revisions, or layout schema.

- `groups.ts` — split tree, tabs, preview/pinned, move, close. Moving the last tab out of a group
  collapses that group.
- `snapshot.ts` — workspace-scoped restore: missing, empty, malformed, failure, ready
- `persist.ts` — runtime+workspace local snapshot, 400ms structural debounce, pagehide/freeze flush,
  in-memory last-good. Cursor/scroll patches update last-good without scheduling a write.
- `session.ts` — Map by workspaceId. `peekEditorWorkbench` never creates. Persist failure/malformed
  keeps last-good and does not write empty over the failed snapshot. Runtime switch resets the map.
- `providers.ts` — enabled provider selection, user association, text fallback, and disable without
  background work
- `commands.ts` / `context-keys.ts` / `menus.ts` — owner-scoped commands, per-key context subscribe,
  `when` menu projection
- `panels.ts` — terminal/problems/output container; empty is distinct from failure
- `view-state.ts` — per-view cursor/scroll capture and restore

High-frequency cursor/scroll state stays on the tab `viewState` in memory. Snapshots are explicit,
not per keystroke. Document dirty buffers remain in the Document Registry.

The Agent Files surface adapts onto this kernel: the explorer is shared, split groups use kernel
tabs, and `useFilesViewTabsStore` remains the Agent navigation API until a later Shell owns layout.
